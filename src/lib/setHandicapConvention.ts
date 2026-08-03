// ============================================================
// EDGE LAB — T3-разблокировка: КОНВЕНЦИЯ ±1.5 ПРОВЕРЯЕТСЯ ДАННЫМИ, А НЕ РАССУЖДЕНИЕМ
//
// ЧТО ЗАБЛОКИРОВАНО И ПОЧЕМУ ЭТО ДОРОГО. `set_handicap` — вторая по глубине семья пропов (466 штук,
// 394 выше книжного гейта, медиана книги $2908). Вся она стоит в `provenance_review`, пока не
// подтверждено эмпирически: сторона гандикапа читается от МАНИЛАЙН-ФАВОРИТА (фаворит несёт −1.5), а не
// от литерала «(-1.5)» в подписи. Флаг TENNIS_SET_HANDICAP_UNBLOCK ждёт именно этой проверки.
//
// САМОЗАПЕЧАТЫВАЮЩИЙСЯ ГЕЙТ. Доказательства нельзя взять из нашей же тени: семья блокируется ДО того,
// как станет сигналом, поэтому в shadow-калибровке у `set_handicap` ровно ноль строк. Блок не даёт
// накопить данные, которые сняли бы блок. Проверка идёт по РАЗРЕШИВШИМСЯ рынкам (цена ушла к 0 или 100)
// против ФАКТИЧЕСКОГО счёта по сетам — торговать для этого не нужно.
//
// ПОЧЕМУ КОНТРОЛЬ — МАНИЛАЙН, А НЕ «ЯВНЫЕ ПОДПИСИ». Первую версию контроля я построил на подписях с
// явным «(-1.5)»: они проверяли бы не гипотезу, а сам метод. ПЕРЕПИСЬ ПОДПИСЕЙ НА ПРОДЕ ЭТО УБИЛА —
// все 81 гандикап-подпись имеют вид «Турнир: A vs B Set Handicap +/-1.5», явных НЕТ НИ ОДНОЙ. Контроль
// был бы пуст по построению, а «контроль не набран» я бы читал как «данных мало», хотя это «такой
// контроль невозможен». Контролем стал МАНИЛАЙН: он проверяет ровно те два звена, на которых держится
// проверка гандикапа, и ни одного лишнего:
//   (1) последняя записанная цена ДЕЙСТВИТЕЛЬНО отражает разрешение (уходит к 0/100), и
//   (2) ориентация подписи (`propFirstIsP1`: кто в подписи первый) читается верно.
// Про сам гандикап манилайн не знает ничего — поэтому он контроль, а не подсказка.
//
// КРИТЕРИИ ЗАФИКСИРОВАНЫ ДО ДАННЫХ (иначе это подгонка):
//   • контроль: ≥8 манилайнов с прочитанным исходом и НОЛЬ расхождений — иначе «МЕТОД НЕВЕРЕН»
//     и никакого вердикта о конвенции;
//   • тест: ≥8 независимых МАТЧЕЙ (не рынков: два пропа одного матча решаются одним счётом — это ОДНО
//     испытание) и НОЛЬ расхождений → конвенция подтверждена, p=0.0039 на 8 матчах при нулевой
//     гипотезе «сторона — монетка»;
//   • хоть одно расхождение теста → ОПРОВЕРГНУТА, блок остаётся;
//   • недобор → «НЕ СОЗРЕЛО»: это отсутствие замера, а не разрешение.
//
// Модуль ТОЛЬКО читает. Флага он не касается: снятие блока — отдельное решение владельца по этим числам.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { parseProp, propFirstIsP1 } from "./tennisPmv.js";
import { tennisMoneyline } from "./tennisScout.js";
import { pWithUnit } from "./signals.js";

/** Пороги — ДО данных. Меняются решением, а не результатом. */
export const SHC_CONTROL_MIN = 8;
export const SHC_TEST_MIN_MATCHES = 8;
/** Цена, ниже/выше которой рынок считается разрешившимся. Между — исхода НЕТ, а не «наверное да». */
export const SHC_RESOLVED_HI = 90;
export const SHC_RESOLVED_LO = 10;

export type ShcOutcome = "совпало" | "РАСХОЖДЕНИЕ" | "нет исхода";
export interface ShcRow {
  matchId: string; players: string; label: string;
  /** Манилайн проверяет ИНСТРУМЕНТ (цена→исход, ориентация); гандикап — саму конвенцию. */
  group: "контроль" | "тест";
  setsFirst: number; setsSecond: number;
  /** Первый в подписи — фаворит по СТАРТОВОЙ цене? (для теста это и есть носитель −1.5 по правилу) */
  favIsLabelFirst: boolean;
  predictedFirstWins: boolean; lastPriceCents: number | null;
  observedFirstWins: boolean | null; outcome: ShcOutcome; note: string;
}
export type ShcVerdict = "МЕТОД НЕВЕРЕН" | "ОПРОВЕРГНУТА" | "ПОДТВЕРЖДЕНА" | "НЕ СОЗРЕЛО";
export interface ShcReport {
  rows: ShcRow[];
  controlChecked: number; controlMismatch: number;
  testMatches: number; testChecked: number; testMismatch: number;
  /** Перепись подписей — цена блока в штуках и проверка, что «явные» вообще существуют. */
  ambiguousProps: number; explicitProps: number;
  verdict: ShcVerdict; note: string;
}

