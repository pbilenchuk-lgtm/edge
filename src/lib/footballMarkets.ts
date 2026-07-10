// ============================================================
// EDGE LAB — map a Polymarket FOOTBALL market label to a code-derived probability.
//
// The analyst estimates only `core`; poisson.ts derives every market. This module
// is the bridge: given a raw Polymarket label (e.g. "Over 2.5", "Both Teams to
// Score — No", "Brazil (-1.5)", "Team to Advance — Norway") plus the home/away
// names, it returns the model's probability that the label resolves YES, or null
// if the label isn't one we derive (then ai_prob stays unset, as before).
// ============================================================

import type { DerivedMarkets } from "./poisson.js";

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}.\-+ ]/gu, " ").replace(/\s+/g, " ").trim();
const inv = (p: number | null) => (p == null ? null : Math.round((1 - p) * 10000) / 10000);
/** Distinctive tokens of a team name (≥3 chars, or short with a digit) for a
 *  loose "does this label mention that team" test. */
const teamTokens = (name: string) => new Set(norm(name).split(" ").filter((w) => w.length >= 3 || /\d/.test(w)));
const mentions = (labelNorm: string, name: string): boolean => {
  const toks = [...teamTokens(name)];
  return toks.length > 0 && toks.some((t) => new RegExp(`(?:^| )${t}(?:$| )`).test(labelNorm));
};

/** Which totals scope a label refers to, from half/team keywords. */
function totalsScope(s: string, home: string, away: string): { key: keyof DerivedMarkets; team?: "home" | "away" } {
  if (/\b(1st half|first half|1h|ht)\b/.test(s)) return { key: "totals_1h" };
  if (/\b(2nd half|second half|2h)\b/.test(s)) return { key: "totals_2h" };
  if (mentions(s, home)) return { key: "totals_home", team: "home" };
  if (mentions(s, away)) return { key: "totals_away", team: "away" };
  return { key: "totals_match" };
}

/**
 * Probability the label resolves YES per the derived distribution, or null when
 * the market isn't derived. `sideNo` flips YES/NO markets the caller already split.
 */
export function footballLabelProb(rawLabel: string, home: string, away: string, d: DerivedMarkets): number | null {
  const s = norm(rawLabel);
  // explicit side words appended by the market-side expansion ("— No", "— Under")
  const isNo = /\b(no|under)\b/.test(s) && !/\byes\b/.test(s);

  // 0) CONSERVATIVE SEMANTIC GUARD (before any greedy keyword rule).
  // The rules below match on a single keyword ("over", a team name, "draw") and
  // ignore the rest of the label — so a market whose SUBJECT or MOMENT we don't
  // derive would silently get a goals/moneyline probability by coincidence of
  // wording. Return null for those instead: no ai_prob is correct, a fabricated
  // one is not (and it would be traded on). Draw is a genuine 1X2 tie and stays
  // handled below; this catches the siblings of that same string-matching class.
  // (a) Subjects we never derive (non-goal totals, scorer/specials).
  if (/\b(corners?|cards?|bookings?|yellow|red card|offsides?|fouls?|throw|tackles?|saves?|possession|clean sheet|to score first|first (goal|scorer|team to score)|last goal|anytime|scorer|score in both halves|either half|highest scoring)\b/.test(s)) return null;
  // (b) TEAM + HALF total ("Spain 2nd Half O/U 1.5"): we derive match halves
  // (totals_1h/2h) and full-match team totals (totals_home/away) but NOT a team's
  // per-half total — so it must not collapse into the match-half or full-team cell.
  const isHalf = /\b(1st half|first half|1h|2nd half|second half|2h)\b/.test(s);
  if (isHalf && /\b(over|under)\b/.test(s) && (mentions(s, home) || mentions(s, away))) return null;

  // 1) TOTALS — "over/under X.5" (optionally team- or half-scoped)
  const tot = s.match(/\b(over|under)\s+(\d+(?:\.\d+)?)\b/);
  if (tot) {
    const side = tot[1], line = String(Number(tot[2]));
    const scope = totalsScope(s, home, away);
    const table = d[scope.key] as Record<string, number> | undefined;
    const over = table && line in table ? table[line] : null;
    return side === "under" ? inv(over) : over;
  }

  // 2) BOTH TEAMS TO SCORE (+ 2nd-half variant)
  if (/\b(both teams to score|btts)\b/.test(s)) {
    const yes = /\b(2nd half|second half|2h)\b/.test(s) ? d.btts_2h : d.btts;
    return isNo ? inv(yes) : yes;
  }

  // 3) HANDICAP — "<team> (-1.5)" / "(+1.5)". Parens are stripped by norm, so key
  //    off the SIGNED spread token (a +/- number reliably means a handicap here).
  const hc = s.match(/(?:^| )([-+]\d+(?:\.\d+)?)(?:$| )/);
  if (hc) {
    const spread = Number(hc[1]);
    const homeSide = mentions(s, home);
    const awaySide = mentions(s, away);
    // We derive the home covering −1.5 / −2.5. Everything else is a complement.
    if (homeSide && spread === -1.5) return d.handicap["home_-1.5"] ?? null;
    if (homeSide && spread === -2.5) return d.handicap["home_-2.5"] ?? null;
    if (awaySide && spread === 1.5) return inv(d.handicap["home_-1.5"] ?? null);  // away +1.5 = home doesn't win by ≥2
    if (awaySide && spread === 2.5) return inv(d.handicap["home_-2.5"] ?? null);
    if (awaySide && spread === -1.5) return inv(d.handicap["away_+1.5_complement"] ?? null); // rare; not derived → null
    return null;
  }

  // 4) ADVANCE (knockout)
  if (/\b(advance|to advance|advances|qualify|progress)\b/.test(s)) {
    if (mentions(s, home)) return d.advance.home;
    if (mentions(s, away)) return d.advance.away;
    return null;
  }

  // 5) EXTRA TIME
  if (/\bextra time\b/.test(s)) return isNo ? inv(d.extra_time_prob) : d.extra_time_prob;

  // 6) DRAW (group-stage 1X2 tie)
  if (/\bdraw\b/.test(s)) return isNo ? inv(d.outcome_90.draw) : d.outcome_90.draw;

  // 7) 1X2 TEAM WIN — a bare team name (no over/under/handicap keyword)
  if (mentions(s, home)) return isNo ? inv(d.outcome_90.home) : d.outcome_90.home;
  if (mentions(s, away)) return isNo ? inv(d.outcome_90.away) : d.outcome_90.away;

  return null; // not a market we derive → leave ai_prob unset
}
