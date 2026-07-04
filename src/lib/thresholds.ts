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
import { decimalOdds, edgePct as calcEdge } from "./edge.js";

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
  confidence?: Confidence | null;
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

  // Respect remaining budget for this match (invariant §9.3).
  const remainingFrac = Math.max(0, (budget - exposure) / budget);
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
    // Simplified Kelly the prompts describe: k * edge / (decimalOdds - 1).
    const b = decimalOdds(priceCents) - 1;
    if (!isFinite(b) || b <= 0) return 0;
    const edgeFrac = aiProb - priceCents / 100;
    return Math.max(0, (params.kellyFraction * edgeFrac) / b);
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
