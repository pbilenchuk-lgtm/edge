import { test } from "node:test";
import assert from "node:assert/strict";
import { siblingLabel, impliedProbs, sizePrematch, probSumFlags } from "../src/lib/strategist.js";
import { getProfileConfig, seedRiskProfiles, loadRiskConfig } from "../src/lib/riskConfig.js";
import { openDb } from "../src/lib/db.js";

const MED = loadRiskConfig({}).config!; // defaults ≡ medium

test("siblingLabel: pairs Over/Under and Yes/No, null for one-sided", () => {
  const labels = ["Over 2.5", "Under 2.5", "Both Teams to Score — Yes", "Both Teams to Score — No", "Team to Advance — Portugal"];
  assert.equal(siblingLabel("Over 2.5", labels), "Under 2.5");
  assert.equal(siblingLabel("Under 2.5", labels), "Over 2.5");
  assert.equal(siblingLabel("Both Teams to Score — Yes", labels), "Both Teams to Score — No");
  assert.equal(siblingLabel("Team to Advance — Portugal", labels), null);
});

test("siblingLabel: Yes/No de-vig is symmetric even with inconsistent dash formatting", () => {
  const labels = ["BTTS - Yes", "BTTS No"]; // one side dashed, the other not
  assert.equal(siblingLabel("BTTS - Yes", labels), "BTTS No", "yes side finds no side");
  assert.equal(siblingLabel("BTTS No", labels), "BTTS - Yes", "no side finds yes side (symmetric)");
  // both sides de-vig to the same group → sum to 1
  const imp = impliedProbs([{ label: "BTTS - Yes", priceCents: 58 }, { label: "BTTS No", priceCents: 49 }]);
  assert.ok(imp.get("BTTS - Yes")!.sided && imp.get("BTTS No")!.sided, "both sides de-vigged");
  assert.ok(Math.abs((imp.get("BTTS - Yes")!.implied + imp.get("BTTS No")!.implied) - 1) < 1e-9);
});

test("sizePrematch: a binding cap is honored with FLOOR — never exceeded by rounding", () => {
  // max_position_pct 5% of budget 110 = $5.50 cap; a big edge would size past it.
  const r = sizePrematch({ ourProb: 0.75, priceCents: 55, implied: 0.55, calibration: 0.8, budget: 110, cfg: MED });
  assert.equal(r.status, "enter");
  assert.ok(r.stake <= 5, `floored at or below the $5.50 cap, got ${r.stake}`); // 5, not 6
});

test("impliedProbs: de-vigs a two-sided group to sum 1; raw for one-sided", () => {
  // Over 55¢ + Under 52¢ = 1.07 vig → implied Over = 55/107 ≈ 0.514
  const imp = impliedProbs([{ label: "Over 2.5", priceCents: 55 }, { label: "Under 2.5", priceCents: 52 }, { label: "Team to Advance — X", priceCents: 70 }]);
  assert.ok(Math.abs(imp.get("Over 2.5")!.implied - 55 / 107) < 1e-9, "de-vigged");
  assert.ok(imp.get("Over 2.5")!.sided);
  assert.ok(Math.abs((imp.get("Over 2.5")!.implied + imp.get("Under 2.5")!.implied) - 1) < 1e-9, "group sums to 1");
  assert.equal(imp.get("Team to Advance — X")!.implied, 0.70, "one-sided uses raw price");
  assert.equal(imp.get("Team to Advance — X")!.sided, false);
});

test("sizePrematch: enters on real edge, skips below the profile threshold", () => {
  // our 0.62 vs implied 0.52, price 53¢ → edge 10% ≥ medium min_edge 5%
  const r = sizePrematch({ ourProb: 0.62, priceCents: 53, implied: 0.52, calibration: 0.7, budget: 1000, cfg: MED });
  assert.equal(r.status, "enter");
  assert.ok(r.stake > 0 && r.stake <= 50, `stake within max_position_pct 5% of 1000, got ${r.stake}`);
  // thin edge → skip
  const r2 = sizePrematch({ ourProb: 0.55, priceCents: 53, implied: 0.53, calibration: 0.7, budget: 1000, cfg: MED });
  assert.equal(r2.status, "skip");
});

test("sizePrematch: low calibration gate blocks entry regardless of edge", () => {
  const r = sizePrematch({ ourProb: 0.7, priceCents: 50, implied: 0.5, calibration: 0.3, budget: 1000, cfg: MED });
  assert.equal(r.status, "skip");
  assert.match(r.reason, /калибровк/i);
});

test("sizePrematch: absurd edge is flagged, not traded", () => {
  const r = sizePrematch({ ourProb: 0.95, priceCents: 50, implied: 0.5, calibration: 0.8, budget: 1000, cfg: MED });
  assert.equal(r.status, "flag");
  assert.match(r.reason, /absurd/i);
});

test("sizePrematch: aggressive stakes more and enters lower edge than conservative", () => {
  const db = openDb(":memory:");
  seedRiskProfiles(db, "t");
  const agg = getProfileConfig(db, "aggressive"), con = getProfileConfig(db, "conservative");
  // a modest 4% edge: aggressive (min 3%) enters, conservative (min 7%) skips
  const inp = { ourProb: 0.56, priceCents: 52, implied: 0.52, calibration: 0.6, budget: 1000 };
  assert.equal(sizePrematch({ ...inp, cfg: agg }).status, "enter", "aggressive enters 4% edge");
  assert.equal(sizePrematch({ ...inp, cfg: con }).status, "skip", "conservative skips 4% edge");
  // on a big shared edge, aggressive stakes more (higher Kelly + higher caps)
  const big = { ourProb: 0.66, priceCents: 52, implied: 0.52, calibration: 0.7, budget: 1000 };
  assert.ok(sizePrematch({ ...big, cfg: agg }).stake > sizePrematch({ ...big, cfg: con }).stake, "aggressive stakes more");
});

test("sizePrematch: match-exposure cap limits the stake", () => {
  // already near the match cap (medium max_match_exposure_pct = 10% of 1000 = 100)
  const r = sizePrematch({ ourProb: 0.7, priceCents: 55, implied: 0.55, calibration: 0.8, budget: 1000, matchExposure: 95, cfg: MED });
  assert.ok(r.stake <= 5, `only the remaining $5 of match room can be staked, got ${r.stake}`);
});

test("probSumFlags: flags a group whose raw sum drifts beyond tolerance", () => {
  // Over 70 + Under 70 = 1.40 → way past 1 ± 0.02
  const flags = probSumFlags([{ label: "Over 2.5", priceCents: 70 }, { label: "Under 2.5", priceCents: 70 }], MED);
  assert.ok(flags.has("Over 2.5") && flags.has("Under 2.5"));
  // a tight book is fine
  const ok = probSumFlags([{ label: "Over 2.5", priceCents: 51 }, { label: "Under 2.5", priceCents: 50 }], MED);
  assert.equal(ok.size, 0);
});
