import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";

// Guards the cold-start perf fix in buildAppData: the ~12 per-match DETAIL queries are the
// several-second event-loop freeze that starves Render's deploy port probe. They only feed a
// match's detail card, so OLD finished matches get a LIGHT record (identity + score + settled
// bets, no detail queries) while active + recently-finished matches stay FULL. The full log of
// any old match is still available on demand via the Логи download.
test("buildAppData: old finished matches build LIGHT (detail skipped); recent stay FULL", async () => {
  const { buildAppData } = await import("../src/lib/view.js");
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" } as any);
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const recent = "m_recent", old = "m_old";
  R.insertMatch(db, { id: recent, competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: iso(now - 3_600_000), minute: null, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: iso(now - 1_800_000), duration: null, end_note: null, external_ref: recent } as any);
  R.insertMatch(db, { id: old, competition_id: "epl", home: "C", away: "D", state: "finished", lineup_out: true, kickoff_at: iso(now - 40 * 86_400_000), minute: null, score_home: 2, score_away: 2, final_score: "2:2", kickoff_time: null, end_time: iso(now - 40 * 86_400_000), duration: null, end_note: null, external_ref: old } as any);
  const mkt = (mid: string, tok: string) => R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 50, ai_prob: 0.5, liquidity: "1000", external_ref: tok, snapshot_at: "t", is_closing: false } as any);
  mkt(recent, "t1"); mkt(old, "t2");

  const app = buildAppData(db) as any;
  assert.ok(app.matchDb[recent].markets.length > 0, "recent finished keeps its markets (full detail)");
  assert.equal(app.matchDb[old].markets.length, 0, "old finished is light — detail queries skipped");
  // The light record still carries everything lists / Портфель / «Логи» need:
  assert.equal(app.matchDb[old].finalScore, "2:2", "score preserved");
  assert.equal(app.matchDb[old].scoreHome, 2);
  assert.ok(app.matchDb[old].endIso, "endIso present for chronological sort on the Логи page");
  assert.equal(app.matchDb[old].home, "C");
});
