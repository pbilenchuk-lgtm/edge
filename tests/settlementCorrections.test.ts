// ============================================================
// КОРРЕКТИРУЮЩИЕ ПРОВОДКИ РАСЧЁТА — И ТРИ ПРАВИЛА, БЕЗ КОТОРЫХ ЭТО ВПРЫСК ФАНТОМА
//
// Замер void-книги: из 11 матчей 7 биржа разрешила БИНАРНО (мы вернули ставку вместо выигрыша/проигрыша),
// а 4 настоящих void недоплачены — Polymarket гасит оба токена по 0.5/акцию, мы книжили возврат.
// Ошибка формулы РАВНА НУЛЮ на входе 50¢ — то есть была невидима ровно там, где чаще всего срабатывала.
//
// Здесь держатся: история не переписывается, провенанс обязателен, план ≠ применение.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { planCorrections, applyCorrections, buildCorrectionsLedger, splitPayout, binaryPayout, ARTIFACT_STAKE_USD } from "../src/lib/settlementCorrections.js";

const NOW = "2026-08-09T00:00:00.000Z";
function db0() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: NOW } as never);
  R.insertStrategy(db, { id: "sv", sport_id: "tennis", name: "SV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: NOW, prompt: "p", prompt_live: null, params: {} } as never);
  R.insertMatch(db, { id: "m1", competition_id: "atp", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: NOW,
    minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as never);
  return db;
}
const voidBet = (db: ReturnType<typeof db0>, id: string, stake: number, entry: number) =>
  R.insertBet(db, { id, match_id: "m1", strategy_id: "sv", risk_profile_id: "medium", market_label: "X",
    status: "settled_void", proposed_price: entry, entry_price: entry, current_price: entry, closing_price: null,
    ai_prob: 0.5, stake, rationale: "r", entered_minute: null, result: null, payout: stake, created_at: NOW } as never);
const ev = (betId: string, o: Partial<{ binary: boolean; ourSideWon: boolean }> = {}) =>
  ({ betId, binary: o.binary ?? false, ...(o.ourSideWon !== undefined ? { ourSideWon: o.ourSideWon } : {}),
     evidence: "Gamma: outcomePrices ['0.5','0.5'], Completed Match = No", evidenceSrc: "gamma_outcome_prices" });

test("ФОРМУЛА: void гасит 0.5/акцию — ошибка РОВНО НОЛЬ на 50¢, отсюда её невидимость", () => {
  assert.equal(splitPayout(100, 50), 100, "на 50¢ старая и новая формулы совпадают");
  assert.ok(Math.abs(splitPayout(100, 30) - 166.67) < 0.01, "вход 30¢ → +67%");
  assert.ok(Math.abs(splitPayout(100, 80) - 62.5) < 0.01, "вход 80¢ → −37.5%");
  assert.equal(binaryPayout(100, 40, true), 250);
  assert.equal(binaryPayout(100, 40, false), 0);
});

test("ПРОВЕНАНС ОБЯЗАТЕЛЕН: строка без улики отказана ПОИМЁННО, а не пропущена молча", () => {
  const db = db0(); voidBet(db, "b1", 100, 37);
  const plan = planCorrections(db, [], NOW);
  assert.equal(plan.planned.length, 0);
  assert.deepEqual(plan.refused, [{ betId: "b1", reason: "нет улики резолюции — правка без провенанса не пишется" }]);
});

test("бинарная резолюция без НАЗВАННОЙ стороны — отказ: угадывать сторону нельзя", () => {
  const db = db0(); voidBet(db, "b1", 100, 40);
  const plan = planCorrections(db, [ev("b1", { binary: true })], NOW);
  assert.equal(plan.planned.length, 0);
  assert.match(plan.refused[0]!.reason, /сторона НЕ названа/);
});

test("АРТЕФАКТЫ ПОРЧИ САЙЗИНГА исключены явно — фантом не узаконивается «по факту биржи»", () => {
  const db = db0(); voidBet(db, "big", 28291, 39.6);
  const plan = planCorrections(db, [ev("big", { binary: true, ourSideWon: true })], NOW);
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.totals.excludedArtifacts, 1);
  assert.match(plan.refused[0]!.reason, /артефакт порчи сайзинга/);
  assert.ok(ARTIFACT_STAKE_USD < 28291);
});

test("вход ровно на 50¢ правки не порождает — пустая проводка засоряла бы леджер", () => {
  const db = db0(); voidBet(db, "b1", 100, 50);
  const plan = planCorrections(db, [ev("b1")], NOW);
  assert.equal(plan.planned.length, 0);
  assert.match(plan.refused[0]!.reason, /старая и новая формулы совпадают/);
});

test("PLAN ≠ APPLY: сухой прогон денег не двигает и в леджер не пишет", () => {
  const db = db0(); voidBet(db, "b1", 100, 37);
  const plan = planCorrections(db, [ev("b1")], NOW);
  assert.equal(plan.planned.length, 1);
  assert.ok(Math.abs(plan.totals.deltaUsd - 35.14) < 0.02, `+$${plan.totals.deltaUsd}`);
  assert.match(plan.note, /деньги НЕ двигались/);
  assert.equal(buildCorrectionsLedger(db, NOW).rows, 0, "леджер пуст до применения");
});

test("ИСТОРИЯ НЕ ПЕРЕПИСЫВАЕТСЯ: применение не трогает строку ставки", () => {
  const db = db0(); voidBet(db, "b1", 100, 37);
  const plan = planCorrections(db, [ev("b1")], NOW);
  assert.deepEqual(applyCorrections(db, plan, NOW), { written: 1, skipped: 0 });
  const bet = R.getBet(db, "b1")!;
  assert.equal(bet.status, "settled_void", "статус исходной строки НЕ изменён");
  assert.equal(bet.payout, 100, "выплата исходной строки НЕ изменена");
  const led = buildCorrectionsLedger(db, NOW);
  assert.equal(led.rows, 1);
  assert.match(led.note, /посчитали честно тогда.*поправили потом/);
  assert.match(led.entries[0]!.evidence, /outcomePrices/);
});

test("повтор применения не удваивает деньги", () => {
  const db = db0(); voidBet(db, "b1", 100, 37);
  const plan = planCorrections(db, [ev("b1")], NOW);
  applyCorrections(db, plan, NOW);
  assert.deepEqual(applyCorrections(db, plan, NOW), { written: 0, skipped: 1 });
  assert.equal(buildCorrectionsLedger(db, NOW).rows, 1);
});

test("ложный void: проигравшая сторона получает НОЛЬ, и это отрицательная дельта", () => {
  const db = db0(); voidBet(db, "b1", 100, 40);
  const plan = planCorrections(db, [ev("b1", { binary: true, ourSideWon: false })], NOW);
  const p = plan.planned[0]!;
  assert.equal(p.newStatus, "settled_lost");
  assert.equal(p.newPayout, 0);
  assert.equal(p.deltaUsd, -100, "возврат ставки был НЕЗАСЛУЖЕННЫМ — книга это признаёт");
});
