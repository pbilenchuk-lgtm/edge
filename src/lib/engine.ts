// ============================================================
// EDGE LAB — match lifecycle & trigger engine (ТЗ §3.3)  [SERVER-ONLY]
//
// Consumes sports-provider status to:
//   - transition match state (upcoming → live → finished)
//   - fire reassessment triggers (goal / price_move) — rate-limited (§9.7)
//   - refresh Polymarket odds as versioned snapshots + mark-to-market (§2.10)
//   - on finish: snapshot closing prices, settle open bets (§3.4),
//     recompute quality metrics (§2.14)
// Reassessment narratives come from the LLM with a heuristic fallback, so
// triggers work with or without API keys.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Bet, Match } from "./types.js";
import type { SportsMatchStatus } from "./sports.js";
import { reassessNarrative } from "./llm.js";
import { settleBet, resolveFootballMarket } from "./settlement.js";
import { computeMetrics, type MetricSample } from "./metrics.js";
import { loadPolymarketConfig, getQuotes, type PolymarketConfig } from "./polymarket.js";

export interface EngineConfig {
  reassessGapMinutes: number; // §9.7 rate limit
  priceMoveThreshold: number; // cents move that triggers a reassessment
}
export function loadEngineConfig(env: Record<string, string | undefined> = process.env): EngineConfig {
  return {
    reassessGapMinutes: Number(env.REASSESS_GAP_MIN ?? 5),
    priceMoveThreshold: Number(env.PRICE_MOVE_THRESHOLD ?? 5),
  };
}

export interface EngineDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => string;
  polymarket?: PolymarketConfig;
  config?: EngineConfig;
}

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());

// ------------------------------------------------------------
// Reassessment triggers (rate-limited)
// ------------------------------------------------------------

/** §9.7: at most one reassessment per strategy per N match-minutes. */
export function canReassess(
  db: Database, matchId: string, strategyId: string, minute: number | null, gapMinutes: number,
): boolean {
  const prior = R.reassessmentsForMatch(db, matchId).filter((r) => r.strategy_id === strategyId);
  if (!prior.length) return true;
  const last = prior[prior.length - 1];
  const lastMin = parseInt(String(last.minute ?? ""), 10);
  if (minute == null || isNaN(lastMin)) return true;
  return Math.abs(minute - lastMin) >= gapMinutes;
}

export interface ReassessResult { strategyId: string; created: boolean; reason?: string; source?: string; }

export async function triggerReassessment(
  db: Database,
  args: { match: Match; strategyId: string; trigger: "goal" | "red_card" | "price_move" | "time" | "manual"; minute: number | null },
  deps: EngineDeps = {},
): Promise<ReassessResult> {
  const cfg = deps.config ?? loadEngineConfig(deps.env);
  const { match, strategyId, trigger, minute } = args;
  if (trigger !== "manual" && !canReassess(db, match.id, strategyId, minute, cfg.reassessGapMinutes)) {
    return { strategyId, created: false, reason: "rate-limited (§9.7)" };
  }
  const strat = R.getStrategy(db, strategyId);
  if (!strat) return { strategyId, created: false, reason: "strategy not found" };

  const narr = await reassessNarrative(
    {
      match: `${match.home}–${match.away}`, minute, trigger,
      scoreHome: match.score_home, scoreAway: match.score_away,
      strategyName: strat.name, strategyPrompt: strat.prompt,
    },
    strat.model,
    { fetchImpl: deps.fetchImpl, env: deps.env },
  );

  R.insertReassessment(db, {
    id: R.uid(), match_id: match.id, strategy_id: strategyId,
    minute: minute != null ? `${minute}'` : null, body: narr.body,
    confidence: narr.confidence, trigger, created_at: nowFn(deps)(),
  });
  return { strategyId, created: true, source: narr.source };
}

/** Strategies that currently hold an open bet on a match. */
function strategiesWithOpenBets(db: Database, matchId: string): string[] {
  const ids = new Set<string>();
  for (const b of R.betsForMatch(db, matchId)) if (b.status === "open") ids.add(b.strategy_id);
  return [...ids];
}

// ------------------------------------------------------------
// Odds refresh (versioned snapshots + mark-to-market + price_move trigger)
// ------------------------------------------------------------

export async function refreshMatchOdds(
  db: Database, matchId: string, deps: EngineDeps = {},
): Promise<{ updated: number; triggers: ReassessResult[] }> {
  const match = R.getMatch(db, matchId);
  if (!match) return { updated: 0, triggers: [] };
  const cfg = deps.config ?? loadEngineConfig(deps.env);
  const poly = deps.polymarket ?? loadPolymarketConfig(deps.env);
  const now = nowFn(deps)();
  const markets = R.latestMarkets(db, matchId);
  const tokens = markets.filter((m) => m.external_ref).map((m) => ({ tokenId: m.external_ref as string, snapshotCents: m.price }));
  const quotes = await getQuotes(tokens, poly, { fetchImpl: deps.fetchImpl, now: () => now });
  const byTok: Record<string, number | null> = {};
  for (const q of quotes) byTok[q.tokenId] = q.priceCents;

  let updated = 0;
  const triggers: ReassessResult[] = [];
  for (const m of markets) {
    if (!m.external_ref) continue;
    const price = byTok[m.external_ref];
    if (price == null || price === m.price) continue;
    updated++;
    // new versioned snapshot (§2.10)
    R.insertMarket(db, {
      id: R.uid(), match_id: matchId, label: m.label, price, ai_prob: m.ai_prob,
      liquidity: m.liquidity, external_ref: m.external_ref, snapshot_at: now, is_closing: false,
    });
    // mark-to-market open bets on this market
    for (const b of R.betsForMatch(db, matchId)) {
      if (b.status === "open" && b.market_label === m.label) R.updateBet(db, b.id, { current_price: price });
    }
    // price_move reassessment trigger
    if (Math.abs(price - m.price) >= cfg.priceMoveThreshold) {
      for (const sid of strategiesWithOpenBets(db, matchId)) {
        if (R.betsForMatch(db, matchId, sid).some((b) => b.status === "open" && b.market_label === m.label)) {
          triggers.push(await triggerReassessment(db, { match, strategyId: sid, trigger: "price_move", minute: match.minute }, deps));
        }
      }
    }
  }
  return { updated, triggers };
}

