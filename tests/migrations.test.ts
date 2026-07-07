import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase, migrateSharesToAggressive } from "../src/lib/seed.js";
import { loadPolymarketConfig } from "../src/lib/polymarket.js";
import * as R from "../src/lib/repo.js";

test("loadPolymarketConfig: taker fee defaults to the real Polymarket SPORTS rate (0.75%)", () => {
  assert.equal(loadPolymarketConfig({}).exec.takerFeeRate, 0.0075);
  // env still overrides for a schedule change
  assert.equal(loadPolymarketConfig({ POLYMARKET_TAKER_FEE_RATE: "0.01" }).exec.takerFeeRate, 0.01);
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
