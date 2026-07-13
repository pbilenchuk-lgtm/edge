// ============================================================
// EDGE LAB — game-state-adjusted LIVE probability for MELTING-OPTION markets.
//
// Audit (Argentina–Switzerland, matchId d271b090): the live probability of the
// trailing team scoring was estimated backward-looking from ACCUMULATED tempo
// (live-xG 0.13 → P≈0.34) and the position (Switzerland Over 0.5) was cut on a
// "closed edge" at 31–43¢ minutes before the goal (market then 95–100¢). A
// trailing team is FORCED to open up in the 2nd half and goals cluster late —
// a regime shift the accumulated-tempo view can't see. This layer supplies the
// strategist a game-state NUMBER (P of the event in the remainder) alongside the
// price, so live edge is measured against game-state, not an LLM back-extrapolation.
// §9.6 invariant preserved: code supplies the number, the LLM still judges.
//
// All multipliers are NAMED, env-tunable constants with conservative defaults —
// starting reference points; calibrate later from the measurement slice.
// ============================================================

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export interface LiveProbConfig {
  gsTrail1: number;       // trailing by 1 → boost to that team's remaining λ
  gsTrail2plus: number;   // trailing by 2+ → modest boost (opens up, but also breaks)
  gsLead: number;         // leading → reduction (sits on the result)
  lateFromMin: number;    // minute at which late-game goal clustering starts ramping
  lateBoost: number;      // max additional multiplier by regulation end
  regulationEnd: number;  // 90 for football
}

export function loadLiveProbConfig(env: Record<string, string | undefined> = process.env): LiveProbConfig {
  return {
    gsTrail1: num(env.LIVEPROB_GS_TRAIL1, 1.35),
    gsTrail2plus: num(env.LIVEPROB_GS_TRAIL2PLUS, 1.15),
    gsLead: num(env.LIVEPROB_GS_LEAD, 0.85),
    lateFromMin: num(env.LIVEPROB_LATE_FROM_MIN, 45),
    lateBoost: num(env.LIVEPROB_LATE_BOOST, 0.35),
    regulationEnd: num(env.LIVEPROB_REG_END, 90),
  };
}

/** Fraction of a team's FULL-MATCH xG still to come at `minute`, using the 1st-half
 *  share (goals are back-loaded: share1h < 0.5 ⇒ the 2nd half carries more). A team's
 *  remaining expected goals = full xG × this. Deterministic in the match minute. */
export function remainingXgFraction(minute: number, share1h: number, regEnd = 90): number {
  const s = clamp(share1h, 0.1, 0.9);
  const half = regEnd / 2;
  if (minute <= 0) return 1;
  if (minute >= regEnd) return 0;
  if (minute < half) return s * (half - minute) / half + (1 - s); // rest of 1H (pro-rata) + all 2H
  return (1 - s) * (regEnd - minute) / half;                        // rest of the 2H (pro-rata)
}

/** Game-state multiplier on a team's remaining λ from its score differential (its
 *  goals − opponent goals). Trailing → forced to attack; leading → sits. */
export function gameStateMultiplier(scoreDiff: number, cfg: LiveProbConfig): number {
  if (scoreDiff <= -2) return cfg.gsTrail2plus;
  if (scoreDiff === -1) return cfg.gsTrail1;
  if (scoreDiff >= 1) return cfg.gsLead;
  return 1; // level
}

/** Late-game clustering: 1.0 until lateFromMin, ramping to 1+lateBoost by regEnd. */
export function lateGameProfile(minute: number, cfg: LiveProbConfig): number {
  if (minute <= cfg.lateFromMin) return 1;
  const frac = clamp((minute - cfg.lateFromMin) / (cfg.regulationEnd - cfg.lateFromMin), 0, 1);
  return 1 + cfg.lateBoost * frac;
}

