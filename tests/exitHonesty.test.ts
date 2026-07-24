import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import * as RR from "../src/lib/realRepo.js";
import { buildExitHonesty } from "../src/lib/executor/exitHonesty.js";

const NOW = "2026-07-24T00:00:00.000Z";
function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: NOW } as any);
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: NOW });
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: NOW, minute: 90, score_home: 2, score_away: 1, final_score: "2:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}
// an exit fill on a twin bet with a given settle status.
function exit(db: any, decision: string, betStatus: string, exitCents: number, proceeds: number) {
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 40, entry_price: 40, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 40, rationale: "r", entered_minute: null, result: null, payout: null, decision_id: decision, created_at: NOW } as any);
  db.prepare(`UPDATE bets SET status=? WHERE id=?`).run(betStatus, bid);
  const oid = R.uid();
  RR.insertRealOrder(db, { id: oid, client_order_id: oid, exchange_order_id: null, decision_id: decision, strategy_id: "prematch_value", profile_id: "medium", match_id: "m1", token_id: "0xT", side: "SELL", leg: "exit", limit_price_cents: 95, size_usd: proceeds, tif_sec: 30, code_version: "e7", whitelist_version: 1, note: "x", created_at: NOW } as any);
  RR.insertRealFill(db, { order_id: oid, client_order_id: oid, token_id: "0xT", side: "SELL", size_usd: proceeds, price_cents: exitCents, fee_usd: 0, dry: 1, at: NOW, created_at: NOW });
}

test("exitHonesty: early sales of eventual WINNERS at ~100¢ → benign, small forgone", () => {
  const db = seed();
  for (let i = 0; i < 6; i++) exit(db, "won-" + i, "settled_won", 99.9, 100);
  const r = buildExitHonesty(db, { EXIT_HONESTY_MATERIAL_USD: "50" });
  assert.equal(r.wonExits, 6);
  assert.equal(r.suspectLostProceedsUsd, 0);
  assert.equal(r.verdict, "benign");
  // forgone vs holding to 100¢: 6 × 100 × (100/99.9 − 1) ≈ $0.6
  assert.ok(Math.abs(r.benignWonForgoneUsd) < 2, "gave up only a hair by not holding");
});

test("exitHonesty: selling future-ZEROs at ~100¢ → material_optimism, suspect pile surfaced", () => {
  const db = seed();
  for (let i = 0; i < 4; i++) exit(db, "won-" + i, "settled_won", 99.9, 50);
  for (let i = 0; i < 3; i++) exit(db, "lost-" + i, "settled_lost", 99.5, 80); // sold high on a future 0
  const r = buildExitHonesty(db, { EXIT_HONESTY_MATERIAL_USD: "50" });
  assert.equal(r.lostExits, 3);
  assert.equal(r.suspectLostProceedsUsd, 240, "3 × $80 booked on positions that settled 0");
  assert.equal(r.suspectHighPriceUsd, 240, "all sold at 99.5¢ ≥ 90¢ floor → true optimism");
  assert.equal(r.suspectLowPriceUsd, 0);
  assert.equal(r.verdict, "material_optimism");
  assert.equal(r.avgSuspectExitCents, 99.5);
  assert.equal(r.topSuspect[0].proceedsUsd, 80);
  assert.equal(r.topSuspect[0].band, "high");
});

test("exitHonesty: cheap defensive cuts of future-ZEROs are NOT optimism → benign", () => {
  const db = seed();
  for (let i = 0; i < 5; i++) exit(db, "won-" + i, "settled_won", 99.9, 50);
  // future-0s sold cheaply (defensive cuts that recovered value) — must NOT count as optimism.
  for (let i = 0; i < 4; i++) exit(db, "cut-" + i, "settled_lost", 20, 60);
  const r = buildExitHonesty(db, { EXIT_HONESTY_MATERIAL_USD: "50" });
  assert.equal(r.lostExits, 4);
  assert.equal(r.suspectLostProceedsUsd, 240, "gross pile still $240");
  assert.equal(r.suspectHighPriceUsd, 0, "none sold above the 90¢ optimism floor");
  assert.equal(r.suspectLowPriceUsd, 240, "all $240 are cheap defensive cuts");
  assert.equal(r.verdict, "benign", "cheap cuts of future-0s are the exit working, not optimism");
});

test("exitHonesty: unresolved twins are quarantined; too few resolved → insufficient", () => {
  const db = seed();
  exit(db, "open-1", "open", 99.9, 100);
  exit(db, "won-1", "settled_won", 99.9, 100);
  const r = buildExitHonesty(db, { EXIT_HONESTY_MATERIAL_USD: "50" });
  assert.equal(r.unresolvedExits, 1);
  assert.equal(r.verdict, "insufficient");
});
