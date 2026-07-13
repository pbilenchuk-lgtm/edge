// ============================================================
// EDGE LAB — OUR MONEY, in detail. Not per-strategy analytics (that lives on the
// strategy/match tabs) — this is the whole-treasury picture the Бюджет page needs:
// what we EARNED, what we LOST, what's still UNRESOLVED (outcome unknown), how much
// is IN-PROGRESS (capital deployed in open positions), and where those open
// positions STAND right now (marked to the freshest quote). Plus the execution-cost
// drag (fees + slippage). Read-only aggregation over the real bet ledger.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { summarizeFillCosts } from "./fillCosts.js";

export interface BudgetPosition {
  treasuryTotal: number;      // total treasury balance
  allocated: number;          // sum of competition budgets (the working pool)
  // Realised (settled) — decided money.
  earned: number;             // realised GAINS ($, sum of positive settled P&L)
  lostMoney: number;          // realised LOSSES ($, positive)
  netRealized: number;        // earned − lostMoney
  settled: number; won: number; lost: number;
  // Unresolved / in-progress — money still in play, outcome not yet known.
  openCount: number;          // open positions (outcome undetermined — "ещё не понятно")
  invested: number;           // capital currently committed to open positions ($)
  openMarkValue: number;      // current mark-to-market value of those positions ($)
  openPnl: number;            // unrealised P&L on open positions ($, mark − invested)
  openPlus: number; openPlusPnl: number;   // open positions currently in profit (count, $)
  openMinus: number; openMinusPnl: number; // open positions currently at a loss (count, $)
  // Queued — proposed but not yet filled (no capital committed).
  proposedCount: number; proposedStake: number;
  // Execution drag.
  fees: number; slippage: number; costTotal: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function budgetPosition(db: Database): BudgetPosition {
  const comps = R.listCompetitions(db);
  const allocated = comps.reduce((s, c) => s + (c.budget ?? 0), 0);
  const treasury = R.getTreasury(db);

  let earned = 0, lostMoney = 0, settled = 0, won = 0, lost = 0;
  let openCount = 0, invested = 0, openMarkValue = 0, openPnl = 0;
  let openPlus = 0, openPlusPnl = 0, openMinus = 0, openMinusPnl = 0;
  let proposedCount = 0, proposedStake = 0;

  for (const c of comps) {
    for (const m of R.listMatches(db, c.id)) {
      const price: Record<string, number> = {};
      for (const mk of R.latestMarkets(db, m.id)) if (mk.price != null) price[mk.label] = mk.price;
      for (const b of R.betsForMatch(db, m.id)) {
        if (b.status === "settled_won" || b.status === "settled_lost") {
          const pnl = (b.payout ?? 0) - (b.stake ?? 0);
          if (pnl >= 0) earned += pnl; else lostMoney += -pnl;
          // Count a distinct prediction only when settled by the REAL outcome — a
          // 'partial'/'void' slice is money but not a separate won/lost prediction.
          if (b.settled_by == null) { settled++; if (b.result === "won") won++; else lost++; }
        } else if (b.status === "open") {
          const stake = b.stake ?? 0;
          const entry = b.entry_price ?? 0;
          const cur = price[b.market_label] ?? b.current_price ?? b.entry_price ?? 0;
          const mark = entry > 0 ? stake * (cur / entry) : stake;
          const pnl = mark - stake;
          openCount++; invested += stake; openMarkValue += mark; openPnl += pnl;
          if (pnl >= 0) { openPlus++; openPlusPnl += pnl; } else { openMinus++; openMinusPnl += pnl; }
        } else if (b.status === "proposed") {
          proposedCount++; proposedStake += b.stake ?? 0;
        }
      }
    }
  }

  const fc = summarizeFillCosts(R.allFillCosts(db));
  return {
    treasuryTotal: r2(treasury.total_balance ?? 0), allocated: r2(allocated),
    earned: r2(earned), lostMoney: r2(lostMoney), netRealized: r2(earned - lostMoney),
    settled, won, lost,
    openCount, invested: r2(invested), openMarkValue: r2(openMarkValue), openPnl: r2(openPnl),
    openPlus, openPlusPnl: r2(openPlusPnl), openMinus, openMinusPnl: r2(openMinusPnl),
    proposedCount, proposedStake: r2(proposedStake),
    fees: fc.feeUsd, slippage: fc.slipUsd, costTotal: fc.totalUsd,
  };
}
