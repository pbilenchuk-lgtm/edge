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

  // Totals — "Over/Under X", or Polymarket's "O/U X" (backs Over). A team total
  // ("Colombia Over 2.5") names a side → settle against THAT team's goals, not
  // the aggregate. A prefixed total whose side we can't identify (no team info)
  // is left unsettleable (null) rather than wrongly resolved off the total.
  const ou = l.match(/(?:^|\s)(over|under|o\/u)\s*(\d+(?:\.\d+)?)/);
  if (ou) {
    const line = parseFloat(ou[2]);
    const over = ou[1] !== "under"; // "over" and "o/u" back the Over side
    const side = labelSide(l, teams);
    // What sits before the total? A generic word ("Total/Goals Over 2.5") or
    // nothing ("Over 2.5") → the AGGREGATE (settle off the combined score). A
    // NAMED prefix ("Colombia Over 2.5") is a team total: settle off that side
    // if we can identify it, else it's unresolvable (null) — don't wrongly
    // settle it off the aggregate.
    const prefix = l.slice(0, ou.index ?? 0).trim();
    const genericPrefix = prefix.split(/\s+/).filter(Boolean).every((t) => TOTAL_WORDS.has(t));
    if (side == null && !genericPrefix) return null; // a named (team) total we can't disambiguate
    const scored = side === "home" ? scoreHome : side === "away" ? scoreAway : total;
    return over ? scored > line : scored < line;
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

// Words that can precede a total without naming a team — "Total/Goals Over 2.5"
// is the aggregate, "Colombia Over 2.5" is a team total.
const TOTAL_WORDS = new Set(["total", "totals", "goals", "goal", "match", "aggregate", "combined", "full", "time", "ft", "the", "points", "score"]);

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

// Generic club suffixes that don't identify a team on their own — "Manchester
// United" vs "Newcastle United" must key on "manchester", not "united", or the
// moneyline is unresolvable and gets wrongly voided.
const NAME_STOPWORDS = new Set(["fc", "afc", "sc", "cf", "ac", "as", "cd", "sv", "fk", "if", "bk", "club", "united", "city", "town", "county", "calcio", "sporting", "real", "athletic", "atletico"]);
/** Most distinctive token of a team name (skips generic suffixes), lowercased. */
function nameKey(name: string): string {
  const toks = name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const distinctive = toks.filter((w) => !NAME_STOPWORDS.has(w));
  const pool = distinctive.length ? distinctive : toks;
  return pool.length ? pool[pool.length - 1] : "";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
