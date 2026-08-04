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
// РЕЗУЛЬТАТ ПЕРВОГО СОЗРЕВШЕГО ЗАМЕРА (03.08): гипотеза «фаворит несёт −1.5» ОПРОВЕРГНУТА — 1 расхождение
// на 12 матчах при чистом контроле 27/27. Различающий случай ровно один и он показателен: Parry — Day,
// счёт первого в подписи 1:2, первый НЕ фаворит. Правило ждало покрытия (+1.5 держится при разнице в
// один сет), рынок закрылся на 4.1¢. Все прочие одиннадцать матчей обе гипотезы предсказывают одинаково.
//
// ЧТО ДАННЫЕ ГОВОРЯТ ВМЕСТО. Альтернатива «−1.5 ВСЕГДА у первого в подписи (outcomes[0])» согласована со
// всеми одиннадцатью завершёнными матчами. Но она РОЖДЕНА ЭТИМИ ЖЕ ДАННЫМИ, и подтверждать её на них —
// подгонка в чистом виде. Поэтому она считается параллельно, с собственной пре-регистрацией: засчитываются
// только РАЗЛИЧАЮЩИЕ матчи (те, где две гипотезы предсказывают РАЗНОЕ: первый в подписи не фаворит И
// разница в сетах ровно один) и только сыгранные ПОСЛЕ даты фиксации. Ретроспективный счёт печатается
// отдельно и явно помечен как «на данных, породивших гипотезу».
//
// НЕЗАВЕРШЁННЫЕ МАТЧИ ИСКЛЮЧЕНЫ, И ЭТО НЕ ПОДГОНКА ПОД РЕЗУЛЬТАТ. Проект уже знает (Gate 0.2, tennisPmv):
// «Set Handicap VOID on any mid-match retire». Матч, где никто не набрал победных сетов, судить конвенцию
// не может — контракт там void. Я это знание при построении выборки упустил, и в неё попал Mackenzie —
// Rodionov со счётом 1:0. Правило исключения независимо от гипотез и применяется ко всем строкам сразу.
//
// Модуль ТОЛЬКО читает. Флага он не касается: снятие блока — отдельное решение владельца по этим числам.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { parseProp, propFirstIsP1 } from "./tennisPmv.js";
import { tennisMoneyline } from "./tennisScout.js";
import { isBestOfFive } from "./tennisSetValue.js";
import { pWithUnit } from "./signals.js";

/**
 * ПРЕЖНИЙ ВЕРДИКТ ДАУНГРЕЙЖЕН ДО `unverified` — ратифицировано 04.08. «ОПРОВЕРГНУТА» было снято на 12
 * матчах, из которых 11 исчезли из источника за часы: вывод верен по критерию, но НЕВОСПРОИЗВОДИМ, а
 * невоспроизводимый вывод не имеет права держать решение о деньгах ни в какую сторону. T3 остаётся
 * fail-closed до подтверждения ПО ЖУРНАЛУ. История не стирается — она помечена.
 */
export const PRIOR_VERDICT = {
  verdict: "ОПРОВЕРГНУТА" as ShcVerdict, status: "unverified" as const,
  why: "снят 03-04.08 на выборке из кэпнутых снимков: 11 из 12 наблюдений исчезли за часы (сверка двух прогонов). Вывод по критерию верен, но невоспроизводим — T3 остаётся fail-closed до журнального подтверждения",
};

/** Версия набора гипотез. Строка журнала судится ТОЙ версией, при которой записана: пере-считывать
 *  предсказания сегодняшним кодом значило бы судить старое наблюдение новым правилом. */
export const SHC_HYPO_VERSION = "shc-h1";

