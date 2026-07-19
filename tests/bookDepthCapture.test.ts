import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { bookDepthTargets, saveBookDepth, captureBookDepth } from "../src/lib/bookDepthCapture.js";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  const live = (id: string, state: string) => R.insertMatch(db, { id, competition_id: "epl", home: "A", away: "B", state, lineup_out: true, kickoff_at: "t", minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
  live("mlive", "live"); live("mfin", "finished"); live("mup", "upcoming");
  const mkt = (mid: string, label: string, tok: string, liq: number) => R.insertMarket(db, { id: R.uid(), match_id: mid, label, price: 50, ai_prob: 0.5, liquidity: String(liq), external_ref: tok, snapshot_at: "t", is_closing: false } as any);
  // live match: 5 markets of varying liquidity (only top-4 by liquidity should be targeted)
  mkt("mlive", "Over 2.5", "tok_o25", 5000); mkt("mlive", "BTTS", "tok_btts", 3000); mkt("mlive", "Draw", "tok_draw", 8000); mkt("mlive", "Under 1.5", "tok_u15", 100); mkt("mlive", "Home", "tok_home", 1000);
  // finished/upcoming markets must NOT be targeted
  mkt("mfin", "Over 2.5", "tok_fin", 9000); mkt("mup", "Over 2.5", "tok_up", 9000);
  return db;
}

test("bookDepthTargets: only LIVE matches, top markets by liquidity, bounded", () => {
  const db = seed();
  const t = bookDepthTargets(db, 24, 4);
  assert.equal(t.length, 4, "top-4 markets of the one live match");
  assert.ok(t.every((x) => x.matchId === "mlive"), "finished/upcoming excluded");
  const toks = t.map((x) => x.token);
  assert.ok(toks.includes("tok_draw") && toks.includes("tok_o25") && toks.includes("tok_btts") && toks.includes("tok_home"), "the 4 most liquid");
  assert.ok(!toks.includes("tok_u15"), "the thinnest ($100) book dropped by the per-match cap");
  // global cap honored
  assert.equal(bookDepthTargets(db, 2, 4).length, 2);
});

test("saveBookDepth: persists top-N levels + depth", () => {
  const db = seed();
  saveBookDepth(db, { matchId: "mlive", token: "tok_o25", label: "Over 2.5" },
    { bids: [{ priceCents: 49, size: 100 }, { priceCents: 48, size: 200 }], asks: [{ priceCents: 51, size: 150 }] }, "periodic", "2026-07-18T12:00:00Z");
  const row = db.prepare(`SELECT * FROM book_depth_snapshots`).get() as any;
  assert.equal(row.token_id, "tok_o25");
  assert.equal(row.best_bid_cents, 49);
  assert.equal(row.best_ask_cents, 51);
  assert.equal(JSON.parse(row.asks_json).length, 1);
  assert.equal(JSON.parse(row.bids_json)[1][0], 48, "second bid level price preserved");
  assert.ok(row.ask_depth_usd > 0);
});

test("captureBookDepth: no live book source (poly disabled) → no-op", async () => {
  const db = seed();
  const n = await captureBookDepth(db, { env: {} }, Date.parse("2026-07-18T12:00:00Z"));
  assert.equal(n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM book_depth_snapshots`).get() as any).c, 0);
});
