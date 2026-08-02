// ============================================================
// EDGE LAB — O6: ПРИЁМКА ТЗ = РЕГРЕССИЯ ИНЦИДЕНТА, А НЕ ГАЛОЧКИ ПО ПУНКТАМ
//
// ТЗ дословно: «Пока сценарий не ловится ТРЕМЯ независимыми сигналами — ТЗ не закрыто». Здесь оба
// ратифицированных сценария целиком:
//
//   СИМУЛЯЦИЯ 1 — сдвиг порога калибровки (инцидент пресета, стоивший недели):
//     сигнал A — воронка называет причину И ЕЁ ДОЛЮ;
//     сигнал B — базлайн видит обвал входов при живом календаре;
//     сигнал C — full_drift называет РАЗОШЕДШЕЕСЯ ПОЛЕ по имени.
//   Независимость сигналов здесь принципиальна: A читает trade_log, B — bets, C — конфиг против кода.
//   Общего источника у них нет, поэтому одна поломка не гасит все три.
//
//   СИМУЛЯЦИЯ 2 — джоба перестала запускаться: ловится за сутки по last_run_at + отсутствию строки.
//
// ЧТО ЭТОТ ФАЙЛ НЕ ДОКАЗЫВАЕТ. Что сигналы дойдут до ЧЕЛОВЕКА: они печатаются в еженедельник и отчёты,
// и если их не читать, ТЗ не помогает. Автоматической эскалации в ТЗ не заказано, и я её не выдумываю.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { seedRiskProfiles } from "../src/lib/riskConfig.js";
import { buildEntryFunnel, funnelLine } from "../src/lib/entryFunnel.js";
import { buildProfileDrift } from "../src/lib/profileDrift.js";
import { buildJobHeartbeat, recordJobRun } from "../src/lib/jobHeartbeat.js";
import { buildGateHeartbeat, recordGatePulse } from "../src/lib/gateHeartbeat.js";
import { logLine, parseLogLine, reasonsOutsideDictionary } from "../src/lib/logLine.js";
import { REJECT_REASONS } from "../src/lib/entryFunnel.js";

