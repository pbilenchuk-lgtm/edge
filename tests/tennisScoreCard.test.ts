// ============================================================
// EDGE LAB — ИСТОЧНИК, ЖИВУЩИЙ КОРОЧЕ ЧИТАТЕЛЯ  [четвёртый экземпляр «ратифицировано-но-не-доехало»]
//
// «Счёт ?:? у finished при живом скауте — резолвить финальный счёт в карточку из терминального снапшота»
// ратифицировано в ПЕРВОМ теннисном ТЗ (P2-гигиена). Не доехало. Последствие вылезло 02.08 в «Логах»:
// 376 из 386 теннисных строк показывали пустую клетку счёта, и я сначала объявил это «не тем полем».
// Не тем полем оно было только для 10 матчей; для остальных 376 поле было ПРАВИЛЬНЫМ, но пустым —
// tennis_snapshots чистятся по ретенции, а архив живёт дольше.
//
// Антипаттерн назван: ИСТОЧНИК ЖИВЁТ КОРОЧЕ АРХИВА, КОТОРЫЙ ИЗ НЕГО ЧИТАЕТ. Лечение — переложить факт
// в долгоживущее хранилище В МОМЕНТ, когда он заведомо доступен: терминальный снимок.
//
// Манифест ловит мёртвые МОДУЛИ; строку ТЗ он не ловит ничем — поэтому здесь тест, а не надежда.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { finishTennisMatches, backfillTennisScores, tennisFinalResult } from "../src/lib/tennisTrading.js";

const KO = "2026-08-02T09:00:00Z";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  return db;
}
function match(db: ReturnType<typeof seed>, id: string, state = "live") {
  R.insertMatch(db, {
    id, competition_id: "atp", home: "Player A", away: "Player B", state, lineup_out: true,
    kickoff_at: KO, minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id,
  } as never);
}
function snap(db: ReturnType<typeof seed>, id: string, mid: string, s1: number, s2: number, live: number, status: string, at: string, winner = "First Player") {
  db.prepare(`INSERT INTO tennis_snapshots(id,provider,event_key,pm_match_id,p1,p2,sets_p1,sets_p2,live,status,raw,batch_at,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "api-tennis", "ek-" + mid, mid, "Player A", "Player B", s1, s2, live, status, JSON.stringify({ event_winner: winner }), at, at);
}

test("финиш кладёт счёт по сетам В КАРТОЧКУ — он переживёт чистку снимков по построению", () => {
  const db = seed(); match(db, "t1");
  snap(db, "s1", "t1", 2, 1, 0, "Finished", "2026-08-02T11:00:00Z");

  assert.equal(finishTennisMatches(db, { now: () => "2026-08-02T11:05:00Z" } as never), 1);
  const m = R.getMatch(db, "t1")!;
  assert.equal(m.state, "finished");
  assert.equal(m.final_score, "2:1");
  assert.equal(m.score_home, 2);
  assert.equal(m.score_away, 1);

  // Снимки съедены ретенцией — карточка всё ещё несёт счёт. Это и есть смысл правки.
  db.prepare(`DELETE FROM tennis_snapshots`).run();
  assert.equal(R.getMatch(db, "t1")!.final_score, "2:1");
  assert.equal(tennisFinalResult(db, "t1"), null, "источника больше нет — а факт остался");
});

test("матч с неопределимым победителем НЕ финишируется и счёт не пишется — гадать нечем", () => {
  const db = seed(); match(db, "t2");
  // Ретайр без event_winner: advancing неизвестен → manual. Такой матч остаётся live и виден.
  snap(db, "s2", "t2", 1, 0, 0, "Retired", "2026-08-02T10:30:00Z", "");
  assert.equal(finishTennisMatches(db, { now: () => "2026-08-02T11:05:00Z" } as never), 0);
  const m = R.getMatch(db, "t2")!;
  assert.equal(m.state, "live");
  assert.equal(m.final_score, null);
});

test("бэкфилл спасает то, у чего снимок ЕЩЁ жив, и честно считает то, что уже нет", () => {
  const db = seed();
  match(db, "alive", "finished");                 // снимок есть → спасаем
  snap(db, "sa", "alive", 2, 0, 0, "Finished", "2026-08-01T11:00:00Z");
  match(db, "gone", "finished");                  // снимка нет → потеряно честно
  match(db, "had", "finished");
  R.updateMatch(db, "had", { final_score: "2:1" } as never);   // счёт уже был

  const r = backfillTennisScores(db);
  assert.equal(r.filled, 1);
  assert.equal(r.noSnapshot, 1);
  assert.equal(r.alreadyHad, 1);
  assert.equal(R.getMatch(db, "alive")!.final_score, "2:0");
  assert.equal(R.getMatch(db, "gone")!.final_score, null, "не выдумываем счёт там, где источника нет");
  assert.match(r.note, /не пережил ретенцию/);
});

test("бэкфилл ИДЕМПОТЕНТЕН — второй проход становится no-op, а не переписывает", () => {
  const db = seed();
  match(db, "m", "finished");
  snap(db, "s", "m", 2, 0, 0, "Finished", "2026-08-01T11:00:00Z");
  assert.equal(backfillTennisScores(db).filled, 1);
  const second = backfillTennisScores(db);
  assert.equal(second.filled, 0);
  assert.equal(second.alreadyHad, 1);
});

test("бэкфилл не трогает состояние матча и не касается ставок", () => {
  const db = seed();
  match(db, "m", "finished");
  snap(db, "s", "m", 2, 0, 0, "Finished", "2026-08-01T11:00:00Z");
  const before = R.getMatch(db, "m")!;
  backfillTennisScores(db);
  const after = R.getMatch(db, "m")!;
  assert.equal(after.state, before.state);
  assert.equal(after.end_time, before.end_time);
});
