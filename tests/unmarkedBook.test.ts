import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { buildUnmarkedBook, unmarkedBookLine } from "../src/lib/unmarkedBook.js";
import { UNMARKED_BOOK_BAND_CENTS } from "../src/lib/entryPopulation.js";

function match(db: ReturnType<typeof openDb>, id: string, state: "upcoming" | "live" | "finished", kickoffAt: string) {
  R.insertMatch(db, {
    id, competition_id: "wc2026", home: `H${id}`, away: `A${id}`, state, lineup_out: false,
    kickoff_at: kickoffAt, minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null,
  });
}
function markets(db: ReturnType<typeof openDb>, matchId: string, prices: number[]) {
  prices.forEach((p, i) => R.insertMarket(db, {
    id: `${matchId}-mk${i}`, match_id: matchId, label: `L${i}`, price: p, ai_prob: null,
    liquidity: "100", external_ref: `tok-${matchId}-${i}`, snapshot_at: "2026-08-05T00:00:00.000Z", is_closing: false,
  }));
}

test("N6-2: доля неразмеченной книги приходит СО СВОИМ знаменателем", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  match(db, "u1", "upcoming", "2026-08-06T10:00:00.000Z");
  markets(db, "u1", [50, 50.2, 78, 12]);      // 2 из 4 в полосе
  const r = buildUnmarkedBook(db, Date.parse("2026-08-05T10:00:00.000Z"));
  assert.equal(r.bandCents, UNMARKED_BOOK_BAND_CENTS);
  assert.ok(r.markets >= 4);
  const cut = r.byState.find((x) => x.key === "upcoming")!;
  assert.ok(cut.unmarked >= 2);
  assert.ok(r.pct != null && r.pct > 0);
  assert.match(r.note, /рынков =/);
  assert.match(unmarkedBookLine(r), /unmarked_book: \d+\/\d+ рынков/);
});

test("N6-2: завершённый матч в знаменатель НЕ входит — там планка законна", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  match(db, "fin", "finished", "2026-08-01T10:00:00.000Z");
  markets(db, "fin", [50, 50, 50, 50]);
  const r = buildUnmarkedBook(db, Date.parse("2026-08-05T10:00:00.000Z"));
  assert.ok(!r.byState.some((x) => x.key === "finished"), "у завершённых планка — цена разрешения, а не спящая книга");
});

test("N6-2: TAM ft_blind считается по ТОРГОВАННЫМ книгам, а не по числу фикстур", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const now = Date.parse("2026-08-05T12:00:00.000Z");
  const ko = new Date(now - 60 * 60_000).toISOString();     // час назад — попадает в окно blind-funded
  match(db, "blind-traded", "upcoming", ko);
  markets(db, "blind-traded", [50, 73]);                    // хоть один рынок торгован
  match(db, "blind-parked", "upcoming", ko);
  markets(db, "blind-parked", [50, 50.1]);                  // вся книга у планки
  const r = buildUnmarkedBook(db, now);
  assert.equal(r.ftBlind.fixtures, 2);
  assert.equal(r.ftBlind.withTradedBook, 1);
  assert.equal(r.ftBlind.allUnmarked, 1);
  assert.match(r.ftBlind.tamNote, /Валовой счёт фикстур завышал бы TAM на 1/);
});

test("N6-2: нет рынков — доля НЕ ДОЛЖНА читаться как ноль", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM markets");
  db.exec("UPDATE matches SET state='finished'");
  const r = buildUnmarkedBook(db, Date.parse("2026-08-05T10:00:00.000Z"));
  assert.equal(r.pct, null);
  assert.match(r.note, /не определена \(не ноль\)/);
});
