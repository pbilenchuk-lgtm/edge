// ============================================================
// СТОРОЖ ЛОЖНЫХ СРЕЗОВ #121 — ПРИБОР, А НЕ ОПРЕДЕЛЕНИЕ
//
// `falseCut` существовала с деплоя #121, была покрыта тестом — и НИГДЕ НЕ ВЫЗЫВАЛАСЬ. Тест на чистую
// функцию доказывает, что она посчитает верно, ЕСЛИ её позовут, и ничего не говорит о том, зовут ли.
// Поэтому первый тест здесь — ПРОВОДКА: срез обязан оставлять строку, а `checkPlaceholderFalseCuts` —
// её судить. Остальные держат три свойства: три пути различимы, непроверенное не выдаётся за чистое,
// и вердикт «чисто» невозможен на пустом сторожe.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { structuralPlaceholders, moneylineOf } from "../src/lib/placeholderStructural.js";
import { recordPlaceholderCuts, checkPlaceholderFalseCuts, buildFalseCutReport, falseCutLine, MATURITY_MIN } from "../src/lib/placeholderFalseCut.js";
import type { Market } from "../src/lib/types.js";

const T0 = "2026-08-07T10:00:00.000Z";
const later = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

const db0 = () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: T0 } as never);
  R.insertMatch(db, { id: "m1", competition_id: "atp", home: "A", away: "B", state: "upcoming", lineup_out: false,
    kickoff_at: T0, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null,
    end_time: null, duration: null, end_note: null, external_ref: "m1" } as never);
  return db;
};

function mkt(o: Partial<Market> & { label: string; price: number }): Market {
  return { id: R.uid(), match_id: "m1", label: o.label, price: o.price, ai_prob: null, liquidity: null,
    external_ref: null, snapshot_at: T0, is_closing: false,
    ask_cents: o.ask_cents === undefined ? 51 : o.ask_cents, spread_cents: o.spread_cents === undefined ? 2 : o.spread_cents } as Market;
}
/** Кладёт доску в БД, чтобы дозревание читало ТЕКУЩУЮ цену тем же путём, что прод. */
function board(db: ReturnType<typeof db0>, matchId: string, at: string, rows: { label: string; price: number }[]) {
  for (const r of rows)
    db.prepare(`INSERT INTO markets(id,match_id,label,price,ai_prob,liquidity,external_ref,snapshot_at,is_closing)
                VALUES(?,?,?,?,?,?,?,?,0)`).run(R.uid(), matchId, r.label, r.price, null, null, null, at);
}

test("ПРОВОДКА: срез оставляет строку, дозревание её судит — сторож вызван, а не только определён", () => {
  const db = db0();
  const markets = [
    mkt({ label: "Warsaw: A vs B", price: 80, ask_cents: 81 }),          // манилайн, перекос 30¢
    mkt({ label: "Total Sets: Under 2.5", price: 50, ask_cents: null }), // нет аска
  ];
  const v = structuralPlaceholders(markets);
  assert.equal(v.length, 1);
  assert.equal(recordPlaceholderCuts(db, "m1", v, markets, moneylineOf(markets), T0), 1);
  const row = db.prepare(`SELECT * FROM placeholder_cuts`).get() as any;
  assert.equal(row.path, "no_ask");
  assert.equal(row.cut_cents, 50);
  assert.equal(row.ml_cents, 80, "манилайн заморожен вместе со срезом");
  assert.equal(row.false_cut, null, "до дозревания вердикта нет");

  // Рынок ОЖИЛ: ушёл на 72¢ — значит книга была живая, а срез ложный.
  board(db, "m1", later(MATURITY_MIN + 5), [{ label: "Total Sets: Under 2.5", price: 72 }]);
  const r = checkPlaceholderFalseCuts(db, { now: () => later(MATURITY_MIN + 10) });
  assert.deepEqual(r, { checked: 1, falseCuts: 1 });
  assert.equal((db.prepare(`SELECT false_cut f FROM placeholder_cuts`).get() as any).f, 1);
});

test("незрелый срез не судится: раньше выдержки поздняя цена — та же цена", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  board(db, "m1", later(5), [{ label: "X", price: 72 }]);
  assert.deepEqual(checkPlaceholderFalseCuts(db, { now: () => later(MATURITY_MIN - 1) }), { checked: 0, falseCuts: 0 });
});

