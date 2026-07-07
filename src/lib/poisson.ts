// ============================================================
// EDGE LAB — football analysis Layer 1: Poisson derivation.
//
// The analyst LLM estimates only a small CORE (expected goals + first-half shares
// + a low-score correction) and a scenario tree. This module is the CODE that
// turns `core` into the full market distribution (outcome, totals, BTTS, handicap,
// advance, halves) via a Dixon–Coles-corrected bivariate Poisson — so every market
// comes from ONE coherent estimate instead of 20 independent guesses. No quotes
// involved. Then valid overrides (with a reason) nudge specific markets.
// ============================================================

export interface AnalysisCore {
  xg_home: number;
  xg_away: number;
  home_share_1h: number; // fraction of home xG that falls in the 1st half (~0.44)
  away_share_1h: number;
  poisson_correction: number; // Dixon–Coles ρ for low-score dependence (0 = pure Poisson)
}

export interface AnalysisOverride { target: string; adjust: number; reason?: string }
export interface CoreAdjustment { target: string; op: "multiply" | "add"; value: number; reason?: string }

export interface DerivedMarkets {
  outcome_90: { home: number; draw: number; away: number };
  advance: { home: number; away: number };
  extra_time_prob: number;
  totals_match: Record<string, number>; // P(OVER line) per line
  totals_home: Record<string, number>;
  totals_away: Record<string, number>;
  totals_1h: Record<string, number>;
  totals_2h: Record<string, number>;
  btts: number;
  btts_2h: number;
  handicap: Record<string, number>; // home_-1.5 = P(home wins by ≥2), etc.
}

const K = 12; // score-matrix ceiling — P(≥12 goals a side) is negligible
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function factorial(n: number): number { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function pmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

/** Dixon–Coles low-score correction τ: pure Poisson slightly under-weights the
 *  0-0/1-1 draws football actually produces. Here POSITIVE ρ adds draw mass
 *  (boosts 0-0 & 1-1, trims 1-0 & 0-1); ρ=0 → 1. Clamped ≥0 for safety. */
function dcTau(i: number, j: number, lh: number, la: number, rho: number): number {
  if (!rho) return 1;
  let t = 1;
  if (i === 0 && j === 0) t = 1 + lh * la * rho;
  else if (i === 0 && j === 1) t = 1 - lh * rho;
  else if (i === 1 && j === 0) t = 1 - la * rho;
  else if (i === 1 && j === 1) t = 1 + rho;
  return Math.max(0, t);
}

/** Normalised joint score matrix M[i][j] = P(home=i, away=j). */
function scoreMatrix(lh: number, la: number, rho: number): number[][] {
  const M: number[][] = [];
  let sum = 0;
  for (let i = 0; i <= K; i++) {
    M[i] = [];
    for (let j = 0; j <= K; j++) {
      const p = pmf(lh, i) * pmf(la, j) * dcTau(i, j, lh, la, rho);
      M[i][j] = p; sum += p;
    }
  }
  if (sum > 0) for (let i = 0; i <= K; i++) for (let j = 0; j <= K; j++) M[i][j] /= sum;
  return M;
}

/** Sum the joint matrix over a predicate on (homeGoals, awayGoals). */
function sumWhere(M: number[][], pred: (i: number, j: number) => boolean): number {
  let s = 0;
  for (let i = 0; i <= K; i++) for (let j = 0; j <= K; j++) if (pred(i, j)) s += M[i][j];
  return clamp(s, 0, 1);
}

const LINES_MATCH = [0.5, 1.5, 2.5, 3.5];
const LINES_TEAM = [0.5, 1.5, 2.5];
const LINES_1H = [0.5, 1.5];
const LINES_2H = [0.5, 1.5, 2.5];

/** OVER probabilities for a set of lines from a joint matrix, keyed by "X.5". */
function overs(M: number[][], lines: number[], total: (i: number, j: number) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) out[String(line)] = round4(sumWhere(M, (i, j) => total(i, j) > line));
  return out;
}

/**
 * Turn the analyst's CORE into the full derived market distribution. Pure Poisson
 * (Dixon–Coles corrected) — no quotes, no overrides yet. All probabilities are
 * OVER/YES/side probabilities in 0..1.
 */
export function derivePoissonMarkets(core: AnalysisCore): DerivedMarkets {
  const lh = clamp(core.xg_home, 0.01, 8), la = clamp(core.xg_away, 0.01, 8);
  const rho = Number.isFinite(core.poisson_correction) ? clamp(core.poisson_correction, -0.1, 0.1) : 0;
  const sH = clamp(core.home_share_1h ?? 0.44, 0.1, 0.9), sA = clamp(core.away_share_1h ?? 0.44, 0.1, 0.9);

  const M = scoreMatrix(lh, la, rho);
  const home = sumWhere(M, (i, j) => i > j);
  const draw = sumWhere(M, (i, j) => i === j);
  const away = sumWhere(M, (i, j) => i < j);

  // First / second half as their own (pure-Poisson) score matrices.
  const M1 = scoreMatrix(lh * sH, la * sA, 0);
  const M2 = scoreMatrix(lh * (1 - sH), la * (1 - sA), 0);

  const btts = round4(sumWhere(M, (i, j) => i >= 1 && j >= 1));
  const btts2h = round4(sumWhere(M2, (i, j) => i >= 1 && j >= 1));

  // Knockout: a 90-min draw goes to extra time (≈ P(draw)); advance ≈ win + the
  // draw share split toward the stronger side (ET/penalties slightly favour higher
  // xG), bias_home = xg_home / (xg_home + xg_away).
  const extraTime = round4(draw);
  const biasHome = lh + la > 0 ? lh / (lh + la) : 0.5;
  const advHome = round4(home + draw * biasHome);
  const advAway = round4(away + draw * (1 - biasHome));

  const handicap: Record<string, number> = {
    "home_-1.5": round4(sumWhere(M, (i, j) => i - j >= 2)),
    "home_-2.5": round4(sumWhere(M, (i, j) => i - j >= 3)),
  };

  return {
    outcome_90: { home: round4(home), draw: round4(draw), away: round4(away) },
    advance: { home: advHome, away: advAway },
    extra_time_prob: extraTime,
    totals_match: overs(M, LINES_MATCH, (i, j) => i + j),
    totals_home: overs(M, LINES_TEAM, (i) => i),
    totals_away: overs(M, LINES_TEAM, (_i, j) => j),
    totals_1h: overs(M1, LINES_1H, (i, j) => i + j),
    totals_2h: overs(M2, LINES_2H, (i, j) => i + j),
    btts,
    btts_2h: btts2h,
    handicap,
  };
}

