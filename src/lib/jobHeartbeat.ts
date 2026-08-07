// ============================================================
// EDGE LAB — «НЕ ЗАПУСКАЛОСЬ» ОТЛИЧИМО ОТ «ОТРАБОТАЛО ВПУСТУЮ»  [O3 из ТЗ наблюдаемости]
//
// Обобщение урока piece_relabel: шаг тика логировал результат только при изменениях, и «перевёрнуто 0»
// было НЕМЫМ — снаружи неотличимым от «миграция не запускалась». Тот же дефект был у счётчика глубины
// 30.07 («глубина снята по 0») и у сторожа-на-отсутствие-маркера. Общая форма у всех трёх одна:
// МОЛЧАНИЕ КОДИРУЕТ ДВА РАЗНЫХ ФАКТА. Лечение — дать каждому факту собственный положительный отпечаток.
//
// ПОЧЕМУ НЕ «ПЕЧАТАТЬ КАЖДЫЙ ШАГ ОТДЕЛЬНОЙ СТРОКОЙ». В цикле ~40 шагов; сорок строк каждые полчаса — это
// потоп, который мы уже проходили на карантине (90k строк) и лечили троттлами. Принцип ТЗ прямо запрещает
// «логировать всё». Поэтому:
//   • ФАКТ запуска и результат каждого шага пишутся ДАННЫМИ (app_meta), а не строками — их можно
//     спросить, а не искать глазами;
//   • в лог идёт ОДНА сводная строка на цикл, где присутствуют ВСЕ шаги, включая нулевые. Ноль виден
//     ровно так же, как двести, и при этом не стоит сорока строк.
//
// «Устаревший шаг» = не запускался дольше ожидаемого интервала × запас. Это ловит не «шаг ничего не
// сделал» (законно), а «шаг перестал вызываться» — то есть мёртвую проводку, а не тихий день.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

const KEY = (label: string) => `job:${label}`;

export interface JobRun { at: string; result: number | null; ms: number; ok: boolean }

/** Зафиксировать запуск шага. Пишется ВСЕГДА — в том числе (и особенно) когда результат нулевой. */
export function recordJobRun(db: Database, label: string, run: JobRun): void {
  try { R.metaSet(db, KEY(label), JSON.stringify(run), run.at); } catch { /* учёт не роняет то, что учитывает */ }
}

export function readJobRun(db: Database, label: string): JobRun | null {
  try { const raw = R.metaGet(db, KEY(label)); return raw ? (JSON.parse(raw) as JobRun) : null; } catch { return null; }
}

export interface JobRow {
  label: string; lastAt: string | null; ageMin: number | null;
  result: number | null; ok: boolean;
  verdict: "свежий" | "УСТАРЕЛ" | "НИ РАЗУ";
  note: string;
}
export interface JobHeartbeatReport {
  rows: JobRow[]; stale: JobRow[]; neverRan: JobRow[];
  note: string;
}

/** Во сколько раз шаг может отстать от ожидаемого интервала, прежде чем это станет подозрением. */
export const JOB_STALE_FACTOR = 3;

/**
 * Пульс джоб. `expected` — ожидаемые шаги с интервалом в минутах: список ЯВНЫЙ, потому что «шага нет в
 * app_meta» может значить и «не запускался», и «мы про него забыли». Второе лечится только перечнем.
 */
export function buildJobHeartbeat(
  db: Database, expected: { label: string; everyMin: number }[], nowMs = Date.now(),
): JobHeartbeatReport {
  const rows: JobRow[] = expected.map(({ label, everyMin }) => {
    const run = readJobRun(db, label);
    const ageMin = run ? Math.round((nowMs - (Date.parse(run.at) || 0)) / 60_000) : null;
    const limit = everyMin * JOB_STALE_FACTOR;
    const verdict: JobRow["verdict"] = !run ? "НИ РАЗУ" : (ageMin ?? 0) > limit ? "УСТАРЕЛ" : "свежий";
    return {
      label, lastAt: run?.at ?? null, ageMin, result: run?.result ?? null, ok: run?.ok ?? false, verdict,
      note: verdict === "НИ РАЗУ" ? `ни одного запуска — шаг либо не подключён, либо падает до записи`
        : verdict === "УСТАРЕЛ" ? `${ageMin}мин без запуска при ожидаемых ${everyMin} (порог ${limit}) — подозрение на мёртвую проводку`
        : `${ageMin}мин назад, результат ${run?.result ?? "—"}${run?.ok === false ? " (ОШИБКА)" : ""}`,
    };
  });
  const stale = rows.filter((r) => r.verdict === "УСТАРЕЛ");
  const neverRan = rows.filter((r) => r.verdict === "НИ РАЗУ");
  return {
    rows, stale, neverRan,
    note: stale.length || neverRan.length
      ? `⚠ джобы требуют внимания: устарели ${stale.length} (${stale.map((r) => r.label).join(", ") || "—"}), `
        + `ни разу не запускались ${neverRan.length} (${neverRan.map((r) => r.label).join(", ") || "—"})`
      : `все ${rows.length} ожидаемых джоб отработали в срок`,
  };
}

