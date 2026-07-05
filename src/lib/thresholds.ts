// ============================================================
// EDGE LAB — thresholds: prompt (words) -> params (numbers) -> sizing
// (ТЗ §3.2, invariant §9.6: bet ARITHMETIC is done by code, not the LLM)
//
// A strategy is described by one natural-language prompt. The engine
// extracts numeric thresholds into `params`. ТЗ recommends a structured
// LLM extraction with validation over regexes; we provide BOTH:
//   - extractThresholdsHeuristic(): dependency-free regex baseline / fallback
//   - extractThresholds(prompt, llmExtract?): uses the LLM when available,
//     always validated before use.
// The actual bet size is then computed here, in code.
// ============================================================

import type { Confidence, StrategyParams } from "./types.js";
import { edgePct as calcEdge } from "./edge.js";

const CONFIDENCE_RANK: Record<string, number> = {
  низкая: 1,
  средняя: 2,
  высокая: 3,
  low: 1,
  medium: 2,
  high: 3,
};

export function confidenceRank(c?: string | null): number {
  return c ? CONFIDENCE_RANK[c] ?? 0 : 0;
}

/**
 * Normalize a minConfidence value to a canonical band the ranker understands.
 * The LLM extractor may return a WORD ('высокая') or a NUMBER (0..1); a raw
 * number would score 0 in confidenceRank and silently disable the gate, so map
 * numbers to bands and drop anything unrecognized.
 */
export function normalizeConfidence(v: unknown): Confidence | undefined {
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    if (CONFIDENCE_RANK[s]) return (s === "low" ? "низкая" : s === "medium" ? "средняя" : s === "high" ? "высокая" : s) as Confidence;
    return undefined;
  }
  if (typeof v === "number" && isFinite(v)) {
    const x = v > 1 ? v / 100 : v; // tolerate 0..1 or 0..100
    if (x >= 0.66) return "высокая";
    if (x >= 0.34) return "средняя";
    if (x > 0) return "низкая";
  }
  return undefined;
}

// ------------------------------------------------------------
// Extraction
// ------------------------------------------------------------

/** Regex baseline. Handles the vocabulary used across the seed prompts. */
export function extractThresholdsHeuristic(prompt: string): StrategyParams {
  const p: StrategyParams = {};
  const s = prompt.toLowerCase();

  const maxBet = s.match(/не более (\d+(?:[.,]\d+)?)\s*%/);
  if (maxBet) p.maxPerBet = num(maxBet[1]) / 100;

  const stop = s.match(/стоп[^0-9-]*(-?\d+(?:[.,]\d+)?)\s*%/);
  if (stop) p.stop = -Math.abs(num(stop[1])) / 100;

  const minEdge = s.match(/edge\s*>?=?\s*(\d+(?:[.,]\d+)?)\s*%/);
  if (minEdge) p.minEdge = num(minEdge[1]);

  const flat = s.match(/размер\s*(?:всегда\s*)?(\d+(?:[.,]\d+)?)\s*%/);
  if (flat) p.flatSize = num(flat[1]) / 100;

  const kelly = s.match(/(\d+(?:[.,]\d+)?)\s*\*?\s*kelly|kelly|келли|(\d+[.,]\d+)\s*\*\s*edge/);
  if (kelly) {
    const frac = s.match(/(\d+[.,]\d+)\s*\*/);
    p.kellyFraction = frac ? num(frac[1]) : 0.5;
    const cap = s.match(/максимум\s*(\d+(?:[.,]\d+)?)\s*%/);
    if (cap) p.cap = num(cap[1]) / 100;
  }

  // Ladder: "edge>=10% -> 20%; 7-10% -> 15%; 5-7% -> 10%; 3-5% -> 5%".
  // For a range like "7-10%", the LOWER bound (7) is the tier threshold.
  const tierMatches = [...s.matchAll(/(\d+)(?:\s*-\s*\d+)?\s*%?\s*->\s*(\d+)\s*%/g)];
  if (tierMatches.length >= 2) {
    p.tiers = tierMatches
      .map(([, e, sz]) => [num(e), num(sz) / 100] as [number, number])
      .sort((a, b) => b[0] - a[0]);
    // The lowest tier IS the effective entry threshold — override any minEdge
    // wrongly captured from the ladder text (e.g. "edge>=10%" inside a tier).
    p.minEdge = p.tiers[p.tiers.length - 1][0];
  }

  if (/только при[^.]*высок|«высокая»|высокой уверенност/.test(s)) {
    p.minConfidence = "высокая";
  }

  if (Object.keys(p).length === 0) p.note = "пороги не распознаны";
  return validateParams(p);
}

