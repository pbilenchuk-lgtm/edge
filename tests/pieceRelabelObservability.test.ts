// ============================================================
// EDGE LAB — САМОЕ ВАЖНОЕ ЧТЕНИЕ ПРОЕКТА НЕ ИМЕЕТ ПРАВА ОПИРАТЬСЯ НА ЧЬЮ-ТО ПАМЯТЬ
//
// 66% решённых ставок (618 из 932 на 02.08) несут метку, поставленную по ЗНАКУ P&L куска, а не по исходу
// РЫНКА. Её едят win-rate, Brier и калибровка — то есть торговый результат месяцами выдавал себя за
// точность прогноза. Миграция pieceRelabel это чинит, и её «до/после» — главное чтение проекта.
//
// Ровно поэтому здесь держатся три свойства наблюдаемости, а не сама перемаркировка (она покрыта batch12):
//
//   1. «ДО» ИЗМЕРЕНО, А НЕ ВСПОМНЕНО. Снимок распределения меток и книги пишется ДО первой записи и ровно
//      один раз. Старая метка была детерминированной функцией знака P&L, то есть «до» формально
//      восстановимо задним числом — но восстановимость не заменяет измеримость в моменте.
//
//   2. СЧЁТЧИК ГОВОРИТ ВСЕГДА. Прежний лог печатался только при `flipped || unverifiable`: «перевёрнуто 0»
//      было НЕМЫМ, и отличить «отработало, всё было верно» от «не запускалось» снаружи было нельзя. Тот же
//      немой ноль, что счётчик глубины 30.07.
//
//   3. ДВУСТОРОННИЙ КРИТЕРИЙ, ЗАПИСАННЫЙ ДО ЧИСЕЛ. win↓ при Δкниги=0 — снятие искажения, метка врала,
//      деньги настоящие. win↓ ВМЕСТЕ с Δкниги≠0 — баг миграции, потому что payout она не трогает по
//      определению. Отчёт обязан выдавать эту сторону сам, а не оставлять её интерпретации.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { relabelPiecesByMarket, labelDistribution, PIECE_RELABEL_BEFORE_KEY, PIECE_RELABEL_LAST_KEY } from "../src/lib/pieceRelabel.js";
import { betRecords } from "../src/lib/profileAnalytics.js";
import { betsCsv } from "../src/lib/profileExport.js";

const KO = "2026-07-20T18:00:00.000Z";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 1000, external_league: "usa.1", created_at: KO });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: KO, prompt: "p", prompt_live: null, params: {} } as never);
  return db;
}

function finished(db: ReturnType<typeof seed>, id: string, sh: number, sa: number) {
  R.insertMatch(db, {
    id, competition_id: "c1", home: "H" + id, away: "A" + id, state: "finished", lineup_out: true,
    kickoff_at: KO, minute: null, score_home: sh, score_away: sa, final_score: `${sh}:${sa}`,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id,
  } as never);
}

/** Кусок, закрытый досрочно: метка поставлена по ЗНАКУ P&L — именно это миграция и чинит. */
function piece(db: ReturnType<typeof seed>, id: string, matchId: string, label: string, stake: number, payout: number) {
  const profit = payout > stake;
  R.insertBet(db, {
    id, match_id: matchId, strategy_id: "prematch_value", risk_profile_id: "medium", market_label: label,
    status: profit ? "settled_won" : "settled_lost", proposed_price: 50, entry_price: 50, current_price: 60,
    closing_price: 60, ai_prob: 0.6, stake, rationale: "r", entered_minute: "60'",
    result: profit ? "won" : "lost", payout, created_at: KO,
  } as never);
  db.prepare(`UPDATE bets SET settled_by='early' WHERE id=?`).run(id);
}

// ── 1. «ДО» ИЗМЕРЕНО ────────────────────────────────────────────────────────────────────────────

test("снимок «до» пишется ДО первой записи и переживает миграцию", () => {
  const db = seed();
  finished(db, "m1", 0, 0);                       // Over 1.5 проиграл…
  piece(db, "b1", "m1", "Over 1.5", 100, 140);    // …но кусок продан в плюс → метка won по знаку P&L

  assert.equal(labelDistribution(db).winPct, 100, "до миграции: метка врёт в нашу пользу");
  const r = relabelPiecesByMarket(db);

  const before = JSON.parse(R.metaGet(db, PIECE_RELABEL_BEFORE_KEY)!);
  assert.equal(before.labels.winPct, 100, "«до» зафиксировано ДО записи, а не после");
  assert.equal(before.labels.won, 1);
  assert.equal(labelDistribution(db).winPct, 0, "после: метка по исходу РЫНКА");
  assert.equal(r.flipped, 1);
});

