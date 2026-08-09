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
import { recordPlaceholderCuts, checkPlaceholderFalseCuts, buildFalseCutReport, falseCutLine, MATURITY_MIN, VERDICT_MIN_CHECKED } from "../src/lib/placeholderFalseCut.js";
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
    mkt({ label: "Total Sets: Under 2.5", price: 50, ask_cents: null, spread_cents: null }), // книги нет вовсе
  ];
  const v = structuralPlaceholders(markets);
  assert.equal(v.length, 1);
  assert.equal(recordPlaceholderCuts(db, "m1", v, markets, moneylineOf(markets), T0), 1);
  const row = db.prepare(`SELECT * FROM placeholder_cuts`).get() as any;
  assert.equal(row.path, "no_book");
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
  const markets = [mkt({ label: "X", price: 50, ask_cents: null, spread_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  board(db, "m1", later(5), [{ label: "X", price: 72 }]);
  assert.deepEqual(checkPlaceholderFalseCuts(db, { now: () => later(MATURITY_MIN - 1) }), { checked: 0, falseCuts: 0 });
});

test("ПУТИ РАЗЛИЧИМЫ, включая UNQUOTED_SPREAD: подозрение адресуется КОНКРЕТНОМУ порогу", () => {
  const db = db0();
  const markets = [
    mkt({ label: "Warsaw: A vs B", price: 80, ask_cents: 81 }),
    mkt({ label: "no-book", price: 50, ask_cents: null, spread_cents: null }),
    mkt({ label: "wide", price: 50, ask_cents: 60, spread_cents: 25 }),   // спред 25 ≥ 20
    mkt({ label: "ml-says-no", price: 50, ask_cents: 51, spread_cents: 2 }), // книга котирована, но манилайн 80
  ];
  const v = structuralPlaceholders(markets);
  assert.deepEqual(v.map((x) => x.path).sort(), ["moneyline_contradicts", "no_book", "wide_spread"]);
  recordPlaceholderCuts(db, "m1", v, markets, moneylineOf(markets), T0);
  const rep = buildFalseCutReport(db, T0);
  assert.deepEqual(rep.paths.map((p) => [p.path, p.cuts]),
    [["no_book", 1], ["no_ask_ml", 0], ["wide_spread", 1], ["moneyline_contradicts", 1], ["no_ask", 0]],
    "устаревший путь стоит в конце и виден даже пустым — он основание правки");
  // Порог назван поимённо — иначе «правило ошибается» не превращается в работу.
  assert.match(rep.paths.find((p) => p.path === "wide_spread")!.threshold, /UNQUOTED_SPREAD_CENTS = 20¢/);
  assert.match(rep.paths.find((p) => p.path === "moneyline_contradicts")!.threshold, /ML_SKEW_MIN_CENTS = 15¢/);
  assert.match(rep.paths.find((p) => p.path === "no_book")!.threshold, /сам под наблюдением/);
});

test("СТОРОЖ СОБСТВЕННОЙ СЛЕПОТЫ: непроверенный путь даёт null, а не 0% — иначе он чище проверенного", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null, spread_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  const rep = buildFalseCutReport(db, T0);
  const p = rep.paths.find((x) => x.path === "no_book")!;
  assert.equal(p.cuts, 1);
  assert.equal(p.checked, 0);
  assert.equal(p.falseCutPct, null, "доля без знаменателя не печатается");
  assert.match(p.note, /НЕ ИЗМЕРЕНА \(не «ноль»\)/);
  assert.equal(rep.verdict, "unmeasured");
  assert.ok(!/чисто/.test(rep.note), "пустой сторож не оправдывает правило");
});

test("«чисто» ДОСТИЖИМО: набрали выборку, ни один рынок не ожил — правило оправдано числом", () => {
  const db = db0();
  const labels = Array.from({ length: VERDICT_MIN_CHECKED }, (_, i) => `X${i}`);
  const markets = labels.map((l) => mkt({ label: l, price: 50, ask_cents: null, spread_cents: null }));
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  board(db, "m1", later(MATURITY_MIN + 5), labels.map((l) => ({ label: l, price: 52 })));  // не ожили: 2¢ < 10¢
  checkPlaceholderFalseCuts(db, { now: () => later(MATURITY_MIN + 10) });
  const rep = buildFalseCutReport(db, T0);
  assert.equal(rep.totals.checked, VERDICT_MIN_CHECKED);
  assert.equal(rep.verdict, "clean");
  assert.equal(rep.paths.find((x) => x.path === "no_book")!.falseCutPct, 0);
});

