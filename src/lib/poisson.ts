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

export type MatchType = "group" | "knockout" | "uncertain";

/** A mutually-exclusive branch of the outcome tree (see deriveOutcomeScenarios).
 *  The 6 branches are MECE over (winner × BTTS): {fav|draw|dog} × {no|yes}. No
 *  priority order — each final score maps to exactly one branch by who won and
 *  whether both teams scored. Because the split is homogeneous on BTTS and winner,
 *  BTTS/Extra-Time/advance fall out of the tree cleanly (self-consistency guards
 *  below). Pre-match Value reads these to pick bets that live in the heaviest
 *  branches and to see which branches kill two legs at once. */
export interface OutcomeScenario {
  id: "fav_clean" | "fav_concedes" | "draw_0_0" | "draw_scoring" | "dog_clean" | "dog_concedes";
  label: string;
  prob: number;                       // Σ P of every final score in this branch
  favorite: "home" | "away";
  winner_side: "fav" | "draw" | "dog"; // for advance/winner by summing sides
  btts: "no" | "yes";                  // branch is homogeneous on BTTS
  score_cluster: string[];            // heaviest "i:j" scores in the branch (readability)
  bets_that_live: string[];           // market shorthands that win inside this branch
  leads_to_extra_time: boolean;       // knockout + a draw branch (draw_0_0 / draw_scoring) → ET
  /** Only for the *_concedes branches, whose TOTAL is not homogeneous (2:1 is
   *  Under 3.5 but Over 1.5; 3:2 is Over 2.5): the within-branch split around the
   *  2.5 line, so a consumer on a borderline total checks the scores, not the
   *  raw branch weight. null for the other four (homogeneous-enough) branches. */
  total_note: string | null;
}

/** Deterministic match shape from the branch weights — replaces asking the LLM to
 *  "type" the match. A = class favourite grinds it out; B = open game; C = tight,
 *  evenly-matched; mixed = none dominant. */
export type MatchShape = "A" | "B" | "C" | "mixed";

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
  outcome_scenarios: OutcomeScenario[]; // 6 MECE branches (winner × BTTS), Σ prob = 1
  match_shape: MatchShape;
}

// ---- outcome-scenario clustering + match_shape thresholds (named for calibration) ----
// SPLIT RULE (guard against branch sprawl): split a branch into sub-branches ONLY
// if the new edge (a) opens a tradeable market not already in the tree, OR (b)
// flips the sign of a bet. Do NOT split for matrix "tidiness". These 6 branches
// already cover every tradeable market (advance, BTTS, totals, Extra Time,
// handicaps) — further splitting adds weight-estimation noise without new signal.
const SHAPE_FAV_MIN = 0.55;      // fav_clean + fav_concedes above this → shape A (class favourite)
const SHAPE_SCORING_MIN = 0.55;  // scoring branches (fav_concedes + draw_scoring + dog_concedes) above → shape B (open)
const SHAPE_TIGHT_DOG_MIN = 0.45; // draws + dog_* above this → candidate C (tight/even)
const SHAPE_FAV_WEAK_MAX = 0.45;  // fav-side weight below this = favourite weakly expressed (C)

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
export function derivePoissonMarkets(core: AnalysisCore, matchType: MatchType = "uncertain"): DerivedMarkets {
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
    // Built from the SAME final-core matrix M as everything above — so category
    // core_adjustments already fold into the tree. Overrides are post-hoc nudges
    // to specific market probs (not the score matrix), so they leave the branch
    // weights unchanged; building here vs after applyOverrides is equivalent.
    ...outcomeScenariosFromMatrix(M, lh >= la, matchType === "knockout"),
  };
}

