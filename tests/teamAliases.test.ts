import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import { getTeamAliases, listTeamAliases, addTeamAlias, removeTeamAlias } from "../src/lib/teamAliases.js";

const now = "2026-07-25T00:00:00Z";
function db() { const d = openDb(":memory:"); initSchema(d); return d; }

test("empty store → {} overlay and [] list (default no-op)", () => {
  const d = db();
  assert.deepEqual(getTeamAliases(d), {});
  assert.deepEqual(listTeamAliases(d), []);
});

test("addTeamAlias normalizes both sides to folded tokens; overlay is from→to", () => {
  const d = db();
  const r = addTeamAlias(d, "Neftçi", "Neftchi Baku".split(" ")[0], now); // "Neftçi" → "Neftchi"
  assert.ok(r.ok);
  assert.equal(r.from, "neftci");
  assert.equal(r.to, "neftchi");
  assert.deepEqual(getTeamAliases(d), { neftci: "neftchi" });
});

test("rejects empty / equal / over-long tokens", () => {
  const d = db();
  assert.ok(!addTeamAlias(d, "—", "x", now).ok, "empty fold → rejected");
  assert.ok(!addTeamAlias(d, "Wien", "wien", now).ok, "equal after normalization → rejected");
  assert.ok(!addTeamAlias(d, "a".repeat(41), "b", now).ok, "over-long → rejected");
  assert.deepEqual(getTeamAliases(d), {}, "no rejected alias persisted");
});

test("last write wins for the same from-token (a correction, not a duplicate)", () => {
  const d = db();
  addTeamAlias(d, "abcville", "wrongtown", now);
  addTeamAlias(d, "Abcville", "righttown", now);       // same from after fold → overwrites
  assert.deepEqual(getTeamAliases(d), { abcville: "righttown" });
  assert.equal(listTeamAliases(d).length, 1);
});

test("removeTeamAlias drops by normalized from-token", () => {
  const d = db();
  addTeamAlias(d, "abcville", "xyztown", now);
  addTeamAlias(d, "foo", "bar", now);
  const r = removeTeamAlias(d, "Abcville", now);
  assert.ok(r.ok);
  assert.equal(r.count, 1);
  assert.deepEqual(getTeamAliases(d), { foo: "bar" });
});
