import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateBuy, simulateSell, maxExecutableBuyUsd, parametricBuyAvgCents, parametricSellAvgCents } from "../src/lib/execution.js";

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

test("maxExecutableBuyUsd: 'both' cap = min(edge-preserving, impact-bounded)", () => {
  // fair 52¢, edge floor 1.5¢ → edge ceiling 50.5¢; impact 2¢ over best 46.8 → 48.8¢.
  // cap = min(50.5, 48.8) = 48.8¢ → include 46.8 + 47.5 + 48.0, exclude 55.
  const cap = maxExecutableBuyUsd(asks, 52, { edgeFloorCents: 1.5, maxImpactCents: 2 });
  const want = 200 * 0.468 + 300 * 0.475 + 500 * 0.48;
  assert.equal(Math.round(cap), Math.round(want));
});

test("maxExecutableBuyUsd: edge ceiling binds when it's tighter than impact", () => {
  // fair 48¢, floor 1.5 → edge ceiling 46.5¢ (below best ask 46.8) → nothing qualifies.
  assert.equal(maxExecutableBuyUsd(asks, 48, { edgeFloorCents: 1.5, maxImpactCents: 10 }), 0);
  // fair 48.5, floor 1.5 → ceiling 47.0 → only the 46.8 level.
  const cap = maxExecutableBuyUsd(asks, 48.5, { edgeFloorCents: 1.5, maxImpactCents: 10 });
  assert.equal(Math.round(cap), Math.round(200 * 0.468));
});

test("parametric fallback: slippage scales with order/liquidity, bounded", () => {
  // order = 10% of liquidity, k=4 → +0.4¢ on a buy, −0.4¢ on a sell.
  assert.equal(parametricBuyAvgCents(46.8, 100, 1000, 4), 47.2);
  assert.equal(parametricSellAvgCents(46.8, 100, 1000, 4), 46.4);
  // order == full liquidity → full k; clamped to [1,99].
  assert.equal(parametricBuyAvgCents(97, 1000, 1000, 4), 99);
});