/** ОДНА сводная строка на цикл, где присутствуют ВСЕ шаги — включая нулевые. Ноль виден так же, как
 *  двести, и при этом не стоит сорока строк лога. */
export function cycleSummaryLine(prefix: string, steps: { label: string; result: number | null; ok: boolean }[], ms: number): string {
  const body = steps.map((s) => `${s.label}=${s.ok ? (s.result ?? "—") : "ОШИБКА"}`).join(" · ");
  const zeros = steps.filter((s) => s.ok && (s.result ?? 0) === 0).length;
  return `[${prefix}] ${ms}мс · шагов ${steps.length} (нулевых ${zeros}, ошибок ${steps.filter((s) => !s.ok).length}) · ${body}`;
}

/**
 * Шаги ПОЛНОГО цикла, идущие НЕ по часам тика. Планировщик документирует три каденции, и `discover` —
 * третья: «DISCOVER every DISCOVER_INTERVAL_HR (default 24)», а тик прямо помечен «No discovery».
 *
 * [ПОПРАВКА 07.08] Раньше перечень раздавал интервал тика ВСЕМ через один `.map`, поэтому `discover`
 * читался как «УСТАРЕЛ 347мин при ожидаемых 30 — подозрение на мёртвую проводку». Проводка была живая;
 * неверным было ОЖИДАНИЕ: сторож сверял шаг с контрактом, которого код никогда не давал, и строка горела
 * красным всегда. Цена не нулевая — сводка вела заголовком эту ложную тревогу, а в той же строке стояли
 * настоящие «НИ РАЗУ». Сторож, который шумит постоянно, обучает не читать себя тогда, когда он прав.
 *
 * ПОЧЕМУ НЕ В `UNWATCHED_STEPS`. Снять наблюдение было бы проще и НЕВЕРНО: `discover` — единственный
 * поставщик новых матчей, и его настоящая смерть обязана быть видна. Ему нужен СВОЙ срок, а не немота.
 */
function jobIntervalMin(label: string, tickMin: number, env: Record<string, string | undefined>): number {
  if (label === "discover") return Math.max(1, Number(env.DISCOVER_INTERVAL_HR ?? 24)) * 60;
  return tickMin;
}

/** Ожидаемые шаги ПОЛНОГО цикла с интервалами. Перечень явный: «шага нет в метриках» иначе неотличимо
 *  от «мы про него забыли». Интервалы берутся из настроек, а не зашиты числом. */
export function expectedTickJobs(tickMin: number, env: Record<string, string | undefined> = process.env): { label: string; everyMin: number }[] {
  return [
    "discover",
    // АСИНХРОННЫЕ ШАГИ — они тоже отмечаются с 02.08. До этого `step()` не звал `noteStep` вовсе, и пульс
    // был СТРУКТУРНО слеп ко всему асинхронному: половина цикла (сеть, LLM, провайдер) следа не оставляла.
    // В списке только БЕЗУСЛОВНЫЕ: `dryExitSweep` включается режимом торговли, а провайдер-зависимые
    // (`enrich`, `fixtureDateBackfill`, `boundNoScoreChase`) на проде идут всегда — их отсутствие само по
    // себе повод для тревоги, поэтому они здесь и стоят.
    "sync", "odds", "enrich", "fixtureDateBackfill", "boundNoScoreChase", "snapshots",
    "analyze", "runStrategists", "reassess", "exits", "autoEnter", "complementAudit", "pmResolution",
    "tennisScout", "tennisPrematchScout", "tennisExit", "tennisFinalPoll",
    "aliasOverlay", "repairLeagueMap", "dedupe", "reSettleSuspects", "staleShadowResolve", "pieceRelabel",
    "legGapSuspect", "reSettleSuspectsFresh", "blindFundedAudit", "advanceClocks", "stats", "settleStale",
    "captureLiveOpens", "tennisFinish", "tennisScoreBackfill", "tennisSettle", "tennisPmvSettle",
    "pmvShadowResolve", "pmvShadowProbe", "placeholderFalseCut", "familyShadowResolve", "refusalShadowResolve", "svShadowResolve",
    "prune", "pruneProviderSnapshots", "noFeedCoverage", "sweepAbandoned", "pruneMatches", "capLogArchive",
    "tennisScoutWatchdog", "tennisBreakMarks", "reconcileFootball", "pruneCategories", "shcObserve",
    // [T6] Грейдер строк решения: без него ряд честной калибровки копится, но никогда не читается.
    "gradeDecisionPrices",
  ].map((label) => ({ label, everyMin: jobIntervalMin(label, tickMin, env) }));
}

