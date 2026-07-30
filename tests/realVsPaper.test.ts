import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import * as RR from "../src/lib/realRepo.js";
import { realVsPaperReport, realVsPaperCsv } from "../src/lib/executor/realVsPaper.js";

const NOW = "2026-07-15T12:00:00.000Z";
function seed() {
  const d = openDb(":memory:"); initSchema(d);
  R.upsertSport(d, "football", "Ф");
  R.upsertCompetition(d, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: null, created_at: "t" });
  R.insertStrategy(d, { id: "overreaction", sport_id: "football", name: "OR", tag: "o", color: "#fff", version: 1, prompt: "", prompt_live: null, params: {}, model: "m", model_live: null, created_at: "t" } as any);
  const mid = R.uid();
  R.insertMatch(d, { id: mid, competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  const twin = (decision: string, entry: number, stake: number, payout: number) =>
    R.insertBet(d, { id: R.uid(), match_id: mid, strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Over 1.5", status: payout >= stake ? "settled_won" : "settled_lost", proposed_price: entry, entry_price: entry, current_price: entry, closing_price: entry, ai_prob: 0.6, stake, rationale: "r", entered_minute: "3'", result: payout >= stake ? "won" : "lost", payout, settled_by: "early", settled_at: NOW, entry_meta: null, code_version: "e1", decision_id: decision, created_at: NOW } as any);
  const ord = (decision: string, status: RR.RealOrderStatus, avgFill: number | null, filled: number) => {
    RR.insertRealOrder(d, { id: "o-" + decision, client_order_id: "c-" + decision, exchange_order_id: null, decision_id: decision, strategy_id: "overreaction", profile_id: "medium", match_id: mid, token_id: "tk-" + decision, side: "BUY", leg: "entry", limit_price_cents: 45, size_usd: filled || 30, tif_sec: 45, code_version: "e1", whitelist_version: 1, note: null, created_at: NOW });
    RR.transitionRealOrder(d, "o-" + decision, status, NOW, { filledSizeUsd: filled, avgFillCents: avgFill });
  };
  // A: filled at 46¢ vs paper decision 45¢ → entry slip +1¢. Twin won (+10).
  twin("dA", 45, 30, 40); ord("dA", "filled", 46, 30);
  RR.insertRealFill(d, { order_id: "o-dA", client_order_id: "c-dA", token_id: "tk-dA", side: "BUY", size_usd: 30, price_cents: 46, fee_usd: 0.2, dry: 1, at: NOW, created_at: NOW });
  RR.insertRealLedger(d, { kind: "fill", amount_usd: -30, token_id: "tk-dA", order_id: "o-dA", ref: null, dry: 1, at: NOW, created_at: NOW });
  RR.insertRealLedger(d, { kind: "fee", amount_usd: -0.2, token_id: "tk-dA", order_id: "o-dA", ref: null, dry: 1, at: NOW, created_at: NOW });
  // B: EXPIRED (missed) — but the paper twin still won +15 → edge we couldn't capture.
  twin("dB", 50, 20, 35); ord("dB", "expired", null, 0);
  return d;
}

test("realVsPaperReport: fill-rate by category, entry slippage, missed-fills edge, costs, pnl delta", () => {
  const d = seed();
  const rep = realVsPaperReport(d);
  assert.equal(rep.orders, 2);
  const epl = rep.fillRateByCategory.find((c) => c.category === "epl")!;
  assert.equal(epl.total, 2);
  assert.equal(epl.filled, 1);
  assert.equal(epl.expired, 1);
  assert.equal(epl.fillPct, 50, "1 filled of 2");
  assert.equal(rep.slippage.entryMedianCents, 1, "real 46¢ − paper 45¢ = +1¢ (only the filled order)");
  assert.equal(rep.missedFills.count, 1, "the expired entry");
  assert.equal(rep.missedFills.edgeLostUsd, 15, "its paper twin won +$15 — edge we couldn't capture");
  assert.equal(rep.costs.feeUsd, 0.2, "taker fee booked");
  assert.equal(rep.pnlDelta.paperTwinPnlUsd, 25, "twins: +10 (A) + 15 (B) = 25");
});

test("realVsPaperCsv: one row per entry order with the twin slippage delta", () => {
  const d = seed();
  const csv = realVsPaperCsv(d);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3, "header + 2 orders");
  assert.match(lines[0], /entry_slip_cents/);
  assert.ok(lines.some((l) => l.includes(",filled,") && l.includes(",1,")), "the filled row carries slip +1");
});
