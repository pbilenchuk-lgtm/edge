// ============================================================
// EDGE LAB — order-book execution model.
//
// A prediction-market quote ("Under 2.5 = 46.8¢") is only the price for the FIRST
// unit at the top of the book. A real order eats liquidity up the book, so the
// average fill (VWAP) is worse than the quote — that's SLIPPAGE. A big order also
// MOVES the price, collapsing the very edge you traded on (MARKET IMPACT). On thin
// books ($600–5k vs $2.5M on majors) a large stake destroys its own edge.
//
// This module models both from the real CLOB book (pure functions — the network
// fetch lives in polymarket.ts). Sizes are in SHARES (each resolves to $1 if YES),
// prices in cents (0..100 == probability). USD notional = shares × price/100.
// ============================================================

export interface BookLevel { priceCents: number; size: number } // size = shares
/** bids sorted DESC by price (best first), asks ASC by price (best first). */
export interface OrderBook { bids: BookLevel[]; asks: BookLevel[] }

export interface BuyFill {
  shares: number;          // shares acquired
  avgPriceCents: number;   // VWAP of the fill — the REAL entry price
  worstPriceCents: number; // deepest level touched
  newTopCents: number;     // best ask AFTER the fill (market impact)
  filledUsd: number;       // notional actually spent
  unfilledUsd: number;     // notional the book couldn't absorb
}

export interface SellFill {
  usd: number;             // proceeds
  avgPriceCents: number;   // VWAP of the fill — the REAL exit price
  newTopCents: number;     // best bid AFTER the fill
  filledShares: number;
  unfilledShares: number;
}

/** Buy `usd` worth by taking asks cheapest-first. Empty book → zero fill. */
export function simulateBuy(asks: BookLevel[], usd: number): BuyFill {
  const best = asks[0]?.priceCents ?? 0;
  if (!(usd > 0) || !asks.length) {
    return { shares: 0, avgPriceCents: best, worstPriceCents: best, newTopCents: best, filledUsd: 0, unfilledUsd: Math.max(0, usd) };
  }
  let remaining = usd, shares = 0, cost = 0, worst = best, newTop = best;
  for (const lvl of asks) {
    if (remaining <= 1e-9) break;
    const priceD = lvl.priceCents / 100;
    if (priceD <= 0) continue;
    const levelUsd = lvl.size * priceD;
    const take = Math.min(remaining, levelUsd);
    shares += take / priceD;
    cost += take;
    remaining -= take;
    worst = lvl.priceCents;
    // If this level wasn't fully consumed, it remains the new best ask; otherwise
    // the next untouched level (approximated by the last touched) is the new top.
    newTop = lvl.priceCents;
  }
  const avg = shares > 0 ? (cost / shares) * 100 : best;
  return {
    shares, avgPriceCents: round1(avg), worstPriceCents: worst, newTopCents: newTop,
    filledUsd: round2(usd - remaining), unfilledUsd: round2(Math.max(0, remaining)),
  };
}

/** Sell `shares` by hitting bids highest-first. Empty book → zero fill. */
export function simulateSell(bids: BookLevel[], shares: number): SellFill {
  const best = bids[0]?.priceCents ?? 0;
  if (!(shares > 0) || !bids.length) {
    return { usd: 0, avgPriceCents: best, newTopCents: best, filledShares: 0, unfilledShares: Math.max(0, shares) };
  }
  let remaining = shares, sold = 0, usd = 0, newTop = best;
  for (const lvl of bids) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, lvl.size);
    sold += take;
    usd += take * (lvl.priceCents / 100);
    remaining -= take;
    newTop = lvl.priceCents;
  }
  const avg = sold > 0 ? (usd / sold) * 100 : best;
  return {
    usd: round2(usd), avgPriceCents: round1(avg), newTopCents: newTop,
    filledShares: sold, unfilledShares: Math.max(0, remaining),
  };
}

export interface DepthCapOpts {
  /** minimum edge (cents) each bought share must individually keep vs fair value */
  edgeFloorCents: number;
  /** max the price may move above the best ask while filling (impact cap) */
  maxImpactCents: number;
}

/**
 * Max USD to buy under the "both" policy: every share taken must (a) still carry
 * edge — its price ≤ fair − edgeFloor — AND (b) not move the price more than
 * maxImpact above the best ask. Both are marginal price ceilings, so the cap is a
 * single price ceiling = min of the two; sum the notional of every ask at or below
 * it. Returns 0 when even the best ask has no edge (never buy into negative edge).
 */
export function maxExecutableBuyUsd(asks: BookLevel[], fairCents: number, opts: DepthCapOpts): number {
  if (!asks.length) return 0;
  const best = asks[0].priceCents;
  const capCents = Math.min(fairCents - opts.edgeFloorCents, best + opts.maxImpactCents);
  let usd = 0;
  for (const lvl of asks) {
    if (lvl.priceCents > capCents + 1e-9) break; // asks are ascending — done
    usd += lvl.size * (lvl.priceCents / 100);
  }
  return round2(usd);
}

/**
 * Parametric fallback when the real book is unavailable (dead/near-resolved token
 * or a fetch error): approximate the VWAP as the quote plus a linear impact that
 * grows with the order's size relative to the market's liquidity. Deliberately
 * conservative — we never assume free liquidity. k is cents of slippage when the
 * order equals the whole liquidity pool.
 */
export function parametricBuyAvgCents(quoteCents: number, notionalUsd: number, liquidityUsd: number, k: number): number {
  const f = liquidityUsd > 0 ? notionalUsd / liquidityUsd : 1;
  return round1(Math.min(99, quoteCents + k * f));
}
export function parametricSellAvgCents(quoteCents: number, notionalUsd: number, liquidityUsd: number, k: number): number {
  const f = liquidityUsd > 0 ? notionalUsd / liquidityUsd : 1;
  return round1(Math.max(1, quoteCents - k * f));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
