import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAnalysisDuel, pickAnalysisModel, analysisModelTag } from "../src/lib/analysisDuel.js";

test("loadAnalysisDuel: OFF by default; 'on' enables the default Opus 4.8 vs Fable 5 pair", () => {
  assert.equal(loadAnalysisDuel({}).enabled, false, "off unless explicitly enabled");
  const d = loadAnalysisDuel({ ANALYSIS_DUEL: "on" });
  assert.equal(d.enabled, true);
  assert.deepEqual(d.models, ["Claude Opus 4.8", "Claude Fable 5"]);
});

test("loadAnalysisDuel: OFF variants disable it", () => {
  for (const v of ["off", "OFF", "0", "false", "no"]) assert.equal(loadAnalysisDuel({ ANALYSIS_DUEL: v }).enabled, false);
});

test("loadAnalysisDuel: a custom resolvable pair is honoured; junk/dup disables", () => {
  const d = loadAnalysisDuel({ ANALYSIS_DUEL: "Claude Opus 4.8 | Claude Sonnet 5" });
  assert.equal(d.enabled, true);
  assert.deepEqual(d.models, ["Claude Opus 4.8", "Claude Sonnet 5"]);
  assert.equal(loadAnalysisDuel({ ANALYSIS_DUEL: "Claude Opus 4.8 | Claude Opus 4.8" }).enabled, false, "same model twice is not a duel");
  assert.equal(loadAnalysisDuel({ ANALYSIS_DUEL: "Nonexistent Model X | Claude Opus 4.8" }).enabled, false, "unresolvable model disables");
});

test("pickAnalysisModel: deterministic per id, and balanced across many ids", () => {
  const duel = loadAnalysisDuel({});
  // stable: same id → same model, every time
  assert.equal(pickAnalysisModel("match-abc", duel), pickAnalysisModel("match-abc", duel));
  // balanced: over many ids both arms are well represented (not 0/all)
  let a = 0, b = 0;
  for (let i = 0; i < 400; i++) { const m = pickAnalysisModel(`fixture-${i}-xyz`, duel); if (m === duel.models[0]) a++; else b++; }
  assert.ok(a > 120 && b > 120, `roughly balanced split, got ${a}/${b}`);
});

test("analysisModelTag: short label-safe slug", () => {
  assert.equal(analysisModelTag("Claude Opus 4.8"), "opus48");
  assert.equal(analysisModelTag("Claude Fable 5"), "fable5");
  assert.equal(analysisModelTag("Claude Sonnet 5"), "sonnet5");
});
