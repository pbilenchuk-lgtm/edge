// ============================================================
// EDGE LAB — ПЕРЕ-СНИМОК ПОТРЕБИТЕЛЕЙ МЕТОК: ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ
//
// Не «функция вернула объект», а четыре обещания, данные владельцу:
//   1. «ДО» СЧИТАЕТСЯ ТЕМ ЖЕ КОДОМ. Подменяется ВХОД (набор записей), а не формула. Вторая реализация
//      метрики разошлась бы с первой в тот день, когда одну поправили, — именной класс проекта.
//   2. БАЗА НЕ ПИШЕТСЯ. Отчёт read-only: метки после прохода обязаны остаться ровно теми, что были.
//   3. КАЖДЫЙ СДВИГ ПОДПИСАН. У ячейки есть число переворотов В ЕЁ КОГОРТЕ — иначе сдвиг приходится
//      объяснять догадкой.
//   4. ТЕННИС НЕ ПОЛУЧАЕТ ЦИФРУ. Он получает пометку: цифра означала бы проверку, которой не было.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { relabelPiecesByMarket, preMigrationStatus } from "../src/lib/pieceRelabel.js";
import { betRecords } from "../src/lib/profileAnalytics.js";
import {
  buildLabelEpochSnapshot, preMigrationRecords, labelEpochLine, TENNIS_LABEL_TAG,
} from "../src/lib/labelEpochSnapshot.js";

const KO = "2026-07-20T18:00:00.000Z";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 1000, external_league: "usa.1", created_at: KO });
  for (const id of ["prematch_value", "overreaction"]) {
    R.insertStrategy(db, { id, sport_id: "football", name: id, tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: KO, prompt: "p", prompt_live: null, params: {} } as never);
  }
  return db;
}

function finished(db: ReturnType<typeof seed>, id: string, sh: number, sa: number) {
  R.insertMatch(db, {
    id, competition_id: "c1", home: "H" + id, away: "A" + id, state: "finished", lineup_out: true,
    kickoff_at: KO, minute: null, score_home: sh, score_away: sa, final_score: `${sh}:${sa}`,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id,
  } as never);
}

/** Кусок с меткой по ЗНАКУ P&L — то, что миграция и чинит. */
function piece(db: ReturnType<typeof seed>, id: string, matchId: string, label: string, payout: number, sid = "prematch_value") {
  const profit = payout > 100;
  R.insertBet(db, {
    id, match_id: matchId, strategy_id: sid, risk_profile_id: "medium", market_label: label,
    status: profit ? "settled_won" : "settled_lost", proposed_price: 50, entry_price: 50, current_price: 60,
    closing_price: 60, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "предматч",
    result: profit ? "won" : "lost", payout, created_at: KO,
  } as never);
  db.prepare(`UPDATE bets SET settled_by='early' WHERE id=?`).run(id);
}

test("«до» считается ТЕМ ЖЕ кодом на подменённом ВХОДЕ, а не второй формулой", () => {
  const db = seed();
  finished(db, "m1", 0, 0); piece(db, "b1", "m1", "Over 1.5", 140);   // рынок проиграл, кусок в плюс → переворот
  finished(db, "m2", 3, 0); piece(db, "b2", "m2", "Over 1.5", 140);   // согласен, не переворот
  relabelPiecesByMarket(db);

  const now = betRecords(db);
  const pre = preMigrationRecords(db, now);
  // Подменён ровно один вход и ровно в тех строках, что перевернула миграция.
  const was = preMigrationStatus(db);
  assert.equal(was.size, 1);
  const diff = now.filter((r, i) => r.status !== pre[i].status);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].id, "b1");
  // Всё остальное — тот же объект по значению: подмена не «пересобирает» записи.
  assert.deepEqual(now.filter((r) => r.id !== "b1"), pre.filter((r) => r.id !== "b1"));
});

test("проход НИЧЕГО не пишет в базу — отчёт остаётся read-only", () => {
  const db = seed();
  finished(db, "m1", 0, 0); piece(db, "b1", "m1", "Over 1.5", 140);
  relabelPiecesByMarket(db);
  const snapshot = () => db.prepare(`SELECT id, status, result, market_labeled, piece_pnl FROM bets ORDER BY id`).all();

  const before = JSON.stringify(snapshot());
  buildLabelEpochSnapshot(db);
  assert.equal(JSON.stringify(snapshot()), before, "ни одна строка не изменилась");
});

