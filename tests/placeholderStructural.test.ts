// ============================================================
// #120/#121 — ЭДЖ НА ИСПОЛНИМОЙ ЦЕНЕ + СТРУКТУРНЫЙ ПЛЕЙСХОЛДЕР
//
// Свойства, ради которых оба написаны (замер 151 матч-лога, 07.08):
//   1. Заявленный эдж — функция качества ЦЕНЫ. Плохо размеченная цена ПРОИЗВОДИТ фантомный эдж: два
//      крупнейших эджа выборки (+24.5 и +22.0 п.п.) неисполнимы, единственный проигравший зафилленный
//      тезис — единственный, чья цена стояла ровно на 50¢.
//   2. Временной карантин ловит 70 из 1737 плоских рынков и ОПАЗДЫВАЕТ к предматчевому вызову стратега.
//   3. Пороги названы ДО данных: подгонка под выборку запрещена — тест это и фиксирует.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  structuralPlaceholders, moneylineOf, executableImplied, falseCut, placeholderFunnelLine,
  FLAT_TOL_CENTS, ML_SKEW_MIN_CENTS, UNQUOTED_SPREAD_CENTS, FALSE_CUT_MIN_MOVE_CENTS,
} from "../src/lib/placeholderStructural.js";
import type { Market } from "../src/lib/types.js";

const mk = (label: string, price: number, o: { ask?: number | null; spread?: number | null } = {}): Market => ({
  id: label, match_id: "m", label, price, ai_prob: null, liquidity: "1000",
  external_ref: "t", snapshot_at: "2026-08-07T00:00:00Z", is_closing: false,
  ask_cents: o.ask === undefined ? price + 1 : o.ask, spread_cents: o.spread === undefined ? 2 : o.spread,
} as Market);

const ML = "National Bank Open: Clara Tauson vs Nikola Bartunkova";
const PROP = `${ML} Total Sets: Under 2.5`;

test("пороги ЗАФИКСИРОВАНЫ до данных", () => {
  assert.equal(FLAT_TOL_CENTS, 0.5);
  assert.equal(ML_SKEW_MIN_CENTS, 15);
  assert.equal(UNQUOTED_SPREAD_CENTS, 20);
  assert.equal(FALSE_CUT_MIN_MOVE_CENTS, 10);
});

test("ИМЕННОЙ КЕЙС: манилайн 5.9¢ (фаворит 94%) — проп на 50¢ не может быть оценкой", () => {
  const r = structuralPlaceholders([mk(ML, 5.9), mk(PROP, 50)]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.label, PROP);
  assert.equal(r[0]!.reason, "moneyline_contradicts");
  assert.match(r[0]!.note, /при таком фаворите/);
});

test("манилайн ровный (48¢) — проп на 50¢ НЕ обвиняется: улики нет", () => {
  assert.deepEqual(structuralPlaceholders([mk(ML, 48), mk(PROP, 50)]), []);
});

test("манилайна вообще нет — тест МОЛЧИТ, а не срабатывает (асимметричная гарантия)", () => {
  assert.deepEqual(structuralPlaceholders([mk(PROP, 50)]), []);
});

// [08.08, РАТИФИЦИРОВАНО] Раньше здесь стояло обратное: «нет аска — плейсхолдер и без всякого манилайна».
// Сторож ложных срезов опроверг это числом — 6 ложных из 36 (16.7%), и все на магистральных футбольных
// тоталах, которые потом ушли от 50¢ дальше 10¢. Отсутствие аска в НАШЕМ снимке — утверждение о полноте
// нашей выгрузки, а не о книге биржи; выдавать одно за другое и было дефектом.
test("нет аска, но спред известен и манилайн ровный — НЕ режем: одного молчания аска мало", () => {
  assert.deepEqual(structuralPlaceholders([mk(ML, 48), mk(PROP, 50, { ask: null })]), []);
});

test("нет аска ПЛЮС перекошенный манилайн — вторая улика есть, режем", () => {
  const r = structuralPlaceholders([mk(ML, 88), mk(PROP, 50, { ask: null })]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.path, "no_ask_ml");
});

