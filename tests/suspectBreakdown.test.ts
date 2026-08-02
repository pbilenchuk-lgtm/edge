// ============================================================
// EDGE LAB — КАРАНТИН БОЛЬШЕ ВКЛЮЧЁННОЙ ВЫБОРКИ, И ЭТО НАДО РАЗЛОЖИТЬ, А НЕ РАССЛЕДОВАТЬ ЗАНОВО
//
// Пере-снимок гейта 02.08: 36 записей (13 сигналов) в вердиктной когорте против 53 исключённых как
// `settle_suspect`. Гейт не «копит медленно» — он копит из четверти потока.
//
// Раскладка отвечает ровно на три вопроса и НЕ заводит второй авторитет: решающий предикат общий с самим
// пере-сеттлом. Именно это здесь и держится тестом — потому что расхождение отчёта с конвейером мы уже
// один раз оплатили (CLV, «скрипт мимо кода»), и второй раз платить нечем.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildSuspectBreakdown, classifySuspect, bookTotals, CLASSIFY_VERSION } from "../src/lib/suspectBreakdown.js";
import { reSettleSuspectBets, isStateSuspect, suspectResolveOutcome, legGapMs } from "../src/lib/engine.js";

const KO = "2026-07-20T18:00:00.000Z";
const OPTS = { legGapMs: legGapMs(), isStateSuspect, resolveOutcome: suspectResolveOutcome };

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "uel", sport_id: "football", name: "UEL", budget: 1000, external_league: "uefa.europa", created_at: KO });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: KO, prompt: "p", prompt_live: null, params: {} } as never);
  return db;
}

function match(db: ReturnType<typeof seed>, id: string, o: { state?: string; sh?: number | null; sa?: number | null; ko?: string | null } = {}) {
  R.insertMatch(db, {
    id, competition_id: "uel", home: "H" + id, away: "A" + id, state: o.state ?? "finished", lineup_out: true,
    kickoff_at: o.ko === undefined ? KO : o.ko, minute: null, score_home: o.sh === undefined ? 2 : o.sh, score_away: o.sa === undefined ? 1 : o.sa,
    final_score: "2:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id,
  } as never);
}

/** Привязка к событию ESPN с заданной датой — то, чем «наш круг» и доказывается. */
function bind(db: ReturnType<typeof seed>, matchId: string, eventDate: string | null) {
  db.prepare(`INSERT INTO match_live(match_id,espn_event_date,updated_at) VALUES(?,?,?)
              ON CONFLICT(match_id) DO UPDATE SET espn_event_date=excluded.espn_event_date`).run(matchId, eventDate, KO);
}

function suspectBet(db: ReturnType<typeof seed>, id: string, matchId: string, label: string, status: string) {
  R.insertBet(db, {
    id, match_id: matchId, strategy_id: "prematch_value", risk_profile_id: "medium", market_label: label,
    status, proposed_price: 50, entry_price: 50, current_price: 100, closing_price: 60, ai_prob: 0.6,
    stake: 100, rationale: "r", entered_minute: "предматч", result: status === "settled_won" ? "won" : "lost",
    payout: status === "settled_won" ? 200 : 0, created_at: KO,
  } as never);
  db.prepare(`UPDATE bets SET settle_suspect=1 WHERE id=?`).run(id);
}

test("(а) привязки нет — недоказуемо, и это ПРАВИЛЬНЫЙ исход, а не недоработка", () => {
  const db = seed(); match(db, "m1"); bind(db, "m1", null);
  suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");
  const rep = buildSuspectBreakdown(db, OPTS);
  assert.equal(rep.byClass.unprovable_binding, 1);
  assert.equal(rep.permanentQuarantine, 1);
  assert.equal(rep.releasableNow, 0);
  assert.match(rep.rows[0].reason, /нет даты события ESPN/);
});

test("(а) событие за пределом допустимого разрыва — недоказуемо, и разрыв НАЗВАН в часах", () => {
  const db = seed(); match(db, "m1");
  bind(db, "m1", new Date(Date.parse(KO) - 8 * 24 * 3_600_000).toISOString());   // первый круг неделей раньше
  suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");
  const r = buildSuspectBreakdown(db, OPTS).rows[0];
  assert.equal(r.cls, "unprovable_binding");
  assert.equal(r.legGapHours, 192, "«недоказуемо» обязано быть проверяемым числом, а не вердиктом");
});

