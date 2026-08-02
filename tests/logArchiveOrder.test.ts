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

// ── ...И КЛЮЧ СОРТИРОВКИ НЕ ИМЕЕТ ПРАВА БЫТЬ В БУДУЩЕМ ───────────────────────────────────────────
// Первая версия правки (01.08) отбраковала кривой end_time и упала на kickoff_at — а он у двух строк
// стоял НА НЕДЕЛЮ ВПЕРЁД (08.08). Пробка та же, слоем глубже: я заменил одно негодное поле другим
// вместо того, чтобы запретить негодность как класс. Дословные строки прода 02.08:
//   endIso=NULL      kickoff=2026-08-08T22:30Z  North Carolina Courage–Washington Spirit
//   endIso="21:10"   kickoff=2026-08-08T14:00Z  Sarpsborg 08 FF–Viking FK
// Обе — химеры (finished при кикоффе в будущем), обе НЕ торгуются вовсе (futureFinished.ts).

const NOW = Date.parse("2026-08-02T15:00:00Z");

test("завершённый матч с кикоффом на неделю вперёд уходит ВНИЗ, а не занимает верх", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "chimera-null-end", null, "2026-08-08T22:30:00Z");   // NC Courage
  finished(db, "chimera-bare-end", "21:10", "2026-08-08T14:00:00Z"); // Sarpsborg
  finished(db, "today", "2026-08-02T14:52:39.885Z", "2026-08-02T13:00:00Z");

  const rows = R.listMatchLogs(db, 50, NOW);
  assert.equal(rows[0].id, "today", "сегодняшний матч ПЕРВЫЙ — химеры больше не держат верх");
  assert.ok(rows.slice(1).every((r) => r.futureSortKey), "обе химеры ушли вниз");
});

test("химера помечена флагом — она не торгуется, прятать её молча нельзя", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "chimera", null, "2026-08-08T22:30:00Z");
  finished(db, "normal", "2026-08-02T14:52:39.885Z", "2026-08-02T13:00:00Z");
  const by = new Map(R.listMatchLogs(db, 50, NOW).map((r) => [r.id, r]));
  assert.equal(by.get("chimera")!.futureSortKey, true);
  assert.equal(by.get("normal")!.futureSortKey, false);
});

test("прошлое по-прежнему сортируется по времени — правка не сломала нормальный порядок", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "older", "2026-08-01T10:00:00.000Z", "2026-08-01T08:00:00Z");
  finished(db, "newer", "2026-08-02T10:00:00.000Z", "2026-08-02T08:00:00Z");
  const rows = R.listMatchLogs(db, 50, NOW);
  assert.equal(rows[0].id, "newer");
  assert.equal(rows[1].id, "older");
});

// ── …И КЛИЕНТ НЕ ИМЕЕТ ПРАВА СОРТИРОВАТЬ ПО-СВОЕМУ ──────────────────────────────────────────────
// Прод 02.08, жалоба владельца: «в логах явный хаос». Сортировка на сервере к тому моменту была уже
// починена дважды — но UI пересортировывал список СВОИМ ключом: `Date.parse(endIso || kickoffAt)`.
// Это отменяло обе правки: значение из будущего клиент читал как валидную дату и поднимал химеру
// наверх, а голое «23:51» давало NaN→0 и сваливало 30 строк в недатированный ком внизу.
// Два авторитета на один порядок. Лечение то же, что у CLV: ключ считается ОДИН раз, там же, где
// сортировали, и отдаётся наружу.

test("sortIso отдаётся наружу и равен тому, по чему реально отсортировано", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "ok", "2026-08-02T10:00:00.000Z", "2026-08-02T08:00:00Z");
  finished(db, "bare", "21:10", "2026-08-01T14:00:00Z");          // кривое время → падаем на кикофф
  finished(db, "future", null, "2026-08-08T22:30:00Z");           // химера → к сортировке не допускается

  const by = new Map(R.listMatchLogs(db, 50, NOW).map((r) => [r.id, r]));
  assert.equal(by.get("ok")!.sortIso, "2026-08-02T10:00:00.000Z");
  assert.equal(by.get("bare")!.sortIso, "2026-08-01T14:00:00Z", "негодное время — ключ берётся у кикоффа");
  assert.equal(by.get("future")!.sortIso, null, "будущее ключом не становится вовсе");
});

test("порядок по sortIso совпадает с порядком, который вернул SQL — иначе клиент его отменит", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "old", "2026-07-30T10:00:00.000Z", "2026-07-30T08:00:00Z");
  finished(db, "new", "2026-08-02T10:00:00.000Z", "2026-08-02T08:00:00Z");
  finished(db, "chimera", null, "2026-08-08T22:30:00Z");

  const rows = R.listMatchLogs(db, 50, NOW);
  const clientOrder = [...rows].sort((a, b) => (Date.parse(b.sortIso || "") || 0) - (Date.parse(a.sortIso || "") || 0));
  assert.deepEqual(clientOrder.map((r) => r.id), rows.map((r) => r.id),
    "клиент, сортирующий по sortIso, обязан получить ТОТ ЖЕ список");
  assert.equal(rows[0].id, "new");
});

