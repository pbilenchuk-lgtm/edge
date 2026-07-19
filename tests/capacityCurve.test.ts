import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildCapacityCurve } from "../src/lib/capacityCurve.js";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "OVR", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}
const bet = (db: any, o: { status: string; entry: number; stake: number; result: string | null }) => {
  const id = R.uid();
  R.insertBet(db, { id, match_id: "m1", strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: o.entry, entry_price: o.entry, current_price: o.entry, closing_price: null, ai_prob: 0.6, stake: o.stake, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" } as any);
  db.prepare(`UPDATE bets SET status=?, result=?, payout=? WHERE id=?`).run(o.status, o.result, o.result === "won" ? o.stake * 100 / o.entry : 0, id);
  return id;
};
const fill = (db: any, betId: string, slipCents: number, notional: number) =>
  R.insertFillCost(db, { id: R.uid(), bet_id: betId, match_id: "m1", competition_id: "epl", strategy_id: "overreaction", profile_id: "medium", side: "buy", shares: notional * 2, notional_usd: notional, quote_cents: 50, vwap_cents: 50 + slipCents, fee_cents: 0, fee_usd: 0, slip_cents: slipCents, slip_usd: 0, from_book: 1, created_at: "t" } as any);

test("capacity: base ×1 ≈ realised return; return% decays as bankroll grows (liquidity ceiling)", () => {
  const db = seed();
  const a = bet(db, { status: "settled_won", entry: 50, stake: 100, result: "won" }); fill(db, a, 2, 100);  // c=0.02 ¢/$
  const b = bet(db, { status: "settled_won", entry: 50, stake: 100, result: "won" }); fill(db, b, 2, 100);
  bet(db, { status: "settled_lost", entry: 50, stake: 100, result: "lost" });          // no fill → fallback c=median
  bet(db, { status: "settled_void", entry: 50, stake: 100, result: null });             // void → skipped

  const cap = buildCapacityCurve(db, {});
  assert.equal(cap.betsModeled, 3, "2 won + 1 lost; void excluded");
  assert.equal(cap.anchored, 2);
  assert.equal(cap.fallback, 1);
  assert.equal(cap.voidSkipped, 1);
  assert.equal(cap.rows.length, 5, "5k/20k/50k/100k/200k");

  const base = cap.rows[0], top = cap.rows.at(-1)!;
  assert.equal(base.bank, 5000);
  assert.ok(base.returnPct! > 1.5 && base.returnPct! < 2.5, `base ~+2% (two ~+$100 winners, one −$100), got ${base.returnPct}`);
  // return% must strictly decay with size — deeper into the book, worse entry, lower %
  for (let i = 1; i < cap.rows.length; i++) assert.ok(cap.rows[i].returnPct! < cap.rows[i - 1].returnPct!, `row ${i} return% must drop`);
  assert.ok(top.returnPct! < base.returnPct!, "the biggest bankroll earns a LOWER % than the smallest");
  // entry price degrades (walks up the book) as size grows
  assert.ok(top.avgEntryCents! > base.avgEntryCents!, "avg entry cents worsens at scale");
});

test("capacity: no fill_costs at all → all fallback with median 0, still produces a curve", () => {
  const db = seed();
  bet(db, { status: "settled_won", entry: 40, stake: 100, result: "won" });
  bet(db, { status: "settled_lost", entry: 40, stake: 100, result: "lost" });
  const cap = buildCapacityCurve(db, {});
  assert.equal(cap.anchored, 0);
  assert.equal(cap.fallback, 2);
  assert.equal(cap.medianSlipPer1k, null, "no anchored slip → no median");
  // with c=0 (no modelled slip), return% is flat across bankrolls — honest: we can't see the ceiling
  assert.ok(cap.rows.every((r) => Math.abs(r.returnPct! - cap.rows[0].returnPct!) < 0.01), "flat without slip data");
});
