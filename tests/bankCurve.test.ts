import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { treasuryBankCurve } from "../src/lib/view.js";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}
const settled = (db: any, o: { status: string; stake: number; payout: number; at: string }) => {
  const id = R.uid();
  R.insertBet(db, { id, match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: o.stake, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" } as any);
  db.prepare(`UPDATE bets SET status=?, payout=?, settled_at=? WHERE id=?`).run(o.status, o.payout, o.at, id);
};

test("bank curve: base = current − realized; ends at current; void contributes 0", () => {
  const db = seed();
  R.setTreasury(db, 5100);
  settled(db, { status: "settled_won", stake: 40, payout: 120, at: "2026-07-16T10:00:00Z" });  // +80
  settled(db, { status: "settled_lost", stake: 40, payout: 0, at: "2026-07-17T10:00:00Z" });   // −40
  settled(db, { status: "settled_void", stake: 40, payout: 40, at: "2026-07-18T10:00:00Z" });  // 0

  const c = treasuryBankCurve(db);
  assert.equal(c.current, 5100);
  assert.equal(c.realized, 40, "80 − 40 + 0");
  assert.equal(c.base, 5060, "current − realized");
  assert.equal(c.points[0].at, "старт");
  assert.equal(c.points[0].equity, 5060, "curve starts at base");
  assert.equal(c.points.at(-1)!.equity, 5100, "curve ends at the current balance");
  // one point per settle day + the start point
  assert.deepEqual(c.points.map((p) => p.equity), [5060, 5140, 5100, 5100]);
});

test("bank curve: no settled bets → single start point at current balance", () => {
  const db = seed();
  R.setTreasury(db, 5000);
  const c = treasuryBankCurve(db);
  assert.equal(c.base, 5000);
  assert.equal(c.realized, 0);
  assert.equal(c.points.length, 1);
  assert.equal(c.points[0].equity, 5000);
});

test("bank curve: same-day settles collapse to one end-of-day point", () => {
  const db = seed();
  R.setTreasury(db, 5000);
  settled(db, { status: "settled_won", stake: 50, payout: 90, at: "2026-07-16T10:00:00Z" });  // +40
  settled(db, { status: "settled_lost", stake: 50, payout: 0, at: "2026-07-16T20:00:00Z" });  // −50 (same day)
  const c = treasuryBankCurve(db);
  assert.equal(c.realized, -10);
  assert.equal(c.base, 5010, "5000 − (−10)");
  assert.equal(c.points.length, 2, "start + one day");
  assert.equal(c.points.at(-1)!.equity, 5000, "end-of-day = base −10 = current");
});