/**
 * Apply the analyst's overrides to the derived distribution. An override nudges
 * ONE market by `adjust` (probability points) and MUST carry a reason — code drops
 * any override without one. `target` is a dotted path like "totals_match.2.5.over"
 * or "outcome_90.draw"; ".over"/".under"/".yes"/".no" suffixes are honoured. Draw
 * outcomes are renormalised across home/draw/away so the triple still sums to 1.
 * Returns the count applied.
 */
export function applyOverrides(d: DerivedMarkets, overrides: AnalysisOverride[] | undefined): number {
  if (!Array.isArray(overrides)) return 0;
  let applied = 0;
  for (const o of overrides) {
    if (!o || typeof o.target !== "string" || !Number.isFinite(o.adjust) || !o.reason || !o.reason.trim()) continue;
    // `adjust` refers to the OVER/YES side; a ".under"/".no" suffix flips the sign.
    // Peel the suffix by string (NOT split — line keys like "2.5" contain a dot).
    let target = o.target, sign = 1;
    for (const suf of ["over", "under", "yes", "no"]) {
      if (target.endsWith("." + suf)) { target = target.slice(0, -(suf.length + 1)); if (suf === "under" || suf === "no") sign = -1; break; }
    }
    if (bumpPath(d, target, sign * o.adjust)) applied++;
  }
  // Keep the 1X2 triple normalised after any outcome_90 nudge.
  const o90 = d.outcome_90;
  const s = o90.home + o90.draw + o90.away;
  if (s > 0) { o90.home = round4(o90.home / s); o90.draw = round4(o90.draw / s); o90.away = round4(o90.away / s); }
  return applied;
}

export interface CoreAdjustLog { target: string; op: string; value: number; reason: string; applied: boolean }

/**
 * Apply the category layer's core_adjustments to the base core (Step 1 of the
 * assembler): multiply/add per target, in order, skipping any adjustment without a
 * non-empty reason or an unknown target (logged as not applied). Sanity-clamps xG
 * (0.1–5) and half-shares (0.1–0.9). Pure — returns a NEW core plus a debug log.
 */
export function applyCoreAdjustments(core: AnalysisCore, adjustments: CoreAdjustment[] | undefined): { core: AnalysisCore; log: CoreAdjustLog[] } {
  const c: AnalysisCore = { ...core };
  const log: CoreAdjustLog[] = [];
  const FIELDS = new Set(["xg_home", "xg_away", "home_share_1h", "away_share_1h", "poisson_correction"]);
  for (const a of adjustments ?? []) {
    const ok = a && typeof a.target === "string" && FIELDS.has(a.target) && Number.isFinite(a.value) && (a.op === "multiply" || a.op === "add") && !!a.reason && !!a.reason.trim();
    if (ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cc = c as any;
      cc[a.target] = a.op === "multiply" ? cc[a.target] * a.value : cc[a.target] + a.value;
    }
    log.push({ target: a?.target ?? "", op: a?.op ?? "", value: a?.value ?? 0, reason: a?.reason ?? "", applied: !!ok });
  }
  c.xg_home = clamp(c.xg_home, 0.1, 5); c.xg_away = clamp(c.xg_away, 0.1, 5);
  c.home_share_1h = clamp(c.home_share_1h, 0.1, 0.9); c.away_share_1h = clamp(c.away_share_1h, 0.1, 0.9);
  c.poisson_correction = clamp(c.poisson_correction, -0.1, 0.1);
  return { core: c, log };
}

/** Add `delta` to the probability at a target and clamp to [0,1]. The market tree
 *  is at most two levels: a scalar leaf ("btts") or group.key ("totals_match.2.5",
 *  "outcome_90.draw", "handicap.home_-1.5"). Split on the FIRST dot only so decimal
 *  line keys survive. Returns false if the target doesn't resolve to a number. */
function bumpPath(d: DerivedMarkets, target: string, delta: number): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root = d as any;
  const dot = target.indexOf(".");
  if (dot < 0) {
    if (typeof root[target] !== "number") return false;
    root[target] = round4(clamp(root[target] + delta, 0, 1));
    return true;
  }
  const group = root[target.slice(0, dot)];
  const key = target.slice(dot + 1);
  if (group == null || typeof group[key] !== "number") return false;
  group[key] = round4(clamp(group[key] + delta, 0, 1));
  return true;
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }
