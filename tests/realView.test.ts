import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import * as RR from "../src/lib/realRepo.js";
import { realView } from "../src/lib/executor/realView.js";

const NOW = "2026-07-15T12:00:00.000Z";
function seed() {
  const d = openDb(":memory:"); initSchema(d);
  R.upsertSport(d, "football", "Ф");
  R.upsertCompetition(d, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: null, created_at: "t" });
  R.insertStrategy(d, { id: "overreaction", sport_id: "football", name: "OR", tag: "o", color: "#fff", version: 1, prompt: "", prompt_live: null, params: {}, model: "m", model_live: null, created_at: "t" } as any);
  const mid = R.uid();
  R.insertMatch(d, { id: mid, competition_id: "epl", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "t", minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.insertBet(d, { id: "twin", match_id: mid, strategy_id: "overreaction", risk_profile_id: "medium", market_label: "O", status: "open", proposed_price: 45, entry_price: 45, current_price: 45, closing_price: null, ai_prob: 0.6, stake: 30, rationale: "r", entered_minute: "3'", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e", decision_id: "dec1", created_at: NOW } as any);
  RR.insertRealOrder(d, { id: "o1", client_order_id: "c1", exchange_order_id: null, decision_id: "dec1", strategy_id: "overreaction", profile_id: "medium", match_id: mid, token_id: "tok1", side: "BUY", leg: "entry", limit_price_cents: 45, size_usd: 30, tif_sec: 45, code_version: "e", whitelist_version: 3, note: null, dry: 1 as const, created_at: NOW });
  RR.transitionRealOrder(d, "o1", "placed", NOW, {});
  RR.transitionRealOrder(d, "o1", "filled", NOW, { filledSizeUsd: 30, avgFillCents: 46 });
  RR.insertRealLedger(d, { kind: "fill", amount_usd: -30, token_id: "tok1", order_id: "o1", ref: null, dry: 1, at: NOW, created_at: NOW });
  RR.upsertRealPosition(d, { token_id: "tok1", match_id: mid, strategy_id: "overreaction", size_shares: 65, avg_price_cents: 46, realized_pnl_usd: 0, unrealized_pnl_usd: null, dry: 1, updated_at: NOW });
  return d;
}

test("realView: mode (effective), bank real vs dry, order feed with events + twin delta, report", () => {
  const d = seed();
  const v = realView(d, { REAL_TRADING: "dry_run" });
  assert.equal(v.mode, "dry_run");
  assert.equal(v.envMode, "dry_run");
  assert.equal(v.bank.dryBalanceUsd, -30, "dry ledger moved");
  assert.equal(v.bank.realBalanceUsd, 0, "real books empty (dry-tagged)");
  assert.equal(v.orders.length, 1);
  const o = v.orders[0];
  assert.deepEqual(o.events.map((e) => e.status), ["created", "placed", "filled"], "full lifecycle with timestamps");
  assert.equal(o.dry, true, "no exchange id → dry");
  assert.equal(o.paperEntryCents, 45);
  assert.equal(o.entrySlipCents, 1, "fill 46 − decision 45 = +1¢ twin delta");
  assert.equal(o.whitelistVersion, 3);
  assert.equal(v.positions.length, 1);
  assert.equal(v.report.orders, 1);
});

test("realView: a sticky auto-pause shows the effective mode below the env mode", () => {
  const d = seed();
  RR.setRealAutoPause(d, "daily loss", NOW);
  const v = realView(d, { REAL_TRADING: "on" });
  assert.equal(v.envMode, "on", "env is on");
  assert.equal(v.mode, "exits_only", "but the sticky pause floors the effective mode — visible in the badge");
  assert.ok(v.paused, "pause surfaced for the UI");
});
