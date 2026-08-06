// ============================================================
// EDGE LAB — T3: КОНВЕНЦИЯ ПРОВЕРЯЕТСЯ, А НЕ ОБЪЯВЛЯЕТСЯ
//
// Свойства, ради которых модуль написан:
//   1. КОНТРОЛЬ ВЕТИРУЕТ ВЫВОД. Манилайн проверяет не гипотезу, а инструмент: цену→исход и ориентацию
//      подписи. Разошёлся контроль — никакого вердикта о конвенции, даже если тест идеально чист.
//   2. ЕДИНИЦА — МАТЧ. Два гандикап-пропа одного матча решаются одним счётом: ОДНО испытание.
//   3. СЕРЕДИНА ЦЕНЫ — «нет исхода», а не округление к ближнему краю.
//   4. НЕДОБОР — ОТСУТСТВИЕ ЗАМЕРА, а не разрешение.
//
// Подписи в фикстурах — РЕАЛЬНОЙ формы с прода («Турнир: A vs B Set Handicap +/-1.5»). Первая версия
// контроля стояла на подписях с явным «(-1.5)», и перепись прода показала, что таких НЕТ НИ ОДНОЙ:
// контроль был бы пуст по построению, а его пустоту я бы прочитал как «данных мало».
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildSetHandicapConvention as verdictOf, observeFromSnapshots, setHandicapConventionLine, priceSideIsLabelFirst, SHC_CONTROL_MIN, SHC_TEST_MIN_MATCHES } from "../src/lib/setHandicapConvention.js";
import { recordShcObservations } from "../src/lib/shcJournal.js";

// ВЕРДИКТ ЧИТАЕТСЯ ИЗ ЖУРНАЛА (O8): наблюдение сначала замораживается, потом судится. Тесты идут тем же
// путём, что и прод, — иначе они проверяли бы конструкцию, которой в проде нет.
function buildSetHandicapConvention(db: ReturnType<typeof world>) {
  recordShcObservations(db, "2026-08-04T12:00:00Z");
  return verdictOf(db);
}

function world() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 1000, external_league: null, created_at: "2026-07-01" } as never);
  return db;
}

const P1 = "Carlos Alcaraz", P2 = "Jannik Sinner";
const ML = `Canadian Open: ${P1} vs ${P2}`;
const HCAP = `Canadian Open: ${P1} vs ${P2} Set Handicap +/-1.5`;

/**
 * Один сыгранный матч. `favP1` — фаворит по СТАРТОВОЙ цене скаута; `setsP1/setsP2` — финальный счёт;
 * `mlPrice` — последняя цена манилайна (= P(первого в подписи)); `hcapPrice` — то же для гандикапа.
 * Первый в подписи здесь всегда p1 — ориентацию двигаем через favP1 и счёт.
 */
function played(
  db: ReturnType<typeof world>, i: number,
  o: { favP1: boolean; setsP1: number; setsP2: number; mlPrice?: number | null; hcapPrice?: number | null; outcomeFirst?: string | null },
) {
  const id = `m${i}`;
  const day = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10);
  R.insertMatch(db, { id, competition_id: "atp", home: P1, away: P2, state: "finished", lineup_out: false, kickoff_at: `${day}T10:00:00Z`, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as never);
  const snap = (at: string, p1c: number | null, s1: number, s2: number) => R.insertTennisSnapshot(db, {
    event_key: `ek${i}-${at}`, provider: "apitennis", batch_at: at, p1: P1, p2: P2,
    tournament: "ATP", event_type: "ATP Singles", live: 1, status: "Set 1", sets_p1: s1, sets_p2: s2,
    set_num: 1, games_p1: 0, games_p2: 0, game_points: null, server: null, pm_match_id: id,
    pm_mid_cents: p1c, pm_p1_cents: p1c, pm_p2_cents: p1c == null ? null : 100 - p1c, raw: null,
  });
  snap(`${day}T10:00:00Z`, o.favP1 ? 70 : 30, 0, 0);   // стартовая цена → фаворит
  snap(`${day}T13:00:00Z`, null, o.setsP1, o.setsP2);  // финальный счёт
  // `outcome_first` — имя исхода, чью вероятность несёт цена (markets.outcome_first). В фикстурах по
  // умолчанию это ПЕРВЫЙ в подписи; переворот и отсутствие имени проверяются отдельными тестами.
  const mk = (label: string, price: number, sfx: string) => R.insertMarket(db, { id: `mk${i}${sfx}`, match_id: id, label, price, ai_prob: null, liquidity: 3000, external_ref: null, outcome_first: o.outcomeFirst === undefined ? P1 : o.outcomeFirst, outcome_second: P2, snapshot_at: `${day}T14:00:00Z`, is_closing: false } as never);
  if (o.mlPrice != null) mk(ML, o.mlPrice, "ml");
  if (o.hcapPrice != null) mk(HCAP, o.hcapPrice, "h");
}

