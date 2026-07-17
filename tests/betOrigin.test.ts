import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { resolveBetOrigin, inferOriginFromEnteredMinute, serializeEntryMeta } from "../src/lib/betMeta.js";
import { migrateBetOrigin } from "../src/lib/seed.js";

test("resolveBetOrigin: decision-phase field wins; provenance three-way; frozen inference fallback", () => {
  // entry_meta.phase present → decision (at insert) / meta_backfill (at backfill).
  const pm = serializeEntryMeta({ phase: "prematch" });
  assert.deepEqual(resolveBetOrigin(pm, "предматч", true), { origin: "prematch", source: "decision" });
  assert.deepEqual(resolveBetOrigin(pm, "предматч", false), { origin: "prematch", source: "meta_backfill" });
  const lv = serializeEntryMeta({ phase: "live" });
  assert.deepEqual(resolveBetOrigin(lv, "60'", true), { origin: "live", source: "decision" });
  // No entry_meta.phase → frozen inference (entered_minute has a digit → live, else prematch).
  assert.deepEqual(resolveBetOrigin(null, "45'", true), { origin: "live", source: "inferred_backfill" });
  assert.deepEqual(resolveBetOrigin(null, "предматч", false), { origin: "prematch", source: "inferred_backfill" });
  assert.equal(inferOriginFromEnteredMinute("10'"), "live");
  assert.equal(inferOriginFromEnteredMinute("предматч"), "prematch");
  assert.equal(inferOriginFromEnteredMinute(null), "prematch");
});

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "t", minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}
const insert = (db: any, o: { entryMeta?: string | null; enteredMinute: string }) =>
  R.insertBet(db, { id: R.uid(), match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: o.enteredMinute, result: null, payout: null, entry_meta: o.entryMeta ?? null, created_at: "t" } as any);

test("insertBet stamps origin at entry from entry_meta.phase (source=decision)", () => {
  const db = seed();
  const id = R.uid();
  R.insertBet(db, { id, match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "предматч", result: null, payout: null, entry_meta: serializeEntryMeta({ phase: "live" }), created_at: "t" } as any);
  const row = db.prepare(`SELECT origin, origin_source FROM bets WHERE id=?`).get(id) as any;
  assert.equal(row.origin, "live", "origin from entry_meta.phase, NOT the 'предматч' entered_minute");
  assert.equal(row.origin_source, "decision");
});

test("migrateBetOrigin: backfills NULL-origin rows once, three-way provenance, idempotent", () => {
  const db = seed();
  // Simulate legacy rows: insert normally, then blank the columns to mimic a pre-migration DB.
  const a = R.uid(), b = R.uid();
  insert(db, { entryMeta: serializeEntryMeta({ phase: "prematch" }), enteredMinute: "предматч" }); // has meta
  const withMeta = db.prepare(`SELECT id FROM bets`).all().map((r: any) => r.id);
  insert(db, { entryMeta: null, enteredMinute: "72'" }); // no meta → inferred later
  db.exec(`UPDATE bets SET origin=NULL, origin_source=NULL`); // pretend pre-migration
  const n = migrateBetOrigin(db);
  assert.equal(n, 2, "both rows backfilled");
  const rows = db.prepare(`SELECT entry_meta, origin, origin_source FROM bets`).all() as any[];
  const meta = rows.find((r) => r.entry_meta);
  const infer = rows.find((r) => !r.entry_meta);
  assert.deepEqual([meta.origin, meta.origin_source], ["prematch", "meta_backfill"], "entry_meta rows → meta_backfill");
  assert.deepEqual([infer.origin, infer.origin_source], ["live", "inferred_backfill"], "no-meta row → frozen inference (72' → live)");
  assert.equal(migrateBetOrigin(db), 0, "idempotent — nothing left NULL");
});
