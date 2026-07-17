import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import * as RR from "../src/lib/realRepo.js";
import { addWhitelistRow } from "../src/lib/executor/whitelist.js";
import { buildDryFillWatch } from "../src/lib/executor/dryFillWatch.js";

const NOW = "2026-07-17T12:00:00.000Z";
const nowMs = Date.parse(NOW);
function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "Overreaction", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: NOW } as any);
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: NOW });
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: NOW, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}
const bet = (db: any, o: { decision?: string | null } = {}) => R.insertBet(db, { id: R.uid(), match_id: "m1", strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "30'", result: null, payout: null, decision_id: o.decision === undefined ? "d1" : o.decision, created_at: NOW } as any);
const order = (db: any, o: { status: RR.RealOrderStatus; note: string; filled?: number }) => {
  const id = R.uid();
  RR.insertRealOrder(db, { id, client_order_id: id, exchange_order_id: null, decision_id: "d1", strategy_id: "overreaction", profile_id: "medium", match_id: "m1", token_id: "0xTOK", side: "BUY", leg: "entry", limit_price_cents: 50, size_usd: 20, tif_sec: 30, status: o.status, code_version: null, whitelist_version: 1, note: o.note, created_at: NOW } as any);
  if (o.filled) db.prepare(`UPDATE real_orders SET filled_size_usd=?, status=? WHERE id=?`).run(o.filled, o.status, id);
};

test("dryFillWatch: quiet calendar — no football entries → not a gate failure", () => {
  const rep = buildDryFillWatch(seed(), {}, nowMs);
  assert.equal(rep.candidates, 0);
  assert.equal(rep.verdict, "quiet_calendar");
});

test("dryFillWatch: entries but nothing whitelisted → gated_pre_executor (loud, not silent)", () => {
  const db = seed(); bet(db); bet(db);
  const rep = buildDryFillWatch(db, {}, nowMs);
  assert.equal(rep.candidates, 2);
  assert.equal(rep.funnel.wouldMirror, 0, "not whitelisted → never reaches the executor");
  assert.equal(rep.orders.total, 0);
  assert.equal(rep.verdict, "gated_pre_executor");
});

test("dryFillWatch: order built but no live book → reached_executor_no_live_book (need a match, gate is open)", () => {
  const db = seed();
  addWhitelistRow(db, { strategyId: "overreaction", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  order(db, { status: "expired", note: "нет живой книги" });
  const rep = buildDryFillWatch(db, {}, nowMs);
  assert.equal(rep.orders.total, 1);
  assert.equal(rep.orders.noLiveBook, 1);
  assert.equal(rep.verdict, "reached_executor_no_live_book");
});

test("dryFillWatch: a gate-rejected order (cap/conform) → gate_rejected, distinct from no-book", () => {
  const db = seed();
  order(db, { status: "rejected", note: "кэп (reject): дневной убыток" });
  const rep = buildDryFillWatch(db, {}, nowMs);
  assert.equal(rep.orders.gateRejected, 1);
  assert.equal(rep.verdict, "gate_rejected");
});

test("dryFillWatch: a FILLED dry order → dry_fill_achieved (Pre-F gate passed end-to-end)", () => {
  const db = seed();
  order(db, { status: "filled", note: "VWAP 49¢ ≤ лимит 50¢", filled: 20 });
  const rep = buildDryFillWatch(db, {}, nowMs);
  assert.equal(rep.dryFillsInWindow, 1);
  assert.equal(rep.dryFillsAllTime, 1);
  assert.equal(rep.verdict, "dry_fill_achieved");
});