test("рынок исчез с доски — это НЕ «срез верен»: строка ждёт дальше", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null, spread_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  board(db, "m1", later(MATURITY_MIN + 5), [{ label: "ДРУГОЙ", price: 70 }]);
  assert.deepEqual(checkPlaceholderFalseCuts(db, { now: () => later(MATURITY_MIN + 10) }), { checked: 0, falseCuts: 0 });
  assert.equal((db.prepare(`SELECT false_cut f FROM placeholder_cuts`).get() as any).f, null, "неизвестное осталось неизвестным");
});

test("повторный срез не плодит строк и не пересчитывает замороженную цену", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null, spread_cents: null })];
  const v = structuralPlaceholders(markets);
  recordPlaceholderCuts(db, "m1", v, markets, null, T0);
  const drifted = [mkt({ label: "X", price: 50.4, ask_cents: null, spread_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(drifted), drifted, null, later(20));
  const rows = db.prepare(`SELECT cut_cents, cut_at FROM placeholder_cuts`).all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cut_cents, 50, "первый срез заморожен — сторож не судит себя по собственному следствию");
});

test("строка еженедельника печатает непроверенное словом, а не нулём", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null, spread_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  assert.match(falseCutLine(buildFalseCutReport(db, T0)), /no_book 0\/— из 1/);
});

// [ПОПРАВКА 08.08] Первый прод-замер дал checked=1, falseCuts=0 — и отчёт объявил «чисто». Вердикт на
// ОДНОМ наблюдении: то же, за что мы наказываем гипотезы, только со знаком оправдания. Асимметрия ниже
// намеренная: оправдание требует выборки, обвинение — нет.
test("«чисто» требует ВЫБОРКИ: один дозревший срез вердиктом не является", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null, spread_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  board(db, "m1", later(MATURITY_MIN + 5), [{ label: "X", price: 52 }]);
  checkPlaceholderFalseCuts(db, { now: () => later(MATURITY_MIN + 10) });
  const rep = buildFalseCutReport(db, T0);
  assert.equal(rep.totals.checked, 1);
  assert.equal(rep.verdict, "unmeasured", "одно наблюдение не оправдывает правило");
  assert.match(rep.note, new RegExp(`дозрело 1 из нужных ${VERDICT_MIN_CHECKED}`));
  assert.ok(!/^чисто/.test(rep.note));
});

test("ОБВИНЕНИЕ порога не имеет: один ложный срез называется сразу", () => {
  const db = db0();
  const markets = [mkt({ label: "X", price: 50, ask_cents: null, spread_cents: null })];
  recordPlaceholderCuts(db, "m1", structuralPlaceholders(markets), markets, null, T0);
  board(db, "m1", later(MATURITY_MIN + 5), [{ label: "X", price: 72 }]);   // ожил
  checkPlaceholderFalseCuts(db, { now: () => later(MATURITY_MIN + 10) });
  const rep = buildFalseCutReport(db, T0);
  assert.equal(rep.verdict, "suspect", "улика не ждёт выборки");
  assert.match(rep.note, /ЛОЖНЫЕ СРЕЗЫ ЕСТЬ/);
});

// ============================================================
// [08.08, РАТИФИЦИРОВАНО ПО УЛИКЕ СТОРОЖА] «АСКА НЕТ» ОДИН НЕ РЕЖЕТ.
// Замер: путь `no_ask` дал 6 ложных из 36 проверенных (16.7%) на магистральных футбольных тоталах
// (Under 3.5 / Over 3.5), позже ушедших от 50¢ дальше 10¢ — книга была живая. Отсутствие аска в НАШЕМ
// снимке говорит о полноте наших данных, а не о книге биржи.
// ============================================================

test("ИМЕННОЙ СЛУЧАЙ ЗАМЕРА: тотал без аска, но со спредом и без перекоса — НЕ режется", () => {
  const markets = [
    mkt({ label: "Chelsea vs Arsenal", price: 52, ask_cents: 53 }),          // манилайн ровный: перекос 2¢ < 15¢
    mkt({ label: "Under 3.5", price: 50, ask_cents: null, spread_cents: 3 }), // ровно тот случай, что срезался ложно
    mkt({ label: "Over 3.5", price: 50, ask_cents: null, spread_cents: 3 }),
  ];
  assert.deepEqual(structuralPlaceholders(markets), [], "одного молчания аска мало — это факт нашей выгрузки, не рынка");
});

