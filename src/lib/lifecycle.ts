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
import { syncCompetitions, refreshActiveOdds, recomputeMetrics, importPolymarketMatches, enrichFromEspn } from "./engine.js";
import { SPORT_TAG_IDS } from "./polymarket.js";
import { analyzeMatch, jobActive, matchContext, strategyDrawdown } from "./analysis.js";
import { exitDecision, sizeBet } from "./thresholds.js";
import { stratBudget } from "./money.js";
import { strategistDecide, effectiveEnv } from "./llm.js";
import { hoursUntil } from "./time.js";
import type { Confidence } from "./types.js";

// Timing gates (hours before kickoff). Pre-match assessment opens ~12h out;
// lineups are treated as out ~1h before (WC teamsheets), triggering the final
// (post-lineup) reassessment.
export const ANALYZE_PRE_HOURS = 12;
export const LINEUP_HOURS = 1;
import type { SportsProvider } from "./sports.js";
import type { Match } from "./types.js";

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());
const minuteLabel = (m: Match) => (m.state === "live" && m.minute != null ? `${m.minute}'` : "предматч");
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

/** For matches with a real kickoff time, mark lineups out ~1h before (WC), so
 *  the post-lineup reassessment fires. Only touches time-scheduled (PM) matches;
 *  ESPN-driven live state is left to syncMatchStatus. */