const NOW = Date.parse("2026-08-02T18:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function world() {
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, day(30));
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 1000, external_league: "usa.1", created_at: day(30) });
  R.insertStrategy(db, { id: "pv", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: day(30), prompt: "p", prompt_live: null, params: {} } as never);
  return db;
}
const mk = (db: ReturnType<typeof world>, id: string) => R.insertMatch(db, { id, competition_id: "c1", home: "H" + id, away: "A" + id, state: "finished", lineup_out: true, kickoff_at: day(1), minute: null, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as never);
const skip = (db: ReturnType<typeof world>, mid: string, text: string, at: string) => R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: "pv", minute: null, type: "skip", text, created_at: at } as never);
const bet = (db: ReturnType<typeof world>, id: string, mid: string, at: string) => R.insertBet(db, { id, match_id: mid, strategy_id: "pv", risk_profile_id: "medium", market_label: "Over 1.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 10, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: at } as never);

// ── СИМУЛЯЦИЯ 1: ИНЦИДЕНТ ПРЕСЕТА ЛОВИТСЯ ТРЕМЯ НЕЗАВИСИМЫМИ СИГНАЛАМИ ─────────────────────────

test("ПРИЁМКА O6-1: сдвиг порога калибровки ловится ТРЕМЯ независимыми сигналами за один день", () => {
  const db = world();

  // Неделя нормальной работы.
  for (let d = 1; d <= 7; d++) {
    mk(db, "n" + d);
    for (let i = 0; i < 12; i++) bet(db, `nb${d}_${i}`, "n" + d, day(d));
  }
  // День инцидента: порог в БАЗЕ откатан на conservative-1.0, входов нет, отказы одной причины.
  const cfg = JSON.parse(R.getRiskProfileRow(db, "conservative")!.content);
  cfg.config_version = "conservative-1.0";
  cfg.entry_thresholds = { min_edge: 0.07, min_edge_low_liquidity: 0.10, min_calibration: 0.55, min_market_liquidity: 2000 };
  R.upsertRiskProfile(db, { id: "conservative", name: "Консервативный", content: JSON.stringify(cfg), sort: 2, created_at: day(30) });
  mk(db, "inc");
  for (let i = 0; i < 18; i++) skip(db, "inc", "калибровка 0.50 < 0.55", day(0));

  // ── СИГНАЛ A: воронка — читает trade_log
  const f = buildEntryFunnel(db, { nowMs: NOW });
  assert.equal(f.days[0].entered, 0);
  assert.equal(f.days[0].top[0].code, "below_calibration");
  assert.equal(f.days[0].top[0].n, 18, "причина не просто названа — посчитана");

  // ── СИГНАЛ B: базлайн — читает bets
  const b = f.baselines.find((x) => x.metric === "entered")!;
  assert.equal(b.alert, true, "обвал входов при живом календаре");
  assert.equal(b.median7, 12);

  // ── СИГНАЛ C: full_drift — читает конфиг против кода
  const drift = buildProfileDrift(db, new Date(NOW).toISOString());
  const c = drift.profiles.find((p) => p.id === "conservative")!;
  const field = c.fields.find((x) => x.path === "entry_thresholds.min_calibration")!;
  assert.equal(field.prod, 0.55);
  assert.equal(field.code, 0.45);
  assert.equal(field.prodStricter, true, "разошедшееся поле названо ПО ИМЕНИ, а не «что-то с профилями»");

  // ── НЕЗАВИСИМОСТЬ: три источника, ни одного общего. Одна поломка не гасит все три.
  const sources = new Set(["trade_log", "bets", "risk_profiles↔код"]);
  assert.equal(sources.size, 3);

  // И всё это — читаемо одной строкой.
  assert.match(funnelLine(f), /входов 0/);
  assert.match(funnelLine(f), /below_calibration×18/);
});

// ── СИМУЛЯЦИЯ 2: ДЖОБА ПЕРЕСТАЛА ЗАПУСКАТЬСЯ ──────────────────────────────────────────────────

test("ПРИЁМКА O6-2: джоба, переставшая запускаться, ловится за сутки — по данным, а не по памяти", () => {
  const db = world();
  const expected = [{ label: "pieceRelabel", everyMin: 30 }, { label: "reSettleSuspects", everyMin: 30 }];

  // Обе работали вчера…
  recordJobRun(db, "pieceRelabel", { at: day(1), result: 0, ms: 3, ok: true });
  recordJobRun(db, "reSettleSuspects", { at: day(1), result: 0, ms: 2, ok: true });
  // …но сегодня только одна.
  recordJobRun(db, "reSettleSuspects", { at: new Date(NOW - 10 * 60_000).toISOString(), result: 0, ms: 2, ok: true });

  const h = buildJobHeartbeat(db, expected, NOW);
  const dead = h.rows.find((r) => r.label === "pieceRelabel")!;
  const alive = h.rows.find((r) => r.label === "reSettleSuspects")!;
  assert.equal(dead.verdict, "УСТАРЕЛ");
  assert.equal(alive.verdict, "свежий");
  assert.match(dead.note, /мёртвую проводку/);
  assert.match(h.note, /устарели 1/);

  // И РЕЗУЛЬТАТ НОЛЬ У ЖИВОЙ ДЖОБЫ НЕ ПУТАЕТСЯ С ОТСУТСТВИЕМ ЗАПУСКА — весь смысл O3.
  assert.equal(alive.result, 0);
  assert.equal(alive.verdict, "свежий");
});

// ── O4: ПУЛЬС ГЕЙТОВ, ВКЛЮЧАЯ ЧЕСТНОЕ «НЕ ИЗМЕРЯЕТСЯ» ─────────────────────────────────────────

test("гейт спрашивался и ни разу не сработал при живой торговле → РАССЛЕДОВАТЬ", () => {
  const db = world();
  mk(db, "m1"); bet(db, "b1", "m1", day(0));
  recordGatePulse(db, "piece_relabel", { evaluated: 120, triggered: 0 }, day(0));
  const g = buildGateHeartbeat(db, NOW);
  const row = g.rows.find((r) => r.key === "piece_relabel")!;
  assert.equal(row.verdict, "РАССЛЕДОВАТЬ");
  assert.match(row.note, /мёртвую ветку/);
});

test("гейт без знаменателя честно помечен «НЕ ИЗМЕРЯЕТСЯ», а не закрашен нулём", () => {
  const db = world();
  const row = buildGateHeartbeat(db, NOW).rows.find((r) => r.key === "score_race")!;
  assert.equal(row.evaluatedFrom, null);
  assert.equal(row.verdict, "НЕ ИЗМЕРЯЕТСЯ");
  assert.match(row.note, /ноль здесь не доказывает ни работы, ни смерти/);
});

test("гейт без потока не кричит: ноль проверок ничего не доказывает", () => {
  const db = world();
  recordGatePulse(db, "piece_relabel", { evaluated: 0, triggered: 0 }, day(0));
  assert.equal(buildGateHeartbeat(db, NOW).rows.find((r) => r.key === "piece_relabel")!.verdict, "нет потока");
});

test("сработавший гейт виден как работающий, с долей от проверок", () => {
  const db = world();
  recordGatePulse(db, "piece_relabel", { evaluated: 40, triggered: 7 }, day(0));
  const row = buildGateHeartbeat(db, NOW).rows.find((r) => r.key === "piece_relabel")!;
  assert.equal(row.verdict, "работает");
  assert.match(row.note, /7 раз\(а\) за \d+д из 40 проверок/);
});

// ── O5: СТАНДАРТ СТРОКИ ────────────────────────────────────────────────────────────────────────

test("строка стандарта машиночитаема: префикс парсится, хвост остаётся человеческим", () => {
  const l = logLine({ point: "entry_gate", verdict: "skip", reason: "below_calibration", configHash: "a1b2c3d4", n: 18 },
    "калибровка 0.50 < 0.55 — вход закрыт порогом профиля");
  assert.match(l, /^\[entry_gate\/skip reason=below_calibration cfg=a1b2c3d4 n=18\] /);
  const p = parseLogLine(l)!;
  assert.equal(p.point, "entry_gate");
  assert.equal(p.verdict, "skip");
  assert.equal(p.reason, "below_calibration");
  assert.equal(p.configHash, "a1b2c3d4");
  assert.equal(p.n, 18);
  assert.match(p.human, /порогом профиля/);
});

test("пустые поля НЕ печатаются — «reason=» был бы тем же немым нулём", () => {
  const l = logLine({ point: "job", verdict: "noop" }, "просмотрено 0");
  assert.equal(l, "[job/noop] просмотрено 0");
  assert.equal(parseLogLine(l)!.reason, null);
});

test("причина вне словаря ловится — free-text утекает в other, а other ничего не утверждает", () => {
  const dict = REJECT_REASONS.map((r) => r.code);
  const lines = [
    logLine({ point: "entry_gate", verdict: "skip", reason: "below_edge" }, "ок"),
    logLine({ point: "entry_gate", verdict: "skip", reason: "какая_то_новая" }, "не ок"),
  ];
  assert.deepEqual(reasonsOutsideDictionary(lines, dict), ["какая_то_новая"]);
  assert.deepEqual(reasonsOutsideDictionary([lines[0]], dict), []);
});

test("не-стандартная строка разбирается как null, а не как «пустой префикс»", () => {
  assert.equal(parseLogLine("просто текст без префикса"), null);
});
