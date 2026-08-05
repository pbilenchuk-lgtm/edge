// ============================================================
// EDGE LAB — N4: ДВЕ ПОПУЛЯЦИИ «ПРЕДМАТЧА»
//
// Именной кейс — Celtic FC — Dundee FC, 03.08: кикофф 18:30:00Z, анализ 18:31:06Z, вход 18:32:56Z по
// котировке РОВНО 50.0¢ с нулевым слиппеджем. Прибыль +$142 пришла оттого, что рынок опоздал к разметке,
// а не оттого, что модель была права про размеченный рынок. Складывать такие входы с настоящим
// предматчем в один win-rate — мерить среднюю температуру двух разных болезней.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { isCatchUp, isUnmarkedBook, populationTags, populationOf, isGoldenPopulation, CATCH_UP_CAP_FRAC, UNMARKED_BOOK_BAND_CENTS } from "../src/lib/entryPopulation.js";

const KICK = "2026-08-03T18:30:00Z";

test("РЕГРЕССИЯ Celtic: решение через 66с ПОСЛЕ кикоффа + цена ровно 50.0¢ — обе метки", () => {
  const t = populationTags({ kickoffAt: KICK, decidedAt: "2026-08-03T18:31:06Z", entryCents: 50.0 });
  assert.equal(t.catchUp, true);
  assert.equal(t.unmarkedBook, true);
  assert.equal(populationOf(t), "catch_up + неразмеченная", "пересечение НАЗВАНО отдельно — это самый дорогой случай");
  assert.equal(isGoldenPopulation(t), false, "в золотую ячейку такой вход НЕ входит");
});

test("настоящий предматч: решение до кикоффа по размеченной цене — золотая ячейка", () => {
  const t = populationTags({ kickoffAt: KICK, decidedAt: "2026-08-03T17:00:00Z", entryCents: 62 });
  assert.deepEqual(t, { catchUp: false, unmarkedBook: false });
  assert.equal(populationOf(t), "предматч");
  assert.equal(isGoldenPopulation(t), true);
});

test("метки НЕ синонимы: поздний вход по живой цене и ранний по мёртвой — разные популяции", () => {
  assert.equal(populationOf(populationTags({ kickoffAt: KICK, decidedAt: "2026-08-03T18:40:00Z", entryCents: 71 })), "catch_up");
  assert.equal(populationOf(populationTags({ kickoffAt: KICK, decidedAt: "2026-08-03T12:00:00Z", entryCents: 50 })), "неразмеченная книга");
});

test("неизвестный кикофф НЕ объявляется опозданием — метка на незнании отравила бы когорту", () => {
  assert.equal(isCatchUp(null, "2026-08-03T18:40:00Z"), false);
  assert.equal(isCatchUp("не дата", "2026-08-03T18:40:00Z"), false);
});

test("полоса неразмеченной книги узкая и симметричная", () => {
  assert.equal(UNMARKED_BOOK_BAND_CENTS, 0.5);
  assert.equal(isUnmarkedBook(50), true);
  assert.equal(isUnmarkedBook(50.5), true);
  assert.equal(isUnmarkedBook(49.5), true);
  assert.equal(isUnmarkedBook(51), false, "51¢ — это уже котировка, а не дефолт");
  assert.equal(isUnmarkedBook(null), false, "нет цены — нет утверждения");
});

test("catch-up ходит половиной до созревания своей когорты — паттерн ft_blind", () => {
  assert.equal(CATCH_UP_CAP_FRAC, 0.5);
});
