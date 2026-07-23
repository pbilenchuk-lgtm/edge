// ============================================================
// EDGE LAB — F4: prematch_value EXIT COUNTERFACTUAL  [MEASUREMENT ONLY, zero LLM, zero money-path]
//
// A prematch_value position that we CLOSED EARLY has two P&Ls: what we actually realized, and what it
// WOULD have paid held to the match's settlement. This report puts those side by side per bet and cuts the
// aggregate by EXIT REASON × MARKET FAMILY, so a systematically-harmful exit rule shows up as a cell where
// «держать до сеттла» beats «наш выход» by a material margin of turnover.
//
//   criterion (per cell): n ≥ MIN_N (30) AND Σ(hold − actual) / Σstake ≥ EDGE_MARGIN (15% of turnover)
//   → the exit rule LOST us ≥15¢ per $ traded in that cell vs simply holding. Flagged.
//
// Plus a TWIN block: the same pick held by ≥2 risk profiles that resolved to OPPOSITE outcomes (one won
// held, one lost on an early stop) — the divergence made concrete (audit: Cruz Azul team-Over twins).
//
// Counterfactual outcome comes from resolveFootballMarket on the FINAL score — the same grader settlement
// uses — so «hold-to-settle» is the real settle, not a guess. Only FINISHED, resolvable, clean-epoch PMV
// bets with an early exit enter; unresolvable (null grade) / unfinished are excluded and counted.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { betRecords, type BetRec, type ExitTrigger } from "./profileAnalytics.js";
import { resolveFootballMarket } from "./settlement.js";

