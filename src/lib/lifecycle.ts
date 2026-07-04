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
import { syncCompetitions, refreshActiveOdds, recomputeMetrics } from "./engine.js";
import { analyzeMatch, jobActive } from "./analysis.js";
import { exitDecision } from "./thresholds.js";
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
// 1) Auto-analyze
// ------------------------------------------------------------

export interface AutoAnalyzeItem { matchId: string; match: string; stage: string; ok: boolean; bets: number }

export async function autoAnalyze(db: Database, deps: EngineDeps = {}): Promise<AutoAnalyzeItem[]> {
  const out: AutoAnalyzeItem[] = [];
  for (const { match: m } of activeMatches(db)) {
    if (!R.latestMarkets(db, m.id).length) continue;               // needs tradeable odds
    const stage = m.lineup_out ? "post_lineup" : "pre_lineup";
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

/** Close a single open bet at the current price (cash out the paper position). */
function closeBetEarly(db: Database, bet: { id: string; stake: number | null; entry_price: number | null }, currentPriceCents: number, reason: string, minute: string, now: string): number {
  const stake = bet.stake ?? 0;
  const entry = bet.entry_price ?? 0;
  const payout = entry > 0 ? round2(stake * (currentPriceCents / entry)) : 0;
  const pnl = round2(payout - stake);
  R.updateBet(db, bet.id, { status: pnl >= 0 ? "settled_won" : "settled_lost", result: pnl >= 0 ? "won" : "lost", payout, closing_price: currentPriceCents });
  return pnl;
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

// ------------------------------------------------------------
// 4) Orchestration
// ------------------------------------------------------------

export interface AutoCycleResult {
  synced: number; imported: number; oddsMatches: number; oddsUpdated: number;
  analyzed: AutoAnalyzeItem[]; entered: AutoEnterItem[]; exited: ExitItem[];
}

/**
 * One full automated pass. Order matters: import & status first (settles
 * finished matches, fires goal reassessments), then refresh prices (mark to
 * market, price_move reassessments), then exits on fresh prices, then analyze
 * newly-eligible matches, then fill their proposals.
 */
export async function runAutoCycle(
  db: Database, provider: SportsProvider | null, deps: EngineDeps = {}, opts: { linkOdds?: boolean } = {},
): Promise<AutoCycleResult> {
  const synced = provider ? await syncCompetitions(db, provider, deps, opts) : [];
  const odds = await refreshActiveOdds(db, deps);
  const exited = evaluateExits(db, deps);
  const analyzed = await autoAnalyze(db, deps);
  const entered = autoEnter(db, deps);
  return {
    synced: synced.length, imported: synced.filter((r) => r.created).length,
    oddsMatches: odds.length, oddsUpdated: odds.reduce((n, r) => n + r.updated, 0),
    analyzed, entered, exited,
  };
}
