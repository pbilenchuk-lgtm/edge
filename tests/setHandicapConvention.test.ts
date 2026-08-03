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
import { buildSetHandicapConvention, setHandicapConventionLine, SHC_CONTROL_MIN, SHC_TEST_MIN_MATCHES } from "../src/lib/setHandicapConvention.js";

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
  o: { favP1: boolean; setsP1: number; setsP2: number; mlPrice?: number | null; hcapPrice?: number | null },
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
  const mk = (label: string, price: number, sfx: string) => R.insertMarket(db, { id: `mk${i}${sfx}`, match_id: id, label, price, ai_prob: null, liquidity: 3000, external_ref: null, snapshot_at: `${day}T14:00:00Z`, is_closing: false } as never);
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
  assert.equal(r.testChecked, 0, "неразрешившиеся рынки в счёт не идут");
  assert.equal(r.verdict, "НЕ СОЗРЕЛО");
  assert.match(r.rows.find((x) => x.group === "тест")!.note, /не судим, а не «наверное да»/);
});

test("ЕДИНИЦА — МАТЧ: два гандикап-пропа одного матча это ОДНО испытание", () => {
  const db = world();
  played(db, 100, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 99 });
  R.insertMarket(db, { id: "mk100b", match_id: "m100", label: `Canadian Open: ${P1} vs ${P2} Set Handicap 1.5`, price: 99, ai_prob: null, liquidity: 3000, external_ref: null, snapshot_at: "2026-07-01T15:00:00Z", is_closing: false } as never);
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
