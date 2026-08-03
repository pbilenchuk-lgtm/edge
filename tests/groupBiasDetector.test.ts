// ============================================================
// EDGE LAB — D3(а): ДЕТЕКТОР МЕРИТ, НО НЕ ВМЕШИВАЕТСЯ
//
// Здесь доказываются ровно те свойства, ради которых механизм разделили пополам:
//   1. ЕДИНИЦА — СИГНАЛЫ. Восемь записей одного матч×рынка это ОДНО испытание. Именно подмена этой
//      единицы трижды била по проекту и 02.08 едва не основала прод-механизм.
//   2. ИНТЕРВЕНЦИИ НЕТ В КОДЕ. Не выключена флагом — отсутствует. Модуль, умеющий вмешаться «на всякий
//      случай», рано или поздно вмешается.
//   3. ПОРОГ НЕ ДОБРАН — ВЕРДИКТА НЕТ. «Копим окно» и «нет базы» это ОТСУТСТВИЕ ЗАМЕРА, а не «всё в
//      порядке»: именно так немой ноль и заводится.
//   4. НАСТОЯЩИЙ СЛОМ ДЕТЕКТОР ЛОВИТ. Схлопывание глушит шум, но не сигнал.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  binomLowerTail, GROUP_BIAS_WINDOW_SIGNALS, GROUP_BIAS_P, GROUP_BIAS_MIN_BASE,
  buildGroupBiasDetector, groupBiasLine,
} from "../src/lib/groupBiasDetector.js";
import { pWithUnit } from "../src/lib/signals.js";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";

test("пороги ЗАФИКСИРОВАНЫ до включения — 30 сигналов, p<0.01, база ≥20", () => {
  assert.equal(GROUP_BIAS_WINDOW_SIGNALS, 30);
  assert.equal(GROUP_BIAS_P, 0.01);
  assert.equal(GROUP_BIAS_MIN_BASE, 20);
});

test("нижний хвост считает просадку, а не удачу", () => {
  assert.ok(binomLowerTail(5, 30, 0.657) < 0.001, "5 из 30 при базе 65.7% — глубокая просадка");
  assert.ok(binomLowerTail(20, 30, 0.657) > 0.05, "20 из 30 — в коридоре");
  assert.ok(binomLowerTail(30, 30, 0.657) > 0.999, "все выиграны — просадки нет по определению");
});

test("правило класса: p ВСЕГДА называет свою единицу", () => {
  assert.equal(pWithUnit(0.16, 9), "p=0.160 на 9 сигналах");
  assert.equal(pWithUnit(0.0033, 64, "записях"), "p=0.0033 на 64 записях");
  assert.match(pWithUnit(null, 0), /p не посчитан/);
  // Именно так выглядела ошибка 02.08: одно и то же событие, две единицы, два разных вывода.
  assert.notEqual(pWithUnit(0.16, 9), pWithUnit(0.0033, 64, "записях"));
});

function world() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "usa-mls", sport_id: "football", name: "MLS 2026", budget: 5000, external_league: "usa.1", created_at: "2026-06-01" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: "2026-06-01", prompt: "p", prompt_live: null, params: {} } as never);
  return db;
}
/** Один СИГНАЛ = один матч×рынок×стратегия×день. `legs` записей внутри — это ОДНО событие мира. */
function signal(db: ReturnType<typeof world>, i: number, won: boolean, legs = 1) {
  const mid = `m${i}`;
  // Время ДОЛЖНО строго расти: окно «последние 30 сигналов» сортируется по времени, и цикличная дата
  // (i % 28) перемешивала бы порядок — тест мерил бы не то окно, что задуман.
  const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  R.insertMatch(db, { id: mid, competition_id: "usa-mls", home: `H${i}`, away: `A${i}`, state: "finished", lineup_out: true, kickoff_at: `${day}T18:00:00Z`, minute: null, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as never);
  for (let l = 0; l < legs; l++) {
    R.insertBet(db, {
      id: `${mid}-${l}`, match_id: mid, strategy_id: "prematch_value", risk_profile_id: ["medium", "aggressive", "max", "conservative"][l % 4],
      market_label: "Under 2.5", status: won ? "settled_won" : "settled_lost", proposed_price: 50, entry_price: 50,
      current_price: 50, closing_price: 50, ai_prob: 0.6, stake: 10, rationale: "r", entered_minute: "предматч",
      result: won ? "won" : "lost", payout: won ? 20 : 0, created_at: `${day}T18:00:00Z`,
    } as never);
  }
}

test("ЕДИНИЦА — СИГНАЛЫ: восемь записей одного рынка не превращаются в восемь испытаний", () => {
  const db = world();
  for (let i = 0; i < 25; i++) signal(db, i, true, 4);          // 25 сигналов × 4 записи = 100 записей
  for (let i = 25; i < 55; i++) signal(db, i, i % 3 !== 0, 4);
  const r = buildGroupBiasDetector(db);
  const row = r.rows.find((x) => x.group === "MLS/LigaMX/CSL")!;
  assert.ok(row, "группа опознана");
  assert.equal(row.windowSignals, GROUP_BIAS_WINDOW_SIGNALS, "окно меряется в СИГНАЛАХ, а не в записях");
  assert.equal(row.baseSignals, 25, "база — тоже сигналы");
});

test("ИНТЕРВЕНЦИИ НЕТ: отчёт говорит это прямо, и в модуле нет ни одного пути к записи", async () => {
  const db = world();
  for (let i = 0; i < 60; i++) signal(db, i, i % 4 !== 0);
  const r = buildGroupBiasDetector(db);
  assert.match(r.intervention, /НЕ АРМИРОВАНА/);
  assert.match(groupBiasLine(r), /интервенция НЕ армирована/);
  // Структурная проверка: модуль не импортирует ничего, чем можно вмешаться.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/groupBiasDetector.ts", import.meta.url), "utf8");
  for (const forbidden of ["updateBet", "insertBet", "metaSet", "insertTradeLog", "UPDATE ", "INSERT "]) {
    assert.ok(!src.includes(forbidden), `модуль обязан быть read-only, найдено «${forbidden}»`);
  }
});

test("порог не добран — вердикта НЕТ, и это названо отсутствием замера", () => {
  const db = world();
  for (let i = 0; i < 10; i++) signal(db, i, true);
  const r = buildGroupBiasDetector(db);
  const row = r.rows.find((x) => x.group === "MLS/LigaMX/CSL")!;
  assert.equal(row.verdict, "нет базы");
  assert.equal(row.p, null, "p не выдумывается там, где базы нет");
  assert.match(row.note, /отсутствие замера, а не «всё в порядке»/);
});

test("НАСТОЯЩИЙ слом детектор ловит — схлопывание глушит шум, но не сигнал", () => {
  const db = world();
  for (let i = 0; i < 40; i++) signal(db, i, i % 10 !== 0, 3);   // база ~90% на 40 сигналах
  for (let i = 40; i < 70; i++) signal(db, i, i % 5 === 0, 3);   // окно: 6 из 30
  const r = buildGroupBiasDetector(db);
  const row = r.rows.find((x) => x.group === "MLS/LigaMX/CSL")!;
  assert.equal(row.verdict, "ПРОСАДКА ЗНАЧИМА");
  assert.ok(row.p != null && row.p < GROUP_BIAS_P);
  assert.match(row.note, /на \d+ сигналах/, "p напечатан С ЕДИНИЦЕЙ");
  assert.match(row.note, /ИЗМЕРЕНИЕ, не команда/);
  assert.equal(r.flagged.length, 1);
  assert.match(r.note, /режим НЕ включён/);
});
