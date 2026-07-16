import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as RR from "../src/lib/realRepo.js";

function db() { const d = openDb(":memory:"); initSchema(d); return d; }
const baseOrder = (over: Partial<RR.RealOrderRow> = {}) => ({
  id: "o1", client_order_id: "c1", exchange_order_id: null, decision_id: "dec1",
  strategy_id: "overreaction", profile_id: "medium", match_id: "m1", token_id: "tok1",
  side: "BUY" as const, leg: "entry", limit_price_cents: 45, size_usd: 50, tif_sec: 45,
  code_version: "e1", whitelist_version: 1, note: null, created_at: "2026-07-15T10:00:00.000Z", ...over,
});

test("real_orders: insert stamps a 'created' event; idempotent on client_order_id", () => {
  const d = db();
  const o = RR.insertRealOrder(d, baseOrder());
  assert.equal(o.status, "created");
  assert.equal(o.filled_size_usd, 0);
  assert.deepEqual(RR.realOrderEvents(d, "o1").map((e) => e.status), ["created"], "first transition logged");
  // Re-insert with the SAME client_order_id → the SAME order, not a second row (the §4.3 retry contract).
  const again = RR.insertRealOrder(d, baseOrder({ id: "o2" }));
  assert.equal(again.id, "o1", "idempotent — returns the existing order");
  assert.equal(RR.listRealOrders(d).length, 1, "no duplicate order created");
});

test("real_orders: each transition is logged with its own timestamp → latency reads exactly", () => {
  const d = db();
  RR.insertRealOrder(d, baseOrder());
  RR.transitionRealOrder(d, "o1", "placed", "2026-07-15T10:00:00.250Z", { exchangeOrderId: "x1" });
  RR.transitionRealOrder(d, "o1", "partial", "2026-07-15T10:00:01.000Z", { filledSizeUsd: 20, avgFillCents: 46 });
  RR.transitionRealOrder(d, "o1", "filled", "2026-07-15T10:00:02.000Z", { filledSizeUsd: 50, avgFillCents: 46 });
  assert.deepEqual(RR.realOrderEvents(d, "o1").map((e) => e.status), ["created", "placed", "partial", "filled"]);
  const row = RR.getRealOrder(d, "o1")!;
  assert.equal(row.status, "filled");
  assert.equal(row.exchange_order_id, "x1");
  assert.equal(row.filled_size_usd, 50);
  // §7 latency: created→placed = 250ms, placed→first_fill(partial) = 750ms.
  assert.equal(RR.realOrderLatencyMs(d, "o1", "created", "placed"), 250);
  assert.equal(RR.realOrderLatencyMs(d, "o1", "placed", "partial"), 750);
  assert.equal(RR.realOrderLatencyMs(d, "o1", "created", "cancelled"), null, "absent transition → null");
});

test("real_fills: per-fill rows accumulate under an order", () => {
  const d = db();
  RR.insertRealOrder(d, baseOrder());
  RR.insertRealFill(d, { order_id: "o1", client_order_id: "c1", token_id: "tok1", side: "BUY", size_usd: 20, price_cents: 46, fee_usd: 0.15, at: "t1", created_at: "t1" });
  RR.insertRealFill(d, { order_id: "o1", client_order_id: "c1", token_id: "tok1", side: "BUY", size_usd: 30, price_cents: 47, fee_usd: 0.22, at: "t2", created_at: "t2" });
  assert.equal(RR.realFillsForOrder(d, "o1").length, 2);
});

test("real_ledger: typed kinds sum by type; a bad kind is rejected by the CHECK", () => {
  const d = db();
  RR.insertRealLedger(d, { kind: "deposit", amount_usd: 300, token_id: null, order_id: null, ref: "seed", at: "t", created_at: "t" });
  RR.insertRealLedger(d, { kind: "fill", amount_usd: -50, token_id: "tok1", order_id: "o1", ref: null, at: "t", created_at: "t" });
  RR.insertRealLedger(d, { kind: "fee", amount_usd: -0.4, token_id: "tok1", order_id: "o1", ref: null, at: "t", created_at: "t" });
  const byKind = RR.realLedgerByKind(d);
  assert.equal(byKind.deposit, 300);
  assert.equal(byKind.fill, -50);
  assert.equal(Math.round(RR.realLedgerBalance(d) * 100) / 100, 249.6, "net balance = 300 − 50 − 0.4");
  assert.throws(() => RR.insertRealLedger(d, { kind: "bribe" as any, amount_usd: 1, token_id: null, order_id: null, ref: null, at: "t", created_at: "t" }), /CHECK|constraint/i, "free-text kind rejected");
});

test("real_whitelist: sport is hard-pinned football — tennis is rejected at the DB", () => {
  const d = db();
  const now = "2026-07-15T10:00:00Z";
  d.prepare(`INSERT INTO real_whitelist(id,strategy_id,sport,categories,max_order_usd,enabled,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run("w1", "overreaction", "football", JSON.stringify(["pm-soccer-fifwc"]), 50, 0, 1, now, now);
  RR.appendWhitelistLog(d, 1, "add", JSON.stringify({ strategy: "overreaction" }), "owner", now);
  assert.equal(RR.listWhitelist(d).length, 1);
  assert.equal(RR.currentWhitelistVersion(d), 1);
  assert.throws(() => d.prepare(`INSERT INTO real_whitelist(id,strategy_id,sport,categories,max_order_usd,enabled,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run("w2", "tennis_set_value", "tennis", "[]", 50, 0, 1, now, now), /CHECK|constraint/i, "tennis can't reach real this stage");
});

test("real_positions: upsert by (token, decision, dry) round-trips", () => {
  const d = db();
  RR.upsertRealPosition(d, { token_id: "tok1", decision_id: "dec1", profile_id: "medium", match_id: "m1", strategy_id: "overreaction", size_shares: 100, avg_price_cents: 45, realized_pnl_usd: 0, unrealized_pnl_usd: 2, updated_at: "t1" });
  RR.upsertRealPosition(d, { token_id: "tok1", decision_id: "dec1", profile_id: "medium", match_id: "m1", strategy_id: "overreaction", size_shares: 150, avg_price_cents: 44, realized_pnl_usd: 0, unrealized_pnl_usd: 5, updated_at: "t2" });
  assert.equal(RR.listRealPositions(d).length, 1, "same twin → updated in place, not duplicated");
  assert.equal(RR.listRealPositions(d)[0].size_shares, 150, "updated in place");
  // B1: a DIFFERENT decision on the same token is its OWN row (no merge).
  RR.upsertRealPosition(d, { token_id: "tok1", decision_id: "dec2", profile_id: "aggressive", match_id: "m1", strategy_id: "overreaction", size_shares: 40, avg_price_cents: 50, realized_pnl_usd: 0, unrealized_pnl_usd: null, updated_at: "t3" });
  assert.equal(RR.listRealPositions(d).length, 2, "second twin on the same token → separate row");
});