/**
 * Preferred path: structured extraction via the LLM, validated.
 * `llmExtract` returns a params object (or throws). On any failure we fall
 * back to the heuristic so the system never blocks on a bad LLM response
 * (ТЗ §6: "Невалидный вывод LLM ... не сохранять мусор").
 */
export async function extractThresholds(
  prompt: string,
  llmExtract?: (prompt: string) => Promise<unknown>,
): Promise<StrategyParams> {
  if (!llmExtract) return extractThresholdsHeuristic(prompt);
  try {
    const raw = await llmExtract(prompt);
    const validated = validateParams(raw as StrategyParams);
    // If the LLM returned effectively nothing usable, prefer the heuristic.
    if (Object.keys(validated).length === 0 || validated.note) {
      return extractThresholdsHeuristic(prompt);
    }
    return validated;
  } catch {
    return extractThresholdsHeuristic(prompt);
  }
}

/** Clamp/sanity-check params. Drops nonsense; never throws. */
export function validateParams(raw: StrategyParams): StrategyParams {
  const p: StrategyParams = {};
  // Fraction fields: keep any positive number, clamped to [0,1].
  if (isPos(raw.maxPerBet)) p.maxPerBet = clamp(raw.maxPerBet!, 0, 1);
  // Portfolio stop-loss as a drawdown fraction. Accept BOTH sign conventions:
  // the heuristic emits it negative (-0.25), the LLM extractor is told 0..1 and
  // emits it positive (0.2). Store canonically as a negative fraction so a
  // plainly-stated stop-loss is never silently dropped on the LLM path.
  if (typeof raw.stop === "number" && raw.stop !== 0 && Math.abs(raw.stop) <= 1)
    p.stop = -Math.abs(raw.stop);
  if (typeof raw.edgeExit === "boolean") p.edgeExit = raw.edgeExit;
  if (typeof raw.minEdge === "number" && raw.minEdge >= 0 && raw.minEdge <= 100)
    p.minEdge = raw.minEdge;
  if (isPos(raw.flatSize)) p.flatSize = clamp(raw.flatSize!, 0, 1);
  if (typeof raw.kellyFraction === "number" && raw.kellyFraction > 0 && raw.kellyFraction <= 5)
    p.kellyFraction = raw.kellyFraction;
  if (isPos(raw.cap)) p.cap = clamp(raw.cap!, 0, 1);
  if (Array.isArray(raw.tiers)) {
    const tiers = raw.tiers
      .filter(
        (t) =>
          Array.isArray(t) &&
          typeof t[0] === "number" &&
          typeof t[1] === "number",
      )
      .map(([e, f]) => [e, clamp(f, 0, 1)] as [number, number])
      .sort((a, b) => b[0] - a[0]);
    if (tiers.length) p.tiers = tiers;
  }
  if (raw.minConfidence != null) {
    const mc = normalizeConfidence(raw.minConfidence);
    if (mc) p.minConfidence = mc;
  }
  if (isPos(raw.takeProfit)) p.takeProfit = clamp(raw.takeProfit!, 0, 10);
  if (isPos(raw.exitStop)) p.exitStop = clamp(raw.exitStop!, 0, 1);
  if (Object.keys(p).length === 0) p.note = raw.note ?? "пороги не распознаны";
  return p;
}

