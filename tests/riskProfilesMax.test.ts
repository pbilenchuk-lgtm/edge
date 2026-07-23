import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { canonicalProfileId, isMaxProfile, isMainProfile, MAX_PROFILE_ID } from "../src/lib/riskProfiles.js";
import { migrateRenameRpLiteToMax, getProfileConfig } from "../src/lib/riskConfig.js";

test("riskProfiles helpers: legacy rp-lite* folds to max; trio are main", () => {
  assert.equal(canonicalProfileId("rp-lite-mrca9dz8"), "max");
  assert.equal(canonicalProfileId("rp-lite-anything"), "max");
  assert.equal(canonicalProfileId("max"), "max");
  assert.equal(canonicalProfileId("medium"), "medium");
  assert.equal(isMaxProfile("rp-lite-mrca9dz8"), true);
  assert.equal(isMaxProfile("max"), true);
  assert.equal(isMaxProfile("aggressive"), false);
  for (const p of ["aggressive", "medium", "conservative"]) assert.equal(isMainProfile(p), true, `${p} is main`);
  assert.equal(isMainProfile("max"), false, "max is NOT a main-line profile");
  assert.equal(isMainProfile("rp-lite-mrca9dz8"), false, "legacy alias of max is not main either");
});

test("migrateRenameRpLiteToMax: renames the profile + repoints shares, does NOT rewrite historical bets; getProfileConfig aliases", () => {
  const db = openDb(":memory:"); initSchema(db);
  // A legacy super-risky profile, a share pointing to it, and a HISTORICAL settled bet placed under it.
  R.upsertRiskProfile(db, { id: "rp-lite-mrca9dz8", name: "rp-lite", content: JSON.stringify({ sizing: { kelly_fraction_base: 0.5 } }), sort: 9, created_at: "t" } as any);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "OVR", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  R.setShare(db, { competition_id: "epl", strategy_id: "overreaction", risk_profile_id: "rp-lite-mrca9dz8", pct: 50 });
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  R.insertBet(db, { id: "hist", match_id: "m1", strategy_id: "overreaction", risk_profile_id: "rp-lite-mrca9dz8", market_label: "Over 0.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: 100, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "10'", result: "won", payout: 200, settled_at: "t", entry_meta: null, created_at: "t" } as any);

  migrateRenameRpLiteToMax(db, "now");

  // profile renamed
  assert.ok(R.getRiskProfileRow(db, "max"), "a `max` profile now exists");
  assert.equal(R.getRiskProfileRow(db, "rp-lite-mrca9dz8"), undefined, "the legacy profile row is gone");
  // active shares repointed
  const shares = R.sharesForComp(db, "epl").map((s: any) => s.risk_profile_id);
  assert.ok(shares.includes("max"), "the active share now points to max");
  assert.ok(!shares.includes("rp-lite-mrca9dz8"), "no share left on the legacy id");
  // HISTORICAL bet is NOT rewritten (no reconstructed history) — it keeps the legacy id, aliased on read
  assert.equal(R.getBet(db, "hist")!.risk_profile_id, "rp-lite-mrca9dz8", "historical bet keeps its original profile id");
  assert.equal(canonicalProfileId(R.getBet(db, "hist")!.risk_profile_id), "max", "readers alias it to max");
  // config resolves for BOTH the new id and a lingering legacy id (an open bet placed pre-rename)
  assert.equal(getProfileConfig(db, "max").sizing.kelly_fraction_base, 0.5, "max config kept as-is (Kelly ×0.50)");
  assert.equal(getProfileConfig(db, "rp-lite-mrca9dz8").sizing.kelly_fraction_base, 0.5, "legacy id aliases to the max config");

  // idempotent — a second run is a no-op
  migrateRenameRpLiteToMax(db, "now2");
  assert.ok(R.getRiskProfileRow(db, "max"));
  assert.equal(MAX_PROFILE_ID, "max");
});