/** N чистых контрольных матчей: p1 выигрывает 2:0, манилайн стоит 99¢ на первом в подписи. */
function cleanControl(db: ReturnType<typeof world>, n: number, from = 0) {
  for (let i = from; i < from + n; i++) played(db, i, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99 });
}

test("пороги ЗАФИКСИРОВАНЫ до данных", () => {
  assert.equal(SHC_CONTROL_MIN, 8);
  assert.equal(SHC_TEST_MIN_MATCHES, 8);
});

test("контроль не набран — вердикта НЕТ, и это названо отсутствием замера", () => {
  const db = world();
  cleanControl(db, 3);
  const r = buildSetHandicapConvention(db);
  assert.equal(r.verdict, "НЕ СОЗРЕЛО");
  assert.match(r.note, /гипотезу проверять НЕЧЕМ/);
});

test("контроль РАЗОШЁЛСЯ — вывода о конвенции нет, даже если тест идеально чист", () => {
  const db = world();
  cleanControl(db, 8);
  played(db, 50, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 1 }); // выиграл, а манилайн говорит обратное
  for (let i = 100; i < 110; i++) played(db, i, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 99 });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.controlMismatch, 1);
  assert.equal(r.testMismatch, 0, "тест чист");
  assert.ok(r.testMatches >= SHC_TEST_MIN_MATCHES, "и по объёму созрел");
  assert.equal(r.verdict, "МЕТОД НЕВЕРЕН", "но инструмент не проверен — гипотезу судить нельзя");
  assert.match(r.note, /Вердикта о конвенции НЕТ/);
});

test("одно расхождение теста ОПРОВЕРГАЕТ конвенцию — блок остаётся", () => {
  const db = world();
  for (let i = 100; i < 110; i++) played(db, i, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 99 });
  // Фаворит-первый выиграл 2:0 ⇒ правило (−1.5 на фаворите) ждёт покрытие; рынок говорит обратное.
  played(db, 120, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 2 });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.controlMismatch, 0);
  assert.equal(r.testMismatch, 1);
  assert.equal(r.verdict, "ОПРОВЕРГНУТА");
  assert.match(r.note, /флаг НЕ поднимается/);
});

test("чистый контроль + чистый тест на достаточном числе МАТЧЕЙ — подтверждена, с единицей у p", () => {
  const db = world();
  // Фаворит первый в подписи, 2:0 ⇒ −1.5 покрыт.
  for (let i = 100; i < 104; i++) played(db, i, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 97 });
  // Фаворит ВТОРОЙ в подписи (favP1=false), первый берёт матч 2:1 ⇒ у первого +1.5, он покрыт.
  for (let i = 200; i < 204; i++) played(db, i, { favP1: false, setsP1: 2, setsP2: 1, mlPrice: 98, hcapPrice: 96 });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.controlMismatch, 0);
  assert.equal(r.testMatches, 8);
  assert.equal(r.testMismatch, 0);
  assert.equal(r.verdict, "ПОДТВЕРЖДЕНА");
  assert.match(r.note, /на 8 матчах/, "p ОБЯЗАН называть свою единицу — ратифицированное правило класса");
  assert.match(r.note, /флаг поднимает ВЛАДЕЛЕЦ, не отчёт/);
});

test("фаворит выиграл, но 2:1 — −1.5 НЕ покрыт: правило проверяется, а не подгоняется", () => {
  const db = world();
  for (let i = 100; i < 110; i++) played(db, i, { favP1: true, setsP1: 2, setsP2: 1, mlPrice: 99, hcapPrice: 3 });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.testMismatch, 0, "цена 3¢ = «первый не покрыл», и правило предсказало ровно это");
  assert.equal(r.verdict, "ПОДТВЕРЖДЕНА");
});

