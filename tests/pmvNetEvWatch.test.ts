// ============================================================
// EDGE LAB — N3(1): УСЛОВИЕ, КОТОРОЕ НЕЛЬЗЯ БЫЛО ВЫПОЛНИТЬ
//
// Стоп-кран R2 требует: paper не включается, пока `net_ev_cut` не подтверждён ЖИВЫМ срабатыванием.
// Условие стояло невыполненным — и разбор показал, что оно и не могло быть выполнено: гейт стоит в
// коде НИЖЕ ветки `flag_only`, и при включённом флаге до него не доходило управление.
//
// Здесь держатся три свойства лечения:
//   1. ВЫЗОВ — ЭТО ЕЩЁ НЕ СРАБАТЫВАНИЕ. Условие выполнено только при живом СРЕЗЕ, не при «гейт звался».
//   2. «НЕ ЗВАЛСЯ» ОТЛИЧИМО ОТ «ЗВАЛСЯ И НЕ СРЕЗАЛ» — иначе это снова немой ноль.
//   3. ФЛАГА МОДУЛЬ НЕ КАСАЕТСЯ: он наблюдает гейт, а включает режим владелец.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import { recordNetEvShadow, buildNetEvShadow, netEvShadowLine } from "../src/lib/pmvNetEvWatch.js";

const db0 = () => { const db = openDb(":memory:"); initSchema(db); return db; };
const entry = (pass: boolean, net = pass ? 5 : -1) => ({
  at: "2026-08-05T10:00:00Z", label: "ATP: A vs B Total Sets: Over 2.5", family: "total_sets", side: "over",
  grossCents: 8, haircutCents: 2, feeCents: 2.4, driftCents: 0, marginCents: 2, netCents: net, pass,
});

test("гейт не звался — условие R2 НЕ выполнено, и это названо отсутствием замера", () => {
  const r = buildNetEvShadow(db0());
  assert.equal(r.verdict, "НЕ ЗВАЛСЯ НИ РАЗУ");
  assert.equal(r.r2ConditionMet, false);
  assert.match(r.note, /ОТСУТСТВИЕ ЗАМЕРА, а не «нечего резать»/);
});

test("ВЫЗОВ — ЭТО ЕЩЁ НЕ СРАБАТЫВАНИЕ: 10 оценок без единого среза условие НЕ выполняют", () => {
  const db = db0();
  for (let i = 0; i < 10; i++) recordNetEvShadow(db, entry(true));
  const r = buildNetEvShadow(db);
  assert.equal(r.evaluated, 10);
  assert.equal(r.wouldCut, 0);
  assert.equal(r.verdict, "ЗВАЛСЯ, НО НЕ СРЕЗАЛ НИ РАЗУ");
  assert.equal(r.r2ConditionMet, false, "стоп-кран требует СРЕЗА, а не вызова");
  assert.match(r.note, /условие R2 требует живого СРЕЗА/);
});

test("первый живой срез — условие выполнено, и цена включения названа числом", () => {
  const db = db0();
  for (let i = 0; i < 7; i++) recordNetEvShadow(db, entry(true));
  for (let i = 0; i < 3; i++) recordNetEvShadow(db, entry(false));
  const r = buildNetEvShadow(db);
  assert.equal(r.verdict, "ЖИВОЙ — срабатывания есть");
  assert.equal(r.r2ConditionMet, true);
  assert.equal(r.wouldCut, 3);
  assert.equal(r.cutPct, 30);
  assert.match(r.note, /цена включения известна ДО включения/);
  assert.match(r.note, /Флаг поднимает ВЛАДЕЛЕЦ/);
  assert.match(netEvShadowLine(r), /условие R2 ВЫПОЛНЕНО/);
});

test("последние срабатывания ЧИТАЮТСЯ — «гейт живой» доказывается строками, а не словом", () => {
  const db = db0();
  recordNetEvShadow(db, entry(false, -1.4));
  const r = buildNetEvShadow(db);
  assert.equal(r.recent.length, 1);
  assert.equal(r.recent[0].netCents, -1.4);
  assert.equal(r.recent[0].haircutCents, 2, "M21-haircut участвует и в теневой оценке");
});

test("модуль флага НЕ касается — включает режим владелец, не отчёт", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/pmvNetEvWatch.ts", import.meta.url), "utf8");
  // Проверяем ОБРАЩЕНИЯ, а не упоминания: имя флага в шапке объясняет, почему модуль существует, и
  // запрещать его в тексте значило бы запрещать объяснение. Запрещены чтение среды и торговые записи.
  for (const forbidden of ["process.env", "insertBet", "updateBet", "insertTradeLog"]) {
    assert.ok(!src.includes(forbidden), `наблюдатель гейта не должен трогать «${forbidden}»`);
  }
});
