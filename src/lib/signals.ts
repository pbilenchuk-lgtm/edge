// ============================================================
// EDGE LAB — SIGNAL-LEVEL statistics  [S4, strategic master spec R0.1]
//
// UNIT-OF-VERDICT FIX (owner ratification R0.1): a bet RECORD is not an independent observation. One
// strategist decision is fanned out across 4 risk profiles and can be partial-filled, so «37 записей тоталов
// = 7 сигналов». Judging verdicts per record inflates n ~5× and understates variance — a units-class bug.
//
// A SIGNAL = one decision on one (match, market): all its profiles + partials collapse to a single
// observation. Grouping is deterministic from existing fields (decision_id, else match|market|strategy), so
// history backfills with no schema change. win/CLV are shared across a signal's records (same side, same
// entry/close); P&L is summed (the money that decision made).
//
// All verdict thresholds move to signals: preliminary n≥25, stable n≥40. Significance on signals:
//   • win-vs-implied — exact one-sided binomial P(X≥wins | n, mean implied)
//   • CLV — one-sample t vs 0 (t≥2 ≈ p<0.05 two-sided at these n)
//   • P&L — seeded bootstrap P(total ≤ 0)
//   • concentration — top-3 signals' share of gross P&L (a thesis-stacked few driving it all → not robust)
// ============================================================

import type { BetRec } from "./profileAnalytics.js";

export const SIGNAL_N_PRELIM = 25;
export const SIGNAL_N_STABLE = 40;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The signal a record belongs to. decision_id groups a strategist decision's profiles (and its partials);
 *  without one, fall back to (match, market, strategy) — still collapses the 4-profile fan-out. */
export function signalKey(r: Pick<BetRec, "decisionId" | "matchId" | "market" | "strategyId">): string {
  return r.decisionId ? `d:${r.decisionId}` : `m:${r.matchId}|${norm(r.market)}|${r.strategyId}`;
}

/** Coarse market family for cell cuts (totals / btts / handicap / draw / other-1x2). */
export function marketFamily(label: string): "totals" | "btts" | "handicap" | "draw" | "other" {
  const m = norm(label);
  if (/btts|both teams/.test(m)) return "btts";
  if (/\bover\b|\bunder\b/.test(m)) return "totals";
  if (/handicap|spread|\(-|\(\+/.test(m)) return "handicap";
  if (/\bdraw\b|ничья/.test(m)) return "draw";
  return "other";
}

export interface Signal {
  key: string; strategyId: string; category: string; market: string; family: string;
  phase: "prematch" | "live"; records: number;
  settled: boolean; outcome: "won" | "lost" | "void" | "open";
  impliedProb: number | null; clvCents: number | null; pnl: number; stake: number;
}

/** Collapse records to signals. win/CLV/implied are taken from the signal's records (they agree — same
 *  side, same entry/close); P&L and stake are SUMMED (total the decision realized across its profiles). */
export function collapseToSignals(recs: BetRec[]): Signal[] {
  const by = new Map<string, BetRec[]>();
  for (const r of recs) { const k = signalKey(r); (by.get(k) ?? by.set(k, []).get(k)!).push(r); }
  const out: Signal[] = [];
  for (const [key, rs] of by) {
    const settledRs = rs.filter((r) => r.pnl != null && r.outcome !== "open");
    const pnl = settledRs.reduce((s, r) => s + (r.pnl ?? 0), 0);
    const stake = settledRs.reduce((s, r) => s + (r.stake ?? 0), 0);
    // outcome: a signal is won/lost by its decision's result; any settled record carries it (void if all void).
    const anyWon = rs.some((r) => r.outcome === "won"), anyLost = rs.some((r) => r.outcome === "lost");
    const settled = rs.some((r) => r.outcome !== "open");
    const outcome: Signal["outcome"] = !settled ? "open" : anyWon && !anyLost ? "won" : anyLost && !anyWon ? "lost" : anyWon ? "won" : "void";
    const firstClv = rs.map((r) => r.clvCents).find((x): x is number => x != null) ?? null;
    const firstImp = rs.map((r) => r.impliedProb).find((x): x is number => x != null) ?? null;
    const rep = rs[0];
    out.push({ key, strategyId: rep.strategyId, category: rep.category, market: rep.market, family: marketFamily(rep.market), phase: rep.phase, records: rs.length, settled, outcome, impliedProb: firstImp, clvCents: firstClv, pnl: Math.round(pnl * 100) / 100, stake: Math.round(stake * 100) / 100 });
  }
  return out;
}

// ── significance primitives ────────────────────────────────────────────────
const logChoose = (n: number, k: number): number => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; };
/** Exact one-sided upper-tail binomial P(X ≥ k | n, p). */
export function binomUpperTail(k: number, n: number, p: number): number {
  if (n <= 0) return 1; if (k <= 0) return 1; if (p <= 0) return k > 0 ? 0 : 1; if (p >= 1) return 1;
  let sum = 0; for (let i = k; i <= n; i++) sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, sum);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => { if (xs.length < 2) return 0; const mu = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1)); };
/** Deterministic PRNG (mulberry32) so a report hit twice gives the SAME bootstrap p — seeded from the data. */
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export interface SignalTests {
  nSignals: number; nRecords: number;
  winVsImplied: { wins: number; nDecided: number; winPct: number | null; meanImpliedPct: number | null; binomP: number | null; beatsMarket: boolean };
  clv: { meanCents: number | null; t: number | null; n: number; significant: boolean };
  pnl: { totalUsd: number; bootP_le0: number | null; positiveSignificant: boolean };
  concentration: { top3ShareOfGrossPct: number | null; robust: boolean };
}