/** Пороги — ДО данных. Меняются решением, а не результатом. */
export const SHC_CONTROL_MIN = 8;
export const SHC_TEST_MIN_MATCHES = 8;
/** Альтернатива подтверждается только на РАЗЛИЧАЮЩИХ матчах — тех, где гипотезы спорят. */
export const SHC_ALT_MIN_DISCRIMINATING = 5;
/** Дата фиксации альтернативы. Матчи ДО неё её породили и подтверждать её не могут. */
export const SHC_ALT_REGISTERED_AT = "2026-08-03";
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
  /** Есть ли у рынка токен (external_ref): без него цену переопрашивать НЕЧЕМ. */
  hasToken: boolean;
  /** Насколько цена СТАРШЕ последнего снимка скаута. Замороженная задолго до конца цена не может
   *  дойти до резолюции — и «нет исхода» тогда означает не «рынок не решился», а «мы не смотрели». */
  priceLagMin: number | null;
  /** Матч сыгран до конца (кто-то набрал победные сеты)? Ретайр ⇒ ±1.5 void ⇒ судить нельзя. */
  completed: boolean;
  /** Предсказание АЛЬТЕРНАТИВЫ («−1.5 всегда у первого») и её исход. */
  altPredictedFirstWins: boolean; altOutcome: ShcOutcome;
  /** Гипотезы предсказывают РАЗНОЕ — только такие матчи что-то доказывают об их различии. */
  discriminating: boolean;
  observedFirstWins: boolean | null; outcome: ShcOutcome; note: string;
  /** ПРОВЕНАНС: у каждого факта свой источник и своё время — строка журнала объясняет саму себя. */
  scoreSrc: string; priceSrc: string; favSrc: string; kickoffAt: string | null;
}
export type ShcVerdict = "МЕТОД НЕВЕРЕН" | "ОПРОВЕРГНУТА" | "ПОДТВЕРЖДЕНА" | "НЕ СОЗРЕЛО";
export interface ShcReport {
  rows: ShcRow[];
  controlChecked: number; controlMismatch: number;
  testMatches: number; testChecked: number; testMismatch: number;
  /** Перепись подписей — цена блока в штуках и проверка, что «явные» вообще существуют. */
  ambiguousProps: number; explicitProps: number;
  /** ПОЧЕМУ тест не набирается: из нерешённых гандикапов — сколько без токена и сколько с ценой,
   *  замороженной ДО конца матча. Без этих двух чисел «НЕ СОЗРЕЛО» неотличимо от «не дозреет никогда». */
  undecidedNoToken: number; undecidedStalePrice: number; undecidedMedianLagMin: number | null;
  /** Незавершённые (ретайр) исключены из суждения — ±1.5 там void. Число печатается, а не прячется. */
  droppedIncomplete: number;
  /** Сколько наблюдений в ЖУРНАЛЕ — знаменатель вердикта, живущий дольше снимков. */
  journalRows: number;
  /** ПРЕЖНИЙ вердикт, снятый на испарившейся выборке: история не стирается, но помечена. */
  prior: { verdict: ShcVerdict; status: "unverified"; why: string };
  /** АЛЬТЕРНАТИВА, порождённая данными: считается только на РАЗЛИЧАЮЩИХ матчах ПОСЛЕ фиксации. */
  alt: {
    registeredAt: string; minDiscriminating: number;
    discriminatingSince: number; mismatchSince: number;
    /** Ретроспектива — явно помечена: эти матчи гипотезу ПОРОДИЛИ и подтвердить её не могут. */
    discriminatingRetro: number; mismatchRetro: number;
    verdict: ShcVerdict; note: string;
  };
  verdict: ShcVerdict; note: string;
}

/** Насколько цена рынка старше последнего, что мы знаем о матче. Отрицательных не бывает — только 0. */
function priceLag(snapshotAt: string | null | undefined, lastSeenMs: number): number | null {
  const t = Date.parse(snapshotAt ?? "");
  if (!Number.isFinite(t) || !lastSeenMs) return null;
  return Math.max(0, Math.round((lastSeenMs - t) / 60_000));
}

/** Разрешился ли рынок и в какую сторону. Середина — ЧЕСТНОЕ «нет исхода», а не округление к ближнему. */
function resolvedFirstWins(price: number | null): boolean | null {
  if (price == null) return null;
  if (price >= SHC_RESOLVED_HI) return true;
  if (price <= SHC_RESOLVED_LO) return false;
  return null;
}