// ------------------------------------------------------------
// Sizing — the arithmetic the LLM must NOT do (invariant §9.6)
// ------------------------------------------------------------

export interface SizeInput {
  params: StrategyParams;
  aiProb: number;
  priceCents: number;
  budget: number;
  /** $ already staked by this strategy on this match (for §9.3). */
  exposure?: number;
  /** realized P&L ($) this strategy has already booked on this match — a loss
   *  shrinks what's left to deploy, so cashing out at a loss and re-entering
   *  can't recycle the whole budget again (bankroll = budget + realized). */
  realizedPnl?: number;
  confidence?: Confidence | null;
  /** current P&L fraction of the strategy on the competition (negative = drawdown),
   *  used to enforce params.stop — halt entries once the stop-loss is hit. */
  drawdown?: number;
}

export interface SizeDecision {
  enter: boolean;
  /** fraction of budget for this bet (0 if skipping) */
  fraction: number;
  /** $ stake, rounded, already clamped to remaining budget */
  stake: number;
  edge: number;
  reason: string;
}

/**
 * Decide whether to enter and, if so, how much — deterministically.
 * Returns a skip decision with a human reason for the discipline log
 * (ТЗ §4.2: "Пропуск — валидное событие").
 */
export function sizeBet(input: SizeInput): SizeDecision {
  const { params, aiProb, priceCents, budget } = input;
  const exposure = input.exposure ?? 0;
  const edge = calcEdge(aiProb, priceCents);

  const skip = (reason: string): SizeDecision => ({
    enter: false,
    fraction: 0,
    stake: 0,
    edge,
    reason,
  });

  if (budget <= 0) return skip("нет бюджета на турнире");

  // A non-finite / out-of-range model probability makes every `<`/`<=` gate
  // below evaluate false (NaN comparisons are false), so it would fail OPEN and
  // return a NaN stake. Reject it up front.
  if (!Number.isFinite(aiProb) || aiProb < 0 || aiProb > 1 || !Number.isFinite(edge)) {
    return skip("некорректная вероятность модели");
  }

  // Portfolio stop-loss (§ risk control): once the strategy's drawdown on this
  // competition reaches the stop, halt ALL new entries until it recovers.
  if (params.stop != null && input.drawdown != null && input.drawdown <= params.stop) {
    return skip(`портфель на стоп-лоссе (${(input.drawdown * 100).toFixed(0)}% ≤ ${(params.stop * 100).toFixed(0)}%) — входы остановлены`);
  }

  if (params.minConfidence != null) {
    if (confidenceRank(input.confidence) < confidenceRank(params.minConfidence)) {
      return skip(
        `уверенность ниже порога (нужна «${params.minConfidence}»)`,
      );
    }
  }

  if (params.minEdge != null && edge < params.minEdge) {
    return skip(
      `край ${edge.toFixed(1)}% ниже порога ${params.minEdge}% — пропуск`,
    );
  }
  if (edge <= 0) return skip(`края нет (${edge.toFixed(1)}%) — пропуск`);

  let fraction = rawFraction(params, edge, aiProb, priceCents);
  if (fraction <= 0) return skip("размер по правилам вышел нулевым — пропуск");

  // Hard cap: max per bet (invariant, from «не более N%»).
  const cap = params.maxPerBet ?? params.cap;
  if (cap != null) fraction = Math.min(fraction, cap);

  // Respect remaining budget for this match (invariant §9.3). Bankroll left =
  // budget + realized P&L − open exposure, so a realized LOSS reduces what can
  // be re-staked (a cash-out-and-re-enter cycle can't recycle the full budget).
  const remainingFrac = Math.max(0, (budget + (input.realizedPnl ?? 0) - exposure) / budget);
  fraction = Math.min(fraction, remainingFrac);
  if (fraction <= 0) return skip("бюджет стратегии на матче исчерпан");

  const stake = Math.round(budget * fraction);
  if (stake <= 0) return skip("размер округлился до нуля — пропуск");

  return {
    enter: true,
    fraction,
    stake,
    edge,
    reason: `вход: край ${edge.toFixed(1)}%, размер ${(fraction * 100).toFixed(1)}% бюджета`,
  };
}

