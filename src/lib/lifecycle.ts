// ============================================================
// EDGE LAB — automated match lifecycle (analyze → enter → reassess → exit)
// [SERVER-ONLY]
//
// The cron/tick drives the whole loop without a human:
//   1) autoAnalyze — analyze matches that have tradeable odds and haven't been
//      analyzed for their current stage yet (once pre-lineup, once after
//      lineups; §9.5 keeps it economical — one LLM pass per stage per match).
//   2) autoEnter   — paper-fill the strategy's proposed bets at the current
//      price (proposed → open).
//   3) evaluateExits — close open positions deterministically (§9.6) on
//      take-profit / per-position stop / edge-gone. In-match reassessment on
//      goals & price moves is already fired by the engine.
//   4) runAutoCycle — orchestrates sync + odds + the three steps above.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { syncCompetitions, refreshActiveOdds, recomputeMetrics, importPolymarketMatches, enrichFromEspn, settleStaleOpenBets, seriesAllowFor, dedupeMatches } from "./engine.js";
import { SPORT_TAG_IDS, SPORT_LABELS } from "./polymarket.js";
import { analyzeMatch, jobActive, matchContext, strategyDrawdown, strategyCompExposure, strategyCompRealized, sameMarketLabel } from "./analysis.js";
import { exitDecision, sizeBet } from "./thresholds.js";
import { stratBudget } from "./money.js";
import { strategistDecide, effectiveEnv } from "./llm.js";
import { hoursUntil } from "./time.js";
import type { Confidence, ReassessTrigger } from "./types.js";

// Timing gates (hours before kickoff). Pre-match assessment opens ~12h out;
// lineups are treated as out ~1h before (WC teamsheets), triggering the final
// (post-lineup) reassessment.
export const ANALYZE_PRE_HOURS = 12;
export const LINEUP_HOURS = 1;
// Hours past kickoff after which a clock-only match (ESPN never finished it) is
// auto-finished — generous enough to cover a long match + stoppage/extra time.
export const FINISH_HOURS = 4;
// Per-sport wall-clock ceiling (minutes) for a CLOCK-ONLY live match — one with
// no provider minute at all (we have zero live coverage on it). Past this the
// elapsed-since-kickoff display stops climbing (so an uncovered match never reads
// a nonsense "179'"), and a match carrying no open bets is clock-finished instead
// of hanging "live" for hours. Sports absent here fall back to FINISH_HOURS.
export const SPORT_MAX_LIVE_MIN: Record<string, number> = {
  football: 130, basketball: 160, hockey: 200, tabletennis: 120, esports: 240, tennis: 300,
};
export const maxLiveMinutes = (sport: string): number => SPORT_MAX_LIVE_MIN[sport] ?? FINISH_HOURS * 60;
import type { SportsProvider } from "./sports.js";
import type { Match, MatchState } from "./types.js";

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());
// Prefer the raw ESPN clock ("45'+2'") so logs/reassessments carry stoppage
// time; fall back to the whole-minute figure, then "предматч".
// Match-time label used to STAMP entries/exits/reassessments. For a clock-driven
// live match (no ESPN minute) it computes elapsed minutes from kickoff, so an
// in-match entry reads "63'" not a wrong "предматч".
const minuteLabel = (m: Match, nowMs: number = Date.now()): string => {
  if (m.state !== "live") return "предматч";
  if (m.clock) return m.clock;
  if (m.minute != null) return `${m.minute}'`;
  if (isIsoTs(m.kickoff_at)) return `${Math.max(0, Math.floor((nowMs - Date.parse(m.kickoff_at as string)) / 60000))}'`;
  return "LIVE";
};
const round2 = (n: number) => Math.round(n * 100) / 100;

function activeMatches(db: Database): { comp: string; sport: string; match: Match }[] {
  const out: { comp: string; sport: string; match: Match }[] = [];
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) if (m.state !== "finished") out.push({ comp: c.id, sport: c.sport_id, match: m });
  }
  return out;
}

// ------------------------------------------------------------
// 0) Advance clocks — flip lineup_out / state from the kickoff time
// ------------------------------------------------------------

/**
 * Drive match state from the kickoff CLOCK for time-scheduled matches (found via
 * Polymarket, no ESPN live feed): upcoming → lineup (~1h before) → LIVE (at
 * kickoff) → finished (well after, if ESPN never finished it and nothing's at
 * risk). Without this a match ESPN can't drive (obscure leagues, most tennis)
 * would sit in "lineup" forever — showing «состав» instead of LIVE, never
 * lighting the live-dot, never capturing the kickoff price baseline, and starving
 * the live-only machinery (reassessment / stats / exits). ESPN stays
 * authoritative when it IS driving a match: those carry a real `minute`, so we
 * never clock-finish them and never regress their state.
 */
export function advanceClocks(db: Database, deps: EngineDeps = {}): void {
  const nowMs = Date.parse(nowFn(deps)()) || Date.now();
  for (const { sport, match: m } of activeMatches(db)) {
    const h = hoursUntil(m.kickoff_at, nowMs);
    if (h == null) continue;

    // Clock-finish: a clock-only match (no ESPN minute) past its sport's live
    // ceiling that ESPN never finished. Only when it holds NO open bets (unfunded
    // discovered matches) — never strand a position; the prune then cleans it up.
    // ESPN matches (minute set) are finished by ESPN, never by the clock.
    if (m.state === "live" && m.minute == null && h <= -(maxLiveMinutes(sport) / 60)
        && !R.betsForMatch(db, m.id).some((b) => b.status === "open")) {
      R.updateMatch(db, m.id, { state: "finished", final_score: m.final_score ?? null });
      continue;
    }

    // Postponed / rescheduled: a CLOCK-driven "live" match (no real provider
    // minute) whose kickoff is now in the FUTURE was moved — it isn't live.
    // Revert so the clock re-drives it from the new time (discovery refreshes
    // kickoff_at from Polymarket). Provider-confirmed live (minute set) is never
    // touched here. Bets stay; only the state/label changes.
    if (m.state === "live" && m.minute == null && h > 0) {
      const back: MatchState = h <= LINEUP_HOURS ? "lineup" : "upcoming";
      R.updateMatch(db, m.id, { state: back, lineup_out: h <= LINEUP_HOURS });
      continue;
    }

    // Only TIME-schedule the pre-live states; ESPN owns live/finished once it drives.
    if (m.state !== "upcoming" && m.state !== "lineup") continue;
    let nextState: MatchState, lineupOut: boolean;
    if (h <= 0) { nextState = "live"; lineupOut = true; }             // kicked off
    else if (h <= LINEUP_HOURS) { nextState = "lineup"; lineupOut = true; }
    else { nextState = "upcoming"; lineupOut = false; }
    if (nextState !== m.state || lineupOut !== m.lineup_out) {
      R.updateMatch(db, m.id, { state: nextState, lineup_out: lineupOut });
    }
  }
}

