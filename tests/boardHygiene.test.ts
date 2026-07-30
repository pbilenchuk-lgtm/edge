// ============================================================
// EDGE LAB — СТРАТЕГ ОТКАЗЫВАЛСЯ ОТ ВСЕЙ ДОСКИ, ПОТОМУ ЧТО ДОСКА БЫЛА БИТОЙ
//
// Два прод-лога от 30.07 говорят это словами самого стратега, и ни один гейт входа при этом не
// срабатывал — до гейтов дело просто не доходило («НЕТ ПРЕДЛОЖЕНИЙ: стратег не выдал ни одной ставки»).
//
// 1. Bohemian FC — FC Ballkani (предматч, состояние lineup, 0'):
//      Draw — No 100¢ · Draw — Yes 0.1¢ · Bohemian — Yes 0.1¢ · Ballkani — Yes 100¢
//    Все четыре 1X2-рынка у планки ДО стартового свистка: книга говорит, что победитель уже известен.
//    Стратег: «цены исходных рынков вырождены (100¢/0.1¢) — несвежие/неполные котировки.
//              Верный ответ по методологии — полный пропуск.»
//
// 2. FC Atert Bissen — ETO FC (live, 3'):
//      Draw — Yes 33¢ · Draw (ETO vs. Atert) — Yes 16.5¢ · Draw (Atert vs. ETO) — Yes 0.1¢
//    ОДИН исход под тремя ярлыками по трём расходящимся ценам.
//    Стратег: «дубликат-конфликт: один исход по трём расходящимся ценам. Артефакт данных —
//              не торговать без подтверждения.» — и отказался от ВСЕЙ доски, не только от ничьей.
//
// Канонизатор ничьей для этого и был написан, но подключён был лишь на этапе меты ставки: он чинил
// запись о сделке, которой из-за него же и не случалось. Оба фильтра теперь стоят ДО каталога.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRailPrice, classifyZombie, loadZombieConfig } from "../src/lib/zombieMarket.js";
import { RESOLVED_RAIL_CENTS, isRailCents } from "../src/lib/polymarket.js";

test("порог планки ОДИН на импорт и на карантин — два независимых уже разъезжались", () => {
  assert.equal(RESOLVED_RAIL_CENTS, 1);
  // Обе стороны книги и обе функции обязаны давать один ответ на одной цене.
  for (const c of [0, 0.1, 1, 99, 99.9, 100]) {
    assert.equal(isRailCents(c), true, `${c}¢ — планка`);
    assert.equal(isRailPrice(c), isRailCents(c), `${c}¢: импорт и карантин обязаны совпадать`);
  }
  for (const c of [2, 33, 46, 54, 67, 98]) {
    assert.equal(isRailCents(c), false, `${c}¢ — обычная котировка`);
    assert.equal(isRailPrice(c), isRailCents(c), `${c}¢: импорт и карантин обязаны совпадать`);
  }
});

test("доска Bohemian—Ballkani: планка ДО свистка — карантин; та же цена ПОСЛЕ свистка — нет", () => {
  // Дословные цены из прод-лога.
  const board = [
    { label: "Draw — No", cents: 100 },
    { label: "Draw — Yes", cents: 0.1 },
    { label: "Bohemian FC — Yes", cents: 0.1 },
    { label: "FC Ballkani — Yes", cents: 100 },
  ];
  for (const m of board) {
    const pre = classifyZombie({ priceCents: m.cents, matchKickedOff: false } as any, loadZombieConfig({}));
    assert.equal(pre?.code, "rail_price", `${m.label} @${m.cents}¢ до свистка — не котировка`);
  }
  // ГРАНИЦА — стартовый свисток, а не финальный: после него планку объясняет счёт, и прятать
  // «Over 0.5 @98¢» при забитом голе было бы враньём. На этом я уже один раз ошибся (#89→#90).
  const post = classifyZombie({ priceCents: 100, matchKickedOff: true } as any, loadZombieConfig({}));
  assert.notEqual(post?.code, "rail_price", "после свистка планку объясняет счёт — правило rail_price молчит");
});

test("обычные цены той же доски карантин НЕ трогает — правило не должно душить книгу целиком", () => {
  // Из лога Atert—ETO: живые двусторонние цены обязаны пройти.
  for (const c of [96.7, 53.5, 46.5, 86, 44, 56, 67, 33, 16.5]) {
    assert.equal(isRailPrice(c), false, `${c}¢ — нормальная котировка, карантину здесь делать нечего`);
  }
});
