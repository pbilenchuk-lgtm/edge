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

import type { Bet, Match } from "./types.js";

// Did the match go to EXTRA TIME? A knockout does iff it was level after 90'. Signals, in order:
//   • a LEVEL final score ⇒ the tie was unbroken through ET → penalties → definitely ET (true);
//   • an ET/penalties note in end_note/duration ⇒ true;
//   • a known final MINUTE ⇒ ET was played iff it ran past regulation (≥100'); ≤99' = regulation (false);
//   • nothing known ⇒ null (leave the ET market external/void, as before — never guess).
export function matchPhase(match: Match): { wentToExtraTime: boolean | null } {
  if (match.score_home != null && match.score_away != null && match.score_home === match.score_away) return { wentToExtraTime: true };
  if (/extra[\s-]*time|over[\s-]*time|penalt|shoot[\s-]*out|доп\.?\s*время|овертайм|пенальт/i.test(`${match.end_note ?? ""} ${match.duration ?? ""}`)) return { wentToExtraTime: true };
  if (match.minute != null) return { wentToExtraTime: match.minute >= 100 };
  return { wentToExtraTime: null };
}

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
// A bet HELD TO THE REAL OUTCOME (not an early/partial cash-out, not a void). These are the only settles that
// measure prediction quality (Brier/CLV) and count as decisive win/loss. `null` = the legacy match-score
// settle (before the provenance field existed); "match_score" and "pm_resolution" are the two explicit
// sources (Decision-1 condition 5). Early/partial/void/void_timeout are NOT held-to-settle.
export function isResolutionSettle(settledBy: string | null | undefined): boolean {
  return settledBy == null || settledBy === "match_score" || settledBy === "pm_resolution";
}

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
 * Resolve a TENNIS winner market. Provenance (read from real Polymarket AO/WTA markets,
 * 2026-07): the market resolves to whoever ADVANCES — normal win OR the opponent's
 * retirement/default/disqualification (the non-retiring player advances). Canceled /
 * not-played / no-winner → 50-50 (we VOID: null). A winner-market outcome label is a
 * player NAME, so YES if the label matches the advancing player, NO if it matches the
 * loser, null if it matches neither (unresolvable — keep open / flag).
 */
