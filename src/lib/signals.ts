// ============================================================
// EDGE LAB — SIGNAL-LEVEL statistics  [S4 R0.1; hardened by the 25.07 audit, Phase 0]
//
// UNIT-OF-VERDICT FIX (R0.1): a bet RECORD is not an independent observation. One strategist decision is
// fanned out across 4 risk profiles and can be partial-filled, so «37 записей тоталов = 7 сигналов». Judging
// per record inflates n ~5× — a units-class bug.
//
// A SIGNAL = one decision on one (match, market, EPISODE): all its profiles + partials collapse to a single
// observation. Grouping is deterministic (match × canonical-market × strategy × kickoff-day), so history
// backfills with no schema change. P&L is summed over the signal's BOOK legs (a stale/model-fill leg — a price
// no live bid would have paid — carries NO book P&L); win/CLV are stake-weighted across the legs.
//
// Verdict thresholds move to signals: preliminary n≥25 decided, stable n≥40 decided. Significance on signals
// (Phase-0 corrections in brackets):
//   • win-vs-implied — POISSON-binomial upper tail over each decided signal's OWN implied prob [M2], not a
//     pooled mean-p exact binomial.
//   • CLV — one-sample t vs 0 over DECIDED signals [M4], a real Student-t two-sided p, gated at n≥8 [M3].
//   • P&L — seeded bootstrap P(book total ≤ 0).
//   • concentration — top-3 book share; robust needs ≥4 contributors AND top-3 ≤50% (or ≤70% once ≥40
//     decided) [M1] — the old unconditional n≥40 escape is gone.
// ============================================================

import type { BetRec } from "./profileAnalytics.js";

export const SIGNAL_N_PRELIM = 25;
export const SIGNAL_N_STABLE = 40;
export const CLV_SIG_MIN_N = 8; // [M3] no CLV significance verdict below this many decided-with-CLV signals

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
// [M8] Canonical market id, not the free-text label: strip trailing unit/descriptor noise so "Over 2.5" and
// "Over 2.5 Goals" collapse to one market, WITHOUT merging team/line-bearing labels (team name + line survive).
const MARKET_NOISE = /\b(goals?|голов|гол(?:а|ов)?|мяч(?:а|ей|ей)?|totals?|тотал|full\s*time|\bft\b|match|матч)\b/g;
export function canonicalMarket(label: string): string {
  return norm(label).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(MARKET_NOISE, " ").replace(/\s+/g, " ").trim();
}

/** The signal a record belongs to: match × canonical-market × strategy × EPISODE. The episode is the MATCH
 *  kickoff day [M7] (stable for every bet on that fixture — a UTC-midnight fan-out no longer splits one
 *  decision), falling back to the bet's createdAt day, then "" (matchId is already in the key, so an empty
 *  episode never cross-merges two matches). decision_id is NOT used — it is per-BET-unique here (the R0.1
 *  1:1 units-bug). Acceptance: the golden totals cell collapses ~40 records → ~8 signals. */
export function signalKey(r: Pick<BetRec, "matchId" | "market" | "strategyId" | "kickoffAt" | "createdAt">): string {
  const day = (r.kickoffAt ?? r.createdAt ?? "").slice(0, 10); // episode = match kickoff day, else bet day
  return `${r.matchId}|${canonicalMarket(r.market)}|${r.strategyId}|${day}`;
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
  impliedProb: number | null; clvCents: number | null;
  pnl: number;        // BOOK P&L — sum of the signal's non-stale/non-model-fill legs (the verdict-bearing number)
  grossPnl: number;   // all settled legs incl. stale/model-fill (reference/display only)
  stake: number;      // book stake (matches pnl's basis for ROI)
}

/** Stake-weighted mean of {value, weight} pairs; null when empty; falls back to a simple mean if all weights 0. */
function wmean(pairs: { v: number; w: number }[]): number | null {
  if (!pairs.length) return null;
  const wsum = pairs.reduce((a, p) => a + p.w, 0);
  if (wsum <= 0) return pairs.reduce((a, p) => a + p.v, 0) / pairs.length;
  return pairs.reduce((a, p) => a + p.v * p.w, 0) / wsum;
}

/** Collapse records to signals. P&L/stake SUMMED over BOOK legs (stale/model-fill legs carry null bookPnl and
 *  are excluded [H2]); CLV/implied are STAKE-WEIGHTED across the legs [M5]; a signal is decided only when ALL
 *  legs are settled, and a mixed won+lost signal is 'void' (not a win) [M6]. */
