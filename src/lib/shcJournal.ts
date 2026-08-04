// ============================================================
// EDGE LAB — ЖУРНАЛ НАБЛЮДЕНИЙ КОНВЕНЦИИ ±1.5: ЕДИНСТВЕННЫЙ ПИШУЩИЙ ПУТЬ
//
// ПРАВИЛО КЛАССА, РАТИФИЦИРОВАННОЕ 04.08 — ОНО ШИРЕ ЭТОГО МОДУЛЯ:
//   ЛЮБОЙ вердикт, читающий из КЭПНУТОГО источника, обязан МАТЕРИАЛИЗОВАТЬ вердикт-релевантные факты
//   В МОМЕНТ СОБЫТИЯ. «Источник живёт короче архива» закрывается КОНСТРУКЦИЕЙ, а не увеличением кэпа.
//
// Чем это заслужено. Вердикт T3 строился запросом по `tennis_snapshots`, а те живут под жёстким
// row-cap (20 000 строк при ~20 записях каждые 20 секунд). Сверка двух прогонов подряд 04.08: из 12
// решённых наблюдений 11 ИСЧЕЗЛИ — не изменили вердикт, а пропали целиком («нет строки вовсе»), пришло
// 5 новых. Среди исчезнувших — единственный различающий случай, на котором держался вывод. Критерий
// «набрать N различающих матчей» на таком источнике недостижим ПО ПОСТРОЕНИЮ: различающие редки
// (1 из 12), а наблюдение живёт часы.
//
// ПОЧЕМУ НЕ ПОДНЯТЬ КЭП. Кэп существует не по прихоти: однажды `tennis_snapshots` раздулись до 1.2 ГБ и
// заморозили загрузку (порт-скан Render не дождался). Поднять кэп — обменять одну поломку на другую и
// всё равно потерять историю старше окна. Материализация стоит одну строку на рынок в день.
//
// ЧТО ЗАМОРАЖИВАЕТСЯ. Всё, что нужно вердикту, ВКЛЮЧАЯ ПРЕДСКАЗАНИЯ ОБЕИХ ГИПОТЕЗ и версию их набора:
// пере-считывать предсказание позже значило бы судить старое наблюдение сегодняшним кодом — ровно тот
// способ, которым «до/после» превращается в самообман. Провенанс назван полями: откуда счёт, откуда
// цена, откуда фаворит, каждый со своим временем.
//
// ЗАПИСЫВАЕТСЯ ТОЛЬКО ТО, ЧТО УЖЕ РАЗРЕШИЛОСЬ И ДОИГРАНО. Неразрешившийся рынок (цена в середине) —
// не наблюдение; недоигранный матч — ±1.5 void (Gate 0.2), судить нечем. Идемпотентно: UNIQUE
// (match_id, label), повтор не плодит строк и не переписывает уже замороженное.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { observeFromSnapshots, SHC_HYPO_VERSION } from "./setHandicapConvention.js";

export interface ShcJournalResult {
  seen: number; written: number; skippedUndecided: number; skippedIncomplete: number;
  total: number; note: string;
}

/**
 * Снять наблюдения, пока снимки живы, и заморозить их в журнал. Возвращает СКОЛЬКО НОВЫХ строк —
 * ноль печатается наравне с двадцатью (стандарт громкого нуля), потому что «ничего не разрешилось»
 * и «шаг не отработал» — разные факты.
 */
export function recordShcObservations(db: Database, nowIso = new Date().toISOString()): ShcJournalResult {
  const live = observeFromSnapshots(db);
  let written = 0, skippedUndecided = 0, skippedIncomplete = 0;
  for (const r of live.rows) {
    // Недоигранный матч выбрасывается ТОЛЬКО из теста: ±1.5 при ретайре void (Gate 0.2). Манилайн же
    // при ретайре разрешается нормально — контроль от этого не худеет, и терять его нет причин.
    if (!r.completed && r.group === "тест") { skippedIncomplete++; continue; }
    if (r.observedFirstWins == null) { skippedUndecided++; continue; } // цена в середине ⇒ исхода нет
    const ok = R.insertShcObservation(db, {
      kind: r.group === "контроль" ? "control" : "test",
      match_id: r.matchId, label: r.label, players: r.players, kickoff_at: r.kickoffAt,
      sets_first: r.setsFirst, sets_second: r.setsSecond, completed: r.completed ? 1 : 0,
      fav_is_label_first: r.favIsLabelFirst ? 1 : 0,
      price_cents: r.lastPriceCents ?? 0,
      observed_first_covers: r.observedFirstWins ? 1 : 0,
      pred_favourite: r.predictedFirstWins ? 1 : 0,
      pred_label_first: r.altPredictedFirstWins ? 1 : 0,
      discriminating: r.discriminating ? 1 : 0,
      hypo_version: SHC_HYPO_VERSION,
      score_src: r.scoreSrc, price_src: r.priceSrc, fav_src: r.favSrc,
      created_at: nowIso,
    });
    if (ok) written++;
  }
  const total = R.shcObservationCount(db);
  return {
    seen: live.rows.length, written, skippedUndecided, skippedIncomplete, total,
    note: `журнал ±1.5: осмотрено ${live.rows.length}, заморожено новых ${written} (в журнале ${total})`
      + ` · пропущено: не разрешилось ${skippedUndecided}, не доиграно ${skippedIncomplete}`,
  };
}