export function advanceClocks(db: Database, deps: EngineDeps = {}): void {
  const nowMs = Date.parse(nowFn(deps)()) || Date.now();
  for (const { match: m } of activeMatches(db)) {
    const h = hoursUntil(m.kickoff_at, nowMs);
    if (h == null) continue;
    const lineupOut = h <= LINEUP_HOURS;
    if (lineupOut !== m.lineup_out) R.updateMatch(db, m.id, { lineup_out: lineupOut, state: lineupOut ? "lineup" : "upcoming" });
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

export function autoEnter(db: Database, deps: EngineDeps = {}): AutoEnterItem[] {
  const now = nowFn(deps)();
  const out: AutoEnterItem[] = [];
  for (const { match: m } of activeMatches(db)) {
    const markets = R.latestMarkets(db, m.id);
    for (const b of R.betsForMatch(db, m.id)) {
      if (b.status !== "proposed") continue;
      const price = markets.find((x) => x.label === b.market_label)?.price ?? b.proposed_price ?? 0;
      if (price <= 0) continue;
      R.updateBet(db, b.id, { status: "open", entry_price: price, current_price: price, entered_minute: minuteLabel(m) });
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
  const stake = bet.stake ?? 0;
  const entry = bet.entry_price ?? 0;
  const payout = entry > 0 ? round2(stake * (currentPriceCents / entry)) : 0;
  const pnl = round2(payout - stake);
  // "early" cash-out: booked by P&L sign, NOT by real outcome — excluded from
  // the predictive metrics (Brier/CLV) so trading P&L doesn't masquerade as
  // prediction accuracy.
  R.updateBet(db, bet.id, { status: pnl >= 0 ? "settled_won" : "settled_lost", result: pnl >= 0 ? "won" : "lost", payout, closing_price: currentPriceCents, settled_by: "early" });
  return pnl;
}

/**
 * Close a FRACTION of an open position (partial fixation, §4.2). fraction>=1 is
 * a full close; otherwise the closed slice is booked as a settled child bet and
 * the original open bet's stake shrinks by that slice, leaving the rest running.
 */
function closeBetPortion(db: Database, bet: any, fraction: number, currentPriceCents: number, minute: string, now: string): { pnl: number; partial: boolean } {
  if (fraction >= 1) return { pnl: closeBetEarly(db, bet, currentPriceCents, "", minute, now), partial: false };
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
    result: pnl >= 0 ? "won" : "lost", payout, settled_by: "partial", created_at: now,
  });
  R.updateBet(db, bet.id, { stake: round2(stake - closed) }); // keep the remainder open
  return { pnl, partial: true };
}

export function evaluateExits(db: Database, deps: EngineDeps = {}): ExitItem[] {
  const now = nowFn(deps)();
  const out: ExitItem[] = [];
  const touched = new Set<string>();
  for (const { match: m } of activeMatches(db)) {
    const markets = R.latestMarkets(db, m.id);
    for (const b of R.betsForMatch(db, m.id)) {
      if (b.status !== "open") continue;
      const mk = markets.find((x) => x.label === b.market_label);
      if (!mk || mk.price == null || b.entry_price == null) continue;
      const strat = R.getStrategy(db, b.strategy_id);
      if (!strat) continue;
      const d = exitDecision({ params: strat.params, aiProb: b.ai_prob ?? mk.price / 100, entryPriceCents: b.entry_price, currentPriceCents: mk.price });
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
  db: Database, deps: EngineDeps = {}, opts: { max?: number; newEventMatchIds?: Set<string>; triggeredOnly?: boolean } = {},
): Promise<ReassessResult> {
  const max = opts.max ?? 4;
  const triggered = opts.newEventMatchIds ?? new Set<string>();
  // Event-driven mode (fast live loop): only reassess matches with a fresh
  // trigger — don't burn an LLM call every tick on quiet open positions.
  const triggeredOnly = opts.triggeredOnly ?? false;
  const now = nowFn(deps)();
  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  const comps = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  const out: ReassessResult = { exits: [], entries: [] };
  const touched = new Set<string>();
  let calls = 0;
  for (const { comp, sport, match: m } of activeMatches(db)) {
    if (calls >= max) break;
    const c = comps.get(comp);
    if (!c || c.budget <= 0) continue;
    const open = R.betsForMatch(db, m.id).filter((b) => b.status === "open");
    // Reassess only where there's live risk (open positions) or a fresh trigger.
    // In triggeredOnly mode (fast loop) a trigger is REQUIRED — quiet positions
    // are handled by the deterministic exits + the slow full cycle.
    if (triggeredOnly ? !triggered.has(m.id) : (!open.length && !triggered.has(m.id))) continue;
    const markets = R.latestMarkets(db, m.id);
    if (!markets.length) continue;
    const assess = R.assessmentsForMatch(db, m.id).filter((a) => a.status === "ok").sort((a, b) => (a.created_at >= b.created_at ? -1 : 1))[0];
    const ctx = matchContext(db, m.id); // real lineups + events

    // Strategies to run: those with an active share (can enter) plus any that
    // already hold an open position on this match (must be able to exit).
    const shares = R.sharesForComp(db, comp);
    const sids = new Set<string>();
    for (const s of shares) if (s.pct > 0) sids.add(s.strategy_id);
    for (const b of open) sids.add(b.strategy_id);

    for (const sid of sids) {
      if (calls >= max) break;
      const strat = R.getStrategy(db, sid);
      if (!strat) continue;
      const myOpen = open.filter((b) => b.strategy_id === sid);
      calls++;
      const dec = await strategistDecide({
        strategyName: strat.name, strategyPrompt: strat.prompt,
        match: { home: m.home, away: m.away, sport, state: m.state, minute: m.minute, scoreHome: m.score_home, scoreAway: m.score_away },
        assessment: { confidence: assess?.confidence ?? "средняя", short: assess?.short ?? "", verdict: assess?.verdict ?? "" },
        markets: markets.map((mk) => ({ label: mk.label, priceCents: mk.price, aiProb: mk.ai_prob })),
        openPositions: myOpen.map((b) => ({ market: b.market_label, entryCents: b.entry_price ?? 0, currentCents: b.current_price ?? b.entry_price ?? 0 })),
        context: ctx,
      }, strat.model ?? "Claude Opus 4.8", { fetchImpl: deps.fetchImpl, env });
      if (!dec.ok) continue;

      // (a) EXITS — full or partial fixation on this strategy's open positions.
      const exited = new Set<string>();
      for (const ex of dec.exits) {
        const key = norm(ex.market);
        if (exited.has(key)) continue; // one close per market — a duplicate exit would size off a stale stake
        const b = myOpen.find((x) => norm(x.market_label) === key);
        const mk = b && markets.find((x) => x.label === b.market_label);
        if (!b || !mk || mk.price == null || b.entry_price == null) continue;
        exited.add(key);
        const { pnl, partial } = closeBetPortion(db, b, ex.fraction, mk.price, minuteLabel(m), now);
        const tag = partial ? `частично ${Math.round(ex.fraction * 100)}%` : "полностью";
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "exit", text: `выход «${b.market_label}» (${tag}) @ ${mk.price}¢ · стратег: ${ex.reason} · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, created_at: now });
        out.exits.push({ matchId: m.id, strategyId: sid, market: b.market_label, reason: `стратег (${tag}): ${ex.reason}`, pnl });
        touched.add(sid);
      }

      // (b) ENTRIES — fresh positions the trigger opened. Only strategies with a
      // live share can enter; code sizes/gates. Dedup against markets this
      // strategy already holds/proposed so we never double up on the same bet.
      const share = shares.find((s) => s.strategy_id === sid);
      if (!share || share.pct <= 0 || !dec.picks.length) continue;
      const budget = stratBudget(c.budget, share.pct);
      const drawdown = strategyDrawdown(db, comp, sid, budget);
      const held = new Set(R.betsForMatch(db, m.id, sid).filter((b) => b.status === "open" || b.status === "proposed").map((b) => norm(b.market_label)));
      // Seed exposure from BOTH open and still-proposed stakes — autoEnter will
      // fill the proposals, so a new entry must be sized against them too (§9.3).
      let exposure = R.betsForMatch(db, m.id, sid).filter((b) => b.status === "open" || b.status === "proposed").reduce((n, b) => n + (b.stake ?? 0), 0);
      for (const pick of dec.picks) {
        const mk = markets.find((x) => norm(x.label) === norm(pick.label));
        if (!mk || mk.ai_prob == null || mk.price == null) continue; // need a probability to size
        if (held.has(norm(mk.label))) continue;                       // already in this market
        const d = sizeBet({ params: strat.params, aiProb: mk.ai_prob, priceCents: mk.price, budget, exposure, confidence: pick.conviction as Confidence, drawdown });
        if (!d.enter) continue;
        exposure += d.stake;
        held.add(norm(mk.label));
        R.insertBet(db, {
          id: R.uid(), match_id: m.id, strategy_id: sid, market_label: mk.label,
          status: "proposed", proposed_price: mk.price, entry_price: null, current_price: null,
          closing_price: null, ai_prob: mk.ai_prob, stake: d.stake,
          rationale: `переоценка: «${mk.label}» край ${d.edge.toFixed(1)}%. ${pick.reason || d.reason}.`,
          entered_minute: null, result: null, payout: null, created_at: now,
        });
        out.entries.push({ matchId: m.id, strategyId: sid, market: mk.label, stake: d.stake });
        touched.add(sid);
      }
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
  const synced = provider ? await syncCompetitions(db, provider, deps, opts) : [];
  // Discover the many matches Polymarket lists directly (into catch-all comps).
  // Gated by opts.discover so the frequent tick can skip the daily-ish parse.
  let discovered = 0;
  if (opts.discover !== false) {
    for (const sport of Object.keys(SPORT_TAG_IDS)) {
      const items = await importPolymarketMatches(db, sport, deps, { limit: opts.discoverLimit ?? 200 });
      discovered += items.length;
    }
  }
  const odds = await refreshActiveOdds(db, deps);
  // Pull real lineups + live events (ESPN) — this feeds matchContext and, via
  // its fresh events, arms the strategist's in-match reassessment triggers.
  const enrich = provider ? await enrichFromEspn(db, provider, deps) : { enriched: 0, newEvents: [] };
  const triggers = new Set(enrich.newEvents.map((e) => e.matchId));
  advanceClocks(db, deps); // flip lineup_out ~1h before kickoff (time-scheduled fallback)
  captureLiveOpens(db, deps); // kickoff-price baseline for the odds column
  // Analyze BEFORE reassessment: analyzeMatch wipes a match's proposed bets to
  // replace them with the fresh stage's, which would otherwise delete brand-new
  // reassessment proposals created in the same cycle. Running it first means the
  // reassessment's entries are added afterwards and survive to autoEnter.
  const analyzed = await autoAnalyze(db, deps);
  // deterministic safety-net exits, then strategist-driven reassessment (exits +
  // fresh entries) on matches with risk or a fresh live trigger.
  const reassess = await strategistReassess(db, deps, { newEventMatchIds: triggers });
  const exited = [...evaluateExits(db, deps), ...reassess.exits];
  const entered = autoEnter(db, deps); // fills both analyze- and reassess-proposed bets
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
  const inPlay = activeMatches(db).filter(({ match: m }) => m.state === "live" || m.state === "lineup" || m.lineup_out);
  if (!inPlay.length) return { live: 0, oddsUpdated: 0, enriched: 0, triggers: 0, exits: 0, entries: 0 };

  const odds = await refreshActiveOdds(db, deps, { onlyLive: true });
  advanceClocks(db, deps);
  const enrich = provider ? await enrichFromEspn(db, provider, deps) : { enriched: 0, newEvents: [] };
  captureLiveOpens(db, deps); // snapshot kickoff prices the first time a match is live
  // only goals / red cards trigger the (LLM) strategist reassessment
  const triggers = new Set(enrich.newEvents.filter((e) => LIVE_TRIGGER_TYPES.has(e.type)).map((e) => e.matchId));

  const detExits = evaluateExits(db, deps); // cheap TP/stop, reacts to price every tick
  const reassess = await strategistReassess(db, deps, { newEventMatchIds: triggers, triggeredOnly: true });
  autoEnter(db, deps); // fill any positions the strategist just opened

  return {
    live: inPlay.length, oddsUpdated: odds.reduce((n, r) => n + r.updated, 0),
    enriched: enrich.enriched, triggers: triggers.size,
    exits: detExits.length + reassess.exits.length, entries: reassess.entries.length,
  };
}