export function resolveTennisWinner(
  label: string, p1: string, p2: string,
  advancing: "first" | "second" | null, canceled: boolean,
): boolean | null {
  if (canceled || advancing == null) return null; // 50-50 → void/refund
  const surnames = (name: string) => name.toLowerCase().replace(/[.,]/g, " ").split(/[\s-]+/).filter((t) => t.length > 1);
  const l = label.toLowerCase();
  const hit = (name: string) => surnames(name).some((t) => l.includes(t));
  const winnerName = advancing === "first" ? p1 : p2;
  const loserName = advancing === "first" ? p2 : p1;
  const matchWinner = hit(winnerName), matchLoser = hit(loserName);
  if (matchWinner && !matchLoser) return true;   // this outcome = the advancing player → YES
  if (matchLoser && !matchWinner) return false;  // this outcome = the loser → NO
  return null;                                   // ambiguous / neither → unresolvable
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
  phase?: { wentToExtraTime: boolean | null },
): boolean | null {
  const total = scoreHome + scoreAway;
  const l = label.toLowerCase();

  // A YES/NO market surfaced as two sides ("<market> — Yes" / "— No"): resolve
  // the BASE market and negate for the No side. Only the explicit suffix form
  // (em-dash/colon + Yes|No at the very end), so "Draw No Bet" isn't mistaken.
  const sideSuffix = l.match(/[—:]\s*(yes|no)\s*$/);
  if (sideSuffix) {
    const base = label.slice(0, sideSuffix.index).replace(/[\s—:]+$/, "");
    const r = resolveFootballMarket(base, scoreHome, scoreAway, teams, phase); // forward phase to the base
    return r == null ? null : sideSuffix[1] === "no" ? !r : r;
  }

  // "Will the match go to EXTRA TIME / OVERTIME?" — a knockout goes to ET iff it was level after 90.
  // Not derivable from the score alone (a match level at 90 can be decided in ET → non-level final),
  // so it needs the match PHASE (regulation vs ET, from the final minute / a level final / an ET note).
  // Resolvable when the caller supplies it; else external (null) as before. Advancement stays external.
  if (/\bextra[\s-]*time\b|\bover[\s-]*time\b|go to extra|дополнительное время|овертайм/.test(l)) {
    return phase?.wentToExtraTime ?? null;
  }
  // "Will the match go to PENALTIES / shootout?" — a knockout ends on penalties iff it's still level
  // after extra time, i.e. the FINAL score is level. Derivable from the score alone.
  if (/\bpenalt|\bshoot[\s-]*out\b|пенальт|серии пенальти/.test(l)) return scoreHome === scoreAway;

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
    if (scored === line) return null; // exact push on a whole-number line → refund stake (void)
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
    const adjusted = margin + line;
    if (adjusted === 0) return null; // whole-number handicap lands exactly on the line → push (refund)
    return adjusted > 0;
  }

  // Draw No Bet — back the named side; a DRAW is a PUSH (stake refunded via the
  // void path), NOT a loss. Was caught by the bare /draw/ test below and settled
  // as a straight draw → a winning side booked as a total loss.
  if (/\bno bet\b|\bdnb\b/.test(l)) {
    if (scoreHome === scoreAway) return null;   // push → refund
    return (side ?? "home") === "away" ? scoreAway > scoreHome : scoreHome > scoreAway;
  }
  // Double chance — two of the three 1X2 outcomes backed:
  //   "Home or Draw" / "1X"  → not an away win   (scoreHome ≥ scoreAway)
  //   "Away or Draw" / "X2"  → not a home win     (scoreAway ≥ scoreHome)
  //   "Home or Away" / "12"  → not a draw
  if (/\bhome or away\b|\b12\b/.test(l)) return scoreHome !== scoreAway;
  if (/\bor draw\b|double chance|двойной шанс|\b1x\b|\bx2\b/.test(l)) {
    return (/\bx2\b/.test(l) || side === "away") ? scoreAway >= scoreHome : scoreHome >= scoreAway;
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
    const hasH = has(h), hasA = has(a);
    if (hasH && !hasA) return "home";
    if (hasA && !hasH) return "away";
    // Both teams named on a NON-draw label (e.g. a 2-way "A vs B" winner market,
    // or a same-city derby where both share a distinctive token): the priced
    // outcome leads the label, so the backed side is the FIRST-named team.
    // Was returning null here → a real winner got voided. (Draw is already
    // handled by the caller before this runs.)
    if (hasH && hasA) return l.indexOf(h) <= l.indexOf(a) ? "home" : "away";
  }
  return null;
}

/**
 * For an UNDER-type total ("Under 3.5", "Rosenborg Under 2.5", team clean-sheet "X Under 0.5"),
 * how much MARGIN the thesis still has RIGHT NOW, in goals: (line − goals-so-far-on-the-relevant
 * -side). Positive = the Under is still winning if the match ended now; ≥1 means a single further
 * goal cannot yet break it. This is the mirror of `winsOnEventOccurrence` (which flags Over/BTTS-Yes
 * options): an Under LOSES only when goals climb to the line, so while the margin is comfortable a
 * price crash is a book artifact, not a broken thesis — the deterministic price stop must not fire.
 *
 * Returns null when the label isn't an Under total we can score (the "o/u" alias BACKS the over, a
 * named team total we can't disambiguate, or not a total at all) → caller keeps the normal stop.
 * Team totals settle off the named side; a generic/absent prefix off the aggregate — identical
 * parsing to resolveFootballMarket's totals branch, so live suppression and final settlement agree.
 */
export function underThesisMarginGoals(
  label: string, scoreHome: number, scoreAway: number, teams?: { home: string; away: string },
): number | null {
  const l = label.toLowerCase();
  const ou = l.match(/(?:^|\s)(under|o\/u)\s*(\d+(?:\.\d+)?)/);
  if (!ou || ou[1] !== "under") return null; // only the UNDER side loses on a goal ("o/u" backs over)
  const line = parseFloat(ou[2]);
  if (!isFinite(line)) return null;
  const side = labelSide(l, teams);
  const prefix = l.slice(0, ou.index ?? 0).trim();
  const genericPrefix = prefix.split(/\s+/).filter(Boolean).every((t) => TOTAL_WORDS.has(t));
  if (side == null && !genericPrefix) return null; // named team total we can't disambiguate → keep the stop
  const scored = side === "home" ? scoreHome : side === "away" ? scoreAway : scoreHome + scoreAway;
  return line - scored;
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
