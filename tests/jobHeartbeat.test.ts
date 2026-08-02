// ============================================================
// EDGE LAB — O3: ТРЕТИЙ ЭКЗЕМПЛЯР «МОЛЧАНИЕ КОДИРУЕТ ДВА ФАКТА», ЗАКРЫТЫЙ КЛАССОМ, А НЕ ТОЧЕЧНО
//
// Форма одна у всех трёх, которые нам уже стоили времени:
//   • счётчик глубины 30.07 — «снято 0» не отличалось от «не считалось»;
//   • piece_relabel — «перевёрнуто 0» не отличалось от «не запускалось»;
//   • сторож 02.08 — «условие не наступило» не отличалось от «ответа не было».
// Лечение общее: у КАЖДОГО факта собственный положительный отпечаток.
//
// Здесь этот отпечаток — запись запуска ДАННЫМИ. И отдельным тестом держится, что сводная строка
// показывает нули наравне с ненулями: иначе стандарт «громкого нуля» умрёт на первом же тихом дне.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import { recordJobRun, readJobRun, buildJobHeartbeat, cycleSummaryLine, expectedTickJobs, JOB_STALE_FACTOR, UNWATCHED_STEPS } from "../src/lib/jobHeartbeat.js";

const NOW = Date.parse("2026-08-02T12:00:00Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const db0 = () => { const db = openDb(":memory:"); initSchema(db); return db; };

test("НУЛЕВОЙ результат записывается так же, как любой другой — в этом весь смысл", () => {
  const db = db0();
  recordJobRun(db, "pieceRelabel", { at: at(1), result: 0, ms: 5, ok: true });
  const r = readJobRun(db, "pieceRelabel")!;
  assert.equal(r.result, 0, "ноль — это результат, а не отсутствие результата");
  assert.equal(r.ok, true);
});

test("«не запускалось» отличимо от «отработало впустую»", () => {
  const db = db0();
  recordJobRun(db, "ranEmpty", { at: at(1), result: 0, ms: 1, ok: true });
  const h = buildJobHeartbeat(db, [{ label: "ranEmpty", everyMin: 30 }, { label: "neverRan", everyMin: 30 }], NOW);

  const ran = h.rows.find((r) => r.label === "ranEmpty")!;
  const never = h.rows.find((r) => r.label === "neverRan")!;
  assert.equal(ran.verdict, "свежий");
  assert.equal(never.verdict, "НИ РАЗУ");
  assert.equal(h.neverRan.length, 1);
  assert.match(never.note, /ни одного запуска/);
});

test("шаг, переставший вызываться, ловится по возрасту — это мёртвая проводка, а не тихий день", () => {
  const db = db0();
  recordJobRun(db, "slow", { at: at(30 * JOB_STALE_FACTOR + 5), result: 3, ms: 1, ok: true });
  const h = buildJobHeartbeat(db, [{ label: "slow", everyMin: 30 }], NOW);
  assert.equal(h.rows[0].verdict, "УСТАРЕЛ");
  assert.match(h.rows[0].note, /подозрение на мёртвую проводку/);
  assert.equal(h.stale.length, 1);
});

test("шаг в пределах интервала×запас — свежий; сторож не воет на норму", () => {
  const db = db0();
  recordJobRun(db, "ok", { at: at(31), result: 0, ms: 1, ok: true });
  const h = buildJobHeartbeat(db, [{ label: "ok", everyMin: 30 }], NOW);
  assert.equal(h.rows[0].verdict, "свежий");
  assert.equal(h.stale.length, 0);
  assert.match(h.note, /отработали в срок/);
});

test("упавший шаг помечен ОШИБКОЙ, а не тихо считается отработавшим", () => {
  const db = db0();
  recordJobRun(db, "boom", { at: at(1), result: null, ms: 1, ok: false });
  const h = buildJobHeartbeat(db, [{ label: "boom", everyMin: 30 }], NOW);
  assert.equal(h.rows[0].ok, false);
  assert.match(h.rows[0].note, /ОШИБКА/);
});

test("сводная строка показывает ВСЕ шаги, включая нулевые, и считает нули отдельно", () => {
  const line = cycleSummaryLine("autoCycle", [
    { label: "a", result: 0, ok: true },
    { label: "b", result: 12, ok: true },
    { label: "c", result: null, ok: false },
  ], 1234);
  assert.match(line, /a=0/, "ноль обязан быть НАПЕЧАТАН");
  assert.match(line, /b=12/);
  assert.match(line, /c=ОШИБКА/);
  assert.match(line, /нулевых 1/);
  assert.match(line, /ошибок 1/);
  assert.match(line, /1234мс/);
});

test("перечень ожидаемых шагов ЯВНЫЙ — иначе «шага нет в метриках» неотличимо от «мы про него забыли»", () => {
  const jobs = expectedTickJobs(30);
  assert.ok(jobs.length >= 20);
  assert.ok(jobs.every((j) => j.everyMin === 30), "интервал берётся из настройки, а не зашит числом");
  for (const need of ["pieceRelabel", "reSettleSuspects", "tennisScoreBackfill", "refusalShadowResolve"]) {
    assert.ok(jobs.some((j) => j.label === need), `${need} обязан быть в перечне`);
  }
});

test("пустая база: все ожидаемые шаги — «НИ РАЗУ», и это громко", () => {
  const h = buildJobHeartbeat(db0(), expectedTickJobs(30), NOW);
  assert.equal(h.neverRan.length, h.rows.length);
  assert.match(h.note, /ни разу не запускались/);
});

// ── СПИСОК СТОРОЖА ПРОВЕРЯЕТСЯ САМ ──────────────────────────────────────────────────────────────
// Первый же прогон на проде показал `boundNoScoreChase` в списке ДВАЖДЫ: я добавил его в
// async-блок, не заметив, что он уже стоит в sync-блоке. Дубль не безобиден — он ДВАЖДЫ попадает в
// `neverRan`/`stale`, то есть раздувает тревогу вдвое и сдвигает вердикт «требуют внимания».
// И вторая, более важная проверка: каждая строка перечня обязана соответствовать РЕАЛЬНОМУ шагу цикла.
// Иначе перечень начинает жить своей жизнью — а он существует ровно затем, чтобы «шага нет в метриках»
// было отличимо от «мы про него забыли». Опечатка в метке даёт вечное «НИ РАЗУ» и ложную тревогу.

test("перечень ожидаемых не содержит дублей — иначе один шаг раздувает тревогу вдвое", () => {
  const labels = expectedTickJobs(30).map((j) => j.label);
  const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
  assert.deepEqual([...new Set(dupes)], [], `дубли в перечне: ${[...new Set(dupes)].join(", ")}`);
});

test("каждая метка перечня — РЕАЛЬНЫЙ шаг цикла; опечатка = вечное «НИ РАЗУ»", async () => {
  const declared = await cycleSteps();
  const missing = expectedTickJobs(30).map((j) => j.label).filter((l) => !declared.has(l));
  assert.deepEqual(missing, [], `в перечне есть метки, которых нет среди шагов цикла: ${missing.join(", ")}`);
});

// ОБРАТНОЕ НАПРАВЛЕНИЕ — ОПАСНЕЕ ПРЯМОГО. Лишняя метка даёт ложную тревогу; НЕДОСТАЮЩАЯ даёт МОЛЧАНИЕ:
// шаг перестал ходить, а пульс об этом не знает, потому что шага в перечне нет. Именно так класс
// «ратифицировано, но не доехало» и копится. Новый шаг обязан либо попасть под наблюдение, либо быть
// НАЗВАННЫМ в UNWATCHED_STEPS с причиной — молчаливого третьего варианта не существует.
test("шаг цикла либо под наблюдением, либо ЯВНО назван исключением с причиной", async () => {
  const declared = await cycleSteps();
  const expected = new Set(expectedTickJobs(30).map((j) => j.label));
  const unwatched = [...declared].filter((l) => !expected.has(l) && !(l in UNWATCHED_STEPS));
  assert.deepEqual(unwatched, [], `шаги вне пульса и вне списка исключений: ${unwatched.join(", ")}`);
  for (const [label, why] of Object.entries(UNWATCHED_STEPS)) {
    assert.ok(declared.has(label), `${label} значится исключением, но такого шага в цикле нет`);
    assert.ok(why.length > 20, `${label}: причина обязана быть читаемой, а не отпиской`);
  }
});

/** Метки шагов ПОЛНОГО цикла прямо из исходника — так же, как манифест читает вызывающие пути. */
async function cycleSteps(): Promise<Set<string>> {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/lifecycle.ts", import.meta.url), "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/\bstep(?:Sync)?\(\s*"([A-Za-z][A-Za-z0-9_]*)"/g)) out.add(m[1]);
  return out;
}
