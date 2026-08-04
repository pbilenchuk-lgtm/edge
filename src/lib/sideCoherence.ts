// ============================================================
// EDGE LAB — N1(а): ДВЕ СТОРОНЫ ОДНОГО КОНТРАКТА НЕ МОГУТ БЫТЬ ОБЕ ВЫГОДНЫ
//
// ИМЕННОЙ КЕЙС: UMF Breiðablik — Aqtöbe FK, 04.08. Стратег выдал ОБА исхода одного тотала — «Under 3.5»
// и «Over 3.5» — КАЖДЫЙ с ai_prob 64%. Сумма 128% при том, что события взаимоисключающи и в сумме дают
// ровно 100%. Обе стороны получили «положительный edge», обе пошли в исполнение: $125 ушло на Over при
// том, что рационале той же ставки дословно говорит «Ставлю Under 3.5 … при моей оценке ~64%». Система
// заняла позицию ПРОТИВ СОБСТВЕННОГО ТЕЗИСА; спас только последующий void.
//
// И это не «просто нелогично» — это арифметически гарантированный минус. Ликвидность у обеих сторон
// совпала до четвёртого знака ($74.6599), то есть это два исхода ОДНОГО рынка: покупка пары стоила
// 46.1¢ + 57.2¢ = 103.3¢ при выплате ровно 100¢. Минус 3.3¢ плюс комиссии, при ЛЮБОМ исходе.
//
// ПОЧЕМУ ЭТОГО НЕ ЛОВИЛ НИКТО. Цикл пиков проверяет `hold`, собственный `rejected` стратега, зомби-
// карантин и кластерную экспозицию — но ни один из них не смотрит на ДРУГИЕ пики того же решения.
// `legConsistency` (Z2а) ловит рассогласование ног при СЕТТЛЕ, а не при входе. Между ними была дыра
// ровно в один вопрос: «а не купили ли мы обе стороны сразу».
//
// ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Есть чистая функция: она НАЗЫВАЕТ конфликт и обе его стороны. Нет
// «умного» выбора победившей стороны — при сумме 128% неизвестно, какая из двух оценок сломана, и
// угадывать значит лечить симптом наугад. Блокируются ОБЕ, громко, в provenance_review: корень
// (как пик со стороны Under получил исполнение в Over) чинится отдельно и по своим уликам.
//
// Комплемент определяется ПРОИЗВОДСТВЕННЫМ `complementKey` — тем же, которым сеттл ищет вторую ногу.
// Своя копия правила инверсии сторон была бы вторым авторитетом на одно решение.
// ============================================================

import { complementKey } from "./complementMarket.js";
import { outcomeKey } from "./zombieMarket.js";

/** Допуск на округления оценок. 2пп — это разумная погрешность модели, 28пп — сломанная сторона. */
export const SIDE_COHERENCE_TOLERANCE = 0.02;

export interface CoherencePick { label: string; prob: number | null }
export interface CoherenceConflict {
  labelA: string; labelB: string; probA: number; probB: number; sum: number; note: string;
}

/**
 * Найти пары взаимоисключающих сторон, чьи вероятности в сумме превышают 100% + допуск.
 * Чистая функция: ничего не пишет и ничего не решает — решение принимает вызывающий.
 */
export function findSideConflicts(picks: CoherencePick[]): CoherenceConflict[] {
  const out: CoherenceConflict[] = [];
  const usable = picks.filter((p) => p.prob != null && p.label);
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i], b = usable[j];
      const want = complementKey(a.label);
      if (!want || want !== outcomeKey(b.label)) continue;      // не комплемент — не наш случай
      const sum = (a.prob as number) + (b.prob as number);
      if (sum <= 1 + SIDE_COHERENCE_TOLERANCE) continue;         // когерентно (или в пределах округлений)
      out.push({
        labelA: a.label, labelB: b.label, probA: a.prob as number, probB: b.prob as number, sum,
        note: `НЕКОГЕРЕНТНЫЕ СТОРОНЫ: «${a.label}» ${Math.round((a.prob as number) * 100)}% + «${b.label}» ${Math.round((b.prob as number) * 100)}%`
          + ` = ${Math.round(sum * 100)}% при максимуме 100% (+${Math.round(SIDE_COHERENCE_TOLERANCE * 100)}пп допуска).`
          + ` Это два исхода ОДНОГО контракта: покупка обеих сторон — гарантированный минус при любом исходе.`
          + ` Какая из оценок сломана — неизвестно, поэтому блокируются ОБЕ (provenance_review), а не выбирается «более вероятная»`,
      });
    }
  }
  return out;
}

/** Метки, которые НЕЛЬЗЯ открывать из-за некогерентности. Обе стороны конфликта, без исключений. */
export function blockedByCoherence(picks: CoherencePick[]): { blocked: Set<string>; conflicts: CoherenceConflict[] } {
  const conflicts = findSideConflicts(picks);
  const blocked = new Set<string>();
  for (const c of conflicts) { blocked.add(c.labelA); blocked.add(c.labelB); }
  return { blocked, conflicts };
}
