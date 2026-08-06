// ============================================================
// T6 — КАЛИБРОВКА ЧИТАЕТ ТОЛЬКО ЦЕНУ МОМЕНТА РЕШЕНИЯ
//
// Заслужено моей же ошибкой: теневая калибровка на 282 рынках дала «рынок вдвое лучше нас», читая
// ТЕКУЩИЕ котировки — у завершённого матча они равны исходу (цена «угадала» в 92%). Класс O11,
// допущенный тем, кто правило и формулировал. Значит запрет обязан быть КОНСТРУКЦИЕЙ, а не памятью:
// главный тест здесь — исходник модуля, у которого нет доступа к рынкам.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildHonestCalibration, honestCalibrationLine, CALIB_MIN_N } from "../src/lib/honestCalibration.js";

const NOW = "2026-08-07T00:00:00.000Z";
const db0 = () => { const db = openDb(":memory:"); initSchema(db); return db; };
const row = (db: ReturnType<typeof db0>, i: number, our: number, mkt: number, won: 0 | 1, o: { stage?: string; src?: string } = {}) =>
  R.insertDecisionPrice(db, { id: `d${i}`, match_id: `m${i}`, strategy_id: "pv", label: `L${i}`, stage: o.stage ?? "prematch",
    mid_cents: mkt * 100, ask_cents: mkt * 100, implied_prob: mkt, our_prob: our, edge_source: o.src ?? "executable",
    picked: 0, outcome: won, outcome_src: "match_score@1:0", decided_at: `2026-08-07T00:${String(i).padStart(2, "0")}:00Z` });

test("порог назван ДО данных", () => { assert.equal(CALIB_MIN_N, 30); });

test("СТРУКТУРНЫЙ ЗАПРЕТ: модуль не имеет доступа к текущим котировкам — это не дисциплина", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(new URL("../src/lib/honestCalibration.ts", import.meta.url), "utf8");
  // Проверяется КОД, а не проза: первая версия этого теста падала на собственной шапке модуля, где
  // `latestMarkets` упомянут в объяснении, ПОЧЕМУ его здесь нет. Сторож, срабатывающий на документации
  // собственного свойства, заставляет молчать о нём — ровно наоборот тому, чего мы добиваемся.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const forbidden of ["latestMarkets", "marketsFor", "from \"./polymarket", "getQuotes", "ai_prob", "markets"]) {
    assert.ok(!code.includes(forbidden), `калибровка обязана читать ТОЛЬКО decision_prices, в КОДЕ найдено «${forbidden}»`);
  }
  assert.ok(code.includes("decisionPrices"), "единственный источник назван явно");
  assert.ok(raw.includes("latestMarkets"), "и модуль обязан ОБЪЯСНЯТЬ, почему доступа нет — молчание не документация");
});

test("ряд мал — «НЕ СОЗРЕЛО», и это ОТСУТСТВИЕ ЗАМЕРА, а не «мы плохи»", () => {
  const db = db0();
  for (let i = 0; i < 5; i++) row(db, i, 0.7, 0.5, 1);
  const c = buildHonestCalibration(db);
  assert.equal(c.verdict, "НЕ СОЗРЕЛО");
  assert.equal(c.n, 5);
  assert.match(c.note, /ОТСУТСТВИЕ ЗАМЕРА/);
  assert.match(c.note, /КОНСТРУКЦИЕЙ, а не правилом/);
});

test("созревший ряд: наша оценка ближе к истине — вердикт называет это прямо", () => {
  const db = db0();
  for (let i = 0; i < 40; i++) row(db, i, i % 2 ? 0.9 : 0.1, 0.5, (i % 2 ? 1 : 0) as 0 | 1);
  const c = buildHonestCalibration(db);
  assert.equal(c.n, 40);
  assert.equal(c.verdict, "МЫ ЛУЧШЕ ЦЕНЫ");
  assert.ok((c.ourBrier as number) < (c.mktBrier as number));
  assert.ok(c.byDisagreement.length > 0, "разрез по величине спора с ценой обязателен");
});

test("обратный случай не смягчается: цена лучше — так и печатается", () => {
  const db = db0();
  for (let i = 0; i < 40; i++) row(db, i, i % 2 ? 0.1 : 0.9, i % 2 ? 0.9 : 0.1, (i % 2 ? 1 : 0) as 0 | 1);
  assert.equal(buildHonestCalibration(db).verdict, "ЦЕНА ЛУЧШЕ НАС");
});

test("предматч и лайв не сливаются в одну цифру — это разные вопросы", () => {
  const db = db0();
  for (let i = 0; i < 35; i++) row(db, i, 0.8, 0.5, 1);
  for (let i = 100; i < 110; i++) row(db, i, 0.2, 0.5, 1, { stage: "live" });
  assert.equal(buildHonestCalibration(db, "prematch").n, 35);
  assert.equal(buildHonestCalibration(db, "live").n, 10);
  assert.equal(buildHonestCalibration(db, "all").n, 45);
});

test("доля мид-фолбэка печатается: такие наблюдения слабее по построению (#120)", () => {
  const db = db0();
  for (let i = 0; i < 30; i++) row(db, i, 0.6, 0.5, 1, { src: i < 9 ? "mid_fallback" : "executable" });
  assert.equal(buildHonestCalibration(db).midFallbackShare, 30);
});

test("строка еженедельника отличает пустой ряд от плохого результата", () => {
  assert.match(honestCalibrationLine(buildHonestCalibration(db0())), /n=0\/30 — ряд пуст/);
});
