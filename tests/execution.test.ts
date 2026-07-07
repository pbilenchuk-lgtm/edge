import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateBuy, simulateSell, maxExecutableBuyUsd, parametricBuyAvgCents, parametricSellAvgCents, takerFeeCents, liquidationCents } from "../src/lib/execution.js";

// asks ascending by price; each level: priceCents × size(shares).
const asks = [
  { priceCents: 46.8, size: 200 },  // $93.6 available at 46.8¢
  { priceCents: 47.5, size: 300 },  // $142.5 at 47.5¢
  { priceCents: 48.0, size: 500 },  // $240 at 48¢
  { priceCents: 55.0, size: 1000 }, // deep but far from top
];

test("simulateBuy: fills within the top level at the quote (no slippage)", () => {
  const f = simulateBuy(asks, 50); // < $93.6 available at the top
  assert.equal(f.avgPriceCents, 46.8, "all filled at the best ask");
  assert.equal(Math.round(f.shares), Math.round(50 / 0.468));
  assert.equal(f.unfilledUsd, 0);
});

test("simulateBuy: walks up the book → VWAP worse than the quote (slippage)", () => {
  const f = simulateBuy(asks, 200); // eats 46.8 fully ($93.6) + part of 47.5
  assert.ok(f.avgPriceCents > 46.8 && f.avgPriceCents < 47.5, `VWAP ${f.avgPriceCents} between levels`);
  assert.equal(f.worstPriceCents, 47.5);
  assert.equal(f.newTopCents, 47.5, "price moved up to 47.5¢");
  assert.equal(f.filledUsd, 200);
});

test("simulateBuy: book too thin → partial fill, unfilled reported", () => {
  const thin = [{ priceCents: 46.8, size: 100 }]; // only $46.8 available
  const f = simulateBuy(thin, 500);
  assert.equal(f.filledUsd, 46.8);
  assert.equal(f.unfilledUsd, 453.2);
});

test("simulateSell: hits bids high-first → VWAP below the top bid", () => {
  const bids = [{ priceCents: 46, size: 100 }, { priceCents: 45, size: 100 }, { priceCents: 40, size: 100 }];
  const f = simulateSell(bids, 150); // 100 @46 + 50 @45
  assert.ok(f.avgPriceCents < 46 && f.avgPriceCents > 45);
  assert.equal(f.newTopCents, 45, "sold down to the 45¢ bid");
  assert.equal(f.filledShares, 150);
});

test("maxExecutableBuyUsd: 'both' cap = min(edge-preserving, impact-bounded) — no fee", () => {
  // fair 52¢, edge floor 1.5¢ → edge ceiling 50.5¢; impact 2¢ over best 46.8 → 48.8¢.
  // cap = min(50.5, 48.8) = 48.8¢ → include 46.8 + 47.5 + 48.0, exclude 55.
  const cap = maxExecutableBuyUsd(asks, 52, { edgeFloorCents: 1.5, maxImpactCents: 2, feeRate: 0 });
  const want = 200 * 0.468 + 300 * 0.475 + 500 * 0.48;
  assert.equal(Math.round(cap), Math.round(want));
});

test("maxExecutableBuyUsd: edge ceiling binds when it's tighter than impact — no fee", () => {
  // fair 48¢, floor 1.5 → edge ceiling 46.5¢ (below best ask 46.8) → nothing qualifies.
  assert.equal(maxExecutableBuyUsd(asks, 48, { edgeFloorCents: 1.5, maxImpactCents: 10, feeRate: 0 }), 0);
  // fair 48.5, floor 1.5 → ceiling 47.0 → only the 46.8 level.
  const cap = maxExecutableBuyUsd(asks, 48.5, { edgeFloorCents: 1.5, maxImpactCents: 10, feeRate: 0 });
  assert.equal(Math.round(cap), Math.round(200 * 0.468));
});

test("maxExecutableBuyUsd: round-trip fee tightens the edge ceiling", () => {
  // fair 49.5¢, floor 1.5 → gross ceiling 48.0¢ would include 46.8+47.5 with no fee.
  // With fee 0.03 the round-trip cost (~1¢/share near 47¢) pushes 47.5¢ over the net
  // ceiling, so only the 46.8¢ level (rtFee ~1.5¢ → 48.3 > 48? check) survives — the
  // point: the qualifying depth SHRINKS versus the fee-free case.
  const withFee = maxExecutableBuyUsd(asks, 49.5, { edgeFloorCents: 1.5, maxImpactCents: 10, feeRate: 0.03 });
  const noFee = maxExecutableBuyUsd(asks, 49.5, { edgeFloorCents: 1.5, maxImpactCents: 10, feeRate: 0 });
  assert.ok(withFee < noFee, `fee-aware cap ($${withFee}) tighter than fee-free ($${noFee})`);
});

test("takerFeeCents: Polymarket sports taker fee — peaks at 50¢, symmetric, 0.75¢ max", () => {
  assert.equal(takerFeeCents(50, 0.03), 0.75, "peak $0.75 per 100 shares at 50¢");
  assert.equal(takerFeeCents(30, 0.03), takerFeeCents(70, 0.03), "symmetric around 50¢");
  assert.equal(takerFeeCents(30, 0.03), 0.63, "0.03·30·70/100");
  assert.ok(takerFeeCents(99, 0.03) < 0.05 && takerFeeCents(1, 0.03) < 0.05, "tiny near the extremes");
});

test("liquidationCents: open positions marked below mid (exit haircut + fee)", () => {
  // thin book: order = 20% of liquidity → sell haircut 0.8¢, minus fee(~49.2¢).
  const liq = liquidationCents(50, 200, 1000, 4, 0.03);
  assert.ok(liq < 50, `below the 50¢ mid, got ${liq}`);
  // deep book: negligible slippage, only the fee → just under the mid.
  const deep = liquidationCents(50, 10, 1_000_000, 4, 0.03);
  assert.ok(deep < 50 && deep > 49, `deep book ≈ mid − fee, got ${deep}`);
});

test("parametric fallback: slippage scales with order/liquidity, bounded", () => {
  // order = 10% of liquidity, k=4 → +0.4¢ on a buy, −0.4¢ on a sell.
  assert.equal(parametricBuyAvgCents(46.8, 100, 1000, 4), 47.2);
  assert.equal(parametricSellAvgCents(46.8, 100, 1000, 4), 46.4);
  // order == full liquidity → full k; clamped to [1,99].
  assert.equal(parametricBuyAvgCents(97, 1000, 1000, 4), 99);
});
