// ============================================================
// EDGE LAB — TENNIS PMV Markov core ("poisson.ts of tennis"). PURE, deterministic, unit-tested.
//
// The epistemic stance (see tennis_pmv_spec / BACKLOG): we do NOT price player strength. We take the
// LIQUID MONEYLINE as the anchor (the market's own P(win)), solve for the single class-differential δ
// that reproduces it under a hold-based Markov chain, and from that δ compute the THEORETICAL price
// of every prop (Total Games / Set Handicap / Set N Winner / Total Sets). PMV then trades only the
// INTERNAL INCONSISTENCY of an inattentive thin prop vs the moneyline — market against market.
//
// v1 simplifications (tagged): a game is won by the server with prob p_hold directly (no point-by-point
// expansion); the tiebreak is a logistic approximation from δ; sets are modelled i.i.d. (no fatigue /
// between-set dynamics). base_hold is an INTERIM constant by tour×surface, calibrated later from our
// own score snapshots. bo3 only. Nothing here is anchored on our own strength estimate — δ is market.
// ============================================================

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// INTERIM base hold probabilities by tour×surface (public analytics: ATP hard ~0.80, clay ~0.77,
// WTA ~0.65). Tagged interim — replaced by an epoch calibrated from our own hold-frequency snapshots.
export const BASE_HOLD = {
  atp_hard: num(process.env.TENNIS_BASE_HOLD_ATP_HARD, 0.80),
  atp_clay: num(process.env.TENNIS_BASE_HOLD_ATP_CLAY, 0.77),
  atp_grass: num(process.env.TENNIS_BASE_HOLD_ATP_GRASS, 0.82),
  wta: num(process.env.TENNIS_BASE_HOLD_WTA, 0.65),
};
export function baseHoldFor(tour: "atp" | "wta", surface: "hard" | "clay" | "grass" | null): number {
  if (tour === "wta") return BASE_HOLD.wta;
  return surface === "clay" ? BASE_HOLD.atp_clay : surface === "grass" ? BASE_HOLD.atp_grass : BASE_HOLD.atp_hard;
}

// Tiebreak win prob for A at 6-6: a logistic approximation from δ (the hold differential). δ=0 → 0.5;
// stronger server favoured. TB_K interim; the tiebreak is a v1 simplification (no point model).
const TB_K = num(process.env.TENNIS_TB_K, 6);
export function tiebreakProbA(delta: number): number {
  const p = 1 / (1 + Math.exp(-TB_K * delta));
  return Math.min(0.99, Math.max(0.01, p));
}

export interface SetDistribution {
  pA: number;                              // P(A wins the set)
  scoreProb: Map<string, number>;          // "ga-gb" (final set score) → probability, sums to 1
  totalGames: number[];                    // index = games in set (ga+gb) → probability
}

/**
 * Full distribution of a SINGLE set from the two hold probabilities, with serve alternating each game
 * (aServesFirst = does A serve game 1 of the set). Forward DP over game states; 6-6 resolves by the
 * logistic tiebreak. Deterministic and exact for the hold-game model. delta drives only the tiebreak.
 */
export function setDistribution(pHoldA: number, pHoldB: number, aServesFirst: boolean, delta: number): SetDistribution {
  const score = new Map<string, number>();
  let frontier = new Map<string, number>([["0-0", 1]]);
  const isTerminal = (a: number, b: number) => (a >= 6 && a - b >= 2) || (b >= 6 && b - a >= 2) || a === 7 || b === 7;
  while (frontier.size) {
    const next = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string, p: number) => m.set(k, (m.get(k) ?? 0) + p);
    for (const [key, p] of frontier) {
      const [a, b] = key.split("-").map(Number);
      if (isTerminal(a, b)) { bump(score, key, p); continue; }
      if (a === 6 && b === 6) { // tiebreak resolves the set to 7-6 / 6-7
        const tb = tiebreakProbA(delta);
        bump(score, "7-6", p * tb); bump(score, "6-7", p * (1 - tb));
        continue;
      }
      // Server of the NEXT game: alternates every game from the set's first server.
      const aServes = aServesFirst === ((a + b) % 2 === 0);
      const pAwinsGame = aServes ? pHoldA : 1 - pHoldB; // A holds, or A breaks B's serve
      bump(next, `${a + 1}-${b}`, p * pAwinsGame);
      bump(next, `${a}-${b + 1}`, p * (1 - pAwinsGame));
    }
    frontier = next;
  }
  let pA = 0;
  const totalGames: number[] = [];
  for (const [key, p] of score) {
    const [a, b] = key.split("-").map(Number);
    if (a > b) pA += p;
    const t = a + b;
    totalGames[t] = (totalGames[t] ?? 0) + p;
  }
  for (let i = 0; i < totalGames.length; i++) if (totalGames[i] == null) totalGames[i] = 0;
  return { pA, scoreProb: score, totalGames };
}

