import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeFillCosts, groupFillCosts } from "../src/lib/fillCosts.js";
import type { FillCostRow } from "../src/lib/repo.js";

const row = (o: Partial<FillCostRow>): FillCostRow => ({
  id: "x", bet_id: "b", match_id: "m", competition_id: "c", strategy_id: "s", profile_id: "medium",
  side: "buy", shares: 100, notional_usd: 50, quote_cents: 47, vwap_cents: 47.3,
  fee_cents: 0.75, fee_usd: 0.75, slip_cents: 0.3, slip_usd: 0.3, from_book: 1, created_at: "t", ...o,
});

test("summarizeFillCosts: sums fees/slippage, splits by side, computes cost % of notional", () => {
  const s = summarizeFillCosts([
    row({ side: "buy", notional_usd: 100, fee_usd: 1, slip_usd: 0.5 }),
    row({ side: "sell", notional_usd: 100, fee_usd: 0.8, slip_usd: 1.2, from_book: 0 }),
  ]);
  assert.equal(s.fills, 2);
  assert.equal(s.buys, 1);
  assert.equal(s.sells, 1);
  assert.equal(s.notionalUsd, 200);
  assert.equal(s.feeUsd, 1.8);
  assert.equal(s.slipUsd, 1.7);
  assert.equal(s.totalUsd, 3.5);
  assert.equal(s.feeBuyUsd, 1);
  assert.equal(s.feeSellUsd, 0.8);
  assert.equal(s.slipSellUsd, 1.2);
  assert.equal(s.costPctOfNotional, 1.75, "3.5/200 = 1.75%");
  assert.equal(s.modelledFills, 1, "the parametric sell is flagged");
});

test("summarizeFillCosts: empty → all zeros, no divide-by-zero", () => {
  const s = summarizeFillCosts([]);
  assert.equal(s.fills, 0);
  assert.equal(s.costPctOfNotional, 0);
  assert.equal(s.avgSlipCents, 0);
});

test("groupFillCosts: buckets by a key with an independent summary each", () => {
  const g = groupFillCosts([
    row({ strategy_id: "A", fee_usd: 1, slip_usd: 0, notional_usd: 50 }),
    row({ strategy_id: "A", fee_usd: 1, slip_usd: 0, notional_usd: 50 }),
    row({ strategy_id: "B", fee_usd: 2, slip_usd: 1, notional_usd: 100 }),
  ], (r) => r.strategy_id);
  assert.equal(g.get("A")!.fills, 2);
  assert.equal(g.get("A")!.feeUsd, 2);
  assert.equal(g.get("B")!.totalUsd, 3);
});
