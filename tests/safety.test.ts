import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as RR from "../src/lib/realRepo.js";
import {
  readTradingMode, entriesAllowed, sendsRealOrders, loadSafetyCaps, enforceCaps,
  conformOrderToMarket, resolveRetry, reconcile,
} from "../src/lib/executor/safety.js";

function db() { const d = openDb(":memory:"); initSchema(d); return d; }
const CAPS = { maxOrderUsd: 50, maxExposureUsd: 200, maxDailyLossUsd: 60, maxOrdersPerHour: 20 };
const NOW = Date.parse("2026-07-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;
function seedOrder(d: ReturnType<typeof db>, o: { side?: "BUY" | "SELL"; filled?: number; status?: RR.RealOrderStatus; at?: string; expiryMode?: string; deadline?: string }) {
  const id = `o${seq++}`;
  RR.insertRealOrder(d, { id, client_order_id: id, exchange_order_id: null, decision_id: id, strategy_id: "overreaction", profile_id: "medium", match_id: "m1", token_id: "tok1", side: o.side ?? "BUY", leg: "entry", limit_price_cents: 45, size_usd: 50, tif_sec: 45, code_version: "e1", whitelist_version: 1, note: null, created_at: o.at ?? iso(NOW), expiry_mode: o.expiryMode ?? null, client_cancel_deadline: o.deadline ?? null });
  if (o.status && o.status !== "created") RR.transitionRealOrder(d, id, o.status, o.at ?? iso(NOW), { filledSizeUsd: o.filled ?? 0 });
  return id;
}

// ── §4.2 kill switch ──────────────────────────────────────────────────────────
test("readTradingMode: fresh read, off by default, four valid states", () => {
  assert.equal(readTradingMode({}), "off", "unset → off (fail-safe)");
  assert.equal(readTradingMode({ REAL_TRADING: "garbage" }), "off", "unknown → off");
  for (const m of ["off", "dry_run", "exits_only", "on"] as const) assert.equal(readTradingMode({ REAL_TRADING: m.toUpperCase() }), m);
  assert.equal(entriesAllowed("on"), true);
  assert.equal(entriesAllowed("exits_only"), false, "exits_only forbids new entries");
  assert.equal(sendsRealOrders("dry_run"), false, "dry_run sends nothing real");
  assert.equal(sendsRealOrders("on"), true);
});

// ── §4.1 hard caps ─────────────────────────────────────────────────────────────
test("enforceCaps: order-size clamp to the per-order ceiling", () => {
  const d = db();
  const r = enforceCaps(d, { sizeUsd: 500, isEntry: true }, NOW, CAPS);
  assert.equal(r.action, "allow");
  assert.equal(r.sizeUsd, 50, "clamped to maxOrderUsd");
  assert.equal(r.clamped, true);
});
test("enforceCaps: exposure ceiling rejects a new entry over the cap", () => {
  const d = db();
  seedOrder(d, { side: "BUY", filled: 180, status: "filled" }); // $180 open
  const r = enforceCaps(d, { sizeUsd: 50, isEntry: true }, NOW, CAPS); // 180+50 > 200
  assert.equal(r.action, "reject");
  assert.match(r.reason ?? "", /экспозиция/);
});
test("enforceCaps: daily-loss auto-pause trips exits_only", () => {
  const d = db();
  RR.insertRealLedger(d, { kind: "fill", amount_usd: -70, token_id: "tok1", order_id: "o", ref: null, at: "2026-07-15T09:00:00Z", created_at: "t" });
  const r = enforceCaps(d, { sizeUsd: 10, isEntry: true }, NOW, CAPS);
  assert.equal(r.action, "pause", "≥$60 realized loss today → pause");
});
test("enforceCaps: orders/hour berserk guard rejects", () => {
  const d = db();
  for (let i = 0; i < 20; i++) seedOrder(d, { at: iso(NOW - 60_000) }); // 20 orders in the last hour
  const r = enforceCaps(d, { sizeUsd: 10, isEntry: true }, NOW, CAPS);
  assert.equal(r.action, "reject");
  assert.match(r.reason ?? "", /берсерка|час/);
});
test("enforceCaps: a defensive EXIT is never blocked by the caps", () => {
  const d = db();
  seedOrder(d, { side: "BUY", filled: 199, status: "filled" }); // exposure near cap
  RR.insertRealLedger(d, { kind: "fill", amount_usd: -100, token_id: "t", order_id: "o", ref: null, at: "2026-07-15T09:00:00Z", created_at: "t" }); // loss over cap
  const r = enforceCaps(d, { sizeUsd: 200, isEntry: false }, NOW, CAPS);
  assert.equal(r.action, "allow", "a stop must always be able to leave");
});

// ── §4.1 fifth cap: conform to market tick + min size ──────────────────────────
test("conformOrderToMarket: BUY floors to tick, SELL ceils to tick", () => {
  assert.equal(conformOrderToMarket({ side: "BUY", limitPriceCents: 45.7, sizeUsd: 50 }, { tickCents: 1, minOrderUsd: 5, tolCents: 1 }).limitPriceCents, 45, "BUY floors (never overpay)");
  assert.equal(conformOrderToMarket({ side: "SELL", limitPriceCents: 45.2, sizeUsd: 50 }, { tickCents: 1, minOrderUsd: 5, tolCents: 1 }).limitPriceCents, 46, "SELL ceils (never undersell)");
});
test("conformOrderToMarket: ±1¢ tolerance below the tick → skip (coarse-tick market)", () => {
  const r = conformOrderToMarket({ side: "BUY", limitPriceCents: 40, sizeUsd: 50 }, { tickCents: 10, minOrderUsd: 5, tolCents: 1 }); // 0.1 tick
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /суб-тик/);
});
test("conformOrderToMarket: notional below the market minimum → skip", () => {
  const r = conformOrderToMarket({ side: "BUY", limitPriceCents: 45, sizeUsd: 3 }, { tickCents: 1, minOrderUsd: 5, tolCents: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /мин\. размер/);
});

// ── §4.3 idempotent retry ──────────────────────────────────────────────────────
test("resolveRetry: with the signed blob, RESEND the same (never re-sign); wait only if already live", () => {
  assert.equal(resolveRetry({ orderHash: "0xabc" }, "unknown"), "resend_same", "timeout → resend the SAME blob (same hash)");
  assert.equal(resolveRetry({ orderHash: "0xabc" }, "absent"), "resend_same", "confirmed-absent → still resend same, not a new order");
  assert.equal(resolveRetry({ orderHash: "0xabc" }, "exists"), "wait", "already on the exchange → just wait for the fill");
});
test("resolveRetry: blob lost → new intent ONLY on confirmed absence, else wait (never a blind re-sign)", () => {
  assert.equal(resolveRetry({ orderHash: null }, "absent"), "new_intent", "confirmed absent → sign a fresh intent (logged)");
  assert.equal(resolveRetry({ orderHash: null }, "unknown"), "wait", "unconfirmed → an order may be live → wait");
  assert.equal(resolveRetry({ orderHash: null }, "exists"), "wait");
});

// ── §4.4 reconciliation ────────────────────────────────────────────────────────
test("reconcile: clean → ok; a balance or position gap → exits_only + discrepancy list", () => {
  const clean = reconcile({ ledgerBalanceUsd: 300, positions: [{ tokenId: "t1", sizeShares: 100 }] }, { balanceUsd: 300.5, positions: [{ tokenId: "t1", sizeShares: 100 }] });
  assert.equal(clean.action, "ok", "within $1 / 1 token tolerance");
  const bal = reconcile({ ledgerBalanceUsd: 300, positions: [] }, { balanceUsd: 250, positions: [] });
  assert.equal(bal.action, "exits_only");
  const pos = reconcile({ ledgerBalanceUsd: 300, positions: [{ tokenId: "t1", sizeShares: 100 }] }, { balanceUsd: 300, positions: [{ tokenId: "t1", sizeShares: 40 }] });
  assert.equal(pos.action, "exits_only");
  assert.ok(pos.discrepancies[0].includes("t1"));
  const ghost = reconcile({ ledgerBalanceUsd: 300, positions: [] }, { balanceUsd: 300, positions: [{ tokenId: "t9", sizeShares: 50 }] });
  assert.equal(ghost.action, "exits_only", "an exchange position we don't know about is a discrepancy");
});

// ── §4.4 / §1 persistent client-cancel expiry sweep ────────────────────────────
test("expiredClientCancelOrders: a placed client-cancel order past its deadline is swept (survives restart)", () => {
  const d = db();
  seedOrder(d, { status: "placed", expiryMode: "client-cancel", deadline: iso(NOW - 1000) }); // past deadline
  seedOrder(d, { status: "placed", expiryMode: "client-cancel", deadline: iso(NOW + 60_000) }); // still live
  seedOrder(d, { status: "placed", expiryMode: "native-GTD", deadline: iso(NOW - 1000) }); // GTD → exchange handles it, not swept
  const due = RR.expiredClientCancelOrders(d, iso(NOW));
  assert.equal(due.length, 1, "only the past-deadline client-cancel order is due for cancel");
});