test("книги нет НИ ПО ОДНОМУ полю — режем и без манилайна", () => {
  const r = structuralPlaceholders([mk(ML, 48), mk(PROP, 50, { ask: null, spread: null })]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.reason, "unquoted_book");
  assert.equal(r[0]!.path, "no_book");
  assert.match(r[0]!.note, /НИ ПО ОДНОМУ полю/);
});

test("широкий спред (≥20¢) при цене 50¢ — двусторонней цены фактически нет", () => {
  const r = structuralPlaceholders([mk(ML, 48), mk(PROP, 50, { ask: 60, spread: 22 })]);
  assert.equal(r[0]!.reason, "unquoted_book");
});

test("сам манилайн плейсхолдером себя не объявляет — 50¢ у равных соперников законны", () => {
  assert.deepEqual(structuralPlaceholders([mk(ML, 50)]), []);
});

test("цена ушла от дефолта дальше допуска — не наше дело", () => {
  assert.deepEqual(structuralPlaceholders([mk(ML, 5.9), mk(PROP, 51)]), []);
  assert.equal(structuralPlaceholders([mk(ML, 5.9), mk(PROP, 50.5)]).length, 1, "граница допуска включительно");
});

test("сторож ложного среза: ожившая цена помечает срез как ошибочный, но НЕ откатывает", () => {
  assert.equal(falseCut(50, 72), true, "ушла на 22¢ от дефолта — резали зря");
  assert.equal(falseCut(50, 55), false, "5¢ < 10¢ — в пределах шума, среза не оспаривает");
  assert.equal(falseCut(50, null), false, "нет поздней цены — обвинения нет");
});

test("воронка печатает ТРИ числа раздельно — они лечатся по-разному", () => {
  const s = placeholderFunnelLine({ total: 26, structural: 18, temporal: 3, toLlm: 5 });
  assert.match(s, /всего 26/); assert.match(s, /СТРУКТУРНО 18/);
  assert.match(s, /по времени 3/); assert.match(s, /до стратега 5/);
});

test("монилайн находится по подписи, а не по позиции в списке", () => {
  assert.equal(moneylineOf([mk(PROP, 50), mk(ML, 5.9)]), 5.9);
  assert.equal(moneylineOf([mk(PROP, 50)]), null);
});

// ── #120 ────────────────────────────────────────────────────────────────────────────────────────
test("[#120] эдж считается от АСКА: разрыв +27.5¢ убивает край, а не украшает его", () => {
  // Именной профиль отказов замера: котировка 50.5¢, аск 78¢, наша оценка 64%.
  const m = { price: 50.5, ask_cents: 78 };
  const ex = executableImplied(m, 0.505);
  assert.equal(ex.usable, true);
  assert.equal(ex.cents, 78);
  assert.equal(ex.source, "executable");
  assert.ok(0.64 - ex.implied < 0, "на аске края НЕТ — вход не должен существовать");
  assert.ok(0.64 - 0.505 > 0, "а на миде он выглядел бы +13.5 п.п. — ровно фантом, который мы убираем");
});

test("[#120] перевёрнутая книга (аск НИЖЕ мида) не используется — гейт не улучшает край битой строкой", () => {
  const ex = executableImplied({ price: 60, ask_cents: 40 }, 0.6);
  assert.equal(ex.usable, false);
  assert.equal(ex.source, "mid_fallback");
  assert.equal(ex.cents, 60);
});

test("[#120] аска нет — мид-фолбэк разрешён, но ПОМЕЧЕН провенансом", () => {
  const ex = executableImplied({ price: 33, ask_cents: null }, 0.31);
  assert.equal(ex.source, "mid_fallback");
  assert.equal(ex.implied, 0.31, "де-вигнутая оценка мида, а не сырая цена");
});

test("[#120] аск 100¢ не исполним — покупать нечего", () => {
  assert.equal(executableImplied({ price: 95, ask_cents: 100 }, 0.95).usable, false);
});
