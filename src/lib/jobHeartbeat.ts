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

/** Ожидаемые шаги ПОЛНОГО цикла с интервалами. Перечень явный: «шага нет в метриках» иначе неотличимо
 *  от «мы про него забыли». Интервал берётся из настройки тика, а не зашит числом. */
export function expectedTickJobs(tickMin: number): { label: string; everyMin: number }[] {
  return [
    "aliasOverlay", "repairLeagueMap", "dedupe", "reSettleSuspects", "staleShadowResolve", "pieceRelabel",
    "legGapSuspect", "reSettleSuspectsFresh", "boundNoScoreChase", "blindFundedAudit", "advanceClocks", "stats", "settleStale",
    "captureLiveOpens", "tennisFinish", "tennisScoreBackfill", "tennisSettle", "tennisPmvSettle",
    "pmvShadowResolve", "familyShadowResolve", "refusalShadowResolve", "svShadowResolve",
    "prune", "pruneProviderSnapshots", "noFeedCoverage", "sweepAbandoned", "pruneMatches", "capLogArchive",
  ].map((label) => ({ label, everyMin: tickMin }));
}
