import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import { buildPmvEdgeReport, unitPnl, bootstrapMeanCi, PMV_EDGE_NEED_N } from "../src/lib/pmvEdge.js";

function seed(db: any, rows: { mid: number; won: boolean; dev?: number; status?: string }[]) {
  let i = 0;
  for (const r of rows) {
    db.prepare(
      `INSERT INTO pmv_shadow_signals (id,match_id,market_label,family,side,theo_cents,mid_cents,deviation,epoch,status,created_at)
       VALUES (?,?,?,'total','over',?,?,?,'e9·shadow-s1',?,'t')`,
    ).run(`s${i}`, `m${i}`, `L${i++}`, r.mid + (r.dev ?? 10), r.mid, r.dev ?? 10, r.status ?? (r.won ? "won" : "lost"));
  }
}

test("unitPnl: арифметика бинарного контракта — $1 по 40¢ выигрывает $1.50 и теряет $1", () => {
  // $1 покупает 2.5 доли по 40¢; выигрыш платит $1 за долю → $2.50 на руки, минус вложенный $1 = +$1.50.
  assert.equal(Math.round(unitPnl(40, true, 0) * 100) / 100, 1.5);
  assert.equal(unitPnl(40, false, 0), -1);
  // Комиссия берётся с оборота и списывается независимо от исхода — потому вычитается в обе стороны.
  assert.equal(Math.round(unitPnl(40, true, 0.02) * 100) / 100, 1.48);
  assert.equal(Math.round(unitPnl(40, false, 0.02) * 100) / 100, -1.02);
  // Вырожденные цены — не ставка, а не «бесконечный край».
  assert.equal(unitPnl(0, true, 0.02), 0);
  assert.equal(unitPnl(100, true, 0.02), 0);
});

test("КОНТРОЛЬ МЕТОДА: на честной игре по честной цене нетто-край равен ровно минус комиссии", () => {
  // Это главный тест файла. Если метод показывает край там, где рынок прав по построению, он сломан и
  // любой его положительный ответ на реальных данных ничего не стоит. 50¢ и ровно половина выигрышей —
  // край до комиссии обязан быть нулём, после — ровно −feeRate.
  const db = openDb(":memory:"); initSchema(db);
  seed(db, Array.from({ length: 60 }, (_, i) => ({ mid: 50, won: i % 2 === 0 })));
  const r = buildPmvEdgeReport(db, { POLYMARKET_TAKER_FEE_RATE: "0.02" });
  assert.equal(r.n, 60);
  assert.equal(r.grossPerDollar, 0, "честная цена при честной монете → нулевой валовой край");
  assert.equal(r.netPerDollar, -0.02, "…и ровно минус комиссия после издержек");
  assert.equal(r.verdict, "край_не_подтверждён");
});

test("КРИТЕРИЙ ЗРЕЛОСТИ сильнее красивого результата: n<40 всегда insufficient", () => {
  // Защита от того самого соблазна, ради которого критерий и объявляется заранее: десяток выигрышей подряд
  // по дешёвой цене даёт роскошный P&L, и без порога n он был бы объявлен краем.
  const db = openDb(":memory:"); initSchema(db);
  seed(db, Array.from({ length: 12 }, () => ({ mid: 30, won: true })));
  const r = buildPmvEdgeReport(db, { POLYMARKET_TAKER_FEE_RATE: "0.02" });
  assert.ok(r.n < PMV_EDGE_NEED_N);
  assert.ok((r.netPerDollar ?? 0) > 2, "P&L огромен…");
  assert.equal(r.verdict, "insufficient", "…и всё равно вердикт «мало данных», а не «край»");
  assert.match(r.note, /КОПИМ/);
});

test("настоящий край проходит критерий: интервал целиком выше нуля", () => {
  const db = openDb(":memory:"); initSchema(db);
  // 50¢ при реальной частоте 70% — край, который переживает комиссию с большим запасом.
  seed(db, Array.from({ length: 100 }, (_, i) => ({ mid: 50, won: i % 10 < 7 })));
  const r = buildPmvEdgeReport(db, { POLYMARKET_TAKER_FEE_RATE: "0.02" });
  assert.equal(r.verdict, "край_подтверждён");
  assert.ok(r.ci!.lo > 0, "нижняя граница строго выше нуля");
});

test("отрицательный край не выдаётся за «мало данных»: интервал целиком ниже нуля", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db, Array.from({ length: 100 }, (_, i) => ({ mid: 50, won: i % 10 < 3 })));
  const r = buildPmvEdgeReport(db, { POLYMARKET_TAKER_FEE_RATE: "0.02" });
  assert.equal(r.verdict, "край_не_подтверждён");
  assert.ok(r.ci!.hi < 0);
});

test("бутстрап детерминирован — отчёт обязан воспроизводиться числом в число", () => {
  const xs = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? 1.2 : -1.02));
  assert.deepEqual(bootstrapMeanCi(xs), bootstrapMeanCi(xs));
  assert.equal(bootstrapMeanCi([1]), null, "на одном наблюдении интервала нет — и он не выдумывается");
});

test("в расчёт идут только разрешённые: pending/void/unresolved не подмешиваются в край", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db, [
    { mid: 50, won: true }, { mid: 50, won: false },
    { mid: 50, won: true, status: "pending" }, { mid: 50, won: true, status: "void" }, { mid: 50, won: true, status: "unresolved" },
  ]);
  const r = buildPmvEdgeReport(db, {});
  assert.equal(r.n, 2, "только won/lost");
  assert.equal(r.counts.pending, 1); assert.equal(r.counts.void, 1); assert.equal(r.counts.unresolved, 1);
});

test("бакеты по отклонению разносят сигналы и не теряют ни одного", () => {
  const db = openDb(":memory:"); initSchema(db);
  seed(db, [
    { mid: 50, won: true, dev: 3 }, { mid: 50, won: false, dev: 7 },
    { mid: 50, won: true, dev: 12 }, { mid: 50, won: false, dev: 17 }, { mid: 50, won: true, dev: 25 },
  ]);
  const r = buildPmvEdgeReport(db, {});
  assert.equal(r.buckets.reduce((s, b) => s + b.n, 0), r.n, "сумма по бакетам равна выборке");
  assert.deepEqual(r.buckets.map((b) => b.n), [1, 1, 1, 1, 1]);
});
