import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildOverreactionGate } from "../src/lib/overreactionGate.js";

const NOW = "2026-07-17T12:00:00.000Z";
function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "Overreaction", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: NOW } as any);
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: NOW });
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: NOW, minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}
// insert a settled Overreaction bet and stamp status / settled_by / epoch directly.
function settledBet(db: any, o: { status: string; settledBy?: string | null; code?: string | null; exit?: string | null }) {
  const id = R.uid();
  R.insertBet(db, { id, match_id: "m1", strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "30'", result: null, payout: null, decision_id: id, created_at: NOW } as any);
  db.prepare(`UPDATE bets SET status=?, settled_by=?, code_version=?, exit_code_version=? WHERE id=?`)
    .run(o.status, o.settledBy ?? null, o.code ?? "e5·m1", o.exit ?? o.code ?? "e5·m1", id);
  return id;
}

test("overreactionGate: clean-epoch resolution cycles count; void/cash-out/pre-e5/cross-epoch excluded", () => {
  const db = seed();
  settledBet(db, { status: "settled_won", code: "e5·m1" });                 // counts (won)
  settledBet(db, { status: "settled_lost", code: "e6·m1" });                // counts (lost)
  settledBet(db, { status: "settled_won", code: "e7·m1·opus48" });          // counts (won)
  settledBet(db, { status: "settled_void", code: "e5·m1" });                // excluded: void
  settledBet(db, { status: "settled_won", settledBy: "early", code: "e5·m1" }); // excluded: cash-out
  settledBet(db, { status: "settled_won", code: "e4·m1" });                 // excluded: pre-e5
  settledBet(db, { status: "settled_lost", code: "e5·m1", exit: "e6·m1" }); // excluded: cross-epoch

  const g = buildOverreactionGate(db);
  assert.equal(g.cleanCycles, 3);
  assert.equal(g.won, 2);
  assert.equal(g.lost, 1);
  assert.equal(g.progress, "3/30");
  assert.equal(g.verdict, "accruing");
  assert.equal(g.excluded.void, 1);
  assert.equal(g.excluded.cashOut, 1);
  assert.equal(g.excluded.preEpoch, 1);
  assert.equal(g.excluded.crossEpoch, 1);
  assert.equal(g.byEpoch["e7"].won, 1);
});

test("overreactionGate: gate opens at n≥30 clean cycles", () => {
  const db = seed();
  for (let i = 0; i < 30; i++) settledBet(db, { status: i % 2 ? "settled_won" : "settled_lost", code: "e7·m1" });
  const g = buildOverreactionGate(db);
  assert.equal(g.cleanCycles, 30);
  assert.equal(g.verdict, "gate_open");
});