test("цена в середине — «нет исхода», а не округление к ближнему краю", () => {
  const db = world();
  for (let i = 100; i < 110; i++) played(db, i, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 55 });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.testChecked, 0, "неразрешившиеся рынки в журнал НЕ попадают, значит и в счёт не идут");
  assert.equal(r.verdict, "НЕ СОЗРЕЛО");
  // Наблюдение из снимков всё равно объясняет, почему строки нет — «не судим», а не «наверное да».
  assert.match(observeFromSnapshots(db).rows.find((x) => x.group === "тест")!.note, /не судим, а не «наверное да»/);
});

test("ЕДИНИЦА — МАТЧ: два гандикап-пропа одного матча это ОДНО испытание", () => {
  const db = world();
  played(db, 100, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 99 });
  // Снимок цены — ДНЯ ЭТОГО МАТЧА. Прежняя фикстура ставила 01.07 матчу сотого дня, то есть цену
  // столетней давности; допуск разрыва «цена старше счёта» её теперь законно отсеивает.
  const day100 = new Date(Date.UTC(2026, 6, 1) + 100 * 86_400_000).toISOString().slice(0, 10);
  R.insertMarket(db, { id: "mk100b", match_id: "m100", label: `Canadian Open: ${P1} vs ${P2} Set Handicap 1.5`, price: 99, ai_prob: null, liquidity: 3000, external_ref: null, outcome_first: P1, outcome_second: P2, snapshot_at: `${day100}T14:00:00Z`, is_closing: false } as never);
  const r = buildSetHandicapConvention(db);
  assert.equal(r.testChecked, 2, "рынков два");
  assert.equal(r.testMatches, 1, "а испытание одно — счёт у них общий");
});

test("перепись подписей: неоднозначных против явных — цена блока в штуках", () => {
  const db = world();
  for (let i = 100; i < 103; i++) played(db, i, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 99 });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.ambiguousProps, 3);
  assert.equal(r.explicitProps, 0, "на реальных подписях прода явных нет ни одной");
  assert.match(setHandicapConventionLine(r), /неоднозначных 3 \/ явных 0/);
});

test("модуль read-only и флага не касается", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/setHandicapConvention.ts", import.meta.url), "utf8");
  for (const forbidden of ["metaSet", "insertBet", "updateBet", "UPDATE ", "INSERT ", "process.env.TENNIS_SET_HANDICAP_UNBLOCK"]) {
    assert.ok(!src.includes(forbidden), `проверка обязана только мерить, найдено «${forbidden}»`);
  }
});

// ── ПОЧЕМУ ТЕСТ НЕ НАБИРАЕТСЯ — ТОЖЕ ФАКТ ───────────────────────────────────────────────────────
// Первый прогон на проде: 13 из 15 гандикапов в «нет исхода», цены подозрительно круглые (25 и 50).
// «Не дозрело» и «не дозреет никогда» лечатся противоположно, поэтому причина МЕРЯЕТСЯ, а не
// объясняется догадкой: без токена цену переопрашивать нечем, а замороженная задолго до конца цена не
// может дойти до резолюции — тогда «нет исхода» значит «мы не смотрели», а не «рынок не решился».
test("незрелость объясняется числами: сколько без токена и насколько устарела цена", () => {
  const db = world();
  const i = 300;
  const day = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10);
  played(db, i, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99 });
  // Гандикап с ценой, снятой за 3 часа ДО последнего снимка скаута, и без токена.
  R.insertMarket(db, { id: `mk${i}old`, match_id: `m${i}`, label: HCAP, price: 25, ai_prob: null, liquidity: 3000, external_ref: null, outcome_first: P1, outcome_second: P2, snapshot_at: `${day}T10:00:00Z`, is_closing: false } as never);
  const r = buildSetHandicapConvention(db);
  const row = observeFromSnapshots(db).rows.find((x) => x.group === "тест")!;
  assert.equal(row.outcome, "нет исхода");
  assert.equal(row.hasToken, false, "без токена цену переопрашивать нечем");
  assert.equal(row.priceLagMin, 180, "цена старше последнего снимка на 3 часа");
  assert.equal(r.undecidedNoToken, 1);
  assert.equal(r.undecidedStalePrice, 1);
  assert.equal(r.undecidedMedianLagMin, 180);
  assert.match(r.note, /без токена 1, с ценой старше 30мин до конца матча 1/);
});

