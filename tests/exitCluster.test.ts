import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { exitCluster, sliceOfCluster } from "../src/lib/exitCluster.js";
import { paperSellFill, type SellFillResult } from "../src/lib/executor/paperFill.js";
import type { OrderBookFetch } from "../src/lib/polymarket.js";

const EXEC = { takerFeeRate: 0, fallbackK: 0.1, minEdgeCents: 0, maxSlipCents: 100 } as never;

/** Книга Celtic-типа: верхний бид крупный и дорогой, глубже — быстро дешевеющие уровни. */
const book = (): OrderBookFetch => ({
  status: "ok",
  book: {
    bids: [
      { priceCents: 78, size: 100 },
      { priceCents: 70, size: 100 },
      { priceCents: 62, size: 100 },
      { priceCents: 50, size: 400 },
    ],
    asks: [],
  },
} as unknown as OrderBookFetch);

function addBet(db: ReturnType<typeof openDb>, id: string, strategyId: string, profile: string, label: string, stake: number, entry: number) {
  R.insertBet(db, {
    id, match_id: "m-lineup", strategy_id: strategyId, risk_profile_id: profile, market_label: label,
    status: "open", proposed_price: entry, entry_price: entry, current_price: entry, closing_price: null,
    ai_prob: 0.6, stake, rationale: "t", entered_minute: "40'", result: null, payout: null,
    entry_meta: null, code_version: null, created_at: "2026-08-05T00:00:00.000Z",
  });
}

test("N5-агрегация: одинокая ставка кластера не образует — поведение не меняется ни на знак", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  addBet(db, "b-solo", "edge", "medium", "Under 3.5", 100, 50);
  const b = R.getBet(db, "b-solo")!;
  assert.equal(exitCluster(db, b, new Map()), undefined);
});

test("N5-агрегация: близнецы РАЗНЫХ стратегий и профилей — один кластер (книга на токен одна)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  addBet(db, "b-1", "edge", "medium", "Under 3.5", 100, 50);      // 200 акций
  addBet(db, "b-2", "flat", "aggressive", "Under 3.5", 50, 50);   // 100 акций
  addBet(db, "b-3", "kelly", "medium", "Over 3.5", 80, 40);       // другой рынок — не наш кластер
  const c = exitCluster(db, R.getBet(db, "b-1")!, new Map())!;
  assert.ok(c);
  assert.equal(Math.round(c.clusterShares), 300);
  assert.equal(c.clusterBasisUsd, 150);
});

test("N5-агрегация: перифраз подписи не разваливает кластер", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  addBet(db, "b-a", "edge", "medium", "Under 3.5", 100, 50);
  addBet(db, "b-b", "flat", "medium", "under 3.5", 100, 50);      // регистр/пробелы
  const c = exitCluster(db, R.getBet(db, "b-a")!, new Map())!;
  assert.equal(Math.round(c.clusterShares), 400);
});

test("N5-агрегация: близнецы получают ОДНУ цену — поздний больше не хуже первого", () => {
  // Раздельными заявками: 200 акций съедают 78/70 → VWAP 74; следующие 200 берут уже 62/50.
  const solo1 = paperSellFill(book(), 200, 100, 78, 0, EXEC);
  const solo2 = paperSellFill(book(), 200, 100, 78, 0, EXEC);
  assert.equal(solo1.cents, solo2.cents, "каждый в одиночку видит книгу с вершины — модель занижала слиппедж");

  // Одним ордером на 400 акций книга проедается по-настоящему.
  const agg = paperSellFill(book(), 400, 200, 78, 0, EXEC);
  assert.ok(agg.cents < solo1.cents, `кластерный VWAP ${agg.cents}¢ обязан быть хуже одиночного ${solo1.cents}¢`);

  const a = sliceOfCluster(agg, 200);
  const b = sliceOfCluster(agg, 200);
  assert.equal(a.cents, b.cents, "оба близнеца выходят по цене одного ордера");
  assert.equal(a.cents, agg.cents);
});

test("N5-агрегация: издержки кластера УРЕЗАЮТСЯ до доли близнеца, а не дублируются на каждого", () => {
  const agg = paperSellFill(book(), 400, 200, 78, 0, EXEC);
  assert.ok(agg.cost, "книга дала реальный fill-cost");
  const a = sliceOfCluster(agg, 300);
  const b = sliceOfCluster(agg, 100);
  assert.ok(a.cost && b.cost);
  // Доли складываются в целое: реестр филлов не получает четырёхкратной комиссии одного ордера.
  assert.ok(Math.abs((a.cost!.shares + b.cost!.shares) - agg.cost!.shares) < 1e-6);
  assert.ok(Math.abs((a.cost!.slipUsd + b.cost!.slipUsd) - agg.cost!.slipUsd) < 1e-6);
  assert.ok(Math.abs((a.cost!.notionalUsd + b.cost!.notionalUsd) - agg.cost!.notionalUsd) < 1e-6);
  // Цена за акцию — общая, она НЕ делится.
  assert.equal(a.cost!.vwapCents, agg.cost!.vwapCents);
});

test("N5-агрегация: доля филла кластера переносится на кусок пропорционально", () => {
  // Книга на 700 акций всего — ордер на 1000 исполняется частично.
  const agg: SellFillResult = paperSellFill(book(), 1000, 500, 78, 0, EXEC);
  const frac = agg.requestedShares > 0 ? agg.filledShares / agg.requestedShares : 1;
  const part = sliceOfCluster(agg, 250);
  assert.equal(part.requestedShares, 250);
  assert.ok(Math.abs(part.filledShares - 250 * frac) < 1e-6);
});
