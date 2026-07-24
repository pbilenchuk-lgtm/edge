// ============================================================
// EDGE LAB — POLYMARKET RESOLUTION SETTLE  [SERVER-ONLY]  (Decision-1, condition 1 — the FT-mode prerequisite)
//
// A Polymarket-only football fixture (ESPN/StatPal never linked it — see F1 exonym linking) never receives
// OUR match score, so settleMatch's score-based resolveOutcome returns null and the bet sits `open` forever.
// This settles those bets from the MARKET's resolution instead: after a market resolves, its outcome TOKEN
// prices to ~100¢ (this side won) / ~0¢ (lost) and the Gamma market flips `closed`. Resolution is read from
// the SAME tokens trading already uses (market.external_ref) — no new name mapping.
//
// Fail-closed, per the six ratified design rules:
//   1. PRIMARY = the market's closed/resolved flag; the price only picks the winning SIDE. FALLBACK (no flag)
//      = a resolving price (≥HI / ≤LO) that is STABLE across two polls ≥STABLE_MIN apart. A jittery
//      "confidence" (96¢ pre-resolution, a UMA dispute could still flip) is NOT a resolution.
//   2. COMPLEMENT check: if both tokens of the market are known, the winner is ~HI AND the loser ~LO (sum
//      ~100). A mismatch → `resolution_orientation_suspect`: do NOT settle, log loud. (No 7th orientation bug.)
//   3. VOID split: a real market void (closed=true + a non-resolving price → PM refunded) → settled_by "void";
//      our patience running out (finished ≥ VOID_TIMEOUT_H, still unresolved) → "void_timeout" — a DISTINCT
//      tag so an audit separates "PM refunded" from "we stopped waiting". A resolving price with NO closed
//      flag → wait + log, never void.
//   4. Redemption is NOT a trade → this P&L path charges NO exit fee (settleBet books payout from entry/stake).
//   5. Provenance: settled_by = "pm_resolution" (or the two void tags).
//   6. The first pass also BACKFILLS the hidden tail of already-eternal-open PM-only bets — counted + reported,
//      a free validation of the contour on historical data before FT entries are ever enabled.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { settleBet } from "./settlement.js";
import { isFtBlindBet } from "./betMeta.js";
import { loadShadowConfig, shadowOnExit } from "./shadow.js";
import { loadPolymarketConfig, fetchTokenResolution } from "./polymarket.js";

export interface PmResolutionConfig {
  hiCents: number;        // ≥ this = the winning side
  loCents: number;        // ≤ this = the losing side
  voidTimeoutH: number;   // finished ≥ this and still unresolved → void_timeout
  stableMin: number;      // fallback: a resolving price must persist across two polls ≥ this many minutes apart
  matchDurationH: number; // finish ≈ kickoff + this (PM-only fixtures carry no real end_time)
}
export function loadPmResolutionConfig(env: Record<string, string | undefined> = process.env): PmResolutionConfig {
  const num = (k: string, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    hiCents: num("PM_RES_HI_CENTS", 99),
    loCents: num("PM_RES_LO_CENTS", 1),
    voidTimeoutH: num("PM_RES_VOID_TIMEOUT_H", 72),
    stableMin: num("PM_RES_STABLE_MIN", 30),
    matchDurationH: num("PM_RES_MATCH_DURATION_H", 2.5),
  };
}

/** Resolution state of one token: its current price (cents) and whether the Gamma market is closed/resolved. */
export interface TokenResolution { priceCents: number | null; closed: boolean }
export type ResolveTokensFn = (tokenIds: string[]) => Promise<Record<string, TokenResolution>>;

