import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { repairFutureFinished } from "../src/lib/futureFinished.js";

const NOW = Date.parse("2026-07-28T13:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function seed(db: any) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "UECL", budget: 8000, external_league: "uefa.conf", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "pmv", color: "#fff",
    version: 1, prompt: "", prompt_live: null, params: {}, model: "m", model_live: null, created_at: "t" } as any);
}
function match(db: any, id: string, kickoff: string, state: string, patch: any = {}) {
  R.insertMatch(db, { id, competition_id: "c1", home: `H${id}`, away: `A${id}`, state, lineup_out: false,
    kickoff_at: kickoff, minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id, ...patch } as any);
}

test("матч, «завершённый» до собственного кикоффа, найден и сброшен в upcoming", () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  // Ровно случай Vardar–Rīga: кикофф сегодня в 17:00, а запись уже finished со счётом первого круга.
  match(db, "m1", "2026-07-28T17:00:00Z", "finished", { minute: 90, score_home: 2, score_away: 3, final_score: "2:3" });
  R.upsertMatchLive(db, { match_id: "m1", espn_event_id: "e-first-leg", league: "uefa.conf",
    espn_event_date: "2026-07-22T17:00:00Z", home_lineup: null, away_lineup: null, stats: null, updated_at: "2026-07-22T22:31:55Z" });

  const dry = repairFutureFinished(db, { nowMs: NOW });
  assert.equal(dry.broken, 1);
  assert.equal(dry.rows[0].legGapDays, 6, "разрыв с привязанным событием — шесть дней, это другой круг");
  assert.equal(dry.rows[0].action, "БУДЕТ сброшен");
  assert.equal(R.getMatch(db, "m1")!.state, "finished", "сухой прогон НИЧЕГО не меняет");

  const wet = repairFutureFinished(db, { apply: true, nowMs: NOW });
  assert.equal(wet.reset, 1);
  const m = R.getMatch(db, "m1")!;
  assert.equal(m.state, "upcoming");
  assert.equal(m.score_home, null); assert.equal(m.minute, null); assert.equal(m.final_score, null);
  assert.ok(!R.getMatchLive(db, "m1"), "чужое событие отвязано — иначе следующий проход вернул бы состояние");
});

test("здоровые записи не трогаются: сыгранный вчера finished и будущий upcoming", () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  match(db, "ok1", "2026-07-27T17:00:00Z", "finished", { minute: 90, score_home: 1, score_away: 0 });
  match(db, "ok2", "2026-07-29T17:00:00Z", "upcoming");
  match(db, "ok3", "2026-07-28T12:00:00Z", "live", { minute: 55 });   // кикофф уже был — идёт сейчас
  const r = repairFutureFinished(db, { apply: true, nowMs: NOW });
  assert.equal(r.broken, 0, "ни одна честная запись не подпадает под инвариант");
  assert.equal(R.getMatch(db, "ok1")!.state, "finished");
  assert.equal(R.getMatch(db, "ok3")!.state, "live");
});

test("live до кикоффа — тоже порча: матч не может идти, не начавшись", () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  match(db, "m2", "2026-07-28T20:00:00Z", "live", { minute: 71, score_home: 0, score_away: 1 });
  const r = repairFutureFinished(db, { apply: true, nowMs: NOW });
  assert.equal(r.reset, 1);
  assert.equal(R.getMatch(db, "m2")!.state, "upcoming");
});