/** All four tests on a set of signals. Pure + deterministic. */
export function signalTests(signals: Signal[]): SignalTests {
  const decided = signals.filter((s) => s.outcome === "won" || s.outcome === "lost");
  const wins = decided.filter((s) => s.outcome === "won").length;
  const imps = decided.map((s) => s.impliedProb).filter((x): x is number => x != null);
  const meanImp = imps.length ? mean(imps) : null;
  const binomP = decided.length && meanImp != null ? binomUpperTail(wins, decided.length, meanImp) : null;
  const winPct = decided.length ? Math.round((1000 * wins) / decided.length) / 10 : null;

  const clvs = signals.map((s) => s.clvCents).filter((x): x is number => x != null);
  const clvMean = clvs.length ? mean(clvs) : null;
  const clvT = clvs.length >= 2 && sd(clvs) > 0 ? clvMean! / (sd(clvs) / Math.sqrt(clvs.length)) : null;

  const pnls = signals.filter((s) => s.settled).map((s) => s.pnl);
  const total = Math.round(pnls.reduce((a, b) => a + b, 0) * 100) / 100;
  let bootP: number | null = null;
  if (pnls.length >= 5) {
    const seed = Math.round(Math.abs(total) * 100) + pnls.length * 7919; const rnd = mulberry32(seed || 1);
    const ITERS = 2000; let le0 = 0;
    for (let it = 0; it < ITERS; it++) { let s = 0; for (let i = 0; i < pnls.length; i++) s += pnls[Math.floor(rnd() * pnls.length)]; if (s <= 0) le0++; }
    bootP = Math.round((1000 * le0) / ITERS) / 1000;
  }
  const gross = pnls.reduce((a, b) => a + Math.abs(b), 0);
  const top3 = [...pnls].map(Math.abs).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const top3Share = gross > 0 ? Math.round((1000 * top3) / gross) / 10 : null;

  return {
    nSignals: signals.length, nRecords: signals.reduce((a, s) => a + s.records, 0),
    winVsImplied: { wins, nDecided: decided.length, winPct, meanImpliedPct: meanImp != null ? Math.round(meanImp * 1000) / 10 : null, binomP: binomP != null ? Math.round(binomP * 10000) / 10000 : null, beatsMarket: binomP != null && binomP < 0.05 },
    clv: { meanCents: clvMean != null ? Math.round(clvMean * 10) / 10 : null, t: clvT != null ? Math.round(clvT * 100) / 100 : null, n: clvs.length, significant: clvT != null && clvT >= 2 },
    pnl: { totalUsd: total, bootP_le0: bootP, positiveSignificant: total > 0 && bootP != null && bootP < 0.05 },
    concentration: { top3ShareOfGrossPct: top3Share, robust: (top3Share != null && top3Share <= 50) || signals.length >= SIGNAL_N_STABLE },
  };
}

export interface SignalCohort extends SignalTests {
  strategyId?: string; phase?: string; family?: string;
  matured: "none" | "preliminary" | "stable";
  tripleAgreement: boolean;      // CLV t≥2 AND win beats market (p<0.05) AND P&L bootstrap positive-significant
  verdict: "insufficient" | "positive" | "negative" | "mixed";
  note: string;
}

/** Signal-level verdict for a cell (R0.1). preliminary at n≥25 signals, stable at n≥40; a POSITIVE verdict
 *  needs the triple agreement AND concentration-robust; a NEGATIVE verdict is the symmetric refutation. */
export function signalCohort(recs: BetRec[], meta: { strategyId?: string; phase?: string; family?: string } = {}): SignalCohort {
  const signals = collapseToSignals(recs);
  const t = signalTests(signals);
  const n = t.nSignals;
  const matured = n >= SIGNAL_N_STABLE ? "stable" : n >= SIGNAL_N_PRELIM ? "preliminary" : "none";
  const triple = t.clv.significant && t.winVsImplied.beatsMarket && t.pnl.positiveSignificant;
  let verdict: SignalCohort["verdict"] = "insufficient";
  if (matured !== "none") {
    if (triple && t.concentration.robust) verdict = "positive";
    else if (t.pnl.totalUsd < 0 && (t.clv.t != null && t.clv.t <= -2 || (t.winVsImplied.binomP != null && t.winVsImplied.winPct != null && t.winVsImplied.meanImpliedPct != null && t.winVsImplied.winPct < t.winVsImplied.meanImpliedPct))) verdict = "negative";
    else verdict = "mixed";
  }
  const note = matured === "none"
    ? `копим: ${n}/${SIGNAL_N_PRELIM} сигналов (${t.nRecords} записей) — до предварительного вердикта. Единица — СИГНАЛ, не запись (R0.1).`
    : `${matured === "stable" ? "УСТОЙЧИВО" : "предварительно"} (n=${n} сигналов / ${t.nRecords} записей): CLV t=${t.clv.t} ${t.clv.significant ? "✓" : "✗"}, win ${t.winVsImplied.winPct}% vs рынок ${t.winVsImplied.meanImpliedPct}% (бином p=${t.winVsImplied.binomP} ${t.winVsImplied.beatsMarket ? "✓" : "✗"}), P&L $${t.pnl.totalUsd} (boot P≤0=${t.pnl.bootP_le0} ${t.pnl.positiveSignificant ? "✓" : "✗"}), топ-3 ${t.concentration.top3ShareOfGrossPct}% ${t.concentration.robust ? "✓" : "✗"} → ${verdict === "positive" ? "ПОЛОЖИТЕЛЬНЫЙ (тройное согласие)" : verdict === "negative" ? "ОТРИЦАТЕЛЬНЫЙ" : "СМЕШАННЫЙ (нет согласия)"}`;
  return { ...t, ...meta, matured, tripleAgreement: triple, verdict, note };
}
