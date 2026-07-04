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
 *
 * `teams` (home/away names) lets us resolve side-specific markets — moneyline
 * ("Portugal", "Home to win") and signed handicaps ("Away -1.5") — which are
 * otherwise unresolvable and would leave the bet stuck open forever.
 */
export function resolveFootballMarket(
  label: string,
  scoreHome: number,
  scoreAway: number,
  teams?: { home: string; away: string },
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

  // Advancement / knockout progression depends on extra time & penalties —
  // never derivable from the 90-minute score. Keep external (override).
  if (/advance|progress|проход|выход|qualif/.test(l)) return null;

  // Which side does the label name? home/away keyword or the team's name.
  const side = labelSide(l, teams);

  // Signed handicap: "-1.5" / "+1.5" on the named side (default home).
  const hcap = l.match(/([+-])\s*(\d+(?:\.\d+)?)/);
  if (hcap) {
    const sign = hcap[1] === "-" ? -1 : 1;
    const line = sign * parseFloat(hcap[2]);
    const margin = (side ?? "home") === "away" ? scoreAway - scoreHome : scoreHome - scoreAway;
    return margin + line > 0;
  }

  // Moneyline / match winner: "Portugal", "Home", "Draw to win", "1x2".
  if (/\bdraw\b|ничья|\btie\b/.test(l)) return scoreHome === scoreAway;
  if (side === "home") return scoreHome > scoreAway;
  if (side === "away") return scoreAway > scoreHome;

  return null; // extra-time, penalties, unknown => external result
}

/** Detect which side (home/away) a market label refers to, by keyword or name. */
function labelSide(l: string, teams?: { home: string; away: string }): "home" | "away" | null {
  const home = /\bhome\b|хозяева/.test(l), away = /\baway\b|гости/.test(l);
  if (home && !away) return "home";
  if (away && !home) return "away";
  if (teams) {
    const h = nameKey(teams.home), a = nameKey(teams.away);
    const has = (k: string) => k.length >= 3 && l.includes(k);
    if (has(h) && !has(a)) return "home";
    if (has(a) && !has(h)) return "away";
  }
  return null;
}

/** Most distinctive (trailing) token of a team name, lowercased. */
function nameKey(name: string): string {
  const toks = name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  return toks.length ? toks[toks.length - 1] : "";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
