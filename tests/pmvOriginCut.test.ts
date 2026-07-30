import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { serializeEntryMeta } from "../src/lib/betMeta.js";
import { buildPmvOriginCut, pmvFamily } from "../src/lib/pmvOriginCut.js";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "OVR", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "t", minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}

// Insert a PMV bet, then hand-settle it so we control epoch (settled_at) / result / payout / closing.
function pmvBet(db: any, o: {
  label: string; enteredMinute: string; entryMeta?: string | null;
  strategyId?: string;
  entry?: number | null; close?: number | null;
  result?: "won" | "lost" | null; settledAt?: string | null; payout?: number | null; stake?: number;
}) {
  const id = R.uid();
  R.insertBet(db, {
    id, match_id: "m1", strategy_id: o.strategyId ?? "prematch_value", risk_profile_id: "medium",
    market_label: o.label, status: "open", proposed_price: o.entry ?? 50, entry_price: o.entry ?? 50,
    current_price: o.entry ?? 50, closing_price: o.close ?? null, ai_prob: 0.6, stake: o.stake ?? 40,
    rationale: "r", entered_minute: o.enteredMinute, result: null, payout: null,
    entry_meta: o.entryMeta ?? null, created_at: "2026-07-01T00:00:00Z",
  } as any);
  if (o.result != null) {
    const status = o.result === "won" ? "settled_won" : "settled_lost";
    db.prepare(`UPDATE bets SET status=?, result=?, payout=?, closing_price=?, settled_at=? WHERE id=?`)
      .run(status, o.result, o.payout ?? null, o.close ?? null, o.settledAt ?? null, id);
  } else if (o.close != null) {
    db.prepare(`UPDATE bets SET closing_price=? WHERE id=?`).run(o.close, id);
  }
  return id;
}

test("pmvFamily: totals / btts / handicap / outcome / other", () => {
  assert.equal(pmvFamily("Over 2.5 Goals"), "totals");
  assert.equal(pmvFamily("Under 3.5"), "totals");
  assert.equal(pmvFamily("Both Teams To Score"), "btts");
  assert.equal(pmvFamily("BTTS - No"), "btts");
  assert.equal(pmvFamily("Arsenal -1.5"), "handicap");
  assert.equal(pmvFamily("Arsenal to win"), "outcome");
  assert.equal(pmvFamily("Draw"), "outcome");
  assert.equal(pmvFamily("Some Special Prop"), "other");
});

test("dataHealth valid + verdict/inferred cell separation; only PMV bets counted", () => {
  const db = seed();
  // Verdict-trust rows (decision + meta_backfill), post-fix, settled → a verdict cell.
  pmvBet(db, { label: "Over 2.5", enteredMinute: "предматч", entryMeta: serializeEntryMeta({ phase: "prematch" }), entry: 50, close: 60, result: "won", payout: 80, settledAt: "2026-07-18T00:00:00Z" });
  pmvBet(db, { label: "Under 3.5", enteredMinute: "60'", entryMeta: serializeEntryMeta({ phase: "live" }), entry: 40, close: 30, result: "lost", payout: 0, settledAt: "2026-07-18T00:00:00Z" });
  // Inferred-only row (no entry_meta) → diagnostic block, NEVER a verdict cell.
  pmvBet(db, { label: "Over 1.5", enteredMinute: "72'", entryMeta: null, entry: 55, close: 65, result: "won", payout: 90, settledAt: "2026-07-18T00:00:00Z" });
  // A non-PMV bet must be ignored entirely.
  pmvBet(db, { label: "Over 2.5", enteredMinute: "80'", entryMeta: serializeEntryMeta({ phase: "live" }), strategyId: "overreaction", entry: 50, close: 60, result: "won", payout: 80, settledAt: "2026-07-18T00:00:00Z" });

  const cut = buildPmvOriginCut(db);
  assert.equal(cut.dataHealth.total, 3, "only the 3 PMV bets counted, overreaction excluded");
  assert.equal(cut.dataHealth.originNull, 0);
  assert.equal(cut.dataHealth.unknownSource, 0);
  assert.equal(cut.dataHealth.valid, true);
  assert.ok(!cut.note.startsWith("⛔"), "clean base → no loud refusal");

  // Verdict cells: prematch/totals + live/totals, both post-fix. Inferred row NOT among them.
  const verdictN = cut.verdictCells.reduce((s, c) => s + c.n, 0);
  assert.equal(verdictN, 2, "two verdict-trust rows form cells");
  const inferredN = cut.diagnosticInferredCells.reduce((s, c) => s + c.n, 0);
  assert.equal(inferredN, 1, "the no-meta row is quarantined to the diagnostic block");
  assert.ok(cut.verdictCells.every((c) => c.family === "totals"), "totals family");

  // origin_source counts expose provenance mix: the two meta rows → decision, the no-meta row → inferred.
  assert.equal(cut.originSourceCounts["decision"], 2, "two entry_meta.phase rows → decision-stamped");
  assert.equal(cut.originSourceCounts["inferred_backfill"], 1, "the no-meta row → inferred at insert");
});

