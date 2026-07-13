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

test("budgetPosition: splits realised earned/lost, open in-progress, current standing, queued", () => {
  const { db, comp, strat, mid } = setup();
  // Realised: one win (+$50), one loss (−$40).
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "W", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 75, closing_price: 75, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "10'", result: "won", payout: 150, created_at: "t", settled_by: null, settled_at: "t" });
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "L", status: "settled_lost", proposed_price: 50, entry_price: 50, current_price: 0, closing_price: 0, ai_prob: 0.5, stake: 40, rationale: "r", entered_minute: "10'", result: "lost", payout: 0, created_at: "t", settled_by: null, settled_at: "t" });
  // Open: stake 100 @ entry 40¢, current market 60¢ → mark 150, +50 unrealised (in profit).
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 60, ai_prob: 0.6, liquidity: "1000", external_ref: "T", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Over 1.5", status: "open", proposed_price: 40, entry_price: 40, current_price: 60, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  // Open loser: stake 50 @ entry 50¢, current 40¢ → mark 40, −10 (at a loss).
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "BTTS Yes", price: 40, ai_prob: 0.5, liquidity: "1000", external_ref: "T2", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "BTTS Yes", status: "open", proposed_price: 50, entry_price: 50, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 50, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  // Queued: proposed, not yet filled.
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Q", status: "proposed", proposed_price: 45, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.55, stake: 30, rationale: "r", entered_minute: null, result: null, payout: null, created_at: "t" });
  // Costs.
  R.insertFillCost(db, { id: R.uid(), bet_id: R.uid(), match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", side: "buy", shares: 100, notional_usd: 100, quote_cents: 40, vwap_cents: 40.5, fee_cents: 0.7, fee_usd: 0.7, slip_cents: 0.5, slip_usd: 0.5, from_book: 1, created_at: "t" });

  const p = budgetPosition(db);
  assert.equal(p.earned, 50, "realised gains = +50 from the win");
  assert.equal(p.lostMoney, 40, "realised losses = 40 from the loss");
  assert.equal(p.netRealized, 10, "net realised = 50 − 40");
  assert.equal(p.settled, 2);
  assert.equal(p.won, 1);
  assert.equal(p.lost, 1);
  assert.equal(p.openCount, 2, "two open positions");
  assert.equal(p.invested, 150, "in-progress capital = 100 + 50");
  assert.equal(p.openMarkValue, 190, "current mark = 150 + 40");
  assert.equal(p.openPnl, 40, "unrealised = +50 − 10");
  assert.equal(p.openPlus, 1);
  assert.equal(p.openPlusPnl, 50);
  assert.equal(p.openMinus, 1);
  assert.equal(p.openMinusPnl, -10);
  assert.equal(p.proposedCount, 1);
  assert.equal(p.proposedStake, 30);
  assert.equal(p.fees, 0.7);
  assert.equal(p.slippage, 0.5);
  assert.equal(p.costTotal, 1.2);
});

test("budgetPosition: empty ledger → all zeros, treasury still reported", () => {
  const { db } = setup();
  const p = budgetPosition(db);
  assert.equal(p.earned, 0);
  assert.equal(p.lostMoney, 0);
  assert.equal(p.openCount, 0);
  assert.equal(p.invested, 0);
  assert.equal(p.openPnl, 0);
  assert.ok(p.allocated >= 0, "allocated budget reported");
});
