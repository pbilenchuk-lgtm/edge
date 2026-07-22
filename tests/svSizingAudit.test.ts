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

test("P0.6 sizing audit: a heavy 'rp-lite' that outsizes aggressive IS flagged as an inversion", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, "t");
  const lite = JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIG));
  lite.sizing.kelly_fraction_base = 0.9;
  lite.sizing.kelly_fraction_clamp = [0.05, 0.95];
  lite.sizing.max_position_pct = 0.5;
  lite.sizing.max_match_exposure_pct = 0.5;
  R.upsertRiskProfile(db, { id: "rp-lite-x", name: "rp-lite", content: JSON.stringify(lite), sort: 9, created_at: "t" } as any);
  const audit = buildSvSizingAudit(db, { TENNIS_PAPER_BUDGET_USD: "1000" });
  assert.equal(audit.rows[0].profileId, "rp-lite-x", "the heavy 'lite' profile sorts to the top (biggest stake)");
  assert.ok(audit.inversion, "inversion flagged");
  assert.match(audit.inversion!, /ИНВЕРСИЯ/);
});