/**
 * НАБЛЮДЕНИЕ ИЗ СНИМКОВ — то, что нужно СНЯТЬ, пока снимки ещё живы. Единственный авторитет на
 * построение наблюдения: и журнал, и вердикт зовут его, а не собирают строку по второму разу.
 */
export function observeFromSnapshots(db: Database): {
  rows: ShcRow[]; ambiguousProps: number; explicitProps: number; droppedIncomplete: number;
} {
  const rows: ShcRow[] = [];
  let ambiguousProps = 0, explicitProps = 0, droppedIncomplete = 0;
  const matchDay = new Map<string, string>();      // матч → день старта: им отделяются НОВЫЕ наблюдения

  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    for (const m of R.listMatches(db, c.id)) {
      if (m.state !== "finished") continue;
      // Финальный счёт по сетам — у скаута, того же источника, что и вся теннисная ветка.
      const last = db.prepare(
        `SELECT p1,p2,sets_p1,sets_p2,event_type,tournament FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`,
      ).get(m.id) as { p1: string | null; p2: string | null; sets_p1: number | null; sets_p2: number | null; event_type: string | null; tournament: string | null } | undefined;
      if (!last || last.sets_p1 == null || last.sets_p2 == null || last.sets_p1 === last.sets_p2) continue;
      const lastAt = (db.prepare(`SELECT MAX(batch_at) b FROM tennis_snapshots WHERE pm_match_id=?`).get(m.id) as { b: string | null }).b ?? "";
      const lastSeenMs = Date.parse(lastAt) || 0;
      // ЗАВЕРШЁН ЛИ МАТЧ. Ретайр ⇒ ±1.5 VOID (Gate 0.2, уже ратифицировано в tennisPmv) ⇒ этот матч о
      // конвенции не говорит НИЧЕГО. Правило не зависит ни от одной из гипотез и применяется ко всем сразу.
      const needSets = isBestOfFive(last.event_type, last.tournament) ? 3 : 2;
      const completed = Math.max(last.sets_p1, last.sets_p2) >= needSets;
      matchDay.set(m.id, (m.kickoff_at ?? "").slice(0, 10));
      const players = { p1: last.p1 ?? "", p2: last.p2 ?? "" };
      // ФАВОРИТ — по ПЕРВОЙ проценённой записи скаута. Текущая цена после матча уже равна исходу и
      // сделала бы правило тавтологией: оно предсказывало бы то, из чего построено.
      const start = db.prepare(
        `SELECT pm_p1_cents, batch_at FROM tennis_snapshots WHERE pm_match_id=? AND pm_p1_cents IS NOT NULL ORDER BY batch_at ASC LIMIT 1`,
      ).get(m.id) as { pm_p1_cents: number | null; batch_at: string } | undefined;
      if (start?.pm_p1_cents == null) continue;
      const favIsScoutP1 = start.pm_p1_cents >= 50;
      const favSrc = `first_priced_snapshot@${start.batch_at}`;

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
          predictedFirstWins: predicted, lastPriceCents: price,
          hasToken: !!mlMarket?.external_ref, priceLagMin: priceLag(mlMarket?.snapshot_at, lastSeenMs),
          scoreSrc: `scout_snapshot@${lastAt}`, priceSrc: `markets@${mlMarket?.snapshot_at ?? "—"}`, favSrc, kickoffAt: m.kickoff_at ?? null,
          completed, altPredictedFirstWins: predicted, altOutcome: observed == null ? "нет исхода" : observed === predicted ? "совпало" : "РАСХОЖДЕНИЕ",
          discriminating: false,
          observedFirstWins: observed,
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
        // Недоигранный матч НЕ выбрасывается здесь: наблюдение строится и НЕСЁТ `completed: false`, а
        // решение «не судить» принимает потребитель. Иначе счётчик выброшенных жил бы в двух местах —
        // и тот, что в журнале, всегда показывал бы ноль, потому что строки до него не доходили.
        if (!completed) droppedIncomplete++;                              // ретайр ⇒ ±1.5 void ⇒ судить нечем
        const favIsLabelFirst = first === favIsScoutP1;
        // Явная подпись читает сторону из ЛИТЕРАЛА (её проверять нечем и незачем), неоднозначная — из правила.
        const minusOnFirst = explicit ? parsed.handicapOnFirst : favIsLabelFirst;
        const firstSets = first === true ? last.sets_p1 : last.sets_p2;
        const secondSets = first === true ? last.sets_p2 : last.sets_p1;
        // −1.5 покрыт, если его носитель выиграл с разницей ≥2 сетов; +1.5 покрыт, если соперник НЕ смог.
        const covers = (minusFirst: boolean) => (minusFirst ? firstSets - secondSets >= 2 : !(secondSets - firstSets >= 2));
        const predicted = covers(minusOnFirst);
        // АЛЬТЕРНАТИВА: −1.5 всегда у первого в подписи (outcomes[0]), независимо от того, кто фаворит.
        const altPredicted = covers(true);
        const price = mk.price == null ? null : Number(mk.price);
        const observed = resolvedFirstWins(price);
        const altOutcome: ShcOutcome = observed == null ? "нет исхода" : observed === altPredicted ? "совпало" : "РАСХОЖДЕНИЕ";
        rows.push({
          matchId: m.id, players: `${m.home} — ${m.away}`, label: mk.label, group: "тест",
          setsFirst: firstSets, setsSecond: secondSets, favIsLabelFirst,
          predictedFirstWins: predicted, lastPriceCents: price,
          hasToken: !!mk.external_ref, priceLagMin: priceLag(mk.snapshot_at, lastSeenMs),
          scoreSrc: `scout_snapshot@${lastAt}`, priceSrc: `markets@${mk.snapshot_at ?? "—"}`, favSrc, kickoffAt: m.kickoff_at ?? null,
          completed, altPredictedFirstWins: altPredicted, altOutcome,
          discriminating: predicted !== altPredicted,
          observedFirstWins: observed,
          outcome: observed == null ? "нет исхода" : observed === predicted ? "совпало" : "РАСХОЖДЕНИЕ",
          note: observed == null
            ? `цена ${price ?? "—"}¢ между ${SHC_RESOLVED_LO} и ${SHC_RESOLVED_HI} — исход НЕ прочитан (не судим, а не «наверное да»)`
            : `счёт ${firstSets}:${secondSets}, −1.5 у ${minusOnFirst ? "первого" : "второго"} в подписи (первый ${favIsLabelFirst ? "И ЕСТЬ" : "НЕ"} фаворит) ⇒ ждём ${predicted ? "покрытие" : "непокрытие"}; цена ${price}¢ ⇒ ${observed ? "покрыл" : "не покрыл"}`,
        });
      }
    }
  }

  return { rows, ambiguousProps, explicitProps, droppedIncomplete };
}