// ------------------------------------------------------------
// Settlement + metrics (on finish)
// ------------------------------------------------------------

export function recomputeMetrics(db: Database, strategyId: string, deps: EngineDeps = {}): void {
  const bets = R.settledBetsForStrategy(db, strategyId);
  const samples: MetricSample[] = bets.map((b) => ({
    aiProb: b.ai_prob ?? 0, outcome: (b.result === "won" ? 1 : 0) as 0 | 1,
    entryPrice: b.entry_price ?? 0, closingPrice: b.closing_price,
  }));
  const m = computeMetrics(samples);
  R.upsertQuality(db, {
    strategy_id: strategyId, samples: m.samples, brier: m.brier, clv: m.clv,
    calibration: m.calibration, updated_at: nowFn(deps)(),
  });
}

export function settleMatch(
  db: Database, match: Match, deps: EngineDeps = {},
  overrides: Record<string, boolean> = {},
): { settled: number; skipped: number; affectedStrategies: string[] } {
  const now = nowFn(deps)();
  const closingByLabel: Record<string, number> = {};
  for (const m of R.latestMarkets(db, match.id)) if (!(m.label in closingByLabel)) closingByLabel[m.label] = m.price;

  let settled = 0, skipped = 0;
  const affected = new Set<string>();
  for (const b of R.betsForMatch(db, match.id)) {
    if (b.status !== "open") continue;
    const won = resolveOutcome(b, match, overrides);
    if (won == null) { skipped++; continue; } // needs external result (e.g. Advance)
    const closing = closingByLabel[b.market_label] ?? b.current_price ?? b.entry_price ?? null;
    const patch = settleBet({ entry_price: b.entry_price, stake: b.stake }, won, closing);
    R.updateBet(db, b.id, { status: patch.status, result: patch.result, payout: patch.payout, closing_price: patch.closing_price });
    R.insertTradeLog(db, {
      id: R.uid(), match_id: match.id, strategy_id: b.strategy_id, minute: "финал",
      type: "settle", text: `${b.market_label}: ${won ? "выигрыш" : "проигрыш"} → ${fmt(patch.payout)} (P&L ${fmt(patch.pnl)})`,
      created_at: now,
    });
    settled++; affected.add(b.strategy_id);
  }
  for (const sid of affected) recomputeMetrics(db, sid, deps);
  return { settled, skipped, affectedStrategies: [...affected] };
}

function resolveOutcome(bet: Bet, match: Match, overrides: Record<string, boolean>): boolean | null {
  if (bet.market_label in overrides) return overrides[bet.market_label];
  if (match.score_home == null || match.score_away == null) return null;
  return resolveFootballMarket(bet.market_label, match.score_home, match.score_away);
}

// ------------------------------------------------------------
// Sync one match from a provider status
// ------------------------------------------------------------

export interface SyncResult {
  matchId: string; from: string; to: string;
  goals: number; reassessments: ReassessResult[];
  settlement?: { settled: number; skipped: number };
}

export async function syncMatchStatus(
  db: Database, status: SportsMatchStatus, deps: EngineDeps = {},
  settlementOverrides: Record<string, boolean> = {},
): Promise<SyncResult | null> {
  const match = R.matchByExternalRef(db, status.externalRef);
  if (!match) return null;

  const prevTotal = (match.score_home ?? 0) + (match.score_away ?? 0);
  const newTotal = (status.scoreHome ?? 0) + (status.scoreAway ?? 0);
  const from = match.state;

  const patch: Partial<Match> = {
    state: status.state, minute: status.minute,
    score_home: status.scoreHome, score_away: status.scoreAway,
  };
  if (status.state === "finished") {
    patch.final_score = `${status.scoreHome ?? 0}:${status.scoreAway ?? 0}`;
  }
  R.updateMatch(db, match.id, patch);
  const updated = { ...match, ...patch } as Match;

  const reassessments: ReassessResult[] = [];
  let goals = 0;

  // goal trigger (score increased while live)
  if ((status.state === "live" || status.state === "finished") && match.score_home != null && newTotal > prevTotal) {
    goals = newTotal - prevTotal;
    for (const sid of strategiesWithOpenBets(db, match.id)) {
      reassessments.push(await triggerReassessment(db, { match: updated, strategyId: sid, trigger: "goal", minute: status.minute }, deps));
    }
  }

  let settlement;
  if (status.state === "finished" && from !== "finished") {
    settlement = settleMatch(db, updated, deps, settlementOverrides);
  }

  return { matchId: match.id, from, to: status.state, goals, reassessments, settlement };
}

const fmt = (n: number) => `$${n.toFixed(1)}`;
