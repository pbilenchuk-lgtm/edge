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
import { warsawLabel, hoursUntil, isIso } from "../src/lib/time.js";
import { extractJson } from "../src/lib/llm.js";
import { sameMarketLabel } from "../src/lib/analysis.js";
import type { StrategyParams } from "../src/lib/types.js";

// ---------------- LLM parse + label matching ----------------
test("extractJson: pulls the first balanced object out of prose/fences", () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}');
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('Here you go: {"a":1,"b":"x"} — hope that helps'), '{"a":1,"b":"x"}');
  assert.equal(JSON.parse(extractJson('prefix {"n":{"m":2}} suffix')).n.m, 2);
  // braces inside strings don't miscount
  assert.equal(JSON.parse(extractJson('{"s":"a{b}c"}')).s, "a{b}c");
});

test("sameMarketLabel: filler-tolerant but never conflates distinct markets", () => {
  assert.ok(sameMarketLabel("Over 2.5", "Over 2.5 goals"));   // filler-only diff
  assert.ok(sameMarketLabel("Draw", "Draw"));                 // exact
  assert.ok(!sameMarketLabel("Draw", "Draw no bet"));         // meaningful {no,bet}
  assert.ok(!sameMarketLabel("Over 2.5", "Over 3.5"));        // numbers differ
  assert.ok(!sameMarketLabel("Over 2.5 goals", "Under 2.5 goals")); // over vs under
});

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
test("sizeBet: a non-finite / out-of-range model probability is rejected (no NaN stake)", () => {
  const params: StrategyParams = { flatSize: 0.05, minEdge: 3 };
  for (const bad of [NaN, Infinity, -0.1, 1.5]) {
    const d = sizeBet({ params, aiProb: bad, priceCents: 50, budget: 100 });
    assert.equal(d.enter, false, `aiProb=${bad} must not enter`);
    assert.equal(d.stake, 0, `aiProb=${bad} must size 0, not NaN`);
    assert.ok(Number.isFinite(d.stake), "stake is finite");
  }
});

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

test("sizeBet: a realized loss shrinks re-stakeable budget (no full re-stake after cash-out)", () => {
  const params: StrategyParams = { flatSize: 1, minEdge: 1 };
  // budget $100, no open exposure, but $40 already lost on this match →
  // bankroll left is $60, so a fresh entry can't re-stake the whole $100.
  const d = sizeBet({ params, aiProb: 0.6, priceCents: 50, budget: 100, exposure: 0, realizedPnl: -40 });
  assert.ok(d.stake <= 60, `capped to $60 bankroll, got ${d.stake}`);
  // with no realized loss the same call can use the full budget
  const full = sizeBet({ params, aiProb: 0.6, priceCents: 50, budget: 100, exposure: 0 });
  assert.ok(full.stake > 60, `full budget available without a loss, got ${full.stake}`);
});

test("sizeBet: Kelly uses true fractional formula edge/(1-price)", () => {
  const params: StrategyParams = { kellyFraction: 0.5, cap: 0.25, minEdge: 2 };
  const d = sizeBet({ params, aiProb: 0.55, priceCents: 46.8, budget: 450 });
  // p=0.468; f = 0.5*(0.55-0.468)/(1-0.468) = 0.5*0.082/0.532 = 0.0771
  assert.ok(d.enter);
  assert.ok(Math.abs(d.fraction - 0.0771) < 0.002, `fraction ~0.077, got ${d.fraction}`);
});

test("sizeBet: Kelly sizes larger on low-price (high-odds) bets", () => {
  // The old edge/(d-1) form understated this by ~1/price. p=0.2, q=0.3, k=0.5:
  // true half-Kelly = 0.5*0.1/0.8 = 0.0625 (not 0.0125).
  const d = sizeBet({ params: { kellyFraction: 0.5, minEdge: 1 }, aiProb: 0.3, priceCents: 20, budget: 1000 });
  assert.ok(Math.abs(d.fraction - 0.0625) < 0.001, `fraction ~0.0625, got ${d.fraction}`);
});

// ---------------- time (Warsaw display + scheduling) ----------------
test("time: warsawLabel formats ISO in Warsaw, passes non-ISO through", () => {
  // 2026-07-07T18:45Z = 20:45 Warsaw (CEST, +2)
  const lbl = warsawLabel("2026-07-07T18:45:00.000Z");
  assert.match(lbl!, /20:45/);
  assert.match(lbl!, /07\.07/);
  assert.equal(warsawLabel("через 40 мин"), "через 40 мин"); // non-ISO untouched
  assert.equal(warsawLabel(null), null);
  assert.equal(isIso("2026-07-07T18:45:00Z"), true);
  assert.equal(isIso("через 40 мин"), false);
});

