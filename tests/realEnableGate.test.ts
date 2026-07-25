import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import { setOperatorModeControl, ON_CONFIRM_PHRASE } from "../src/lib/executor/realControl.js";

// Test #3 (audit Part 8 / spec 2.2): arming REAL money must be ENFORCED, not advisory. The typed phrase alone
// is not enough — buildPhaseFReadiness must verdict `go` AND THESIS_MATCH_CAP_USD must be set; otherwise the
// transition refuses and prints the failing checks. Only an explicit, logged override bypasses.
// NOTE: setOperatorModeControl reads process.env (not a passed env), so cap sub-tests mutate + restore it.

test("2.2 C2: the typed phrase is still required (a bare confirm is rejected)", () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const r = setOperatorModeControl(db, "on", true, "owner", "t", "wrong phrase");
  assert.equal(r.ok, false);
  assert.equal(r.needPhrase, true);
});

test("2.2 C2: correct phrase but a failing readiness verdict + unset cap → BLOCKED with reasons", () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const saved = process.env.THESIS_MATCH_CAP_USD;
  delete process.env.THESIS_MATCH_CAP_USD; // cap unset → one of the two failing checks
  try {
    const r = setOperatorModeControl(db, "on", true, "owner", "t", ON_CONFIRM_PHRASE);
    assert.equal(r.ok, false, "fresh DB → readiness=hold (no whitelist/dry-fill) and cap unset → refused");
    assert.match(r.note, /заблокировано/);
    assert.match(r.note, /phase_f_readiness|THESIS_MATCH_CAP_USD/);
  } finally { if (saved === undefined) delete process.env.THESIS_MATCH_CAP_USD; else process.env.THESIS_MATCH_CAP_USD = saved; }
});

test("2.2 C2: setting the cap alone does NOT unblock while readiness still holds", () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const saved = process.env.THESIS_MATCH_CAP_USD;
  process.env.THESIS_MATCH_CAP_USD = "250"; // cap set, but a fresh DB still fails Phase-F readiness
  try {
    const r = setOperatorModeControl(db, "on", true, "owner", "t", ON_CONFIRM_PHRASE);
    assert.equal(r.ok, false, "readiness=hold alone keeps it blocked");
    assert.match(r.note, /phase_f_readiness/);
  } finally { if (saved === undefined) delete process.env.THESIS_MATCH_CAP_USD; else process.env.THESIS_MATCH_CAP_USD = saved; }
});

test("2.2 C2: an explicit readinessOverride bypasses the gate (and is accepted)", () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const saved = process.env.THESIS_MATCH_CAP_USD;
  delete process.env.THESIS_MATCH_CAP_USD;
  try {
    const r = setOperatorModeControl(db, "on", true, "owner", "t", ON_CONFIRM_PHRASE, true);
    assert.equal(r.ok, true, "explicit override arms despite the failing checks (logged separately)");
  } finally { if (saved === undefined) delete process.env.THESIS_MATCH_CAP_USD; else process.env.THESIS_MATCH_CAP_USD = saved; }
});
