import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as RR from "../src/lib/realRepo.js";
import { DryRunExecutor } from "../src/lib/executor/dryRun.js";
import { clientOrderIdFor, type OrderRequest } from "../src/lib/executor/types.js";
import { checkOrphanPositions } from "../src/lib/executor/safety.js";

function db() { const d = openDb(":memory:"); initSchema(d); return d; }
const POLY: any = { enabled: true, exec: { edgeFloorCents: 1, maxImpactCents: 10, fallbackK: 20, takerFeeRate: 0.0075 } };
const bookFetch = (book: any) => (async (url: any) => String(url).includes("/book") ? ({ ok: true, status: 200, json: async () => book } as any) : ({ ok: false, status: 404, json: async () => ({}) } as any)) as unknown as typeof fetch;
const NOW = "2026-07-15T12:00:00.000Z";
const order = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  clientOrderId: clientOrderIdFor("dec-1", "entry"), leg: "entry", tokenId: "tok1", side: "BUY",
  limitPriceCents: 45, sizeUsd: 40, timeInForceSec: 45, decisionId: "dec-1",
  strategyId: "overreaction", profileId: "medium", matchId: "m1", fairValueCents: 55, expiryMode: "client-cancel", ...over,
});
function exec(d: ReturnType<typeof db>, book: any, env: Record<string, string | undefined> = { REAL_TRADING: "dry_run" }, whitelistVersion = 3) {
  return new DryRunExecutor({ db: d, env, poly: POLY, deps: { fetchImpl: bookFetch(book) }, bookCache: new Map(), now: () => NOW, whitelistVersion });
}

test("DryRunExecutor: BUY entry runs the FULL path end-to-end with every transition timestamp + twin/whitelist fields", async () => {
  const d = db();
  const ack = await exec(d, { bids: [{ price: "0.39", size: "1000" }], asks: [{ price: "0.40", size: "1000" }] }).place(order());
  assert.equal(ack.status, "filled");
  assert.ok((ack.avgFillPriceCents ?? 0) >= 40 && (ack.avgFillPriceCents ?? 0) < 41, "filled at the 40¢ ask (+fee), ≤ 45¢ limit");
  const row = RR.getRealOrderByClientId(d, order().clientOrderId)!;
  // twin-link + whitelist version carried on the order.
  assert.equal(row.decision_id, "dec-1", "twin link to the paper bet");
  assert.equal(row.whitelist_version, 3);
  assert.equal(row.exchange_order_id, null, "dry-run → no exchange id (this is how real vs dry is told apart)");
  assert.equal(row.expiry_mode, "client-cancel");
  assert.ok(row.client_cancel_deadline && row.client_cancel_deadline > NOW, "persistent cancel deadline set (= now + TIF)");
  // full transition trail, each with its own timestamp.
  const evs = RR.realOrderEvents(d, row.id).map((e) => e.status);
  assert.deepEqual(evs, ["created", "placed", "filled"], "created→placed→filled");
  // accounting: a fill row, ledger cash-out + fee, a position.
  assert.equal(RR.realFillsForOrder(d, row.id).length, 1);
  const byKind = RR.realLedgerByKind(d);
  assert.ok(byKind.fill < 0, "BUY debits the ledger");
  assert.ok((byKind.fee ?? 0) < 0, "taker fee booked");
  assert.equal(RR.listRealPositions(d).length, 1, "position opened");
});

test("DryRunExecutor: limit below the best ask → TIF EXPIRED, no fill, no position", async () => {
  const d = db();
  const ack = await exec(d, { bids: [], asks: [{ price: "0.50", size: "1000" }] }).place(order({ limitPriceCents: 45 }));
  assert.equal(ack.status, "expired", "best ask 50¢ > 45¢ limit → nothing fills in the window");
  assert.equal(ack.filledSizeUsd, 0);
  const evs = RR.realOrderEvents(d, RR.getRealOrderByClientId(d, order().clientOrderId)!.id).map((e) => e.status);
  assert.deepEqual(evs, ["created", "placed", "expired"]);
  assert.equal(RR.listRealPositions(d).length, 0, "no position from an expired order");
});

