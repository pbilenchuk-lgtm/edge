// ============================================================
// EDGE LAB — PREMATCH STRATEGIST core (Окно 3, code side)  [SERVER-ONLY]
//
// Money math is CODE, not the LLM (orchestration doc, module #3):
//   1) clean the vig from the market quotes (two-sided groups → implied probs),
//   2) edge = our_prob − market_implied (de-vigged),
//   3) safeguards on the cleaned prices (absurd edge, prob-sum drift),
//   4) apply the assigned risk PROFILE's thresholds (min_edge / min_calibration /
//      min_market_liquidity), and
//   5) size via fractional Kelly scaled by calibration, clamped, and capped by
//      max_position_pct / max_match_exposure_pct.
// The strategist LLM only writes the PLAN; every number here is validated
// against risk_config. Pure functions — no DB, easy to test in isolation.
// ============================================================

import type { RiskConfig } from "./riskConfig.js";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The complementary market label for de-vigging a two-sided group, or null.
 * Handles the common football-derived pairs: Over N ⇄ Under N (totals, halves,
 * team totals) and "… — Yes" ⇄ "… — No" (BTTS etc.). One-sided markets (a lone
 * "Team to Advance", a handicap) have no sibling → priced raw.
 */
// Strip a trailing "yes"/"no" (with any separator/spacing) → the group stem, so
// two sides of a Yes/No market normalise to the SAME key regardless of how each
// is formatted ("BTTS - Yes" and "BTTS No" both → "btts"). Symmetric de-vig.
const yesNoSide = (n: string): "yes" | "no" | null => { const m = n.match(/\b(yes|no)\s*$/); return m ? (m[1] as "yes" | "no") : null; };
const yesNoStem = (n: string): string => n.replace(/\s*(—|-)?\s*(yes|no)\s*$/, "").trim();
export function siblingLabel(label: string, labels: string[]): string | null {
  const n = norm(label);
  const find = (target: string) => labels.find((l) => l !== label && norm(l) === target) ?? null;
  let m = n.match(/^(.*?)\bover\b(.*)$/);
  if (m) { const hit = find(`${m[1]}under${m[2]}`.replace(/\s+/g, " ").trim()); if (hit) return hit; }
  m = n.match(/^(.*?)\bunder\b(.*)$/);
  if (m) { const hit = find(`${m[1]}over${m[2]}`.replace(/\s+/g, " ").trim()); if (hit) return hit; }
  // Yes/No: match on the group stem + opposite side, so de-vig is symmetric and
  // works even when the two sides are dash-formatted differently.
  const side = yesNoSide(n);
  if (side) {
    const stem = yesNoStem(n), want = side === "yes" ? "no" : "yes";
    const hit = labels.find((l) => { if (l === label) return false; const nl = norm(l); return yesNoSide(nl) === want && yesNoStem(nl) === stem; });
    if (hit) return hit;
  }
  return null;
}

export interface MarketQuote { label: string; priceCents: number; liquidity?: number | null }
export interface ImpliedInfo { implied: number; groupSum: number | null; sided: boolean }

/**
 * De-vigged implied probability per market. For a two-sided pair we normalise the
 * group to sum 1 (implied = p / (p + p_sibling)); for a one-sided market we fall
 * back to the raw price/100 (best available). `groupSum` is the raw pre-normalise
 * sum (for the prob-sum safeguard); `sided` marks whether de-vig was applied.
 */
export function impliedProbs(markets: MarketQuote[]): Map<string, ImpliedInfo> {
  const labels = markets.map((m) => m.label);
  const priceOf = new Map(markets.map((m) => [m.label, m.priceCents]));
  const out = new Map<string, ImpliedInfo>();
  for (const m of markets) {
    const p = m.priceCents / 100;
    const sib = siblingLabel(m.label, labels);
    if (sib != null && priceOf.has(sib)) {
      const ps = (priceOf.get(sib) as number) / 100;
      const sum = p + ps;
      out.set(m.label, { implied: sum > 0 ? p / sum : p, groupSum: sum, sided: true });
    } else {
      out.set(m.label, { implied: p, groupSum: null, sided: false });
    }
  }
  return out;
}

export type SizeStatus = "enter" | "skip" | "flag";
export interface SizeResult {
  status: SizeStatus;
  stake: number;         // $ (0 unless status==="enter")
  fraction: number;      // fraction of the pair budget
  edge: number;          // our_prob − implied (de-vigged), as a fraction
  implied: number;
  kellyFraction: number; // the calibration-scaled, clamped Kelly fraction used
  reason: string;
}

export interface SizeInput {
  ourProb: number;         // model probability the market resolves YES
  priceCents: number;      // actual buy price (with vig) — Kelly pays this
  implied: number;         // de-vigged implied prob (for the edge gate)
  calibration: number;     // analysis xg_confidence, 0..1
  liquidity?: number | null;
  budget: number;          // the (strategy, profile) pair's $ budget
  matchExposure?: number;  // $ already committed by this pair ON THIS MATCH
  compExposure?: number;   // $ already committed by this pair across the comp
  cfg: RiskConfig;
  /** LIVE: skip the absurd_edge_block flag. In-play a huge edge is REAL, not a
   *  data bug — a resolved market (Over 1.5 at 0:2 ≈ 98%) legitimately sits far
   *  from a lagging book; that gap IS the strategist's alpha. Default false. */
  allowLargeEdge?: boolean;
}