export function collapseToSignals(recs: BetRec[]): Signal[] {
  const by = new Map<string, BetRec[]>();
  for (const r of recs) { const k = signalKey(r); (by.get(k) ?? by.set(k, []).get(k)!).push(r); }
  const out: Signal[] = [];
  for (const [key, rs] of by) {
    const settledRs = rs.filter((r) => r.outcome !== "open");
    const bookRs = settledRs.filter((r) => r.bookPnl != null);             // [H2] non-stale/non-model-fill legs
    const pnl = bookRs.reduce((s, r) => s + (r.bookPnl ?? 0), 0);          // book P&L (verdict)
    const grossPnl = settledRs.reduce((s, r) => s + (r.pnl ?? 0), 0);      // all legs (reference)
    const stake = bookRs.reduce((s, r) => s + (r.stake ?? 0), 0);
    // [M6] precedence: a signal is settled only when every leg is settled; an open leg keeps it 'open'.
    const allSettled = rs.length > 0 && rs.every((r) => r.outcome !== "open");
    const anyWon = rs.some((r) => r.outcome === "won"), anyLost = rs.some((r) => r.outcome === "lost");
    const settled = allSettled;
    const outcome: Signal["outcome"] = !settled ? "open" : (anyWon && anyLost) ? "void" : anyWon ? "won" : anyLost ? "lost" : "void";
    const clvCents = wmean(rs.filter((r) => r.clvCents != null).map((r) => ({ v: r.clvCents!, w: Math.max(r.stake ?? 0, 0) })));
    const impliedProb = wmean(rs.filter((r) => r.impliedProb != null).map((r) => ({ v: r.impliedProb!, w: Math.max(r.stake ?? 0, 0) })));
    const rep = rs[0];
    out.push({
      key, strategyId: rep.strategyId, category: rep.category, market: rep.market, family: marketFamily(rep.market),
      phase: rep.phase, records: rs.length, settled, outcome,
      impliedProb: impliedProb != null ? Math.round(impliedProb * 10000) / 10000 : null,
      clvCents: clvCents != null ? Math.round(clvCents * 10) / 10 : null,
      pnl: Math.round(pnl * 100) / 100, grossPnl: Math.round(grossPnl * 100) / 100, stake: Math.round(stake * 100) / 100,
    });
  }
  return out;
}

// ── significance primitives ────────────────────────────────────────────────
const logChoose = (n: number, k: number): number => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; };
/** Exact one-sided upper-tail binomial P(X ≥ k | n, p). Kept for hand-checkable tests + as a degenerate
 *  fallback; the win verdict now uses the Poisson-binomial tail (heterogeneous implied). */
export function binomUpperTail(k: number, n: number, p: number): number {
  if (n <= 0) return 1; if (k <= 0) return 1; if (p <= 0) return k > 0 ? 0 : 1; if (p >= 1) return 1;
  let sum = 0; for (let i = k; i <= n; i++) sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, sum);
}
/** [M2] Poisson-binomial upper tail P(X ≥ k) for X = Σ Bernoulli(p_i), exact via O(n²) PMF convolution. This is
 *  the correct null for a set of signals each with its OWN implied prob; equal p_i reduces to the binomial. */
export function poissonBinomialUpperTail(k: number, probs: number[]): number {
  const n = probs.length;
  if (k <= 0) return 1; if (k > n) return 0; if (n === 0) return k > 0 ? 0 : 1;
  let pmf = [1];
  for (const praw of probs) {
    const p = Math.min(1, Math.max(0, praw));
    const next = new Array(pmf.length + 1).fill(0);
    for (let i = 0; i < pmf.length; i++) { next[i] += pmf[i] * (1 - p); next[i + 1] += pmf[i] * p; }
    pmf = next;
  }
  let tail = 0; for (let i = k; i <= n; i++) tail += pmf[i];
  return Math.min(1, Math.max(0, tail));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => { if (xs.length < 2) return 0; const mu = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1)); };

