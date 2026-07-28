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
import { markLegGapSuspect } from "../src/lib/footballIntegrity.js";

function bet(db: any, id: string, mid: string, status: string, settledBy: string | null) {
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,settled_by,created_at)
              VALUES(?,?,'prematch_value','medium','Under 2.5',?,50,40,?,'t')`).run(id, mid, status, settledBy);
}

test("legGap: матч с гэпом 16 дней и ТОЛЬКО досрочно закрытыми ставками получает suspect", () => {
  // Точная форма Seattle–Portland: лига НЕ из перечня двухматчевых (MLS), все позиции закрыты early/partial,
  // то есть до сеттл-пути, где жила маркировка, они не доходят вовсе. Прежние две проверки пропускали оба
  // признака сразу — поэтому самый грубый разрыв из найденных оставался непомеченным.
  const db = openDb(":memory:"); initSchema(db); seed(db);
  R.upsertCompetition(db, { id: "mls", sport_id: "football", name: "MLS", budget: 8000, external_league: "usa.1", created_at: "t" } as any);
  R.insertMatch(db, { id: "sea", competition_id: "mls", home: "Seattle", away: "Portland", state: "finished",
    lineup_out: true, kickoff_at: "2026-08-02T02:30:00Z", minute: 90, score_home: 1, score_away: 5, final_score: "1:5",
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "sea" } as any);
  R.upsertMatchLive(db, { match_id: "sea", espn_event_id: "e-old", league: "usa.1",
    espn_event_date: "2026-07-17T02:30:00Z", home_lineup: null, away_lineup: null, stats: null, updated_at: "2026-07-22T21:42:32Z" });
  bet(db, "s1", "sea", "settled_lost", "early");
  bet(db, "s2", "sea", "settled_lost", "partial");
  bet(db, "s3", "sea", "open", null);

  const dry = markLegGapSuspect(db, {}, { apply: false });
  assert.equal(dry.mismatched, 1);
  assert.equal(dry.rows[0].gapDays, 16, "разрыв ровно шестнадцать дней");
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM bets WHERE settle_suspect=1`).get() as any).n, 0, "сухой прогон не метит");

  const r = markLegGapSuspect(db, {});
  assert.equal(r.betsTagged, 3, "помечены ВСЕ ставки матча, включая открытую и закрытые досрочно");
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM bets WHERE settle_suspect=1`).get() as any).n, 3);
});

test("legGap: честная привязка в пределах допуска НЕ метится, и повтор ничего не добавляет", () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  R.insertMatch(db, { id: "ok", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true,
    kickoff_at: "2026-07-28T18:00:00Z", minute: 90, score_home: 1, score_away: 0, final_score: "1:0",
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "ok" } as any);
  R.upsertMatchLive(db, { match_id: "ok", espn_event_id: "e-same", league: "uefa.conf",
    espn_event_date: "2026-07-28T18:00:00Z", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  bet(db, "o1", "ok", "settled_won", "match_score");
  assert.equal(markLegGapSuspect(db, {}).betsTagged, 0);
  assert.equal(markLegGapSuspect(db, {}).betsTagged, 0, "идемпотентно: второй проход не метит заново");
});

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