export interface PmResolutionResult {
  candidates: number;        // open bets on PM-only (score-less) finished football fixtures examined
  settled: number; won: number; lost: number;
  marketVoid: number;        // closed=true + non-resolving price → PM refunded
  voidTimeout: number;       // unresolved past the timeout → we stopped waiting
  suspect: number;           // complement mismatch → not settled, flagged
  pendingStable: number;     // resolving price, no closed flag → awaiting the second stable poll
  pendingUnresolved: number; // no resolving price yet, still inside the timeout
  zombieBackfill: number;    // = candidates: the hidden already-eternal-open tail this pass cleared/examined
  // Proof #2: the one-time bank impact of this pass (a backfill settles a tail that accrued for weeks — a
  // STEP on the P&L curve, not a trading result). settled_by="pm_resolution"/void tags segment it out of daily cuts.
  bankDeltaUsd: number;      // Σ P&L booked this pass (won/lost payouts − stakes; a void refund is 0)
  reservesFreedUsd: number;  // Σ stake released back to the shadow bank this pass
}

const PMRES_OBS = "pmres_obs:"; // per-bet fallback observation: JSON { side: "won"|"lost", at: iso }

/**
 * Settle the open bets of Polymarket-only (score-less) FINISHED football fixtures from PM market resolution.
 * Pure of any entry logic — it only resolves the unresolvable tail. Safe to run every sweep (idempotent: a
 * settled bet is skipped next pass). The token resolver is injectable for tests; the default reads live
 * prices via getQuotes and the closed flag best-effort from Gamma.
 */