// ------------------------------------------------------------
// 1) Auto-analyze
// ------------------------------------------------------------

export interface AutoAnalyzeItem { matchId: string; match: string; stage: string; ok: boolean; bets: number }

/**
 * Analyze matches that have tradeable odds, belong to a FUNDED competition
 * (budget > 0 — no point spending LLM on matches no strategy can bet), and
 * haven't been analyzed for their current stage. Capped per run so a tick over
 * hundreds of discovered matches doesn't fire hundreds of model calls.
 */
export async function autoAnalyze(db: Database, deps: EngineDeps = {}, opts: { max?: number } = {}): Promise<AutoAnalyzeItem[]> {
  const max = opts.max ?? 6;
  const nowMs = Date.parse(nowFn(deps)()) || Date.now();
  const budgetByComp = new Map(R.listCompetitions(db).map((c) => [c.id, c.budget]));
  const out: AutoAnalyzeItem[] = [];
  for (const { comp, match: m } of activeMatches(db)) {
    if (out.length >= max) break;
    if ((budgetByComp.get(comp) ?? 0) <= 0) continue;              // unfunded → skip (economical)
    if (!R.latestMarkets(db, m.id).length) continue;               // needs tradeable odds
    const stage = m.lineup_out ? "post_lineup" : "pre_lineup";
    // Time gate: pre-match assessment only within ~12h of kickoff; the final
    // (post-lineup) pass runs once lineups are out (advanceClocks flips it ~1h
    // before). Matches with no known kickoff (e.g. ESPN live) aren't gated.
    const h = hoursUntil(m.kickoff_at, nowMs);
    if (stage === "pre_lineup" && h != null && h > ANALYZE_PRE_HOURS) continue;
    if (R.assessmentsForMatch(db, m.id).some((a) => a.stage === stage && a.status === "ok")) continue; // already done this stage
    if (jobActive(R.getAnalysisJob(db, m.id), Date.now())) continue; // a run is in flight
    const r = await analyzeMatch(db, m.id, deps);
    out.push({ matchId: m.id, match: `${m.home}–${m.away}`, stage, ok: r.ok, bets: r.betsCreated ?? 0 });
  }
  return out;
}

// ------------------------------------------------------------
// 2) Auto-enter (paper fill proposed bets)
// ------------------------------------------------------------

export interface AutoEnterItem { matchId: string; strategyId: string; market: string; price: number; stake: number }

// Sports where a confirmed starting lineup materially changes the read, so we
// hold pre-match capital until it's out (mirrors the frontend LINEUP_SPORTS).
const LINEUP_SPORTS = new Set(["football"]);

export function autoEnter(db: Database, deps: EngineDeps = {}): AutoEnterItem[] {
  const now = nowFn(deps)();
  const out: AutoEnterItem[] = [];
  for (const { sport, match: m } of activeMatches(db)) {
    // Don't DEPLOY capital on a lineup-sport match before its lineups are out —
    // pre-lineup we still analyze and PROPOSE possible bets (shown as
    // «предлагается»), but they only fill once the lineup lands (lineup_out) or
    // the match is live. This keeps the pre-match read a preview, not an entry.
    const preLineupHold = LINEUP_SPORTS.has(sport) && !m.lineup_out && (m.state === "upcoming" || m.state === "lineup");
    const markets = R.latestMarkets(db, m.id);
    const bets = R.betsForMatch(db, m.id);
    // A strategy must never hold two OPEN positions on the SAME market — that's
    // the double-exposure a concurrent analyze/reassess race (or analyze+reassess
    // in one cycle) could otherwise fill. This single choke point guards it
    // regardless of how duplicate proposals were created.
    const openKey = new Set(bets.filter((b) => b.status === "open").map((b) => `${b.strategy_id}|${b.market_label}`));
    for (const b of bets) {
      if (b.status !== "proposed") continue;
      if (preLineupHold) continue; // preview only — keep it «предлагается» until lineups are out
      const key = `${b.strategy_id}|${b.market_label}`;
      if (openKey.has(key)) { R.updateBet(db, b.id, { status: "not_filled" }); continue; } // already in this market — drop the dup
      const price = markets.find((x) => x.label === b.market_label)?.price ?? b.proposed_price ?? 0;
      if (price <= 0) continue;
      R.updateBet(db, b.id, { status: "open", entry_price: price, current_price: price, entered_minute: minuteLabel(m) });
      openKey.add(key);
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "enter", text: `вход «${b.market_label}» @ ${price}¢ · $${b.stake ?? 0}`, created_at: now });
      out.push({ matchId: m.id, strategyId: b.strategy_id, market: b.market_label, price, stake: b.stake ?? 0 });
    }
  }
  return out;
}

// ------------------------------------------------------------
// 3) Evaluate exits (close open positions early, at market)
// ------------------------------------------------------------