// Student-t two-sided p-value via the regularized incomplete beta (Lanczos lgamma + Lentz betacf).
function lgamma(x: number): number {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
/** Two-sided p-value for a one-sample t statistic with df degrees of freedom. */
export function studentTwoSidedP(t: number, df: number): number {
  if (!(df > 0)) return 1;
  const tt = Math.abs(t);
  return Math.min(1, betai(df / 2, 0.5, df / (df + tt * tt)));
}

/** Deterministic PRNG (mulberry32) so a report hit twice gives the SAME bootstrap p — seeded from the data. */
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export interface SignalTests {
  nSignals: number; nRecords: number; recordsPerSignal: number | null; nDecided: number;
  winVsImplied: { wins: number; nDecided: number; winPct: number | null; meanImpliedPct: number | null; binomP: number | null; beatsMarket: boolean };
  clv: { meanCents: number | null; t: number | null; p: number | null; n: number; significant: boolean };
  pnl: { totalUsd: number; grossUsd: number; bootP_le0: number | null; positiveSignificant: boolean };
  concentration: { top3ShareOfGrossPct: number | null; contributors: number; robust: boolean };
}

/** All four tests on a set of signals. Pure + deterministic. */
export function signalTests(signals: Signal[]): SignalTests {
  const decided = signals.filter((s) => s.outcome === "won" || s.outcome === "lost");
  // [M2] win-vs-implied on the DECIDED signals that carry an implied prob (consistent wins/n/probs base).
  const decidedWithImp = decided.filter((s) => s.impliedProb != null);
  const wins = decidedWithImp.filter((s) => s.outcome === "won").length;
  const probs = decidedWithImp.map((s) => s.impliedProb as number);
  const meanImp = probs.length ? mean(probs) : null;
  const binomP = decidedWithImp.length ? poissonBinomialUpperTail(wins, probs) : null;
  const winPct = decidedWithImp.length ? Math.round((1000 * wins) / decidedWithImp.length) / 10 : null;

  // [M4] CLV over DECIDED signals only (same sample as win/P&L), [M3] gated at n≥8 with a real Student-t p.
  const clvs = decided.map((s) => s.clvCents).filter((x): x is number => x != null);
  const clvMean = clvs.length ? mean(clvs) : null;
  const clvSd = sd(clvs);
  const clvT = clvs.length >= 2 && clvSd > 0 ? clvMean! / (clvSd / Math.sqrt(clvs.length)) : null;
  const clvP = clvT != null && clvs.length >= 2 ? studentTwoSidedP(clvT, clvs.length - 1) : null;
  const clvSignificant = clvT != null && clvs.length >= CLV_SIG_MIN_N && clvP != null && clvP < 0.05;

  const pnls = signals.filter((s) => s.settled).map((s) => s.pnl);       // book P&L
  const total = Math.round(pnls.reduce((a, b) => a + b, 0) * 100) / 100;
  const gross = Math.round(signals.filter((s) => s.settled).reduce((a, s) => a + s.grossPnl, 0) * 100) / 100;
  let bootP: number | null = null;
  if (pnls.length >= 5) {
    const seed = Math.round(Math.abs(total) * 100) + pnls.length * 7919; const rnd = mulberry32(seed || 1);
    const ITERS = 2000; let le0 = 0;
    for (let it = 0; it < ITERS; it++) { let s = 0; for (let i = 0; i < pnls.length; i++) s += pnls[Math.floor(rnd() * pnls.length)]; if (s <= 0) le0++; }
    bootP = Math.round((1000 * le0) / ITERS) / 1000;
  }
  const contributors = pnls.filter((x) => x !== 0).length;
  const grossAbs = pnls.reduce((a, b) => a + Math.abs(b), 0);
  const top3 = [...pnls].map(Math.abs).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const top3Share = grossAbs > 0 ? Math.round((1000 * top3) / grossAbs) / 10 : null;
  const nDecided = decided.length;
  // [M1] robustness on the DECIDED base: ≥4 contributors AND top-3 ≤50% (or ≤70% once ≥40 decided). The old
  // unconditional `nDecided ≥ 40` escape (which passed a top-3=95% cell as robust) is removed.
  const robust = contributors >= 4 && top3Share != null && (top3Share <= 50 || (nDecided >= SIGNAL_N_STABLE && top3Share <= 70));

  return {
    nSignals: signals.length, nRecords: signals.reduce((a, s) => a + s.records, 0),
    recordsPerSignal: signals.length ? Math.round((signals.reduce((a, s) => a + s.records, 0) / signals.length) * 100) / 100 : null,
    nDecided,
    winVsImplied: { wins, nDecided: decidedWithImp.length, winPct, meanImpliedPct: meanImp != null ? Math.round(meanImp * 1000) / 10 : null, binomP: binomP != null ? Math.round(binomP * 10000) / 10000 : null, beatsMarket: binomP != null && binomP < 0.05 },
    clv: { meanCents: clvMean != null ? Math.round(clvMean * 10) / 10 : null, t: clvT != null ? Math.round(clvT * 100) / 100 : null, p: clvP != null ? Math.round(clvP * 10000) / 10000 : null, n: clvs.length, significant: clvSignificant },
    pnl: { totalUsd: total, grossUsd: gross, bootP_le0: bootP, positiveSignificant: total > 0 && bootP != null && bootP < 0.05 },
    concentration: { top3ShareOfGrossPct: top3Share, contributors, robust },
  };
}

// Flag-only / shadow strategies place legacy sim-money bets that are NOT the real signal — their calibration
// lives in a dedicated shadow store. signal_stats over their `bets` measures the wrong box, so it must refuse
// a verdict and point at the right report.
export const FLAG_ONLY_STRATEGIES: Record<string, string> = { tennis_pmv: "?report=pmv_shadow_calibration (shadow-когорта, n≈62, Brier-go)" };

export interface SignalCohort extends SignalTests {
  strategyId?: string; phase?: string; family?: string;
  matured: "none" | "preliminary" | "stable";
  tripleAgreement: boolean;      // CLV t sig AND win beats market (p<0.05) AND P&L bootstrap positive-significant
  verdict: "insufficient" | "positive" | "negative" | "mixed" | "legacy_diagnostic";
  note: string;
}

/** Signal-level verdict for a cell (R0.1). Maturity keys on DECIDED signals (win/P&L-bearing): preliminary at
 *  n≥25 decided, stable at n≥40. POSITIVE = triple agreement AND concentration-robust; symmetric NEGATIVE. A
 *  flag-only strategy returns legacy_diagnostic (its real signal is in a shadow store, not `bets`). */
export function signalCohort(recs: BetRec[], meta: { strategyId?: string; phase?: string; family?: string } = {}): SignalCohort {
  const signals = collapseToSignals(recs);
  const t = signalTests(signals);
  const nDec = t.nDecided;
  const flagOnly = meta.strategyId ? FLAG_ONLY_STRATEGIES[meta.strategyId] : undefined;
  const matured = nDec >= SIGNAL_N_STABLE ? "stable" : nDec >= SIGNAL_N_PRELIM ? "preliminary" : "none";
  const triple = t.clv.significant && t.winVsImplied.beatsMarket && t.pnl.positiveSignificant;
  let verdict: SignalCohort["verdict"] = "insufficient";
  if (flagOnly) verdict = "legacy_diagnostic";
  else if (matured !== "none") {
    if (triple && t.concentration.robust) verdict = "positive";
    else if (t.pnl.totalUsd < 0 && ((t.clv.t != null && t.clv.t <= -2 && t.clv.significant) || (t.winVsImplied.binomP != null && t.winVsImplied.winPct != null && t.winVsImplied.meanImpliedPct != null && t.winVsImplied.winPct < t.winVsImplied.meanImpliedPct))) verdict = "negative";
    else verdict = "mixed";
  }
  const head = `n=${t.nSignals} сигналов / ${t.nRecords} записей (${t.recordsPerSignal}/сигнал), решённых ${nDec}`;
  const note = flagOnly
    ? `LEGACY-ДИАГНОСТИКА: signal_stats читает legacy sim-деньги этой flag-only стратегии (решено всего ${nDec}), НЕ её настоящий сигнал. Смотри ${flagOnly}. Вердикт не выносится.`
    : matured === "none"
      ? `копим: ${nDec}/${SIGNAL_N_PRELIM} РЕШЁННЫХ сигналов (${head}) — до предварительного вердикта. Единица — СИГНАЛ, не запись (R0.1).`
      : `${matured === "stable" ? "УСТОЙЧИВО" : "предварительно"} (${head}): CLV t=${t.clv.t} p=${t.clv.p} ${t.clv.significant ? "✓" : "✗"}, win ${t.winVsImplied.winPct}% vs рынок ${t.winVsImplied.meanImpliedPct}% (Poisson-бином p=${t.winVsImplied.binomP} ${t.winVsImplied.beatsMarket ? "✓" : "✗"}), book-P&L $${t.pnl.totalUsd} (boot P≤0=${t.pnl.bootP_le0} ${t.pnl.positiveSignificant ? "✓" : "✗"}), топ-3 ${t.concentration.top3ShareOfGrossPct}% (${t.concentration.contributors} доноров) ${t.concentration.robust ? "✓" : "✗"} → ${verdict === "positive" ? "ПОЛОЖИТЕЛЬНЫЙ (тройное согласие)" : verdict === "negative" ? "ОТРИЦАТЕЛЬНЫЙ" : "СМЕШАННЫЙ (нет согласия)"}`;
  return { ...t, ...meta, matured, tripleAgreement: triple, verdict, note };
}
