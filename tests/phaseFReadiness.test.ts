import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import * as RR from "../src/lib/realRepo.js";
import { addWhitelistRow } from "../src/lib/executor/whitelist.js";
import { buildPhaseFReadiness } from "../src/lib/executor/phaseFReadiness.js";

const NOW = "2026-07-17T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const ENV = { REAL_TRADING: "dry_run", REAL_BANK_USD: "1000" };

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: NOW } as any);
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: NOW });
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: NOW, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}
const paperBet = (db: any, decision: string) => R.insertBet(db, { id: R.uid(), match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "medium", market_label: "Over 2.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: 60, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "предматч", result: "won", payout: 80, decision_id: decision, created_at: NOW } as any);
const realOrder = (db: any, o: { decision: string; status: RR.RealOrderStatus; fillCents?: number; filled?: number; createdAt?: string }) => {
  const id = R.uid();
  RR.insertRealOrder(db, { id, client_order_id: id, exchange_order_id: null, decision_id: o.decision, strategy_id: "prematch_value", profile_id: "medium", match_id: "m1", token_id: "0xTOK", side: "BUY", leg: "entry", limit_price_cents: 50, size_usd: 20, tif_sec: 30, status: o.status, code_version: null, whitelist_version: 1, note: "n", created_at: o.createdAt ?? NOW } as any);
  db.prepare(`UPDATE real_orders SET filled_size_usd=?, avg_fill_cents=? WHERE id=?`).run(o.filled ?? 0, o.fillCents ?? null, id);
  return id;
};
const position = (db: any, decision: string) => RR.upsertRealPosition(db, { token_id: "0xTOK", decision_id: decision, profile_id: "medium", match_id: "m1", strategy_id: "prematch_value", size_shares: 40, avg_price_cents: 50, realized_pnl_usd: 0, unrealized_pnl_usd: 0, updated_at: NOW } as any);

function happy() {
  const db = seed();
  addWhitelistRow(db, { strategyId: "prematch_value", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  paperBet(db, "d1");
  realOrder(db, { decision: "d1", status: "filled", fillCents: 49, filled: 20 }); // fill BELOW limit → negative slip, healthy
  position(db, "d1");
  return db;
}

test("phase-F readiness: clean dry contour → GO, no failed invariants", () => {
  const rep = buildPhaseFReadiness(happy(), ENV, nowMs);
  assert.equal(rep.counts.fail, 0, "no hard failures");
  assert.ok(rep.verdict === "go" || rep.verdict === "review", `verdict=${rep.verdict}`);
  const by = Object.fromEntries(rep.checks.map((c) => [c.id, c.status]));
  assert.equal(by.whitelist_target, "pass");
  assert.equal(by.twin_orphan_orders, "pass");
  assert.equal(by.filled_has_position, "pass");
  assert.equal(by.dry_fill, "pass");
  assert.equal(by.target_exercised, "pass");
  assert.equal(by.exposure_le_bank, "pass");
});

test("phase-F readiness: a real order with no paper twin → twin_orphan_orders FAIL → hold", () => {
  const db = happy();
  realOrder(db, { decision: "ghost", status: "filled", fillCents: 50, filled: 20 }); // decision_id not in bets
  const rep = buildPhaseFReadiness(db, ENV, nowMs);
  const c = rep.checks.find((x) => x.id === "twin_orphan_orders")!;
  assert.equal(c.status, "fail");
  assert.equal(rep.verdict, "hold");
});

test("phase-F readiness: a filled order without a position → filled_has_position FAIL", () => {
  const db = seed();
  addWhitelistRow(db, { strategyId: "prematch_value", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  paperBet(db, "d1");
  realOrder(db, { decision: "d1", status: "filled", fillCents: 49, filled: 20 }); // NO position inserted
  const rep = buildPhaseFReadiness(db, ENV, nowMs);
  assert.equal(rep.checks.find((x) => x.id === "filled_has_position")!.status, "fail");
  assert.equal(rep.verdict, "hold");
});

test("phase-F readiness: target strategy not whitelisted → whitelist_target FAIL", () => {
  const db = seed();
  paperBet(db, "d1");
  realOrder(db, { decision: "d1", status: "filled", fillCents: 49, filled: 20 });
  position(db, "d1");
  const rep = buildPhaseFReadiness(db, ENV, nowMs);
  assert.equal(rep.checks.find((x) => x.id === "whitelist_target")!.status, "fail");
  assert.equal(rep.verdict, "hold");
});

test("phase-F readiness: over-fill (filled > size) is caught as an impossible fill", () => {
  const db = happy();
  db.prepare(`UPDATE real_orders SET filled_size_usd=999 WHERE decision_id='d1'`).run();
  const rep = buildPhaseFReadiness(db, ENV, nowMs);
  assert.equal(rep.checks.find((x) => x.id === "no_overfill")!.status, "fail");
});
