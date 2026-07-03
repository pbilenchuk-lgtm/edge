// ============================================================
// EDGE LAB — settlement (ТЗ §3.4)
//
// Prediction-market payout: buying an outcome share at price p (cents)
// costs p/100 dollars per share and pays $1 if it resolves YES.
//   shares  = stake / (entry/100)
//   payout  = won ? shares * 1 : 0  =  won ? stake / (entry/100) : 0
//   pnl     = payout − stake
// On settlement we also snapshot closing_price on the bet for CLV (§2.10).
// ============================================================

import type { Bet } from "./types.js";

/** Total return ($) of a bet: stake plus profit if won, else 0. */
export function payout(entryPriceCents: number, stake: number, won: boolean): number {
  if (!won) return 0;
  if (entryPriceCents <= 0) return 0;
  return round2(stake / (entryPriceCents / 100));
}

export interface SettlePatch {
  status: "settled_won" | "settled_lost";
  result: "won" | "lost";
  payout: number;
  closing_price: number | null;
  pnl: number;
}

/**
 * Settle one open bet given the resolved outcome and the market's closing
 * price (for CLV). Returns the fields to persist plus the realized P&L.
 */
export function settleBet(
  bet: Pick<Bet, "entry_price" | "stake">,
  won: boolean,
  closingPriceCents: number | null,
): SettlePatch {
  const entry = bet.entry_price ?? 0;
  const stake = bet.stake ?? 0;
  const pay = payout(entry, stake, won);
  return {
    status: won ? "settled_won" : "settled_lost",
    result: won ? "won" : "lost",
    payout: pay,
    closing_price: closingPriceCents,
    pnl: round2(pay - stake),
  };
}

/**
 * Resolve a common football market from the final score.
 * Returns true (YES), false (NO), or null when the label needs external
 * info the score alone can't provide (e.g. "Team to Advance", penalties).
 * Caller can supply an explicit override for those (ТЗ §3.4).
 */
export function resolveFootballMarket(
  label: string,
  scoreHome: number,
  scoreAway: number,
): boolean | null {
  const total = scoreHome + scoreAway;
  const l = label.toLowerCase();

  const ou = l.match(/(over|under)\s*(\d+(?:\.\d+)?)/);
  if (ou) {
    const line = parseFloat(ou[2]);
    return ou[1] === "over" ? total > line : total < line;
  }

  if (/both teams to score|btts/.test(l)) {
    const yes = scoreHome > 0 && scoreAway > 0;
    return /—\s*no|:\s*no|\bno\b/.test(l) ? !yes : yes;
  }

  // Handicap "-1.5" on the home side: home wins by 2+.
  const hcap = l.match(/-\s*(\d+(?:\.\d+)?)/);
  if (hcap && /(?:home|-1\.5|-2\.5)/.test(l)) {
    const line = parseFloat(hcap[1]);
    return scoreHome - scoreAway > line;
  }

  return null; // "Team to Advance", extra-time, penalties => external result
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