// ------------------------------------------------------------
// Exit — when to close an OPEN paper position (position simulation)
// ------------------------------------------------------------

export interface ExitInput {
  params: StrategyParams;
  aiProb: number;          // model probability the market resolves YES (from the last assessment)
  entryPriceCents: number; // price we bought at
  currentPriceCents: number;
}
export interface ExitDecision { exit: boolean; reason: string; pnlFrac: number }

/** Defaults when the strategy prompt doesn't specify exit rules. */
export const DEFAULT_TAKE_PROFIT = 0.5; // +50% of position value
export const DEFAULT_EXIT_STOP = 0.5;   // −50%

/**
 * Deterministic exit rule (code, not LLM — §9.6). A prediction-market position
 * bought at `entry` is worth stake·(current/entry) if sold now, so P&L% is
 * current/entry − 1. We close on: take-profit, per-position stop, or when the
 * edge that justified the entry is gone (model prob ≤ current price).
 */
export function exitDecision(inp: ExitInput): ExitDecision {
  const { params, aiProb, entryPriceCents, currentPriceCents } = inp;
  const pnlFrac = entryPriceCents > 0 ? currentPriceCents / entryPriceCents - 1 : 0;
  const tp = params.takeProfit ?? DEFAULT_TAKE_PROFIT;
  const sl = params.exitStop ?? DEFAULT_EXIT_STOP;
  if (pnlFrac >= tp) return { exit: true, reason: `тейк-профит +${(pnlFrac * 100).toFixed(0)}%`, pnlFrac };
  if (pnlFrac <= -Math.abs(sl)) return { exit: true, reason: `стоп ${(pnlFrac * 100).toFixed(0)}%`, pnlFrac };
  // "Edge gone" auto-exit is opt-OUT: strategies that manage exits via the
  // strategist (edgeExit:false) skip this so the fast loop doesn't cash out —
  // and re-enter — every tick the model prob dips under the price (in-match churn).
  if (params.edgeExit !== false && aiProb * 100 - currentPriceCents <= 0) return { exit: true, reason: `край исчез (ИИ ${(aiProb * 100).toFixed(0)}% ≤ ${currentPriceCents}¢)`, pnlFrac };
  return { exit: false, reason: "держим", pnlFrac };
}

/** Base fraction before caps, from whichever rule the strategy uses. */
function rawFraction(
  params: StrategyParams,
  edge: number,
  aiProb: number,
  priceCents: number,
): number {
  if (params.tiers && params.tiers.length) {
    for (const [thr, frac] of params.tiers) {
      if (edge >= thr) return frac;
    }
    return 0; // below the lowest tier => no entry
  }
  if (params.kellyFraction != null) {
    // Kelly for buying a binary outcome at price p (prob) with model prob q:
    //   f* = (q − p) / (1 − p)   (edge over the room left above the price),
    // scaled by kellyFraction. (The earlier k·edge/(d−1) form understated the
    // stake by a factor of p and mis-sized high-odds bets.)
    const p = priceCents / 100;
    if (p <= 0 || p >= 1) return 0;
    const edgeFrac = aiProb - p;
    return Math.max(0, (params.kellyFraction * edgeFrac) / (1 - p));
  }
  if (params.flatSize != null) return params.flatSize;
  return 0;
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function num(x: string): number {
  return parseFloat(x.replace(",", "."));
}
function isPos(x: unknown): x is number {
  return typeof x === "number" && x > 0;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
