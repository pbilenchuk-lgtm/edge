// ─────────────────────────────────────────────────────────────────────────────
// REAL-TRADING repo (spec §2.3 / §5). DB access for the real contour, kept in its
// OWN module to reinforce isolation: the simulation never imports this, and this
// never writes to sim tables. Build != enable — these functions exist for the
// dry-run/real executor; nothing calls them until REAL_TRADING is on.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "./db.js";
import { randomUUID } from "node:crypto";

const uid = () => randomUUID();

export type RealOrderStatus = "created" | "placed" | "partial" | "filled" | "expired" | "cancelled" | "rejected" | "dry_run";
export type RealLedgerKind = "deposit" | "fill" | "fee" | "redemption" | "gas" | "withdrawal";

export interface RealOrderRow {
  id: string; client_order_id: string; exchange_order_id: string | null; decision_id: string;
  strategy_id: string; profile_id: string; match_id: string; token_id: string;
  side: "BUY" | "SELL"; leg: string; limit_price_cents: number; size_usd: number; tif_sec: number;
  status: RealOrderStatus; filled_size_usd: number; avg_fill_cents: number | null;
  code_version: string | null; whitelist_version: number | null; note: string | null; created_at: string;
}

// ── real_orders + transition log ─────────────────────────────────────────────

/** Insert a freshly-built order in status "created" and stamp the first transition event.
 *  Idempotent on client_order_id: a re-insert with the same id is a no-op that returns the
 *  existing row (the §4.3 crash-retry contract — never a second order). */
export function insertRealOrder(db: Database, o: Omit<RealOrderRow, "status" | "filled_size_usd" | "avg_fill_cents"> & { status?: RealOrderStatus }): RealOrderRow {
  const existing = getRealOrderByClientId(db, o.client_order_id);
  if (existing) return existing; // idempotency: same client_order_id → the same order
  const status: RealOrderStatus = o.status ?? "created";
  db.prepare(
    `INSERT INTO real_orders(id,client_order_id,exchange_order_id,decision_id,strategy_id,profile_id,match_id,
       token_id,side,leg,limit_price_cents,size_usd,tif_sec,status,filled_size_usd,avg_fill_cents,code_version,whitelist_version,note,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,?,?)`,
  ).run(o.id, o.client_order_id, o.exchange_order_id, o.decision_id, o.strategy_id, o.profile_id, o.match_id,
    o.token_id, o.side, o.leg, o.limit_price_cents, o.size_usd, o.tif_sec, status, o.code_version, o.whitelist_version, o.note, o.created_at);
  appendRealOrderEvent(db, o.id, status, o.created_at, "order created");
  return getRealOrderByClientId(db, o.client_order_id)!;
}

export function getRealOrderByClientId(db: Database, clientOrderId: string): RealOrderRow | null {
  return (db.prepare(`SELECT * FROM real_orders WHERE client_order_id=?`).get(clientOrderId) as RealOrderRow | undefined) ?? null;
}
export function getRealOrder(db: Database, id: string): RealOrderRow | null {
  return (db.prepare(`SELECT * FROM real_orders WHERE id=?`).get(id) as RealOrderRow | undefined) ?? null;
}
export function listRealOrders(db: Database, status?: RealOrderStatus): RealOrderRow[] {
  return (status
    ? db.prepare(`SELECT * FROM real_orders WHERE status=? ORDER BY created_at`).all(status)
    : db.prepare(`SELECT * FROM real_orders ORDER BY created_at`).all()) as RealOrderRow[];
}

/** Append ONE status-transition event (its own timestamp) — the §7 latency source. */
export function appendRealOrderEvent(db: Database, orderId: string, status: RealOrderStatus, at: string, note?: string): void {
  db.prepare(`INSERT INTO real_order_events(id,order_id,status,at,note) VALUES(?,?,?,?,?)`).run(uid(), orderId, status, at, note ?? null);
}
export function realOrderEvents(db: Database, orderId: string): { status: RealOrderStatus; at: string; note: string | null }[] {
  return db.prepare(`SELECT status,at,note FROM real_order_events WHERE order_id=? ORDER BY at`).all(orderId) as any;
}

/** Move an order to a new status: update the row AND append the transition event (with its own
 *  timestamp), so the trail is never lost. exchangeOrderId/filled/avg are set when known. */
export function transitionRealOrder(db: Database, orderId: string, status: RealOrderStatus, at: string, patch: { exchangeOrderId?: string | null; filledSizeUsd?: number; avgFillCents?: number | null; note?: string } = {}): void {
  const sets: string[] = ["status=?"]; const vals: any[] = [status];
  if (patch.exchangeOrderId !== undefined) { sets.push("exchange_order_id=?"); vals.push(patch.exchangeOrderId); }
  if (patch.filledSizeUsd !== undefined) { sets.push("filled_size_usd=?"); vals.push(patch.filledSizeUsd); }
  if (patch.avgFillCents !== undefined) { sets.push("avg_fill_cents=?"); vals.push(patch.avgFillCents); }
  db.prepare(`UPDATE real_orders SET ${sets.join(", ")} WHERE id=?`).run(...vals, orderId);
  appendRealOrderEvent(db, orderId, status, at, patch.note);
}