export const PMV_STRATEGY = "prematch_value";
export const CF_MIN_N = (() => { const n = Number(process.env.PMV_CF_MIN_N); return Number.isFinite(n) && n > 0 ? n : 30; })();
export const CF_EDGE_MARGIN = (() => { const n = Number(process.env.PMV_CF_EDGE_MARGIN_PCT); return Number.isFinite(n) && n > 0 ? n / 100 : 0.15; })();

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Coarse market family for the cut. Order matters: totals before handicap (a signed total isn't a handicap). */
export function marketFamily(label: string): string {
  const l = label.toLowerCase();
  if (/\bover\b|\bunder\b|\bo\/u\b|\btotal\b|тотал|\bтб\b|\bтм\b/.test(l)) return "totals";
  if (/both teams to score|\bbtts\b|обе забьют/.test(l)) return "btts";
  if (/clean sheet|сухой|to nil/.test(l)) return "clean_sheet";
  if (/[+-]\d+(\.\d+)?|handicap|\bфора\b|spread|asian/.test(l)) return "handicap";
  if (/\bdraw\b|ничья|\b1x2\b/.test(l)) return "1x2/draw";
  return "moneyline/other";
}

const parseScore = (s: string | null): { h: number; a: number } | null => {
  const m = String(s ?? "").match(/(\d+)\s*[:\-–]\s*(\d+)/);
  return m ? { h: Number(m[1]), a: Number(m[2]) } : null;
};

export interface CfBet {
  betId: string; matchLabel: string; profileId: string; market: string; family: string;
  reason: ExitTrigger; entryCents: number; stake: number;
  actualPnl: number; holdPnl: number; delta: number; // delta = hold − actual (>0 → holding was better)
  heldWin: boolean;
}

/** Per-bet actual vs hold-to-settle for every early-closed, resolvable PMV bet. */
export function pmvCounterfactualBets(db: Database, pmvRecs?: BetRec[]): { bets: CfBet[]; excluded: { unresolvable: number; noEarlyExit: number; unfinished: number } } {
  // Accept a pre-loaded PMV slice so buildPmvExitCounterfactual scans the (large) bet log ONCE, not twice.
  const recs: BetRec[] = pmvRecs ?? betRecords(db).filter((r) => r.strategyId === PMV_STRATEGY);
  const bets: CfBet[] = [];
  let unresolvable = 0, noEarlyExit = 0, unfinished = 0;
  for (const r of recs) {
    if (r.outcome === "open") { unfinished++; continue; }        // not settled → no counterfactual yet
    if (r.exits.length === 0) { noEarlyExit++; continue; }        // held to settle already → nothing to compare
    if (r.entryCents == null || r.entryCents <= 0 || r.pnl == null) { unresolvable++; continue; }
    const fs = parseScore(r.finalScore);
    if (!fs) { unresolvable++; continue; }
    const m = R.getMatch(db, r.matchId);
    const heldWin = resolveFootballMarket(r.market, fs.h, fs.a, m ? { home: m.home, away: m.away } : undefined);
    if (heldWin == null) { unresolvable++; continue; }            // market not gradable from the score → skip
    const shares = r.stake / (r.entryCents / 100);
    const holdPnl = r2(heldWin ? shares - r.stake : -r.stake);
    const actualPnl = r.pnl;
    const reason: ExitTrigger = r.exits[r.exits.length - 1]?.trigger ?? "discretionary";
    bets.push({
      betId: r.id, matchLabel: r.matchLabel, profileId: r.profileId, market: r.market, family: marketFamily(r.market),
      reason, entryCents: r.entryCents, stake: r2(r.stake), actualPnl: r2(actualPnl), holdPnl, delta: r2(holdPnl - actualPnl), heldWin,
    });
  }
  return { bets, excluded: { unresolvable, noEarlyExit, unfinished } };
}

export interface CfCell {
  reason: string; family: string; n: number; turnover: number;
  actualPnl: number; holdPnl: number; delta: number; deltaPctTurnover: number | null; flagged: boolean;
}
function cellize(rows: CfBet[], keyOf: (b: CfBet) => { reason: string; family: string }): CfCell[] {
  const buckets = new Map<string, CfBet[]>();
  for (const b of rows) { const k = keyOf(b); const key = `${k.reason}|${k.family}`; (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(b); }
  const out: CfCell[] = [];
  for (const [key, rs] of buckets) {
    const [reason, family] = key.split("|");
    const turnover = rs.reduce((s, b) => s + b.stake, 0);
    const actualPnl = rs.reduce((s, b) => s + b.actualPnl, 0);
    const holdPnl = rs.reduce((s, b) => s + b.holdPnl, 0);
    const delta = holdPnl - actualPnl;
    const deltaPctTurnover = turnover > 0 ? delta / turnover : null;
    out.push({
      reason, family, n: rs.length, turnover: r2(turnover), actualPnl: r2(actualPnl), holdPnl: r2(holdPnl),
      delta: r2(delta), deltaPctTurnover: deltaPctTurnover == null ? null : r2(deltaPctTurnover * 100),
      flagged: rs.length >= CF_MIN_N && deltaPctTurnover != null && deltaPctTurnover >= CF_EDGE_MARGIN,
    });
  }
  // Most-harmful cells first (biggest positive delta % = holding would have helped most).
  return out.sort((a, b) => (b.deltaPctTurnover ?? -Infinity) - (a.deltaPctTurnover ?? -Infinity));
}

export interface TwinDivergence {
  matchLabel: string; market: string; n: number;
  legs: { profileId: string; pnl: number; earlyExit: boolean; heldWin: boolean }[];
  pnlSpread: number; // max − min realized pnl across the twin legs (same pick, same stake basis → the disposition cost)
  oppositeOutcomes: boolean; // ≥1 leg WON, ≥1 leg LOST on the same pick — the divergence made concrete
}
/** Same pick (match × market) held by ≥2 PMV profiles that resolved to OPPOSITE outcomes — the audit signal
 *  that an early exit on one profile realized a loss the twin (held) turned into a win. */
export function twinDivergences(pmvRecs: BetRec[]): TwinDivergence[] {
  // Group ALL settled PMV bets (not just early-closed) by match × market so a held twin joins its exited twin.
  const recs = pmvRecs.filter((r) => r.outcome !== "open");
  const groups = new Map<string, BetRec[]>();
  for (const r of recs) { const k = `${r.matchId}|${r.market}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  const out: TwinDivergence[] = [];
  for (const rs of groups.values()) {
    if (rs.length < 2) continue;
    const wins = rs.filter((r) => r.outcome === "won").length;
    const losses = rs.filter((r) => r.outcome === "lost").length;
    if (wins === 0 || losses === 0) continue; // only OPPOSITE-outcome twins are the signal
    const pnls = rs.map((r) => r.pnl ?? 0);
    out.push({
      matchLabel: rs[0].matchLabel, market: rs[0].market, n: rs.length,
      legs: rs.map((r) => ({ profileId: r.profileId, pnl: r2(r.pnl ?? 0), earlyExit: r.exits.length > 0, heldWin: r.outcome === "won" })),
      pnlSpread: r2(Math.max(...pnls) - Math.min(...pnls)), oppositeOutcomes: true,
    });
  }
  return out.sort((a, b) => b.pnlSpread - a.pnlSpread);
}

export interface PmvExitCounterfactual {
  strategy: string; criterion: { minN: number; edgeMarginPct: number };
  n: number; turnover: number;
  totalActualPnl: number; totalHoldPnl: number; totalDelta: number; deltaPctTurnover: number | null;
  byReasonFamily: CfCell[]; byReason: CfCell[]; byFamily: CfCell[];
  flaggedCells: CfCell[]; twins: TwinDivergence[];
  excluded: { unresolvable: number; noEarlyExit: number; unfinished: number };
  note: string;
}
export function buildPmvExitCounterfactual(db: Database): PmvExitCounterfactual {
  const pmvRecs = betRecords(db).filter((r) => r.strategyId === PMV_STRATEGY); // ONE scan of the bet log, shared
  const { bets, excluded } = pmvCounterfactualBets(db, pmvRecs);
  const turnover = bets.reduce((s, b) => s + b.stake, 0);
  const totalActualPnl = bets.reduce((s, b) => s + b.actualPnl, 0);
  const totalHoldPnl = bets.reduce((s, b) => s + b.holdPnl, 0);
  const totalDelta = totalHoldPnl - totalActualPnl;
  const byReasonFamily = cellize(bets, (b) => ({ reason: b.reason, family: b.family }));
  const byReason = cellize(bets, (b) => ({ reason: b.reason, family: "все" }));
  const byFamily = cellize(bets, (b) => ({ reason: "все", family: b.family }));
  return {
    strategy: PMV_STRATEGY, criterion: { minN: CF_MIN_N, edgeMarginPct: r2(CF_EDGE_MARGIN * 100) },
    n: bets.length, turnover: r2(turnover),
    totalActualPnl: r2(totalActualPnl), totalHoldPnl: r2(totalHoldPnl), totalDelta: r2(totalDelta),
    deltaPctTurnover: turnover > 0 ? r2((totalDelta / turnover) * 100) : null,
    byReasonFamily, byReason, byFamily,
    flaggedCells: byReasonFamily.filter((c) => c.flagged), twins: twinDivergences(pmvRecs),
    excluded,
    note: "delta = hold-to-settle − actual (>0 → держать было лучше). Flagged: n≥минимум И delta/turnover ≥ порог. Только PMV, завершённые, разрешимые, чистая эпоха.",
  };
}