test("(б) привязка доказана и статус неверен — готова к пересчёту", () => {
  const db = seed(); match(db, "m1", { sh: 0, sa: 0 });      // 0:0 → Over 1.5 проигран
  bind(db, "m1", KO);
  suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");     // помечена выигрышем по ЧУЖОМУ счёту
  const rep = buildSuspectBreakdown(db, OPTS);
  assert.equal(rep.byClass.ready_regrade, 1);
  assert.equal(rep.releasableNow, 1);
  assert.match(rep.rows[0].reason, /settled_won → settled_lost/);
});

test("(б) привязка доказана, статус уже верен — снимется только метка", () => {
  const db = seed(); match(db, "m1", { sh: 2, sa: 1 });
  bind(db, "m1", KO);
  suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");
  assert.equal(buildSuspectBreakdown(db, OPTS).byClass.ready_confirm, 1);
});

test("(в) ярлык не разрешается по счёту — конвейер не берёт, и это РАБОТА, а не карантин", () => {
  const db = seed(); match(db, "m1"); bind(db, "m1", KO);
  suspectBet(db, "b1", "m1", "Игрок X забьёт первым", "settled_won");
  const rep = buildSuspectBreakdown(db, OPTS);
  assert.equal(rep.byClass.uncovered_label, 1);
  assert.equal(rep.uncovered, 1);
  assert.equal(rep.permanentQuarantine, 0, "нерешаемый ярлык — НЕ то же самое, что недоказуемая привязка");
});

test("(в) матч не в терминальном состоянии — тоже «конвейер не берёт», а не «недоказуемо»", () => {
  const db = seed(); match(db, "m1", { state: "live" }); bind(db, "m1", KO);
  suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");
  assert.equal(buildSuspectBreakdown(db, OPTS).byClass.uncovered_state, 1);
});

test("ОТЧЁТ И КОНВЕЙЕР НЕ МОГУТ РАЗОЙТИСЬ: сколько обещано снять — столько и снимается", () => {
  const db = seed();
  match(db, "ok1", { sh: 0, sa: 0 }); bind(db, "ok1", KO); suspectBet(db, "b1", "ok1", "Over 1.5", "settled_won");
  match(db, "ok2", { sh: 2, sa: 1 }); bind(db, "ok2", KO); suspectBet(db, "b2", "ok2", "Over 1.5", "settled_won");
  match(db, "bad"); bind(db, "bad", null);                  suspectBet(db, "b3", "bad", "Over 1.5", "settled_won");
  match(db, "lbl"); bind(db, "lbl", KO);                    suspectBet(db, "b4", "lbl", "Игрок X забьёт первым", "settled_won");

  const before = buildSuspectBreakdown(db, OPTS);
  assert.equal(before.total, 4);
  assert.equal(before.releasableNow, 2);

  const run = reSettleSuspectBets(db, {});
  assert.equal(run.regraded + run.confirmed, before.releasableNow, "обещание отчёта = факт конвейера");
  assert.equal(run.deferred, before.permanentQuarantine + before.uncovered);

  const after = buildSuspectBreakdown(db, OPTS);
  assert.equal(after.total, 2, "снялись ровно обещанные две");
  assert.equal(after.releasableNow, 0);
});

test("раскладка НИЧЕГО не пишет — карантин после отчёта тот же", () => {
  const db = seed(); match(db, "m1", { sh: 0, sa: 0 }); bind(db, "m1", KO);
  suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");
  buildSuspectBreakdown(db, OPTS);
  buildSuspectBreakdown(db, OPTS);
  assert.equal(R.getBet(db, "b1")!.status, "settled_won");
  assert.equal(buildSuspectBreakdown(db, OPTS).total, 1, "отчёт не снимает метку и не пересчитывает");
});