/** Latency (ms) between two transition statuses for an order — decision→place→first_fill (§7).
 *  Returns null if either transition is absent. */
export function realOrderLatencyMs(db: Database, orderId: string, from: RealOrderStatus, to: RealOrderStatus): number | null {
  const evs = realOrderEvents(db, orderId);
  const a = evs.find((e) => e.status === from)?.at, b = evs.find((e) => e.status === to)?.at;
  if (!a || !b) return null;
  const ms = (Date.parse(b) || 0) - (Date.parse(a) || 0);
  return Number.isFinite(ms) ? ms : null;
}

// ── real_fills ───────────────────────────────────────────────────────────────
export interface RealFillRow { id: string; order_id: string; client_order_id: string; token_id: string; side: "BUY" | "SELL"; size_usd: number; price_cents: number; fee_usd: number; at: string; created_at: string }
export function insertRealFill(db: Database, f: Omit<RealFillRow, "id">): string {
  const id = uid();
  db.prepare(`INSERT INTO real_fills(id,order_id,client_order_id,token_id,side,size_usd,price_cents,fee_usd,at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, f.order_id, f.client_order_id, f.token_id, f.side, f.size_usd, f.price_cents, f.fee_usd, f.at, f.created_at);
  return id;
}
export function realFillsForOrder(db: Database, orderId: string): RealFillRow[] {
  return db.prepare(`SELECT * FROM real_fills WHERE order_id=? ORDER BY at`).all(orderId) as RealFillRow[];
}

// ── real_positions ───────────────────────────────────────────────────────────
export interface RealPositionRow { token_id: string; match_id: string | null; strategy_id: string | null; size_shares: number; avg_price_cents: number | null; realized_pnl_usd: number; unrealized_pnl_usd: number | null; updated_at: string }
export function upsertRealPosition(db: Database, p: RealPositionRow): void {
  db.prepare(
    `INSERT INTO real_positions(token_id,match_id,strategy_id,size_shares,avg_price_cents,realized_pnl_usd,unrealized_pnl_usd,updated_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(token_id) DO UPDATE SET match_id=excluded.match_id, strategy_id=excluded.strategy_id,
       size_shares=excluded.size_shares, avg_price_cents=excluded.avg_price_cents,
       realized_pnl_usd=excluded.realized_pnl_usd, unrealized_pnl_usd=excluded.unrealized_pnl_usd, updated_at=excluded.updated_at`,
  ).run(p.token_id, p.match_id, p.strategy_id, p.size_shares, p.avg_price_cents, p.realized_pnl_usd, p.unrealized_pnl_usd, p.updated_at);
}
export function listRealPositions(db: Database): RealPositionRow[] {
  return db.prepare(`SELECT * FROM real_positions ORDER BY updated_at DESC`).all() as RealPositionRow[];
}

// ── real_ledger ──────────────────────────────────────────────────────────────
export interface RealLedgerRow { id: string; kind: RealLedgerKind; amount_usd: number; token_id: string | null; order_id: string | null; ref: string | null; at: string; created_at: string }
export function insertRealLedger(db: Database, e: Omit<RealLedgerRow, "id">): string {
  const id = uid();
  db.prepare(`INSERT INTO real_ledger(id,kind,amount_usd,token_id,order_id,ref,at,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, e.kind, e.amount_usd, e.token_id, e.order_id, e.ref, e.at, e.created_at);
  return id;
}
/** Net USDC by kind (§4.4 reconciliation reasons by TYPE, not free text). */
export function realLedgerByKind(db: Database): Record<string, number> {
  const rows = db.prepare(`SELECT kind, SUM(amount_usd) AS net FROM real_ledger GROUP BY kind`).all() as { kind: string; net: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.net;
  return out;
}
export function realLedgerBalance(db: Database): number {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_usd),0) AS bal FROM real_ledger`).get() as { bal: number };
  return r.bal ?? 0;
}

// ── real_whitelist (§5) ──────────────────────────────────────────────────────
export interface RealWhitelistRow { id: string; strategy_id: string; sport: string; categories: string; max_order_usd: number; enabled: number; version: number; created_at: string; updated_at: string }
export function listWhitelist(db: Database, enabledOnly = false): RealWhitelistRow[] {
  return (enabledOnly
    ? db.prepare(`SELECT * FROM real_whitelist WHERE enabled=1`).all()
    : db.prepare(`SELECT * FROM real_whitelist`).all()) as RealWhitelistRow[];
}
export function currentWhitelistVersion(db: Database): number {
  const r = db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM real_whitelist_log`).get() as { v: number };
  return r.v ?? 0;
}
export function appendWhitelistLog(db: Database, version: number, action: string, detail: string | null, actor: string | null, at: string): void {
  db.prepare(`INSERT INTO real_whitelist_log(id,version,action,detail,actor,at) VALUES(?,?,?,?,?,?)`).run(uid(), version, action, detail, actor, at);
}
