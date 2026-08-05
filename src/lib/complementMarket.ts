// ============================================================
// EDGE LAB — COMPLEMENT LOOKUP FOR PM-RESOLUTION SETTLEMENT
//
// The PM-resolution settler refuses to settle on a single token: an inverted outcome↔label mapping would book
// a win as a loss, so it demands the complementary side as a cross-check. It reads that complement from
// `markets.token_second` — and 44,255 of 119,839 market rows (37%) do not have it, including every totals book
// ft_blind trades. The complement is not missing from Polymarket; it is sitting right there in the same match
// as its own row. We simply never stored the pointer.
//
// Consequence, measured: all 7 of the first ft_blind entries settled `void` while their markets resolved
// cleanly at 1¢ and 99.6¢. The mode enters and can never finish, so its cohort can never mature and its 50%
// probation cap can never be reviewed.
//
// This module SUPPLIES the guard with the data it was missing. It does not relax it: a complement found here
// goes through exactly the same checks as a stored one (≈0/100 pairing, two-poll stability, closed flag), and
// when nothing is found the settler still holds and voids on timeout as before.
//
// THE MATCHING IS THE DANGEROUS PART, and is deliberately strict. A totals market carries a LINE, and
// settling «Under 3.5» against the price of «Over 1.5» would be an orientation bug in settled money — the same
// class as the four token-orientation bugs this project has already paid for, just moved into the settle path.
// So the pair is keyed on (subject × exact line × inverted side), never on "some opposite-looking total in the
// same match".
//
// The implementation reuses outcomeKey — the same fold the notation_desync rule uses — because it already
// normalises notations and, crucially, KEEPS the digits of the line. «Under 3.5» → "under35" and «Over 1.5» →
// "over15" can therefore never be paired. The side token is swapped only when it ANCHORS THE END of the key,
// so a club whose name contains a side word (Yesilyurt → "yesilyurt…") is never corrupted mid-string.
// ============================================================

import { outcomeKey } from "./zombieMarket.js";

export interface ComplementCandidate { label: string; external_ref: string | null }
export interface ComplementHit { label: string; token: string; key: string; via: "stored" | "match" }

/** Side tokens that invert. Ordered longest-first so "under"/"over" are tried before the bare yes/no. */
const SIDE_SWAPS: [RegExp, string][] = [
  [/under(\d+)$/, "over$1"],
  [/over(\d+)$/, "under$1"],
  [/yes$/, "no"],
  [/no$/, "yes"],
];

/**
 * The complement KEY for a label, or null when the label has no invertible side anchored at its end.
 *
 * Returning null is a real answer, not a failure: a handicap like «Team (-1.5)» folds to a key with no side
 * token, and a market whose complement we cannot name with certainty must not be settled against a guess.
 */
export function complementKey(label: string): string | null {
  const k = outcomeKey(label);
  for (const [re, to] of SIDE_SWAPS) {
    if (re.test(k)) {
      const swapped = k.replace(re, to);
      return swapped === k ? null : swapped;   // paranoia: a no-op swap is not a complement
    }
  }
  return null;
}

/** Side words that invert, at WORD level on the raw label (not on the folded key). */
const SIDE_WORD_SWAPS: [RegExp, string][] = [
  [/\bunder\b/gi, "Over"], [/\bover\b/gi, "Under"],
  [/\bменьше\b/gi, "Больше"], [/\bбольше\b/gi, "Меньше"],
  [/\bтм\b/gi, "ТБ"], [/\bтб\b/gi, "ТМ"],
  [/\byes\b/gi, "No"], [/\bno\b/gi, "Yes"],
  [/\bда\b/gi, "Нет"], [/\bнет\b/gi, "Да"],
];

/**
 * Комплементарная ПОДПИСЬ (не ключ): «Under 3.5 goals» → «Over 3.5 goals».
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ complementKey. Тот меняет сторону только когда она ЗАМЫКАЕТ свёрнутый ключ — это
 * намеренная строгость сеттла, и её трогать нельзя. Но для гейта когерентности сторон она оборачивается
 * дырой: «Under 3.5 goals» сворачивается в "under35goals", ни один end-anchored свап не подходит, ключ
 * равен null — конфликт не найден, обе стороны входят. При этом sameMarketLabel считает «Under 3.5 goals»
 * и «Under 3.5» ОДНИМ рынком (goals — филлер), то есть исполнение обе строки принимает.
 *
 * Здесь свап делается по СЛОВУ на исходной подписи, а сравнение потом идёт через sameMarketLabel — тот же
 * авторитет, которым исполнитель привязывает пик к рынку. Побочно закрывается и ложный ключ у
 * complementKey: слово-границы не позволяют «Torino» превратиться в «Toriyes».
 *
 * Ровно ОДНА сторона свапается за вызов (первое совпавшее правило) — «Over 2.5 — Yes» не должен
 * инвертироваться дважды и вернуться к себе.
 */
export function complementLabel(label: string): string | null {
  const s = String(label ?? "");
  for (const [re, to] of SIDE_WORD_SWAPS) {
    re.lastIndex = 0;
    if (!re.test(s)) continue;
    re.lastIndex = 0;
    const swapped = s.replace(re, to);
    return swapped.toLowerCase() === s.toLowerCase() ? null : swapped;
  }
  return null;
}

/**
 * Find the complementary market for `label` among this match's own markets.
 *
 * Requires EXACTLY ONE candidate to carry the complement key. Two rows sharing it means the catalogue has
 * duplicate notations of the same outcome (the very condition notation_desync quarantines), and picking one of
 * them arbitrarily is how a settle silently binds to the wrong book — so ambiguity resolves to null and the
 * settler falls back to holding.
 */
export function findComplementMarket(label: string, markets: ComplementCandidate[]): ComplementHit | null {
  const want = complementKey(label);
  if (!want) return null;
  const self = outcomeKey(label);
  const hits = markets.filter((m) => m.external_ref && outcomeKey(m.label) === want && outcomeKey(m.label) !== self);
  if (hits.length !== 1) return null;
  return { label: hits[0].label, token: hits[0].external_ref as string, key: want, via: "match" };
}

/**
 * The complement token to cross-check with, preferring the stored pointer and falling back to the match
 * catalogue. `via` travels with it so every settled row can say which source it used — a settle dispute must
 * be answerable from the record, not from archaeology.
 */
export function resolveComplement(
  label: string, storedToken: string | null | undefined, markets: ComplementCandidate[],
): ComplementHit | null {
  if (storedToken) return { label, token: storedToken, key: complementKey(label) ?? "", via: "stored" };
  return findComplementMarket(label, markets);
}
