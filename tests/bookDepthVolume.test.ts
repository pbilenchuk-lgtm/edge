// ============================================================
// EDGE LAB — ГОТОВНОСТЬ КНИГИ К ИЗМЕРЕННОЙ ЁМКОСТИ: ТЕСТЫ НА ГЛАВНУЮ ЛОВУШКУ
//
// Ловушка названа именем: 31.07 при 25 418 снимках пересечение с когортой было почти пустым — объём
// говорил «данных море», а замер не строился. Поэтому здесь проверяется, что БОЛЬШОЙ объём при нулевом
// пересечении даёт «копим», а не «можно строить», и что окно сопоставления работает по времени, а не
// по факту существования строки.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildBookDepthVolume, bookDepthVolumeLine, MIN_MATCHED_ENTRIES, MIN_MATCHES, MATCH_WINDOW_MIN, CAPACITY_STRATEGY } from "../src/lib/bookDepthVolume.js";
import { makeFillCapture, captureFillBook } from "../src/lib/bookDepthCapture.js";

const T = "2026-08-01T00:00:00Z";
const NOW = "2026-08-12T00:00:00Z";

function world() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 8000, external_league: "usa.1", created_at: T });
  R.insertStrategy(db, { id: CAPACITY_STRATEGY, sport_id: "football", name: "Overreaction", tag: "t", color: null, version: 1, model: null, model_live: null, created_at: T, prompt: "p", prompt_live: null, params: {} } as never);
  return db;
}
function match(db: ReturnType<typeof world>, id: string) {
  R.insertMatch(db, {
    id, competition_id: "c1", home: `H${id}`, away: `A${id}`, state: "live", lineup_out: true, kickoff_at: T,
    minute: 30, score_home: 0, score_away: 0, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id,
  } as never);
}
function book(db: ReturnType<typeof world>, mid: string, label: string, at: string, source = "periodic") {
  db.prepare(
    `INSERT INTO book_depth_snapshots (id, match_id, token_id, label, source, best_bid_cents, best_ask_cents, bid_depth_usd, ask_depth_usd, bids_json, asks_json, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(R.uid(), mid, `tok-${mid}-${label}`, label, source, 49, 51, 500, 500, "[[49,100]]", "[[51,100]]", at);
}
let seq = 0;
function entry(db: ReturnType<typeof world>, mid: string, label: string, at: string) {
  R.insertBet(db, {
    id: `e${++seq}`, match_id: mid, strategy_id: CAPACITY_STRATEGY, risk_profile_id: "medium", market_label: label,
    status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6,
    stake: 100, rationale: "r", entered_minute: "30'", result: null, payout: null, created_at: at,
  } as never);
}

test("пустая таблица: сказано «строить нечего», а не «критерий не выполнен»", () => {
  const r = buildBookDepthVolume(world(), NOW);
  assert.equal(r.verdict, "no_data");
  assert.equal(r.rows, 0);
  assert.ok(bookDepthVolumeLine(r).includes("ДАННЫХ НЕТ"));
});

// ГЛАВНЫЙ ТЕСТ. Снимков много, входов много — но они про РАЗНЫЕ рынки, и пересечение пусто.
// Голый COUNT(*) сказал бы «данных море»; вердикт обязан сказать «копим».
test("большой объём при нулевом пересечении с входами = КОПИМ, а не «можно строить»", () => {
  const db = world();
  match(db, "m1");
  for (let i = 0; i < 400; i++) book(db, "m1", "Over 2.5", `2026-08-10T${String(i % 24).padStart(2, "0")}:00:00Z`);
  for (let i = 0; i < MIN_MATCHED_ENTRIES + 5; i++) entry(db, "m1", "BTTS", "2026-08-10T12:00:00Z");
  const r = buildBookDepthVolume(db, NOW);
  assert.ok(r.rows >= 400);
  assert.equal(r.overreaction.entriesWithBook, 0);
  assert.equal(r.verdict, "accumulate");
  assert.ok(r.criterion.includes("ПРИГОДНОСТЬ"));
});

test("окно сопоставления работает по ВРЕМЕНИ: книга того же рынка, но давняя, входу не засчитывается", () => {
  const db = world();
  match(db, "m1");
  entry(db, "m1", "Over 2.5", "2026-08-10T12:00:00Z");
  book(db, "m1", "Over 2.5", "2026-08-10T12:05:00Z");                                   // внутри окна
  entry(db, "m1", "Under 1.5", "2026-08-10T12:00:00Z");
  book(db, "m1", "Under 1.5", `2026-08-10T${12 + Math.ceil(MATCH_WINDOW_MIN / 60) + 1}:00:00Z`); // далеко за окном
  const r = buildBookDepthVolume(db, NOW);
  assert.equal(r.overreaction.entries, 2);
  assert.equal(r.overreaction.entriesWithBook, 1);
});

test("критерий выполнен по ОБОИМ порогам — и по входам, и по числу разных матчей", () => {
  const db = world();
  for (let i = 0; i < MIN_MATCHES; i++) {
    const mid = `m${i}`; match(db, mid);
    for (let k = 0; k < Math.ceil(MIN_MATCHED_ENTRIES / MIN_MATCHES); k++) {
      entry(db, mid, "Over 2.5", "2026-08-10T12:00:00Z");
    }
    book(db, mid, "Over 2.5", "2026-08-10T12:03:00Z");
  }
  const r = buildBookDepthVolume(db, NOW);
  assert.ok(r.overreaction.entriesWithBook >= MIN_MATCHED_ENTRIES, `входов с книгой ${r.overreaction.entriesWithBook}`);
  assert.equal(r.overreaction.matchesWithBook, MIN_MATCHES);
  assert.equal(r.verdict, "build_measured");
  assert.ok(bookDepthVolumeLine(r).includes("МОЖНО СТРОИТЬ"));
});

// Один вечер выборкой не является — даже когда входов формально хватает.
test("входов достаточно, но все из одного матча — критерий по матчам не даёт вынести «можно строить»", () => {
  const db = world();
  match(db, "m1");
  for (let i = 0; i < MIN_MATCHED_ENTRIES + 10; i++) entry(db, "m1", "Over 2.5", "2026-08-10T12:00:00Z");
  book(db, "m1", "Over 2.5", "2026-08-10T12:01:00Z");
  const r = buildBookDepthVolume(db, NOW);
  assert.ok(r.overreaction.entriesWithBook >= MIN_MATCHED_ENTRIES);
  assert.equal(r.overreaction.matchesWithBook, 1);
  assert.equal(r.verdict, "accumulate");
});

// ── захват на филле ────────────────────────────────────────────────────────────────────────────

test("захват на филле пишет книгу и считается ОТДЕЛЬНЫМ источником — это несмещённая выборка", () => {
  const db = world(); match(db, "m1");
  const cap = makeFillCapture(db, "2026-08-10T12:00:00Z");
  captureFillBook(cap, { matchId: "m1", token: "tok1", label: "Over 2.5" },
    { status: "ok", book: { bids: [{ priceCents: 49, size: 100 }], asks: [{ priceCents: 51, size: 100 }] } }, "fill_entry");
  const r = buildBookDepthVolume(db, NOW);
  assert.equal(r.overreaction.onFillRows, 1);
  assert.ok(r.bySource.some((s) => s.source === "fill_entry"));
});

test("дедуп: близнецы одного токена в одном цикле дают ОДНУ запись, а не две", () => {
  const db = world(); match(db, "m1");
  const cap = makeFillCapture(db, "2026-08-10T12:00:00Z");
  const t = { matchId: "m1", token: "tok1", label: "Over 2.5" };
  const bk = { status: "ok", book: { bids: [{ priceCents: 49, size: 100 }], asks: [{ priceCents: 51, size: 100 }] } };
  captureFillBook(cap, t, bk, "fill_entry");
  captureFillBook(cap, t, bk, "fill_entry");
  assert.equal(buildBookDepthVolume(db, NOW).rows, 1);
});

// Пустая книга — ФАКТ ёмкости («налить было нечем»); недоступная — НАША слепота и молчание.
test("пустая книга пишется нулём, недоступная не пишется вовсе", () => {
  const db = world(); match(db, "m1");
  const cap = makeFillCapture(db, "2026-08-10T12:00:00Z");
  captureFillBook(cap, { matchId: "m1", token: "tokA", label: "A" }, { status: "empty" }, "fill_entry");
  captureFillBook(cap, { matchId: "m1", token: "tokB", label: "B" }, { status: "unavailable" }, "fill_entry");
  const r = buildBookDepthVolume(db, NOW);
  assert.equal(r.rows, 1);
  assert.equal(r.emptyRows, 1);
  assert.ok(r.bySource.some((s) => s.source === "fill_entry_empty"));
});

test("без контекста захвата ничего не пишется — путь решения остаётся нетронутым", () => {
  const db = world(); match(db, "m1");
  captureFillBook(undefined, { matchId: "m1", token: "tok1", label: "A" }, { status: "ok", book: { bids: [], asks: [] } }, "fill_entry");
  assert.equal(buildBookDepthVolume(db, NOW).rows, 0);
});
