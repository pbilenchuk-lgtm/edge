import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeTennisTriggers, tennisReassessShouldCall, TENNIS_ARMED } from "../src/lib/tennisOverreaction.js";

test("charge: a clear favourite (underdog ≤ threshold) arms two interim triggers", () => {
  const c = chargeTennisTriggers({ p1Cents: 78, p2Cents: 22 }); // p2 underdog → p1 favourite
  assert.equal(c.favSide, "first");
  assert.equal(c.favPriceCents, 78);
  assert.equal(c.triggers.length, 2);
  assert.ok(c.triggers.every((t) => t.thresholds === "interim"));
  assert.deepEqual(c.triggers.map((t) => t.id).sort(), ["early_break", "lost_first_set"]);
});

test("charge: a coin-flip match (no clear underdog) arms nothing", () => {
  assert.equal(chargeTennisTriggers({ p1Cents: 55, p2Cents: 45 }).favSide, null);
  assert.equal(chargeTennisTriggers({ p1Cents: null, p2Cents: 30 }).favSide, null);
});

test("gate: favourite broken early + price at buyback → call the LLM", () => {
  const c = chargeTennisTriggers({ p1Cents: 80, p2Cents: 20 }); // fav = first
  assert.equal(tennisReassessShouldCall(c, { brokenSide: "first", setNum: 1, favSetsLost: 0, favPriceCents: 52 }), true);
});

test("gate: the UNDERDOG being broken is NOT our setup → skip", () => {
  const c = chargeTennisTriggers({ p1Cents: 80, p2Cents: 20 });
  assert.equal(tennisReassessShouldCall(c, { brokenSide: "second", setNum: 1, favSetsLost: 0, favPriceCents: 85 }), false);
});

test("gate: favourite broken but price NOT near the buyback → skip (no panic)", () => {
  const c = chargeTennisTriggers({ p1Cents: 80, p2Cents: 20 });
  // fav still priced 74¢ — nowhere near the 55¢ early-break buyback (+10 buffer) → skip
  assert.equal(tennisReassessShouldCall(c, { brokenSide: "first", setNum: 1, favSetsLost: 0, favPriceCents: 74 }), false);
});

test("gate: lost set 1 uses the deeper buyback cap", () => {
  const c = chargeTennisTriggers({ p1Cents: 80, p2Cents: 20 });
  // in set 2 after losing set 1: cap = lostFirstSetBuyMax (45) + buffer
  assert.equal(tennisReassessShouldCall(c, { brokenSide: "first", setNum: 2, favSetsLost: 1, favPriceCents: 50 }), true);
  assert.equal(tennisReassessShouldCall(c, { brokenSide: "first", setNum: 2, favSetsLost: 1, favPriceCents: 60 }), false);
});

test("gate: outside armed windows (late, no set lost) → skip", () => {
  const c = chargeTennisTriggers({ p1Cents: 80, p2Cents: 20 });
  assert.equal(tennisReassessShouldCall(c, { brokenSide: "first", setNum: 3, favSetsLost: 0, favPriceCents: 40 }), false);
});

test("gate: unknown price fails OPEN (don't silently skip a real setup)", () => {
  const c = chargeTennisTriggers({ p1Cents: 80, p2Cents: 20 });
  assert.equal(tennisReassessShouldCall(c, { brokenSide: "first", setNum: 1, favSetsLost: 0, favPriceCents: null }), true);
});

test("gate: no favourite armed → skip (iron border: entry only via armed trigger)", () => {
  const c = chargeTennisTriggers({ p1Cents: 52, p2Cents: 48 });
  assert.equal(tennisReassessShouldCall(c, { brokenSide: "first", setNum: 1, favSetsLost: 0, favPriceCents: 40 }), false);
});

test("interim armed constants are present + env-tunable shape", () => {
  assert.ok(TENNIS_ARMED.earlyBreakBuyMax > TENNIS_ARMED.lostFirstSetBuyMax, "lost-set-1 panic is deeper (lower buy cap)");
});
