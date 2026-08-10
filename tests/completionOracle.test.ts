// ============================================================
// ОРАКУЛ ЗАВЕРШЕНИЯ — УЛИКА, А НЕ СДЕЛКА (Р3, часть 2)
//
// ЗАМЕР 10.08: оракул `Completed Match` нашёлся лишь у 2 матчей из 12 дочитанных (17%). Причина —
// рельсовый отсев: `isRailCents` роняет ≤1¢ и ≥99¢, а «матч доиграют нормально» почти достоверно, поэтому
// оракул почти всегда стоит ровно там. Единственный матч, где он у нас ЕСТЬ, держал его на 50/50 —
// незаполненным плейсхолдером.
//
// ИДЕАЛЬНАЯ ИНВЕРСИЯ: завозили ровно тогда, когда он молчит, выбрасывали всякий раз, когда говорит.
// Фильтр торгуемости, применённый к улике, отбирает бесполезное.
//
// Обратная сторона правки: освобождённый от рельса рынок может лежать на доске с ценой 99¢ и выглядеть
// для стратега бесплатными деньгами. Это закрывается ЯВНО, а не надеждой.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCompletionOracle, isRailCents } from "../src/lib/polymarket.js";
import { structuralPlaceholders } from "../src/lib/placeholderStructural.js";

test("оракул опознаётся по подписи", () => {
  assert.ok(isCompletionOracle("Croatia Open: Completed Match: Fabian Marozsan vs Juan Carlos Prado"));
  assert.ok(isCompletionOracle("Completed Match — Yes"));
  assert.ok(!isCompletionOracle("Croatia Open: Fabian Marozsan vs Juan Carlos Prado"));
  assert.ok(!isCompletionOracle("Match Over 22.5"));
});

test("ИМЕННОЙ СЛУЧАЙ ЗАМЕРА: цены оракула из прода лежат ровно на рельсе", () => {
  // Фактические bestAsk семи матчей 10.08 — в центах.
  for (const c of [100, 99.9, 0.1, 0.9]) assert.ok(isRailCents(c), `${c}¢ — рельс, оракул выбрасывался`);
  // …а плейсхолдерные 50¢ рельс не ловит: только поэтому оракул и попадал к нам — молчащим.
  assert.ok(!isRailCents(50));
});

test("оракул НИКОГДА не выглядит торговым кандидатом даже при 99¢", () => {
  // Структурный тест плейсхолдера его не срежет (цена не на 50¢), поэтому защита обязана быть отдельной:
  // проверяем сам предикат, которым analysis.ts скрывает оракул от стратега.
  const oracle = { label: "Completed Match — Yes", price: 99 } as never;
  assert.ok(isCompletionOracle((oracle as { label: string }).label),
    "скрытие стратега опирается на этот предикат — если он молчит, улика становится сделкой");
  assert.deepEqual(structuralPlaceholders([{ label: "Completed Match — Yes", price: 99, ask_cents: 99, spread_cents: 1 } as never]), [],
    "на 99¢ плейсхолдерный тест молчит — значит одной этой защиты было бы НЕ достаточно");
});