export interface ExitItem { matchId: string; strategyId: string; market: string; reason: string; pnl: number }

/** Close a single open bet fully at the current price (cash out the position). */
function closeBetEarly(db: Database, bet: { id: string; stake: number | null; entry_price: number | null }, currentPriceCents: number, reason: string, minute: string, now: string): number {
  // Re-read under the current DB state: two concurrent reassess flows (double
  // click / two tabs / a manual reassess overlapping the scheduler) snapshot the
  // same open bet BEFORE the LLM await, then both try to close it. Fresh-read so
  // a bet already settled is a no-op (no double-settle) and we use the fresh stake.
  const fresh = R.getBet(db, bet.id);
  if (!fresh || fresh.status !== "open") return 0;
  const stake = fresh.stake ?? 0;
  const entry = fresh.entry_price ?? 0;
  const payout = entry > 0 ? round2(stake * (currentPriceCents / entry)) : 0;
  const pnl = round2(payout - stake);
  // "early" cash-out: booked by P&L sign, NOT by real outcome — excluded from
  // the predictive metrics (Brier/CLV) so trading P&L doesn't masquerade as
  // prediction accuracy.
  R.updateBet(db, bet.id, { status: pnl >= 0 ? "settled_won" : "settled_lost", result: pnl >= 0 ? "won" : "lost", payout, closing_price: currentPriceCents, settled_by: "early", settled_at: now });
  return pnl;
}

/**
 * Close a FRACTION of an open position (partial fixation, §4.2). fraction>=1 is
 * a full close; otherwise the closed slice is booked as a settled child bet and
 * the original open bet's stake shrinks by that slice, leaving the rest running.
 */
function closeBetPortion(db: Database, bet: any, fraction: number, currentPriceCents: number, minute: string, now: string): { pnl: number; partial: boolean } {
  if (fraction >= 1) return { pnl: closeBetEarly(db, bet, currentPriceCents, "", minute, now), partial: false };
  // Re-read: another flow may have already (partially) closed this position
  // during our LLM await. Skip if no longer open; size the slice off the FRESH
  // stake so two concurrent partial closes can't over-close (phantom exposure).
  const fresh = R.getBet(db, bet.id);
  if (!fresh || fresh.status !== "open") return { pnl: 0, partial: false };
  bet = fresh;
  const stake = bet.stake ?? 0, entry = bet.entry_price ?? 0;
  const closed = round2(stake * fraction);
  if (closed <= 0 || entry <= 0) return { pnl: closeBetEarly(db, bet, currentPriceCents, "", minute, now), partial: false };
  const payout = round2(closed * (currentPriceCents / entry));
  const pnl = round2(payout - closed);
  R.insertBet(db, {
    id: R.uid(), match_id: bet.match_id, strategy_id: bet.strategy_id, market_label: bet.market_label,
    status: pnl >= 0 ? "settled_won" : "settled_lost", proposed_price: bet.proposed_price, entry_price: entry,
    current_price: currentPriceCents, closing_price: currentPriceCents, ai_prob: bet.ai_prob, stake: closed,
    rationale: `частичная фиксация ${Math.round(fraction * 100)}%`, entered_minute: bet.entered_minute,
    result: pnl >= 0 ? "won" : "lost", payout, settled_by: "partial", settled_at: now, created_at: now,
  });
  R.updateBet(db, bet.id, { stake: round2(stake - closed) }); // keep the remainder open
  return { pnl, partial: true };
}

