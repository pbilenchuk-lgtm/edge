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
import type { Bet, Competition, Match, MatchState } from "./types.js";
import type { SportsMatchStatus } from "./sports.js";
import { reassessNarrative, effectiveEnv } from "./llm.js";
import { settleBet, resolveFootballMarket, matchPhase, isResolutionSettle } from "./settlement.js";
import { isFtBlindBet } from "./betMeta.js";
import { computeMetrics, type MetricSample } from "./metrics.js";
import { loadPolymarketConfig, getQuotes, findMatchEvents, matchMarketSnapshots, discoverSportMatches, SPORT_LABELS, type PolymarketConfig } from "./polymarket.js";
import { liquidationCents } from "./execution.js";
import { loadShadowConfig, shadowOnExit } from "./shadow.js";
import { recordComebackLatency } from "./overreactionLatency.js";
import { isIso, finishStamp } from "./time.js";
import type { SportsProvider } from "./sports.js";
import { UEFA_TWO_LEG } from "./footballIntegrity.js";
import { foldLetters } from "./nameFold.js";
import { getTeamAliases } from "./teamAliases.js";

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

/** Monotonic match-state ordering — provider writes must never regress below the
 *  stored state (a stale poll can't flip live→upcoming or finished→live). */
const STATE_RANK: Record<MatchState, number> = { upcoming: 0, lineup: 1, live: 2, finished: 3 };

// ------------------------------------------------------------
// Reassessment triggers (rate-limited)
// ------------------------------------------------------------