test("DryRunExecutor: idempotent — re-place with the same clientOrderId does not double-fill", async () => {
  const d = db();
  const book = { bids: [], asks: [{ price: "0.40", size: "1000" }] };
  const first = await exec(d, book).place(order());
  const second = await exec(d, book).place(order());
  assert.equal(first.status, "filled");
  assert.match(second.note ?? "", /идемпотентно/);
  assert.equal(RR.listRealOrders(d).length, 1, "one order");
  assert.equal(RR.realFillsForOrder(d, RR.getRealOrderByClientId(d, order().clientOrderId)!.id).length, 1, "one fill, not two");
});

test("DryRunExecutor: over-cap size is clamped by the belt before the fill", async () => {
  const d = db();
  const ack = await exec(d, { bids: [], asks: [{ price: "0.40", size: "10000" }] }).place(order({ sizeUsd: 500 }));
  assert.equal(ack.status, "filled");
  assert.equal(ack.clamped, true);
  const row = RR.getRealOrderByClientId(d, order().clientOrderId)!;
  assert.equal(row.size_usd, 50, "clamped to REAL_MAX_ORDER_USD before sizing the fill");
  assert.ok(row.note?.includes("урезан"));
});

test("DryRunExecutor: mode off → the executor is inert (rejected, nothing booked)", async () => {
  const d = db();
  const ack = await exec(d, { bids: [], asks: [{ price: "0.40", size: "1000" }] }, { REAL_TRADING: "off" }).place(order());
  assert.equal(ack.status, "rejected");
  assert.equal(RR.listRealOrders(d).length, 0, "off books nothing");
});

// ── orphan-positions sentinel ──────────────────────────────────────────────────
test("checkOrphanPositions: a REAL open position + a no-exit mode → loud persistent alert", () => {
  const d = db();
  // Simulate a REAL fill: an order WITH an exchange id + a position on its token.
  RR.insertRealOrder(d, { id: "ro", client_order_id: "rc", exchange_order_id: "0xhash", decision_id: "dec", strategy_id: "overreaction", profile_id: "medium", match_id: "m1", token_id: "tokR", side: "BUY", leg: "entry", limit_price_cents: 45, size_usd: 50, tif_sec: 45, code_version: null, whitelist_version: 1, note: null, created_at: NOW });
  RR.upsertRealPosition(d, { token_id: "tokR", match_id: "m1", strategy_id: "overreaction", size_shares: 100, avg_price_cents: 45, realized_pnl_usd: 0, unrealized_pnl_usd: null, updated_at: NOW });
  const off = checkOrphanPositions(d, "off", NOW);
  assert.equal(off.alert, true, "real position + off (no exits) → orphan alert");
  assert.equal(RR.getRealOrphanAlert(d)?.message, off.message, "alert persisted for UI + logs");
  // exits_only CAN manage them → no alert (and clears a prior one).
  const ok = checkOrphanPositions(d, "exits_only", NOW);
  assert.equal(ok.alert, false, "exits_only can exit → not orphaned");
  assert.equal(RR.getRealOrphanAlert(d), null, "alert cleared when the combo resolves");
});

test("checkOrphanPositions: a DRY-run position never triggers the sentinel (no real risk)", () => {
  const d = db();
  // A dry position: order with NO exchange id (dry) + a position.
  RR.insertRealOrder(d, { id: "do", client_order_id: "dc", exchange_order_id: null, decision_id: "dec", strategy_id: "overreaction", profile_id: "medium", match_id: "m1", token_id: "tokD", side: "BUY", leg: "entry", limit_price_cents: 45, size_usd: 50, tif_sec: 45, code_version: null, whitelist_version: 1, note: null, created_at: NOW });
  RR.upsertRealPosition(d, { token_id: "tokD", match_id: "m1", strategy_id: "overreaction", size_shares: 100, avg_price_cents: 45, realized_pnl_usd: 0, unrealized_pnl_usd: null, updated_at: NOW });
  assert.equal(checkOrphanPositions(d, "off", NOW).alert, false, "dry position carries no real risk → no false alarm in dry-run");
});
