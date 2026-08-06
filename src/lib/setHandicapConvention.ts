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
// ── КОРЕНЬ, НАЙДЕННЫЙ 06.08: ОРИЕНТАЦИЯ БЫЛА ДОПУЩЕНИЕМ, А НЕ ФАКТОМ (см. O14) ───────────────────
// Все три гипотезы («−1.5 у фаворита», «−1.5 у первого в подписи», «цена — контракт фаворита») спорили о
// том, КТО несёт −1.5, и молча сходились в том, что цена относится к ПЕРВОМУ В ПОДПИСИ. Это неверно:
// цена относится к outcomes[0], а подпись «A vs B Set Handicap +/-1.5» называет ОБОИХ и стороны не несёт.
// Разбивка замера 06.08 (n=91) показала ячейку «фаворит второй, разница 2 сета» (n=22), где промахнулись
// ОБЕ гипотезы по 13 строк, а ЗЕРКАЛЬНЫЙ прогноз угадал все 13 — переворачивалась не гипотеза, а чтение.
//
// Знание было на входе и выбрасывалось за шаг до потребителя: `marketSides` не сохраняла имя исхода,
// когда подпись «уже называет» его. Теперь имя приходит соседним полем (`markets.outcome_first`), сторона
// ЧИТАЕТСЯ, а наблюдение без прочитанной стороны к вердикту НЕ ДОПУСКАЕТСЯ — как и наблюдение с
// неизмеренным разрывом «цена старше счёта». Невозможность доказать сторону не есть доказательство стороны.
//
// Модуль ТОЛЬКО читает. Флага он не касается: снятие блока — отдельное решение владельца по этим числам.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { parseProp, propFirstIsP1 } from "./tennisPmv.js";
import { tennisMoneyline } from "./tennisScout.js";
import { normName } from "./tennisMatch.js";
import { isBestOfFive } from "./tennisSetValue.js";
import { pWithUnit } from "./signals.js";
import { terminalBookMid } from "./terminalBook.js";

/**
 * ПРЕЖНИЙ ВЕРДИКТ ДАУНГРЕЙЖЕН ДО `unverified` — ратифицировано 04.08. «ОПРОВЕРГНУТА» было снято на 12
 * матчах, из которых 11 исчезли из источника за часы: вывод верен по критерию, но НЕВОСПРОИЗВОДИМ, а
 * невоспроизводимый вывод не имеет права держать решение о деньгах ни в какую сторону. T3 остаётся
 * fail-closed до подтверждения ПО ЖУРНАЛУ. История не стирается — она помечена.
 */
/**
 * [T3-фикс 05.08] СЧЁТ И ЦЕНА ОБЯЗАНЫ БЫТЬ ИЗ ОДНОГО МОМЕНТА.
 *
 * ЧЕМ ЗАСЛУЖЕНО. Замер 05.08: контроль дал 4 расхождения на 173 манилайнах, и отчёт объявил «сломано одно
 * из двух звеньев самой проверки — цена→исход или ориентация подписи». Проверка этого вывода:
 *   медиана разрыва «цена старше счёта» у 169 СОГЛАСНЫХ наблюдений — 5 минут;
 *   у ВСЕХ ЧЕТЫРЁХ расхождений — 164 минуты (88 / 109 / 164 / 368).
 * То есть инструмент не сломан. Сломан журнал: он берёт счёт из свежего снимка скаута, цену — из строки
 * `markets`, которая обновляется медленным тиком, и сравнивает два факта из РАЗНЫХ моментов как
 * одновременные. Поле `priceLagMin` для этого и существовало — но НЕ ХРАНИЛОСЬ в журнале, было NULL на
 * всех 173 строках, и NULL читался как «свежо». Сторож-на-отсутствие-отрицательного-маркера.
 *
 * ПОРОГ ВЫБРАН МЕХАНИЧЕСКИ, А НЕ ПО ВЫБОРКЕ. Скаут пишет каждые ~20 секунд, `markets` обновляются раз в
 * медленный тик — значит цена возрастом до ОДНОГО тика это норма конвейера, а не рассинхрон. Отсюда
 * TICK_INTERVAL_MIN (по умолчанию 30). Подгонять порог под наблюдённые 88 минут я не стал: тогда он
 * оправдывал бы сам себя данными, которые должен судить.
 *
 * NULL — ЭТО ОТКАЗ, А НЕ РАЗРЕШЕНИЕ. Не смогли измерить разрыв ⇒ не можем утверждать одновременность ⇒
 * наблюдение к вердикту не допускается. Старые журнальные строки (записанные до этой колонки) остаются
 * в журнале навсегда — append-only — но считаются ОТДЕЛЬНО и вердикт не двигают.
 */
