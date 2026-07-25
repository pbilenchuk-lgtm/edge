import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import { addTeamAlias } from "../src/lib/teamAliases.js";
import { nameMatch, refreshTeamAliasOverlay } from "../src/lib/engine.js";

const now = "2026-07-25T00:00:00Z";
function db() { const d = openDb(":memory:"); initSchema(d); return d; }

// NOTE: refreshTeamAliasOverlay mutates a module-level cache, so these tests set/reset it explicitly to stay
// independent of order (a later test with an empty DB re-asserts the default no-op).

test("empty overlay: nameMatch behaves exactly as before (a synthetic mismatch stays unmatched)", () => {
  const d = db();
  refreshTeamAliasOverlay(d); // empty
  assert.equal(nameMatch("Abcville", "Xyztown United"), false, "no alias → no bridge");
  assert.equal(nameMatch("West Ham", "West Ham United"), true, "static behavior intact");
});

test("an added alias bridges a previously-unmatched pair on the next refresh", () => {
  const d = db();
  refreshTeamAliasOverlay(d);
  assert.equal(nameMatch("Abcville", "Xyztown United"), false);
  addTeamAlias(d, "abcville", "xyztown", now);
  refreshTeamAliasOverlay(d);                 // sprint applies the discovery
  assert.equal(nameMatch("Abcville", "Xyztown United"), true, "alias canonicalizes the token → subset matches");
});

test("SAFETY: an alias cannot force a FALSE match — the distinctive-token subset gate still holds", () => {
  const d = db();
  // a careless alias mapping 'wanderers' → 'rovers'
  addTeamAlias(d, "wanderers", "rovers", now);
  refreshTeamAliasOverlay(d);
  // two genuinely different clubs that share only the aliased suffix must STILL not match (bristol ≠ wolverhampton)
  assert.equal(nameMatch("Wolverhampton Wanderers", "Bristol Rovers"), false, "other distinctive tokens differ → blocked");
  // but the same club across the alias does match
  assert.equal(nameMatch("Wolverhampton Wanderers", "Wolverhampton Rovers"), true);
});

test("reset: empty DB overlay restores the no-op", () => {
  const d = db();
  refreshTeamAliasOverlay(d);
  assert.equal(nameMatch("Abcville", "Xyztown United"), false);
});
