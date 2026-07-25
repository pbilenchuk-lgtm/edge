import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { FOOTBALL_EPOCH } from "../src/lib/repo.js";
import { backfillFootballEpoch } from "../src/lib/footballIntegrity.js";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "pm-mls", sport_id: "football", name: "MLS", budget: 8000, external_league: "usa.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "pm-mls", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: 2, score_away: 1, final_score: "2:1", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: "m1" } as any);
  let i = 0;
  const bet = (codeVersion: string | null, exitCv: string | null) => {
    const id = `b${i++}`;
    R.insertBet(db, { id, match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "max", market_label: "Over 2.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 100, closing_price: 60, ai_prob: 0.7, stake: 40, rationale: "r", entered_minute: null, result: "won", payout: 80, settled_by: null, code_version: codeVersion, football_epoch: "epoch_unknown", created_at: "t" } as any);
    if (exitCv) db.prepare(`UPDATE bets SET exit_code_version=? WHERE id=?`).run(exitCv, id);
    return id;
  };
  return { db, bet };
}

test("epoch backfill: e5+ non-cross-epoch recovers to clean; pre-e5 / null / cross-epoch stay epoch_unknown; idempotent", () => {
  const { db, bet } = seed();
  const clean5 = bet("e5·m1·opus48", null);           // entry e5, never-settled exit → clean
  const clean6 = bet("e6·m2", "e6·m2");                // entry e6, exit e6 → clean
  const clean7 = bet("e7·m1", null);                   // entry e7 → clean
  const preE4 = bet("e4·m1", null);                    // entry pre-clean → stays unknown
  const legacy = bet(null, null);                      // no code_version → stays unknown
  const cross = bet("e5·m1", "e6·m1");                 // life spanned a deploy → ambiguous → stays unknown

  const r = backfillFootballEpoch(db);
  assert.equal(r.scanned, 6);
  assert.equal(r.recovered, 3, "the three clean e5+ non-cross rows");
  assert.equal(r.stillUnknown, 3);
  assert.equal(r.reasons.entry_pre_clean_or_unlabelled, 2, "e4 + null code_version");
  assert.equal(r.reasons.cross_epoch, 1);

  const ep = (id: string) => (db.prepare(`SELECT football_epoch e FROM bets WHERE id=?`).get(id) as any).e;
  for (const id of [clean5, clean6, clean7]) assert.equal(ep(id), FOOTBALL_EPOCH, `${id} recovered`);
  for (const id of [preE4, legacy, cross]) assert.equal(ep(id), "epoch_unknown", `${id} stays unknown`);

  // idempotent — a second pass recovers nothing
  assert.equal(backfillFootballEpoch(db).recovered, 0);
});
