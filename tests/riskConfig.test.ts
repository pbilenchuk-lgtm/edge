import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRiskConfig, getRiskConfig, getProfileConfig, seedRiskProfiles, migrateRiskProfileExits, listRiskProfileViews, parseRiskProfile, parseRiskConfigHeuristic, DEFAULT_RISK_CONFIG, RISK_PROFILE_DEFS } from "../src/lib/riskConfig.js";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";

test("loadRiskConfig: empty input → all defaults, everything listed in _defaults_used", () => {
  const r = loadRiskConfig({});
  assert.ok(r.ok && r.config);
  assert.equal(r.config!.entry_thresholds.min_edge, 0.04);
  assert.equal(r.config!.sizing.kelly_fraction_base, 0.20);
  assert.deepEqual(r.config!.sizing.kelly_fraction_clamp, [0.05, 0.33]);
  // 17 scalar ranges (incl. 2 exits) + the clamp = 18 default fields
  assert.equal(r.config!._defaults_used.length, 18, "all fields defaulted");
  assert.deepEqual(r.config!.exits, { take_profit_pct: 0.5, hard_stop_pct: 0.5 });
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

test("loadRiskConfig: kelly base must sit inside the clamp — derive default, reject explicit contradiction", () => {
  // base only → the defaulted clamp widens to contain it (base = its ceiling)
  const derived = loadRiskConfig({ sizing: { kelly_fraction_base: 0.5 } });
  assert.ok(derived.ok && derived.config);
  assert.deepEqual(derived.config!.sizing.kelly_fraction_clamp, [0.05, 0.5]);
  // base + an EXPLICIT clamp that excludes it → hard error, not a silent cap
  const bad = loadRiskConfig({ sizing: { kelly_fraction_base: 0.5, kelly_fraction_clamp: [0.05, 0.33] } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors!.some((e) => e.includes("kelly_fraction_base")), "flags the base/clamp contradiction");
  // a coherent explicit pair passes untouched
  const ok = loadRiskConfig({ sizing: { kelly_fraction_base: 0.33, kelly_fraction_clamp: [0.05, 0.4] } });
  assert.ok(ok.ok && ok.config);
  assert.deepEqual(ok.config!.sizing.kelly_fraction_clamp, [0.05, 0.4]);
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

test("getRiskConfig: no profiles → defaults; after seeding → MEDIUM preset", () => {
  const db = openDb(":memory:");
  assert.deepEqual(getRiskConfig(db), DEFAULT_RISK_CONFIG); // nothing seeded
  seedRiskProfiles(db, "2026-07-07T00:00:00Z");
  // getRiskConfig reads the MEDIUM reference profile
  assert.equal(getRiskConfig(db).entry_thresholds.min_edge, 0.05);
  assert.equal(getRiskConfig(db).sizing.kelly_fraction_base, 0.20);
});

test("seedRiskProfiles: seeds three named presets, idempotent, each validates", () => {
  const db = openDb(":memory:");
  seedRiskProfiles(db, "2026-07-07T00:00:00Z");
  const views = listRiskProfileViews(db);
  assert.equal(views.length, 3);
  assert.deepEqual(views.map((v) => v.id), ["aggressive", "medium", "conservative"], "ordered by sort");
  assert.deepEqual(views.map((v) => v.name), ["Агрессивный", "Средний", "Консервативный"]);
  // aggressive is bolder than conservative on the key knobs
  const agg = getProfileConfig(db, "aggressive"), con = getProfileConfig(db, "conservative");
  assert.ok(agg.sizing.kelly_fraction_base > con.sizing.kelly_fraction_base);
  assert.ok(agg.entry_thresholds.min_edge < con.entry_thresholds.min_edge);
  assert.ok(agg.sizing.max_position_pct > con.sizing.max_position_pct);
  // idempotent — re-seeding doesn't duplicate
  seedRiskProfiles(db, "2026-07-08T00:00:00Z");
  assert.equal(listRiskProfileViews(db).length, 3);
});

test("parseRiskProfile: «вытащить» pulls values from free text, validates, defaults the rest", () => {
  const text = `entry_thresholds:
  min_edge: 0.03
  min_edge_low_liquidity: 0.05
  min_calibration: 0.40
sizing:
  kelly_fraction_base: 0.33
  kelly_fraction_clamp: [0.05, 0.40]
  max_position_pct: 0.08
safeguards:
  absurd_edge_block: 0.25`;
  const res = parseRiskProfile(text);
  assert.ok(res.ok && res.config, res.errors?.join("; "));
  assert.equal(res.config!.entry_thresholds.min_edge, 0.03);
  // min_edge_low_liquidity must NOT be shadowed by the min_edge regex
  assert.equal(res.config!.entry_thresholds.min_edge_low_liquidity, 0.05);
  assert.equal(res.config!.sizing.kelly_fraction_base, 0.33);
  assert.deepEqual(res.config!.sizing.kelly_fraction_clamp, [0.05, 0.40]);
  assert.equal(res.config!.sizing.max_position_pct, 0.08);
  assert.equal(res.config!.safeguards.absurd_edge_block, 0.25);
  // an unmentioned field falls back to the default
  assert.ok(res.config!._defaults_used.includes("bankroll_limits.daily_loss_limit_pct"));
});

test("parseRiskProfile: parses the UI labels + percent notation (the «Lite» profile)", () => {
  // exactly what the user typed into the «Новый риск-профиль» box
  const text = `min_edge: 2.0% — входит даже на тонком крае (ниже 2% — уже зона ошибки очистки от vig)
min_calibration: 0.30 — пускает модель действовать
Kelly base: 0.5 — половина Kelly, практический потолок агрессии
max позиция: 12%
max на матч: 20%
absurd edge: 25% — НЕ трогать (см. ниже)
take-profit: 90% — даёт прибыли бежать дольше
hard-stop: 75% — больше места тезису отыграться`;
  const res = parseRiskProfile(text);
  assert.ok(res.ok && res.config, res.errors?.join("; "));
  const c = res.config!;
  assert.equal(c.entry_thresholds.min_edge, 0.02, "2.0% → 0.02, not 2");
  assert.equal(c.entry_thresholds.min_calibration, 0.30);
  assert.equal(c.sizing.kelly_fraction_base, 0.5, "«Kelly base» label recognised");
  assert.deepEqual(c.sizing.kelly_fraction_clamp, [0.05, 0.5], "defaulted clamp widened to contain the base (0.5 is the ceiling, not dead)");
  assert.equal(c.sizing.max_position_pct, 0.12, "«max позиция» → 12% → 0.12");
  assert.equal(c.sizing.max_match_exposure_pct, 0.20, "«max на матч» → 20% → 0.20");
  assert.equal(c.safeguards.absurd_edge_block, 0.25, "«absurd edge» → 25% → 0.25");
  assert.equal(c.exits.take_profit_pct, 0.90, "«take-profit» → 90% → 0.90");
  assert.equal(c.exits.hard_stop_pct, 0.75, "«hard-stop» → 75% → 0.75");
});

test("parseRiskConfigHeuristic: an out-of-range value surfaces as a validation error", () => {
  const res = parseRiskProfile("min_edge = 1.5\nkelly_fraction_base = 0.2");
  assert.equal(res.ok, false);
  assert.ok(res.errors!.some((e) => e.includes("min_edge")));
});

test("profile exits differ: aggressive holds longer, conservative locks in sooner", () => {
  const db = openDb(":memory:");
  seedRiskProfiles(db, "t");
  const agg = getProfileConfig(db, "aggressive"), med = getProfileConfig(db, "medium"), con = getProfileConfig(db, "conservative");
  assert.ok(agg.exits.take_profit_pct > med.exits.take_profit_pct && med.exits.take_profit_pct > con.exits.take_profit_pct, "take-profit: agg > med > con");
  assert.ok(agg.exits.hard_stop_pct > con.exits.hard_stop_pct, "aggressive tolerates a wider stop");
  assert.deepEqual(med.exits, { take_profit_pct: 0.5, hard_stop_pct: 0.5 });
});

test("migrateRiskProfileExits: adds exits to presets seeded before the group existed, idempotent", () => {
  const db = openDb(":memory:");
  // seed a preset WITHOUT the exits group (simulate an old prod row)
  const aggNoExits = loadRiskConfig({ ...(RISK_PROFILE_DEFS[0].values as any), exits: undefined });
  const raw = JSON.parse(JSON.stringify(aggNoExits.config));
  delete raw.exits;
  R.upsertRiskProfile(db, { id: "aggressive", name: "Агрессивный", content: JSON.stringify(raw), sort: 0, created_at: "t" });
  assert.ok(!JSON.parse(R.getRiskProfileRow(db, "aggressive")!.content).exits || getProfileConfig(db, "aggressive").exits.take_profit_pct === 0.5, "pre-migration lacks profile-specific exits");

  migrateRiskProfileExits(db);
  assert.equal(getProfileConfig(db, "aggressive").exits.take_profit_pct, 0.80, "aggressive exits restored");
  // idempotent
  migrateRiskProfileExits(db);
  assert.equal(getProfileConfig(db, "aggressive").exits.take_profit_pct, 0.80);
});

test("getProfileConfig: unknown id → defaults; every preset def loads clean", () => {
  const db = openDb(":memory:");
  seedRiskProfiles(db, "2026-07-07T00:00:00Z");
  assert.deepEqual(getProfileConfig(db, "does-not-exist"), DEFAULT_RISK_CONFIG);
  for (const def of RISK_PROFILE_DEFS) assert.equal(loadRiskConfig(def.values).ok, true, `${def.id} validates`);
});