export function evaluateExits(db: Database, deps: EngineDeps = {}): ExitItem[] {
  const now = nowFn(deps)();
  const out: ExitItem[] = [];
  const touched = new Set<string>();
  for (const { match: m } of activeMatches(db)) {
    // Price-driven exits (take-profit / stop / edge-gone) are LIVE management —
    // per ТЗ §3.3 mark-to-market and price triggers belong to the live phase. A
    // position opened on lineup is HELD untouched until kickoff; letting exits run
    // pre-match closed positions on pure Polymarket drift (the «вход… → выход…
    // предматч» churn). Settlement of finished matches is handled elsewhere.
    if (m.state !== "live") continue;
    const markets = R.latestMarkets(db, m.id);
    for (const b of R.betsForMatch(db, m.id)) {
      if (b.status !== "open") continue;
      const mk = markets.find((x) => x.label === b.market_label);
      if (!mk || mk.price == null || b.entry_price == null) continue;
      const strat = R.getStrategy(db, b.strategy_id);
      if (!strat) continue;
      // When the model prob is unknown, DON'T let it read as "edge gone" (which
      // would force-close on the first tick) — pass 1 so only take-profit / hard
      // stop can fire. (Defensive: entries always store a non-null ai_prob.)
      const d = exitDecision({ params: strat.params, aiProb: b.ai_prob ?? 1, entryPriceCents: b.entry_price, currentPriceCents: mk.price });
      if (!d.exit) continue;
      const pnl = closeBetEarly(db, b, mk.price, d.reason, minuteLabel(m), now);
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "exit", text: `выход «${b.market_label}» @ ${mk.price}¢ · ${d.reason} · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, created_at: now });
      out.push({ matchId: m.id, strategyId: b.strategy_id, market: b.market_label, reason: d.reason, pnl });
      touched.add(b.strategy_id);
    }
  }
  for (const sid of touched) recomputeMetrics(db, sid, deps);
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Snapshot each live match's current prices as its kickoff baseline (first
 *  write wins), so the odds column shows in-match movement, not pre-match drift. */
function captureLiveOpens(db: Database, deps: EngineDeps): void {
  const now = nowFn(deps)();
  for (const { match: m } of activeMatches(db)) if (m.state === "live") R.captureOpenOdds(db, m.id, now);
}

export interface ReassessEntry { matchId: string; strategyId: string; market: string; stake: number }
export interface ReassessResult { exits: ExitItem[]; entries: ReassessEntry[] }

/**
 * Strategist-driven in-match reassessment. For funded matches that either hold
 * open positions OR just saw a fresh live event (goal / red card / lineups —
 * pulled from ESPN by enrichFromEspn, passed in via opts.newEventMatchIds), we
 * hand the strategy PROMPT the real match context (lineups + events) and let its
 * own methodology decide BOTH what to EXIT (full/partial fixation, "this event
 * broke the thesis") and what fresh markets to ENTER (a new pattern the event
 * opened). Code still sizes/gates entries (§9.6). Capped per run — one model
 * call per (match, strategy) — so it only fires where the user holds risk or a
 * trigger actually fired. This is what makes reassessment *react* to live data.
 */
export async function strategistReassess(
  db: Database, deps: EngineDeps = {}, opts: { max?: number; newEventMatchIds?: Set<string>; triggeredOnly?: boolean; labelFor?: Map<string, ReassessTrigger>; onlyStrategyId?: string } = {},
): Promise<ReassessResult> {
  const max = opts.max ?? 4;
  const triggered = opts.newEventMatchIds ?? new Set<string>();
  const labelFor = opts.labelFor ?? new Map<string, ReassessTrigger>();
  // Event-driven mode (fast live loop): only reassess matches with a fresh
  // trigger — don't burn an LLM call every tick on quiet open positions.
  const triggeredOnly = opts.triggeredOnly ?? false;
  const now = nowFn(deps)();
  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  const comps = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  const out: ReassessResult = { exits: [], entries: [] };
  const touched = new Set<string>();
  let calls = 0;
  // Process on-pitch event triggers (goal / red card — anything NOT labelled
  // "time") BEFORE the periodic heartbeat matches, so an urgent reaction to a
  // goal is never crowded out of the per-run `max` budget by routine 5-min ticks.
  const isPeriodic = (id: string) => (labelFor.get(id) ?? "time") === "time";
  const ordered = activeMatches(db).slice().sort((a, b) => Number(isPeriodic(a.match.id)) - Number(isPeriodic(b.match.id)));
  for (const { comp, sport, match: m } of ordered) {
    if (calls >= max) break;
    const c = comps.get(comp);
    if (!c || c.budget <= 0) continue;
    // Reassessment is IN-MATCH management that reacts to real events (goal / red
    // card / price move) — per ТЗ §3.3 it belongs to the LIVE phase. Never run it
    // pre-match: for leagues we can't enrich, `lineup_out` is a pure time-flip
    // (advanceClocks, ~1h before kickoff) with NO real teamsheet, so allowing the
    // lineup_out branch churned not-yet-started matches on pre-match price noise
    // ("движение цены на старте без игрового триггера; статичное 0:0"). Entry on
    // lineup still happens (autoAnalyze post_lineup + autoEnter); we just hold
    // those positions untouched until the ball is actually rolling.
    if (m.state !== "live") continue;
    const open = R.betsForMatch(db, m.id).filter((b) => b.status === "open");
    // Reassess only where there's live risk (open positions) or a fresh trigger.
    // In triggeredOnly mode (fast loop) a trigger is REQUIRED — quiet positions
    // are handled by the deterministic exits + the slow full cycle.
    if (triggeredOnly ? !triggered.has(m.id) : (!open.length && !triggered.has(m.id))) continue;
    const markets = R.latestMarkets(db, m.id);
    if (!markets.length) continue;
    const opens = R.openOddsFor(db, m.id); // kickoff price per label → price_move direction/size
    const nowMs = Date.parse(now) || Date.now();
    // A live minute for the strategist even when no provider drives one: the timer
    // estimate from kickoff (capped at the sport ceiling so it never reads absurd).
    const minuteApprox = m.minute == null && isIsoTs(m.kickoff_at)
      ? Math.min(maxLiveMinutes(sport), Math.max(0, Math.floor((nowMs - Date.parse(m.kickoff_at as string)) / 60000)))
      : null;
    const assess = R.assessmentsForMatch(db, m.id).filter((a) => a.status === "ok").sort((a, b) => (a.created_at >= b.created_at ? -1 : 1))[0];
    const ctx = matchContext(db, m.id); // real lineups + stats + events

    // Strategies to run: those with an active share (can enter) plus any that
    // already hold an open position on this match (must be able to exit).
    const shares = R.sharesForComp(db, comp);
    const sids = new Set<string>();
    for (const s of shares) if (s.pct > 0) sids.add(s.strategy_id);
    for (const b of open) sids.add(b.strategy_id);

    for (const sid of sids) {
      if (calls >= max) break;
      if (opts.onlyStrategyId && sid !== opts.onlyStrategyId) continue; // manual: one strategy only
      const strat = R.getStrategy(db, sid);
      if (!strat) continue;
      const myOpen = open.filter((b) => b.strategy_id === sid);
      calls++;
      const dec = await strategistDecide({
        strategyName: strat.name, strategyPrompt: strat.prompt,
        match: { home: m.home, away: m.away, sport, state: m.state, minute: m.minute, scoreHome: m.score_home, scoreAway: m.score_away, minuteApprox },
        assessment: { confidence: assess?.confidence ?? "средняя", short: assess?.short ?? "", verdict: assess?.verdict ?? "" },
        markets: markets.map((mk) => ({ label: mk.label, priceCents: mk.price, aiProb: mk.ai_prob, liquidity: mk.liquidity != null ? Number(mk.liquidity) : null, openCents: mk.label in opens ? opens[mk.label] : null })),
        openPositions: myOpen.map((b) => ({ market: b.market_label, entryCents: b.entry_price ?? 0, currentCents: b.current_price ?? b.entry_price ?? 0 })),
        context: ctx,
      }, strat.model ?? "Claude Opus 4.8", { fetchImpl: deps.fetchImpl, env });
      if (!dec.ok) continue;
      touched.add(sid);
      // Track what ACTUALLY happened, so the reassessment note (written AFTER the
      // exits/entries below) states reality — not the LLM's intent. Otherwise the
      // note musing "держу BTTS No" showed even when no such position was ever
      // opened (picks gated / abstained), reading like positions that don't exist.
      const enteredMarkets: string[] = [], exitedMarkets: string[] = [], unfilled: string[] = [];

      // (a) EXITS — full or partial fixation on this strategy's open positions.
      const exitedIds = new Set<string>();
      for (const ex of dec.exits) {
        // Resolve the strategist's (possibly paraphrased) exit label to a real
        // open position — exact first, then the safe fuzzy match, so an exit the
        // model asked for isn't silently dropped and the position left open.
        const b = myOpen.find((x) => norm(x.market_label) === norm(ex.market)) ?? myOpen.find((x) => sameMarketLabel(x.market_label, ex.market));
        const mk = b && markets.find((x) => x.label === b.market_label);
        if (!b || !mk || mk.price == null || b.entry_price == null) continue;
        // Dedup on the RESOLVED bet id, not the label: two paraphrased exits
        // ("Under 2.5" / "Under 2.5 goals") map to the same position and the
        // second would size off the already-shrunk stake → over-fixation.
        if (exitedIds.has(b.id)) continue;
        exitedIds.add(b.id);
        const { pnl, partial } = closeBetPortion(db, b, ex.fraction, mk.price, minuteLabel(m), now);
        const tag = partial ? `частично ${Math.round(ex.fraction * 100)}%` : "полностью";
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "exit", text: `выход «${b.market_label}» (${tag}) @ ${mk.price}¢ · стратег: ${ex.reason} · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, created_at: now });
        out.exits.push({ matchId: m.id, strategyId: sid, market: b.market_label, reason: `стратег (${tag}): ${ex.reason}`, pnl });
        exitedMarkets.push(`${b.market_label} (${tag})`);
        touched.add(sid);
      }

      // (b) ENTRIES — fresh positions the trigger opened. Only strategies with a
      // live share can enter; code sizes/gates. Dedup against markets this
      // strategy already holds/proposed so we never double up on the same bet.
      const share = shares.find((s) => s.strategy_id === sid);
      if (share && share.pct > 0 && dec.picks.length) {
        const budget = stratBudget(c.budget, share.pct);
        const drawdown = strategyDrawdown(db, comp, sid, budget);
        const held = new Set(R.betsForMatch(db, m.id, sid).filter((b) => b.status === "open" || b.status === "proposed").map((b) => norm(b.market_label)));
        // Seed exposure + realized from ALL the strategy's matches in this comp
        // (open AND still-proposed — autoEnter will fill the proposals), so the
        // §9.3 cap is per-COMPETITION, not per-match: concurrent matches can't each
        // stake the full share.
        let exposure = strategyCompExposure(db, comp, sid);
        const realizedPnl = strategyCompRealized(db, comp, sid);
        for (const pick of dec.picks) {
          const mk = markets.find((x) => norm(x.label) === norm(pick.label)) ?? markets.find((x) => sameMarketLabel(x.label, pick.label));
          if (!mk || mk.price == null) { unfilled.push(`«${pick.label}» — нет рынка`); continue; }
          // LIVE re-scoring: size off the strategist's OWN current probability (it
          // re-estimates from the live score/minute — a 0:2 game's "Over 1.5" is
          // ~1.0, not the stale pre-match ai_prob). Fall back to the stored prob
          // only if none given. Refresh the market ai_prob so the UI edge is live
          // too (the odds refresh carries ai_prob forward).
          const aiProb = pick.prob != null ? pick.prob : mk.ai_prob;
          if (aiProb == null) { unfilled.push(`«${mk.label}» — нет оценки`); continue; }
          if (pick.prob != null) R.setMarketAiProb(db, mk.id, pick.prob);
          if (held.has(norm(mk.label))) continue;                       // already in this market
          const d = sizeBet({ params: strat.params, aiProb, priceCents: mk.price, budget, exposure, realizedPnl, confidence: pick.conviction as Confidence, drawdown });
          if (!d.enter) { unfilled.push(`«${mk.label}» — ${d.reason}`); continue; }
          exposure += d.stake;
          held.add(norm(mk.label));
          R.insertBet(db, {
            id: R.uid(), match_id: m.id, strategy_id: sid, market_label: mk.label,
            status: "proposed", proposed_price: mk.price, entry_price: null, current_price: null,
            closing_price: null, ai_prob: aiProb, stake: d.stake,
            rationale: `переоценка: «${mk.label}» край ${d.edge.toFixed(1)}%. ${pick.reason || d.reason}.`,
            entered_minute: null, result: null, payout: null, created_at: now,
          });
          out.entries.push({ matchId: m.id, strategyId: sid, market: mk.label, stake: d.stake });
          enteredMarkets.push(mk.label);
          touched.add(sid);
        }
      }

      // Reassessment note (Переоценки tab) — written AFTER acting, LEADING with
      // the FACTUAL result so it can't imply positions that weren't opened.
      const facts: string[] = [];
      if (enteredMarkets.length) facts.push(`вошёл: ${enteredMarkets.join(", ")}`);
      if (exitedMarkets.length) facts.push(`вышел: ${exitedMarkets.join(", ")}`);
      if (!enteredMarkets.length && !exitedMarkets.length) facts.push(myOpen.length ? `держу ${myOpen.length} поз.` : "позиций нет, вход не сделан");
      if (unfilled.length) facts.push(`не вошёл: ${unfilled.slice(0, 3).join("; ")}`);
      const noteBody = `${facts.join(" · ")}.${dec.note?.trim() ? " " + dec.note.trim() : ""}`;
      R.insertReassessment(db, {
        id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m),
        body: noteBody, confidence: assess?.confidence ?? null,
        trigger: labelFor.get(m.id) ?? "time", created_at: now,
      });
    }
  }
  for (const sid of touched) recomputeMetrics(db, sid, deps);
  return out;
}

