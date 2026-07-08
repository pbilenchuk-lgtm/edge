import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase, migrateSharesToAggressive, migrateSharesAllPairs, migrateSharesGrid } from "../src/lib/seed.js";
import { seedRiskProfiles } from "../src/lib/riskConfig.js";
import { loadPolymarketConfig } from "../src/lib/polymarket.js";
import * as R from "../src/lib/repo.js";

test("loadPolymarketConfig: taker fee defaults to the real Polymarket SPORTS rate (0.75%)", () => {
  assert.equal(loadPolymarketConfig({}).exec.takerFeeRate, 0.0075);
  // env still overrides for a schedule change
  assert.equal(loadPolymarketConfig({ POLYMARKET_TAKER_FEE_RATE: "0.01" }).exec.takerFeeRate, 0.01);
});

test("migrateSharesAllPairs: every football category gets all 3×3 pairs, evenly, once", () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Футбол");
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-a", sport_id: "football", name: "A", budget: 900, external_league: null, created_at: "t" });
  R.upsertCompetition(db, { id: "pm-tennis", sport_id: "tennis", name: "T", budget: 900, external_league: null, created_at: "t" });

  migrateSharesAllPairs(db, "t");

  const rows = R.sharesForComp(db, "pm-a");
  assert.equal(rows.length, 9, "3 strategists × 3 profiles = 9 pairs");
  assert.deepEqual([...new Set(rows.map((r) => r.risk_profile_id))].sort(), ["aggressive", "conservative", "medium"]);
  assert.deepEqual([...new Set(rows.map((r) => r.strategy_id))].sort(), ["live_xg", "overreaction", "prematch_value"]);
  assert.ok(rows.every((r) => r.pct === rows[0].pct), "funds split evenly across pairs");
  assert.ok(rows[0].pct > 11 && rows[0].pct < 12, `~11.11% each, got ${rows[0].pct}`);
  // non-football category untouched
  assert.equal(R.sharesForComp(db, "pm-tennis").length, 0, "tennis has no strategists → no pairs");
  // idempotent — a later manual reallocation survives a re-run
  R.clearShares(db, "pm-a");
  migrateSharesAllPairs(db, "t2");
  assert.equal(R.sharesForComp(db, "pm-a").length, 0, "re-run no-ops after the marker is set");
});

test("migrateSharesGrid: full strategist × ALL-profiles grid, even budget, re-lays on profile-set change", () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "pm-a", sport_id: "football", name: "A", budget: 1200, external_league: null, created_at: "t" });
  seedRiskProfiles(db, "t"); // 3 presets

  migrateSharesGrid(db, "t");
  let rows = R.sharesForComp(db, "pm-a");
  assert.equal(rows.length, 9, "3 strategists × 3 profiles");

  // user adds a 4th custom profile («Lite») → next boot re-lays the grid as 12
  R.upsertRiskProfile(db, { id: "lite", name: "Lite", content: JSON.stringify({}), sort: 9, created_at: "t" });
  migrateSharesGrid(db, "t2");
  rows = R.sharesForComp(db, "pm-a");
  assert.equal(rows.length, 12, "3 strategists × 4 profiles = 12 pairs");
  assert.equal([...new Set(rows.map((r) => r.risk_profile_id))].length, 4, "all four profiles present");
  assert.ok(rows.every((r) => r.pct === rows[0].pct), "budget split evenly");
  assert.ok(rows[0].pct > 8 && rows[0].pct < 9, `~8.33% each, got ${rows[0].pct}`);
  // budget set to pairs × $1000, and each pair floors to EXACTLY $1000
  const comp = R.listCompetitions(db).find((c) => c.id === "pm-a")!;
  assert.equal(comp.budget, 12000, "budget = 12 pairs × $1000");
  assert.equal(Math.floor(comp.budget * rows[0].pct / 100), 1000, "every pair funded with exactly $1000");

  // stable profile set → a manual reallocation survives (no re-run)
  R.setShare(db, { competition_id: "pm-a", strategy_id: "overreaction", risk_profile_id: "lite", pct: 40 });
  migrateSharesGrid(db, "t3");
  assert.equal(R.sharesForComp(db, "pm-a").find((r) => r.strategy_id === "overreaction" && r.risk_profile_id === "lite")!.pct, 40, "manual edit preserved while profile set unchanged");
});

test("migrateSharesToAggressive: every share → aggressive, live bets retagged, idempotent", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // sanity: seeded shares exist on some competition
  const comp = R.listCompetitions(db).find((c) => R.sharesForComp(db, c.id).length > 0)!;
  assert.ok(comp, "a seeded competition has shares");
  const before = R.sharesForComp(db, comp.id);
  const totalBefore = before.reduce((a, s) => a + s.pct, 0);
  assert.ok(before.some((s) => s.risk_profile_id !== "aggressive"), "starts on a non-aggressive profile");

  // a live bet tagged medium should be retagged; a settled one must NOT be
  const strat = before[0].strategy_id;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 10, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertBet(db, { id: "open-1", match_id: mid, strategy_id: strat, risk_profile_id: "medium", market_label: "X", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.5, stake: 100, rationale: null, entered_minute: "10'", result: null, payout: null, settled_by: null, created_at: "t" });
  R.insertBet(db, { id: "done-1", match_id: mid, strategy_id: strat, risk_profile_id: "medium", market_label: "Y", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 100, closing_price: 100, ai_prob: 0.5, stake: 100, rationale: null, entered_minute: "10'", result: "won", payout: 200, settled_by: "settlement", created_at: "t" });

  migrateSharesToAggressive(db, "2026-07-07T00:00:00Z");

  const after = R.sharesForComp(db, comp.id);
  assert.ok(after.every((s) => s.risk_profile_id === "aggressive"), "all shares now aggressive");
  assert.equal(after.reduce((a, s) => a + s.pct, 0), totalBefore, "total pct preserved");
  assert.equal(R.getBet(db, "open-1")!.risk_profile_id, "aggressive", "open bet retagged");
  assert.equal(R.getBet(db, "done-1")!.risk_profile_id, "medium", "settled bet keeps its historical tag");

  // idempotent — a later manual switch back to medium survives a re-run
  R.setShare(db, { competition_id: comp.id, strategy_id: strat, risk_profile_id: "medium", pct: 5 });
  migrateSharesToAggressive(db, "2026-07-08T00:00:00Z");
  assert.ok(R.sharesForComp(db, comp.id).some((s) => s.risk_profile_id === "medium"), "re-run is a no-op after the marker is set");
});
