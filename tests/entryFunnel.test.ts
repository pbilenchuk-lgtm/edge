// ============================================================
// EDGE LAB — O2: ВОРОНКА ОТВЕЧАЕТ НА «ВХОДОВ НЕТ — ГДЕ ПРОБЛЕМА?»  [+ приёмочная симуляция инцидента]
//
// 29.07 воронка дала 0 входов при живом календаре, и поиск занял дни. Инцидент пресета выглядел так же:
// «анализ идёт, ставок нет» снаружи неотличимо от «сетап не совпал». Обе ситуации обязаны читаться одной
// строкой: «анализ N · входы 0 · причина: калибровка ниже порога (18 из 24)».
//
// Ключевой тест здесь — ПОСЛЕДНИЙ: полная симуляция инцидента пресета. Пока он не ловится, O2 не закрыт.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildEntryFunnel, funnelLine, REJECT_REASONS, FUNNEL_DROP_ALERT_PCT } from "../src/lib/entryFunnel.js";

const NOW = Date.parse("2026-08-02T18:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 1000, external_league: "usa.1", created_at: day(20) });
  R.insertStrategy(db, { id: "pv", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: day(20), prompt: "p", prompt_live: null, params: {} } as never);
  return db;
}
function match(db: ReturnType<typeof seed>, id: string) {
  R.insertMatch(db, { id, competition_id: "c1", home: "H" + id, away: "A" + id, state: "finished", lineup_out: true, kickoff_at: day(1), minute: null, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as never);
}
function skip(db: ReturnType<typeof seed>, mid: string, text: string, at: string, type = "skip") {
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: "pv", minute: null, type, text, created_at: at } as never);
}
function bet(db: ReturnType<typeof seed>, id: string, mid: string, at: string) {
  R.insertBet(db, { id, match_id: mid, strategy_id: "pv", risk_profile_id: "medium", market_label: "Over 1.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 10, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: at } as never);
}

test("словарь причин собран из того, что ПИШЕТ код, а не из человеческой прозы", () => {
  const cases: [string, string][] = [
    ["калибровка 0.50 < 0.55", "below_calibration"],
    ["edge 3.20% < порога 5.00% (тонкий рынок)", "below_edge"],
    ["Kelly-край по фактической цене ≤ 0", "kelly_nonpositive"],
    ["исчерпан кэп экспозиции на матч", "cap_match"],
    ["бюджет пары исчерпан", "budget_pair"],
    ["пропуск матча — стратег вернул 0 picks (полный пропуск)", "strategist_zero_picks"],
    ["dead_board_llm_saved: 12 из 12 рынков скрыто", "dead_board"],
    ["sizing_insanity: размер $900 > $500", "sizing_insanity"],
  ];
  for (const [text, code] of cases) {
    const hit = REJECT_REASONS.find((r) => r.test.test(text));
    assert.equal(hit?.code, code, text);
  }
});

test("«разобрано» считается по МАТЧАМ, а не по строкам — иначе отказы надували бы знаменатель", () => {
  const db = seed(); match(db, "m1");
  for (let i = 0; i < 20; i++) skip(db, "m1", "калибровка 0.50 < 0.55", day(0));
  const f = buildEntryFunnel(db, { nowMs: NOW });
  assert.equal(f.days[0].analysed, 1, "один матч с двадцатью отказами — это ОДИН разобранный матч");
  assert.equal(f.days[0].byReason.below_calibration, 20);
});

test("топ-3 причины дня — то, что заменяет дни поисков одной строкой", () => {
  const db = seed(); match(db, "m1"); match(db, "m2");
  for (let i = 0; i < 5; i++) skip(db, "m1", "калибровка 0.50 < 0.55", day(0));
  for (let i = 0; i < 3; i++) skip(db, "m2", "edge 3.00% < порога 5.00%", day(0));
  skip(db, "m2", "бюджет пары исчерпан", day(0));
  const t = buildEntryFunnel(db, { nowMs: NOW }).days[0];
  assert.deepEqual(t.top.map((x) => x.code), ["below_calibration", "below_edge", "budget_pair"]);
  assert.equal(t.top[0].n, 5);
});

// ── НЕВЯЗКА: словарь, отставший от кода, обязан кричать ─────────────────────────────────────────

test("отказ, которого словарь не знает, идёт в НЕВЯЗКУ с образцом, а не в корзину «прочее»", () => {
  const db = seed(); match(db, "m1");
  skip(db, "m1", "новая причина, которой словарь ещё не знает", day(0));
  const f = buildEntryFunnel(db, { nowMs: NOW });
  assert.equal(f.days[0].unattributed, 1);
  assert.match(f.days[0].unattributedSamples[0], /новая причина/);
  assert.ok(f.investigate.some((x) => /НЕВЯЗКА/.test(x)), "пробел словаря — сам по себе алерт");
  assert.match(funnelLine(f), /НЕВЯЗКА 1/);
});

test("известные причины невязку не создают — сторож, воющий на всё, перестаёт быть сторожем", () => {
  const db = seed(); match(db, "m1");
  skip(db, "m1", "калибровка 0.42 < 0.45", day(0));
  const f = buildEntryFunnel(db, { nowMs: NOW });
  assert.equal(f.days[0].unattributed, 0);
  assert.equal(f.investigate.length, 0);
});

// ── БАЗЛАЙНЫ ───────────────────────────────────────────────────────────────────────────────────

test("падение входов ≥60% при ЖИВОМ календаре заводит расследование", () => {
  const db = seed();
  for (let d = 1; d <= 7; d++) {           // база: по 10 входов в день
    match(db, "h" + d);
    for (let i = 0; i < 10; i++) bet(db, `b${d}_${i}`, "h" + d, day(d));
  }
  match(db, "today"); skip(db, "today", "калибровка 0.50 < 0.55", day(0));   // календарь ЖИВОЙ, входов 0
  const f = buildEntryFunnel(db, { nowMs: NOW });
  const b = f.baselines.find((x) => x.metric === "entered")!;
  assert.equal(b.today, 0);
  assert.equal(b.median7, 10);
  assert.equal(b.dropPct, 100);
  assert.equal(b.alert, true);
  assert.match(b.note, new RegExp(`${FUNNEL_DROP_ALERT_PCT}%`));
  assert.ok(f.investigate.some((x) => /entered/.test(x)));
});

test("ноль входов при МЁРТВОМ календаре — не алерт: выходной и деградация это разные факты", () => {
  const db = seed();
  for (let d = 1; d <= 7; d++) { match(db, "h" + d); for (let i = 0; i < 10; i++) bet(db, `b${d}_${i}`, "h" + d, day(d)); }
  // сегодня НИЧЕГО не разбиралось — матчей нет
  const f = buildEntryFunnel(db, { nowMs: NOW });
  const entered = f.baselines.find((x) => x.metric === "entered")!;
  assert.equal(entered.alert, false, "путать выходной с деградацией — значит приучить владельца игнорировать сигнал");
});

test("база — медиана ПРЕДЫДУЩИХ дней: сегодняшний провал не оправдывает сам себя", () => {
  const db = seed();
  for (let d = 1; d <= 7; d++) { match(db, "h" + d); for (let i = 0; i < 10; i++) bet(db, `b${d}_${i}`, "h" + d, day(d)); }
  match(db, "today"); skip(db, "today", "калибровка 0.50 < 0.55", day(0));
  assert.equal(buildEntryFunnel(db, { nowMs: NOW }).baselines.find((x) => x.metric === "entered")!.median7, 10);
});

// ── O6 (частично): ПРИЁМОЧНАЯ СИМУЛЯЦИЯ ИНЦИДЕНТА ПРЕСЕТА ──────────────────────────────────────
// «Пока сценарий не ловится — ТЗ не закрыто». Здесь проверяется ДВА из трёх независимых сигналов
// (воронка + базлайн); третий — full_drift — живёт в profileDrift и покрыт своим тестом.

test("ПРИЁМКА: сдвиг порога калибровки читается воронкой в тот же день, с причиной и числом", () => {
  const db = seed();
  // Неделя нормальной работы: 12 входов в день, отказов мало.
  for (let d = 1; d <= 7; d++) {
    match(db, "n" + d);
    for (let i = 0; i < 12; i++) bet(db, `nb${d}_${i}`, "n" + d, day(d));
    skip(db, "n" + d, "edge 4.00% < порога 5.00%", day(d));
  }
  // День инцидента: порог калибровки подскочил до 0.55 — входов НЕТ, отказы все одной причины.
  match(db, "inc");
  for (let i = 0; i < 24; i++) skip(db, "inc", `калибровка 0.5${i % 3} < 0.55`, day(0));

  const f = buildEntryFunnel(db, { nowMs: NOW });
  const t = f.days[0];

  // Сигнал 1 — воронка НАЗЫВАЕТ причину и её долю.
  assert.equal(t.entered, 0);
  assert.equal(t.top[0].code, "below_calibration");
  assert.equal(t.top[0].n, 24, "причина не просто названа — она посчитана");
  assert.match(t.top[0].what, /калибровка ниже порога/);

  // Сигнал 2 — базлайн заводит расследование, потому что календарь живой.
  const b = f.baselines.find((x) => x.metric === "entered")!;
  assert.equal(b.alert, true);
  assert.equal(b.median7, 12);

  // И всё это — ОДНОЙ строкой, которой не хватило в тот вторник.
  const line = funnelLine(f);
  assert.match(line, /входов 0/);
  assert.match(line, /below_calibration×24/);
  assert.match(line, /РАССЛЕДОВАТЬ/);
});