// ------------------------------------------------------------
// 4) Orchestration
// ------------------------------------------------------------

export interface AutoCycleResult {
  synced: number; imported: number; discovered: number; oddsMatches: number; oddsUpdated: number;
  enriched: number; triggers: number;
  analyzed: AutoAnalyzeItem[]; entered: AutoEnterItem[]; exited: ExitItem[]; reassessEntries: ReassessEntry[];
}

/**
 * One full automated pass. Order matters: import & status first (settles
 * finished matches, fires goal reassessments), then refresh prices (mark to
 * market, price_move reassessments), then exits on fresh prices, then analyze
 * newly-eligible matches, then fill their proposals.
 */
export async function runAutoCycle(
  db: Database, provider: SportsProvider | null, deps: EngineDeps = {}, opts: { linkOdds?: boolean; discoverLimit?: number; discover?: boolean } = {},
): Promise<AutoCycleResult> {
  // Each stage is isolated: a transient throw in one provider call (ESPN /
  // Polymarket network blip) must NOT abort the whole cycle and skip the
  // downstream money-management steps (exits / entries / settlement). Failed
  // stages degrade to their empty result and the pass continues.
  const step = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) { console.error(`[autoCycle:${label}]`, e instanceof Error ? e.message : e); return fallback; }
  };
  const stepSync = <T>(label: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (e) { console.error(`[autoCycle:${label}]`, e instanceof Error ? e.message : e); return fallback; }
  };

  const synced = provider ? await step("sync", () => syncCompetitions(db, provider!, deps, opts), []) : [];
  // Discover the many matches Polymarket lists directly (into catch-all comps).
  // Gated by opts.discover so the frequent tick can skip the daily-ish parse.
  let discovered = 0;
  if (opts.discover !== false) {
    for (const sport of Object.keys(SPORT_TAG_IDS)) {
      const items = await step("discover", () => importPolymarketMatches(db, sport, deps, { limit: opts.discoverLimit }), [] as any[]);
      discovered += items.length;
    }
  }
  // Drop duplicate fixtures (a Polymarket row + a market-less provider clone that
  // slipped past name-matching) BEFORE enrich, so provider data lands on the
  // surviving tradeable row, not the bare clone.
  stepSync("dedupe", () => dedupeMatches(db), 0);
  const odds = await step("odds", () => refreshActiveOdds(db, deps), [] as Awaited<ReturnType<typeof refreshActiveOdds>>);
  // Pull real lineups + live events (ESPN) — this feeds matchContext and, via
  // its fresh events, arms the strategist's in-match reassessment triggers.
  const enrich = provider ? await step("enrich", () => enrichFromEspn(db, provider!, deps), { enriched: 0, newEvents: [] }) : { enriched: 0, newEvents: [] };
  const labelFor = new Map<string, ReassessTrigger>();
  for (const e of enrich.newEvents) if (!labelFor.has(e.matchId)) labelFor.set(e.matchId, LIVE_TRIGGER_TYPES.has(e.type) ? (e.type as ReassessTrigger) : "price_move");
  const triggers = new Set(enrich.newEvents.map((e) => e.matchId));
  stepSync("advanceClocks", () => advanceClocks(db, deps), undefined); // flip lineup_out ~1h before kickoff
  stepSync("stats", () => recordMatchStats(db, deps), 0); // 5-min match-stats snapshot into the events feed
  stepSync("settleStale", () => settleStaleOpenBets(db, deps), 0); // re-settle a finish that raced ahead of the score sync
  stepSync("captureLiveOpens", () => captureLiveOpens(db, deps), undefined); // kickoff-price baseline
  // Analyze BEFORE reassessment: analyzeMatch wipes a match's proposed bets to
  // replace them with the fresh stage's, which would otherwise delete brand-new
  // reassessment proposals created in the same cycle. Running it first means the
  // reassessment's entries are added afterwards and survive to autoEnter.
  const analyzed = await step("analyze", () => autoAnalyze(db, deps), [] as AutoAnalyzeItem[]);
  // deterministic safety-net exits, then strategist-driven reassessment (exits +
  // fresh entries) on matches with risk or a fresh live trigger.
  const reassess = await step("reassess", () => strategistReassess(db, deps, { newEventMatchIds: triggers, labelFor }), { exits: [], entries: [] } as ReassessResult);
  const exited = [...stepSync("exits", () => evaluateExits(db, deps), [] as ExitItem[]), ...reassess.exits];
  const entered = stepSync("autoEnter", () => autoEnter(db, deps), [] as AutoEnterItem[]); // fills both analyze- and reassess-proposed bets
  stepSync("prune", () => R.pruneMarketSnapshots(db), 0); // keep the snapshot history bounded (persistent DB)
  // Bound the matches table: drop finished/stale matches that carry NO bets (the
  // Polymarket discovery flood). Never touches a match with betting history, so
  // metrics/P&L are preserved. Keeps buildAppData's per-poll scan bounded (§502).
  stepSync("pruneMatches", () => R.pruneStaleMatches(db, { staleBeforeMs: (Date.parse(nowFn(deps)()) || Date.now()) - 3 * 86400_000 }), 0);
  // Drop categories we no longer track: untracked sports (cricket) + non-ATP
  // tennis. No-bet only, never a seeded comp. Discovery already stops importing
  // them; this clears the ones imported before the rule changed.
  stepSync("pruneCategories", () => R.pruneRemovedCategories(db, {
    keepSports: new Set(Object.keys(SPORT_LABELS)),
    tennisSeriesAllow: seriesAllowFor("tennis", deps.env) ?? new Set(),
  }), 0);
  return {
    synced: synced.length, imported: synced.filter((r) => r.created).length, discovered,
    oddsMatches: odds.length, oddsUpdated: odds.reduce((n, r) => n + r.updated, 0),
    enriched: enrich.enriched, triggers: triggers.size,
    analyzed, entered, exited, reassessEntries: reassess.entries,
  };
}

