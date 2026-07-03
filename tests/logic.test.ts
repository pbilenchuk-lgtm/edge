import { test } from "node:test";
import assert from "node:assert/strict";

import {
  freeBalance, canSetBudget, stratBudget, sharesValid, sharesTotal,
  stakeWithinBudget, roi,
} from "../src/lib/money.js";
import { edgePct, impliedProb, decimalOdds } from "../src/lib/edge.js";
import {
  extractThresholdsHeuristic, validateParams, sizeBet, confidenceRank,
} from "../src/lib/thresholds.js";
import { payout, settleBet, resolveFootballMarket } from "../src/lib/settlement.js";
import {
  brierScore, clvValue, calibration, computeMetrics, verdict, MIN_SAMPLES,
} from "../src/lib/metrics.js";
import { checkInvariants } from "../src/lib/invariants.js";
import type { StrategyParams } from "../src/lib/types.js";

// ---------------- money (§3.1, §9.1–3) ----------------
test("money: free balance and allocation guard", () => {
  const comps = [{ id: "a", budget: 1500 }, { id: "b", budget: 400 }, { id: "c", budget: 400 }];
  assert.equal(freeBalance(5000, comps), 2700);
  assert.equal(canSetBudget(5000, comps, "a", 3000), true); // others 800 + 3000 <= 5000
  assert.equal(canSetBudget(5000, comps, "a", 4500), false); // others 800 + 4500 > 5000
  assert.equal(canSetBudget(5000, comps, "a", -1), false);
});

test("money: strat budget, shares, stake guard, roi", () => {
  assert.equal(stratBudget(1500, 50), 750);
  assert.equal(sharesTotal([{ pct: 50 }, { pct: 30 }, { pct: 20 }]), 100);
  assert.equal(sharesValid([{ pct: 50 }, { pct: 51 }]), false);
  assert.equal(stakeWithinBudget([{ stake: 100 }, { stake: 200 }], 300), true);
  assert.equal(stakeWithinBudget([{ stake: 100 }, { stake: 250 }], 300), false);
  assert.equal(roi(150, 1000), 15);
});

// ---------------- edge (§2.10) ----------------
test("edge: cents <-> probability", () => {
  assert.ok(Math.abs(impliedProb(46.8) - 0.468) < 1e-9);
  assert.equal(Math.round(edgePct(0.55, 46.8) * 10) / 10, 8.2);
  assert.equal(decimalOdds(50), 2);
});

// ---------------- thresholds extraction (§3.2) ----------------
test("thresholds: extract tiered/flat/kelly prompts", () => {
  const edge = extractThresholdsHeuristic(
    "Входи при высокой уверенности. Размер по лесенке: edge>=10% -> 20%; 7-10% -> 15%; 5-7% -> 10%; 3-5% -> 5%. Не более 20% на ставку, стоп -25%.",
  );
  assert.deepEqual(edge.tiers, [[10, 0.2], [7, 0.15], [5, 0.1], [3, 0.05]]);
  assert.equal(edge.maxPerBet, 0.2);
  assert.equal(edge.stop, -0.25);
  assert.equal(edge.minEdge, 3, "lowest tier is the effective min edge, not 10");
  assert.equal(edge.minConfidence, "высокая");

  const flat = extractThresholdsHeuristic("Входи на любой edge >= 3%. Размер всегда 5%. Не более 5% на ставку.");
  assert.equal(flat.flatSize, 0.05);
  assert.equal(flat.minEdge, 3);
  assert.equal(flat.maxPerBet, 0.05);

  const kelly = extractThresholdsHeuristic("Входи при edge >= 2%. Размер = 0.5*edge/(odds-1), максимум 25%. Не более 25% на ставку, стоп -30%.");
  assert.equal(kelly.kellyFraction, 0.5);
  assert.equal(kelly.cap, 0.25);
  assert.equal(kelly.minEdge, 2);

  assert.equal(extractThresholdsHeuristic("бла бла").note, "пороги не распознаны");
});

test("thresholds: validateParams drops nonsense", () => {
  const p = validateParams({ maxPerBet: 5, minEdge: -3, flatSize: 0.1 } as StrategyParams);
  assert.equal(p.maxPerBet, 1); // clamped
  assert.equal(p.minEdge, undefined); // dropped
  assert.equal(p.flatSize, 0.1);
});

test("confidenceRank ordering", () => {
  assert.ok(confidenceRank("высокая") > confidenceRank("средняя"));
  assert.ok(confidenceRank("средняя") > confidenceRank("низкая"));
});

// ---------------- sizing — code, not LLM (§9.6) ----------------
test("sizeBet: tiered ladder picks the right tier and caps", () => {
  const params: StrategyParams = { tiers: [[10, 0.2], [7, 0.15], [5, 0.1], [3, 0.05]], maxPerBet: 0.2, minEdge: 3 };
  const d = sizeBet({ params, aiProb: 0.55, priceCents: 46.8, budget: 750, confidence: "высокая" });
  assert.equal(d.enter, true);
  assert.equal(d.fraction, 0.15); // edge 8.2% -> tier 7
  assert.equal(d.stake, 113); // 750 * 0.15 = 112.5 -> 113
});

