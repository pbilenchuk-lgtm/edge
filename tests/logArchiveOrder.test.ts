// ============================================================
// EDGE LAB — «В ЛОГАХ НЕТ СОБЫТИЙ» ОКАЗАЛОСЬ СОРТИРОВКОЙ, А НЕ ПУСТОТОЙ
//
// Прод 30.07, жалоба владельца: «матч за матчем, ничего не происходит, в логи ничего не добавляется».
// Запрос архива показал обратное: за день туда легло 49 матчей — Pegula–Frech, Bohemian–Ballkani,
// Žilina–Katowice и остальные. Первый из них стоял на ПОЗИЦИИ #22.
//
// Наверху намертво сидели 20 строк, у которых end_time записан голым временем («23:51», «22:59»),
// а не ISO. `ORDER BY COALESCE(end_time, kickoff_at) DESC` — лексикографическая сортировка строк, и
//   "23:51" > "2026-07-30T20:43:37Z"
// потому что на второй позиции '3' > '0'. КАЖДАЯ такая строка вечно выше ЛЮБОЙ даты; чем дольше живёт
// архив, тем толще пробка. Снаружи это неотличимо от «ничего не добавляется» — и стоило нам дня
// поисков не там.
//
// Правило: сортировка по ВРЕМЕНИ обязана сортировать время, а не байты строки. И дефект записи
// помечается флагом, а не маскируется починкой порядка — иначе мы чиним симптом и теряем причину.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";

function seed(db: ReturnType<typeof openDb>) {
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "Conf", budget: 0, external_league: "uefa.europa.conf", created_at: "t" });
}
function finished(db: ReturnType<typeof openDb>, id: string, endTime: string | null, kickoff: string) {
  R.insertMatch(db, {
    id, competition_id: "c1", home: "H" + id, away: "A" + id, state: "finished", lineup_out: true,
    kickoff_at: kickoff, minute: null, score_home: 1, score_away: 0, final_score: "1:0",
    kickoff_time: null, end_time: endTime, duration: null, end_note: null, external_ref: id,
  });
}

test("голое «23:51» больше не выигрывает у сегодняшней даты — новые матчи наверху", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  // Дословная форма прод-пробки: end_time = «23:51» при кикоффе неделю назад.
  finished(db, "old", "23:51", "2026-07-23T21:00:00Z");
  finished(db, "today", "2026-07-30T20:43:37.155Z", "2026-07-30T19:00:00Z");

  const rows = R.listMatchLogs(db, 50);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "today", "сегодняшний матч ПЕРВЫЙ — иначе архив выглядит замершим");
  assert.equal(rows[1].id, "old");
});

test("дефект записи не замаскирован починкой порядка — строка помечена", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "bad", "23:51", "2026-07-23T21:00:00Z");
  finished(db, "good", "2026-07-30T20:43:37.155Z", "2026-07-30T19:00:00Z");

  const by = new Map(R.listMatchLogs(db, 50).map((r) => [r.id, r]));
  assert.equal(by.get("bad")!.endTimeMalformed, true, "«23:51» — не ISO, и это названо");
  assert.equal(by.get("good")!.endTimeMalformed, false);
});

test("несколько кривых строк упорядочены между собой по кикоффу, а не по байтам времени", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "bad-older", "23:51", "2026-07-20T21:00:00Z");   // «23:51» лексикографически БОЛЬШЕ…
  finished(db, "bad-newer", "07:05", "2026-07-25T06:00:00Z");   // …чем «07:05», хотя матч старше
  const rows = R.listMatchLogs(db, 50);
  assert.equal(rows[0].id, "bad-newer", "порядок определяет кикофф, раз время записи негодно");
  assert.equal(rows[1].id, "bad-older");
});

test("матч без end_time сортируется по кикоффу и не всплывает наверх из-за NULL", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "no-end", null, "2026-07-22T18:00:00Z");
  finished(db, "today", "2026-07-30T20:43:37.155Z", "2026-07-30T19:00:00Z");
  const rows = R.listMatchLogs(db, 50);
  assert.equal(rows[0].id, "today");
  assert.equal(rows[1].id, "no-end");
  assert.equal(rows[1].endTimeMalformed, false, "отсутствие времени — не «кривой формат», это другое");
});