/** Строка ЖУРНАЛА → строка вердикта. Предсказания НЕ пересчитываются: они заморожены при записи. */
function journalRows(db: Database): ShcRow[] {
  const mk = (o: R.ShcObservationRow): ShcRow => {
    const obs = !!o.observed_first_covers;
    const outcome: ShcOutcome = obs === !!o.pred_favourite ? "совпало" : "РАСХОЖДЕНИЕ";
    const altOutcome: ShcOutcome = obs === !!o.pred_label_first ? "совпало" : "РАСХОЖДЕНИЕ";
    return {
      matchId: o.match_id, players: o.players ?? "", label: o.label,
      group: o.kind === "control" ? "контроль" : "тест",
      setsFirst: o.sets_first, setsSecond: o.sets_second, favIsLabelFirst: !!o.fav_is_label_first,
      predictedFirstWins: !!o.pred_favourite, lastPriceCents: o.price_cents,
      hasToken: true, priceLagMin: null, completed: !!o.completed,
      altPredictedFirstWins: !!o.pred_label_first, altOutcome, discriminating: !!o.discriminating,
      observedFirstWins: obs, outcome,
      note: `журнал ${o.hypo_version}: счёт ${o.sets_first}:${o.sets_second}, цена ${o.price_cents}¢ · ${o.score_src} · ${o.price_src} · ${o.fav_src}`,
      scoreSrc: o.score_src, priceSrc: o.price_src, favSrc: o.fav_src, kickoffAt: o.kickoff_at,
    };
  };
  return R.shcObservations(db).map(mk);
}