test("self-validation: NULL origin / unknown source → valid:false + loud note", () => {
  const db = seed();
  pmvBet(db, { label: "Over 2.5", enteredMinute: "предматч", entryMeta: serializeEntryMeta({ phase: "prematch" }), entry: 50, close: 60, result: "won", payout: 80, settledAt: "2026-07-18T00:00:00Z" });
  // Corrupt the column to simulate an unmigrated / broken DB.
  db.exec(`UPDATE bets SET origin=NULL, origin_source=NULL WHERE strategy_id='prematch_value'`);
  const cut = buildPmvOriginCut(db);
  assert.equal(cut.dataHealth.valid, false, "NULL origin → not confirmed");
  assert.equal(cut.dataHealth.originNull, 1);
  assert.ok(cut.note.startsWith("⛔"), "loud refusal to judge on a broken base");

  // Unknown source is also caught.
  const db2 = seed();
  pmvBet(db2, { label: "Over 2.5", enteredMinute: "предматч", entryMeta: serializeEntryMeta({ phase: "prematch" }), entry: 50, close: 60, result: "won", payout: 80, settledAt: "2026-07-18T00:00:00Z" });
  db2.exec(`UPDATE bets SET origin_source='garbage' WHERE strategy_id='prematch_value'`);
  const cut2 = buildPmvOriginCut(db2);
  assert.equal(cut2.dataHealth.unknownSource, 1);
  assert.equal(cut2.dataHealth.valid, false);
  assert.ok(cut2.note.startsWith("⛔"));
});

test("epoch split: pre-fix cells are CLV-only (winPnlValid=false); post-fix all three", () => {
  const db = seed();
  const meta = serializeEntryMeta({ phase: "prematch" });
  // Pre-fix (settled before cutoff): win%/P&L poisoned → winPnlValid=false, CLV still present.
  pmvBet(db, { label: "Over 2.5", enteredMinute: "предматч", entryMeta: meta, entry: 50, close: 62, result: "won", payout: 80, settledAt: "2026-07-16T00:00:00Z" });
  // Post-fix (settled after cutoff): winPnlValid=true.
  pmvBet(db, { label: "Under 3.5", enteredMinute: "предматч", entryMeta: meta, entry: 40, close: 30, result: "lost", payout: 0, settledAt: "2026-07-18T00:00:00Z" });

  const cut = buildPmvOriginCut(db);
  const pre = cut.verdictCells.find((c) => c.epoch === "pre_fix");
  const post = cut.verdictCells.find((c) => c.epoch === "post_fix");
  assert.ok(pre, "a pre-fix cell exists");
  assert.ok(post, "a post-fix cell exists");
  assert.equal(pre!.winPnlValid, false, "pre-fix win%/P&L invalid");
  assert.equal(pre!.clvMean, 12, "pre-fix CLV still computed (62-50)");
  assert.equal(post!.winPnlValid, true, "post-fix win%/P&L valid");
  assert.equal(post!.winPct, 0, "post-fix lost → 0% win");
});

test("open (unsettled) bets form no cell; header still counts them", () => {
  const db = seed();
  pmvBet(db, { label: "Over 2.5", enteredMinute: "предматч", entryMeta: serializeEntryMeta({ phase: "prematch" }), entry: 50, close: null }); // open
  const cut = buildPmvOriginCut(db);
  assert.equal(cut.dataHealth.total, 1, "counted in the health header");
  assert.equal(cut.verdictCells.length, 0, "but forms no verdict cell while open");
});