// ── АЛЬТЕРНАТИВА, ПОРОЖДЁННАЯ ДАННЫМИ, СУДИТСЯ ПО СОБСТВЕННОЙ ПРЕ-РЕГИСТРАЦИИ ────────────────────
// Созревший замер 03.08 опроверг «фаворит несёт −1.5» одним расхождением на 12 матчах при чистом
// контроле 27/27 — и те же данные оказались согласованы с «−1.5 ВСЕГДА у первого в подписи». Соблазн
// объявить вторую гипотезу подтверждённой на них же — ровно подгонка. Поэтому здесь держатся два
// свойства: считаются только РАЗЛИЧАЮЩИЕ матчи, и только те, что сыграны ПОСЛЕ фиксации.
test("совпадения там, где гипотезы предсказывают ОДНО И ТО ЖЕ, альтернативу не подтверждают", () => {
  const db = world();
  // Фаворит первый, 2:0 — обе гипотезы говорят «покрыл». Таких сколько угодно, доказывают они ноль.
  for (let i = 400; i < 412; i++) played(db, i, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 97 });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.rows.filter((x) => x.group === "тест" && x.discriminating).length, 0, "различающих нет");
  assert.equal(r.alt.discriminatingSince, 0);
  assert.equal(r.alt.verdict, "НЕ СОЗРЕЛО");
  assert.match(r.alt.note, /различающих матчей после/);
});

test("ретроспектива названа ретроспективой: породившие гипотезу матчи её не подтверждают", () => {
  const db = world();
  // Различающий случай: первый НЕ фаворит и разница ровно в один сет (как Parry — Day).
  // Даты этих матчей — ДО регистрации альтернативы.
  for (let i = 0; i < 6; i++) played(db, i, { favP1: false, setsP1: 1, setsP2: 2, mlPrice: 4, hcapPrice: 4 });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.alt.discriminatingRetro, 6, "шесть различающих — но все ДО фиксации");
  assert.equal(r.alt.mismatchRetro, 0, "и все согласованы с альтернативой");
  assert.equal(r.alt.discriminatingSince, 0, "после фиксации — ни одного");
  assert.equal(r.alt.verdict, "НЕ СОЗРЕЛО", "согласие ретроспективы вердикта НЕ даёт");
  assert.match(r.alt.note, /гипотезу ПОРОДИЛИ и подтвердить её не могут/);
  // И исходная гипотеза на этих же матчах опровергнута — ровно случай Parry — Day.
  assert.equal(r.testMismatch, 6);
});

test("незавершённый матч не судится НИ В ОДНОЙ группе — включая контроль", () => {
  // [T3-фикс 05.08] Прежняя версия этого теста утверждала обратное: «манилайн при ретайре разрешается
  // нормально — контроль остаётся». Прод опроверг: из четырёх контрольных расхождений замера 05.08 ДВА
  // были ровно `completed:false`. Матч, где никто не набрал победных сетов, не отвечает на вопрос «кто
  // выиграл» — ни для гандикапа, ни для манилайна. Кейс оставлен как регрессия к прежнему дефекту.
  const db = world();
  played(db, 500, { favP1: false, setsP1: 1, setsP2: 0, mlPrice: 99, hcapPrice: 99 }); // никто не набрал 2
  const r = buildSetHandicapConvention(db);
  assert.equal(r.rows.filter((x) => x.group === "тест").length, 0, "гандикап такого матча не судится");
  assert.equal(r.droppedIncomplete, 1, "и число выброшенных НАПЕЧАТАНО, а не спрятано");
  assert.equal(r.rows.filter((x) => x.group === "контроль").length, 0, "манилайн недоигранного матча тоже не судится");
});