/** §9.7: at most one reassessment per strategy per N match-minutes. */
export function canReassess(
  db: Database, matchId: string, strategyId: string, minute: number | null, gapMinutes: number,
): boolean {
  // Only engine-driven narratives (goal / red_card / price_move) count toward
  // THIS gap — a routine strategist heartbeat ('time') or a manual run must not
  // suppress a real on-pitch trigger's narrative (they use separate cadences).
  const prior = R.reassessmentsForMatch(db, matchId)
    .filter((r) => r.strategy_id === strategyId && r.trigger !== "time" && r.trigger !== "manual");
  if (!prior.length) return true;
  if (minute == null) {
    // No match clock (pre-clock / a league ESPN gives no minute for): rate-limit
    // on WALL-CLOCK instead, or every price tick would fire a fresh narrative.
    const last = Date.parse(prior[prior.length - 1].created_at);
    return isNaN(last) || Date.now() - last >= gapMinutes * 60_000;
  }
  // Compare against the last reassessment that HAS a parseable match-minute;
  // skip null-minute ones (e.g. manual triggers) so they don't reset the gap.
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = parseInt(String(prior[i].minute ?? ""), 10);
    if (!isNaN(m)) return Math.abs(minute - m) >= gapMinutes;
  }
  return true;
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

  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  const narr = await reassessNarrative(
    {
      match: `${match.home}–${match.away}`, minute, trigger,
      scoreHome: match.score_home, scoreAway: match.score_away,
      strategyName: strat.name, strategyPrompt: strat.prompt,
    },
    strat.model,
    { fetchImpl: deps.fetchImpl, env },
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
    // Quote-refresh updates the mid from CLOB /midpoint (no fresh book). The book's SPREAD structure
    // changes slower than the mid tick, so carry the last Gamma-sourced ask/spread forward — a stale-ish
    // ask still beats the mid on a wide-spread book. But drop it if the new mid has CROSSED the carried
    // ask (price ≥ ask is incoherent → the book moved) — then edge falls back to mid (flagged). Cheap
    // price-based staleness, no extra timestamp; the book-fill guard remains the final backstop.
    const askStillCoherent = m.ask_cents != null && price < m.ask_cents;
    R.insertMarket(db, {
      id: R.uid(), match_id: matchId, label: m.label, price, ai_prob: m.ai_prob,
      liquidity: m.liquidity, external_ref: m.external_ref, token_second: m.token_second ?? null, snapshot_at: now, is_closing: false,
      ask_cents: askStillCoherent ? m.ask_cents : null, spread_cents: askStillCoherent ? m.spread_cents : null,
    });
    // mark-to-market open bets on this market — at LIQUIDATION value (mid haircut
    // for exit slippage − exit fee), not the raw mid, so unrealized P&L / equity
    // reflect what you could actually cash out on this book.
    const liq = Number(m.liquidity ?? 0) || 0;
    for (const b of R.betsForMatch(db, matchId)) {
      if (b.status !== "open" || b.market_label !== m.label) continue;
      const mtm = poly.enabled ? liquidationCents(price, b.stake ?? 0, liq, poly.exec.fallbackK, poly.exec.takerFeeRate) : price;
      R.updateBet(db, b.id, { current_price: mtm });
    }
    // price_move reassessment trigger — LIVE only (ТЗ §3.3). Pre-match a
    // discovered match sits in `lineup`/time-flipped `lineup_out` with no game,
    // and illiquid Polymarket markets drift ≥threshold constantly, which fired a
    // flood of "движение цены на старте без игрового триггера" reassessments on a
    // not-yet-started match. Mark-to-market above still runs; only the trigger waits.
    if (match.state === "live" && Math.abs(price - m.price) >= cfg.priceMoveThreshold) {
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
// Refresh odds across all active matches (scheduler/cron path)
// ------------------------------------------------------------

export interface OddsRefreshItem { matchId: string; match: string; updated: number; reassessments: number; }

/**
 * Re-quote every non-finished match that has Polymarket-backed markets. This is
 * the LLM-free half of the cron (no match ANALYSIS is triggered): only the live
 * engine's own price_move reassessments can fire — rate-limited (§9.7), only for
 * strategies already holding an open bet, and with a heuristic fallback, exactly
 * as the manual per-match refresh button behaves.
 */
export async function refreshActiveOdds(db: Database, deps: EngineDeps = {}, opts: { onlyLive?: boolean } = {}): Promise<OddsRefreshItem[]> {
  const out: OddsRefreshItem[] = [];
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      if (m.state === "finished") continue;
      // fast live loop: only re-price matches in play (or with lineups out)
      if (opts.onlyLive && !(m.state === "live" || m.state === "lineup" || m.lineup_out)) continue;
      if (!R.latestMarkets(db, m.id).some((mk) => mk.external_ref)) continue;
      const r = await refreshMatchOdds(db, m.id, deps);
      if (r.updated || r.triggers.length) {
        out.push({ matchId: m.id, match: `${m.home}–${m.away}`, updated: r.updated, reassessments: r.triggers.filter((t) => t.created).length });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------
// Settlement + metrics (on finish)
// ------------------------------------------------------------

export function recomputeMetrics(db: Database, strategyId: string, deps: EngineDeps = {}): void {
  // Only bets settled by the REAL match outcome measure prediction quality.
  // Early/partial cash-outs are booked by P&L sign and would bias Brier/CLV.
  // FT-blind bets (blind Polymarket-only entries) are a SEPARATE risk cohort — zero in-flight management —
  // so they must NOT mix into the managed prematch_value Brier/CLV verdict (Decision-1 condition 2).
  const bets = R.settledBetsForStrategy(db, strategyId).filter((b) => isResolutionSettle(b.settled_by) && !isFtBlindBet(b));
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
  // CLV closing line: the KICKOFF price (when pre-match betting closed) is the
  // real benchmark — the finish-time market price is post-resolution (~0/100)
  // and would make CLV just P&L again. Fall back to the last price if no kickoff.
  const kickoff = R.openOddsFor(db, match.id);

  let settled = 0, skipped = 0;
  const affected = new Set<string>();
  const shadowCfg = loadShadowConfig(db, deps.env);
  // A bet resolving on the match result must ALSO free its shadow-bank reserve —
  // otherwise the $5000 pool keeps counting settled positions as "reserved" forever
  // (orphaned capital: free understated, caps falsely tightened). Mirrors the
  // early-close path, which already calls shadowOnExit. Observe-only; never throws.
  const releaseShadow = (betId: string) => { try { shadowOnExit(db, betId, 1, shadowCfg, now); } catch { /* observe-only */ } };
  for (const b of R.betsForMatch(db, match.id)) {
    if (b.status !== "open") continue;
    const won = resolveOutcome(b, match, overrides);
    if (won == null) {
      // Distinguish "no score yet" from "unresolvable market label". If the
      // final score isn't in yet (a finish that raced ahead of the score sync),
      // DON'T void — that would erase a real winner/loser. Leave it open; it
      // settles once the score lands. Only genuinely unresolvable markets
      // (Advance / penalties / unknown label, score KNOWN) fall through to void.
      if (match.score_home == null || match.score_away == null) { skipped++; continue; }
      // The match is FINISHED with a known score but this market can't be
      // auto-resolved (Advance / penalties / an unknown label, no override).
      // Leaving it open strands the stake as open exposure forever — the match
      // is never active again. Void it: refund the stake, zero P&L, tagged
      // 'void' so it's excluded from win/lose accuracy.
      R.updateBet(db, b.id, {
        status: "settled_void", result: null, payout: b.stake ?? 0, settled_at: now,
        closing_price: b.current_price ?? b.entry_price ?? null, settled_by: "void",
      });
      releaseShadow(b.id);
      R.insertTradeLog(db, {
        id: R.uid(), match_id: match.id, strategy_id: b.strategy_id, minute: "финал",
        type: "settle", text: `${b.market_label}: рынок не рассчитывается автоматически — возврат ставки ${fmt(b.stake ?? 0)} (P&L $0)`,
        created_at: now,
      });
      skipped++; affected.add(b.strategy_id);
      continue;
    }
    // Closing line for CLV = the KICKOFF snapshot — but ONLY for PRE-match bets.
    // CLV measures beating the closing (kickoff) line, which is defined relative
    // to a bet placed BEFORE kickoff. For an IN-MATCH entry the kickoff price
    // predates the bet, so benchmarking against it is meaningless and biased the
    // metric negative — give those a NEUTRAL CLV (closing = entry). With no
    // kickoff captured, fall back to entry too (never the post-resolution price).
    const preMatch = b.entered_minute == null || /предматч/i.test(b.entered_minute);
    const closing = preMatch ? (kickoff[b.market_label] ?? b.entry_price ?? null) : (b.entry_price ?? null);
    const patch = settleBet({ entry_price: b.entry_price, stake: b.stake }, won, closing);
    // Provenance (Decision-1 condition 5): this resolution came from OUR match score. Explicit tag so an audit
    // can tell it apart from a pm_resolution settle; isResolutionSettle keeps both in the metric/verdict cohort.
    R.updateBet(db, b.id, { status: patch.status, result: patch.result, payout: patch.payout, closing_price: patch.closing_price, settled_at: now, settled_by: "match_score" });
    releaseShadow(b.id);
    R.insertTradeLog(db, {
      id: R.uid(), match_id: match.id, strategy_id: b.strategy_id, minute: "финал",
      type: "settle", text: `${b.market_label}: ${won ? "выигрыш" : "проигрыш"} → ${fmt(patch.payout)} (P&L ${fmt(patch.pnl)})`,
      created_at: now,
    });
    settled++; affected.add(b.strategy_id);
  }
  // Close out orphaned PROPOSALS: a proposed bet that never filled (autoEnter held
  // it — no provider live coverage on this match, or its price/liquidity guard hit)
  // would otherwise sit as «предлагается» forever on a finished match. Mark it
  // not_filled so the terminal state is honest and the pair frees its exposure.
  for (const b of R.betsForMatch(db, match.id)) {
    if (b.status !== "proposed") continue;
    R.updateBet(db, b.id, { status: "not_filled", settled_at: now, rationale: appendReasonEngine(b.rationale, "матч завершился — вход не открывался (нет live-данных провайдера или не наступили условия)") });
    R.insertTradeLog(db, { id: R.uid(), match_id: match.id, strategy_id: b.strategy_id, minute: "финал", type: "skip", text: `${b.market_label}: предложение не открылось до конца матча (нет live-покрытия / условия не наступили)`, created_at: now });
    affected.add(b.strategy_id);
  }
  for (const sid of affected) recomputeMetrics(db, sid, deps);
  // Compute-at-settle: persist this match's Overreaction latency cases while snapshots are
  // still hot (rolling measurement). Observe-only + fully guarded — a failure here must
  // NEVER break settlement. Idempotent (a per-match marker), so repeated settle calls no-op.
  try { recordComebackLatency(db, match, deps); } catch (e) { console.warn(`[comeback-latency] ${match.id}: ${e instanceof Error ? e.message : String(e)}`); }
  return { settled, skipped, affectedStrategies: [...affected] };
}
/** Append a short reason to a bet rationale (engine-local; mirrors lifecycle's). */
function appendReasonEngine(rationale: string | null, note: string): string {
  return rationale ? `${rationale} · ${note}` : note;
}

/**
 * Safety-net sweep: a finish that races ahead of the score sync makes settleMatch
 * leave those bets OPEN (see the skip branch above), and no state-transition edge
 * ever fires settleMatch again once the match row is already `finished`. So sweep
 * every finished match that still has open bets and a known score, and settle it.
 * Cheap (one query + one getMatch per affected match) and idempotent.
 */
export function settleStaleOpenBets(db: Database, deps: EngineDeps = {}): number {
  const matchIds = new Set<string>();
  for (const b of R.openBets(db)) matchIds.add(b.match_id);
  let settled = 0;
  for (const mid of matchIds) {
    const m = R.getMatch(db, mid);
    if (m && m.state === "finished" && m.score_home != null && m.score_away != null && !isStateSuspect(db, mid)) {
      settled += settleMatch(db, m, deps).settled; // F2: never settle a state_suspect finish (feed died early)
    }
  }
  return settled;
}

/**
 * P1(в) [batch-7]: RE-SETTLE the two-leg suspects by the corrected binding. footballIntegrity flags a settled
 * bet on a two-leg comp `settle_suspect` because its grade may have come off the OTHER leg (Raków won 3:1 but
 * "Raków — Yes" booked settled_lost). markUefaSettleSuspect catches; nothing re-grades — so a genuine win is an
 * eternal suspect. This closes the loop: for each suspect whose match binding we can PROVE clean — the match is
 * finished with a known score, not a feed-drop freeze, and its bound ESPN event date sits within ±LEG_GAP of
 * kickoff (the same proof backfillEspnEventDates uses to clear the flag) — the stored score IS the right leg's,
 * so recompute the honest outcome and re-grade the bet (status/result/payout/pnl + a «пересчёт» log), then
 * clear the flag. Suspects we can't prove clean (no event date, unfinished/state_suspect, or an unresolvable
 * label) are left for the PM-resolution settler (P2) and counted `deferred`. Idempotent; recomputes metrics for
 * every strategy whose grade actually moved.
 */
export function reSettleSuspectBets(db: Database, deps: EngineDeps = {}): { regraded: number; confirmed: number; deferred: number } {
  const now = nowFn(deps)();
  const gap = Math.max(1, Number(deps.env?.FOOTBALL_LEG_GAP_HOURS ?? process.env.FOOTBALL_LEG_GAP_HOURS ?? 30)) * 3_600_000;
  const rows = db.prepare(`SELECT id FROM bets WHERE settle_suspect=1 AND status LIKE 'settled%'`).all() as { id: string }[];
  let regraded = 0, confirmed = 0, deferred = 0;
  const affected = new Set<string>();
  for (const { id } of rows) {
    const bet = R.getBet(db, id);
    if (!bet) { deferred++; continue; }
    const m = R.getMatch(db, bet.match_id);
    // Only re-grade against a trustworthy score: finished, known score, not a feed-drop freeze (F2).
    if (!m || m.state !== "finished" || m.score_home == null || m.score_away == null || isStateSuspect(db, m.id)) { deferred++; continue; }
    // PROVE the binding is the right leg: the bound ESPN event date must sit within ±LEG_GAP of kickoff.
    const live = R.getMatchLive(db, m.id);
    const koMs = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
    const evMs = live?.espn_event_date ? Date.parse(live.espn_event_date) : NaN;
    if (!(Number.isFinite(koMs) && Number.isFinite(evMs) && Math.abs(evMs - koMs) <= gap)) { deferred++; continue; } // → PM-resolution (P2)
    const won = resolveOutcome(bet, m, {});
    if (won == null) { deferred++; continue; } // unresolvable label with a known score → PM-resolution / void (P2)
    const nextStatus = won ? "settled_won" : "settled_lost";
    if (bet.status === nextStatus) { db.prepare(`UPDATE bets SET settle_suspect=0 WHERE id=?`).run(id); confirmed++; continue; } // already honest
    const patch = settleBet({ entry_price: bet.entry_price, stake: bet.stake }, won, bet.closing_price ?? null);
    db.prepare(`UPDATE bets SET status=?, result=?, payout=?, settled_by='match_score', settled_at=?, settle_suspect=0 WHERE id=?`)
      .run(patch.status, patch.result, patch.payout, now, id);
    R.insertTradeLog(db, {
      id: R.uid(), match_id: m.id, strategy_id: bet.strategy_id, minute: "пересчёт", type: "settle",
      text: `${bet.market_label}: ПЕРЕСЧЁТ по исправленной привязке (two-leg ${m.score_home}:${m.score_away}) — ${won ? "выигрыш" : "проигрыш"} → ${fmt(patch.payout)} (P&L ${fmt(patch.pnl)}; был ${bet.status})`,
      created_at: now,
    });
    regraded++; affected.add(bet.strategy_id);
  }
  for (const sid of affected) recomputeMetrics(db, sid, deps);
  return { regraded, confirmed, deferred };
}

function resolveOutcome(bet: Bet, match: Match, overrides: Record<string, boolean>): boolean | null {
  if (bet.market_label in overrides) return overrides[bet.market_label];
  if (match.score_home == null || match.score_away == null) return null;
  return resolveFootballMarket(bet.market_label, match.score_home, match.score_away, { home: match.home, away: match.away }, matchPhase(match));
}

// ------------------------------------------------------------
// F2: terminal-state validity. A football finish is VALID only when the clock reached full time
// (≥ FOOTBALL_FINISH_MIN_CLOCK, default 80') OR the provider flagged an early terminal
// (abandoned/awarded/forfeit/walkover/void). A finish at 46' with a live score (Toluca: the feed died at
// half-time and the state machine accepted it) is STATE_SUSPECT — settlement is FROZEN so positions are
// never resolved on a match that isn't really over. Marked in app_meta; the settle sweeps skip it; a later
// VALID finish clears the mark and the sweep settles it then.
const FINISH_ABANDON_AWARD = /abandon|awarded|forfeit|walk\s?over|\bw\.?o\b|cancel|void|no result|retired/i;
function clockMinuteOf(status: SportsMatchStatus): number {
  const c = String(status.clock ?? "").match(/(\d{1,3})/);
  return Math.max(status.minute ?? 0, c ? Number(c[1]) : 0);
}
export function finishSuspectReason(
  status: SportsMatchStatus, env: Record<string, string | undefined> = process.env,
  kickoffAt?: string | null, nowIso?: string,
): string | null {
  // F2, ветка «химера». Правило проверяло ТОЛЬКО часы («финиш раньше 80-й»), и класс «завершён раньше
  // собственного кикоффа» не ловило вообще — прод 02.08 держал две такие строки (Sarpsborg–Viking и
  // NC Courage–Washington Spirit, обе с кикоффом 08.08) БЕЗ флага state_suspect. Это не «правило не
  // подключено к пути», а «у правила не было этой ветки»: логическая невозможность мимо порога минут.
  // Проверяется ПЕРВОЙ — пока запись утверждает невозможное, судить её часы бессмысленно.
  if (kickoffAt && nowIso) {
    const ko = Date.parse(kickoffAt), now = Date.parse(nowIso);
    if (Number.isFinite(ko) && Number.isFinite(now) && ko - now > 2 * 3_600_000) {
      return `завершён РАНЬШЕ собственного кикоффа (${kickoffAt}) — химера чужой привязки, сеттл заморожен`;
    }
  }
  if (FINISH_ABANDON_AWARD.test(status.detail ?? "")) return null;            // a legitimate early terminal
  const floor = Math.max(1, Number(env.FOOTBALL_FINISH_MIN_CLOCK ?? 80));
  const min = clockMinuteOf(status);
  return min >= floor ? null : `финиш на ${min || "?"}' (< ${floor}', без флага abandoned/awarded) — фид оборвался`;
}
const stateSuspectKey = (mid: string) => `state_suspect:${mid}`;
export function isStateSuspect(db: Database, matchId: string): boolean { return !!(R.metaGet(db, stateSuspectKey(matchId)) || ""); }

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

  // Never let a glitchy/stale provider poll REGRESS state (live→upcoming,
  // finished→live) — that would drop a live match out of the loop or, worse,
  // flip a finished match back to live and skip its re-settlement. And never
  // wipe a KNOWN score back to null. Mirrors advanceClocks' monotonic guard.
  const nextState = STATE_RANK[status.state] >= STATE_RANK[from] ? status.state : from;
  const scoreHome = status.scoreHome ?? match.score_home;
  const scoreAway = status.scoreAway ?? match.score_away;
  const patch: Partial<Match> = {
    state: nextState, minute: status.minute, clock: status.clock ?? null,
    score_home: scoreHome, score_away: scoreAway,
  };
  if (nextState === "finished") {
    patch.final_score = `${scoreHome ?? 0}:${scoreAway ?? 0}`;
    // Stamp the FINISH time (Warsaw) once, on the first transition into finished, so
    // the card can show «завершён 18:07» / «20:00–22:01 · длительность 2 ч 01 мин»
    // instead of a bare «финал». Warsaw everywhere (kickoff too); duration off the ISO
    // kickoff. Best-effort — a missing/again-finished match just keeps what it had.
    if (from !== "finished" && !match.end_time) Object.assign(patch, finishStamp(match.kickoff_at, nowFn(deps)()));
  }
  R.updateMatch(db, match.id, patch);
  const updated = { ...match, ...patch } as Match;

  // F2: gate the finish. A premature/unflagged finish FREEZES settlement (state_suspect); a valid one clears
  // any prior mark so the sweep can settle it.
  let finishFrozen = false;
  if (nextState === "finished") {
    const now = nowFn(deps)();
    const suspect = finishSuspectReason(status, deps.env ?? process.env, match.kickoff_at, now);
    if (suspect) {
      finishFrozen = true;
      if (!isStateSuspect(db, match.id)) {
        R.metaSet(db, stateSuspectKey(match.id), suspect, now);
        console.warn(`[state_suspect] ${match.home}–${match.away}: ${suspect} — сеттл ЗАМОРОЖЕН`);
        try { R.insertCronLog(db, { id: R.uid(), at: now, kind: "state_suspect", ok: 0, summary: `[state_suspect] «${match.home}–${match.away}» ${suspect} — сеттл заморожен`, created_at: now }); } catch { /* journal best-effort */ }
      }
    } else if (isStateSuspect(db, match.id)) {
      R.metaSet(db, stateSuspectKey(match.id), "", now); // a valid finish arrived → un-freeze; the sweep settles
    }
  }

  const reassessments: ReassessResult[] = [];
  let goals = 0;

  // goal trigger (score increased while live). prevTotal already coalesces a
  // null prior score to 0, so an upcoming→live first goal is caught too; fresh
  // imports don't double-count because upsertImportedMatch has already set the
  // score before this runs (prevTotal == newTotal there).
  if ((status.state === "live" || status.state === "finished") && newTotal > prevTotal) {
    goals = newTotal - prevTotal;
    for (const sid of strategiesWithOpenBets(db, match.id)) {
      reassessments.push(await triggerReassessment(db, { match: updated, strategyId: sid, trigger: "goal", minute: status.minute }, deps));
    }
  }

  let settlement;
  if (nextState === "finished" && from !== "finished" && !finishFrozen) {
    settlement = settleMatch(db, updated, deps, settlementOverrides);
  }

  return { matchId: match.id, from, to: status.state, goals, reassessments, settlement };
}

// ------------------------------------------------------------
// Auto-import & categorization: pull a competition's matches from the
// sports provider and file them under that competition (ТЗ иерархия §1).
// ------------------------------------------------------------

/** Find an existing match for the same fixture in a competition (order-insensitive
 *  team match), so different sources (Polymarket "pm:" ref vs ESPN numeric id)
 *  don't create duplicate rows for one game. */
function findTwinMatch(db: Database, competitionId: string, home: string, away: string): Match | undefined {
  const twins = R.listMatches(db, competitionId).filter((dm) => sameTeams(dm.home, dm.away, home, away));
  if (twins.length <= 1) return twins[0];
  // Prefer the twin that already carries Polymarket markets (the tradeable row),
  // so provider data attaches to it rather than a bare duplicate — otherwise the
  // score lands on a market-less clone and the real match shows "нет котировок".
  return twins.find((dm) => R.latestMarkets(db, dm.id).length) ?? twins[0];
}

/** Create the match under a competition if it's new (keyed by external_ref, then
 *  by team names). If a twin exists from another source, merge the ESPN identity
 *  into it (so status sync + settlement work) rather than duplicating the fixture. */
export function upsertImportedMatch(
  db: Database, competitionId: string, status: SportsMatchStatus,
): { match: Match; created: boolean } {
  const existing = R.matchByExternalRef(db, status.externalRef);
  if (existing) return { match: existing, created: false };
  const twin = findTwinMatch(db, competitionId, status.home, status.away);
  if (twin) {
    // Adopt the ESPN ref so syncMatchStatus can drive/settle this fixture. AND
    // align home/away to ESPN's orientation: the twin (from a Polymarket title)
    // may be reversed, and syncMatchStatus writes scoreHome/scoreAway UNFLIPPED,
    // so a reversed twin would settle bets against mirrored scores (wrong
    // winner). Flip stored scores too if the twin already had any.
    const flipped = nameMatch(twin.home, status.away); // twin.home is ESPN's away side
    const patch: Partial<Match> = {};
    if (twin.external_ref !== status.externalRef) patch.external_ref = status.externalRef;
    if (flipped) {
      patch.home = status.home; patch.away = status.away;
      if (twin.score_home != null || twin.score_away != null) { patch.score_home = twin.score_away; patch.score_away = twin.score_home; }
    }
    if (Object.keys(patch).length) R.updateMatch(db, twin.id, patch);
    return { match: { ...twin, ...patch }, created: false };
  }
  const match: Match = {
    id: R.uid(), competition_id: competitionId, home: status.home, away: status.away,
    // kickoff_at is an ISO timestamp OR null — never a raw provider label. ESPN's
    // status.detail for an upcoming game is a human string ("Sat, July 11th at 12:00
    // PM EDT"); storing it verbatim both DISPLAYED the wrong timezone and broke every
    // ISO-based gate (hoursUntil/justKickedOff/advanceClocks read it as "no kickoff").
    state: status.state, lineup_out: status.state !== "upcoming", kickoff_at: isIso(status.detail) ? status.detail : null,
    minute: status.minute, score_home: status.scoreHome, score_away: status.scoreAway,
    final_score: status.state === "finished" ? `${status.scoreHome ?? 0}:${status.scoreAway ?? 0}` : null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: status.externalRef,
  };
  R.insertMatch(db, match);
  return { match, created: true };
}

/**
 * Remove duplicate fixtures within a competition: the SAME match imported twice
 * — a Polymarket row (with markets/bets) plus a provider row with live data but
 * no markets — created while name-matching briefly failed (e.g. "Djurgardens" vs
 * "Djurgården"). For each set of same-teams twins, keep the richest (markets, then
 * bets) and delete only the losers that carry NEITHER markets NOR bets, so nothing
 * tradeable or with history is ever dropped. Provider data re-lands on the survivor
 * on the next enrich. Returns how many rows were removed.
 */
export function dedupeMatches(db: Database): number {
  const doomed: string[] = [];
  for (const c of R.listCompetitions(db)) {
    const matches = R.listMatches(db, c.id).filter((m) => m.state !== "finished");
    const gone = new Set<string>();
    const weight = (id: string) => R.latestMarkets(db, id).length * 2 + (R.betsForMatch(db, id).length ? 1 : 0);
    for (let i = 0; i < matches.length; i++) {
      const a = matches[i];
      if (gone.has(a.id)) continue;
      for (let j = i + 1; j < matches.length; j++) {
        const b = matches[j];
        if (gone.has(b.id) || !sameTeams(a.home, a.away, b.home, b.away)) continue;
        const drop = weight(a.id) >= weight(b.id) ? b : a;
        if (weight(drop.id) > 0) continue; // never drop a row that holds markets or bets
        doomed.push(drop.id); gone.add(drop.id);
        if (drop.id === a.id) break; // a itself was dropped — stop pairing from it
      }
    }
  }
  return R.deleteMatchesById(db, doomed);
}

/** Best-effort: attach Polymarket markets to a match that has none. */
export async function linkMatchOdds(
  db: Database, match: Match, sport: string, deps: EngineDeps = {},
): Promise<number> {
  if (R.latestMarkets(db, match.id).length) return 0;
  const poly = deps.polymarket ?? loadPolymarketConfig(deps.env);
  if (!poly.enabled) return 0;
  const events = await findMatchEvents(poly, { sport, home: match.home, away: match.away }, { fetchImpl: deps.fetchImpl });
  if (!events.length) return 0;
  const now = nowFn(deps)();
  // Aggregate the match's settleable markets across its event variants, drop
  // prop/corner/card/halftime noise, cap to the most liquid.
  const snaps = matchMarketSnapshots(events, now, poly.maxMarketsPerMatch);
  for (const s of snaps) {
    R.insertMarket(db, {
      id: R.uid(), match_id: match.id, label: s.label, price: s.price, ai_prob: null,
      liquidity: s.liquidity, external_ref: s.external_ref, token_second: s.tokenSecond ?? null, snapshot_at: now, is_closing: false,
    });
  }
  return snaps.length;
}

// ------------------------------------------------------------
// Discover matches directly FROM Polymarket (not only ESPN-linked leagues) —
// imports the many matches it lists into a per-sport catch-all competition.
// ------------------------------------------------------------

const pmCompLabel = (sport: string): string => `Polymarket · ${SPORT_LABELS[sport] ?? sport} · прочее`;

// Localized names + ESPN league (for lineup/event enrichment) for known series.
const SERIES_RU: Record<string, string> = {
  "soccer-fifwc": "ЧМ-2026",
  "soccer-ucl": "Лига чемпионов",
  "soccer-uel": "Лига Европы",
  "soccer-epl": "АПЛ",
  "soccer-laliga": "Ла Лига",
  "soccer-seriea": "Серия A",
  "soccer-bundesliga": "Бундеслига",
  "soccer-ligue1": "Лига 1",
};
const SERIES_ESPN_LEAGUE: Record<string, string> = {
  "soccer-fifwc": "fifa.world",
  "soccer-ucl": "uefa.champions",
  "soccer-uel": "uefa.europa",
  "soccer-epl": "eng.1",
  "soccer-laliga": "esp.1",
  "soccer-seriea": "ita.1",
  "soccer-bundesliga": "ger.1",
  "soccer-ligue1": "fra.1",
  // Exact Polymarket slugs whose NAME is too generic to infer safely:
  "liga-1": "per.1",     // Polymarket "Liga 1" = Peruvian Liga 1 (Cusco, Sport Boys, Alianza…)
  "romania-1": "rou.1",  // "Romania 1" = Romanian SuperLiga
};
// Fallback when the exact Polymarket series slug isn't in the table above:
// infer the ESPN league code from the series NAME/slug, so a newly-listed
// league (Nordic, etc.) still gets ESPN live scores + events instead of going
// dark in-match (enrichFromEspn only touches comps that have an external_league,
// and it still gates every enrich on a team-name match, so a loose guess here is
// safe — worst case it finds nothing). Extend as more leagues are traded.
const LEAGUE_NAME_ESPN: [RegExp, string][] = [
  // UEFA club competitions — the marquee midweek cups. ORDER MATTERS: the more
  // specific name must win, so Women's → Conference → Champions/Europa. Without
  // these, "UEFA Champions League" fell through to null (unfunded) and "UEFA
  // Europa League" wrongly matched the old /a-?league/ rule → aus.1.
  [/women'?s\s*champions\s*league|uwcl/i, "uefa.wchampions"],
  [/(europa\s*)?conference\s*league|uecl/i, "uefa.europa.conf"],
  [/champions\s*league|\bucl\b/i, "uefa.champions"],
  [/europa\s*league|\buel\b/i, "uefa.europa"],
  // CONMEBOL club cups — discovered from Polymarket but had no ESPN league, so a
  // live match went dark (no scores/events → no in-play management, no bets).
  [/copa\s*sudamericana|sudamericana/i, "conmebol.sudamericana"],
  [/copa\s*libertadores|libertadores/i, "conmebol.libertadores"],
  [/allsvenskan/i, "swe.1"], [/superettan/i, "swe.2"],
  [/eliteserien/i, "nor.1"],
  [/eredivisie/i, "ned.1"], [/eerste divisie/i, "ned.2"],
  [/(primeira liga|liga portugal)/i, "por.1"],
  // Danish/Denmark Superliga BEFORE the Turkish Süper Lig — and the Turkish rule is
  // anchored with \b so it matches "Süper Lig" (two words) but NOT "Superliga" (Denmark's
  // one word). Without both, "Denmark Superliga" fell through to tur.1 and would have pulled
  // TURKISH live data onto Danish matches.
  [/(danish|denmark)\s*super\s*liga|superligaen/i, "den.1"],
  [/s[üu]per\s*lig\b/i, "tur.1"],
  [/(scottish premiership|scottish prem)/i, "sco.1"],
  [/(jupiler|belgian pro league|pro league)/i, "bel.1"],
  [/(swiss super|super league.*switzerland)/i, "sui.1"],
  [/(major league soccer|\bmls\b)/i, "usa.1"],
  [/\bnwsl\b|national women'?s soccer/i, "usa.nwsl"],
  // Brazil: Série B before Série A so "Serie B" doesn't fall into the A rule.
  // Match either word order ("Brazil Serie B" / "Serie B Brazil") + "Brasileirão B".
  [/((brazil|brasil).*s[ée]rie\s*b|s[ée]rie\s*b.*(brazil|brasil)|brasileir[ãa]o?\s*s[ée]rie\s*b)/i, "bra.2"],
  [/(brasileir|(brazil|brasil).*s[ée]rie\s*a|s[ée]rie\s*a.*(brazil|brasil))/i, "bra.1"],
  [/liga mx/i, "mex.1"],
  // Peru Liga 1 (ESPN per.1). The bare "Liga 1" slug is pinned in SERIES_ESPN_LEAGUE;
  // this catches a name that spells the country out.
  [/(liga 1.*per[uú]|per[uú].*liga 1|\bperu\b)/i, "per.1"],
  // Romania SuperLiga (ESPN rou.1). Category arrives as bare "Romania 1".
  [/\bromania\b|superliga.*romania|liga 1.*romania/i, "rou.1"],
  // [H4] anchor to the ENGLISH second tier only. The bare /\bchampionship\b/ over-matched "European/World/
  // Scottish/African … Championship" → bound English-2nd-tier live data onto foreign fixtures (wrong-feed on
  // real money). Scottish Championship is sco.2, not eng.2; add it explicitly if traded.
  [/(efl championship|english championship)/i, "eng.2"],
  [/saudi pro league/i, "ksa.1"],
  [/j1 league/i, "jpn.1"],
  // Chinese Super League — ESPN's chn.1 feed DOES carry it (probed: Beijing Guoan, Henan,
  // Yunnan Yukun all present with live status), so it's not "uncovered" — it was just unmapped,
  // which made reconcileFootballCategories DELETE it every tick. Mapping it here backfills the
  // league, auto-funds it via the standard grid, and lets enrichFromEspn pull live scores/events.
  [/chinese super league|china.*super league|super league.*china/i, "chn.1"],
  [/\ba-?league\b/i, "aus.1"],
  [/(greek super league|super league greece)/i, "gre.1"],
  [/(austrian bundesliga|bundesliga.*austria)/i, "aut.1"],
];
const inferEspnLeague = (name: string | null): string | null => {
  if (!name) return null;
  for (const [re, code] of LEAGUE_NAME_ESPN) if (re.test(name)) return code;
  return null;
};
// A UEFA club competition splits across TWO ESPN scoreboards by round: the main draw
// (e.g. uefa.champions) and the qualifying rounds (uefa.champions_qual). Our comp maps to
// the main slug, so the summer qualifiers — obscure clubs but real Polymarket liquidity —
// went dark (empty main board → no lineups/live → football analysis gated off → 0 trades;
// the SK Iberia 1999 — FC Flora case). Poll BOTH slugs: the team-name match then finds the
// fixture wherever ESPN files it, and matchDetail/match_live key off the board's own slug, so
// lineups + events resolve under the right league. A non-existent slug 400s → scoreboard
// returns [] (harmless). Not a coverage gap; no new provider needed.
const ESPN_QUAL_SIBLING: Record<string, string> = {
  "uefa.champions": "uefa.champions_qual",
  "uefa.europa": "uefa.europa_qual",
  "uefa.europa.conf": "uefa.europa.conf_qual",
  "uefa.wchampions": "uefa.wchampions_qual",
};
export function espnLeagueVariants(league: string): string[] {
  const q = ESPN_QUAL_SIBLING[league];
  return q ? [league, q] : [league];
}
const slugify = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Ensure the CATEGORY competition a discovered match belongs to (its Polymarket
 * `series`, e.g. "FIFA World Cup" → "ЧМ-2026"). Matches with no series fall back
 * to the per-sport "…· прочее" bucket. Never clobbers an existing comp's budget;
 * backfills the ESPN league so its matches get lineups/events.
 */
/** The ESPN league a discovered match's series maps to, or null if ESPN doesn't
 *  cover it (→ no live scores/events, so we don't import it). */
/** The stable series slug for a discovered match (Polymarket seriesSlug, else a
 *  slug of the series name). "" when it has no series. */
export function seriesSlugOf(series: string | null, seriesSlug: string | null): string {
  return (seriesSlug ?? (series ? slugify(series) : "")).toLowerCase();
}

/** Per-sport series allow-list (slugs) — null = NO restriction. Tennis is
 *  unrestricted by default: show any fixture that's on Polymarket, clears the
 *  liquidity floor, and has live data — across as many tournament categories as
 *  that yields (user: «если есть на полимаркете, ликвидность и лайв — показываем,
 *  хоть в нескольких категориях»). The liquidity gate + coverage machinery (entry
 *  rule + uncovered-finish) decide what actually trades, so a series whitelist is
 *  redundant. Set TENNIS_SERIES only to deliberately narrow to specific tours. */
export function seriesAllowFor(sport: string, env: Record<string, string | undefined> = process.env): Set<string> | null {
  if (sport !== "tennis") return null;
  const raw = env.TENNIS_SERIES;
  if (!raw) return null; // default: liquidity + live-data are the gates, not the series
  const slugs = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return slugs.length ? new Set(slugs) : null;
}

export function espnLeagueForSeries(series: string | null, seriesSlug: string | null): string | null {
  const slug = seriesSlug ?? (series ? slugify(series) : null);
  if (!slug && !series) return null;
  return (slug ? SERIES_ESPN_LEAGUE[slug] : null) ?? inferEspnLeague(series) ?? inferEspnLeague(slug) ?? null;
}

function ensureCategoryComp(db: Database, sport: string, series: string | null, seriesSlug: string | null, now: string): string {
  // The persistent prod DB was seeded before these sports existed, so guarantee
  // the sports(id) row exists (FK target for competitions.sport_id) at import
  // time — idempotent, safe on every run.
  R.upsertSport(db, sport, SPORT_LABELS[sport] ?? sport);
  if (!series && !seriesSlug) {
    const id = `pm-${sport}`;
    if (!R.listCompetitions(db).some((c) => c.id === id))
      R.upsertCompetition(db, { id, sport_id: sport, name: pmCompLabel(sport), budget: 0, external_league: null, created_at: now });
    return id;
  }
  const slug = seriesSlug ?? slugify(series!);
  const id = `pm-${slug}`;
  const league = espnLeagueForSeries(series, seriesSlug);
  const existing = R.listCompetitions(db).find((c) => c.id === id);
  if (!existing) {
    R.upsertCompetition(db, { id, sport_id: sport, name: SERIES_RU[slug] ?? series ?? slug, budget: 0, external_league: league, created_at: now });
  } else if (league && league !== existing.external_league) {
    // R2(а): correct a STALE/WRONG slug, not just fill a null. A comp created before a
    // LEAGUE_NAME_ESPN rule existed keeps the old (wrong) inference forever otherwise —
    // e.g. "Denmark Superliga" was stamped tur.1 before the den.1 rule landed, so its
    // matches queried the Turkish board and went blind on a league ESPN fully covers.
    // Only overwrite when the fresh inference is confident (non-null) and disagrees;
    // never clear a stored league to null. Self-limiting: once fixed, want === stored.
    const from = existing.external_league;
    R.setCompetitionLeague(db, id, league);
    recordLeagueMapFix(db, { comp: id, name: existing.name, from, to: league }, now);
  }
  return id;
}

/** The ESPN league an EXISTING category comp should map to, recomputed from its own
 *  name + id-slug (mirrors espnLeagueForSeries at creation, plus a de-hyphen fallback
 *  so a slug like "denmark-superliga" still resolves via the name rules). */
function reinferCompLeague(comp: Competition): string | null {
  const slug = comp.id.replace(/^pm-/, "");
  return espnLeagueForSeries(comp.name, slug) ?? inferEspnLeague(slug.replace(/[-_]+/g, " "));
}

export interface LeagueMapFix { comp: string; name: string; from: string | null; to: string }
/** Append a corrected league-map to the audit ring (bounded), so the profiles report can
 *  show which comps were repaired and from what. */
function recordLeagueMapFix(db: Database, fix: LeagueMapFix, now: string): void {
  let ring: (LeagueMapFix & { at: string })[] = [];
  try { ring = JSON.parse(R.metaGet(db, "league_map_fixes_recent") ?? "[]"); } catch { ring = []; }
  ring.unshift({ ...fix, at: now });
  R.metaSet(db, "league_map_fixes_recent", JSON.stringify(ring.slice(0, 50)), now);
}

/**
 * R2(а): sweep every FOOTBALL category comp and correct any external_league that
 * disagrees with the current inference — catches comps stamped before a mapping rule
 * existed and that aren't re-discovered often enough for ensureCategoryComp to self-heal.
 * Never clears a league to null (inference-unknown ⇒ leave the stored value alone).
 * `apply:false` = dry-run (audit only). Returns the discrepancies found.
 */
export function repairCategoryLeagues(db: Database, now: string, opts: { apply?: boolean } = {}): LeagueMapFix[] {
  const fixes: LeagueMapFix[] = [];
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "football") continue;
    const want = reinferCompLeague(c);
    if (!want || want === c.external_league) continue;
    fixes.push({ comp: c.id, name: c.name, from: c.external_league ?? null, to: want });
    if (opts.apply !== false) { R.setCompetitionLeague(db, c.id, want); recordLeagueMapFix(db, { comp: c.id, name: c.name, from: c.external_league ?? null, to: want }, now); }
  }
  return fixes;
}

export interface DiscoverItem { sport: string; match: string; created: boolean; markets: number }

/**
 * Import the most-liquid matches Polymarket lists for a sport into its catch-all
 * competition, with their settleable odds. Idempotent: existing matches are left
 * alone (markets attached only if they have none). State/lineup come from the
 * event start date — live scores still need the ESPN sync.
 */
export async function importPolymarketMatches(
  db: Database, sport: string, deps: EngineDeps = {}, opts: { limit?: number } = {},
): Promise<DiscoverItem[]> {
  const poly = deps.polymarket ?? loadPolymarketConfig(deps.env);
  if (!poly.enabled) return [];
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  // Widen coverage without more Polymarket calls: a longer window + higher match
  // cap pull MORE leagues out of the SAME fetched event set (no extra requests —
  // user: «отбиваемся от полимаркета»). Both env-tunable.
  const env = deps.env ?? process.env;
  // A typo'd env (e.g. "400 matches") must NOT become NaN — that would slice(0,
  // NaN) to [] and silently import ZERO matches. Fall back to the default.
  const numEnv = (v: string | undefined, def: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; };
  const windowDays = numEnv(env.DISCOVER_WINDOW_DAYS, 21);
  const limit = opts.limit != null && Number.isFinite(opts.limit) ? opts.limit : numEnv(env.DISCOVER_MATCH_LIMIT, 400);
  // Per-MARKET dust gate (provenance by depth): Polymarket lists a fixture across
  // several events, and a stale/novelty contract shows up with dust liquidity
  // (~$90) alongside the real $5k+ markets — untradeable, degenerate-priced, and it
  // pollutes the quote panel + the ai_prob matcher. Drop a market only when it's
  // BOTH under an absolute dust floor AND dwarfed by a real market on the same
  // fixture (≥ ratio deeper), so a uniformly-thin low-profile fixture keeps all of
  // its markets. Both env-tunable; 0 disables.
  const dustLiq = numEnv(env.MARKET_MIN_LIQUIDITY, 200); // relative dust ceiling
  const dustRatio = numEnv(env.MARKET_DUST_RATIO, 5);
  // ABSOLUTE hard floor: a market below this is never tradeable, full stop — drop it
  // regardless of the rest of the fixture. This closes the hole in the relative rule:
  // on a niche league where EVERY market is thin, no market "dwarfs" another, so the
  // relative check never fires and dust would pass. The absolute floor catches it.
  const hardFloor = numEnv(env.MARKET_HARD_FLOOR, 50);
  const discovered = await discoverSportMatches(poly, sport, now, { fetchImpl: deps.fetchImpl }, { limit, windowDays, nowMs });
  const allow = seriesAllowFor(sport, deps.env); // e.g. tennis → only ATP tour
  const out: DiscoverItem[] = [];
  for (const d of discovered) {
    // Import by LIQUIDITY, not by ESPN coverage — user: «меня не интересуют
    // матчи с низкой ликвидностью… а где ликвидность есть — надо брать». A liquid
    // fixture is worth trading even without a live scoreboard (its «События
    // матча» then falls back to market-price snapshots); a thin one isn't, ESPN
    // feed or not. 0 disables the floor.
    if (poly.minLiquidity > 0 && d.liquidity < poly.minLiquidity) continue;
    // Tennis: DOUBLES are out of scope entirely (spec: «Пары — не подключать вообще»),
    // env-independent — never import them regardless of TENNIS_SERIES.
    if (sport === "tennis" && /doubles/i.test(`${d.series ?? ""} ${d.seriesSlug ?? ""}`)) continue;
    // Per-sport series allow-list (tennis: TENNIS_SERIES; null = unrestricted).
    if (allow && !allow.has(seriesSlugOf(d.series, d.seriesSlug))) continue;
    // Skip matches with NO tournament series — on Polymarket these are novelty /
    // prop "X vs Y" markets (player H2H, "to play?"), not real fixtures. They
    // fed the useless «… · прочее» catch-all. Real matches always carry a series.
    if (!d.series && !d.seriesSlug) continue;
    // FOOTBALL: import ONLY leagues ESPN maps (live coverage). An unmapped league
    // (e.g. Chinese Super League) has no live provider data — StatPal returns empty
    // feeds, Sportmonks is WC-only — so it can't be managed in-play and only wastes
    // analysis on phantom edges vs near-resolved odds. Supersedes the earlier
    // import-by-liquidity rule FOR FOOTBALL; other sports keep their own coverage.
    if (sport === "football" && espnLeagueForSeries(d.series, d.seriesSlug) == null) continue;
    // Route into the tournament category this match belongs to (Polymarket series).
    const compId = ensureCategoryComp(db, sport, d.series, d.seriesSlug, now);
    // Order-INSENSITIVE ref (teams sorted): Polymarket may list a fixture as
    // "A vs B" one run and "B vs A" the next, which with an orientation-sensitive
    // key produced a duplicate row. Sorting the two sides collapses both to one.
    const ref = `pm:${sport}:${[d.home, d.away].map((s) => s.toLowerCase().replace(/\s+/g, "")).sort().join("-")}`;
    // Dedup, most-reliable first: (1) the order-insensitive pm: ref, (2) SHARED
    // CLOB tokens — the same fixture keeps its market tokens even if Polymarket
    // rewords the title, so this catches spelling drift the ref/name checks miss,
    // (3) team-name twin (the fixture may already exist under an ESPN id from
    // syncCompetitions). Never duplicate the game.
    const tokenRefs = d.markets.map((s) => s.external_ref).filter((r): r is string => !!r);
    let match = R.matchByExternalRef(db, ref)
      ?? R.matchByMarketTokens(db, tokenRefs)
      ?? findTwinMatch(db, compId, d.home, d.away);
    let created = false;
    if (!match) {
      const startMs = d.kickoff ? Date.parse(d.kickoff) : NaN;
      // kickoff stored as ISO for scheduling; the view renders it in Warsaw time.
      match = {
        id: R.uid(), competition_id: compId, home: d.home, away: d.away,
        state: "upcoming", lineup_out: !isNaN(startMs) && startMs <= nowMs + 3600_000, kickoff_at: d.kickoff ?? null,
        minute: null, score_home: null, score_away: null, final_score: null,
        kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: ref,
      };
      R.insertMatch(db, match);
      created = true;
    } else if (d.kickoff) {
      // Existing match: (a) BACKFILL kickoff_at if it was created with none
      // (Polymarket hadn't exposed startTime yet) — else it sits in "upcoming"
      // forever, never clock-driving; (b) UPDATE it when Polymarket moves the
      // start (postponed/rescheduled), so advanceClocks re-derives from the new
      // time instead of staying clock-"live" at the old slot. Real ISO + >5min.
      const newMs = Date.parse(d.kickoff);
      const oldMs = match.kickoff_at ? Date.parse(match.kickoff_at) : NaN;
      if (!isNaN(newMs) && (isNaN(oldMs) || Math.abs(newMs - oldMs) > 5 * 60_000)) {
        R.updateMatch(db, match.id, { kickoff_at: d.kickoff });
        match.kickoff_at = d.kickoff;
      }
    }
    // Attach any market side we don't already have (by CLOB token) — not
    // all-or-nothing: an existing match must still pick up NEW sides Polymarket
    // now exposes (e.g. the "No" leg of a yes/no market added after first import).
    const existing = R.latestMarkets(db, match.id);
    const haveTokens = new Set(existing.map((mk) => mk.external_ref).filter(Boolean));
    const haveLabels = new Set(existing.map((mk) => mk.label));
    // Fixture depth = the deepest market across everything we know for it (existing +
    // incoming). Dust = below the floor AND ≥ratio shallower than that reference.
    const liqOf = (v: string | number | null | undefined) => Number(v ?? 0) || 0;
    const refLiq = Math.max(0, ...existing.map((mk) => liqOf(mk.liquidity)), ...d.markets.map((s) => liqOf(s.liquidity)));
    // Dust = below the ABSOLUTE hard floor (always), OR below the relative ceiling AND
    // dwarfed by a real market on the same fixture (≥ratio deeper). Two thresholds:
    // the absolute closes the "every market is thin" hole the relative one can't.
    const isDust = (liq: number) => liq > 0 && (
      liq < hardFloor ||
      (dustLiq > 0 && liq < dustLiq && refLiq >= liq * dustRatio)
    );
    // Drop existing dust listings (imported before this gate, or a market that drained
    // to dust) so the pollution self-heals on re-discovery.
    for (const mk of existing) if (isDust(liqOf(mk.liquidity))) R.deleteMarketLabel(db, match.id, mk.label);
    for (const s of d.markets) {
      // dedup by token (tokenless → by label) so re-discovery can't duplicate.
      if (s.external_ref ? haveTokens.has(s.external_ref) : haveLabels.has(s.label)) continue;
      if (isDust(liqOf(s.liquidity))) continue; // orphan/degenerate dust listing — don't surface it
      R.insertMarket(db, { id: R.uid(), match_id: match.id, label: s.label, price: s.price, ai_prob: null, liquidity: s.liquidity, external_ref: s.external_ref, token_second: s.tokenSecond ?? null, snapshot_at: now, is_closing: false });
    }
    out.push({ sport, match: `${d.home}–${d.away}`, created, markets: d.markets.length });
  }
  return out;
}

// ------------------------------------------------------------
// Enrich matches with REAL lineups + events from ESPN (so reassessment has
// teeth). Cross-refs DB matches (any competition, incl. Polymarket-discovered)
// to ESPN scoreboard events by team names, updates live state, stores lineups,
// and records new in-match events (goals/cards/subs) as reassessment triggers.
// ------------------------------------------------------------

// Generic club suffixes carry no identity — "Manchester United" and "Newcastle
// United" must NOT match on "united". Matching needs a distinctive token.
const TEAM_STOPWORDS = new Set(["fc", "afc", "sc", "cf", "ac", "as", "cd", "sv", "fk", "if", "bk", "club", "united", "city", "town", "county", "calcio", "sporting", "real", "athletic", "atletico"]);
// Fold the special letters NFD does NOT decompose to ASCII — ø/æ/ß/… are single
// code points, not base+combining, so `normalize("NFD")` leaves them intact. Without
// this, "Tromsø" (Polymarket) and "Tromso" (ESPN) tokenized to different tokens and
// nameMatch failed → the same fixture imported twice (an ESPN-only twin with no
// quotes and a raw non-ISO kickoff string). Fold BEFORE NFD so the two paths agree.
// foldLetters now lives in the leaf module nameFold.ts (shared with the persisted alias store so the two
// canonicalize identically). Imported above.
// S11: the persisted alias overlay (getTeamAliases) is merged OVER TEAM_EXONYMS in teamTokens. It's read from
// a module-level cache refreshed once at the TOP of runAutoCycle (refreshTeamAliasOverlay) — before
// discover/dedupe/enrich, so EVERY name-match path in a cycle uses one fresh overlay (M13). enrichFromEspn
// also refreshes defensively for standalone calls. Empty overlay (default) ⇒ byte-for-byte the old behavior.
let TEAM_ALIAS_OVERLAY: Record<string, string> = {};
/** Reload the DB-backed alias overlay into the module cache. Called at the top of each enrich/reconcile pass. */
export function refreshTeamAliasOverlay(db: Database): void { TEAM_ALIAS_OVERLAY = getTeamAliases(db); }
// F1: city EXONYMS — Polymarket carries the native spelling, ESPN/StatPal the English one, and diacritic
// folding alone can't bridge a translated city ("Wien"→"Vienna", "Barysaŭ"→"Borisov"). Without this the
// fixture never links → no match_live → phantom kickoff clock, zero entries, forced ?:? finish (Santa
// Coloma–Rapid Wien, BATE Barysaŭ). Applied to BOTH names symmetrically and only maps a spelling to its
// canonical, so it cannot create a false match: the distinctive-token subset gate in nameMatch still holds
// (two different Vienna clubs keep their distinct rapid/austria tokens). Keys are post-fold/NFD ASCII tokens.
const TEAM_EXONYMS: Record<string, string> = {
  wien: "vienna", wenen: "vienna",
  barysau: "borisov", barysaw: "borisov",
  munchen: "munich", muenchen: "munich",
  koln: "cologne", koeln: "cologne",
  praha: "prague", moskva: "moscow", kyiv: "kiev",
  beograd: "belgrade", warszawa: "warsaw", lisboa: "lisbon",
  athina: "athens", bucuresti: "bucharest", kobenhavn: "copenhagen",
  milano: "milan", torino: "turin", genova: "genoa", roma: "rome",
  sevilla: "seville", venezia: "venice", firenze: "florence",
  // P3 batch-7: club-name variants surfaced by the &probe audit against ESPN's actual spelling. Each maps a
  // Polymarket/ESPN spelling to the OTHER's so the distinctive-token subset gate bridges them (no false match:
  // the remaining tokens stay distinct). larnakas↔larnaca, polissya↔polissia, tobyl↔tobol, varteks↔varazdin.
  larnakas: "larnaca", polissya: "polissia", tobyl: "tobol", varteks: "varazdin",
  // R2(б) batch-8: Swedish å romanized as "aa" on Polymarket ("Vasteraas") but folded from å
  // to a single "a" on ESPN ("Västerås" → "vasteras"), so the token never matched and a fully
  // ESPN-covered swe.1 fixture (Örgryte at Västerås) went blind. Map the doubled-vowel spelling.
  vasteraas: "vasteras",
};
function teamTokens(name: string): Set<string> {
  // Keep tokens ≥3 chars, OR short ones that carry a digit — esports orgs are
  // routinely 2-char names ("T1", "G2", "C9"). Dropping those left such a match
  // with an EMPTY token set, so nameMatch always failed and the fixture could
  // never reconcile with the provider (it hung "live" forever on the timer).
  const toks = foldLetters(name.toLowerCase()).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  // [H3] MAP the aliases (F1 static city exonyms, then the S11 persisted overlay — last wins) BEFORE the
  // length filter. A 2-char club token ("KÍ"→ki, "HB"→hb) was dropped by the ≥3 filter BEFORE any alias could
  // rescue it, so a 2-char name yielded an EMPTY token set and could never bind — and an added alias was
  // silently dead. Mapping first lets `ki→klaksvik` (8 chars) survive; un-aliased short noise ("fc","sc",
  // "ki") still drops. The ≥3 floor is UNCHANGED (lowering it would let FC/AC/SC false-match).
  return new Set(toks.map((w) => TEAM_ALIAS_OVERLAY[w] ?? TEAM_EXONYMS[w] ?? w).filter((w) => w.length >= 3 || /\d/.test(w)));
}
/** Do two team names refer to the same club/nation? Requires every token of the
 *  shorter name to appear in the longer (so "West Ham" ⊂ "West Ham United" ok,
 *  but "Manchester United" vs "Newcastle United" / "Manchester City" do NOT),
 *  and at least one shared DISTINCTIVE (non-suffix) token. */
// Two tokens refer to the same word if equal, or one is the other's stem plus a
// short inflection (≤3 chars) — Scandinavian/genitive club forms differ only in a
// trailing suffix ("Djurgården"→"djurgarden" vs "Djurgårdens"→"djurgardens",
// "Hammarby"/"Hammarbys"). The length guard keeps "Inter" from swallowing
// "Internacional" and "man" from "manchester".
function tokenCompat(x: string, y: string): boolean {
  if (x === y) return true;
  const [s, g] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 5 && g.length - s.length <= 3 && g.startsWith(s);
}
export function nameMatch(a: string, b: string): boolean {
  const ta = [...teamTokens(a)], tb = [...teamTokens(b)];
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (!small.every((t) => big.some((u) => tokenCompat(t, u)))) return false; // shorter ⊆ longer (stem-aware)
  return small.some((t) => !TEAM_STOPWORDS.has(t) && big.some((u) => !TEAM_STOPWORDS.has(u) && tokenCompat(t, u))); // a real, distinctive token
}
export function sameTeams(h1: string, a1: string, h2: string, a2: string): boolean {
  return (nameMatch(h1, h2) && nameMatch(a1, a2)) || (nameMatch(h1, a2) && nameMatch(a1, h2));
}

export interface EnrichResult { enriched: number; newEvents: { matchId: string; type: string; minute: number | null; text: string }[] }

export async function enrichFromEspn(db: Database, provider: SportsProvider, deps: EngineDeps = {}): Promise<EnrichResult> {
  if (!provider.matchDetail) return { enriched: 0, newEvents: [] };
  refreshTeamAliasOverlay(db); // S11: pull persisted name aliases into the hot match path for this pass
  const now = nowFn(deps)();
  const comps0 = R.listCompetitions(db);
  const compSport = new Map(comps0.map((c) => [c.id, c.sport_id]));
  const compLeague = new Map(comps0.map((c) => [c.id, c.external_league]));
  // P0.1 fixture-identity date gate config + tally. LEG_GAP_H: how far the ESPN event date may sit from the
  // record's kickoff before it's treated as ANOTHER leg / a reschedule (not this match). ~30h clears
  // same-match timezone jitter yet catches a 2-day reschedule and a week-apart second leg.
  const LEG_GAP_MS = Math.max(1, Number(deps.env?.FOOTBALL_LEG_GAP_HOURS ?? process.env.FOOTBALL_LEG_GAP_HOURS ?? 30)) * 3_600_000;
  const legTally = { dateGap: 0, suffix: 0, orient: 0 };
  // P3-audit (batch-7): capture each bind rejection so the tally's 17 date-gaps can be INSPECTED — a gap of a
  // week is a genuine other-leg; a gap of 1–3 days is a possible RESCHEDULE the gate may be over-tightly cutting.
  const legRejects: { home: string; away: string; recordKickoff: string | null; espnDate: string | null; gapHours: number | null; league: string; reason: string }[] = [];
  const recordReject = (home: string, away: string, ko: string | null, espn: string | null, league: string, reason: string) => {
    const koMs = ko ? Date.parse(ko) : NaN, evMs = espn ? Date.parse(espn) : NaN;
    const gapHours = Number.isFinite(koMs) && Number.isFinite(evMs) ? Math.round(Math.abs(evMs - koMs) / 3_600_000) : null;
    if (legRejects.length < 60) legRejects.push({ home, away, recordKickoff: ko, espnDate: espn, gapHours, league, reason });
  };
  const qualBase = (lg: string | null | undefined) => String(lg ?? "").replace(/_qual$/i, "");
  // Build the (sport, league) scoreboards to poll. Football (and any other
  // ESPN-linked competition) contributes its mapped league; the provider also
  // declares fixed leagues per sport (nba/nhl/mlb…). Deduped per sport.
  const jobs = new Map<string, Set<string>>();
  const addJob = (sport: string, league: string | null) => {
    if (!league) return;
    let set = jobs.get(sport); if (!set) jobs.set(sport, (set = new Set()));
    // Expand a UEFA main-draw slug to also poll its qualifying-round sibling (no-op for
    // every other league). Team-name matching gates each board, so an extra probe is safe.
    for (const v of espnLeagueVariants(league)) set.add(v);
  };
  for (const c of R.linkedCompetitions(db)) addJob(c.sport_id, c.external_league);
  if (!jobs.has("football")) addJob("football", "fifa.world");
  if (provider.leaguesFor) for (const sport of new Set(compSport.values())) for (const lg of provider.leaguesFor(sport)) addJob(sport, lg);
  const dbMatches = R.listCompetitions(db).flatMap((c) => R.listMatches(db, c.id)).filter((m) => m.state !== "finished");
  const out: EnrichResult = { enriched: 0, newEvents: [] };
  for (const [sport, leagues] of jobs) for (const league of leagues) {
    const board = await provider.scoreboard(sport, league);
    for (const s of board) {
      // Same-sport only — otherwise "Poland vs Netherlands" basketball could
      // match a soccer fixture of the same nations.
      // P0.1 FIXTURE-IDENTITY DATE GATE (blocking). A two-leg tie plays the SAME teams twice a week apart,
      // so team names alone bind either leg — the settle-contamination root. Among the team-matched records,
      // pick the one whose kickoff is within LEG_GAP of the ESPN event date; a bigger gap on ALL of them
      // means this event is another leg / a reschedule → do NOT bind, loud + counted (reason date_gap,
      // distinct from a league-suffix mismatch). No event date OR a record without a kickoff → can't gate,
      // fall back to the first team match (legacy behaviour, unchanged for single-leg fixtures).
      const candidates = dbMatches.filter((dm) => compSport.get(dm.competition_id) === sport && sameTeams(dm.home, dm.away, s.home, s.away));
      if (!candidates.length) continue;
      const evMs = s.date ? Date.parse(s.date) : NaN;
      const dateOk = (c: typeof candidates[number]) => { const ko = c.kickoff_at ? Date.parse(c.kickoff_at) : NaN; return Number.isFinite(evMs) && Number.isFinite(ko) && Math.abs(evMs - ko) <= LEG_GAP_MS; };
      // P1(б7) TWO-LEG BINDING: a two-leg tie replays the SAME teams a week apart, so team names bind either
      // leg — the settle-contamination root (Raków won 3:1, "Raków — Yes" booked settled_lost off the other
      // leg). For a two-leg competition a POSITIVE date-match is MANDATORY: both escape hatches are closed —
      // (1) a no-kickoff record can't be date-checked → NOT bound; (2) a missing ESPN date → NOT bound. Keyed
      // on the board league OR the candidate's own competition, so a _qual variant or a suffix-filed comp is
      // still protected. Single-leg fixtures keep the legacy fallbacks unchanged.
      const boardTwoLeg = UEFA_TWO_LEG.has(qualBase(league));
      let m: typeof candidates[number] | undefined = candidates.find(dateOk); // a positive date-match always wins
      if (!m) {
        const twoLeg = candidates.filter((c) => boardTwoLeg || UEFA_TWO_LEG.has(qualBase(compLeague.get(c.competition_id))));
        if (twoLeg.length) {
          legTally.dateGap++;
          const c0 = twoLeg[0];
          recordReject(c0.home, c0.away, c0.kickoff_at, s.date ?? null, league, "two_leg_no_datematch");
          console.warn(`[enrich] fixture_leg_mismatch two_leg_no_datematch: «${c0.home}–${c0.away}» запись ${c0.kickoff_at ?? "—"} vs ESPN ${s.date ?? "—"} (${league}) — НЕ привязано (двухматчевая пара требует совпадения даты ≤${Math.round(LEG_GAP_MS / 3_600_000)}ч)`);
          continue; // never team-name-bind a two-leg fixture without a positive date match
        }
        if (Number.isFinite(evMs)) {
          m = candidates.find((c) => !c.kickoff_at); // single-leg: a record with no kickoff can't be gated → allow
          if (!m) {
            legTally.dateGap++;
            const c0 = candidates[0];
            recordReject(c0.home, c0.away, c0.kickoff_at, s.date ?? null, league, "date_gap");
            console.warn(`[enrich] fixture_leg_mismatch date_gap: «${c0.home}–${c0.away}» запись ${c0.kickoff_at} vs ESPN ${s.date} (${league}) — НЕ привязано (чужой круг/перенос)`);
            continue; // the date says this event is not any of these records — never wire a foreign leg
          }
        } else {
          m = candidates[0]; // single-leg, no event date → can't gate; legacy team-name binding
        }
      }
      // Suffix mismatch (record league vs board league) is LEGAL — PM files quals under the main league and
      // we cross-poll _qual on purpose. Count at INFO for traceability; NEVER blocks (only the date does).
      if (qualBase(compLeague.get(m.competition_id)) === qualBase(league) && compLeague.get(m.competition_id) !== league) legTally.suffix++;
      // sameTeams is order-insensitive: the DB match's home/away orientation (from the Polymarket title) may be
      // the reverse of ESPN's. Resolve orientation from BOTH sides and require it UNAMBIGUOUS — a name set that
      // matches straight AND mirrored (or neither) could put the score on the wrong side (the secondary two-leg
      // contamination vector). Don't guess: skip + loud log rather than risk a mirrored score/lineup.
      const straight = nameMatch(m.home, s.home) && nameMatch(m.away, s.away);
      const mirrored = nameMatch(m.home, s.away) && nameMatch(m.away, s.home);
      if (straight === mirrored) {
        legTally.orient++;
        recordReject(m.home, m.away, m.kickoff_at, s.date ?? null, league, "ambiguous_orientation");
        console.warn(`[enrich] ambiguous_orientation «${m.home}–${m.away}» vs ESPN «${s.home}–${s.away}» (${league}) — НЕ привязано (ориентация счёта неоднозначна)`);
        continue;
      }
      // МАТЧ НЕ МОЖЕТ БЫТЬ ЗАВЕРШЁН РАНЬШЕ СОБСТВЕННОГО КИКОФФА. Дата-гейт выше не даёт чужому кругу
      // ПРИВЯЗАТЬСЯ, но строки, привязанные до его появления, сохраняют испорченную привязку, и каждый
      // следующий опрос радостно переносит «finished / 90' / 2:3» чужого события на фикстуру, которая ещё
      // не начиналась. Так 28.07 торговля встала на восемнадцать часов: пять вторых кругов квалификации
      // лежали finished со счетами первых кругов от 22.07, а матч, который система считает сыгранным, не
      // входит в живую фазу, не доходит до стратега и не торгуется НИКОГДА.
      //
      // Это не порог, который можно подобрать, — это логическая невозможность, поэтому отказ безусловный.
      // Окно в одну длину матча существует только чтобы не спорить о слегка неточном времени кикоффа;
      // событие, завершившееся за часы ДО начала своей фикстуры, — это чужой матч.
      //
      // ВОССТАНОВЛЕНО 02.08 после того, как мой откат прода на 26.07 удалил этот модуль вместе с врезкой.
      // На 02.08 в базе снова лежали две химеры (Sarpsborg–Viking и NC Courage–Washington Spirit, обе с
      // кикоффом 08.08), то есть правило было не «переподключено», а просто отсутствовало.
      const koMsNow = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
      const claimsOver = s.final || s.state === "finished" || s.state === "live";
      if (claimsOver && Number.isFinite(koMsNow) && koMsNow - Date.parse(now) > 2 * 3_600_000) {
        legTally.dateGap++;
        recordReject(m.home, m.away, m.kickoff_at, s.date ?? null, league, "finished_before_kickoff");
        console.warn(`[enrich] finished_before_kickoff: «${m.home}–${m.away}» кикофф ${m.kickoff_at}, а событие ESPN уже «${s.state}${s.final ? "/final" : ""}» (${s.date ?? "—"}) — состояние НЕ применено (чужой круг на нашей записи)`);
        continue;
      }
      const flip = mirrored; // DB home is ESPN's away side → scores/lineups mirrored
      const scoreHome = flip ? s.scoreAway : s.scoreHome;
      const scoreAway = flip ? s.scoreHome : s.scoreAway;
      // Did THIS enrich transition the match into "finished"? Settlement lives
      // in settleMatch (called by syncMatchStatus, guarded on from!=="finished"),
      // so if enrich flips a match to finished first, syncMatchStatus would skip
      // it forever and its open bets would never resolve. Settle here instead.
      const becameFinished = (s.final || s.state === "finished") && m.state !== "finished";
      // Never regress state or wipe a known score on a stale/glitchy poll.
      const nextState = STATE_RANK[s.state] >= STATE_RANK[m.state] ? s.state : m.state;
      const sh = scoreHome ?? m.score_home, sa = scoreAway ?? m.score_away;
      // Stamp the Warsaw finish time HERE too: ESPN owns the live→finished transition for
      // covered matches, so enrich finishes them first and syncMatchStatus (guarded on
      // from!=="finished") then never stamps — the card would read a bare «финал».
      R.updateMatch(db, m.id, { state: nextState, minute: s.minute, score_home: sh, score_away: sa, clock: s.clock ?? null, ...(s.final ? { final_score: `${sh ?? 0}:${sa ?? 0}` } : {}), ...(becameFinished && !m.end_time ? finishStamp(m.kickoff_at, now) : {}) });
      if (becameFinished) { const fresh = R.getMatch(db, m.id); if (fresh) settleMatch(db, fresh, deps); }
      const detail = await provider.matchDetail!(sport, league, s.externalRef);
      const homeLineup = detail ? (flip ? detail.lineups.away : detail.lineups.home) : null;
      const awayLineup = detail ? (flip ? detail.lineups.home : detail.lineups.away) : null;
      // orient stats to the DB match's home/away, same as lineups
      const statHome = detail?.stats ? (flip ? detail.stats.away : detail.stats.home) : null;
      const statAway = detail?.stats ? (flip ? detail.stats.home : detail.stats.away) : null;
      const statsJson = (statHome || statAway) ? JSON.stringify({ home: statHome, away: statAway }) : null;
      // ALWAYS record a match_live row on a board match — even for tennis/esports
      // which have no lineup/stat detail. Its existence IS the "provider covers
      // this fixture / we have live data" signal the entry gate + uncovered-match
      // pruning rely on; without it a covered tennis match would read as blind.
      R.upsertMatchLive(db, { match_id: m.id, espn_event_id: s.externalRef, league, espn_event_date: s.date ?? null, home_lineup: homeLineup ? JSON.stringify(homeLineup) : null, away_lineup: awayLineup ? JSON.stringify(awayLineup) : null, stats: statsJson, updated_at: now });
      if (detail) {
        if (detail.lineupOut && !m.lineup_out) R.updateMatch(db, m.id, { lineup_out: true, state: s.state === "upcoming" ? "lineup" : s.state });
        for (const e of detail.events) {
          if (e.type === "other") continue;
          if (R.insertMatchEvent(db, { id: R.uid(), match_id: m.id, event_key: e.key, minute: e.minute, type: e.type, team: e.team, text: e.text, created_at: now })) {
            out.newEvents.push({ matchId: m.id, type: e.type, minute: e.minute, text: e.text });
          }
        }
      }
      out.enriched++;
    }
  }
  // P0.1: surface the leg-mismatch tally (blocking date_gap vs informational suffix) for ops/audit.
  if (legTally.dateGap || legTally.suffix || legTally.orient) {
    try { R.metaSet(db, "fixture_leg_mismatch", JSON.stringify({ ...legTally, at: now }), now); } catch { /* never block on a marker */ }
    // P3-audit: persist the per-rejection detail (bounded) so the tally can be inspected for false rejects.
    try { if (legRejects.length) R.metaSet(db, "fixture_bind_rejections", JSON.stringify({ at: now, rejects: legRejects }), now); } catch { /* best-effort */ }
  }
  return out;
}

export interface CompetitionSyncItem {
  competition: string; match: string; created: boolean; state: string; oddsLinked?: number;
}

/**
 * Sync every competition that is linked to an external league: import new
 * matches into it (categorized), refresh live status, and optionally attach
 * Polymarket odds to freshly imported matches.
 */
export async function syncCompetitions(
  db: Database, provider: SportsProvider, deps: EngineDeps = {}, opts: { linkOdds?: boolean } = {},
): Promise<CompetitionSyncItem[]> {
  const out: CompetitionSyncItem[] = [];
  for (const c of R.linkedCompetitions(db)) {
    const statuses = await provider.scoreboard(c.sport_id, c.external_league as string);
    for (const s of statuses) {
      const { match, created } = upsertImportedMatch(db, c.id, s);
      let oddsLinked: number | undefined;
      // Attempt odds linking for any non-finished match that still has none —
      // not just on first import. Polymarket often lists a match's markets only
      // closer to kickoff, so a match imported early must be retried on later
      // syncs (linkMatchOdds is a no-op once markets exist).
      if (opts.linkOdds && s.state !== "finished" && !R.latestMarkets(db, match.id).length) {
        oddsLinked = await linkMatchOdds(db, match, c.sport_id, deps);
      }
      const r = await syncMatchStatus(db, s, deps);
      const finalState = r?.to ?? s.state;
      // An ESPN board fixture Polymarket never listed has NO markets — untradeable.
      // Once it's LIVE or FINISHED, Polymarket's listing window has passed (odds
      // will never come), so it only clutters the UI as a market-less «LIVE» tile
      // with idle funded strategies (analysis just fails «нет рынков»). Drop it —
      // it provably holds no bets (no market to bet on). An UPCOMING market-less
      // match is kept: Polymarket often lists odds only closer to kickoff and the
      // retry above backfills them; discovery also re-imports a real match once it
      // has markets. (No markets ever ⇔ latestMarkets empty — a stored link never
      // disappears — so this can't drop a match whose odds merely failed one fetch.)
      if ((finalState === "live" || finalState === "finished") && !R.latestMarkets(db, match.id).length) {
        R.deleteMatchesById(db, [match.id]);
        continue;
      }
      out.push({ competition: c.id, match: `${s.home}–${s.away}`, created, state: finalState, oddsLinked });
    }
  }
  return out;
}

const fmt = (n: number) => `$${n.toFixed(1)}`;
