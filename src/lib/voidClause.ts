// ============================================================
// EDGE LAB — КЛАУЗА VOID ЧИТАЕТСЯ ИЗ ТЕКСТА РЫНКА, А НЕ ИЗ ОБЩЕГО ПРАВИЛА  (Р4, ратифицировано 09.08)
//
// ЧЕМ ЗАСЛУЖЕНО. Сверка с Gamma показала, что ретайр-клауза РАЗНАЯ у разных семей ОДНОГО И ТОГО ЖЕ матча:
//   • манилайн            — «resolves to the player who ADVANCES» (НЕ 50-50!);
//   • Set N Games O/U     — «if the first set is not completed FOR ANY REASON → 50-50» (область — СЕТ);
//   • Completed Match     — любой форфейт, включая ретайр и walkover → «No».
// Одно «общее правило voidов» на все три невозможно физически: применив сетовую клаузу к манилайну, мы
// вернули бы ставку там, где биржа платит проходящему.
//
// O14 ПРИМЕНЯЕТСЯ БУКВАЛЬНО: клауза — ФАКТ конкретного рынка, а не вывод из его имени. Она лежит текстом
// в `description` этого рынка, и читать надо её, а не нашу память о ней.
//
// ЧТО ЭТОТ МОДУЛЬ ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ. Он РАЗБИРАЕТ текст в структуру и НАЗЫВАЕТ, какие именно фразы
// сработали (провенанс на уровне цитаты). Он НЕ меняет расчёт: сначала надо увидеть, СОГЛАСНА ли наша
// зашитая семейная логика с текстом рынка, и только потом что-то трогать. Обратный порядок — это ровно та
// правка вслепую, которую замер уже дважды убил в этой сессии.
//
// РАСХОЖДЕНИЕ — ГЛАВНЫЙ ВЫХОД. `disagrees` отвечает на вопрос, который иначе задать нечем: «наше общее
// правило и текст этого рынка говорят одно и то же?». Пока такого сравнения нет, ошибка семейной логики
// неотличима от её правоты.
// ============================================================

/** Что происходит с рынком при РЕТАЙРЕ/дефолте/дисквалификации по ходу матча. */
export type OnRetire =
  | "advancer"      // разрешается в пользу того, кто ПРОШЁЛ дальше (манилайн)
  | "split"         // 50-50
  | "no"            // разрешается в «No» (Completed Match)
  | "unit_scope";   // зависит от того, завершилась ли СВОЯ единица (сет), а не матч

/** Область, завершение которой требуется для нормального расчёта. */
export type ClauseScope = "match" | "set" | "unknown";

