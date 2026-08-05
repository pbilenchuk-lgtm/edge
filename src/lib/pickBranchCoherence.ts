// ============================================================
// EDGE LAB — N1(б): КОРЕНЬ SIDE-MAPPING. ПИК ПРОТИВ СОБСТВЕННОГО СПИСКА ВЕТОК
//
// ЧТО ОКАЗАЛОСЬ КОРНЕМ (разбор лога UMF Breiðablik — Aqtöbe FK, 04.08, стадия post_lineup).
// Гипотеза «код перепутал сторону» НЕ подтвердилась. Пик пришёл от стратега таким:
//     { "label": "Over 3.5", "marketId": "m10", "prob": 0.64,
//       "reason": "Ставлю Under 3.5 (m11) …",
//       "livesInBranches": ["fav_clean","draw_0_0","dog_clean","draw_scoring[1:1]",
//                           "часть fav_concedes[2:1]","часть dog_concedes[1:2]"],
//       "branchWeightSum": 0.62 }
// `label` и `marketId` СОГЛАСОВАНЫ между собой — оба указывают на Over 3.5 (движок и напечатал в
// рационале «Over 3.5»). Привязка по id (P4) отработала верно: она отвечает на вопрос «КАКОЙ рынок»,
// и ответила правильно. Сломана СТОРОНА: модель выдала дубль-пик на комплемент, скопировав в него
// рационале от Under, и никто ниже по коду не спросил, о том ли рынке этот пик.
//
// ПОЧЕМУ ИНВАРИАНТА N1(а) НЕДОСТАТОЧНО. Он парный: срабатывает, только когда в одном решении лежат ОБЕ
// стороны и сумма их вероятностей > 100%. Если стратег выдаст ОДИН пик — «Over 3.5» с рационале про
// Under — сумма считаться не с чем, конфликта нет, деньги уходят на противоположную сторону молча. Это
// не редкий вариант, а более вероятный: дубль-пик мы увидели именно потому, что он шумный.
//
// ЧТО ЧИТАЕТСЯ ВМЕСТО ПРОЗЫ. Разбирать `reason` регулярками нельзя — это гадание по тексту. Но пик несёт
// СОБСТВЕННОЕ МАШИННОЕ УТВЕРЖДЕНИЕ о том, на каких исходах он выигрывает: `livesInBranches`. Оно уже
// собиралось (analysis.ts кладёт его в battle-sheet и в entry_meta) — и никогда не проверялось. Класс
// знакомый: второй авторитет на то же решение, который просто никто не спрашивал.
//
// ДОПУСТИМЫЕ УЛИКИ — ТОЛЬКО ТЕ, ЧТО СЛЕДУЮТ ИЗ ОПРЕДЕЛЕНИЯ ВЕТКИ, И НИКОГДА `score_cluster`:
//   • явный счёт в скобках — «draw_scoring[1:1]» — это утверждение самой модели, тотал известен точно;
//   • структурный минимум ветки (BRANCH_TOTAL_BOUNDS в poisson.ts): fav_concedes ≥ 3 гола и т.д.;
//   • draw_0_0 — ровно 0 голов;
//   • для BTTS — ветка однородна по BTTS по построению, поэтому улика точная для всех шести.
// Минимум умеет доказывать только «ветка ТОЧНО выше линии»: верхней границы нет (5:0 — это fav_clean).
// Поэтому отсутствие улик НИКОГДА не обвиняет; обвиняет только ЕДИНОГЛАСИЕ допустимых улик против.
//
// ПРАВИЛО БЛОКИРОВКИ (fail-closed, но с асимметричной гарантией):
//     ≥2 разрешимых веток И ни одна не за названную сторону И хотя бы одна против → contradicts.
// Одна ветка не обвиняет (слишком тонко для парсинга), смешанная картина не обвиняет (законный пик живёт
// в части веток), нераспознанное не обвиняет. На Breiðablik разрешились четыре — draw_0_0 (0 голов),
// draw_scoring[1:1] (2), fav_concedes[2:1] (3), dog_concedes[1:2] (3) — все ниже 3.5 при названном Over.
//
// ГРАНИЦА ПОКРЫТИЯ НАЗВАНА ЧЕСТНО. Разбираются семьи, где сторона выводится из ветки БЕЗ знания имён
// команд: тоталы матча и BTTS. Для 1X2/фор нужна привязка «фаворит = home/away» к подписи, и её здесь
// нет — такие пики возвращают `unknown` и не блокируются. На деньги это ограничение не влияет: семейный
// гейт (analysis.ts) пускает деньги prematch_value ТОЛЬКО в тоталы, остальное демоутится в shadow.
// ============================================================

import { BRANCH_BTTS, BRANCH_TOTAL_BOUNDS, SCENARIO_IDS } from "./poisson.js";

/** Минимум разрешимых веток, ниже которого единогласие не считается уликой. */
export const BRANCH_MIN_RESOLVED = 2;

export type BranchVerdict = "ok" | "contradicts" | "unknown";
export interface BranchEvidence { branch: string; side: string; via: "явный счёт" | "минимум ветки" | "btts ветки" }
export interface BranchCheck {
  verdict: BranchVerdict;
  family: "total" | "btts" | null;
  namedSide: string | null;
  agree: BranchEvidence[];
  against: BranchEvidence[];
  resolved: number;
  note: string;
}

