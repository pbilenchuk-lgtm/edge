// ============================================================
// EDGE LAB — team-name folding (leaf module, no deps).  [S11]
//
// The canonical letter-fold + single-token normalizer used by BOTH the live name-match path
// (engine.teamTokens) and the persisted alias store (teamAliases). Kept in one leaf module so the two
// CANNOT drift: an alias key normalized here lands in exactly the token space teamTokens compares on.
// ============================================================

/** Fold locale letters ESPN/StatPal render in ASCII that NFD alone won't bridge (ø→o, ß→ss, ə→a …). */
export function foldLetters(s: string): string {
  return s
    .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/œ/g, "oe").replace(/ß/g, "ss")
    .replace(/đ/g, "d").replace(/ð/g, "d").replace(/ł/g, "l").replace(/þ/g, "th").replace(/ħ/g, "h").replace(/ı/g, "i")
    .replace(/ə/g, "a"); // schwa (Azerbaijani) — NFD leaves it intact; "Zirə" → "Zira"
}

/** Normalize ONE token to the same canonical form teamTokens compares on: fold → NFD strip diacritics →
 *  lowercase → keep letters/digits only. An alias key/value must pass through this so it matches at runtime. */
export function foldToken(w: string): string {
  return foldLetters(String(w).toLowerCase()).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}
