import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { seedRiskProfiles, DEFAULT_RISK_CONFIG } from "../src/lib/riskConfig.js";
import { buildSvSizingAudit } from "../src/lib/svSizingAudit.js";

test("P0.6 sizing audit: a row per profile, sorted by stake; NO inversion for well-ordered defaults", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, "t"); // aggressive / medium / conservative presets
  const audit = buildSvSizingAudit(db, { TENNIS_PAPER_BUDGET_USD: "1000" });
  assert.ok(audit.rows.length >= 3, "one row per profile");
  assert.equal(audit.reference.priceCents, 35);
  for (let i = 1; i < audit.rows.length; i++) assert.ok(audit.rows[i - 1].refStake >= audit.rows[i].refStake, "sorted by stake desc");
  assert.equal(audit.inversion, null, "presets are ordered — no inversion");
});

test("P0.6 sizing audit: a genuinely-misconfigured CONSERVATIVE that outsizes aggressive IS flagged as an inversion", () => {
  // Post owner-decision 23.07.2026(b), `max` outsizing everyone is BY DESIGN and NOT an inversion. The audit
  // still flags a real misconfiguration — a "lite"/"conservative" profile that outsizes aggressive.
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, "t");
  const heavy = JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIG));
  heavy.sizing.kelly_fraction_base = 0.9;
  heavy.sizing.kelly_fraction_clamp = [0.05, 0.95];
  heavy.sizing.max_position_pct = 0.5;
  heavy.sizing.max_match_exposure_pct = 0.5;
  // overwrite the seeded conservative preset with a (wrongly) heavy config
  R.upsertRiskProfile(db, { id: "conservative", name: "Консервативный", content: JSON.stringify(heavy), sort: 2, created_at: "t" } as any);
  const audit = buildSvSizingAudit(db, { TENNIS_PAPER_BUDGET_USD: "1000" });
  assert.equal(audit.rows[0].profileId, "conservative", "the heavy conservative sorts to the top (biggest stake)");
  assert.ok(audit.inversion, "inversion flagged");
  assert.match(audit.inversion!, /ИНВЕРСИЯ/);
});

test("P0.6 sizing audit: `max` outsizing aggressive is NOT an inversion (legitimized 23.07.2026 b)", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, "t");
  const heavy = JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIG));
  heavy.sizing.kelly_fraction_base = 0.9;
  heavy.sizing.kelly_fraction_clamp = [0.05, 0.95];
  heavy.sizing.max_position_pct = 0.5;
  heavy.sizing.max_match_exposure_pct = 0.5;
  R.upsertRiskProfile(db, { id: "max", name: "max", content: JSON.stringify(heavy), sort: 9, created_at: "t" } as any);
  const audit = buildSvSizingAudit(db, { TENNIS_PAPER_BUDGET_USD: "1000" });
  assert.equal(audit.rows[0].profileId, "max", "max sorts to the top (biggest stake — by design)");
  assert.equal(audit.inversion, null, "max outsizing everyone is intentional, not an inversion");
});
