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

test("п.2 (batch-4): updateBet stamps exit_code_version on the first settled transition; crossEpoch detects a deploy mid-life", async () => {
  const { crossEpoch, codeEpochOf } = await import("../src/lib/codeEpoch.js");
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "C", budget: 1000, external_league: null, created_at: T });
  R.insertStrategy(db, { id: "s", sport_id: "football", name: "S", tag: "s", color: null, version: 1, prompt: "", prompt_live: null, params: {}, model: "x", model_live: null, created_at: T } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: T, minute: 90, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  // Bet entered in a PAST code epoch (e0), still open.
  R.insertBet(db, { id: "b1", match_id: "m1", strategy_id: "s", risk_profile_id: "medium", market_label: "A", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "pre", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e0·m1", created_at: T } as any);
  // Settle it now (current epoch is CODE_VERSION·m1). updateBet must auto-stamp exit_code_version once.
  R.updateBet(db, "b1", { status: "settled_won", result: "won", payout: 200 });
  const b = R.getBet(db, "b1")!;
  assert.equal((b as any).exit_code_version, `${CODE_VERSION}·m1`, "exit epoch stamped at settle");
  assert.equal(codeEpochOf(b.code_version), "e0");
  assert.ok(crossEpoch(b), "e0 entry vs current exit epoch → cross_epoch");
  // A second updateBet must NOT overwrite the exit epoch.
  R.updateBet(db, "b1", { status: "settled_won", closing_price: 100 });
  assert.equal((R.getBet(db, "b1") as any).exit_code_version, `${CODE_VERSION}·m1`, "exit epoch stamped once, not overwritten");
  // A same-epoch cycle is NOT cross_epoch.
  R.insertBet(db, { id: "b2", match_id: "m1", strategy_id: "s", risk_profile_id: "medium", market_label: "A", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "pre", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: `${CODE_VERSION}·m1`, created_at: T } as any);
  R.updateBet(db, "b2", { status: "settled_lost", result: "lost", payout: 0 });
  assert.equal(crossEpoch(R.getBet(db, "b2")!), false, "same entry/exit epoch → not cross_epoch");
});
