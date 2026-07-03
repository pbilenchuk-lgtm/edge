// ============================================================
// EDGE LAB — edge & price helpers (ТЗ §2.10)
//
// Prediction-market convention: price is in cents 0..100, which equals
// the market-implied probability * 100. The AI gives its own probability
// (0..1). Edge is the gap between them, in percentage points.
// ============================================================

/** Market-implied probability (0..1) from a price in cents. */
export function impliedProb(priceCents: number): number {
  return priceCents / 100;
}

/**
 * Edge in percentage points: (ai_prob − price/100) * 100.
 * Positive = the AI thinks the outcome is underpriced by the market.
 */
export function edgePct(aiProb: number, priceCents: number): number {
  return (aiProb - priceCents / 100) * 100;
}

/** Decimal odds implied by a cents price (1 / probability). */
export function decimalOdds(priceCents: number): number {
  const p = priceCents / 100;
  return p > 0 ? 1 / p : Infinity;
}