const SCENARIO_LABELS: Record<OutcomeScenario["id"], string> = {
  fav_clean: "фаворит побеждает всухую",
  fav_concedes: "фаворит выигрывает, пропустив",
  draw_0_0: "ничья 0:0",
  draw_scoring: "результативная ничья",
  dog_clean: "аутсайдер побеждает всухую",
  dog_concedes: "аутсайдер выигрывает, пропустив",
};
const WINNER_SIDE: Record<OutcomeScenario["id"], "fav" | "draw" | "dog"> = {
  fav_clean: "fav", fav_concedes: "fav", draw_0_0: "draw", draw_scoring: "draw", dog_clean: "dog", dog_concedes: "dog",
};
const BRANCH_BTTS: Record<OutcomeScenario["id"], "no" | "yes"> = {
  fav_clean: "no", fav_concedes: "yes", draw_0_0: "no", draw_scoring: "yes", dog_clean: "no", dog_concedes: "yes",
};
const SCENARIO_IDS: OutcomeScenario["id"][] = ["fav_clean", "fav_concedes", "draw_0_0", "draw_scoring", "dog_clean", "dog_concedes"];

/** MECE classification by (winner × BTTS): exactly one branch per final score, no
 *  priority order. winner is fav/draw/dog (fav/dog by xG); BTTS = both teams scored.
 *  fav won → dog=0 is fav_clean, dog≥1 is fav_concedes; symmetric for dog; a draw
 *  is 0:0 or a scoring draw. */
function scenarioFor(i: number, j: number, favHome: boolean): OutcomeScenario["id"] {
  const favG = favHome ? i : j, dogG = favHome ? j : i;
  const bothScored = i >= 1 && j >= 1;
  if (favG > dogG) return bothScored ? "fav_concedes" : "fav_clean";
  if (favG < dogG) return bothScored ? "dog_concedes" : "dog_clean";
  return i === 0 ? "draw_0_0" : "draw_scoring"; // draw (i===j)
}

/** bets_that_live from winner_side + btts (+ knockout for the draw branches). */
function betsThatLive(id: OutcomeScenario["id"], knockout: boolean): string[] {
  switch (id) {
    case "fav_clean": return ["fav_win", "fav_-0.5", "btts_no"];
    case "fav_concedes": return ["fav_win", "btts_yes", "over_1.5"];
    case "draw_0_0": return knockout ? ["extra_time_yes", "under_2.5", "btts_no"] : ["draw", "under_2.5", "btts_no"];
    case "draw_scoring": return knockout ? ["extra_time_yes", "btts_yes", "over_1.5"] : ["draw", "btts_yes", "over_1.5"];
    case "dog_clean": return ["dog_win", "dog_+0.5", "btts_no"];
    case "dog_concedes": return ["dog_win", "dog_+0.5", "btts_yes"];
  }
}

/** Within-branch total distribution for the *_concedes branches, whose total is
 *  NOT homogeneous (2:1 is Over 2.5 but Under 3.5; 3:2 is Over 3.5). A win with
 *  both teams scoring is always ≥3 goals, so the 2.5 line is degenerate — the
 *  useful split is the 3.5 line. We report both Over shares so a consumer on a
 *  borderline total checks the scores, not the raw branch weight. null if empty. */
function totalNote(cells: { s: string; p: number }[], branchProb: number): string | null {
  if (branchProb <= 0) return null;
  let o25 = 0, o35 = 0;
  for (const c of cells) { const [hi, aj] = c.s.split(":").map(Number); const t = hi + aj; if (t >= 3) o25 += c.p; if (t >= 4) o35 += c.p; }
  return `Over2.5: ${Math.round((o25 / branchProb) * 100)}%, Over3.5: ${Math.round((o35 / branchProb) * 100)}% внутри ветки`;
}

/** Cluster a normalised score matrix into the 6-branch MECE tree + match_shape.
 *  Pure; the sole source of truth for both derivePoissonMarkets and the exported
 *  deriveOutcomeScenarios wrapper. Because the split is homogeneous on (winner,
 *  BTTS), the tree must reproduce the independent Poisson BTTS and draw/ET masses
 *  exactly — a mismatch is a clustering bug, so we throw (never fail silently). */