/** Core: game-state-adjusted remaining λ and P(team scores ≥1 in the remainder). */
export function liveScoreProb(
  input: { teamXgFull: number; teamShare1h: number; minute: number; scoreDiff: number },
  cfg: LiveProbConfig,
): { lambdaRemaining: number; prob: number; gs: number; late: number } {
  const baseRem = Math.max(0, input.teamXgFull) * remainingXgFraction(input.minute, input.teamShare1h, cfg.regulationEnd);
  const gs = gameStateMultiplier(input.scoreDiff, cfg);
  const late = lateGameProfile(input.minute, cfg);
  const lambda = baseRem * gs * late;
  return { lambdaRemaining: lambda, prob: 1 - Math.exp(-lambda), gs, late };
}

/** Poisson P(X ≥ k) for a mean λ (k small — team-goal thresholds). */
export function poissonAtLeast(k: number, lambda: number): number {
  if (k <= 0) return 1;
  let term = Math.exp(-lambda), cdf = term; // P(X=0)
  for (let i = 1; i < k; i++) { term *= lambda / i; cdf += term; }
  return clamp(1 - cdf, 0, 1);
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, " ").trim();
function sideOf(team: string, home: string, away: string): "home" | "away" | null {
  const t = normName(team), h = normName(home), a = normName(away);
  if (t && (t === h || h.includes(t) || t.includes(h))) return "home";
  if (t && (t === a || a.includes(t) || t.includes(a))) return "away";
  return null;
}

export interface LiveAdjInput {
  home: string; away: string;
  scoreHome: number | null; scoreAway: number | null;
  minute: number | null;
  core: { xg_home: number; xg_away: number; home_share_1h: number; away_share_1h: number };
}

/** Game-state-adjusted live probability for a MELTING-OPTION market — team Over 0.5/1.5
 *  and BTTS-Yes — or null for any other market (Under/No/directional/totals are out of
 *  scope: winsOnEventOccurrence governs the exit side; this governs only the melting Over/
 *  BTTS-Yes prob fed to the strategist). Already-resolved legs return 1.0. */
export function liveAdjustedProb(label: string, inp: LiveAdjInput, cfg: LiveProbConfig): { prob: number; note: string } | null {
  if (inp.minute == null || inp.scoreHome == null || inp.scoreAway == null) return null;
  const sh = inp.scoreHome, sa = inp.scoreAway;
  const probSide = (side: "home" | "away", goalsNeededTotal: number): { prob: number; lam: number; goals: number } => {
    const already = side === "home" ? sh : sa;
    const need = goalsNeededTotal - already;
    if (need <= 0) return { prob: 1, lam: 0, goals: already };
    const r = liveScoreProb({
      teamXgFull: side === "home" ? inp.core.xg_home : inp.core.xg_away,
      teamShare1h: side === "home" ? inp.core.home_share_1h : inp.core.away_share_1h,
      minute: inp.minute!,
      scoreDiff: side === "home" ? sh - sa : sa - sh,
    }, cfg);
    return { prob: need === 1 ? r.prob : poissonAtLeast(need, r.lambdaRemaining), lam: r.lambdaRemaining, goals: already };
  };

  // Team Over N.5 — "<Team> Over 0.5" / "Over 1.5"
  const om = label.match(/^(.*?)\s+over\s+(\d)\.5\b/i);
  if (om) {
    const side = sideOf(om[1], inp.home, inp.away);
    if (!side) return null;
    const r = probSide(side, Number(om[2]) + 1); // Over 0.5 → ≥1, Over 1.5 → ≥2
    return { prob: r.prob, note: `game-state: ${side === "home" ? inp.home : inp.away} забито ${r.goals}, λ_ост ${r.lam.toFixed(2)} → P≥${Number(om[2]) + 1}` };
  }
  // BTTS — Yes only (a melting option; "No" loses on the event → out of scope)
  if (/(both teams to score|btts)\b.*\byes\b/i.test(label)) {
    const H = probSide("home", 1), A = probSide("away", 1);
    return { prob: clamp(H.prob * A.prob, 0, 1), note: `game-state BTTS: P(дом≥1)=${H.prob.toFixed(2)}×P(гости≥1)=${A.prob.toFixed(2)}` };
  }
  return null;
}