export interface VoidClause {
  onRetire: OnRetire;
  scope: ClauseScope;
  /** ЦИТАТЫ, на которых стоит вывод. Без них клауза — наше утверждение, а не факт рынка. */
  quotes: string[];
  /** Уверенность разбора: `parsed` — нашли явные фразы; `unparsed` — текст есть, но клаузы в нём не видно. */
  status: "parsed" | "unparsed";
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Предложения текста — клауза живёт в предложении, и цитировать надо его целиком. */
function sentences(text: string): string[] {
  return norm(text).split(/(?<=[.!?])\s+/).filter(Boolean);
}

/**
 * Разбор клаузы ИЗ ТЕКСТА рынка. Ничего не додумывает: если явных фраз нет, возвращает `unparsed` — и это
 * честный отказ, а не тихий дефолт к «общему правилу». Дефолт здесь и был бы дефектом.
 */
export function parseVoidClause(description: string | null | undefined): VoidClause {
  const text = norm(description ?? "");
  if (!text) return { onRetire: "unit_scope", scope: "unknown", quotes: [], status: "unparsed" };
  const ss = sentences(text);
  const quotes: string[] = [];
  // ПРИОРИТЕТ ПО СМЫСЛУ, А НЕ ПО ПОРЯДКУ ПРЕДЛОЖЕНИЙ. Первая версия читала текст сверху вниз и первой
  // же встречала общую клаузу «cancel/tie/delay → 50-50», после чего клауза РЕТАЙРА («resolve to the
  // player who advances») уже не могла её перебить. Тест на дословном тексте манилайна это поймал.
  // Ошибка была бы дорогой: мы вернули бы ставку там, где биржа платит проходящему.
  //
  // Клаузы говорят о РАЗНЫХ событиях: отмена/ничья/walkover — это не ретайр. Поэтому они собираются
  // порознь, и `onRetire` определяет только та, что про ретайр.
  let retireClause: OnRetire | null = null;   // что при РЕТАЙРЕ
  let cancelSplit = false;                    // есть ли 50-50 при отмене/ничьей/walkover
  let scope: ClauseScope = "unknown";

  for (const s of ss) {
    const l = s.toLowerCase();
    // Completed Match: любой форфейт (включая ретайр) → «No». Самая специфичная — берётся безусловно.
    if (/forfeit|walkover|retirement/.test(l) && /resolve[sd]?\s*"?no"?/.test(l)) {
      retireClause = "no"; scope = "match"; quotes.push(s); continue;
    }
    // Манилайн: при ретайре/дефолте/дисквалификации платит ПРОХОДЯЩИЙ.
    if (/retirement|default|disqualif/.test(l) && /advanc/.test(l)) {
      retireClause = retireClause ?? "advancer";
      if (scope === "unknown") scope = "match";
      quotes.push(s); continue;
    }
    // Сетовая клауза: область — СВОЯ единица, а не матч.
    if (/\bset\b/.test(l) && /not completed|is not complete/.test(l) && /50-?50/.test(l)) {
      retireClause = retireClause ?? "unit_scope"; scope = "set"; quotes.push(s); continue;
    }
    // Общая 50-50 — про ОТМЕНУ, не про ретайр. Она НЕ определяет поведение при ретайре.
    if (/50-?50/.test(l) && /cancel|tie|delay|walkover/.test(l)) {
      cancelSplit = true;
      if (scope === "unknown") scope = "match";
      quotes.push(s);
    }
  }
  const onRetire: OnRetire | null = retireClause ?? (cancelSplit ? "split" : null);
  if (onRetire == null) return { onRetire: "unit_scope", scope, quotes, status: "unparsed" };
  return { onRetire, scope, quotes, status: "parsed" };
}

/**
 * СРАВНЕНИЕ С НАШЕЙ ЗАШИТОЙ СЕМЕЙНОЙ ЛОГИКОЙ. `ourMatchScopeVoid` — то, что сегодня считает код
 * (isMatchScopeVoid: семья воидится при незавершении МАТЧА). Текст рынка говорит своё. Расхождение
 * означает, что одно из двух неверно, — и увидеть это можно только сравнив.
 */
export function clauseDisagrees(clause: VoidClause, ourMatchScopeVoid: boolean): { disagrees: boolean; why: string } {
  if (clause.status === "unparsed")
    return { disagrees: false, why: "клауза не разобрана — сравнивать не с чем, и это НЕ согласие" };
  // Текст говорит: при ретайре платим проходящему ⇒ рынок НЕ воидится по незавершению матча.
  const textSaysMatchVoid = clause.onRetire === "split" && clause.scope === "match";
  if (clause.onRetire === "advancer" && ourMatchScopeVoid)
    return { disagrees: true, why: "текст: при ретайре платит ПРОХОДЯЩЕМУ; наш код: семья воидится по незавершению матча — вернули бы ставку там, где биржа платит" };
  if (clause.scope === "set" && ourMatchScopeVoid)
    return { disagrees: true, why: "текст: область — СЕТ (сет завершён ⇒ расчёт нормальный); наш код: воид по незавершению МАТЧА — воидили бы сыгранный сет" };
  if (textSaysMatchVoid && !ourMatchScopeVoid)
    return { disagrees: true, why: "текст: 50-50 при незавершении матча; наш код: семья не считается матч-воидной" };
  return { disagrees: false, why: "текст и код согласны" };
}

/** Короткая подпись клаузы для провенанса в строке расчёта. */
export function clauseSignature(c: VoidClause): string {
  return c.status === "unparsed" ? "клауза НЕ разобрана" : `ретайр→${c.onRetire}, область=${c.scope} (цитат ${c.quotes.length})`;
}
