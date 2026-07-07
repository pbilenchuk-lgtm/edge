import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRiskConfig, getRiskConfig, DEFAULT_RISK_CONFIG } from "../src/lib/riskConfig.js";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";

test("loadRiskConfig: empty input → all defaults, everything listed in _defaults_used", () => {
  const r = loadRiskConfig({});
  assert.ok(r.ok && r.config);
  assert.equal(r.config!.entry_thresholds.min_edge, 0.04);
  assert.equal(r.config!.sizing.kelly_fraction_base, 0.20);
  assert.deepEqual(r.config!.sizing.kelly_fraction_clamp, [0.05, 0.33]);
  // 15 scalar ranges + the clamp = 16 default fields
  assert.equal(r.config!._defaults_used.length, 16, "all fields defaulted");
});

test("loadRiskConfig: human values pass through; only unset ones are defaulted", () => {
  const r = loadRiskConfig({
    entry_thresholds: { min_edge: 0.05, min_calibration: 0.5 },
    sizing: { max_position_pct: 0.03 },
    bankroll_limits: { max_concurrent_positions: 5 },
  });
  assert.ok(r.ok && r.config);
  assert.equal(r.config!.entry_thresholds.min_edge, 0.05);
  assert.equal(r.config!.entry_thresholds.min_calibration, 0.5);
  assert.equal(r.config!.sizing.max_position_pct, 0.03);
  assert.equal(r.config!.bankroll_limits.max_concurrent_positions, 5);
  // untouched ones default
  assert.equal(r.config!.entry_thresholds.min_edge_low_liquidity, 0.07);
  assert.ok(r.config!._defaults_used.includes("entry_thresholds.min_edge_low_liquidity"));
  assert.ok(!r.config!._defaults_used.includes("entry_thresholds.min_edge"));
});

test("loadRiskConfig: out-of-range values are REJECTED, never silently fixed", () => {
  const r = loadRiskConfig({
    entry_thresholds: { min_edge: 1.5 },              // > 1
    sizing: { kelly_fraction_base: 0 },               // must be > 0
    safeguards: { max_quote_age_seconds: -5 },        // must be > 0
    bankroll_limits: { max_concurrent_positions: 2.5 }, // must be integer
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors && r.errors.length === 4, `all four flagged, got ${r.errors?.length}`);
  assert.ok(r.errors!.some((e) => e.includes("min_edge")));
  assert.ok(r.errors!.some((e) => e.includes("kelly_fraction_base")));
  assert.ok(r.errors!.some((e) => e.includes("max_quote_age_seconds")));
  assert.ok(r.errors!.some((e) => e.includes("max_concurrent_positions")));
});

test("loadRiskConfig: kelly_fraction_clamp must be an ordered [lo,hi] in (0,1]", () => {
  assert.equal(loadRiskConfig({ sizing: { kelly_fraction_clamp: [0.3, 0.1] } }).ok, false, "lo>hi rejected");
  assert.equal(loadRiskConfig({ sizing: { kelly_fraction_clamp: [0, 0.3] } }).ok, false, "lo=0 rejected");
  assert.equal(loadRiskConfig({ sizing: { kelly_fraction_clamp: [0.1, 1.2] } }).ok, false, "hi>1 rejected");
  const ok = loadRiskConfig({ sizing: { kelly_fraction_clamp: [0.1, 0.4] } });
  assert.ok(ok.ok && ok.config);
  assert.deepEqual(ok.config!.sizing.kelly_fraction_clamp, [0.1, 0.4]);
});

test("loadRiskConfig: non-numeric field rejected; returned config is frozen", () => {
  assert.equal(loadRiskConfig({ entry_thresholds: { min_edge: "0.04" } }).ok, false, "string not coerced");
  const r = loadRiskConfig({});
  assert.ok(Object.isFrozen(r.config));
});

test("getRiskConfig: no row → defaults; stored valid config round-trips", () => {
  const db = openDb(":memory:");
  assert.deepEqual(getRiskConfig(db), DEFAULT_RISK_CONFIG);
  const custom = loadRiskConfig({ entry_thresholds: { min_edge: 0.06 } });
  R.setRiskConfigRaw(db, JSON.stringify(custom.config), "2026-07-07T00:00:00Z");
  assert.equal(getRiskConfig(db).entry_thresholds.min_edge, 0.06, "stored value read back");
});
