// ============================================================
// O12 — вердикт-релевантное состояние рынка снимается СОБЫТИЕМ, не расписанием.
//
// Именной замер (05.08): 63 из 73 нерешённых гандикапов имели цену старше 30 минут на конец матча,
// медиана отставания 121 минута. Причина структурная: `markets` пишет только refreshActiveOdds (первый
// шаг тика), терминальный статус скаут узнаёт девятым, а со следующего тика матч становится `finished`
// и refreshActiveOdds его пропускает по построению. Терминальный момент — последний шанс.
// ============================================================

import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { terminalBookTaken, terminalBookMid, captureTerminalBook, TERMINAL_BOOK_SOURCE } from "../src/lib/terminalBook.js";

function world() {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 1000, external_league: null, created_at: "2026-08-01" });
  R.insertMatch(db, {
    id: "tm", competition_id: "atp", home: "A. One", away: "B. Two", state: "finished", lineup_out: false,
    kickoff_at: "2026-08-05T10:00:00.000Z", minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null,
  });
  return db;
}
const mk = (db: ReturnType<typeof world>, id: string, label: string, token: string | null) =>
  R.insertMarket(db, { id, match_id: "tm", label, price: 50, ai_prob: null, liquidity: "100", external_ref: token, snapshot_at: "2026-08-05T10:00:00.000Z", is_closing: false });

const depth = (db: ReturnType<typeof world>, label: string, token: string, bid: number | null, ask: number | null, at: string, source = TERMINAL_BOOK_SOURCE) =>
  db.prepare(`INSERT INTO book_depth_snapshots(id,match_id,token_id,label,source,best_bid_cents,best_ask_cents,bid_depth_usd,ask_depth_usd,bids_json,asks_json,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(R.uid(), "tm", token, label, source, bid, ask, 0, 0, "[]", "[]", at);

test("O12: снимок читается как mid по лучшим bid/ask и несёт СВОЁ время", () => {
  const db = world();
  depth(db, "ATP: A vs B Set Handicap +/-1.5", "tok1", 98, 100, "2026-08-05T12:00:00.000Z");
  const r = terminalBookMid(db, "tm", "ATP: A vs B Set Handicap +/-1.5")!;
  assert.equal(r.cents, 99);
  assert.equal(r.at, "2026-08-05T12:00:00.000Z");
});

test("O12: пустая книга — это ОТСУТСТВИЕ котировки, а не ноль центов", () => {
  const db = world();
  depth(db, "L", "tok", null, null, "2026-08-05T12:00:00.000Z", `${TERMINAL_BOOK_SOURCE}_empty`);
  assert.equal(terminalBookMid(db, "tm", "L"), null);
});

test("O12: односторонняя книга читается по имеющейся стороне, а не выбрасывается", () => {
  const db = world();
  depth(db, "L", "tok", 97, null, "2026-08-05T12:00:00.000Z");
  assert.equal(terminalBookMid(db, "tm", "L")!.cents, 97);
});

test("O12: берётся САМЫЙ СВЕЖИЙ терминальный снимок рынка", () => {
  const db = world();
  depth(db, "L", "tok", 60, 62, "2026-08-05T11:00:00.000Z");
  depth(db, "L", "tok", 98, 100, "2026-08-05T12:00:00.000Z");
  assert.equal(terminalBookMid(db, "tm", "L")!.cents, 99);
});

test("O12: снимок другого источника терминальным не считается", () => {
  const db = world();
  depth(db, "L", "tok", 98, 100, "2026-08-05T12:00:00.000Z", "periodic");
  assert.equal(terminalBookMid(db, "tm", "L"), null);
  assert.equal(terminalBookTaken(db, "tm"), false);
});

test("O12: идемпотентность держится САМОЙ записью, а не маркером", async () => {
  const db = world();
  mk(db, "m1", "ATP: A vs B Set Handicap +/-1.5", "tok1");
  assert.equal(terminalBookTaken(db, "tm"), false);
  depth(db, "ATP: A vs B Set Handicap +/-1.5", "tok1", 98, 100, "2026-08-05T12:00:00.000Z");
  assert.equal(terminalBookTaken(db, "tm"), true);
  // повторный заход не делает НИ ОДНОГО сетевого вызова — выходит на первой же проверке
  assert.equal(await captureTerminalBook(db, "tm", {}, "2026-08-05T12:05:00.000Z"), 0);
});

test("O12: манилайн ВХОДИТ в цели — колонка скаута не может доказать свою свежесть", async () => {
  // У pm_p1_cents два происхождения: живой мидпойнт для рынков в скоупе и СОХРАНЁННЫЙ дискавери-манилайн
  // для вне-скоупных тиров, записанный под временем текущей строки. Предматчевая цена выглядела бы
  // синхронной со счётом. Поэтому манилайн идёт через тот же терминальный снимок, что и гандикапы.
  const db = world();
  mk(db, "m-ml", "ATP: A. One vs B. Two", "tokML");
  mk(db, "m-h", "ATP: A. One vs B. Two Set Handicap +/-1.5", "tokH");
  const n = await captureTerminalBook(db, "tm", { env: {} } as never, "2026-08-05T12:00:00.000Z");
  assert.equal(n, 0, "polymarket выключен — снимков нет, и это не ошибка");
  assert.equal(terminalBookTaken(db, "tm"), false);
});

test("O12: рынок без токена целью не становится — снимать нечего, а не «пусто»", async () => {
  const db = world();
  mk(db, "m-nt", "ATP: A vs B Total Sets: Over 2.5", null);
  assert.equal(await captureTerminalBook(db, "tm", {}, "2026-08-05T12:00:00.000Z"), 0);
});