// High-impact events that warrant an immediate strategist reassessment (an LLM
// call). Goals and red cards change the game state; yellows/subs are recorded
// and shown, but don't burn a model call on the fast loop.
const LIVE_TRIGGER_TYPES = new Set(["goal", "red_card"]);

// The strategist reassesses at LEAST this often on any live match with open risk,
// regardless of on-pitch events — so positions are re-evaluated (full/partial
// exit) and fresh analytics land on a steady heartbeat, not only on goals.
export const REASSESS_INTERVAL_MIN = 5;

// Match-stats snapshots land on the SAME cadence as the periodic reassessment
// (user: «статистику каждые 5 минут, так же как и переоценку»).
export const STATS_INTERVAL_MIN = REASSESS_INTERVAL_MIN;

/** Format the stored ESPN team-stats JSON into one compact «home–away» line, e.g.
 *  "владение 58%–42% · удары 7–4 · в створ 3–1". Returns null if there's nothing. */
export function formatMatchStats(statsJson: string | null | undefined): string | null {
  if (!statsJson) return null;
  let s: any;
  try { s = JSON.parse(statsJson); } catch { return null; }
  const home = s?.home, away = s?.away;
  const hi = new Map<string, string>(((home?.items ?? []) as any[]).map((x) => [x.label, x.value]));
  const ai = new Map<string, string>(((away?.items ?? []) as any[]).map((x) => [x.label, x.value]));
  // Preserve the order stats appear in for the home side, then any away-only labels.
  const labels = [...hi.keys(), ...[...ai.keys()].filter((l) => !hi.has(l))];
  const parts = labels.map((l) => `${l} ${hi.get(l) ?? "—"}–${ai.get(l) ?? "—"}`);
  if (!parts.length) return null;
  return parts.join(" · ");
}

