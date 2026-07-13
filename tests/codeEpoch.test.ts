import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { CODE_VERSION } from "../src/lib/betMeta.js";
import { modelEpoch, effectiveCodeVersion, bumpModelEpoch } from "../src/lib/codeEpoch.js";

const T = "2026-07-13T18:00:00.000Z";

test("modelEpoch defaults to 1 on a fresh DB; effectiveCodeVersion combines both epochs", () => {
  const db = openDb(":memory:");
  assert.equal(modelEpoch(db), 1);
  assert.equal(effectiveCodeVersion(db), `${CODE_VERSION}·m1`);
});

test("bumpModelEpoch advances the counter and the stamped label", () => {
  const db = openDb(":memory:");
  assert.equal(bumpModelEpoch(db, T), 2);
  assert.equal(effectiveCodeVersion(db), `${CODE_VERSION}·m2`);
  assert.equal(bumpModelEpoch(db, T), 3);
  assert.equal(effectiveCodeVersion(db), `${CODE_VERSION}·m3`);
});

test("a corrupt/absent epoch value reads back as 1 (never throws, never < 1)", () => {
  const db = openDb(":memory:");
  R.metaSet(db, "model_epoch", "not-a-number", T);
  assert.equal(modelEpoch(db), 1);
  R.metaSet(db, "model_epoch", "0", T);
  assert.equal(modelEpoch(db), 1);
  R.metaSet(db, "model_epoch", "4.9", T);
  assert.equal(modelEpoch(db), 4); // floored
});