test("[T3-фикс] цена СТАРШЕ счёта больше чем на тик — наблюдение к вердикту не допускается", () => {
  const db = world();
  cleanControl(db, 9);
  const clean = buildSetHandicapConvention(db);
  assert.ok(clean.controlChecked >= 8, "чистая выборка набирается");
  assert.equal(clean.refusedStalePrice, 0);

  // Тот же матч, но цена снята на шесть часов раньше счёта — ровно профиль четырёх расхождений прода
  // (медиана разрыва у согласных 5 минут, у расхождений 164).
  const db2 = world();
  cleanControl(db2, 9);
  const day = new Date(Date.UTC(2026, 6, 1) + 20 * 86_400_000).toISOString().slice(0, 10);
  R.insertMatch(db2, { id: "m20", competition_id: "atp", home: P1, away: P2, state: "finished", lineup_out: false, kickoff_at: `${day}T10:00:00Z`, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m20" } as never);
  const snap = (at: string, p1c: number | null, s1: number, s2: number) => R.insertTennisSnapshot(db2, {
    event_key: `ek20-${at}`, provider: "apitennis", batch_at: at, p1: P1, p2: P2,
    tournament: "ATP", event_type: "ATP Singles", live: 1, status: "Set 1", sets_p1: s1, sets_p2: s2,
    set_num: 1, games_p1: 0, games_p2: 0, game_points: null, server: null, pm_match_id: "m20",
    pm_mid_cents: p1c, pm_p1_cents: p1c, pm_p2_cents: p1c == null ? null : 100 - p1c, raw: null,
  });
  snap(`${day}T10:00:00Z`, 70, 0, 0);
  snap(`${day}T19:00:00Z`, null, 2, 0);                       // счёт — 19:00
  R.insertMarket(db2, { id: "mk20ml", match_id: "m20", label: ML, price: 99, ai_prob: null, liquidity: 3000, external_ref: null, outcome_first: P1, outcome_second: P2, snapshot_at: `${day}T13:00:00Z`, is_closing: false } as never); // цена — 13:00
  // Отказ происходит НА ЗАПИСИ: журнал append-only, и не заморозить плохую строку — единственный способ
  // её не иметь. Поэтому счётчик отказа приходит из шага журнала, а не из вердикта.
  const rec = recordShcObservations(db2, "2026-08-04T12:00:00Z");
  assert.ok(rec.skippedStalePrice >= 1, "несинхронное наблюдение не заморожено");
  assert.match(rec.note, /цена старше счёта/, "отказ НАПЕЧАТАН, а не спрятан");
  const r2 = verdictOf(db2);
  assert.equal(r2.controlChecked, clean.controlChecked, "и в контроль оно не попало");
});

test("[T3-фикс] строка с НЕИЗМЕРИМЫМ разрывом к вердикту не допускается — NULL это отказ, а не «свежо»", () => {
  const db = world();
  cleanControl(db, 9);
  const clean = buildSetHandicapConvention(db);
  // Прежняя строка журнала, чей провенанс не разбирается ⇒ разрыв восстановить нечем. Ровно такими были
  // все 173 строки замера 05.08: поле существовало, но не хранилось, и NULL читался как «свежо».
  R.insertShcObservation(db, {
    kind: "control", match_id: "m-legacy", label: ML, players: `${P1} — ${P2}`, kickoff_at: "2026-07-20T10:00:00Z",
    sets_first: 0, sets_second: 2, completed: 1, fav_is_label_first: 1, price_cents: 99,
    price_lag_min: null, observed_first_covers: 1, pred_favourite: 0, pred_label_first: 0,
    discriminating: 0, hypo_version: "shc-h1", score_src: "legacy", price_src: "legacy", fav_src: "legacy",
    created_at: "2026-07-20T12:00:00Z",
  });
  const r = verdictOf(db);
  assert.equal(r.controlChecked, clean.controlChecked, "недопущенная строка контроль не двигает");
  assert.equal(r.controlMismatch, 0, "и вердикт «метод неверен» ею не вызывается");
  assert.equal(r.refusedLegacyNoLag, 1);
  assert.match(r.note, /к вердикту НЕ допущено/, "сужение выборки названо числом");
});

// ── ФИКС 06.08: пре-регистрация судила только различающую ячейку и слепа там, где обе гипотезы врут ──
// Замер 06.08 (n=91): fav_first=false·margin=1 — основная промахнулась 15/15, альтернатива 0; но в ячейке
// fav_first=false·margin=2 (n=22) промахнулись ОБЕ по 13, и зеркальный прогноз угадал все 13. «Обыграла
// соперницу» ≠ «правило найдено» — вердикт обязан нести число промахов по ВСЕЙ выборке.
test("[фикс] альтернатива с промахами на полной выборке даёт «ПОДТВЕРЖДЕНА В ДУЭЛИ», а не лицензию", () => {
  const db = world();
  cleanControl(db, 9);
  // 5 РАЗЛИЧАЮЩИХ матчей, где альтернатива права: первый в подписи НЕ фаворит, разница ровно один сет.
  // Дни считаются от 01.07 + i, а пре-регистрация стоит на 03.08 — берём i > 33, иначе матчи уйдут в ретро.
  // 2:1 ⇒ альтернатива («−1.5 у первого») говорит «не покрыл», основная («−1.5 у фаворита») — «покрыл».
  // Цена 2¢ ⇒ не покрыл ⇒ права альтернатива.
  for (let i = 40; i < 45; i++) played(db, i, { favP1: false, setsP1: 2, setsP2: 1, mlPrice: 99, hcapPrice: 2 });
  // И один НЕразличающий, где альтернатива промахивается: разница 2, цена против её прогноза.
  played(db, 50, { favP1: false, setsP1: 0, setsP2: 2, mlPrice: 2, hcapPrice: 99 });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.alt.discriminatingSince, 5, "различающих набрано ровно по критерию");
  assert.equal(r.alt.mismatchSince, 0, "в дуэли альтернатива чиста");
  assert.ok(r.alt.fullSetMismatch > 0, "но на ПОЛНОЙ выборке промахи есть");
  assert.equal(r.alt.verdict, "ПОДТВЕРЖДЕНА В ДУЭЛИ");
  assert.match(r.alt.note, /правилом НЕ стала/);
  assert.match(r.alt.note, /из ТОКЕНА/);
});

// ── КОРЕНЬ 06.08: СТОРОНА ЧИТАЕТСЯ ИЗ ИМЕНИ ИСХОДА, А НЕ ВЫВОДИТСЯ ───────────────────────────────
// Цена рынка всегда относится к outcomes[0]. Чей это игрок — говорит ТОЛЬКО имя исхода: подпись
// «A vs B Set Handicap +/-1.5» называет обоих и стороны не несёт. Три «глобальных правила» подряд
// (фаворит, первый в подписи, контракт фаворита) объясняли по три четверти выборки и врали на остатке
// именно потому, что порядок outcomes — факт листинга Polymarket, а не конвенция.

test("ИМЕННАЯ ЯЧЕЙКА (n=22): токен переворачивает чтение, и обе гипотезы перестают промахиваться", () => {
  // Профиль ячейки замера 06.08: первый в подписи НЕ фаворит, разница ровно 2 сета. Обе гипотезы
  // предсказывают «первый не покрыл», рынок стоит на 99¢ — под прежним ДОПУЩЕНИЕМ «цена про первого»
  // это расхождение у обеих (13 из 22), а зеркальное чтение угадывает все 13.
  const cell = { favP1: false, setsP1: 0, setsP2: 2, mlPrice: 2, hcapPrice: 99 };

  const blind = world();
  played(blind, 60, { ...cell, outcomeFirst: null });               // имени исхода нет — сторона допущена
  const bRow = observeFromSnapshots(blind).rows.find((x) => x.group === "тест")!;
  assert.equal(bRow.sideFromToken, null);
  assert.equal(bRow.outcome, "РАСХОЖДЕНИЕ", "без стороны обе гипотезы «промахиваются»");
  assert.equal(bRow.altOutcome, "РАСХОЖДЕНИЕ");

  const read = world();
  played(read, 60, { ...cell, outcomeFirst: P2 });                  // цена — про ВТОРОГО в подписи
  const rRow = observeFromSnapshots(read).rows.find((x) => x.group === "тест")!;
  assert.equal(rRow.sideFromToken, false, "сторона ПРОЧИТАНА и она обратная");
  assert.equal(rRow.observedFirstWins, false, "99¢ на втором = первый НЕ покрыл");
  assert.equal(rRow.outcome, "совпало", "промах был артефактом ориентации, а не гипотезы");
  assert.equal(rRow.altOutcome, "совпало");
  assert.match(rRow.note, /цена 99¢ про ВТОРОГО/, "строка называет, чью сторону она видит");
});

test("сторона НЕ прочитана — строка не морозится и к вердикту не допускается", () => {
  const db = world();
  played(db, 100, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 97, outcomeFirst: null });
  const rec = recordShcObservations(db, "2026-08-04T12:00:00Z");
  assert.equal(rec.written, 0, "догадку не морозим: журнал append-only, не записать — единственный способ не иметь");
  assert.equal(rec.skippedSideUnknown, 2, "и манилайн, и гандикап — оба без прочитанной стороны");
  assert.match(rec.note, /сторона не прочитана 2/, "отказ НАПЕЧАТАН, а не спрятан");

  // Прежняя журнальная строка (записанная до колонки) вердикт не двигает — но названа числом.
  R.insertShcObservation(db, {
    kind: "test", match_id: "m-legacy", label: HCAP, players: `${P1} — ${P2}`, kickoff_at: "2026-07-20T10:00:00Z",
    sets_first: 2, sets_second: 0, completed: 1, fav_is_label_first: 1, price_cents: 97,
    price_lag_min: 5, side_from_token: null, side_src: null,
    observed_first_covers: 1, pred_favourite: 1, pred_label_first: 1, discriminating: 0,
    hypo_version: "shc-h1", score_src: "legacy", price_src: "legacy", fav_src: "legacy",
    created_at: "2026-07-20T12:00:00Z",
  });
  const r = verdictOf(db);
  assert.equal(r.refusedSideUnknown, 1);
  assert.equal(r.testChecked, 0, "недопущенная строка тест не набирает");
  assert.match(r.note, /сторона НЕ ПРОЧИТАНА 1/);
});

