import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { sweepAbandonedMatches, BROKEN_NOTE } from "../src/lib/staleSweep.js";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString(); // h hours from NOW

function db0() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис"); R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertStrategy(db, { id: "tennis_set_value", sport_id: "tennis", name: "SV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  return db;
}
const mk = (db: any, o: { id: string; comp: string; state: string; kickoff: string | null }) =>
  R.insertMatch(db, { id: o.id, competition_id: o.comp, home: "A", away: "B", state: o.state, lineup_out: o.state === "lineup", kickoff_at: o.kickoff, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: o.id } as any);
const bet = (db: any, mid: string, status: string) => {
  const id = R.uid();
  R.insertBet(db, { id, match_id: mid, strategy_id: "tennis_set_value", risk_profile_id: "medium", market_label: "A", status, proposed_price: 40, entry_price: 40, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 50, rationale: "r", entered_minute: "сет 2", result: status === "settled_won" ? "won" : null, payout: status === "settled_won" ? 90 : null, created_at: "t" } as any);
  return id;
};

test("sweep: past-kickoff tennis (lineup) never live → abandoned + BROKEN_NOTE", () => {
  const db = db0();
  mk(db, { id: "m1", comp: "atp", state: "lineup", kickoff: iso(-10) }); // 10h past
  const r = sweepAbandonedMatches(db, NOW);
  assert.equal(r.abandoned, 1);
  const m = R.getMatch(db, "m1")!;
  assert.equal(m.state, "finished");
  assert.equal(m.end_note, BROKEN_NOTE);
});

test("sweep: football live stuck 6h past kickoff → abandoned", () => {
  const db = db0();
  mk(db, { id: "m1", comp: "epl", state: "live", kickoff: iso(-6) });
  assert.equal(sweepAbandonedMatches(db, NOW).abandoned, 1);
  assert.equal(R.getMatch(db, "m1")!.state, "finished");
});

test("sweep: within threshold is UNTOUCHED (tennis 2h past, football 3h past)", () => {
  const db = db0();
  mk(db, { id: "t", comp: "atp", state: "lineup", kickoff: iso(-2) });   // <6h
  mk(db, { id: "f", comp: "epl", state: "live", kickoff: iso(-3) });     // <5h
  mk(db, { id: "fut", comp: "atp", state: "upcoming", kickoff: iso(+3) }); // future
  const r = sweepAbandonedMatches(db, NOW);
  assert.equal(r.abandoned + r.fixed, 0);
  assert.equal(R.getMatch(db, "t")!.state, "lineup");
  assert.equal(R.getMatch(db, "f")!.state, "live");
  assert.equal(R.getMatch(db, "fut")!.state, "upcoming");
});

test("sweep: open bet on an abandoned match is VOIDED (P&L 0)", () => {
  const db = db0();
  mk(db, { id: "m1", comp: "atp", state: "lineup", kickoff: iso(-10) });
  const bid = bet(db, "m1", "open");
  const r = sweepAbandonedMatches(db, NOW);
  assert.equal(r.abandoned, 1); assert.equal(r.voided, 1);
  const b = R.getBet(db, bid)!;
  assert.equal(b.status, "settled_void");
  assert.equal(b.payout, b.stake, "voided → payout=stake → P&L 0");
  assert.equal(R.getMatch(db, "m1")!.end_note, BROKEN_NOTE);
});

test("sweep: a match with a SETTLED bet resolved → state fixed to finished, NO broken marker, settled bet untouched", () => {
  const db = db0();
  mk(db, { id: "m1", comp: "atp", state: "lineup", kickoff: iso(-10) });
  const bid = bet(db, "m1", "settled_won");
  const r = sweepAbandonedMatches(db, NOW);
  assert.equal(r.fixed, 1); assert.equal(r.abandoned, 0);
  const m = R.getMatch(db, "m1")!;
  assert.equal(m.state, "finished");
  assert.equal(m.end_note, null, "played match → not flagged broken");
  const b = R.getBet(db, bid)!;
  assert.equal(b.status, "settled_won", "settled bet left intact");
});

test("sweep: no-kickoff junk (no bets, never scouted) → abandoned; no-kickoff WITH a bet is left alone", () => {
  const db = db0();
  mk(db, { id: "junk", comp: "atp", state: "upcoming", kickoff: null });     // no bets → junk
  mk(db, { id: "held", comp: "atp", state: "lineup", kickoff: null });       // has a bet → don't guess
  bet(db, "held", "open");
  const r = sweepAbandonedMatches(db, NOW);
  assert.equal(R.getMatch(db, "junk")!.state, "finished", "no-kickoff junk swept");
  assert.equal(R.getMatch(db, "held")!.state, "lineup", "no-kickoff match with a bet left alone");
  assert.ok(r.abandoned >= 1);
});

test("sweep: idempotent — a second pass changes nothing", () => {
  const db = db0();
  mk(db, { id: "m1", comp: "atp", state: "lineup", kickoff: iso(-10) });
  sweepAbandonedMatches(db, NOW);
  const r2 = sweepAbandonedMatches(db, NOW);
  assert.equal(r2.abandoned + r2.fixed + r2.voided, 0, "already finished → not re-swept");
});
