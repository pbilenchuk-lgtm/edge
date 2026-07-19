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
  assert.equal(p.free, p.balance - p.invested, "free = balance − invested (realised profit is available)");
});

test("budgetPosition: partial fixation — realised P&L sums the closed slice + remainder, cost not inflated (audit)", () => {
  const { db, comp, strat, mid } = setup();
  // One position, original sim stake 100, bank committed 100 (ratio 1). 50% fixed early at
  // return 1.5 (child slice), remainder settles at return 2.0. Bank realised must be
  // 50·(1.5−1) + 50·(2.0−1) = +75 — NOT the buggy 100·(2.0−1)=+100 (which dropped the child
  // slice and rode the full commitment on the shrunken remainder).
  const parent = R.uid(), child = R.uid();
  // remainder (settles by real result), stake shrunk to 50, return 2.0 → payout 100
  R.insertBet(db, bet({ id: parent, match_id: mid, strategy_id: strat.id, market_label: "Over 0.5", status: "settled_won", entry_price: 50, stake: 50, result: "won", payout: 100, settled_by: null, settled_at: "t" }));
  // closed slice: partial child, stake 50, return 1.5 → payout 75
  R.insertBet(db, bet({ id: child, match_id: mid, strategy_id: strat.id, market_label: "Over 0.5", status: "settled_won", entry_price: 50, stake: 50, result: "won", payout: 75, settled_by: "partial", settled_at: "t" }));
  // The bank commitment (event only on the parent) = 100 → original stake = 50 remainder + 50 child = 100 → ratio 1.
  R.insertShadowEvent(db, { id: R.uid(), bet_id: parent, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size_requested: 100, size_reserved: 100, verdict: "allowed", reason: null, is_live: 0, edge: 0.05, contention: 0, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.02, created_at: "t" });
  // Fills booked under the parent: entry buy + the partial-exit sell — fee $2, slip $1 total.
  R.insertFillCost(db, { id: R.uid(), bet_id: parent, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", side: "buy", shares: 100, notional_usd: 100, quote_cents: 50, vwap_cents: 50, fee_cents: 2, fee_usd: 2, slip_cents: 1, slip_usd: 1, from_book: 1, created_at: "t" });

  const p = budgetPosition(db, "2026-07-13T16:00:00Z");
  assert.equal(p.earned, 75, "realised = closed slice (+25) + remainder (+50), not +100");
  assert.equal(p.lostMoney, 0);
  assert.equal(p.netRealized, 75);
  assert.equal(p.settled, 1, "one prediction (the real-outcome parent), not two");
  assert.equal(p.won, 1);
  // Cost scaled by committed/ORIGINAL-stake (100/100=1), not committed/shrunken-stake (100/50=2).
  assert.equal(p.fees, 2, "fees not doubled by the shrunken remainder stake");
  assert.equal(p.slippage, 1);
});

test("budgetPosition: bank equity curve accumulates realised P&L by settle day, ends at balance", () => {
  const { db, comp, strat, mid } = setup();
  const ev = (betId: string, reserved: number) => R.insertShadowEvent(db, { id: R.uid(), bet_id: betId, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size_requested: reserved, size_reserved: reserved, verdict: "allowed", reason: null, is_live: 0, edge: 0.05, contention: 0, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.02, created_at: "t" });
  // day 1: winner, committed 50, stake 100 → payout 150 (ratio 1.5) → bank +$25
  const w = R.uid();
  R.insertBet(db, bet({ id: w, match_id: mid, strategy_id: strat.id, market_label: "W", status: "settled_won", entry_price: 50, stake: 100, result: "won", payout: 150, settled_at: "2026-07-16T12:00:00Z" }));
  ev(w, 50);
  // day 2: loser, committed 20, stake 40 → payout 0 → bank −$20
  const l = R.uid();
  R.insertBet(db, bet({ id: l, match_id: mid, strategy_id: strat.id, market_label: "L", status: "settled_lost", entry_price: 50, stake: 40, result: "lost", payout: 0, settled_at: "2026-07-17T12:00:00Z" }));
  ev(l, 20);

  const p = budgetPosition(db, "2026-07-18T00:00:00Z");
  assert.equal(p.netRealized, 5);
  const c = p.curve;
  assert.equal(c.base, p.bank, "curve base = the bank");
  assert.equal(c.current, p.balance, "curve ends at the balance");
  assert.equal(c.realized, 5);
  assert.equal(c.points.length, 3, "старт + 2 settle days");
  assert.equal(c.points[0].equity, p.bank, "no untimed realised → start at bank");
  assert.equal(c.points[1].equity, p.bank + 25, "after day 1: +25");
  assert.equal(c.points[2].equity, p.bank + 5, "after day 2: −20 → net +5");
  assert.equal(c.points.at(-1)!.equity, p.balance, "last point = balance");
});

test("budgetPosition: no shadow activity → bank intact, all P&L zero", () => {
  const { db } = setup();
  const p = budgetPosition(db, "2026-07-13T16:00:00Z");
  assert.ok(p.bank > 0, "bank is the configured betting bank");
  assert.equal(p.balance, p.bank, "no realised P&L → balance = bank");
  assert.equal(p.invested, 0);
  assert.equal(p.free, p.bank, "nothing invested → free equals the whole bank");
  assert.equal(p.openPnl, 0);
  assert.equal(p.earned, 0);
});