test("матч с РЕШЁННЫМИ ставками не откатывается — это переписывание книги задним числом", () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  match(db, "m3", "2026-07-28T17:00:00Z", "finished", { minute: 90, score_home: 2, score_away: 3 });
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,created_at)
              VALUES('b1','m3','prematch_value','medium','Over 2.5','settled_won',50,100,'t')`).run();
  const r = repairFutureFinished(db, { apply: true, nowMs: NOW });
  assert.equal(r.broken, 1);
  assert.equal(r.reset, 0, "не тронут");
  assert.equal(r.skippedWithMoney, 1);
  assert.equal(r.rows[0].action, "пропущен: есть решённые ставки");
  assert.equal(R.getMatch(db, "m3")!.state, "finished", "состояние осталось — решение за владельцем");
  assert.match(r.note, /решённые ставки/);
});

test("наведённые события матча стираются вместе с состоянием", () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  match(db, "m4", "2026-07-28T17:00:00Z", "finished", { minute: 90, score_home: 2, score_away: 3 });
  R.insertMatchEvent(db, { id: "e1", match_id: "m4", event_key: "g1", minute: 30, type: "goal", team: "X", text: "гол первого круга", created_at: "t" });
  repairFutureFinished(db, { apply: true, nowMs: NOW });
  // Иначе инвариант «счёт против событий» увидел бы голы при пустом счёте и заблокировал переоценку уже сам.
  assert.equal(R.eventsForMatch(db, "m4").length, 0);
});

// ── Дыра пометки: подозрение по ФАКТУ разрыва, а не по списку турниров и не в момент расчёта ──────
test("--with-settled чинит состояние и НЕ трогает книгу", () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  match(db, "m5", "2026-07-30T18:00:00Z", "finished", { minute: 90, score_home: 2, score_away: 1 });
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,payout,settled_by,created_at)
              VALUES('b9','m5','prematch_value','medium','Bohemian — Yes','settled_lost',50,14,0.7,'early','t')`).run();
  const before = db.prepare(`SELECT status,payout,stake,settled_by FROM bets WHERE id='b9'`).get() as any;

  const r = repairFutureFinished(db, { apply: true, withSettled: true, nowMs: NOW });
  assert.equal(r.reset, 1);
  assert.equal(r.resetWithSettled, 1);
  assert.equal(r.skippedWithMoney, 0);
  assert.equal(R.getMatch(db, "m5")!.state, "upcoming", "состояние починено — матч снова торгуемый");

  const after = db.prepare(`SELECT status,payout,stake,settled_by FROM bets WHERE id='b9'`).get() as any;
  assert.deepEqual(after, before, "книга не изменена НИ В ОДНОМ поле: P&L той позиции взят с рынка, а не со счёта");
  assert.match(r.note, /книга не изменена/);
});


// ── F2 ПОДКЛЮЧЁН К ХИМЕРА-КЛАССУ ────────────────────────────────────────────────────────────────
// Прод 02.08 держал две строки finished при кикоффе 08.08 — и НИ ОДНА не несла state_suspect.
// Причина: finishSuspectReason судил только минуту («финиш раньше 80-й»), а «завершён раньше
// собственного кикоффа» мимо этого порога проходил. Ветка добавлена и проверяется ПЕРВОЙ.
import { finishSuspectReason } from "../src/lib/engine.js";

test("F2: завершение раньше собственного кикоффа — state_suspect, даже при честных 90 минутах", () => {
  const now = "2026-08-02T15:00:00Z";
  const ok90 = { state: "finished", detail: "FT", clock: "90'", scoreHome: 1, scoreAway: 0 } as any;
  // Химера: часы идеальные, но кикофф на неделю вперёд.
  const chimera = finishSuspectReason(ok90, {}, "2026-08-08T14:00:00Z", now);
  assert.ok(chimera && /РАНЬШЕ собственного кикоффа/.test(chimera), `ожидали подозрение, получили: ${chimera}`);
  // Нормальный вчерашний матч на 90-й — подозрения нет.
  assert.equal(finishSuspectReason(ok90, {}, "2026-08-01T14:00:00Z", now), null);
  // Ветка минут не сломана: обрыв фида на 40-й по-прежнему ловится.
  const early = { state: "finished", detail: "FT", clock: "40'", scoreHome: 0, scoreAway: 0 } as any;
  assert.match(String(finishSuspectReason(early, {}, "2026-08-01T14:00:00Z", now)), /фид оборвался/);
  // Без кикоффа/времени ветка молчит — судить нечем (fail-open на неоднозначности).
  assert.equal(finishSuspectReason(ok90, {}, null, now), null);
});