test("time: hoursUntil computes lead time", () => {
  const now = Date.parse("2026-07-07T12:00:00Z");
  assert.equal(hoursUntil("2026-07-07T18:00:00Z", now), 6);
  assert.ok(hoursUntil("2026-07-07T11:00:00Z", now)! < 0); // already started
  assert.equal(hoursUntil("через час", now), null);
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
  // Polymarket "O/U 2.5" total (backs Over); team totals stay unsettleable
  assert.equal(resolveFootballMarket("O/U 2.5", 2, 1), true);  // total 3 > 2.5
  assert.equal(resolveFootballMarket("O/U 3.5", 2, 1), false); // total 3 < 3.5
  assert.equal(resolveFootballMarket("Colombia O/U 2.5", 2, 1), null); // team total, no team info — can't settle
  // team totals settle against THAT team's goals when teams are known (clarifyLabel
  // rewrites "Colombia O/U 2.5" → "Colombia Over 2.5" at ingestion — must NOT
  // settle off the aggregate)
  const cg = { home: "Colombia", away: "Ghana" };
  assert.equal(resolveFootballMarket("Colombia Over 2.5", 1, 2, cg), false); // Colombia 1, not >2.5
  assert.equal(resolveFootballMarket("Colombia Over 0.5", 1, 2, cg), true);  // Colombia 1 > 0.5
  assert.equal(resolveFootballMarket("Ghana Over 1.5", 1, 2, cg), true);     // Ghana 2 > 1.5
  assert.equal(resolveFootballMarket("Over 2.5", 1, 2, cg), true);           // aggregate 3 > 2.5
  // generic-word prefixes are the AGGREGATE, not an unresolvable team total
  assert.equal(resolveFootballMarket("Total Over 2.5", 2, 1), true);  // total 3 > 2.5
  assert.equal(resolveFootballMarket("Goals Over 3.5", 2, 1), false); // total 3 < 3.5
  // moneyline for clubs sharing a suffix resolves on the distinctive token
  const mancup = { home: "Manchester United", away: "Newcastle United" };
  assert.equal(resolveFootballMarket("Manchester United", 2, 1, mancup), true);  // home won
  assert.equal(resolveFootballMarket("Newcastle United", 2, 1, mancup), false);  // away lost
});

test("settlement: moneyline resolves from score (no longer stuck open)", () => {
  const teams = { home: "Portugal", away: "Croatia" };
  assert.equal(resolveFootballMarket("Portugal", 2, 1, teams), true);   // home win
  assert.equal(resolveFootballMarket("Croatia", 2, 1, teams), false);   // away lost
  assert.equal(resolveFootballMarket("Home to win", 2, 1, teams), true);
  assert.equal(resolveFootballMarket("Away", 0, 3, teams), true);       // away won
  assert.equal(resolveFootballMarket("Draw", 1, 1, teams), true);       // tie
  assert.equal(resolveFootballMarket("Draw", 2, 1, teams), false);
});

test("settlement: signed handicap respects side and sign", () => {
  const teams = { home: "Portugal", away: "Croatia" };
  assert.equal(resolveFootballMarket("Portugal -1.5", 2, 0, teams), true);   // home by 2 > 1.5
  assert.equal(resolveFootballMarket("Portugal -1.5", 1, 0, teams), false);  // home by 1
  assert.equal(resolveFootballMarket("Croatia -1.5", 0, 3, teams), true);    // away by 3 (was inverted before)
  assert.equal(resolveFootballMarket("Croatia -1.5", 0, 3, teams) !== false, true);
});

test("thresholds: numeric minConfidence still gates (не отключается)", () => {
  // The extractor may emit minConfidence as a number; validateParams (the real
  // pipeline) must normalize it to a band so the gate isn't silently disabled.
  const p = validateParams({ minConfidence: 0.8, flatSize: 0.05 } as unknown as StrategyParams);
  assert.equal(p.minConfidence, "высокая");
  const skip = sizeBet({ params: p, aiProb: 0.9, priceCents: 50, budget: 1000, confidence: "низкая" });
  assert.equal(skip.enter, false);
  assert.match(skip.reason, /уверенность/);
});

test("sizeBet: portfolio stop-loss halts entries once drawdown hits it", () => {
  const params: StrategyParams = { flatSize: 0.05, minEdge: 1, stop: -0.2 };
  const base = { params, aiProb: 0.6, priceCents: 50, budget: 1000, confidence: "высокая" as const };
  assert.equal(sizeBet({ ...base, drawdown: -0.1 }).enter, true);   // above the stop
  const halted = sizeBet({ ...base, drawdown: -0.25 });             // past the stop
  assert.equal(halted.enter, false);
  assert.match(halted.reason, /стоп-лосс/);
  assert.equal(sizeBet({ ...base }).enter, true);                   // no drawdown info => no halt
});

test("thresholds: stop-loss captured in both sign conventions", () => {
  assert.equal(validateParams({ stop: 0.2 } as StrategyParams).stop, -0.2);   // LLM (0..1) — was dropped before
  assert.equal(validateParams({ stop: -0.25 } as StrategyParams).stop, -0.25); // heuristic
  assert.equal(validateParams({ stop: 0 } as StrategyParams).stop, undefined);
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
