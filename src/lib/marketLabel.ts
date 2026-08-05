// ============================================================
// EDGE LAB — ОДИН АВТОРИТЕТ НА ВОПРОС «ЭТО ТОТ ЖЕ РЫНОК?»
//
// `sameMarketLabel` жил в analysis.ts и оттуда импортировался в lifecycle. Когда за тот же ответ
// понадобилось спросить из sideCoherence (гейт когерентности сторон), прямой импорт замкнул бы цикл
// analysis → sideCoherence → analysis. Вынесено в отдельный модуль БЕЗ изменения поведения: analysis.ts
// его реэкспортирует, все прежние импорты продолжают работать.
//
// Почему не «своя маленькая копия правила в sideCoherence»: гейт обязан считать одинаковыми ровно те
// подписи, которые исполнитель считает одним рынком. Разъедься эти два ответа — и блок-лист промахнётся
// мимо той самой строки, которую он запрещает (класс «два авторитета на одно решение»).
// ============================================================

export const normLabel = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export const tokenSet = (s: string) => new Set(normLabel(s).split(" ").filter(Boolean));
// Numbers a label carries (e.g. "over 2.5 goals" → "2.5"). Two labels can only
// fuzzy-match if their numbers are identical.
export const numTokens = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).sort().join(",");
// Non-numeric words safe to differ between a market label and the model's
// paraphrase of it. Anything OUTSIDE this set changes the market's meaning.
const LABEL_FILLER = new Set(["goals", "goal", "total", "points", "point", "match", "result", "the", "full", "time", "of"]);
/** True iff every token present in exactly one of the two sets is pure filler. */
export const extraAllFiller = (a: Set<string>, b: Set<string>): boolean => {
  for (const t of a) if (!b.has(t) && !LABEL_FILLER.has(t) && !/^\d/.test(t)) return false;
  for (const t of b) if (!a.has(t) && !LABEL_FILLER.has(t) && !/^\d/.test(t)) return false;
  return true;
};

/** Do two market labels refer to the same market? Exact (normalized) match, or a
 *  SAFE fuzzy match where the numbers line up and the only differing tokens are
 *  filler ("Over 2.5" ↔ "Over 2.5 goals") — never "Draw" ↔ "Draw no bet". Used
 *  to resolve the strategist's paraphrased pick/exit labels back to real markets. */
export function sameMarketLabel(a: string, b: string): boolean {
  const na = normLabel(a), nb = normLabel(b);
  if (na === nb) return true;
  return numTokens(na) === numTokens(nb) && extraAllFiller(tokenSet(a), tokenSet(b));
}