/**
 * Шаги, СОЗНАТЕЛЬНО не находящиеся под наблюдением, и почему. Список существует затем, чтобы «шага нет
 * в перечне» означало решение, а не забывчивость: обратная проверка (тест) сверяет перечень с реальными
 * шагами цикла и падает на любом новом непокрытом, если он не назван здесь.
 */
export const UNWATCHED_STEPS: Record<string, string> = {
  dryExitSweep: "включается режимом торговли (readTradingMode ≠ off); при выключенном режиме «НИ РАЗУ» было бы ложной тревогой",
};

// ── ЖИВОЙ ТИК: ВТОРАЯ ПОЛОВИНА ТОЙ ЖЕ СЛЕПОТЫ ───────────────────────────────────────────────────
// 02.08 я починил `step()` полного цикла и объявил класс закрытым. Живой тик остался ровно с тем же
// дефектом: `stepLive`/`stepSyncLive` не звали `noteStep` вовсе. А в живом тике живут шаги, которых в
// полном цикле НЕТ ни одного экземпляра: `tennisTrade`, `tennisSetValue`, `tennisPmv`, `bookDepth`,
// `liveBackfillAnalyze` — то есть теннисные входы, съём глубины и добор анализа. Пульс показывал 49/49
// зелёных и при этом не знал об этих пяти ничего.
//
// ПОЧЕМУ ОТДЕЛЬНАЯ СЕКЦИЯ, А НЕ ДОБАВЛЕНИЕ В `expectedTickJobs`. Живой тик идёт ТОЛЬКО пока есть матч в
// игре. Ночью живых матчей нет — и все его шаги «устарели» бы по стенным часам. Это ровно та ложная
// тревога, которую уже лечили у `dryExitSweep` и у `resettle_suspect`: сторож обязан молчать там, где
// он ничего не измеряет. Поэтому свежесть живого шага меряется НЕ стенными часами, а ЯКОРЕМ —
// отметкой последнего полного живого прохода. Отстал от якоря → проводка мертва. Якоря нет → замера
// нет, и отчёт говорит это словами, а не выдаёт «всё в порядке».
//
// Метки живут в своём пространстве имён (`live:`), потому что половина имён совпадает с полным циклом
// (`odds`, `enrich`, `tennisScout`…), и общая запись стирала бы разницу между «шаг ходит в медленном
// цикле» и «шаг ходит в живом».

export const LIVE_JOB_PREFIX = "live:";
/** Якорь: положительная отметка «полный живой проход дошёл до конца». Ставится последней строкой прохода. */
export const LIVE_PASS_LABEL = "live:pass";
/** Насколько шаг может отстать от якоря, прежде чем это мёртвая проводка, а не разница в тиках. */
export const LIVE_LAG_TOLERANCE_MIN = 10;
/** Старше этого якорь означает «живых матчей давно нет» — то есть ОТСУТСТВИЕ замера, а не здоровье. */
export const LIVE_ANCHOR_FRESH_MIN = 30;

export const liveJobKey = (label: string) => `${LIVE_JOB_PREFIX}${label}`;

/**
 * Шаги ПОЛНОГО живого прохода. Перечень явный по той же причине, что и у медленного цикла.
 * `enrich` зависит от провайдера (на проде он всегда есть — его отсутствие само по себе тревога),
 * остальные безусловны внутри прохода.
 */
export function expectedLiveJobs(): string[] {
  return [
    "odds", "advanceClocks", "enrich", "settleStale", "stats", "captureLiveOpens", "snapshots",
    "bookDepth", "tennisScout", "tennisBreakMarks", "tennisTrade", "tennisSetValue", "tennisPmv",
    "tennisPmvSettle", "tennisExit", "tennisFinish", "tennisSettle",
    "liveBackfillAnalyze", "exits", "reassess", "autoEnter",
  ];
}

/** Живые шаги, сознательно вне наблюдения, и почему. Пустой список — тоже решение, а не забывчивость. */
export const UNWATCHED_LIVE_STEPS: Record<string, string> = {};