test("аск молчит, но манилайн перекошен — ВТОРАЯ улика есть, срез законен", () => {
  const markets = [
    mkt({ label: "Bayern vs Bochum", price: 88, ask_cents: 89 }),             // перекос 38¢ ≥ 15¢
    mkt({ label: "Under 3.5", price: 50, ask_cents: null, spread_cents: 3 }),
  ];
  const v = structuralPlaceholders(markets);
  assert.deepEqual(v.map((x) => x.path), ["no_ask_ml"]);
  assert.match(v[0]!.note, /одного отсутствия аска мало/);
});

test("книги нет НИ ПО ОДНОМУ полю — единственное, что режет в одиночку, и оно под наблюдением", () => {
  const markets = [mkt({ label: "Under 3.5", price: 50, ask_cents: null, spread_cents: null })];
  const v = structuralPlaceholders(markets);
  assert.deepEqual(v.map((x) => x.path), ["no_book"], "молчат оба поля — это уже не пробел одного");
  // Поблажка НЕ обоснована замером, поэтому судится ОТДЕЛЬНЫМ путём: окажется ложной — будет видно числом.
  const db = db0();
  recordPlaceholderCuts(db, "m1", v, markets, null, T0);
  assert.equal(buildFalseCutReport(db, T0).paths.find((p) => p.path === "no_book")!.cuts, 1);
});

test("ИСТОРИЯ НЕ СТИРАЕТСЯ: устаревший путь остаётся виден как основание правки", () => {
  const db = db0();
  // Строка, записанная СТАРЫМ правилом: путь `no_ask`, ложный срез.
  db.prepare(`INSERT INTO placeholder_cuts(id,match_id,market_label,reason,path,cut_cents,cut_at,later_cents,later_at,false_cut)
              VALUES(?,?,?,?,?,?,?,?,?,1)`).run(R.uid(), "m1", "Under 3.5", "unquoted_book", "no_ask", 50, T0, 72, later(60));
  const rep = buildFalseCutReport(db, T0);
  const legacy = rep.paths.find((p) => p.path === "no_ask")!;
  assert.equal(legacy.cuts, 1, "строка старого правила НЕ выброшена из отчёта");
  assert.match(legacy.threshold, /УСТАРЕЛ 08\.08/);
  // …но вердикт о ДЕЙСТВУЮЩЕМ правиле она не выносит: иначе снятое правило вечно обвиняло бы живое.
  assert.equal(rep.totals.cuts, 0);
  assert.equal(rep.verdict, "unmeasured");
  assert.equal(rep.totals.legacyFalseCuts, 1);
  assert.match(falseCutLine(rep), /устар\. no_ask: 1 ложных из 1 — улика, по которой правило правили/);
});