/** Разрешился ли рынок и в какую сторону. Середина — ЧЕСТНОЕ «нет исхода», а не округление к ближнему. */
function resolvedFirstWins(price: number | null): boolean | null {
  if (price == null) return null;
  if (price >= SHC_RESOLVED_HI) return true;
  if (price <= SHC_RESOLVED_LO) return false;
  return null;
}

export function buildSetHandicapConvention(db: Database): ShcReport {
  const rows: ShcRow[] = [];
  let ambiguousProps = 0, explicitProps = 0;

  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    for (const m of R.listMatches(db, c.id)) {
      if (m.state !== "finished") continue;
      // Финальный счёт по сетам — у скаута, того же источника, что и вся теннисная ветка.
      const last = db.prepare(
        `SELECT p1,p2,sets_p1,sets_p2 FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`,
      ).get(m.id) as { p1: string | null; p2: string | null; sets_p1: number | null; sets_p2: number | null } | undefined;
      if (!last || last.sets_p1 == null || last.sets_p2 == null || last.sets_p1 === last.sets_p2) continue;
      const players = { p1: last.p1 ?? "", p2: last.p2 ?? "" };
      // ФАВОРИТ — по ПЕРВОЙ проценённой записи скаута. Текущая цена после матча уже равна исходу и
      // сделала бы правило тавтологией: оно предсказывало бы то, из чего построено.
      const start = db.prepare(
        `SELECT pm_p1_cents FROM tennis_snapshots WHERE pm_match_id=? AND pm_p1_cents IS NOT NULL ORDER BY batch_at ASC LIMIT 1`,
      ).get(m.id) as { pm_p1_cents: number | null } | undefined;
      if (start?.pm_p1_cents == null) continue;
      const favIsScoutP1 = start.pm_p1_cents >= 50;

      // ── КОНТРОЛЬ: манилайн. Кто выиграл матч — известно из счёта; ориентация — из подписи.
      const ml = tennisMoneyline(db, m.id, players);
      if (ml) {
        const mlMarket = R.latestMarkets(db, m.id).find((x) => x.label === ml.label);
        const price = mlMarket?.price == null ? null : Number(mlMarket.price);
        const firstSets = ml.firstIsP1 ? last.sets_p1 : last.sets_p2;
        const secondSets = ml.firstIsP1 ? last.sets_p2 : last.sets_p1;
        const predicted = firstSets > secondSets;
        const observed = resolvedFirstWins(price);
        rows.push({
          matchId: m.id, players: `${m.home} — ${m.away}`, label: ml.label, group: "контроль",
          setsFirst: firstSets, setsSecond: secondSets, favIsLabelFirst: ml.firstIsP1 === favIsScoutP1,
          predictedFirstWins: predicted, lastPriceCents: price, observedFirstWins: observed,
          outcome: observed == null ? "нет исхода" : observed === predicted ? "совпало" : "РАСХОЖДЕНИЕ",
          note: observed == null
            ? `цена ${price ?? "—"}¢ между ${SHC_RESOLVED_LO} и ${SHC_RESOLVED_HI} — исход не прочитан`
            : `счёт первого в подписи ${firstSets}:${secondSets} ⇒ ждём ${predicted ? "победу" : "поражение"}; цена ${price}¢ ⇒ ${observed ? "победил" : "проиграл"}`,
        });
      }

      // ── ТЕСТ: гандикапы. Правило: −1.5 несёт МАНИЛАЙН-ФАВОРИТ.
      for (const mk of R.latestMarkets(db, m.id)) {
        const parsed = parseProp(mk.label);
        if (!parsed || parsed.family !== "set_handicap") continue;
        const explicit = /\(\s*[-−]\s*1\.5\s*\)/.test(mk.label);
        if (explicit) explicitProps++; else ambiguousProps++;
        const first = propFirstIsP1(mk.label, players);
        if (first == null) continue;                                    // стороны не сопоставлены — не судим
        const favIsLabelFirst = first === favIsScoutP1;
        // Явная подпись читает сторону из ЛИТЕРАЛА (её проверять нечем и незачем), неоднозначная — из правила.
        const minusOnFirst = explicit ? parsed.handicapOnFirst : favIsLabelFirst;
        const firstSets = first === true ? last.sets_p1 : last.sets_p2;
        const secondSets = first === true ? last.sets_p2 : last.sets_p1;
        // −1.5 покрыт, если его носитель выиграл с разницей ≥2 сетов; +1.5 покрыт, если соперник НЕ смог.
        const predicted = minusOnFirst ? firstSets - secondSets >= 2 : !(secondSets - firstSets >= 2);
        const price = mk.price == null ? null : Number(mk.price);
        const observed = resolvedFirstWins(price);
        rows.push({
          matchId: m.id, players: `${m.home} — ${m.away}`, label: mk.label, group: "тест",
          setsFirst: firstSets, setsSecond: secondSets, favIsLabelFirst,
          predictedFirstWins: predicted, lastPriceCents: price, observedFirstWins: observed,
          outcome: observed == null ? "нет исхода" : observed === predicted ? "совпало" : "РАСХОЖДЕНИЕ",
          note: observed == null
            ? `цена ${price ?? "—"}¢ между ${SHC_RESOLVED_LO} и ${SHC_RESOLVED_HI} — исход НЕ прочитан (не судим, а не «наверное да»)`
            : `счёт ${firstSets}:${secondSets}, −1.5 у ${minusOnFirst ? "первого" : "второго"} в подписи (первый ${favIsLabelFirst ? "И ЕСТЬ" : "НЕ"} фаворит) ⇒ ждём ${predicted ? "покрытие" : "непокрытие"}; цена ${price}¢ ⇒ ${observed ? "покрыл" : "не покрыл"}`,
        });
      }
    }
  }

  const decided = (g: ShcRow["group"]) => rows.filter((r) => r.group === g && r.outcome !== "нет исхода");
  const control = decided("контроль"), test = decided("тест");
  const controlMismatch = control.filter((r) => r.outcome === "РАСХОЖДЕНИЕ").length;
  const testMismatch = test.filter((r) => r.outcome === "РАСХОЖДЕНИЕ").length;
  // ЕДИНИЦА — МАТЧ, А НЕ РЫНОК: два гандикап-пропа одного матча решаются одним счётом.
  const testMatches = new Set(test.map((r) => r.matchId)).size;

  let verdict: ShcVerdict, note: string;
  if (control.length < SHC_CONTROL_MIN) {
    verdict = "НЕ СОЗРЕЛО";
    note = `контроль не набран: манилайнов с прочитанным исходом ${control.length} при нужных ${SHC_CONTROL_MIN} — инструмент не проверен, значит и гипотезу проверять НЕЧЕМ`;
  } else if (controlMismatch > 0) {
    verdict = "МЕТОД НЕВЕРЕН";
    note = `контроль РАЗОШЁЛСЯ: ${controlMismatch} из ${control.length} манилайнов противоречат собственному счёту. Сломано одно из двух звеньев самой проверки — цена→исход или ориентация подписи. Вердикта о конвенции НЕТ, блок остаётся`;
  } else if (testMismatch > 0) {
    verdict = "ОПРОВЕРГНУТА";
    note = `конвенция ОПРОВЕРГНУТА: ${testMismatch} расхождений на ${testMatches} матчах при чистом контроле (${control.length}/${control.length}). Правило «фаворит несёт −1.5» неверно — блок остаётся, флаг НЕ поднимается`;
  } else if (testMatches < SHC_TEST_MIN_MATCHES) {
    verdict = "НЕ СОЗРЕЛО";
    note = `контроль чист (${control.length}/${control.length}), расхождений нет, но матчей теста ${testMatches} при нужных ${SHC_TEST_MIN_MATCHES} — это ОТСУТСТВИЕ ЗАМЕРА, а не разрешение`;
  } else {
    verdict = "ПОДТВЕРЖДЕНА";
    note = `контроль чист (${control.length}/${control.length}), тест чист: ${test.length} рынков на ${testMatches} матчах, ноль расхождений — ${pWithUnit(Math.pow(0.5, testMatches), testMatches, "матчах")} при нулевой «сторона — монетка». Основание для снятия блока есть; флаг поднимает ВЛАДЕЛЕЦ, не отчёт`;
  }

  return {
    rows, controlChecked: control.length, controlMismatch,
    testMatches, testChecked: test.length, testMismatch,
    ambiguousProps, explicitProps, verdict, note,
  };
}

/** Строка для еженедельника: цена блока в штуках и текущий вердикт проверки. */
export function setHandicapConventionLine(r: ShcReport): string {
  return `set_handicap: подписей неоднозначных ${r.ambiguousProps} / явных ${r.explicitProps}`
    + ` · контроль ${r.controlChecked - r.controlMismatch}/${r.controlChecked}`
    + ` · тест ${r.testChecked - r.testMismatch}/${r.testChecked} на ${r.testMatches} матчах`
    + ` · ${r.verdict}`;
}
