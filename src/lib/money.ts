// ============================================================
// EDGE LAB — money model (ТЗ §3.1) + related invariants (§9.1–§9.3)
//
// Two levels of money:
//   1) Treasury -> Competition: budget in $ reserved from free balance.
//   2) Competition -> Strategy: share in % (sum <= 100). % * budget = $.
//
// Comparison of strategies is by ROI %, never absolute P&L (§3.1, §9.10).
// ============================================================

import type { Competition } from "./types.js";

/** Sum of all competition budgets = allocated portion of the treasury. */
export function allocated(competitions: Pick<Competition, "budget">[]): number {
  return competitions.reduce((a, c) => a + (c.budget || 0), 0);
}

/** Free = total − allocated. Invariant §9.1: must stay >= 0. */
export function freeBalance(
  totalBalance: number,
  competitions: Pick<Competition, "budget">[],
): number {
  return round2(totalBalance - allocated(competitions));
}

/**
 * Can we set `newBudget` on `compId` without over-allocating the treasury?
 * The competition's own current budget is released back before the check,
 * so re-setting an existing budget behaves intuitively.
 */
export function canSetBudget(
  totalBalance: number,
  competitions: Pick<Competition, "id" | "budget">[],
  compId: string,
  newBudget: number,
): boolean {
  if (newBudget < 0) return false;
  const others = competitions
    .filter((c) => c.id !== compId)
    .reduce((a, c) => a + (c.budget || 0), 0);
  return others + newBudget <= totalBalance + 1e-9;
}

/** $ budget of a strategy on a competition = budget * pct / 100. */
export function stratBudget(compBudget: number, pct: number): number {
  return Math.round(((compBudget || 0) * (pct || 0)) / 100);
}

/** Sum of shares (%) on a competition. */
export function sharesTotal(shares: { pct: number }[]): number {
  return round2(shares.reduce((a, s) => a + (s.pct || 0), 0));
}

/** Invariant §9.2: sum of strategy shares on a competition <= 100%. */
export function sharesValid(shares: { pct: number }[]): boolean {
  return sharesTotal(shares) <= 100 + 1e-9;
}

/**
 * Invariant §9.3: total stake of a strategy's bets on a match
 * must not exceed its budget on that competition.
 */
export function stakeWithinBudget(
  bets: { stake: number | null }[],
  strategyBudget: number,
): boolean {
  const total = bets.reduce((a, b) => a + (b.stake || 0), 0);
  return total <= strategyBudget + 1e-9;
}

/** ROI % of an equity result against the budget that produced it. */
export function roi(pnl: number, budget: number): number {
  return budget > 0 ? (pnl / budget) * 100 : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