/**
 * Deterministically decide entry + size for ONE market against a risk profile.
 * The whole point of profiles: aggressive enters a smaller edge and stakes more,
 * conservative the opposite — all from cfg, no per-strategy params.
 */
export function sizePrematch(inp: SizeInput): SizeResult {
  const { ourProb, priceCents, implied, calibration, budget, cfg } = inp;
  const p = priceCents / 100;
  const edge = ourProb - implied;
  const matchExposure = inp.matchExposure ?? 0;
  const compExposure = inp.compExposure ?? 0;
  const base: Omit<SizeResult, "status" | "stake" | "fraction" | "reason"> = { edge, implied, kellyFraction: 0 };
  const skip = (reason: string): SizeResult => ({ status: "skip", stake: 0, fraction: 0, reason, ...base });
  const flag = (reason: string): SizeResult => ({ status: "flag", stake: 0, fraction: 0, reason, ...base });

  if (!Number.isFinite(ourProb) || ourProb < 0 || ourProb > 1 || !Number.isFinite(p) || p <= 0 || p >= 1) return skip("некорректная цена/вероятность");
  if (budget <= 0) return skip("нет бюджета пары");

  // Safeguard: an edge above absurd_edge_block is almost surely a bug (bad quote /
  // wrong market), not value — flag, do NOT trade. Skipped in live (allowLargeEdge)
  // where a resolved-market edge is genuine.
  if (!inp.allowLargeEdge && edge > cfg.safeguards.absurd_edge_block) return flag(`edge ${(edge * 100).toFixed(1)}% > absurd_edge_block ${(cfg.safeguards.absurd_edge_block * 100).toFixed(0)}% — вероятно баг`);

  // Thresholds (profile). Thin markets use the raised min_edge. UNKNOWN depth
  // (liquidity null — we couldn't read it) is treated as thin: an unmeasurable
  // book is a reason for caution, not for the easier bar.
  const thin = inp.liquidity == null || inp.liquidity < cfg.entry_thresholds.min_market_liquidity;
  const minEdge = thin ? cfg.entry_thresholds.min_edge_low_liquidity : cfg.entry_thresholds.min_edge;
  if (calibration < cfg.entry_thresholds.min_calibration) return skip(`калибровка ${calibration.toFixed(2)} < ${cfg.entry_thresholds.min_calibration}`);
  if (edge < minEdge) return skip(`edge ${(edge * 100).toFixed(1)}% < порога ${(minEdge * 100).toFixed(1)}%${thin ? " (тонкий рынок)" : ""}`);

  // Fractional Kelly for buying a binary at price p with model prob q:
  //   f_kelly = (q − p) / (1 − p),  scaled by the profile's Kelly fraction.
  // We deliberately do NOT scale the stake by the analysis xg_confidence: that
  // self-reported number is not a calibrated probability (LLM confidence clusters
  // ~0.5 and defaults to 0.5 when absent), so multiplying every stake by it adds
  // NOISE dressed up as risk management — distorting both the sizes and the later
  // interpretation of test results. Size on the real edge only; the profile's
  // kelly_fraction_base is the risk dial. (calibration still acts as a hard ENTRY
  // gate below via min_calibration; it just no longer modulates size.)
  const kFrac = clamp(cfg.sizing.kelly_fraction_base, cfg.sizing.kelly_fraction_clamp[0], cfg.sizing.kelly_fraction_clamp[1]);
  const kellyEdge = (ourProb - p) / (1 - p);
  if (kellyEdge <= 0) return skip("Kelly-край по фактической цене ≤ 0");
  let fraction = kFrac * kellyEdge;

  // Hard per-position cap (% of the pair budget).
  fraction = Math.min(fraction, cfg.sizing.max_position_pct);
  // Correlation cap: total staked on THIS match by this pair ≤ max_match_exposure_pct.
  const matchRoom = Math.max(0, cfg.sizing.max_match_exposure_pct * budget - matchExposure);
  // Budget room across the whole comp (existing §9.3 invariant).
  const compRoom = Math.max(0, budget - compExposure);
  const capped = Math.min(fraction * budget, matchRoom, compRoom);
  if (capped <= 0) {
    if (matchRoom <= 0) return skip("исчерпан кэп экспозиции на матч");
    return skip("бюджет пары исчерпан");
  }
  // FLOOR (not round): a binding cap (max_position_pct / max_match_exposure_pct /
  // budget) must never be exceeded, not even by the ≤$0.50 that Math.round(x.5) adds.
  const stake = Math.floor(capped);
  if (stake <= 0) return skip("размер округлился до нуля");

  return { status: "enter", stake, fraction: stake / budget, edge, implied, kellyFraction: kFrac, reason: `вход: edge ${(edge * 100).toFixed(1)}%, Kelly×${kFrac.toFixed(2)}, ${(stake / budget * 100).toFixed(1)}% бюджета` };
}

/** Prob-sum integrity per de-vigged group: a raw two-sided sum that drifts beyond
 *  1 ± tolerance is suspicious (bad/stale quote) — the caller flags those markets.
 *  Returns the set of labels whose group sum is out of tolerance. */
export function probSumFlags(markets: MarketQuote[], cfg: RiskConfig): Set<string> {
  const implied = impliedProbs(markets);
  const bad = new Set<string>();
  const tol = cfg.safeguards.prob_sum_tolerance;
  for (const [label, info] of implied) {
    if (info.sided && info.groupSum != null && Math.abs(info.groupSum - 1) > tol + 1e-9) bad.add(label);
  }
  return bad;
}

function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