test("повторный проход НЕ переписывает «до» — иначе снимок сползал бы за каждым тиком", () => {
  const db = seed();
  finished(db, "m1", 0, 0); piece(db, "b1", "m1", "Over 1.5", 100, 140);
  relabelPiecesByMarket(db);
  const snap1 = R.metaGet(db, PIECE_RELABEL_BEFORE_KEY);

  finished(db, "m2", 0, 0); piece(db, "b2", "m2", "Over 1.5", 100, 140);
  relabelPiecesByMarket(db);
  assert.equal(R.metaGet(db, PIECE_RELABEL_BEFORE_KEY), snap1, "«до» — это ОДИН момент, а не скользящее окно");
});

// ── 2. СЧЁТЧИК ГОВОРИТ ВСЕГДА ───────────────────────────────────────────────────────────────────

test("нулевой проход отчитывается ТАКЖЕ громко — немого нуля больше нет", () => {
  const db = seed();
  const r = relabelPiecesByMarket(db);
  assert.equal(r.scanned, 0);
  assert.equal(r.flipped, 0);
  assert.match(r.note, /просмотрено 0/);
  assert.match(r.note, /ПЕРЕВЁРНУТО 0/);
  assert.match(r.note, /Δ книги = \+?\$0\.00/, "ноль обязан быть НАПЕЧАТАН, а не подразумеваться");
  assert.ok(R.metaGet(db, PIECE_RELABEL_LAST_KEY), "и сохранён — «не запускалось» отличимо от «отработало вхолостую»");
});

// ── 3. ДВУСТОРОННИЙ КРИТЕРИЙ ────────────────────────────────────────────────────────────────────

test("сторона 1: метка сдвинулась, деньги нет → Δ книги ровно $0.00, и это НАЗВАНО снятием искажения", () => {
  const db = seed();
  finished(db, "m1", 0, 0); piece(db, "b1", "m1", "Over 1.5", 100, 140);
  finished(db, "m2", 3, 1); piece(db, "b2", "m2", "Over 1.5", 100, 60);   // рынок выигран, кусок продан в минус

  const r = relabelPiecesByMarket(db);
  assert.equal(r.bookDeltaUsd, 0);
  assert.deepEqual(r.bookAfter, r.bookBefore, "payout не входит в UPDATE — и это подтверждено измерением");
  assert.match(r.note, /СНЯТИЕ ИСКАЖЕНИЯ, а не регресс/);
  assert.equal(r.flipped, 2, "обе метки были неверны — в обе стороны");
  assert.equal(r.labelsBefore.winPct, 50);
  assert.equal(r.labelsAfter.winPct, 50, "здесь win не сдвинулся — сдвинулось ЧТО именно засчитано");
});

test("судьба куска сохранена отдельно: piece_pnl>0 при метке lost — обе цифры правдивы", () => {
  const db = seed();
  finished(db, "m1", 0, 0); piece(db, "b1", "m1", "Over 1.5", 100, 140);
  relabelPiecesByMarket(db);
  const b = db.prepare(`SELECT status, result, piece_pnl p, payout, market_labeled ml FROM bets WHERE id='b1'`).get() as any;
  assert.equal(b.status, "settled_lost", "рынок проигран");
  assert.equal(b.p, 40, "а кусок продан в плюс — Cusco-класс");
  assert.equal(b.payout, 140, "деньги не тронуты");
  assert.equal(b.ml, 1);
});

// ── ЭКСПОРТ: «ДО/ПОСЛЕ» ЧИТАЕТСЯ ИЗ ДАННЫХ ──────────────────────────────────────────────────────

test("market_labeled и piece_pnl доезжают до записи среза и до CSV", () => {
  const db = seed();
  finished(db, "m1", 0, 0); piece(db, "b1", "m1", "Over 1.5", 100, 140);

  const pre = betRecords(db).find((x) => x.id === "b1")!;
  assert.equal(pre.marketLabeled, 0, "до миграции метка НЕ сверена с рынком — и это видно снаружи");
  assert.equal(pre.piecePnl, null);

  relabelPiecesByMarket(db);
  const post = betRecords(db).find((x) => x.id === "b1")!;
  assert.equal(post.marketLabeled, 1);
  assert.equal(post.piecePnl, 40);

  const csv = betsCsv(db);
  assert.match(csv.split("\n")[0], /piece_pnl/);
  assert.match(csv.split("\n")[0], /market_labeled/);
});

test("непроверяемый ярлык помечается 2, а не молчит и не выдаёт ложный void", () => {
  const db = seed();
  finished(db, "m1", 1, 1);
  piece(db, "b1", "m1", "Игрок X забьёт первым", 100, 140);
  const r = relabelPiecesByMarket(db);
  assert.equal(r.unverifiable, 1);
  assert.equal(r.relabeled, 0);
  const b = db.prepare(`SELECT market_labeled ml, status FROM bets WHERE id='b1'`).get() as any;
  assert.equal(b.ml, 2, "потребители калибровки обязаны отбрасывать такую строку, как settle_suspect");
  assert.equal(b.status, "settled_won", "старая метка НЕ трогается — гадать хуже, чем признать непроверяемость");
});
