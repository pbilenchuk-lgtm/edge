import { test } from "node:test";
import assert from "node:assert/strict";
import { armedTriggers, overreactionShouldCall } from "../src/lib/reassessGate.js";

const sheet = (triggers: unknown[] | null, nested = false) =>
  JSON.stringify(nested
    ? { pair: "Overreaction · medium", strategist_plan: triggers == null ? { ok: false } : { live_triggers_armed: triggers } }
    : { pair: "Overreaction · medium", ...(triggers == null ? {} : { live_triggers_armed: triggers }) });

const goalTrigger = { scenario_trigger: "андердог забивает ранний гол", buyback_target: 62, depth_condition: "≤0:1", time_window: "до ~30'" };
const redTrigger = { scenario_trigger: "красная карточка фавориту", buyback_target: 55, time_window: "до 60'" };

test("armedTriggers: distinguishes no-sheet / unparsed / parsed-none / parsed-list", () => {
  assert.equal(armedTriggers(null).kind, "none");
  assert.equal(armedTriggers("").kind, "none");
  assert.equal(armedTriggers("{not json").kind, "unparsed");
  assert.equal(armedTriggers(JSON.stringify({ pair: "x" })).kind, "none"); // parsed, but armed nothing
  const r = armedTriggers(sheet([goalTrigger]));
  assert.equal(r.kind, "triggers");
  assert.equal((r as any).list.length, 1);
  // nested under strategist_plan is also found
  assert.equal(armedTriggers(sheet([goalTrigger], true)).kind, "triggers");
});

test("overreaction gate: no armed triggers → skip (cannot enter without one)", () => {
  assert.equal(overreactionShouldCall(sheet([]), { totalGoals: 1, minute: 20 }), false);
  assert.equal(overreactionShouldCall(sheet(null), { totalGoals: 1, minute: 20 }), false);
  assert.equal(overreactionShouldCall(null, { totalGoals: 1, minute: 20 }), false);
});

test("overreaction gate: unparsed battle sheet → fail open (call)", () => {
  assert.equal(overreactionShouldCall("{broken", { totalGoals: 0, minute: 5 }), true);
});

test("overreaction gate: 0:0 with only goal-keyed triggers → skip (no panic to buy back yet)", () => {
  assert.equal(overreactionShouldCall(sheet([goalTrigger]), { totalGoals: 0, minute: 10 }), false);
});

test("overreaction gate: 0:0 but a RED-CARD-keyed trigger is live → call (red cards aren't in the score)", () => {
  assert.equal(overreactionShouldCall(sheet([redTrigger]), { totalGoals: 0, minute: 10 }), true);
});

test("overreaction gate: a goal is on the board and we're in-window → call", () => {
  assert.equal(overreactionShouldCall(sheet([goalTrigger]), { totalGoals: 1, minute: 22 }), true);
});

test("overreaction gate: goal on the board but every window has passed → skip", () => {
  // goalTrigger window ~30' + 10' buffer = 40'; at 55' it is dead.
  assert.equal(overreactionShouldCall(sheet([goalTrigger]), { totalGoals: 1, minute: 55 }), false);
});

test("overreaction gate: unknown minute never disqualifies on the time window", () => {
  assert.equal(overreactionShouldCall(sheet([goalTrigger]), { totalGoals: 1, minute: null }), true);
});

test("overreaction gate: a trigger with no parseable window stays eligible (fail open on time)", () => {
  const noWindow = { scenario_trigger: "андердог забил", buyback_target: 60 };
  assert.equal(overreactionShouldCall(sheet([noWindow]), { totalGoals: 1, minute: 88 }), true);
});