/** Convolve two discrete distributions indexed by integer (games/sets totals). */
function convolve(x: number[], y: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) { if (!x[i]) continue; for (let j = 0; j < y.length; j++) { if (!y[j]) continue; out[i + j] = (out[i + j] ?? 0) + x[i] * y[j]; } }
  for (let i = 0; i < out.length; i++) if (out[i] == null) out[i] = 0;
  return out;
}

export interface MatchDistribution {
  pMatchA: number;                 // P(A wins the match, bo3)
  pSetA: number;                   // P(A wins a single set) = Set 1 Winner (v1, no fatigue)
  sets: { a20: number; a21: number; b21: number; b20: number }; // set-score outcome masses (sum 1)
  pTwoSets: number;                // Total Sets = 2 (a straight-sets win either side)
  setTotalGames: number[];         // per-set games distribution (marginal) → Set N Games O/U
  matchTotalGames: number[];       // whole-match games distribution → Match Games O/U
}

/**
 * bo3 match distribution from the two hold probabilities. Sets are i.i.d. (v1). Match total games is
 * built by enumerating the set sequences (2-0 → 2 sets, 2-1 → 3 sets) and convolving the CONDITIONAL
 * per-set game totals (a set A wins has a different game-total shape than one B wins), so the
 * match-total correctly reflects that straight-sets blowouts carry fewer games.
 */
export function matchDistribution(pHoldA: number, pHoldB: number, delta: number, momentum = 0): MatchDistribution {
  const set = setDistribution(pHoldA, pHoldB, true, delta);
  const pSetA = set.pA;
  // Conditional per-set game-total distributions (| winner) — from the level (no-momentum) set, a
  // v1 approximation (momentum mainly shifts WHO wins a set, less the games-within-set shape).
  const totA: number[] = [], totB: number[] = [], totMarg: number[] = [];
  for (const [key, p] of set.scoreProb) {
    const [a, b] = key.split("-").map(Number); const t = a + b;
    totMarg[t] = (totMarg[t] ?? 0) + p;
    if (a > b) totA[t] = (totA[t] ?? 0) + p; else totB[t] = (totB[t] ?? 0) + p;
  }
  const normed = (arr: number[], mass: number): number[] => { const o: number[] = []; for (let i = 0; i < arr.length; i++) o[i] = mass > 0 ? (arr[i] ?? 0) / mass : 0; return o; };
  const gA = normed(totA, pSetA), gB = normed(totB, 1 - pSetA); // game-total | A/B won a set
  // SET-DEPENDENCE MOMENTUM (P3): the winner of a set gets +momentum to hold strength (loser −momentum)
  // in the NEXT set — i.i.d. sets over-priced 3-setters (the Total Sets Over lean). ε=0 → i.i.d.
  const clamp = (x: number) => Math.min(0.999, Math.max(0.001, x));
  const pSetAafter = (winnerWasA: boolean): number => {
    if (momentum === 0) return pSetA;
    const dA = winnerWasA ? momentum : -momentum;
    return setDistribution(clamp(pHoldA + dA), clamp(pHoldB - dA), true, delta).pA;
  };
  const s2A_ifA = pSetAafter(true), s2A_ifB = pSetAafter(false);   // P(A wins set2 | A/B won set1)
  const s3A_ifA = s2A_ifA, s3A_ifB = s2A_ifB;                       // set3 momentum from set2 winner (same shift)
  // Set-score outcomes (bo3) with momentum-conditioned set 2 / set 3.
  const a20 = pSetA * s2A_ifA, b20 = (1 - pSetA) * (1 - s2A_ifB);
  const a21 = pSetA * (1 - s2A_ifA) * s3A_ifB + (1 - pSetA) * s2A_ifB * s3A_ifA;
  const b21 = pSetA * (1 - s2A_ifA) * (1 - s3A_ifB) + (1 - pSetA) * s2A_ifB * (1 - s3A_ifA);
  const pMatchA = a20 + a21;
  // Match total games: weight each set-sequence by its prob, convolve its per-set conditional totals.
  const acc: number[] = [];
  const add = (w: number, dist: number[]) => { for (let i = 0; i < dist.length; i++) acc[i] = (acc[i] ?? 0) + w * (dist[i] ?? 0); };
  add(a20, convolve(gA, gA));                 // A A
  add(b20, convolve(gB, gB));                 // B B
  add(a21, convolve(convolve(gA, gA), gB));   // A wins 2, loses 1 (any order → same convolution)
  add(b21, convolve(convolve(gB, gB), gA));   // B wins 2, loses 1
  for (let i = 0; i < acc.length; i++) if (acc[i] == null) acc[i] = 0;
  return {
    pMatchA, pSetA, sets: { a20, a21, b21, b20 }, pTwoSets: a20 + b20,
    setTotalGames: (() => { const o: number[] = []; for (let i = 0; i < totMarg.length; i++) o[i] = totMarg[i] ?? 0; return o; })(),
    matchTotalGames: acc,
  };
}