/**
 * Emit a match-stats snapshot into the events feed for each LIVE match that has
 * ESPN stats, at most one per STATS_INTERVAL_MIN (wall-clock) — the possession /
 * shots / chances readout of «what's happening now», beside goals & cards. Cheap,
 * LLM-free, and deduped by a fresh event_key so it layers a new row each cadence.
 */
export function recordMatchStats(db: Database, deps: EngineDeps = {}): number {
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  let written = 0;
  for (const { match: m } of activeMatches(db)) {
    if (m.state !== "live") continue;
    const live = R.getMatchLive(db, m.id);
    // Prefer real ESPN team stats (possession/shots); fall back to a basic market
    // snapshot (score + prices) so «События матча» ALWAYS shows a 5-min heartbeat,
    // even on matches ESPN can't feed (tennis / obscure leagues) — otherwise the
    // tab would be empty and vanish there.
    const text = formatMatchStats(live?.stats) ?? formatMarketSnapshot(db, m);
    if (!text) continue;
    // Elapsed minute for a clock-only match (no ESPN minute), for the event label.
    const elapsed = m.minute ?? (isIsoTs(m.kickoff_at) ? Math.max(0, Math.floor((nowMs - Date.parse(m.kickoff_at as string)) / 60000)) : null);
    // Cadence gate: skip if a stats snapshot landed within the last interval.
    const prior = R.eventsForMatch(db, m.id).filter((e) => e.type === "stats");
    const last = prior.length ? Date.parse(prior[prior.length - 1].created_at) : NaN;
    if (!isNaN(last) && nowMs - last < STATS_INTERVAL_MIN * 60_000) continue;
    if (R.insertMatchEvent(db, { id: R.uid(), match_id: m.id, event_key: `stats-${now}`, minute: elapsed, type: "stats", team: null, text, created_at: now })) written++;
  }
  return written;
}

const isIsoTs = (s: string | null | undefined): boolean => !!s && /^\d{4}-\d\d-\d\dT/.test(s) && !isNaN(Date.parse(s));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Shorten a verbose Polymarket label for the snapshot: drop the "Tournament: "
 *  prefix and the redundant "A vs B" match title, leaving just the market bit
 *  ("Set 1 Over 10.5"). Falls back to the bare side/name for a plain moneyline. */
function shortMarketLabel(label: string, home: string, away: string): string {
  let s = label.replace(/^[^:]{1,40}:\s*/, ""); // "Quito: ..." → "..."
  for (const [a, b] of [[home, away], [away, home]])
    s = s.replace(new RegExp(`${escapeRe(a)}\\s+vs\\.?\\s+${escapeRe(b)}`, "i"), "");
  s = s.replace(/\bvs\.?\b/i, "").replace(/\s{2,}/g, " ").trim();
  return s || "победитель"; // the title emptied out → it's the match-winner market
}

/** Basic market snapshot for a live match with no sport-stats feed: current score
 *  (if any) + the market-implied leaders — «what's happening now» through the
 *  market, so «События матча» has a heartbeat even without ESPN. Kept short:
 *  degenerate/settled markets (≈0/100¢, "Completed Match") dropped, labels
 *  stripped of the repeated match title, capped to the top 2 by price. */
function formatMarketSnapshot(db: Database, m: Match): string | null {
  const markets = R.latestMarkets(db, m.id).filter((mk) =>
    mk.price != null && mk.price > 2 && mk.price < 98 && !/completed match/i.test(mk.label));
  if (!markets.length) return null;
  const seen = new Set<string>();
  const top: string[] = [];
  for (const mk of markets.slice().sort((a, b) => (b.price ?? 0) - (a.price ?? 0))) {
    const lbl = shortMarketLabel(mk.label, m.home, m.away);
    if (seen.has(lbl)) continue;
    seen.add(lbl);
    top.push(`${lbl} ${mk.price}¢`);
    if (top.length >= 2) break;
  }
  if (!top.length) return null;
  const score = (m.score_home != null && m.score_away != null) ? `счёт ${m.score_home}:${m.score_away} · ` : "";
  return `${score}рынок: ${top.join(" · ")}`;
}

