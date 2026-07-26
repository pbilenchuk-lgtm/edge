import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import { getProfileConfig } from "../src/lib/riskConfig.js";
import { ftBlindCohort } from "../src/lib/pmResolution.js";
import { CODE_VERSION } from "../src/lib/betMeta.js";

test("1.3: conservative entry thresholds now EQUAL medium's; it differs only in SIZE", () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const con = getProfileConfig(db, "conservative");
  const med = getProfileConfig(db, "medium");
  assert.deepEqual(con.entry_thresholds, med.entry_thresholds, "same signal SET as medium (a size-dial, not a selection filter)");
  assert.ok(con.sizing.kelly_fraction_base < med.sizing.kelly_fraction_base, "smaller Kelly → smaller size");
  assert.ok(con.sizing.max_position_pct < med.sizing.max_position_pct, "smaller per-position cap");
});

test("1.3: a semantics change is an epoch bump, so the pre-change cohort stays distinctly labelled", () => {
  // Pinned to the CURRENT epoch rather than to e8: the point of the rule is that the label moves whenever the
  // numbers change meaning. Asserting a frozen "e8" would fail every future bump and train the next reader to
  // edit the expectation reflexively — which is how an epoch stops being a boundary and becomes a formality.
  assert.match(CODE_VERSION, /^e\d+$/, "a human-legible monotone label, not a git sha");
  assert.ok(Number(CODE_VERSION.slice(1)) >= 8, "conservative's re-parameterization (e8) is at or behind us");
});

test("1.4: ft_blind cap-review criterion accrues to n≥30 decided; cap is NOT auto-lifted", () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const c = ftBlindCohort(db, {});
  assert.equal(c.capFrac, 0.5, "50% cap stays (env default)");
  assert.equal(c.capReview.needDecided, 30);
  assert.equal(c.capReview.haveDecided, 0);
  assert.equal(c.capReview.met, false, "empty cohort → criterion not met, cap unchanged");
  assert.match(c.capReview.note, /копим|решённых/);
});