/** Сторона, названная ПОДПИСЬЮ рынка. null — семья вне покрытия (см. границу в шапке). */
export function namedSideOf(label: string): { family: "total"; side: "over" | "under"; line: number } | { family: "btts"; side: "yes" | "no" } | null {
  const s = ` ${String(label).toLowerCase().replace(/\s+/g, " ").trim()} `;
  // Границы слов задаём через \p{L} с флагом u, а НЕ через \b: \b определён на [A-Za-z0-9_], поэтому
  // между пробелом и кириллической буквой границы нет вовсе — «Больше 2.5» молча не распознавалось бы.
  const word = (w: string) => new RegExp(`(?<![\\p{L}\\d])${w}(?![\\p{L}\\d])`, "u").test(s);
  if (/both teams to score|обе забьют/u.test(s) || word("btts")) {
    if (word("no") || word("нет")) return { family: "btts", side: "no" };
    if (word("yes") || word("да")) return { family: "btts", side: "yes" };
    return null;                                        // BTTS без стороны — сторона не названа
  }
  // Тотал МАТЧА. Командные и таймовые тоталы («Home Over 1.5», «1st Half Over 0.5») дерево исходов не
  // описывает — оно про финальный счёт целиком, поэтому такие подписи в покрытие не берутся.
  if (["half", "тайм", "home", "away", "team"].some(word)) return null;
  const m = s.match(/(?<![\p{L}\d])(over|under|больше|меньше|тб|тм)(?![\p{L}\d])[^0-9]{0,12}(\d+(?:\.\d+)?)/u);
  if (!m) return null;
  const side = /over|больше|тб/u.test(m[1]) ? "over" : "under";
  return { family: "total", side, line: Number(m[2]) };
}

/** id ветки, названной в свободной строке пика («часть fav_concedes[2:1]» → fav_concedes). */
function branchIdIn(claim: string): (typeof SCENARIO_IDS)[number] | null {
  const s = claim.toLowerCase();
  for (const id of SCENARIO_IDS) if (s.includes(id)) return id;
  return null;
}

/** Явные счета в скобках: «draw_scoring[1:1,2:2]» → [2, 4]. Пусто — улик по счёту нет. */
function bracketTotals(claim: string): number[] {
  const out: number[] = [];
  for (const m of claim.matchAll(/(\d+)\s*[:-]\s*(\d+)/g)) out.push(Number(m[1]) + Number(m[2]));
  return out;
}

/**
 * Сверить пик с его же списком веток. Чистая функция: ничего не читает из БД и ничего не решает —
 * решение принимает вызывающий (и он же обязан не блокировать на `unknown`).
 */
export function checkPickBranches(label: string, livesInBranches: string[] | null | undefined): BranchCheck {
  const named = namedSideOf(label);
  const claims = (livesInBranches ?? []).filter((x) => typeof x === "string" && x.trim());
  const empty: BranchCheck = { verdict: "unknown", family: named?.family ?? null, namedSide: named?.side ?? null, agree: [], against: [], resolved: 0, note: "" };
  if (!named) return { ...empty, note: "сторона не выводится из подписи — семья вне покрытия проверки" };
  if (!claims.length) return { ...empty, note: "стратег не назвал веток — улик нет, обвинения нет" };

  const agree: BranchEvidence[] = [], against: BranchEvidence[] = [];
  for (const claim of claims) {
    const id = branchIdIn(claim);
    if (!id) continue;                                   // не наша нотация — молчим, а не обвиняем
    let side: string | null = null;
    let via: BranchEvidence["via"] = "минимум ветки";
    if (named.family === "btts") {
      side = BRANCH_BTTS[id]; via = "btts ветки";
    } else {
      const b = BRANCH_TOTAL_BOUNDS[id];
      const totals = bracketTotals(claim);
      if (totals.length) {
        // Явные счета: сторона определена, только если ВСЕ они по одну сторону линии.
        const over = totals.every((t) => t > named.line), under = totals.every((t) => t < named.line);
        side = over ? "over" : under ? "under" : null; via = "явный счёт";
      } else if (b.exact != null) {
        side = b.exact > named.line ? "over" : "under"; via = "явный счёт";
      } else if (b.min > named.line) {
        side = "over"; via = "минимум ветки";            // верхней границы нет — «under» так доказать нельзя
      }
    }
    if (!side) continue;
    (side === named.side ? agree : against).push({ branch: id, side, via });
  }

  const resolved = agree.length + against.length;
  if (resolved < BRANCH_MIN_RESOLVED) {
    return { ...empty, agree, against, resolved, note: `разрешилось веток: ${resolved} (< ${BRANCH_MIN_RESOLVED}) — улик мало, обвинения нет` };
  }
  if (against.length && !agree.length) {
    return {
      verdict: "contradicts", family: named.family, namedSide: named.side, agree, against, resolved,
      note: `пик назвал «${named.side}», но ВСЕ ${against.length} разрешимых веток его же списка играют против:`
        + ` ${against.map((e) => `${e.branch}→${e.side} (${e.via})`).join(", ")}`,
    };
  }
  return {
    verdict: "ok", family: named.family, namedSide: named.side, agree, against, resolved,
    note: `за сторону ${agree.length} веток, против ${against.length} — самоопровержения нет`,
  };
}

/** Строка для provenance_review: факт, сторона, ветки — без интерпретаций. */
export function branchContradictionNote(label: string, c: BranchCheck): string {
  return `ПИК ПРОТИВ СВОИХ ЖЕ ВЕТОК: «${label}» — ${c.note}.`
    + ` Список веток — машинное утверждение самого стратега о том, где ставка выигрывает;`
    + ` он единогласно описывает ПРОТИВОПОЛОЖНУЮ сторону. Какая половина пика сломана — неизвестно,`
    + ` поэтому вход блокируется, а не «исправляется» на комплемент (угадывание стороны — это и есть корень)`;
}