// Set-dependence momentum ε (interim): the winner of a set gets +ε hold strength in the next set.
// Reduces 3-set rate (winner consolidates) — the fix for the Total Sets Over lean. Calibrated later
// from our snapshots' P(win set2 | won set1); tagged interim. ε=0 recovers the i.i.d.-sets v1.
export const TENNIS_MOMENTUM = num(process.env.TENNIS_MOMENTUM, 0.04);

/** P(A wins the bo3 match) for a given δ around base (monotone increasing in δ). */
export function matchWinProbA(base: number, delta: number, momentum = TENNIS_MOMENTUM): number {
  const pA = Math.min(0.999, Math.max(0.001, base + delta / 2));
  const pB = Math.min(0.999, Math.max(0.001, base - delta / 2));
  return matchDistribution(pA, pB, delta, momentum).pMatchA;
}

/**
 * Solve for the class differential δ that reproduces the MONEYLINE P(A wins) under the chain — binary
 * search (matchWinProbA is monotone in δ). This is the whole anchor: no strength estimate of ours, the
 * market's moneyline dictates δ. Returns δ clamped to the range that keeps both holds in (0,1).
 */
export function deltaFromMoneyline(pMoneylineA: number, base: number, momentum = TENNIS_MOMENTUM): number {
  const target = Math.min(0.999, Math.max(0.001, pMoneylineA));
  const maxD = 2 * Math.min(base, 1 - base) * 0.999; // keep pA,pB within (0,1)
  let lo = -maxD, hi = maxD;
  if (matchWinProbA(base, hi, momentum) <= target) return hi;   // market more lopsided than the model can reach
  if (matchWinProbA(base, lo, momentum) >= target) return lo;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (matchWinProbA(base, mid, momentum) < target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// ── Theoretical prop prices (cents) from the solved chain ──────────────────
const tailProb = (dist: number[], from: number): number => { let s = 0; for (let i = from; i < dist.length; i++) s += dist[i] ?? 0; return s; };

export interface TennisTheo {
  delta: number; pHoldA: number; pHoldB: number;
  set1WinnerA: number;          // P(A wins a set)
  totalSetsOver25: number;      // P(3 sets) — "Total Sets O/U 2.5" Over
  setHandicapA15: number;       // P(A wins by 2 sets = 2-0) — "Set Handicap A −1.5"
  matchGamesOver: (line: number) => number;   // P(match total games ≥ line+0.5)
  setGamesOver: (line: number) => number;      // P(a set's games ≥ line+0.5) (marginal per-set)
  dist: MatchDistribution;
}

/** Build every listed prop's theoretical probability from the moneyline anchor + base_hold + momentum. */
export function tennisTheo(pMoneylineA: number, base: number, momentum = TENNIS_MOMENTUM): TennisTheo {
  const delta = deltaFromMoneyline(pMoneylineA, base, momentum);
  const pHoldA = Math.min(0.999, Math.max(0.001, base + delta / 2));
  const pHoldB = Math.min(0.999, Math.max(0.001, base - delta / 2));
  const dist = matchDistribution(pHoldA, pHoldB, delta, momentum);
  const gamesOver = (dist2: number[]) => (line: number) => tailProb(dist2, Math.ceil(line + 0.5));
  return {
    delta, pHoldA, pHoldB,
    set1WinnerA: dist.pSetA,
    totalSetsOver25: 1 - dist.pTwoSets, // Over 2.5 sets == a 3-set match
    setHandicapA15: dist.sets.a20,
    matchGamesOver: gamesOver(dist.matchTotalGames),
    setGamesOver: gamesOver(dist.setTotalGames),
    dist,
  };
}