/**
 * ВЕРДИКТ СТРОИТСЯ ИЗ ЖУРНАЛА, а не из снимков. Снимки нужны только для ТЕКУЩЕЙ диагностики — переписи
 * подписей и ответа «почему тест не набирается»; они кэпнуты и историю не хранят.
 */
export function buildSetHandicapConvention(db: Database): ShcReport {
  const live = observeFromSnapshots(db);
  const rows = journalRows(db);
  const { ambiguousProps, explicitProps, droppedIncomplete } = live;

  const decided = (g: ShcRow["group"]) => rows.filter((r) => r.group === g && r.outcome !== "нет исхода");
  const control = decided("контроль"), test = decided("тест");
  const controlMismatch = control.filter((r) => r.outcome === "РАСХОЖДЕНИЕ").length;
  const testMismatch = test.filter((r) => r.outcome === "РАСХОЖДЕНИЕ").length;
  // ЕДИНИЦА — МАТЧ, А НЕ РЫНОК: два гандикап-пропа одного матча решаются одним счётом.
  const testMatches = new Set(test.map((r) => r.matchId)).size;

  // ПОЧЕМУ ТЕСТ НЕ НАБИРАЕТСЯ — считается по ТЕКУЩИМ снимкам: это вопрос о сегодняшнем сборе, а не о истории.
  const undecided = live.rows.filter((r) => r.group === "тест" && r.outcome === "нет исхода");
  const undecidedNoToken = undecided.filter((r) => !r.hasToken).length;
  const lags = undecided.map((r) => r.priceLagMin).filter((x): x is number => x != null).sort((a, b) => a - b);
  const undecidedStalePrice = lags.filter((x) => x > 30).length;
  const undecidedMedianLagMin = lags.length ? lags[lags.length >> 1] : null;
  const whyStuck = undecided.length
    ? ` Из ${undecided.length} нерешённых гандикапов сейчас: без токена ${undecidedNoToken}, с ценой старше 30мин до конца матча ${undecidedStalePrice} (медиана отставания ${undecidedMedianLagMin ?? "—"}мин).`
    : "";

  // ── АЛЬТЕРНАТИВА судится по собственной пре-регистрации: только РАЗЛИЧАЮЩИЕ матчи и только ПОСЛЕ фиксации.
  const discr = rows.filter((r) => r.group === "тест" && r.discriminating && r.altOutcome !== "нет исхода");
  const byMatch = (list: ShcRow[]) => {
    const seen = new Map<string, boolean>();
    for (const r of list) seen.set(r.matchId, (seen.get(r.matchId) ?? false) || r.altOutcome === "РАСХОЖДЕНИЕ");
    return { n: seen.size, bad: [...seen.values()].filter(Boolean).length };
  };
  const day = (r: ShcRow) => (r.kickoffAt ?? "").slice(0, 10);
  const since = byMatch(discr.filter((r) => day(r) > SHC_ALT_REGISTERED_AT));
  const retro = byMatch(discr.filter((r) => day(r) <= SHC_ALT_REGISTERED_AT));
  const altVerdict: ShcVerdict = since.bad > 0 ? "ОПРОВЕРГНУТА"
    : since.n >= SHC_ALT_MIN_DISCRIMINATING ? "ПОДТВЕРЖДЕНА" : "НЕ СОЗРЕЛО";
  const alt = {
    registeredAt: SHC_ALT_REGISTERED_AT, minDiscriminating: SHC_ALT_MIN_DISCRIMINATING,
    discriminatingSince: since.n, mismatchSince: since.bad,
    discriminatingRetro: retro.n, mismatchRetro: retro.bad,
    verdict: altVerdict,
    note: altVerdict === "ОПРОВЕРГНУТА"
      ? `альтернатива «−1.5 всегда у первого» ОПРОВЕРГНУТА: ${since.bad} расхождений на ${since.n} различающих матчах после ${SHC_ALT_REGISTERED_AT}`
      : altVerdict === "ПОДТВЕРЖДЕНА"
        ? `альтернатива ПОДТВЕРЖДЕНА на НОВЫХ данных: ${since.n} различающих матчей после ${SHC_ALT_REGISTERED_AT}, ноль расхождений — ${pWithUnit(Math.pow(0.5, since.n), since.n, "матчах")}. Флаг поднимает ВЛАДЕЛЕЦ`
        : `альтернатива НЕ СОЗРЕЛА: различающих матчей после ${SHC_ALT_REGISTERED_AT} ${since.n} при нужных ${SHC_ALT_MIN_DISCRIMINATING}`
          + ` (ретроспективно согласована с ${retro.n - retro.bad}/${retro.n} различающими — но ЭТИ матчи гипотезу ПОРОДИЛИ и подтвердить её не могут)`,
  };

  let verdict: ShcVerdict, note: string;
  if (control.length < SHC_CONTROL_MIN) {
    verdict = "НЕ СОЗРЕЛО";
    note = `журнал: контроль не набран — манилайнов с прочитанным исходом ${control.length} при нужных ${SHC_CONTROL_MIN}. Инструмент не проверен, значит и гипотезу проверять НЕЧЕМ.${whyStuck}`;
  } else if (controlMismatch > 0) {
    verdict = "МЕТОД НЕВЕРЕН";
    note = `контроль РАЗОШЁЛСЯ: ${controlMismatch} из ${control.length} манилайнов противоречат собственному счёту. Сломано одно из двух звеньев самой проверки — цена→исход или ориентация подписи. Вердикта о конвенции НЕТ, блок остаётся`;
  } else if (testMismatch > 0) {
    verdict = "ОПРОВЕРГНУТА";
    note = `конвенция ОПРОВЕРГНУТА по ЖУРНАЛУ: ${testMismatch} расхождений на ${testMatches} матчах при чистом контроле (${control.length}/${control.length}). Правило «фаворит несёт −1.5» неверно — блок остаётся, флаг НЕ поднимается`;
  } else if (testMatches < SHC_TEST_MIN_MATCHES) {
    verdict = "НЕ СОЗРЕЛО";
    note = `журнал: контроль чист (${control.length}/${control.length}), расхождений нет, но матчей теста ${testMatches} при нужных ${SHC_TEST_MIN_MATCHES} — ОТСУТСТВИЕ ЗАМЕРА, а не разрешение.${whyStuck}`;
  } else {
    verdict = "ПОДТВЕРЖДЕНА";
    note = `по ЖУРНАЛУ: контроль чист (${control.length}/${control.length}), тест чист — ${test.length} рынков на ${testMatches} матчах, ноль расхождений, ${pWithUnit(Math.pow(0.5, testMatches), testMatches, "матчах")}. Основание для снятия блока есть; флаг поднимает ВЛАДЕЛЕЦ, не отчёт`;
  }

  return {
    rows, controlChecked: control.length, controlMismatch,
    testMatches, testChecked: test.length, testMismatch,
    ambiguousProps, explicitProps,
    undecidedNoToken, undecidedStalePrice, undecidedMedianLagMin,
    droppedIncomplete, alt, verdict, note,
    journalRows: rows.length, prior: PRIOR_VERDICT,
  };
}

/** Строка для еженедельника: цена блока в штуках и текущий вердикт проверки. */
export function setHandicapConventionLine(r: ShcReport): string {
  return `set_handicap: подписей неоднозначных ${r.ambiguousProps} / явных ${r.explicitProps}`
    + ` · контроль ${r.controlChecked - r.controlMismatch}/${r.controlChecked}`
    + ` · тест ${r.testChecked - r.testMismatch}/${r.testChecked} на ${r.testMatches} матчах`
    + ` · ${r.verdict}`
    + ` · альт «−1.5 у первого»: ${r.alt.discriminatingSince}/${r.alt.minDiscriminating} различающих после ${r.alt.registeredAt} → ${r.alt.verdict}`
    + ` · журнал ${r.journalRows} набл. · прежний вердикт ${r.prior.verdict} помечен ${r.prior.status}`;
}