test("ТРИ ПУТИ РАЗЛИЧИМЫ, включая UNQUOTED_SPREAD: подозрение адресуется КОНКРЕТНОМУ порогу", () => {
  const db = db0();
  const markets = [
    mkt({ label: "Warsaw: A vs B", price: 80, ask_cents: 81 }),
    mkt({ label: "no-ask", price: 50, ask_cents: null }),
    mkt({ label: "wide", price: 50, ask_cents: 60, spread_cents: 25 }),   // спред 25 ≥ 20
    mkt({ label: "ml-says-no", price: 50, ask_cents: 51, spread_cents: 2 }), // книга котирована, но манилайн 80
  ];
  const v = structuralPlaceholders(markets);
  assert.deepEqual(v.map((x) => x.path).sort(), ["moneyline_contradicts", "no_ask", "wide_spread"]);
  recordPlaceholderCuts(db, "m1", v, markets, moneylineOf(markets), T0);
  const rep = buildFalseCutReport(db, T0);
  assert.deepEqual(rep.paths.map((p) => [p.path, p.cuts]), [["no_ask", 1], ["wide_spread", 1], ["moneyline_contradicts", 1]]);
  // Порог назван поимённо — иначе «правило ошибается» не превращается в работу.
  assert.match(rep.paths.find((p) => p.path === "wide_spread")!.threshold, /UNQUOTED_SPREAD_CENTS = 20¢/);
  assert.match(rep.paths.find((p) => p.path === "moneyline_contradicts")!.threshold, /ML_SKEW_MIN_CENTS = 15¢/);
  assert.match(rep.paths.find((p) => p.path === "no_ask")!.threshold, /нашего числа здесь нет/);
});

test("СТОРОЖ СОБСТВЕННОЙ СЛЕПОТЫ: непроверенный путь даёт null, а не 0% — иначе он чище проверенного", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  const rep = buildFalseCutReport(db, T0);
  const p = rep.paths.find((x) => x.path === "no_ask")!;
  assert.equal(p.cuts, 1);
  assert.equal(p.checked, 0);
  assert.equal(p.falseCutPct, null, "доля без знаменателя не печатается");
  assert.match(p.note, /НЕ ИЗМЕРЕНА \(не «ноль»\)/);
  assert.equal(rep.verdict, "unmeasured");
  assert.ok(!/чисто/.test(rep.note), "пустой сторож не оправдывает правило");
});

test("вердикт «чисто» возможен ТОЛЬКО после дозревания", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  board(db, "m1", later(MATURITY_MIN + 5), [{ label: "X", price: 52 }]);  // не ожил: 2¢ < 10¢
  checkPlaceholderFalseCuts(db, { now: () => later(MATURITY_MIN + 10) });
  const rep = buildFalseCutReport(db, T0);
  assert.equal(rep.verdict, "clean");
  assert.equal(rep.paths.find((x) => x.path === "no_ask")!.falseCutPct, 0);
});

test("рынок исчез с доски — это НЕ «срез верен»: строка ждёт дальше", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  board(db, "m1", later(MATURITY_MIN + 5), [{ label: "ДРУГОЙ", price: 70 }]);
  assert.deepEqual(checkPlaceholderFalseCuts(db, { now: () => later(MATURITY_MIN + 10) }), { checked: 0, falseCuts: 0 });
  assert.equal((db.prepare(`SELECT false_cut f FROM placeholder_cuts`).get() as any).f, null, "неизвестное осталось неизвестным");
});

test("повторный срез не плодит строк и не пересчитывает замороженную цену", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null })];
  const v = structuralPlaceholders(markets);
  recordPlaceholderCuts(db, "m1", v, markets, null, T0);
  const drifted = [mkt({ label: "X", price: 50.4, ask_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(drifted), drifted, null, later(20));
  const rows = db.prepare(`SELECT cut_cents, cut_at FROM placeholder_cuts`).all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cut_cents, 50, "первый срез заморожен — сторож не судит себя по собственному следствию");
});

test("строка еженедельника печатает непроверенное словом, а не нулём", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  assert.match(falseCutLine(buildFalseCutReport(db, T0)), /no_ask 0\/— из 1/);
});