test("нота называет все три класса числами — «копим» без раскладки больше не ответ", () => {
  const db = seed();
  match(db, "ok", { sh: 0, sa: 0 }); bind(db, "ok", KO); suspectBet(db, "b1", "ok", "Over 1.5", "settled_won");
  match(db, "bad"); bind(db, "bad", null);               suspectBet(db, "b2", "bad", "Over 1.5", "settled_won");
  const n = buildSuspectBreakdown(db, OPTS).note;
  assert.match(n, /ГОТОВЫ К СНЯТИЮ СЕЙЧАС: 1/);
  assert.match(n, /НАВСЕГДА В КАРАНТИНЕ: 1/);
  assert.match(n, /КОНВЕЙЕР НЕ БЕРЁТ: 0/);
});

test("осиротевшая строка классифицируется, а не роняет раскладку", () => {
  const db = seed(); match(db, "m1"); bind(db, "m1", KO);
  suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");
  const c = classifySuspect(db, "нет-такой-ставки", OPTS);
  assert.equal(c.cls, "orphan");
});

// ── ПОСТФАКТУМ-ИЗМЕРЕНИЕ И ПОДПИСЬ СНЯТИЯ ───────────────────────────────────────────────────────
// Стандарт со времён бэкфиллов: после КАЖДОЙ массовой записи нулевая дельта денег подтверждается
// измерением из базы, а не выводится из предиката. Предикат уже покрыт тестом выше — но обещание и
// факт это разные вещи, и второе дешевле первого.

test("подтверждение без изменения статуса даёт Δ книги РОВНО $0.00, измеренную из базы", () => {
  const db = seed();
  match(db, "m1", { sh: 2, sa: 1 }); bind(db, "m1", KO); suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");
  match(db, "m2", { sh: 2, sa: 1 }); bind(db, "m2", KO); suspectBet(db, "b2", "m2", "Over 1.5", "settled_won");

  const before = bookTotals(db);
  const r = reSettleSuspectBets(db, {});
  assert.equal(r.confirmed, 2);
  assert.equal(r.regraded, 0);
  assert.equal(r.bookDeltaUsd, 0);
  assert.deepEqual(r.bookAfter, before, "ни одна цифра книги не сдвинулась");
  assert.match(r.note, /Δ книги = \+?\$0\.00/);
  assert.match(r.note, /измерено ИЗ БАЗЫ после записи/);
});

test("пересчёт статуса ДВИГАЕТ книгу — и отчёт это признаёт, а не прячет", () => {
  const db = seed();
  match(db, "m1", { sh: 0, sa: 0 }); bind(db, "m1", KO); suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");
  const r = reSettleSuspectBets(db, {});
  assert.equal(r.regraded, 1);
  assert.notEqual(r.bookDeltaUsd, 0, "выигрыш, переоценённый в проигрыш, обязан изменить книгу");
  assert.match(r.note, /НЕНУЛЕВАЯ дельта/);
});

test("снятие ПОДПИСАНО: дата и версия предиката стоят в самой строке", () => {
  const db = seed();
  match(db, "m1", { sh: 2, sa: 1 }); bind(db, "m1", KO); suspectBet(db, "b1", "m1", "Over 1.5", "settled_won");
  reSettleSuspectBets(db, {});
  const row = db.prepare(`SELECT settle_suspect s, settle_verified v, settle_verified_at at, settle_verified_by by FROM bets WHERE id='b1'`).get() as any;
  assert.equal(row.s, 0);
  assert.equal(row.v, 1);
  assert.equal(row.by, CLASSIFY_VERSION, "«чем снят флаг» отвечается строкой, а не памятью");
  assert.ok(row.at && Date.parse(row.at), "и когда — тоже");
});

test("обещание отчёта = поставка прогона, число в число", () => {
  const db = seed();
  match(db, "ok", { sh: 2, sa: 1 }); bind(db, "ok", KO); suspectBet(db, "b1", "ok", "Over 1.5", "settled_won");
  match(db, "st", { state: "upcoming" }); bind(db, "st", KO); suspectBet(db, "b2", "st", "Over 1.5", "settled_won");
  const promised = buildSuspectBreakdown(db, OPTS).releasableNow;
  const r = reSettleSuspectBets(db, {});
  assert.equal(promised, 1);
  assert.equal(r.regraded + r.confirmed, promised);
  assert.equal(buildSuspectBreakdown(db, OPTS).total, 1, "остался ровно необещанный");
});