export async function settlePmResolutionBets(
  db: Database, deps: EngineDeps & { resolveTokens?: ResolveTokensFn } = {},
): Promise<PmResolutionResult> {
  const now = deps.now?.() ?? new Date().toISOString();
  const nowMs = Date.parse(now) || Date.now();
  const cfg = loadPmResolutionConfig(deps.env);
  const shadowCfg = loadShadowConfig(db, deps.env);
  const res: PmResolutionResult = { candidates: 0, settled: 0, won: 0, lost: 0, marketVoid: 0, voidTimeout: 0, suspect: 0, pendingStable: 0, pendingUnresolved: 0, zombieBackfill: 0, bankDeltaUsd: 0, reservesFreedUsd: 0 };

  // 1) Gather candidates: FINISHED football matches with NO score (the PM-only signature) that still hold open bets.
  const cands: { betId: string; matchId: string; kickoffAt: string | null; createdAt: string; token: string | null; token2: string | null }[] = [];
  const tokenSet = new Set<string>();
  for (const comp of R.listCompetitions(db).filter((c) => c.sport_id === "football")) {
    for (const m of R.listMatches(db, comp.id)) {
      if (m.state !== "finished") continue;
      if (m.score_home != null && m.score_away != null) continue; // has our score → the normal settleMatch path owns it
      for (const b of R.betsForMatch(db, m.id)) {
        if (b.status !== "open") continue;
        const mk = R.latestMarkets(db, m.id).find((x) => x.label === b.market_label);
        const token = mk?.external_ref ?? null;
        const token2 = mk?.token_second ?? null;
        if (token) tokenSet.add(token);
        if (token2) tokenSet.add(token2);
        cands.push({ betId: b.id, matchId: m.id, kickoffAt: m.kickoff_at, createdAt: b.created_at, token, token2 });
      }
    }
  }
  res.candidates = cands.length;
  res.zombieBackfill = cands.length; // rule 6: this pass's count of the hidden open tail
  if (!cands.length) return res;

  // 2) Resolve every token once (price + closed flag).
  const resolver = deps.resolveTokens ?? defaultResolveTokens(deps);
  const map = await resolver([...tokenSet]);

  const isWonSide = (p: number | null) => p != null && p >= cfg.hiCents;
  const isLostSide = (p: number | null) => p != null && p <= cfg.loCents;
  const isResolving = (p: number | null) => isWonSide(p) || isLostSide(p);

  const settle = (betId: string, won: boolean, priceCents: number | null) => {
    const b = R.getBet(db, betId); if (!b) return;
    // Rule 4: redemption is not a trade — settleBet books payout from entry/stake with NO exit fee.
    const patch = settleBet({ entry_price: b.entry_price, stake: b.stake }, won, priceCents);
    R.updateBet(db, betId, { status: patch.status, result: patch.result, payout: patch.payout, closing_price: patch.closing_price, settled_at: now, settled_by: "pm_resolution" });
    try { shadowOnExit(db, betId, 1, shadowCfg, now); } catch { /* observe-only */ }
    try { R.metaDelete(db, `${PMRES_OBS}${betId}`); } catch { /* best-effort */ }
    R.insertTradeLog(db, { id: R.uid(), match_id: b.match_id, strategy_id: b.strategy_id, minute: "финал", type: "settle", text: `${b.market_label}: PM-резолюция → ${won ? "выигрыш" : "проигрыш"} (цена ${priceCents ?? "?"}¢) · выплата $${(patch.payout ?? 0).toFixed(2)} (P&L ${(patch.pnl).toFixed(2)}) [pm_resolution]`, created_at: now });
    res.settled++; won ? res.won++ : res.lost++;
    res.bankDeltaUsd += patch.pnl; res.reservesFreedUsd += b.stake ?? 0;
  };
  const voidBet = (betId: string, tag: "void" | "void_timeout", detail: string) => {
    const b = R.getBet(db, betId); if (!b) return;
    R.updateBet(db, betId, { status: "settled_void", result: null, payout: b.stake ?? 0, settled_at: now, closing_price: b.current_price ?? b.entry_price ?? null, settled_by: tag });
    try { shadowOnExit(db, betId, 1, shadowCfg, now); } catch { /* observe-only */ }
    try { R.metaDelete(db, `${PMRES_OBS}${betId}`); } catch { /* best-effort */ }
    R.insertTradeLog(db, { id: R.uid(), match_id: b.match_id, strategy_id: b.strategy_id, minute: "финал", type: "settle", text: `${b.market_label}: ${detail} — возврат ставки $${(b.stake ?? 0).toFixed(2)} (P&L $0) [${tag}]`, created_at: now });
    tag === "void" ? res.marketVoid++ : res.voidTimeout++;
    res.reservesFreedUsd += b.stake ?? 0; // a refund frees the reserve; P&L 0 → no bankDelta
  };

  for (const c of cands) {
    if (!c.token) { res.pendingUnresolved++; continue; }        // no token → can't resolve from PM
    const t = map[c.token] ?? { priceCents: null, closed: false };
    const comp = c.token2 ? map[c.token2] : null;
    const finishedMs = (c.kickoffAt ? Date.parse(c.kickoffAt) : NaN);
    const finishMs = Number.isFinite(finishedMs) ? finishedMs + cfg.matchDurationH * 3_600_000 : (Date.parse(c.createdAt) || nowMs);
    const overdue = nowMs - finishMs >= cfg.voidTimeoutH * 3_600_000;

    // Rule 2: complement orientation check — only meaningful when we're about to call a resolving side.
    const complementOk = (): boolean => {
      if (!comp || comp.priceCents == null) return true;         // unknown complement → can't cross-check, allow
      if (isWonSide(t.priceCents)) return isLostSide(comp.priceCents);
      if (isLostSide(t.priceCents)) return isWonSide(comp.priceCents);
      return true;
    };

    // Rule 1 PRIMARY: the market is closed/resolved.
    if (t.closed) {
      if (isResolving(t.priceCents)) {
        if (!complementOk()) { res.suspect++; suspectLog(db, c, t, comp, now); continue; }
        settle(c.betId, isWonSide(t.priceCents), t.priceCents);
      } else {
        // Rule 3: closed with a non-resolving price = a real market void/refund.
        voidBet(c.betId, "void", `рынок закрыт с неразрешающей ценой ${t.priceCents ?? "?"}¢ — рыночный void/refund`);
      }
      continue;
    }

    // Rule 1 FALLBACK: no closed flag — a resolving price must persist across two polls ≥ stableMin apart.
    if (isResolving(t.priceCents)) {
      const side: "won" | "lost" = isWonSide(t.priceCents) ? "won" : "lost";
      const prev = readObs(db, c.betId);
      if (prev && prev.side === side && (nowMs - (Date.parse(prev.at) || nowMs)) >= cfg.stableMin * 60_000) {
        if (!complementOk()) { res.suspect++; suspectLog(db, c, t, comp, now); continue; }
        settle(c.betId, side === "won", t.priceCents);
      } else {
        if (!prev || prev.side !== side) writeObs(db, c.betId, side, now); // (re)start the stability clock
        res.pendingStable++;
      }
      continue;
    }

    // Not closed, not resolving. Rule 3: only NOW may the timeout void fire.
    if (overdue) voidBet(c.betId, "void_timeout", `не разрешилось за ${cfg.voidTimeoutH}ч (PM не закрыл рынок)`);
    else res.pendingUnresolved++;
  }

  res.bankDeltaUsd = Math.round(res.bankDeltaUsd * 100) / 100;
  res.reservesFreedUsd = Math.round(res.reservesFreedUsd * 100) / 100;
  return res;
}

