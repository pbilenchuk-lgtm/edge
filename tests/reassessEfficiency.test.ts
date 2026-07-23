import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildReassessEfficiency } from "../src/lib/reassessEfficiency.js";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  return db;
}
function bet(db: any, o: { id: string; match: string; status: string; created: string }) {
  R.insertMatch(db, { id: o.match, competition_id: "epl", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "t", minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: o.match } as any);
  R.insertBet(db, { id: o.id, match_id: o.match, strategy_id: "prematch_value", risk_profile_id: "medium", market_label: "Over 1.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "предматч", result: null, payout: null, entry_meta: null, created_at: o.created } as any);
  db.prepare(`UPDATE bets SET status=? WHERE id=?`).run(o.status, o.id);
}

test("F5: calls-per-traded-match + gate-skip ratio, anchored denominator, baseline verdict", () => {
  const db = seed();
  R.metaSet(db, "reassess_counter_since", "2026-07-10T00:00:00Z", "t");
  R.metaSet(db, "reassess_llm_calls_total", "40", "t");
  R.metaSet(db, "reassess_gate_skips_total", "160", "t"); // gate short-circuited 160 of 200 ticks
  // 4 traded matches SINCE the anchor + 1 pre-anchor entry that must NOT count in the denominator.
  bet(db, { id: "b1", match: "m1", status: "settled_won", created: "2026-07-11T00:00:00Z" });
  bet(db, { id: "b2", match: "m2", status: "open", created: "2026-07-11T00:00:00Z" });
  bet(db, { id: "b3", match: "m3", status: "settled_lost", created: "2026-07-12T00:00:00Z" });
  bet(db, { id: "b4", match: "m4", status: "open", created: "2026-07-12T00:00:00Z" });
  bet(db, { id: "old", match: "m0", status: "settled_won", created: "2026-07-01T00:00:00Z" }); // pre-anchor
  bet(db, { id: "prop", match: "m5", status: "proposed", created: "2026-07-12T00:00:00Z" }); // not a real entry

  const rep = buildReassessEfficiency(db);
  assert.equal(rep.tradedMatches, 4, "pre-anchor + proposed excluded from the denominator");
  assert.equal(rep.callsPerTradedMatch, 10, "40 calls / 4 matches");
  assert.equal(rep.gateSkipRatioPct, 80, "160 skips / 200 ticks");
  assert.equal(rep.verdict, "below_baseline", "10 < 26 → the P0.4 gate cut the mill");
});

test("F5: insufficient when no traded matches / counters unbumped", () => {
  const db = seed();
  const rep = buildReassessEfficiency(db);
  assert.equal(rep.since, null);
  assert.equal(rep.callsPerTradedMatch, null);
  assert.equal(rep.gateSkipRatioPct, null);
  assert.equal(rep.verdict, "insufficient");
});
