// ============================================================
// ЭТАЛОН СТОРОЖА НЕ БЕРЁТСЯ ИЗ ПРОВЕРЯЕМОГО ЧИСЛА
//
// Разбор восьми гигантских строк (17.07: $28 291 и $7 386 при банке $1k) назвал причину: общая переменная
// `TENNIS_PAPER_BUDGET_USD` стояла в $1M ради PMV-симуляции, а Set-Value читал ЕЁ ЖЕ и сайзился от
// миллионного банка. Все кэпы процентные, поэтому $28 291 = 2.8% от $1M прошли «в пределах»: сторож не
// молчал — его СПРОСИЛИ С НЕВЕРНЫМ ЗНАМЕНАТЕЛЕМ.
//
// Хуже: бэкстоп `sizing_insanity`, построенный ПРОТИВ этой аварии, на теннисных путях получал
// `bankCeiling: TENNIS_PAPER_BUDGET` — то есть сверялся с испорченным числом и промолчал бы во второй раз
// по той же причине. Его собственный контракт требует источника, независимого от бюджета.
//
// Здесь держатся два свойства: (1) испорченный бюджет ловится эталоном из ДРУГОГО источника;
// (2) абсолютный потолок — ЧИСЛО, а не доля, потому что процент от испорченного знаменателя не сработает
// никогда. И оба БЛОКИРУЮТ, а не подрезают: тихий трим спрятал бы порчу ровно тогда, когда её видно.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { sizePrematch } from "../src/lib/strategist.js";
import { getProfileConfig } from "../src/lib/riskConfig.js";
import { openDb, initSchema } from "../src/lib/db.js";

const cfg = () => { const db = openDb(":memory:"); initSchema(db); return getProfileConfig(db, "max"); };

/** Вход, повторяющий аварию 17.07: Set-Value, фаворит 39.6¢, наша вероятность 55% (edge ~15%). */
const inp = (o: { budget: number; bankCeiling?: number; absoluteMaxStakeUsd?: number }) => ({
  ourProb: 0.551, priceCents: 39.6, implied: 0.396, calibration: 0.6, liquidity: 4900,
  matchExposure: 0, compExposure: 0, cfg: cfg(), ...o,
});

test("АВАРИЯ 17.07 ВОСПРОИЗВЕДЕНА: испорченный бюджет $1M даёт стотысячную ставку", () => {
  // Эталон взят ИЗ ТОГО ЖЕ числа, что и бюджет, — как было на теннисных путях до правки.
  const r = sizePrematch(inp({ budget: 1_000_000, bankCeiling: 1_000_000 }));
  assert.equal(r.status, "enter", "сторож с испорченным эталоном пропускает");
  assert.ok(r.stake > 20_000, `ставка $${r.stake} — тот самый порядок, что в проде 17.07`);
});

test("ЭТАЛОН ИЗ ДРУГОГО ИСТОЧНИКА ловит ту же аварию", () => {
  const r = sizePrematch(inp({ budget: 1_000_000, bankCeiling: 1000 }));   // банк — настоящий, $1k
  assert.equal(r.status, "flag", "заблокировано, а не подрезано");
  assert.match(r.reason, /sizing_insanity/);
  assert.equal(r.stake, 0);
});

test("АБСОЛЮТНЫЙ ПОТОЛОК ловит порчу, даже если испорчен И банк тоже", () => {
  // Худший случай: обе переменные выставлены неверно. Проценты бессильны — их знаменатели оба врут.
  const r = sizePrematch(inp({ budget: 1_000_000, bankCeiling: 1_000_000, absoluteMaxStakeUsd: 250 }));
  assert.equal(r.status, "flag");
  assert.match(r.reason, /stake_over_absolute_cap/);
  assert.match(r.reason, /потолок задан ЧИСЛОМ, а не долей/);
});

test("при санкционированном банке потолки НЕ связывают — защита не мешает нормальной работе", () => {
  const r = sizePrematch(inp({ budget: 1000, bankCeiling: 1000, absoluteMaxStakeUsd: 250 }));
  assert.equal(r.status, "enter");
  assert.ok(r.stake > 0 && r.stake <= 250, `ставка $${r.stake} — внутри обоих потолков`);
});

test("потолок БЛОКИРУЕТ, а не подрезает: тихий трим спрятал бы порчу", () => {
  const r = sizePrematch(inp({ budget: 1_000_000, bankCeiling: 1_000_000, absoluteMaxStakeUsd: 250 }));
  assert.notEqual(r.stake, 250, "подрезанная до потолка ставка выглядела бы как нормальный вход");
  assert.equal(r.stake, 0);
});

test("теннисные пути передают эталон и потолок из ОТДЕЛЬНЫХ переменных — проводка, а не только функция", async () => {
  // Тест на чистую функцию доказывает, что она посчитает верно, ЕСЛИ её позовут с верными полями.
  // Авария была именно в ПОЛЯХ вызова, поэтому проверяем исходник вызова.
  const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/tennisTrading.ts", "utf8"));
  const calls = src.split("\n").filter((l) => l.includes("sizePrematch({"));
  assert.ok(calls.length >= 2, "обе теннисные точки на месте");
  for (const c of calls) {
    assert.ok(c.includes("bankCeiling: TENNIS_BANK_USD"), `эталон из своей переменной: ${c.slice(0, 90)}`);
    assert.ok(c.includes("absoluteMaxStakeUsd: TENNIS_MAX_STAKE_USD"), "абсолютный потолок передан");
    assert.ok(!/bankCeiling:\s*TENNIS_PAPER_BUDGET\b/.test(c), "эталон НЕ берётся из бюджета сайзинга");
  }
  const pmv = await import("node:fs").then((fs) => fs.readFileSync("src/lib/tennisPmv.ts", "utf8"));
  assert.ok(pmv.includes("bankCeiling: PMV_BANK_USD"), "PMV тоже сверяется со своей переменной");
  assert.ok(!/bankCeiling:\s*PMV_BUDGET\b/.test(pmv), "PMV не сверяется с собственным бюджетом");
});
