// ============================================================
// EDGE LAB — ПЛАНКА, КОТОРУЮ СОСТОЯНИЕ ИГРЫ НЕ ОБЪЯСНЯЕТ  (правило a1)
//
// Третья итерация правила о планочных ценах. Первые две я сделал неверно, и обе ошибки живут здесь
// регрессионными тестами — это и есть цена, которую мы за них платим, вместо того чтобы платить её
// повторно на проде.
//
//   #89 — правило ключевалось на «матч не завершён». На 90'+4' матча Bay FC — NJ/NY Gotham (0:1) оно
//         карантинило `Draw — No @98.5¢` и `Over 0.5 @98¢` — цены АБСОЛЮТНО верные, гол уже забит.
//   #90 — я передвинул границу на стартовый свисток. Правильно для #89, но оставило дыру: прод 30.07
//         показал на шести живых матчах Conference League 36 из 40, 36 из 40, 32 из 36 и 30 из 34
//         рынков у планки ПРИ СЧЁТЕ 0:0 НА 24-Й МИНУТЕ. (a0) молчит (матч начался), resolved_price
//         молчит (он требует gsProb ≥ 0.995 — «счёт запер исход», а при 0:0 не заперто ничто).
//         Стратег видел доску, где 90% котировок утверждают известный результат, и отказывался от неё
//         целиком: «пропуск матча — стратег вернул 0 picks».
//
// Верный предикат — не «до/после свистка», а тот же, что в T1.1: ОБЪЯСНЯЕТ ЛИ СОСТОЯНИЕ ИГРЫ ЦЕНУ.
// Числа зафиксированы ДО деплоя: планка ≤1¢/≥99¢; «gsProb далёк» = ≤0.95 при цене ≥99 и симметрично
// ≥0.05 при ≤1. Зазор 4пп — чтобы класс #89 (98¢ при gsProb≈0.99) проходил С ЗАПАСОМ, а не впритык.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyZombie, zombieClearWithMargin, loadZombieConfig } from "../src/lib/zombieMarket.js";

const CFG = loadZombieConfig({});
const base = { groupSpreadCents: null, bookAgeMin: 1, live: true, matchKickedOff: true } as const;

test("дыра #90 закрыта: 99¢ при 0:0 на 24' — карантин (состояние игры такой определённости не даёт)", () => {
  // Доска Hajduk — Páfos / Tromsø — Hradec: 36 из 40 рынков у планки при 0:0 на 24-й минуте.
  const z = classifyZombie({ ...base, label: "Over 0.5", priceCents: 99.5, gsProb: 0.78 }, CFG);
  assert.equal(z?.code, "rail_unexplained");
  assert.match(String(z?.detail), /78/, "в детали стоит фактическая game-state вероятность");
  // Симметрия: та же ложь с другой стороны книги.
  const low = classifyZombie({ ...base, label: "Under 0.5", priceCents: 0.5, gsProb: 0.22 }, CFG);
  assert.equal(low?.code, "rail_unexplained");
});

test("ошибка #89 НЕ повторена: 98¢ на 90'+4' при запертом счёте проходит с запасом", () => {
  // Дословный случай из лога Bay FC — NJ/NY Gotham (0:1, 90'+4'): гол забит, Over 0.5 заперт.
  const over = classifyZombie({ ...base, label: "Over 0.5", priceCents: 98, gsProb: 1 }, CFG);
  assert.equal(over, null, "98¢ вообще не планка (нужно ≥99) — правило не имеет права её касаться");
  const draw = classifyZombie({ ...base, label: "Draw — No", priceCents: 98.5, gsProb: 0.99 }, CFG);
  assert.equal(draw, null, "98.5¢ при gsProb 0.99 — корректная цена, а не зомби");
  // И даже НА планке: если состояние игры её подпирает, правило молчит. Это и есть зазор 4пп.
  const locked = classifyZombie({ ...base, label: "Over 0.5", priceCents: 99.5, gsProb: 0.99 }, CFG);
  assert.equal(locked, null, "gsProb 0.99 > потолка 0.95 — планка ОБЪЯСНЕНА, торгуем");
});

test("gsProb неизвестен → правило МОЛЧИТ (§9.6 fail-open на неоднозначности)", () => {
  const z = classifyZombie({ ...base, label: "Team to Advance — X", priceCents: 99.5, gsProb: null }, CFG);
  assert.equal(z, null, "не знаем состояния игры — не имеем права утверждать, что планка им не объясняется");
});

test("до свистка приоритет у (a0): код rail_price, а не rail_unexplained", () => {
  const z = classifyZombie({ ...base, matchKickedOff: false, label: "Draw — Yes", priceCents: 0.1, gsProb: 0.26 }, CFG);
  assert.equal(z?.code, "rail_price", "предматчевую планку объяснять нечем — там своё правило");
});

test("выход из карантина с зазором — иначе цена у самой планки будет хлопать каждый тик", () => {
  const near = { ...base, label: "Over 0.5", priceCents: 99 - CFG.hysteresisCents + 0.5, gsProb: 0.78 };
  assert.equal(classifyZombie(near, CFG), null, "по голому порогу цена уже чиста");
  assert.equal(zombieClearWithMargin(near, CFG), false, "но до планки ближе зазора — карантин держим");
  const far = { ...base, label: "Over 0.5", priceCents: 90, gsProb: 0.78 };
  assert.equal(zombieClearWithMargin(far, CFG), true, "отошла от планки на зазор — рынок снова торгуем");
});

test("порог вынесен в конфиг и перекрывается средой — число фиксируется до деплоя, а не в коде", () => {
  const loose = loadZombieConfig({ FOOTBALL_ZOMBIE_RAIL_GSPROB_CEILING: "0.5" });
  assert.equal(loose.railGsProbCeiling, 0.5);
  assert.equal(classifyZombie({ ...base, label: "Over 0.5", priceCents: 99.5, gsProb: 0.78 }, loose), null,
    "при потолке 0.5 та же цена объяснена — правило управляемо без деплоя");
});