function outcomeScenariosFromMatrix(M: number[][], favHome: boolean, knockout: boolean): { outcome_scenarios: OutcomeScenario[]; match_shape: MatchShape } {
  const acc: Record<string, { prob: number; cells: { s: string; p: number }[] }> = {};
  for (const id of SCENARIO_IDS) acc[id] = { prob: 0, cells: [] };
  let raw = 0;
  for (let i = 0; i <= K; i++) for (let j = 0; j <= K; j++) {
    const p = M[i][j]; raw += p;
    const id = scenarioFor(i, j, favHome);
    acc[id].prob += p;
    if (p > 0) acc[id].cells.push({ s: `${i}:${j}`, p });
  }
  // (1) Partition: every cell landed in exactly one branch → weights sum to the mass.
  const branchSum = SCENARIO_IDS.reduce((s, id) => s + acc[id].prob, 0);
  if (Math.abs(branchSum - raw) > 1e-6) throw new Error(`outcome_scenarios: branches sum ${branchSum} ≠ matrix mass ${raw}`);
  // (2) BTTS falls out of the tree cleanly: the three "yes" branches must equal the
  //     independent Poisson BTTS mass. Only a MECE-by-BTTS split guarantees this.
  const rawBtts = sumWhere(M, (i, j) => i >= 1 && j >= 1);
  const bttsYes = acc.fav_concedes.prob + acc.draw_scoring.prob + acc.dog_concedes.prob;
  if (Math.abs(bttsYes - rawBtts) > 1e-6) throw new Error(`outcome_scenarios: BTTS-yes branches ${bttsYes} ≠ Poisson btts ${rawBtts}`);
  // (3) Extra time (draws) falls out cleanly too: both draw branches = P(draw 90).
  const rawDraw = sumWhere(M, (i, j) => i === j);
  const drawBranches = acc.draw_0_0.prob + acc.draw_scoring.prob;
  if (Math.abs(drawBranches - rawDraw) > 1e-6) throw new Error(`outcome_scenarios: draw branches ${drawBranches} ≠ Poisson draw ${rawDraw}`);
  const favorite = favHome ? "home" : "away";
  const outcome_scenarios: OutcomeScenario[] = SCENARIO_IDS.map((id) => ({
    id,
    label: SCENARIO_LABELS[id],
    prob: round4(acc[id].prob),
    favorite,
    winner_side: WINNER_SIDE[id],
    btts: BRANCH_BTTS[id],
    score_cluster: acc[id].cells.sort((a, b) => b.p - a.p).slice(0, 4).map((c) => c.s),
    bets_that_live: betsThatLive(id, knockout),
    leads_to_extra_time: knockout && (id === "draw_0_0" || id === "draw_scoring"),
    total_note: (id === "fav_concedes" || id === "dog_concedes") ? totalNote(acc[id].cells, acc[id].prob) : null,
  }));
  return { outcome_scenarios, match_shape: matchShapeFrom(acc) };
}

function matchShapeFrom(acc: Record<string, { prob: number }>): MatchShape {
  const favSide = acc.fav_clean.prob + acc.fav_concedes.prob;
  const scoring = acc.fav_concedes.prob + acc.draw_scoring.prob + acc.dog_concedes.prob;
  const tightDog = acc.draw_0_0.prob + acc.draw_scoring.prob + acc.dog_clean.prob + acc.dog_concedes.prob;
  if (favSide >= SHAPE_FAV_MIN) return "A";                                       // class favourite
  if (scoring >= SHAPE_SCORING_MIN) return "B";                                   // open, goals-y
  if (tightDog >= SHAPE_TIGHT_DOG_MIN && favSide < SHAPE_FAV_WEAK_MAX) return "C"; // tight, even
  return "mixed";
}

/** Public wrapper: the outcome tree from a CORE (recomputes the matrix). Used by
 *  callers that have the final core but not the matrix. Identical result to the
 *  copy derivePoissonMarkets embeds. */
export function deriveOutcomeScenarios(core: AnalysisCore, matchType: MatchType = "uncertain"): { outcome_scenarios: OutcomeScenario[]; match_shape: MatchShape } {
  const lh = clamp(core.xg_home, 0.01, 8), la = clamp(core.xg_away, 0.01, 8);
  const rho = Number.isFinite(core.poisson_correction) ? clamp(core.poisson_correction, -0.1, 0.1) : 0;
  return outcomeScenariosFromMatrix(scoreMatrix(lh, la, rho), lh >= la, matchType === "knockout");
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