export const SHC_MAX_PRICE_LAG_MIN = (() => {
  const n = Number(process.env.TICK_INTERVAL_MIN);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

/**
 * ПРЕЖНИЕ ВЕРДИКТЫ — В СПИСКЕ, А НЕ ЗАТЁРТЫЕ. История снятого вывода это тоже наблюдение: каждый из них
 * был верен по своему критерию и каждый пал не от новых данных, а от найденного дефекта ИНСТРУМЕНТА.
 * Список печатается целиком — иначе «третий раз опровергли» неотличимо от «один раз опровергли».
 */
export interface ShcPriorVerdict { verdict: ShcVerdict; status: "unverified"; why: string }
export const PRIOR_VERDICTS: ShcPriorVerdict[] = [
  {
    verdict: "ОПРОВЕРГНУТА", status: "unverified",
    why: "снят 03-04.08 на выборке из кэпнутых снимков: 11 из 12 наблюдений исчезли за часы (сверка двух прогонов). Вывод по критерию верен, но невоспроизводим — T3 остаётся fail-closed до журнального подтверждения",
  },
  {
    verdict: "ОПРОВЕРГНУТА", status: "unverified",
    why: "снят 06.08 по журналу (28 расхождений на 91 наблюдении при чистом контроле 302/302). Вывод опирался на ДОПУЩЕНИЕ «цена всегда про первого в подписи» — а ячейка «первый не фаворит, разница 2 сета» (n=22) показала, что там ориентация переворачивается: обе гипотезы промахнулись по 13, зеркальный прогноз угадал все 13. Наблюдения без ПРОЧИТАННОЙ стороны к вердикту больше не допускаются",
  },
];
/** @deprecated читать `PRIOR_VERDICTS`; оставлено, пока внешние потребители не переехали. */
export const PRIOR_VERDICT = PRIOR_VERDICTS[0]!;

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
  /** [T3-корень] Цена относится к ПЕРВОМУ в подписи? ПРОЧИТАНО из имени исхода (markets.outcome_first).
   *  null — сторона не прочитана: наблюдение к вердикту не допускается (догадка тут и была корнем саги). */
  sideFromToken: boolean | null;
  /** Провенанс стороны: имя исхода / «имени нет» / «имя не сопоставилось» — три РАЗНЫХ факта. */
  sideSrc: string;
  /** Предсказание АЛЬТЕРНАТИВЫ («−1.5 всегда у первого») и её исход. */
  altPredictedFirstWins: boolean; altOutcome: ShcOutcome;
  /** Гипотезы предсказывают РАЗНОЕ — только такие матчи что-то доказывают об их различии. */
  discriminating: boolean;
  observedFirstWins: boolean | null; outcome: ShcOutcome; note: string;
  /** ПРОВЕНАНС: у каждого факта свой источник и своё время — строка журнала объясняет саму себя. */
  scoreSrc: string; priceSrc: string; favSrc: string; kickoffAt: string | null;
}
/** «ПОДТВЕРЖДЕНА В ДУЭЛИ» — гипотеза обыграла соперницу там, где они расходятся, но правилом не стала:
 *  на полной выборке промахи есть. Отдельное слово нужно ровно потому, что «ПОДТВЕРЖДЕНА» читается как
 *  лицензия на снятие блока, а дуэльная победа лицензией не является. */
export type ShcVerdict = "МЕТОД НЕВЕРЕН" | "ОПРОВЕРГНУТА" | "ПОДТВЕРЖДЕНА" | "ПОДТВЕРЖДЕНА В ДУЭЛИ" | "НЕ СОЗРЕЛО";
export interface ShcReport {
  rows: ShcRow[];
  controlChecked: number; controlMismatch: number;
  testMatches: number; testChecked: number; testMismatch: number;
  /** Перепись подписей — цена блока в штуках и проверка, что «явные» вообще существуют. */
  ambiguousProps: number; explicitProps: number;
  /** ПОЧЕМУ тест не набирается: из нерешённых гандикапов — сколько без токена и сколько с ценой,
   *  замороженной ДО конца матча. Без этих двух чисел «НЕ СОЗРЕЛО» неотличимо от «не дозреет никогда». */
  undecidedNoToken: number; undecidedStalePrice: number; undecidedMedianLagMin: number | null;
  /** [T3-фикс] Порог допуска и отказы: сужение выборки обязано быть видимым, а не молчаливым. */
  maxPriceLagMin: number;
  refusedLegacyNoLag: number; refusedStalePrice: number; refusedIncomplete: number; refusedSideUnknown: number;
  /** [T3-корень] ПОКРЫТИЕ ОРИЕНТАЦИИ. Отдельный блок нужен потому, что «колонки ещё нет» и «имя пришло,
   *  но не сопоставилось» лечатся ПРОТИВОПОЛОЖНО: первое проходит само с новыми матчами, второе значит,
   *  что провайдер не даёт имён вовсе и механизм не заработает НИКОГДА. Без этого различения молчащий
   *  ноль покрытия неотличим от самозапечатывающегося гейта — четвёртый раз за неделю. */
  orientation: {
    known: number; noName: number; unreadable: number;
    journalKnown: number; journalUnknown: number;
    /** Проба пишущего пути: сколько СВЕЖИХ строк `markets` вообще и сколько из них несут имя исхода.
     *  Покрытие зреет сутками, а сломанный писатель обязан быть виден в тот же час. */
    writeProbeMarkets: number; writeProbeNamed: number; writeProbeHours: number;
    note: string;
  };
  /** Незавершённые (ретайр) исключены из суждения — ±1.5 там void. Число печатается, а не прячется. */
  droppedIncomplete: number;
  /** Сколько наблюдений в ЖУРНАЛЕ — знаменатель вердикта, живущий дольше снимков. */
  journalRows: number;
  /** ПРЕЖНИЕ вердикты, снятые дефектами инструмента: история не стирается, но помечена. */
  priors: ShcPriorVerdict[];
  /** АЛЬТЕРНАТИВА, порождённая данными: считается только на РАЗЛИЧАЮЩИХ матчах ПОСЛЕ фиксации. */
  alt: {
    registeredAt: string; minDiscriminating: number;
    discriminatingSince: number; mismatchSince: number;
    /** Ретроспектива — явно помечена: эти матчи гипотезу ПОРОДИЛИ и подтвердить её не могут. */
    discriminatingRetro: number; mismatchRetro: number;
    /** Промахи альтернативы на ВСЕЙ тест-выборке — то, чего пре-регистрация по построению не видит. */
    fullSetChecked: number; fullSetMismatch: number;
    verdict: ShcVerdict; note: string;
  };
  verdict: ShcVerdict; note: string;
}

/**
 * [ПРИБОР 06.08] ЖИВ ЛИ ПИШУЩИЙ ПУТЬ — УЛИКА НА ИСТОЧНИКЕ, А НЕ ЧЕРЕЗ СУТКИ.
 *
 * Покрытие ориентации считается по ЗАВЕРШЁННЫМ теннисным матчам — то есть между деплоем и первым
 * доигранным матчем стоит слепая зона в часы, в которой «имён ещё нет, потому что матчей не было» и
 * «имён нет, потому что путь их не кладёт» выглядят ОДИНАКОВО. Ровно эта слепота уже стоила одного
 * пропущенного дефекта: `refreshMatchOdds` терял имя на каждом тике, и заметить это было нечем.
 *
 * Проба смотрит на СВЕЖИЕ строки `markets` — любые, не только теннис и не только завершённые. Если за
 * последние часы строки писались, а имён в них нет, путь сломан, и это видно СРАЗУ.
 */
const SHC_WRITE_PROBE_H = 2;
function writeProbe(db: Database, nowMs: number): { total: number; named: number } {
  try {
    const since = new Date(nowMs - SHC_WRITE_PROBE_H * 3_600_000).toISOString();
    const r = db.prepare(
      `SELECT COUNT(*) n, SUM(CASE WHEN outcome_first IS NOT NULL AND outcome_first<>'' THEN 1 ELSE 0 END) k
         FROM markets WHERE snapshot_at >= ?`,
    ).get(since) as { n?: number; k?: number } | undefined;
    return { total: r?.n ?? 0, named: r?.k ?? 0 };
  } catch { return { total: 0, named: 0 }; }
}

/** Насколько цена рынка старше последнего, что мы знаем о матче. Отрицательных не бывает — только 0. */
function priceLag(snapshotAt: string | null | undefined, lastSeenMs: number): number | null {
  const t = Date.parse(snapshotAt ?? "");
  if (!Number.isFinite(t) || !lastSeenMs) return null;
  return Math.max(0, Math.round((lastSeenMs - t) / 60_000));
}

/**
 * [T3-корень 06.08] СТОРОНА ЧИТАЕТСЯ ИЗ ИМЕНИ ИСХОДА, А НЕ ВЫВОДИТСЯ.
 *
 * `outcome_first` — имя исхода, чью вероятность несёт цена (outcomes[0] у Polymarket). Для «A vs B Set
 * Handicap +/-1.5» это единственный факт, который вообще говорит, ЧЬЮ сторону мы видим: подпись называет
 * обоих и не различает их. Возвращает true, если цена относится к ПЕРВОМУ игроку в подписи.
 *
 * null — имя не сопоставилось (нет колонки у старых строк, или провайдер дал не-именной исход). Это
 * ОТСУТСТВИЕ ФАКТА: наблюдение к вердикту не допускается. Догадка здесь и была источником всей саги —
 * три глобальных правила подряд объясняли по три четверти выборки и врали на остатке.
 */
export function priceSideIsLabelFirst(outcomeFirst: string | null | undefined, p1: string, p2: string): boolean | null {
  const o = normName(String(outcomeFirst ?? ""));
  if (!o) return null;
  const a = normName(p1), b = normName(p2);
  if (!a || !b || a === b) return null;
  const hitA = o.includes(a) || a.includes(o);
  const hitB = o.includes(b) || b.includes(o);
  if (hitA === hitB) return null;                 // ни одного или оба — различить нечем
  return hitA;
}

/**
 * Сторона наблюдения: цена рынка относится к ПЕРВОМУ В ПОДПИСИ?
 *
 * `priceSideIsLabelFirst` отвечает про p1/p2 скаута, а подпись может называть их в обратном порядке —
 * поэтому ответ ещё разворачивается через `labelFirstIsP1`. Три исхода различаются НАЗВАНИЕМ:
 *   • имя есть и сопоставилось — сторона прочитана;
 *   • имени нет вовсе (строка старше колонки) — пройдёт само с новыми матчами;
 *   • имя есть, но не сопоставилось («Yes»/«No», иная транслитерация) — механизм НЕ заработает сам,
 *     и это обязано быть видно отдельным числом, а не растворяться в общем «не прочитано».
 */
function orientationOf(
  outcomeFirst: string | null | undefined, players: { p1: string; p2: string }, labelFirstIsP1: boolean,
): { side: boolean | null; src: string } {
  const raw = String(outcomeFirst ?? "").trim();
  if (!raw) return { side: null, src: "side_absent:имени исхода нет" };
  const isP1 = priceSideIsLabelFirst(raw, players.p1, players.p2);
  if (isP1 == null) return { side: null, src: `side_unreadable:${raw}` };
  return { side: isP1 === labelFirstIsP1, src: `outcome_first:${raw}` };
}

/** Разрешился ли рынок и в какую сторону. Середина — ЧЕСТНОЕ «нет исхода», а не округление к ближнему. */
function resolvedFirstWins(price: number | null): boolean | null {
  if (price == null) return null;
  if (price >= SHC_RESOLVED_HI) return true;
  if (price <= SHC_RESOLVED_LO) return false;
  return null;
}

/**
 * Развернуть исход, прочитанный ПО ЦЕНЕ (то есть про outcomes[0]), в исход ПЕРВОГО В ПОДПИСИ.
 *
 * Рынок бинарен и ничья по ±1.5 в сетах невозможна — значит «второй покрыл» это ровно «первый не покрыл»,
 * и разворот законен без знания, у кого из них −1.5. Сторона неизвестна ⇒ РАЗВОРАЧИВАТЬ НЕЧЕМ: строка
 * остаётся с прежним, ДОПУЩЕННЫМ чтением и помечается недопустимой — это честнее, чем ронять её в
 * «нет исхода», где она смешалась бы с рынками, которые действительно не разрешились.
 */
function orient(outcomeFirstWins: boolean | null, sideIsLabelFirst: boolean | null): boolean | null {
  if (outcomeFirstWins == null) return null;
  return sideIsLabelFirst === false ? !outcomeFirstWins : outcomeFirstWins;
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
      // [O12] ПОЧЕМУ ЦЕНА НЕ БЕРЁТСЯ ИЗ КОЛОНКИ СКАУТА, ХОТЯ ОНА ТАМ ЕСТЬ.
      //
      // Соблазн очевиден: скаут пишет `pm_p1_cents` в ту же строку, что и счёт, — разрыв был бы нулевым
      // по построению. Но у этой колонки ДВА разных происхождения (tennisScout): для рынков в скоупе это
      // живой мидпойнт, а для вне-скоупных тиров (ITF/челленджеры/пары) — СОХРАНЁННЫЙ ДИСКАВЕРИ-манилайн,
      // записанный под временем ТЕКУЩЕЙ строки. То есть предматчевая цена выглядела бы синхронной со
      // счётом и получала бы разрыв 0, а различить их из строки нечем.
      //
      // Это тот же класс O11, спрятанный на уровень глубже: метка времени принадлежит СТРОКЕ, а не факту
      // в ней. Источник, который не может доказать собственную свежесть, к вердикту не допускается —
      // поэтому и манилайн, и гандикапы читаются из ТЕРМИНАЛЬНОГО СНИМКА, который несёт своё время съёма.

      // ── КОНТРОЛЬ: манилайн. Кто выиграл матч — известно из счёта; ориентация — из подписи.
      const ml = tennisMoneyline(db, m.id, players);
      if (ml) {
        const mlMarket = R.latestMarkets(db, m.id).find((x) => x.label === ml.label);
        const mlTerm = terminalBookMid(db, m.id, ml.label);
        const price = mlTerm ? mlTerm.cents : (mlMarket?.price == null ? null : Number(mlMarket.price));
        const firstSets = ml.firstIsP1 ? last.sets_p1 : last.sets_p2;
        const secondSets = ml.firstIsP1 ? last.sets_p2 : last.sets_p1;
        const predicted = firstSets > secondSets;
        // [T3-корень] Ориентация читается и в КОНТРОЛЕ — иначе контроль подтверждал бы инструмент, не
        // проверив то самое звено, ради которого он заведён («ориентация подписи читается верно»).
        const mlSide = orientationOf(mlMarket?.outcome_first, players, ml.firstIsP1);
        const observed = orient(resolvedFirstWins(price), mlSide.side);
        rows.push({
          matchId: m.id, players: `${m.home} — ${m.away}`, label: ml.label, group: "контроль",
          setsFirst: firstSets, setsSecond: secondSets, favIsLabelFirst: ml.firstIsP1 === favIsScoutP1,
          predictedFirstWins: predicted, lastPriceCents: price,
          hasToken: !!mlMarket?.external_ref,
          sideFromToken: mlSide.side, sideSrc: mlSide.src,
          priceLagMin: priceLag(mlTerm ? mlTerm.at : mlMarket?.snapshot_at, lastSeenMs),
          scoreSrc: `scout_snapshot@${lastAt}`,
          priceSrc: mlTerm ? `terminal_book@${mlTerm.at}` : `markets@${mlMarket?.snapshot_at ?? "—"}`,
          favSrc, kickoffAt: m.kickoff_at ?? null,
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
        // [O12] ЦЕНА ГАНДИКАПА — ИЗ ТЕРМИНАЛЬНОГО СНИМКА, если он есть. Он снят В МОМЕНТ терминального
        // статуса, то есть синхронно со счётом; строка `markets` для завершившегося матча заведомо
        // старая (её пишет медленный тик, и после `finished` не пишет вовсе). Нет снимка — падаем на
        // `markets` и честно несём его отставание в priceLagMin, где допуск journal'а его и отсеет.
        const term = terminalBookMid(db, m.id, mk.label);
        const price = term ? term.cents : (mk.price == null ? null : Number(mk.price));
        // [T3-корень 06.08] СТОРОНА ЧИТАЕТСЯ ИЗ ИМЕНИ ИСХОДА, А НЕ ВЫВОДИТСЯ. Цена всегда относится к
        // outcomes[0]; чей это игрок — говорит только `outcome_first`. Прежде здесь стояло молчаливое
        // допущение «outcomes[0] = первый в подписи», и именно оно давало ячейку n=22, где промахивались
        // ОБЕ гипотезы, а зеркальный прогноз угадывал все 13.
        const side = orientationOf(mk.outcome_first, players, first === true);
        const observed = orient(resolvedFirstWins(price), side.side);
        const altOutcome: ShcOutcome = observed == null ? "нет исхода" : observed === altPredicted ? "совпало" : "РАСХОЖДЕНИЕ";
        rows.push({
          matchId: m.id, players: `${m.home} — ${m.away}`, label: mk.label, group: "тест",
          setsFirst: firstSets, setsSecond: secondSets, favIsLabelFirst,
          predictedFirstWins: predicted, lastPriceCents: price,
          hasToken: !!mk.external_ref,
          sideFromToken: side.side, sideSrc: side.src,
          priceLagMin: priceLag(term ? term.at : mk.snapshot_at, lastSeenMs),
          scoreSrc: `scout_snapshot@${lastAt}`,
          priceSrc: term ? `terminal_book@${term.at}` : `markets@${mk.snapshot_at ?? "—"}`,
          favSrc, kickoffAt: m.kickoff_at ?? null,
          completed, altPredictedFirstWins: altPredicted, altOutcome,
          discriminating: predicted !== altPredicted,
          observedFirstWins: observed,
          outcome: observed == null ? "нет исхода" : observed === predicted ? "совпало" : "РАСХОЖДЕНИЕ",
          note: observed == null
            ? `цена ${price ?? "—"}¢ между ${SHC_RESOLVED_LO} и ${SHC_RESOLVED_HI} — исход НЕ прочитан (не судим, а не «наверное да»)`
            : `счёт ${firstSets}:${secondSets}, −1.5 у ${minusOnFirst ? "первого" : "второго"} в подписи (первый ${favIsLabelFirst ? "И ЕСТЬ" : "НЕ"} фаворит) ⇒ ждём ${predicted ? "покрытие" : "непокрытие"}; цена ${price}¢ про ${side.side == null ? "НЕИЗВЕСТНО КОГО" : side.side ? "первого" : "ВТОРОГО"} (${side.src}) ⇒ ${observed ? "покрыл" : "не покрыл"}`,
        });
      }
    }
  }

  return { rows, ambiguousProps, explicitProps, droppedIncomplete };
}

/**
 * [T3-фикс] Допустимо ли наблюдение к ВЕРДИКТУ. Три условия, все — про то, отвечает ли строка на вопрос,
 * который ей задают:
 *   • разрыв «цена старше счёта» ИЗМЕРЕН — иначе одновременность недоказуема (NULL это отказ, не «свежо»);
 *   • разрыв не больше одного тика — иначе цена описывает не тот момент, что счёт;
 *   • матч ДОИГРАН — иначе «кто выиграл» ещё не определено, а ±1.5 там вообще void (Gate 0.2).
 *
 * Прежде третье условие применялось только к тесту: «манилайн при ретайре разрешается нормально». Замер
 * 05.08 это опроверг — двое из четырёх контрольных расхождений были ровно `completed:false`. Условие
 * распространено на ОБЕ группы; контроль худеет, но перестаёт врать.
 */
export type ShcRefusal = "lag_unknown" | "stale_price" | "incomplete" | "side_unknown";
/** Первая непройденная причина, а не набор: так счётчики отказов НЕ пересекаются и сумма сходится. */
export function refusalCause(r: ShcRow): ShcRefusal | null {
  if (r.priceLagMin == null) return "lag_unknown";
  if (r.priceLagMin > SHC_MAX_PRICE_LAG_MIN) return "stale_price";
  if (!r.completed) return "incomplete";
  // [T3-корень 06.08] ЧЕТВЁРТОЕ УСЛОВИЕ — СТОРОНА ПРОЧИТАНА, А НЕ ДОПУЩЕНА.
  //
  // Прежде наблюдение молча считало, что цена относится к первому в подписи. Замер 06.08 (n=91) это
  // допущение опроверг: в ячейке «первый не фаворит, разница 2 сета» (n=22) промахнулись ОБЕ гипотезы
  // по 13 строк, а ЗЕРКАЛЬНЫЙ прогноз угадал все 13 — подпись ориентации не несёт, её несёт токен.
  //
  // Это ровно тот же ход, что и с priceLagMin: невозможность доказать сторону не есть доказательство
  // стороны. Прежние строки журнала остаются (append-only), но вердикт не двигают.
  if (r.sideFromToken == null) return "side_unknown";
  return null;
}
export function admissible(r: ShcRow): boolean { return refusalCause(r) == null; }

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
      hasToken: true, priceLagMin: o.price_lag_min ?? null, completed: !!o.completed,
      sideFromToken: o.side_from_token == null ? null : !!o.side_from_token, sideSrc: o.side_src ?? "side_absent:строка старше колонки",
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
export function buildSetHandicapConvention(db: Database, nowMs = Date.now()): ShcReport {
  const live = observeFromSnapshots(db);
  const rows = journalRows(db);
  const { ambiguousProps, explicitProps, droppedIncomplete } = live;

  // [T3-фикс] К ВЕРДИКТУ ДОПУСКАЮТСЯ ТОЛЬКО ОДНОВРЕМЕННЫЕ НАБЛЮДЕНИЯ. Разрыв не измерен ⇒ отказ:
  // невозможность доказать одновременность это не доказательство одновременности.
  const decided = (g: ShcRow["group"]) => rows.filter((r) => r.group === g && r.outcome !== "нет исхода" && admissible(r));
  const notAdmissible = rows.filter((r) => r.outcome !== "нет исхода" && !admissible(r));
  const byCause = (c: ShcRefusal) => notAdmissible.filter((r) => refusalCause(r) === c).length;
  const legacyNoLag = byCause("lag_unknown");
  const staleAdmission = byCause("stale_price");
  const incompleteAdmission = byCause("incomplete");
  const sideUnknownAdmission = byCause("side_unknown");
  const control = decided("контроль"), test = decided("тест");
  const controlMismatch = control.filter((r) => r.outcome === "РАСХОЖДЕНИЕ").length;
  const testMismatch = test.filter((r) => r.outcome === "РАСХОЖДЕНИЕ").length;
  // ЕДИНИЦА — МАТЧ, А НЕ РЫНОК: два гандикап-пропа одного матча решаются одним счётом.
  const testMatches = new Set(test.map((r) => r.matchId)).size;

  // ПОЧЕМУ ТЕСТ НЕ НАБИРАЕТСЯ — считается по ТЕКУЩИМ снимкам: это вопрос о сегодняшнем сборе, а не о истории.
  const undecided = live.rows.filter((r) => r.group === "тест" && r.outcome === "нет исхода");
  const undecidedNoToken = undecided.filter((r) => !r.hasToken).length;
  const lags = undecided.map((r) => r.priceLagMin).filter((x): x is number => x != null).sort((a, b) => a - b);
  const undecidedStalePrice = lags.filter((x) => x > SHC_MAX_PRICE_LAG_MIN).length;   // тот же порог, что у допуска
  const undecidedMedianLagMin = lags.length ? lags[lags.length >> 1] : null;
  const whyStuck = undecided.length
    ? ` Из ${undecided.length} нерешённых гандикапов сейчас: без токена ${undecidedNoToken}, с ценой старше ${SHC_MAX_PRICE_LAG_MIN}мин до конца матча ${undecidedStalePrice} (медиана отставания ${undecidedMedianLagMin ?? "—"}мин).`
    : "";

  // ── АЛЬТЕРНАТИВА судится по собственной пре-регистрации: только РАЗЛИЧАЮЩИЕ матчи и только ПОСЛЕ фиксации.
  // [ФИКС 06.08, вечер] АЛЬТЕРНАТИВА СУДИТСЯ ПО ТЕМ ЖЕ ДОПУЩЕННЫМ СТРОКАМ, ЧТО И ОСНОВНАЯ ГИПОТЕЗА.
  //
  // Замер сразу после деплоя O14 вскрыл мой же дефект: `discr` не фильтровался через `admissible`, и
  // альтернатива продолжала считаться на строках, которые основной вердикт только что отверг. Итог был
  // абсурден — «ПОДТВЕРЖДЕНА» при `fullSetChecked: 0`: полная выборка пуста (все 418 строк недопущены),
  // `altFullBad === 0` истинно НА ПУСТОМ МНОЖЕСТВЕ, и `altClean` не понизил вердикт. Альтернатива стала
  // выглядеть СИЛЬНЕЕ, чем до фикса («ПОДТВЕРЖДЕНА» вместо «ПОДТВЕРЖДЕНА В ДУЭЛИ»), хотя доказательств
  // стало МЕНЬШЕ. Немой ноль: пустая выборка прочиталась как чистая.
  //
  // Один допуск на обе гипотезы — иначе это два авторитета на одно решение, и слабейший побеждает.
  const discr = rows.filter((r) => r.group === "тест" && r.discriminating && r.altOutcome !== "нет исхода" && admissible(r));
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
  // [ФИКС 06.08] КРИТЕРИЙ БЫЛ НЕДОСПЕЦИФИЦИРОВАН, И ЭТО МОЯ ОШИБКА ПРОТОКОЛА.
  //
  // Пре-регистрация судила альтернативу ТОЛЬКО на РАЗЛИЧАЮЩИХ матчах — там, где две гипотезы дают разные
  // ответы. Для ВЫБОРА между ними это верно. Но слово вердикта — «ПОДТВЕРЖДЕНА» — читается как «конвенция
  // установлена», а критерий по построению СЛЕП к ячейке, где обе гипотезы отвечают ОДИНАКОВО и обе
  // ошибаются.
  //
  // Замер 06.08, разбивка теста по ячейкам (n=91):
  //     fav_first=true,  margin=1  n=24 — промахов: основная 0 · альтернатива 0
  //     fav_first=true,  margin=2  n=30 — промахов: основная 0 · альтернатива 0
  //     fav_first=false, margin=1  n=15 — промахов: основная 15 · альтернатива 0   ← различающая ячейка
  //     fav_first=false, margin=2  n=22 — промахов: основная 13 · альтернатива 13  ← СЛЕПАЯ ЗОНА
  // В слепой зоне 13 из 22 идут против ОБЕИХ, причём зеркальный прогноз угадывает все 13 — то есть там
  // ориентация токена переворачивается, и ни подпись, ни фаворит её не предсказывают.
  //
  // Поэтому вердикт альтернативы отныне НЕСЁТ ЧИСЛО ПРОМАХОВ ПО ВСЕЙ ВЫБОРКЕ, а «ПОДТВЕРЖДЕНА» без
  // чистой полной выборки понижается до «ПОДТВЕРЖДЕНА В ДУЭЛИ»: она обыграла соперницу там, где они
  // расходятся, и это НЕ то же самое, что «правило найдено».
  const altFull = rows.filter((r) => r.group === "тест" && r.altOutcome !== "нет исхода" && admissible(r));
  const altFullBad = altFull.filter((r) => r.altOutcome === "РАСХОЖДЕНИЕ").length;
  // ПУСТАЯ ВЫБОРКА НЕ ЧИСТАЯ. `altFullBad === 0` истинно и когда промахов нет, и когда судить нечего —
  // это разные факты, и второй не даёт лицензии. Сторож стоит явно, а не выводится из фильтра выше.
  const altClean = altFull.length > 0 && altFullBad === 0;
  const alt = {
    registeredAt: SHC_ALT_REGISTERED_AT, minDiscriminating: SHC_ALT_MIN_DISCRIMINATING,
    discriminatingSince: since.n, mismatchSince: since.bad,
    discriminatingRetro: retro.n, mismatchRetro: retro.bad,
    fullSetChecked: altFull.length, fullSetMismatch: altFullBad,
    verdict: altVerdict === "ПОДТВЕРЖДЕНА" && !altClean ? ("ПОДТВЕРЖДЕНА В ДУЭЛИ" as ShcVerdict) : altVerdict,
    note: altVerdict === "ОПРОВЕРГНУТА"
      ? `альтернатива «−1.5 всегда у первого» ОПРОВЕРГНУТА: ${since.bad} расхождений на ${since.n} различающих матчах после ${SHC_ALT_REGISTERED_AT}`
      : altVerdict === "ПОДТВЕРЖДЕНА"
        ? (altClean
            ? `альтернатива ПОДТВЕРЖДЕНА на НОВЫХ данных: ${since.n} различающих матчей после ${SHC_ALT_REGISTERED_AT}, ноль расхождений — ${pWithUnit(Math.pow(0.5, since.n), since.n, "матчах")}; и по ВСЕЙ тест-выборке (${altFull.length}) промахов тоже нет. Флаг поднимает ВЛАДЕЛЕЦ`
            : `альтернатива выиграла ДУЭЛЬ, но правилом НЕ стала: ${since.n} различающих матчей после ${SHC_ALT_REGISTERED_AT} без единого расхождения (${pWithUnit(Math.pow(0.5, since.n), since.n, "матчах")}) — И ${altFullBad} промахов на ВСЕЙ тест-выборке (${altFull.length}).`
              + ` Пре-регистрация судила только ячейку, где гипотезы РАСХОДЯТСЯ, и по построению слепа там, где обе отвечают одинаково и обе ошибаются.`
              + ` «Обыграла соперницу» ≠ «правило найдено»: блок остаётся, ориентацию нужно брать из ТОКЕНА, а не выводить из подписи и фаворита`)
        : `альтернатива НЕ СОЗРЕЛА: различающих матчей после ${SHC_ALT_REGISTERED_AT} ${since.n} при нужных ${SHC_ALT_MIN_DISCRIMINATING}`
          + ` (ретроспективно согласована с ${retro.n - retro.bad}/${retro.n} различающими — но ЭТИ матчи гипотезу ПОРОДИЛИ и подтвердить её не могут)`,
  };

  // [T3-фикс] ОТКАЗЫ ДОПУСКА ПЕЧАТАЮТСЯ ВСЕГДА. Сужение выборки, о котором не сказано, — это та же
  // подмена, что и вердикт по несинхронным фактам: читатель обязан видеть, сколько строк не отвечало.
  const refused = legacyNoLag + staleAdmission + incompleteAdmission + sideUnknownAdmission;
  const admitNote = refused
    ? ` · к вердикту НЕ допущено ${refused}: разрыв «цена старше счёта» не измерен ${legacyNoLag} (строки старше колонки — доказать одновременность нечем),`
      + ` разрыв больше ${SHC_MAX_PRICE_LAG_MIN}мин ${staleAdmission}, матч не доигран ${incompleteAdmission},`
      + ` сторона НЕ ПРОЧИТАНА ${sideUnknownAdmission} (ориентация была допущением, а не фактом)`
    : "";

  // ── [T3-корень] ПОКРЫТИЕ ОРИЕНТАЦИИ. Громкий ноль обязателен: механизм, который «просто ещё не набрал»,
  // и механизм, который не заработает НИКОГДА, выглядят одинаково ровно до тех пор, пока их не разделить.
  const orientKnown = live.rows.filter((r) => r.sideFromToken != null).length;
  const orientAbsent = live.rows.filter((r) => r.sideSrc.startsWith("side_absent")).length;
  const orientUnreadable = live.rows.filter((r) => r.sideSrc.startsWith("side_unreadable")).length;
  const jKnown = rows.filter((r) => r.sideFromToken != null).length;
  const jUnknown = rows.length - jKnown;
  const probe = writeProbe(db, nowMs);
  const probeNote = probe.total === 0
    ? ` · проба писателя: свежих строк markets за ${SHC_WRITE_PROBE_H}ч НЕТ — путь не проверен (это не «он мёртв»)`
    : probe.named === 0
      ? ` · ⚠ ПИШУЩИЙ ПУТЬ НЕ КЛАДЁТ ИМЯ: ${probe.total} свежих строк markets за ${SHC_WRITE_PROBE_H}ч, из них с именем НОЛЬ — покрытие само не вырастет`
      : ` · пишущий путь жив: ${probe.named} из ${probe.total} свежих строк markets несут имя`;
  const orientation = {
    known: orientKnown, noName: orientAbsent, unreadable: orientUnreadable,
    journalKnown: jKnown, journalUnknown: jUnknown,
    writeProbeMarkets: probe.total, writeProbeNamed: probe.named, writeProbeHours: SHC_WRITE_PROBE_H,
    note: `ориентация из токена: в журнале прочитана у ${jKnown} из ${rows.length} строк`
      + ` · по текущим снимкам прочитана ${orientKnown}, имени исхода нет ${orientAbsent}, имя не сопоставилось ${orientUnreadable}`
      + (orientKnown === 0 && orientUnreadable > 0
        ? `. ИМЕНА ПРИХОДЯТ, НО НЕ СОПОСТАВЛЯЮТСЯ — само это не пройдёт: механизм требует разбора, а не ожидания`
        : orientKnown === 0
          ? `. Колонка заведена 06.08 и заполняется только на ЖИВЫХ рынках — покрытие растёт с новыми матчами, уже завершённым его взять негде`
          : "")
      + probeNote,
  };

  let verdict: ShcVerdict, note: string;
  if (control.length < SHC_CONTROL_MIN) {
    verdict = "НЕ СОЗРЕЛО";
    note = `журнал: контроль не набран — манилайнов с прочитанным исходом ${control.length} при нужных ${SHC_CONTROL_MIN}. Инструмент не проверен, значит и гипотезу проверять НЕЧЕМ.${whyStuck}${admitNote} · ${orientation.note}`;
  } else if (controlMismatch > 0) {
    verdict = "МЕТОД НЕВЕРЕН";
    note = `контроль РАЗОШЁЛСЯ: ${controlMismatch} из ${control.length} манилайнов противоречат собственному счёту. Сломано одно из двух звеньев самой проверки — цена→исход или ориентация подписи (несинхронные наблюдения уже отсеяны допуском, поэтому объяснить разрыв разной свежестью нельзя). Вердикта о конвенции НЕТ, блок остаётся${admitNote}`;
  } else if (testMismatch > 0) {
    verdict = "ОПРОВЕРГНУТА";
    note = `конвенция ОПРОВЕРГНУТА по ЖУРНАЛУ: ${testMismatch} расхождений на ${testMatches} матчах при чистом контроле (${control.length}/${control.length}). Правило «фаворит несёт −1.5» неверно — блок остаётся, флаг НЕ поднимается${admitNote}`;
  } else if (testMatches < SHC_TEST_MIN_MATCHES) {
    verdict = "НЕ СОЗРЕЛО";
    note = `журнал: контроль чист (${control.length}/${control.length}), расхождений нет, но матчей теста ${testMatches} при нужных ${SHC_TEST_MIN_MATCHES} — ОТСУТСТВИЕ ЗАМЕРА, а не разрешение.${whyStuck}${admitNote} · ${orientation.note}`;
  } else {
    verdict = "ПОДТВЕРЖДЕНА";
    note = `по ЖУРНАЛУ: контроль чист (${control.length}/${control.length}), тест чист — ${test.length} рынков на ${testMatches} матчах, ноль расхождений, ${pWithUnit(Math.pow(0.5, testMatches), testMatches, "матчах")}. Основание для снятия блока есть; флаг поднимает ВЛАДЕЛЕЦ, не отчёт${admitNote}`;
  }

  return {
    rows, controlChecked: control.length, controlMismatch,
    testMatches, testChecked: test.length, testMismatch,
    ambiguousProps, explicitProps,
    undecidedNoToken, undecidedStalePrice, undecidedMedianLagMin,
    droppedIncomplete, alt, verdict, note,
    maxPriceLagMin: SHC_MAX_PRICE_LAG_MIN,
    refusedLegacyNoLag: legacyNoLag, refusedStalePrice: staleAdmission, refusedIncomplete: incompleteAdmission,
    refusedSideUnknown: sideUnknownAdmission, orientation,
    journalRows: rows.length, priors: PRIOR_VERDICTS,
  };
}

/** Строка для еженедельника: цена блока в штуках и текущий вердикт проверки. */
export function setHandicapConventionLine(r: ShcReport): string {
  return `set_handicap: подписей неоднозначных ${r.ambiguousProps} / явных ${r.explicitProps}`
    + ` · контроль ${r.controlChecked - r.controlMismatch}/${r.controlChecked}`
    + ` · тест ${r.testChecked - r.testMismatch}/${r.testChecked} на ${r.testMatches} матчах`
    + ` · ${r.verdict}`
    + ` · альт «−1.5 у первого»: ${r.alt.discriminatingSince}/${r.alt.minDiscriminating} различающих после ${r.alt.registeredAt} → ${r.alt.verdict}`
    + ` · сторона из токена ${r.orientation.journalKnown}/${r.journalRows} (имени нет ${r.orientation.noName}, не сопоставилось ${r.orientation.unreadable})`
    + ` · писатель ${r.orientation.writeProbeNamed}/${r.orientation.writeProbeMarkets} свежих строк с именем`
    + ` · журнал ${r.journalRows} набл. · прежних вердиктов помечено unverified: ${r.priors.length}`;
}
