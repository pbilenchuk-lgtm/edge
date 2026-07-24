import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import { recordPmvShadowSignal } from "../src/lib/tennisPmvShadow.js";
import { buildTennisMaturity } from "../src/lib/tennisMaturity.js";

const NOW = "2026-07-24T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

test("tennisMaturity: empty cohorts → not matured, no rate, honest null ETA", () => {
  const db = openDb(":memory:"); initSchema(db);
  const r = buildTennisMaturity(db, { nowMs: NOW_MS });
  const pmv = r.cohorts.find((c) => c.cohort === "pmv_brier")!;
  const sv = r.cohorts.find((c) => c.cohort === "set_value_shadow")!;
  assert.equal(pmv.haveN, 0);
  assert.equal(pmv.needN, 40, "PMV Brier criterion is n≥40");
  assert.equal(pmv.matured, false);
  assert.equal(pmv.ratePerDay, null, "no resolved rows → no rate");
  assert.equal(pmv.etaDays, null, "no rate → honest null ETA, not a fabricated number");
  assert.equal(sv.needN, 40, "set_value verdict-bin criterion is n≥40");
  assert.equal(sv.secondary?.needN, 80, "and total n≥80");
  assert.equal(sv.matured, false);
  assert.match(r.note, /flag_only НЕ разблокируется/);
});

test("tennisMaturity: resolved PMV rows give a rate and an ETA toward n/40", () => {
  const db = openDb(":memory:"); initSchema(db);
  // 7 resolved PMV shadow rows over the trailing window → a non-zero rate; still far from n=40.
  for (let i = 0; i < 7; i++) {
    recordPmvShadowSignal(db, { matchId: "m" + i, label: "L" + i, family: "set_winner", side: "first", firstIsP1: true, theoCents: 60, midCents: 55, deviation: 5, delta: 5, bookUsd: 100, tour: "ATP", surface: "hard", epoch: "shadow-s1", at: NOW });
    db.prepare(`UPDATE pmv_shadow_signals SET status='won', hits=1, resolved_at=? WHERE match_id=?`).run(NOW, "m" + i);
  }
  const r = buildTennisMaturity(db, { nowMs: NOW_MS, windowDays: 14 });
  const pmv = r.cohorts.find((c) => c.cohort === "pmv_brier")!;
  assert.equal(pmv.haveN, 7, "7 scored rows count toward the Brier base");
  assert.equal(pmv.matured, false, "7 < 40 → still accruing");
  assert.ok(pmv.ratePerDay && pmv.ratePerDay > 0, "a non-zero resolve rate");
  assert.ok(pmv.etaDays && pmv.etaDays > 0, "an ETA toward n=40 at that rate");
});
