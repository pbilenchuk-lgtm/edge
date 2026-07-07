import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleFootball } from "../src/lib/assembler.js";
import { derivePoissonMarkets } from "../src/lib/poisson.js";
import type { FootballAnalysis, CategoryDelta } from "../src/lib/llm.js";

const base: FootballAnalysis = {
  ok: true, matchType: "group", matchTypeReason: "есть ничья",
  core: { xg_home: 1.6, xg_away: 1.2, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 },
  overrides: [{ target: "totals_match.2.5.over", adjust: -0.03, reason: "оба осторожны" }],
  drivers: [{ factor: "атака хозяев", direction: "хозяева", magnitude: "medium", confidence: 0.6 }],
  scenarios: [{ trigger: "ранний гол", prob: 0.3, shifts: null, note: "n" }],
  calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 10, notes: "" },
  unknowns: ["состав не подтверждён"],
};

test("assembleFootball: no category → base core derived, base overrides applied", () => {
  const as = assembleFootball(base, null);
  const pure = derivePoissonMarkets(base.core);
  // over 2.5 nudged down 0.03 by the base override
  assert.ok(Math.abs(as.derived.totals_match["2.5"] - (pure.totals_match["2.5"] - 0.03)) < 0.001, "base override applied");
  assert.equal(as.categoryNotes, "");
  assert.equal(as.drivers.length, 1);
});

test("assembleFootball: category core_adjustment lowers xG → totals drop, metadata merges", () => {
  const cat: CategoryDelta = {
    ok: true,
    coreAdjustments: [{ target: "xg_away", op: "multiply", value: 0.9, reason: "Мехико высота" }],
    newDrivers: [{ factor: "высота", direction: "оба вниз", magnitude: "small", confidence: 0.5 }],
    newScenarios: [{ trigger: "параллельный матч", prob: 0.2, shifts: null, note: "мотивация" }],
    overrideAdjustments: [{ target: "totals_match.1.5.over", adjust: -0.02, reason: "сжатие" }],
    confidenceXgDelta: -0.1, confidenceScenarioDelta: 0, notes: "ЧМ: высота и несыгранность",
  };
  const as = assembleFootball(base, cat);
  const baseline = assembleFootball(base, null);
  assert.ok(as.core.xg_away < base.core.xg_away, "xG away lowered by the modifier");
  assert.ok(as.derived.totals_match["2.5"] < baseline.derived.totals_match["2.5"], "lower xG → lower Over 2.5");
  assert.equal(as.drivers.length, 2, "base + new driver");
  assert.equal(as.scenarios.length, 2, "base + new scenario");
  assert.ok(Math.abs(as.calibration.xg_confidence - 0.5) < 1e-9, "confidence shifted 0.6 → 0.5");
  assert.equal(as.categoryNotes, "ЧМ: высота и несыгранность");
  assert.equal(as.overrides.length, 2, "base + category overrides merged");
});

test("assembleFootball: drops garbage scenario nodes (empty shifts AND empty note)", () => {
  const cat: CategoryDelta = {
    ok: true, coreAdjustments: [], newDrivers: [],
    newScenarios: [
      { trigger: "выход в овертайм", prob: 0.2, shifts: null, note: "" },                  // garbage → dropped
      { trigger: "параллельный матч", prob: 0.15, shifts: null, note: "меняет мотивацию" }, // has note → kept
    ],
    overrideAdjustments: [], confidenceXgDelta: 0, confidenceScenarioDelta: 0, notes: "",
  };
  const as = assembleFootball(base, cat);
  const triggers = as.scenarios.map((s) => s.trigger);
  assert.ok(triggers.includes("параллельный матч"), "filled scenario kept");
  assert.ok(!triggers.includes("выход в овертайм"), "empty scenario dropped");
  assert.ok(triggers.includes("ранний гол"), "base scenario (has note) kept");
});

test("assembleFootball: outcome_90 stays a valid distribution after everything", () => {
  const cat: CategoryDelta = { ok: true, coreAdjustments: [{ target: "xg_home", op: "add", value: 0.3, reason: "хозяева" }], newDrivers: [], newScenarios: [], overrideAdjustments: [{ target: "outcome_90.draw", adjust: 0.05, reason: "ничья вероятнее" }], confidenceXgDelta: 0, confidenceScenarioDelta: 0, notes: "" };
  const as = assembleFootball(base, cat);
  const o = as.derived.outcome_90;
  assert.ok(Math.abs(o.home + o.draw + o.away - 1) < 0.001, "1X2 still sums to 1");
});