test("каждая ячейка несёт ЧИСЛО ПЕРЕВОРОТОВ В СВОЕЙ КОГОРТЕ — сдвиг подписан, а не угадан", () => {
  const db = seed();
  finished(db, "m1", 0, 0); piece(db, "b1", "m1", "Over 1.5", 140);
  finished(db, "m2", 3, 0); piece(db, "b2", "m2", "Over 1.5", 60);    // рынок выиграл, кусок в минус → переворот
  relabelPiecesByMarket(db);

  const s = buildLabelEpochSnapshot(db);
  assert.equal(s.flipsTotal, 2);
  const gold = s.cells.find((c) => c.cell === "golden:prematch_value×totals")!;
  assert.ok(gold, "золотая ячейка читается ПЕРВОЙ по ратифицированному порядку");
  assert.equal(gold.order, 1);
  assert.equal(gold.flippedInCohort, 2, "подпись миграции на самой ячейке");
  assert.ok(s.cells.every((c) => c.note.length > 20), "у каждой ячейки читаемое пояснение");
  // Порядок чтения — ратифицированный, а не случайный.
  assert.deepEqual(s.cells.map((c) => c.order), [...s.cells.map((c) => c.order)].sort((a, b) => a - b));
});

test("ценовая сторона помечена как НЕЗАВИСЯЩАЯ от меток — отсутствие сдвига это факт, а не недосмотр", () => {
  const db = seed();
  finished(db, "m1", 0, 0); piece(db, "b1", "m1", "Over 1.5", 140);
  relabelPiecesByMarket(db);

  const price = buildLabelEpochSnapshot(db).cells.find((c) => c.cell === "exit_honesty:price_side")!;
  assert.equal(price.before, null);
  assert.equal(price.after, null);
  assert.match(price.note, /НЕ ЗАВИСЯТ ПО ПОСТРОЕНИЮ/);
  assert.match(price.note, /искать его не надо/);
});

test("теннис получает ПОМЕТКУ, а не цифру — цифра означала бы проверку, которой не было", () => {
  const db = seed();
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "t1", sport_id: "tennis", name: "ATP", budget: 500, external_league: null, created_at: KO });
  R.insertStrategy(db, { id: "tennis_pmv", sport_id: "tennis", name: "PMV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: KO, prompt: "p", prompt_live: null, params: {} } as never);
  R.insertMatch(db, { id: "tm", competition_id: "t1", home: "P1", away: "P2", state: "finished", lineup_out: true, kickoff_at: KO, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "tm" } as never);
  piece(db, "tb", "tm", "P1", 140, "tennis_pmv");
  finished(db, "m1", 0, 0); piece(db, "b1", "m1", "Over 1.5", 140);
  relabelPiecesByMarket(db);

  const s = buildLabelEpochSnapshot(db);
  assert.equal(s.tennis.tag, TENNIS_LABEL_TAG);
  assert.ok(s.tennis.strategies.includes("tennis_pmv"));
  assert.match(s.tennis.note, /ЗНАКОМ P&L, выдающим себя за точность прогноза/);
  assert.match(s.tennis.note, /потеряны для верификации навсегда/);
  // Ни одна ЯЧЕЙКА не относится к теннису: он в проход не входит.
  assert.ok(s.cells.every((c) => !/tennis/i.test(c.cell)));
  assert.match(labelEpochLine(s), new RegExp(TENNIS_LABEL_TAG));
});

test("нет переворотов — «до» тождественно «после», и проход это говорит, а не молчит", () => {
  const db = seed();
  finished(db, "m1", 3, 0); piece(db, "b1", "m1", "Over 1.5", 140);   // метка и так верна
  relabelPiecesByMarket(db);

  const s = buildLabelEpochSnapshot(db);
  assert.equal(s.flipsTotal, 0);
  const gold = s.cells.find((c) => c.cell === "golden:prematch_value×totals")!;
  assert.equal(gold.delta, 0);
  assert.equal(gold.flippedInCohort, 0);
  assert.match(s.note, /0 переворотов/);
});