// ============================================================
// РЕТРО-ПРОВЕРКА ПРАВКИ НА ТОЙ УЛИКЕ, ЧТО ЕЁ ВЫЗВАЛА. У сужения правила ДВЕ стороны, и обе измеримы из
// уже записанных полей среза. Отчёт, показывающий только спасённые ложные срезы и молчащий про
// потерянные верные, — реклама правки, а не её замер.
// ============================================================
const cutRow = (db: ReturnType<typeof db0>, o: { ask: number | null; spread: number | null; ml: number | null; wasFalse: boolean }) =>
  db.prepare(`INSERT INTO placeholder_cuts(id,match_id,market_label,reason,path,cut_cents,ask_cents,spread_cents,ml_cents,cut_at,later_cents,later_at,false_cut)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(R.uid(), "m1", `L${R.uid()}`, "unquoted_book", "no_ask", 50, o.ask, o.spread, o.ml, T0, o.wasFalse ? 72 : 51, later(60), o.wasFalse ? 1 : 0);

test("РЕТРО СЧИТАЕТ ОБЕ СТОРОНЫ: спасённые ложные И потерянные верные", () => {
  const db = db0();
  cutRow(db, { ask: null, spread: 3, ml: 50, wasFalse: true });   // ложный, новое правило пропустит → спасли
  cutRow(db, { ask: null, spread: 3, ml: 50, wasFalse: false });  // ВЕРНЫЙ, но тоже пропустит → цена
  cutRow(db, { ask: null, spread: null, ml: 50, wasFalse: false }); // no_book → срежет и дальше
  cutRow(db, { ask: 51, spread: 2, ml: 88, wasFalse: false });      // манилайн перекошен → срежет
  const rt = buildFalseCutReport(db, T0).retro!;
  assert.equal(rt.rows, 4);
  assert.deepEqual({ a: rt.avoidedFalse, l: rt.lostTrue, k: rt.keptTrue, f: rt.keptFalse }, { a: 1, l: 1, k: 2, f: 0 });
  assert.match(rt.note, /ИЗБЕЖАЛО ложных 1 из 1/);
  assert.match(rt.note, /ЦЕНА: потеряно верных срезов 1/);
});

test("СТОРОЖ ПЕРЕПРАВКИ: если ни один верный срез не выжил — правило выключено, и это сказано прямо", () => {
  const db = db0();
  cutRow(db, { ask: null, spread: 3, ml: 50, wasFalse: true });
  cutRow(db, { ask: null, spread: 3, ml: 50, wasFalse: false });
  cutRow(db, { ask: null, spread: 3, ml: 50, wasFalse: false });
  const rt = buildFalseCutReport(db, T0).retro!;
  assert.equal(rt.keptTrue, 0);
  assert.match(rt.note, /ПРАВИЛО ВЫКЛЮЧЕНО ЦЕЛИКОМ/);
  assert.match(rt.note, /Фантом променян на потерю/);
});

test("недозревшие в ретро не идут: судить по неизвестному нельзя", () => {
  const db = db0();
  db.prepare(`INSERT INTO placeholder_cuts(id,match_id,market_label,reason,path,cut_cents,ask_cents,spread_cents,ml_cents,cut_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`).run(R.uid(), "m1", "нов", "unquoted_book", "no_book", 50, null, null, null, T0);
  assert.equal(buildFalseCutReport(db, T0).retro, null, "нет дозревших — ретро молчит, а не показывает нули");
});

// [08.08, ЗАМЕР ПРОТИВ МЕНЯ] Ретро на проде: 58 из 58 срезов остались бы срезанными, избежали 0 ложных
// из 10. Правка оказалась ИНЕРТНОЙ на той самой улике, что её вызвала — поблажка `no_book`, которую я сам
// пометил как необоснованную замером, проглотила все случаи. Разбивка по ветке существует затем, чтобы
// «правка не сработала» превратилось в адрес, а не в «сузим ещё».
test("ПРАВКА ИНЕРТНА — сказано прямо, и названа ветка, которая всё глотает", () => {
  const db = db0();
  for (let i = 0; i < 3; i++) cutRow(db, { ask: null, spread: null, ml: 50, wasFalse: i === 0 });
  const rt = buildFalseCutReport(db, T0).retro!;
  assert.equal(rt.stillCut, 3);
  assert.equal(rt.avoidedFalse, 0);
  assert.match(rt.note, /ПРАВКА ИНЕРТНА на этой улике/);
  assert.deepEqual(rt.byNewPath, [{ path: "no_book", n: 3, falseCuts: 1, falseCutPct: 33.3 }]);
});

test("ветка с корроборацией отделена от поблажки: адрес виден, а не «правило вообще»", () => {
  const db = db0();
  cutRow(db, { ask: null, spread: null, ml: 50, wasFalse: true });   // поблажка no_book — срежет
  cutRow(db, { ask: null, spread: 3, ml: 88, wasFalse: false });     // корроборация no_ask_ml — срежет
  cutRow(db, { ask: null, spread: 3, ml: 50, wasFalse: true });      // ни того, ни другого — ПРОПУСТИТ
  const rt = buildFalseCutReport(db, T0).retro!;
  const m = Object.fromEntries(rt.byNewPath.map((x) => [x.path, [x.n, x.falseCuts]]));
  assert.deepEqual(m, { no_book: [1, 1], no_ask_ml: [1, 0] }, "ветки названы порознь — предложение будет адресным");
  assert.equal(rt.avoidedFalse, 1);
  // «Инертна» — про ИСХОДЫ, а не про маршрут: здесь один срез исчез, значит правка что-то изменила.
  assert.ok(!/ПРАВКА ИНЕРТНА/.test(rt.note));
});

test("«инертна» судит ИСХОДЫ, а не маршруты: разные ветки при тех же срезах — всё равно инертна", () => {
  const db = db0();
  cutRow(db, { ask: null, spread: null, ml: 50, wasFalse: true });   // no_book
  cutRow(db, { ask: null, spread: 3, ml: 88, wasFalse: false });     // no_ask_ml
  const rt = buildFalseCutReport(db, T0).retro!;
  assert.equal(rt.stillCut, 2);
  assert.match(rt.note, /ПРАВКА ИНЕРТНА/, "переименовать путь не значит изменить решение");
});