function readObs(db: Database, betId: string): { side: "won" | "lost"; at: string } | null {
  try { const s = R.metaGet(db, `${PMRES_OBS}${betId}`); if (s) { const o = JSON.parse(s); if (o && (o.side === "won" || o.side === "lost")) return o; } } catch { /* ignore */ }
  return null;
}
function writeObs(db: Database, betId: string, side: "won" | "lost", at: string): void {
  try { R.metaSet(db, `${PMRES_OBS}${betId}`, JSON.stringify({ side, at }), at); } catch { /* best-effort */ }
}
function suspectLog(db: Database, c: { betId: string; matchId: string }, t: TokenResolution, comp: TokenResolution | null, now: string): void {
  const b = R.getBet(db, c.betId); if (!b) return;
  R.insertTradeLog(db, { id: R.uid(), match_id: c.matchId, strategy_id: b.strategy_id, minute: "финал", type: "skip", text: `${b.market_label}: resolution_orientation_suspect — токен ${t.priceCents ?? "?"}¢ и комплемент ${comp?.priceCents ?? "?"}¢ не образуют ~0/~100 пары; НЕ сеттлю, разбор вручную`, created_at: now });
}

/** Default resolver: Gamma market state per token (closed flag + resolved outcomePrices) — the source that
 *  survives archival, so a historical backfill resolves correctly. Bounded + hard-timeout inside
 *  fetchTokenResolution; an unknown token is absent from the map → the caller reads it as unresolved. */
function defaultResolveTokens(deps: EngineDeps): ResolveTokensFn {
  return async (tokenIds: string[]) => {
    const poly = deps.polymarket ?? loadPolymarketConfig(deps.env);
    return fetchTokenResolution(poly, tokenIds, { fetchImpl: deps.fetchImpl });
  };
}

// FT-blind cohort (Decision-1 condition 2): the SEPARATE verdict row for blind Polymarket-only positions —
// a different risk class (zero in-flight management), kept out of the managed prematch_value metrics and
// measured on its own. Read-only.
export interface FtBlindCohort { total: number; open: number; settled: number; won: number; lost: number; void: number; pnl: number; winPct: number | null }
export function ftBlindCohort(db: Database): FtBlindCohort {
  const c: FtBlindCohort = { total: 0, open: 0, settled: 0, won: 0, lost: 0, void: 0, pnl: 0, winPct: null };
  for (const comp of R.listCompetitions(db).filter((x) => x.sport_id === "football")) {
    for (const m of R.listMatches(db, comp.id)) {
      for (const b of R.betsForMatch(db, m.id)) {
        if (!isFtBlindBet(b)) continue;
        c.total++;
        if (b.status === "open") { c.open++; continue; }
        c.settled++;
        if (b.status === "settled_void") c.void++;
        else if (b.result === "won") c.won++;
        else if (b.result === "lost") c.lost++;
        c.pnl += (b.payout ?? 0) - (b.stake ?? 0);
      }
    }
  }
  c.pnl = Math.round(c.pnl * 100) / 100;
  const decided = c.won + c.lost;
  c.winPct = decided ? Math.round((c.won / decided) * 1000) / 10 : null;
  return c;
}