test("sizeBet: minEdge and confidence gates cause a skip with a reason", () => {
  const params: StrategyParams = { flatSize: 0.05, minEdge: 3, maxPerBet: 0.05 };
  const skip = sizeBet({ params, aiProb: 0.55, priceCents: 54, budget: 300 }); // edge 1% < 3%
  assert.equal(skip.enter, false);
  assert.match(skip.reason, /ниже порога/);

  const confParams: StrategyParams = { flatSize: 0.05, minEdge: 3, minConfidence: "высокая" };
  const confSkip = sizeBet({ params: confParams, aiProb: 0.55, priceCents: 46.8, budget: 300, confidence: "средняя" });
  assert.equal(confSkip.enter, false);
  assert.match(confSkip.reason, /уверенность/);
});

test("sizeBet: respects remaining match budget (§9.3)", () => {
  const params: StrategyParams = { flatSize: 0.5, minEdge: 1 };
  const d = sizeBet({ params, aiProb: 0.6, priceCents: 50, budget: 100, exposure: 90 });
  assert.ok(d.stake <= 10, "cannot exceed remaining $10 of budget");
});

test("sizeBet: Kelly uses simplified edge/net-odds formula", () => {
  const params: StrategyParams = { kellyFraction: 0.5, cap: 0.25, minEdge: 2 };
  const d = sizeBet({ params, aiProb: 0.55, priceCents: 46.8, budget: 450 });
  // b = 100/46.8 - 1 = 1.1368; f = 0.5*0.082/1.1368 = 0.0361
  assert.ok(d.enter);
  assert.ok(Math.abs(d.fraction - 0.0361) < 0.002, `fraction ~0.036, got ${d.fraction}`);
});

// ---------------- settlement (§3.4) ----------------
test("settlement: payout and P&L", () => {
  assert.equal(payout(55, 100, true), 181.82);
  assert.equal(payout(55, 100, false), 0);
  const patch = settleBet({ entry_price: 55, stake: 100 }, true, 92);
  assert.equal(patch.status, "settled_won");
  assert.equal(patch.closing_price, 92);
  assert.equal(patch.pnl, 81.82);
});

test("settlement: football market resolution from score 2:1", () => {
  assert.equal(resolveFootballMarket("Under 2.5", 2, 1), false); // total 3
  assert.equal(resolveFootballMarket("Over 2.5", 2, 1), true);
  assert.equal(resolveFootballMarket("Over 1.5", 2, 1), true);
  assert.equal(resolveFootballMarket("Both Teams to Score — Yes", 2, 1), true);
  assert.equal(resolveFootballMarket("Team to Advance — Португалия", 2, 1), null); // external
});

// ---------------- metrics (§2.14) ----------------
test("metrics: Brier, CLV, calibration, verdict", () => {
  const samples = [
    { aiProb: 0.85, outcome: 1 as const, entryPrice: 55, closingPrice: 92 },
    { aiProb: 0.55, outcome: 1 as const, entryPrice: 58, closingPrice: 40 },
  ];
  assert.equal(brierScore(samples), 0.1125);
  assert.equal(clvValue(samples), 9.5); // (37 + -18)/2
  // low data -> verdict "мало данных"
  assert.equal(computeMetrics(samples).verdict, "мало данных");

  // enough samples, good numbers -> "эдж реален"
  const many = Array.from({ length: MIN_SAMPLES }, () => ({
    aiProb: 0.7, outcome: 1 as const, entryPrice: 60, closingPrice: 66,
  }));
  const m = computeMetrics(many);
  assert.equal(m.lowData, false);
  assert.equal(m.verdict, "эдж реален");
  assert.ok(m.calibration.length >= 1);
});

test("metrics: verdict branches", () => {
  assert.equal(verdict(0.1, 5, false), "эдж реален");
  assert.equal(verdict(0.25, -2, false), "эджа нет");
  assert.equal(verdict(0.25, 0.5, false), "неясно");
  assert.equal(verdict(0.1, 5, true), "мало данных");
});

// ---------------- invariants (§9) ----------------
test("invariants: detects over-allocation and over-shares", () => {
  const bad = checkInvariants({
    totalBalance: 1000,
    competitions: [{ id: "a", budget: 800 }, { id: "b", budget: 400 }], // 1200 > 1000
    sharesByComp: { a: [{ strategy_id: "s1", pct: 60 }, { strategy_id: "s2", pct: 50 }] }, // 110 > 100
    stakeGroups: [],
    assessmentsByMatch: {},
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.some((v) => v.code === "9.1"));
  assert.ok(bad.violations.some((v) => v.code === "9.2"));

  const good = checkInvariants({
    totalBalance: 5000,
    competitions: [{ id: "a", budget: 1500 }],
    sharesByComp: { a: [{ strategy_id: "s1", pct: 50 }] },
    stakeGroups: [{ competitionId: "a", strategyId: "s1", matchId: "m", strategyBudget: 750, bets: [{ stake: 700 }] }],
    assessmentsByMatch: { m: [{ stage: "pre_lineup", status: "ok" }, { stage: "post_lineup", status: "ok" }] },
  });
  assert.equal(good.ok, true);
});