test("endIso — истинный инстант или null; сырое «23:51» уходит в endTimeRaw, а не притворяется временем", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "bare", "23:51", "2026-07-23T21:00:00Z");
  finished(db, "good", "2026-08-02T10:00:00.000Z", "2026-08-02T08:00:00Z");

  const by = new Map(R.listMatchLogs(db, 50, NOW).map((r) => [r.id, r]));
  assert.equal(by.get("bare")!.endIso, null, "поле с именем endIso не имеет права содержать «23:51»");
  assert.equal(by.get("bare")!.endTimeRaw, "23:51", "дефект НЕ теряется — он назван отдельным полем");
  assert.equal(by.get("bare")!.endTimeMalformed, true);
  assert.equal(by.get("good")!.endIso, "2026-08-02T10:00:00.000Z");
  assert.equal(by.get("good")!.endTimeRaw, null);
  // Группировка по дню на клиенте — это endIso.slice(0,10). Раньше отсюда бралась корзина «23:51».
  assert.equal(by.get("bare")!.endIso?.slice(0, 10) ?? null, null);
});

test("теннис показывает счёт по сетам — 386 пустых клеток архива были не «нет данных», а не тем полем", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  R.insertMatch(db, {
    id: "t1", competition_id: "atp", home: "Player A", away: "Player B", state: "finished", lineup_out: true,
    kickoff_at: "2026-08-02T09:00:00Z", minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: "2026-08-02T11:00:00.000Z", duration: null, end_note: null, external_ref: "t1",
  } as never);
  const snap = (id: string, s1: number, s2: number, live: number, status: string, at: string) =>
    db.prepare(`INSERT INTO tennis_snapshots(id,provider,event_key,pm_match_id,p1,p2,sets_p1,sets_p2,live,status,batch_at,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, "api-tennis", "ek1", "t1", "Player A", "Player B", s1, s2, live, status, at, at);
  snap("s1", 1, 0, 1, "In Progress", "2026-08-02T10:00:00Z");
  snap("s2", 2, 1, 0, "Finished", "2026-08-02T10:58:00Z");

  const row = R.listMatchLogs(db, 50, NOW)[0];
  assert.equal(row.finalScore, "2:1", "счёт берётся из ПОСЛЕДНЕГО снимка, а не из первого попавшегося");
});

test("футбольный счёт не подменяется теннисным путём — источник по виду спорта", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "f1", "2026-08-02T10:00:00.000Z", "2026-08-02T08:00:00Z");
  assert.equal(R.listMatchLogs(db, 50, NOW)[0].finalScore, "1:0", "футбол читает final_score как раньше");
});

// ── ТИП ДЫРЫ ВМЕСТО ВИДА ПОЛОМКИ ────────────────────────────────────────────────────────────────
// 114 футбольных строк архива показывали пустую клетку счёта. Пустая клетка без причины читается как
// «недосчитано», то есть как наша поломка. На деле это известный класс покрытия: лига без фида
// торгуется вслепую и сеттлится по PM-резолюции — счёта в НАШИХ источниках не существует, а исход есть.
// Данные не чиним, тип дыры называем.

test("нет привязки к провайдеру → no_feed: счёта не существует, а не «недосчитан»", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  R.insertMatch(db, {
    id: "nf", competition_id: "c1", home: "H", away: "A", state: "finished", lineup_out: true,
    kickoff_at: "2026-08-01T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: "2026-08-01T20:00:00.000Z", duration: null, end_note: null, external_ref: "nf",
  } as never);
  assert.equal(R.listMatchLogs(db, 50, NOW)[0].noScoreReason, "no_feed");
});

test("привязка есть, счёта нет → bound_no_score: у неизвестного есть ИМЯ, а не пустота", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  R.insertMatch(db, {
    id: "bd", competition_id: "c1", home: "H", away: "A", state: "finished", lineup_out: true,
    kickoff_at: "2026-08-01T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: "2026-08-01T20:00:00.000Z", duration: null, end_note: null, external_ref: "bd",
  } as never);
  db.prepare(`INSERT INTO match_live(match_id,espn_event_date,updated_at) VALUES(?,?,?)`).run("bd", "2026-08-01T18:00:00Z", "t");
  assert.equal(R.listMatchLogs(db, 50, NOW)[0].noScoreReason, "bound_no_score",
    "отказ выдумывать причину — правильный рефлекс; но пустая клетка без имени читается как поломка");
});

test("матч со счётом причины не несёт — метка только там, где клетка пуста", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db);
  finished(db, "ok", "2026-08-01T20:00:00.000Z", "2026-08-01T18:00:00Z");
  const r = R.listMatchLogs(db, 50, NOW)[0];
  assert.equal(r.finalScore, "1:0");
  assert.equal(r.noScoreReason, null);
});

test("теннис без снимка → score_source_expired: источник жил короче архива", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  R.insertMatch(db, {
    id: "t9", competition_id: "atp", home: "A", away: "B", state: "finished", lineup_out: true,
    kickoff_at: "2026-07-20T09:00:00Z", minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: "2026-07-20T11:00:00.000Z", duration: null, end_note: null, external_ref: "t9",
  } as never);
  assert.equal(R.listMatchLogs(db, 50, NOW)[0].noScoreReason, "score_source_expired");
});