test("«имени ещё нет» и «имя не сопоставилось» — РАЗНЫЕ числа: лечатся противоположно", () => {
  // Без различения молчащий ноль покрытия неотличим от механизма, который не заработает НИКОГДА.
  const absent = world();
  played(absent, 100, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 97, outcomeFirst: null });
  const a = verdictOf(absent);
  assert.equal(a.orientation.known, 0);
  assert.equal(a.orientation.noName, 2);
  assert.equal(a.orientation.unreadable, 0);
  assert.match(a.orientation.note, /покрытие растёт с новыми матчами/);

  const junk = world();
  played(junk, 100, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 97, outcomeFirst: "Yes" });
  const j = verdictOf(junk);
  assert.equal(j.orientation.known, 0);
  assert.equal(j.orientation.unreadable, 2, "имя пришло — но игрока в нём нет");
  assert.match(j.orientation.note, /САМО ЭТО НЕ ПРОЙДЁТ|НЕ СОПОСТАВЛЯЮТСЯ/, "громкий ноль называет причину");
});

test("ПУСТАЯ полная выборка НЕ чистая: альтернатива не подтверждается на нуле строк", () => {
  // Замер сразу после деплоя O14 показал ровно это: `fullSetChecked: 0` и вердикт «ПОДТВЕРЖДЕНА».
  // Различающие считались БЕЗ допуска, а `altFullBad === 0` было истинно на пустом множестве — и
  // альтернатива стала выглядеть СИЛЬНЕЕ, чем до фикса, хотя доказательств стало МЕНЬШЕ.
  const db = world();
  cleanControl(db, 9);
  // Шесть различающих матчей ПОСЛЕ пре-регистрации, где альтернатива права, — но БЕЗ прочитанной стороны.
  for (let i = 40; i < 46; i++) played(db, i, { favP1: false, setsP1: 2, setsP2: 1, mlPrice: 99, hcapPrice: 2, outcomeFirst: null });
  const r = buildSetHandicapConvention(db);
  assert.equal(r.alt.fullSetChecked, 0, "судить нечего");
  assert.equal(r.alt.discriminatingSince, 0, "различающие считаются по ДОПУЩЕННЫМ строкам, как и основная");
  assert.equal(r.alt.verdict, "НЕ СОЗРЕЛО", "«промахов нет» на пустом множестве — не лицензия");
});

test("purity: имя исхода читается как ИМЯ, а не как порядковый номер", () => {
  assert.equal(priceSideIsLabelFirst("Carlos Alcaraz", P1, P2), true);
  assert.equal(priceSideIsLabelFirst("Alcaraz", P1, P2), true, "фамилии достаточно");
  assert.equal(priceSideIsLabelFirst("Sinner", P1, P2), false);
  assert.equal(priceSideIsLabelFirst("Yes", P1, P2), null, "не-именной исход — ОТСУТСТВИЕ факта");
  assert.equal(priceSideIsLabelFirst("", P1, P2), null);
  assert.equal(priceSideIsLabelFirst("Alcaraz", P1, P1), null, "одинаковые имена различить нечем");
});