export type LiveJobVerdict = "свежий" | "ОТСТАЛ" | "НИ РАЗУ" | "тика не было";
export interface LiveJobRow {
  label: string; lastAt: string | null; lagMin: number | null;
  result: number | null; ok: boolean; verdict: LiveJobVerdict; note: string;
}
export interface LiveJobHeartbeatReport {
  /** Явное «замер был / замера не было» — вместо того чтобы кодировать это пустым списком тревог. */
  measured: boolean;
  anchorAt: string | null; anchorAgeMin: number | null;
  rows: LiveJobRow[]; lagging: LiveJobRow[]; neverRan: LiveJobRow[];
  note: string;
}

export function buildLiveJobHeartbeat(
  db: Database, expected: string[] = expectedLiveJobs(), nowMs = Date.now(),
): LiveJobHeartbeatReport {
  const anchor = readJobRun(db, LIVE_PASS_LABEL);
  const anchorMs = anchor ? Date.parse(anchor.at) || 0 : 0;
  const anchorAgeMin = anchor ? Math.round((nowMs - anchorMs) / 60_000) : null;
  // Якоря нет или он стар — живых матчей не было. Это ОТСУТСТВИЕ ЗАМЕРА: молчание сторожа здесь не
  // утверждает ничего, и отчёт обязан сказать это буквально.
  const measured = !!anchor && (anchorAgeMin as number) <= LIVE_ANCHOR_FRESH_MIN;

  const rows: LiveJobRow[] = expected.map((label) => {
    const run = readJobRun(db, liveJobKey(label));
    const lagMin = run && anchorMs ? Math.round((anchorMs - (Date.parse(run.at) || 0)) / 60_000) : null;
    let verdict: LiveJobVerdict;
    if (!measured) verdict = "тика не было";
    else if (!run) verdict = "НИ РАЗУ";
    else verdict = (lagMin ?? 0) > LIVE_LAG_TOLERANCE_MIN ? "ОТСТАЛ" : "свежий";
    return {
      label, lastAt: run?.at ?? null, lagMin, result: run?.result ?? null, ok: run?.ok ?? false, verdict,
      note: verdict === "тика не было"
          ? `живого прохода ${anchor ? `${anchorAgeMin}мин назад (порог ${LIVE_ANCHOR_FRESH_MIN})` : "не было ни разу"} — живой тик идёт только пока есть матч в игре, поэтому это ОТСУТСТВИЕ ЗАМЕРА, а не «шаг здоров»`
        : verdict === "НИ РАЗУ" ? `полный живой проход дошёл до конца, а этот шаг следа не оставил — проводка мертва`
        : verdict === "ОТСТАЛ" ? `отстал от последнего живого прохода на ${lagMin}мин (порог ${LIVE_LAG_TOLERANCE_MIN}) — шаг перестал вызываться внутри тика`
        : `в такт с проходом (отставание ${lagMin ?? 0}мин), результат ${run?.result ?? "—"}${run?.ok === false ? " (ОШИБКА)" : ""}`,
    };
  });

  const lagging = rows.filter((r) => r.verdict === "ОТСТАЛ");
  const neverRan = rows.filter((r) => r.verdict === "НИ РАЗУ");
  return {
    measured, anchorAt: anchor?.at ?? null, anchorAgeMin, rows, lagging, neverRan,
    note: !measured
      ? `живой тик не измеряется: последний полный проход ${anchor ? `${anchorAgeMin}мин назад` : "отсутствует"}. Это отсутствие замера, а не здоровье`
      : lagging.length || neverRan.length
        ? `⚠ живые шаги требуют внимания: отстали ${lagging.length} (${lagging.map((r) => r.label).join(", ") || "—"}), `
          + `ни разу ${neverRan.length} (${neverRan.map((r) => r.label).join(", ") || "—"})`
        : `все ${rows.length} шагов живого тика в такт с проходом (якорь ${anchorAgeMin}мин назад)`,
  };
}

/** Строка для еженедельника/здоровья. «Не измеряется» здесь — отдельный исход, а не тихое «ок». */
export function liveJobLine(r: LiveJobHeartbeatReport): string {
  if (!r.measured) return `live_jobs: НЕ ИЗМЕРЯЕТСЯ — живого прохода ${r.anchorAt ? `${r.anchorAgeMin}мин назад` : "не было"}`;
  return `live_jobs: ${r.rows.length - r.lagging.length - r.neverRan.length}/${r.rows.length} в такт`
    + (r.lagging.length ? ` · ⚠ отстали: ${r.lagging.map((x) => x.label).join(", ")}` : "")
    + (r.neverRan.length ? ` · ⚠ НИ РАЗУ: ${r.neverRan.map((x) => x.label).join(", ")}` : "");
}
