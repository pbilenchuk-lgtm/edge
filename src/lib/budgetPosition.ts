// ============================================================
// EDGE LAB — OUR REAL BETTING BUDGET. Not the per-strategy simulation budgets
// (those are isolated, only to measure how each strategy performs — that lives on
// the Metrics tab). This is the ONE real bank we bet with: $5000 (the shadow
// allocator's bankTotal) and what happens to it — balance, invested, earned,
// lost, and what's in-progress right now.
//
// Every position's money is scaled to what the BANK committed to it (the
// allocator's size_reserved), NOT the isolated sim stake — so the totals are the
// real $5000's story, not a sum of simulation budgets. Read-only.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { loadShadowConfig, shadowPoolState } from "./shadow.js";
import { summarizeFillCosts } from "./fillCosts.js";

export interface BudgetPosition {
  bank: number;            // the real betting bank ($5000)
  balance: number;         // bank + realised P&L — the bank's current worth
  equity: number;          // balance + unrealised (mark-to-market total worth right now)
  free: number;            // available to deploy now
  invested: number;        // bank capital committed to OPEN positions
  settling: number;        // committed capital of CLOSED positions still in the resolve lag
  // Realised — decided money (bank-scaled).
  earned: number; lostMoney: number; netRealized: number;
  settled: number; won: number; lost: number;
  // In-progress — open positions, marked to the freshest quote (bank-scaled).
  openCount: number; openMarkValue: number; openPnl: number;
  openPlus: number; openPlusPnl: number; openMinus: number; openMinusPnl: number;
  // Execution drag on the bank (fees + slippage), scaled to the bank's commitment.
  fees: number; slippage: number; costTotal: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function budgetPosition(db: Database, nowIso?: string): BudgetPosition {
  const cfg = loadShadowConfig(db);
  const bank = cfg.bankTotal;
  const pool = shadowPoolState(db, cfg, nowIso ?? new Date().toISOString());

  // How much the BANK committed to each funded bet (allocator reserve at entry).
  const committedByBet = new Map<string, number>();
  for (const e of R.allShadowEvents(db)) {
    if (e.bet_id && e.size_reserved > 0) committedByBet.set(e.bet_id, (committedByBet.get(e.bet_id) ?? 0) + e.size_reserved);
  }

  // Realised P&L of the bank: each funded, settled position returns its bank
  // commitment × (bet return ratio − 1). Won/lost counted on real-outcome settles.
  let earned = 0, lostMoney = 0, settled = 0, won = 0, lost = 0;
  for (const [betId, committed] of committedByBet) {
    const b = R.getBet(db, betId);
    if (!b || (b.status !== "settled_won" && b.status !== "settled_lost")) continue;
    const stake = b.stake ?? 0;
    const ratio = stake > 0 && b.payout != null ? b.payout / stake : 1; // return multiple on the sim stake
    const pnl = committed * (ratio - 1);                                 // applied to the bank's commitment
    if (pnl >= 0) earned += pnl; else lostMoney += -pnl;
    if (b.settled_by == null) { settled++; if (b.result === "won") won++; else lost++; }
  }

  // In-progress: the bank's OPEN reserves, marked to the freshest quote per market.
  const priceCache = new Map<string, Record<string, number>>();
  const priceFor = (matchId: string, label: string): number | null => {
    let p = priceCache.get(matchId);
    if (!p) { p = {}; for (const mk of R.latestMarkets(db, matchId)) if (mk.price != null) p[mk.label] = mk.price; priceCache.set(matchId, p); }
    return p[label] ?? null;
  };
  let openCount = 0, invested = 0, openMarkValue = 0, openPnl = 0;
  let openPlus = 0, openPlusPnl = 0, openMinus = 0, openMinusPnl = 0;
  for (const rsv of R.allShadowReserves(db)) {
    if (rsv.state !== "reserved") continue;
    const b = rsv.bet_id ? R.getBet(db, rsv.bet_id) : null;
    if (!b || b.status !== "open") continue;
    const entry = b.entry_price ?? 0;
    const cur = priceFor(b.match_id, b.market_label) ?? b.current_price ?? entry;
    const mark = entry > 0 ? rsv.size * (cur / entry) : rsv.size; // bank commitment marked to market
    const pnl = mark - rsv.size;
    openCount++; invested += rsv.size; openMarkValue += mark; openPnl += pnl;
    if (pnl >= 0) { openPlus++; openPlusPnl += pnl; } else { openMinus++; openMinusPnl += pnl; }
  }

  // Execution costs scaled to the bank's commitment (the fill ledger is at sim-stake
  // notional; scale each fill by committed/stake so the drag is on the real $5000).
  const scaledCosts = R.allFillCosts(db).map((f) => {
    const committed = f.bet_id ? committedByBet.get(f.bet_id) ?? 0 : 0;
    const b = f.bet_id ? R.getBet(db, f.bet_id) : null;
    const stake = b?.stake ?? f.notional_usd;
    const scale = stake > 0 ? Math.min(4, committed / stake) : 0; // guard against a degenerate ratio
    return { ...f, fee_usd: f.fee_usd * scale, slip_usd: f.slip_usd * scale, notional_usd: f.notional_usd * scale };
  });
  const fc = summarizeFillCosts(scaledCosts as R.FillCostRow[]);

  const netRealized = earned - lostMoney;
  return {
    bank: r2(bank), balance: r2(bank + netRealized), equity: r2(bank + netRealized + openPnl),
    free: r2(pool.free), invested: r2(invested), settling: r2(pool.settling),
    earned: r2(earned), lostMoney: r2(lostMoney), netRealized: r2(netRealized),
    settled, won, lost,
    openCount, openMarkValue: r2(openMarkValue), openPnl: r2(openPnl),
    openPlus, openPlusPnl: r2(openPlusPnl), openMinus, openMinusPnl: r2(openMinusPnl),
    fees: fc.feeUsd, slippage: fc.slipUsd, costTotal: fc.totalUsd,
  };
}
