import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { budgetPosition } from "../src/lib/budgetPosition.js";

function setup() {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  return { db, comp, strat, mid };
}

const bet = (o: any) => ({ risk_profile_id: "medium", proposed_price: 50, closing_price: null, ai_prob: 0.5, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t", settled_by: null, settled_at: null, current_price: null, ...o });

test("budgetPosition: bank P&L is scaled to the BANK's committed size, not the sim stake", () => {
  const { db, comp, strat, mid } = setup();
  // Funded winner: sim stake 100 → payout 150 (ratio 1.5). Bank committed 50 → +$25 to the bank.
  const w = R.uid();
  R.insertBet(db, bet({ id: w, match_id: mid, strategy_id: strat.id, market_label: "W", status: "settled_won", entry_price: 50, stake: 100, result: "won", payout: 150, settled_at: "t" }));
  R.insertShadowEvent(db, { id: R.uid(), bet_id: w, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size_requested: 50, size_reserved: 50, verdict: "allowed", reason: null, is_live: 0, edge: 0.05, contention: 0, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.02, created_at: "t" });
  // Funded loser: sim stake 40 → payout 0 (ratio 0). Bank committed 20 → −$20.
  const l = R.uid();
  R.insertBet(db, bet({ id: l, match_id: mid, strategy_id: strat.id, market_label: "L", status: "settled_lost", entry_price: 50, stake: 40, result: "lost", payout: 0, settled_at: "t" }));
  R.insertShadowEvent(db, { id: R.uid(), bet_id: l, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size_requested: 20, size_reserved: 20, verdict: "allowed", reason: null, is_live: 0, edge: 0.03, contention: 0, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.02, created_at: "t" });
  // Open position: sim stake 100 @ entry 40¢, market now 60¢ (ratio 1.5). Bank reserved 30 → mark 45, +15.
  const o = R.uid();
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 60, ai_prob: 0.6, liquidity: "1000", external_ref: "T", snapshot_at: "t", is_closing: false });
  R.insertBet(db, bet({ id: o, match_id: mid, strategy_id: strat.id, market_label: "Over 1.5", status: "open", entry_price: 40, stake: 100, entered_minute: "предматч" }));
  R.insertShadowReserve(db, { id: R.uid(), bet_id: o, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size: 30, is_live: 0, edge: 0.1, state: "reserved", settle_at: null, created_at: "t" });

  const p = budgetPosition(db, "2026-07-13T16:00:00Z");
  assert.equal(p.earned, 25, "bank gain = committed 50 × (1.5−1)");
  assert.equal(p.lostMoney, 20, "bank loss = committed 20 × 1");
  assert.equal(p.netRealized, 5);
  assert.equal(p.settled, 2);
  assert.equal(p.won, 1);
  assert.equal(p.lost, 1);
  assert.equal(p.balance, p.bank + 5, "balance = bank + realised net");
  assert.equal(p.openCount, 1);
  assert.equal(p.invested, 30, "invested = the bank's reserved size, NOT the sim stake 100");
  assert.equal(p.openMarkValue, 45, "mark = 30 × 60/40");
  assert.equal(p.openPnl, 15);
  assert.equal(p.openPlus, 1);
  assert.equal(p.equity, p.bank + 5 + 15, "equity = balance + unrealised");
});

test("budgetPosition: no shadow activity → bank intact, all P&L zero", () => {
  const { db } = setup();
  const p = budgetPosition(db, "2026-07-13T16:00:00Z");
  assert.ok(p.bank > 0, "bank is the configured betting bank");
  assert.equal(p.balance, p.bank, "no realised P&L → balance = bank");
  assert.equal(p.invested, 0);
  assert.equal(p.openPnl, 0);
  assert.equal(p.earned, 0);
});
