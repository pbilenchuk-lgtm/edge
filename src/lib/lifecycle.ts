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
import { syncCompetitions, refreshActiveOdds, recomputeMetrics, importPolymarketMatches } from "./engine.js";
import { SPORT_TAG_IDS } from "./polymarket.js";
import { analyzeMatch, jobActive } from "./analysis.js";
import { exitDecision } from "./thresholds.js";
import { strategistDecide, effectiveEnv } from "./llm.js";
import { hoursUntil } from "./time.js";

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
  R.updateBet(db, bet.id, { status: pnl >= 0 ? "settled_won" : "settled_lost", result: pnl >= 0 ? "won" : "lost", payout, closing_price: currentPriceCents });
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
    result: pnl >= 0 ? "won" : "lost", payout, created_at: now,
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

/**
 * Strategist-driven exits: for matches with open positions (funded comps), let
 * the strategy PROMPT decide what to cut per its in-match methodology (scenario
 * change, "this event broke the position"). Complements the deterministic
 * evaluateExits. Capped per run — one model call per (match, strategy) with
 * open positions — so it only runs where the user actually holds risk.
 */
export async function strategistExits(db: Database, deps: EngineDeps = {}, opts: { max?: number } = {}): Promise<ExitItem[]> {
  const max = opts.max ?? 4;
  const now = nowFn(deps)();
  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  const budgetByComp = new Map(R.listCompetitions(db).map((c) => [c.id, c.budget]));
  const out: ExitItem[] = [];
  const touched = new Set<string>();
  let calls = 0;
  for (const { comp, sport, match: m } of activeMatches(db)) {
    if (calls >= max) break;
    if ((budgetByComp.get(comp) ?? 0) <= 0) continue;
    const open = R.betsForMatch(db, m.id).filter((b) => b.status === "open");
    if (!open.length) continue;
    const markets = R.latestMarkets(db, m.id);
    const assess = R.assessmentsForMatch(db, m.id).filter((a) => a.status === "ok").sort((a, b) => (a.created_at >= b.created_at ? -1 : 1))[0];
    const byStrat = new Map<string, typeof open>();
    for (const b of open) (byStrat.get(b.strategy_id) ?? byStrat.set(b.strategy_id, []).get(b.strategy_id)!).push(b);
    for (const [sid, bets] of byStrat) {
      if (calls >= max) break;
      const strat = R.getStrategy(db, sid);
      if (!strat) continue;
      calls++;
      const dec = await strategistDecide({
        strategyName: strat.name, strategyPrompt: strat.prompt,
        match: { home: m.home, away: m.away, sport, state: m.state, minute: m.minute, scoreHome: m.score_home, scoreAway: m.score_away },
        assessment: { confidence: assess?.confidence ?? "средняя", short: assess?.short ?? "", verdict: assess?.verdict ?? "" },
        markets: markets.map((mk) => ({ label: mk.label, priceCents: mk.price, aiProb: mk.ai_prob })),
        openPositions: bets.map((b) => ({ market: b.market_label, entryCents: b.entry_price ?? 0, currentCents: b.current_price ?? b.entry_price ?? 0 })),
      }, strat.model ?? "Claude Opus 4.8", { fetchImpl: deps.fetchImpl, env });
      if (!dec.ok) continue;
      for (const ex of dec.exits) {
        const b = bets.find((x) => norm(x.market_label) === norm(ex.market));
        const mk = b && markets.find((x) => x.label === b.market_label);
        if (!b || !mk || mk.price == null || b.entry_price == null) continue;
        const { pnl, partial } = closeBetPortion(db, b, ex.fraction, mk.price, minuteLabel(m), now);
        const tag = partial ? `частично ${Math.round(ex.fraction * 100)}%` : "полностью";
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "exit", text: `выход «${b.market_label}» (${tag}) @ ${mk.price}¢ · стратег: ${ex.reason} · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, created_at: now });
        out.push({ matchId: m.id, strategyId: sid, market: b.market_label, reason: `стратег (${tag}): ${ex.reason}`, pnl });
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
  analyzed: AutoAnalyzeItem[]; entered: AutoEnterItem[]; exited: ExitItem[];
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
  advanceClocks(db, deps); // flip lineup_out ~1h before kickoff
  // deterministic safety-net exits first, then strategist-driven cuts on what's left
  const exited = [...evaluateExits(db, deps), ...(await strategistExits(db, deps))];
  const analyzed = await autoAnalyze(db, deps);
  const entered = autoEnter(db, deps);
  return {
    synced: synced.length, imported: synced.filter((r) => r.created).length, discovered,
    oddsMatches: odds.length, oddsUpdated: odds.reduce((n, r) => n + r.updated, 0),
    analyzed, entered, exited,
  };
}