/** LIVE matches due for a periodic reassessment — those not reassessed in the
 *  last REASSESS_INTERVAL_MIN minutes (or never). Fires on ANY funded live match
 *  with tradeable markets, regardless of whether a position is open: reassessment
 *  is both fresh analytics AND a chance to open/exit, so it must not wait for an
 *  on-pitch event (user: «переоценку надо делать каждые 5 минут независимо»).
 *  Gated to state==="live" only: pre-match (`lineup`/time-flipped `lineup_out`)
 *  has no game to react to, and the heartbeat there just churned reassessments. */
function periodicReassessMatches(db: Database, deps: EngineDeps): Set<string> {
  const nowMs = Date.parse(nowFn(deps)()) || Date.now();
  const budgetByComp = new Map(R.listCompetitions(db).map((c) => [c.id, c.budget]));
  const due = new Set<string>();
  for (const { comp, match: m } of activeMatches(db)) {
    if (m.state !== "live") continue;
    if ((budgetByComp.get(comp) ?? 0) <= 0) continue;        // unfunded → skip (economical)
    if (!R.latestMarkets(db, m.id).length) continue;         // nothing to price/trade
    const notes = R.reassessmentsForMatch(db, m.id);
    const last = notes.length ? Date.parse(notes[notes.length - 1].created_at) : NaN;
    if (isNaN(last) || nowMs - last >= REASSESS_INTERVAL_MIN * 60_000) due.add(m.id);
  }
  return due;
}

export interface LiveCycleResult { live: number; oddsUpdated: number; enriched: number; triggers: number; exits: number; entries: number }

/**
 * FAST live loop — runs on a short cadence (every LIVE_TICK_SEC, default 90s)
 * so the system reacts to what happens ON the pitch, not on the 30-minute tick.
 * It is deliberately narrow and cheap:
 *   1) re-price only live/lineup matches (mark to market),
 *   2) pull fresh ESPN events (goals / cards / subs),
 *   3) deterministic exits (take-profit / stop) — no LLM, every tick,
 *   4) strategist reassessment ONLY on a high-impact trigger (goal / red card),
 *      handing it the live context so it acts on open positions or opens new.
 * No Polymarket discovery, no pre-match analysis — those stay on the slow cycle.
 * Returns quickly (and does ~nothing) when no match is in play.
 */
export async function runLiveCycle(
  db: Database, provider: SportsProvider | null, deps: EngineDeps = {},
): Promise<LiveCycleResult> {
  const stepLive = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) { console.error(`[liveCycle:${label}]`, e instanceof Error ? e.message : e); return fallback; }
  };
  const stepSyncLive = <T>(label: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (e) { console.error(`[liveCycle:${label}]`, e instanceof Error ? e.message : e); return fallback; }
  };
  const inPlay = activeMatches(db).filter(({ match: m }) => m.state === "live" || m.state === "lineup" || m.lineup_out);
  if (!inPlay.length) { stepSyncLive("settleStale", () => settleStaleOpenBets(db, deps), 0); return { live: 0, oddsUpdated: 0, enriched: 0, triggers: 0, exits: 0, entries: 0 }; }

  // Each stage isolated: a transient throw in one (a DB/JSON error inside enrich,
  // a settleMatch throw) must NOT abort the deterministic exits / autoEnter below.
  const odds = await stepLive("odds", () => refreshActiveOdds(db, deps, { onlyLive: true }), [] as Awaited<ReturnType<typeof refreshActiveOdds>>);
  stepSyncLive("advanceClocks", () => advanceClocks(db, deps), undefined);
  const enrich = provider ? await stepLive("enrich", () => enrichFromEspn(db, provider, deps), { enriched: 0, newEvents: [] }) : { enriched: 0, newEvents: [] };
  stepSyncLive("settleStale", () => settleStaleOpenBets(db, deps), 0); // re-settle a finish that raced ahead of the score
  stepSyncLive("stats", () => recordMatchStats(db, deps), 0); // 5-min match-stats snapshot into the events feed
  stepSyncLive("captureLiveOpens", () => captureLiveOpens(db, deps), undefined); // snapshot kickoff prices the first time a match is live
  // Reassessment fires on TWO conditions, unioned: (1) a high-impact on-pitch
  // event (goal / red card) — labelled by its type; (2) the periodic 5-min
  // heartbeat on any match with open risk — labelled "time". Both hand the
  // strategist the live context to re-evaluate positions AND open fresh ones.
  const labelFor = new Map<string, ReassessTrigger>();
  const eventTriggers = new Set<string>();
  for (const e of enrich.newEvents) if (LIVE_TRIGGER_TYPES.has(e.type)) { labelFor.set(e.matchId, e.type as ReassessTrigger); eventTriggers.add(e.matchId); }
  for (const id of periodicReassessMatches(db, deps)) if (!labelFor.has(id)) labelFor.set(id, "time");
  const reassessIds = new Set(labelFor.keys());

  const detExits = stepSyncLive("exits", () => evaluateExits(db, deps), [] as ExitItem[]); // cheap TP/stop, reacts to price every tick
  const reassess = await stepLive("reassess", () => strategistReassess(db, deps, { newEventMatchIds: reassessIds, triggeredOnly: true, labelFor }), { exits: [], entries: [] } as ReassessResult);
  stepSyncLive("autoEnter", () => autoEnter(db, deps), [] as AutoEnterItem[]); // fill any positions the strategist just opened

  return {
    live: inPlay.length, oddsUpdated: odds.reduce((n, r) => n + r.updated, 0),
    enriched: enrich.enriched, triggers: eventTriggers.size, // on-pitch events only (periodic reassess is separate)
    exits: detExits.length + reassess.exits.length, entries: reassess.entries.length,
  };
}
