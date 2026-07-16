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
  id: string; client_order_id: string; salt: string | null; order_hash: string | null; exchange_order_id: string | null; decision_id: string;
  strategy_id: string; profile_id: string; match_id: string; token_id: string;
  side: "BUY" | "SELL"; leg: string; limit_price_cents: number; size_usd: number; tif_sec: number;
  expiry_mode: string | null; client_cancel_deadline: string | null;
  status: RealOrderStatus; filled_size_usd: number; avg_fill_cents: number | null;
  code_version: string | null; whitelist_version: number | null; note: string | null; created_at: string;
}

// ── real_orders + transition log ─────────────────────────────────────────────

/** Insert a freshly-built order in status "created" and stamp the first transition event.
 *  Idempotent on client_order_id: a re-insert with the same id is a no-op that returns the
 *  existing row (the §4.3 crash-retry contract — never a second order). */
export function insertRealOrder(db: Database, o: Omit<RealOrderRow, "status" | "filled_size_usd" | "avg_fill_cents" | "salt" | "order_hash" | "expiry_mode" | "client_cancel_deadline"> & { status?: RealOrderStatus; salt?: string | null; order_hash?: string | null; expiry_mode?: string | null; client_cancel_deadline?: string | null }): RealOrderRow {
  const existing = getRealOrderByClientId(db, o.client_order_id);
  if (existing) return existing; // idempotency: same client_order_id → the same order
  const status: RealOrderStatus = o.status ?? "created";
  db.prepare(
    `INSERT INTO real_orders(id,client_order_id,salt,order_hash,exchange_order_id,decision_id,strategy_id,profile_id,match_id,
       token_id,side,leg,limit_price_cents,size_usd,tif_sec,expiry_mode,client_cancel_deadline,status,filled_size_usd,avg_fill_cents,code_version,whitelist_version,note,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,?,?)`,
  ).run(o.id, o.client_order_id, o.salt ?? null, o.order_hash ?? null, o.exchange_order_id, o.decision_id, o.strategy_id, o.profile_id, o.match_id,
    o.token_id, o.side, o.leg, o.limit_price_cents, o.size_usd, o.tif_sec, o.expiry_mode ?? null, o.client_cancel_deadline ?? null, status, o.code_version, o.whitelist_version, o.note, o.created_at);
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

/** client-cancel orders still working (placed/partial) whose deadline has passed — the belt's
 *  reconciliation sweep cancels these, so a crashed in-memory timer / process restart can NEVER
 *  leave a GTC order hanging forever (the "process slept with an open position" class, for orders). */
export function expiredClientCancelOrders(db: Database, nowIso: string): RealOrderRow[] {
  return db.prepare(
    `SELECT * FROM real_orders WHERE expiry_mode='client-cancel' AND status IN ('placed','partial')
       AND client_cancel_deadline IS NOT NULL AND client_cancel_deadline < ? ORDER BY client_cancel_deadline`,
  ).all(nowIso) as RealOrderRow[];
}

/** Live open REAL exposure ($) — A3 (audit #6). Two parts, REAL only (dry=0):
 *   (1) open real positions at cost basis: Σ(size_shares × avg_price / 100) — releases when a SELL
 *       reduces the position (unlike the old lifetime-buy-volume sum that never dropped on exit);
 *   (2) a RESERVATION for real BUY orders still working (placed/partial, exchange_order_id set): the
 *       UNFILLED notional (size_usd − filled). Reserving at check-time closes the TOCTOU where two
 *       concurrent place() both read pre-fill state and both pass the cap.
 *  Dry orders/positions never count — the real belt gates real state only. */
export function openRealExposureUsd(db: Database): number {
  const pos = db.prepare(`SELECT COALESCE(SUM(size_shares * avg_price_cents / 100.0),0) AS x FROM real_positions WHERE dry=0 AND size_shares > 0`).get() as { x: number };
  const reserved = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN size_usd - COALESCE(filled_size_usd,0) > 0 THEN size_usd - COALESCE(filled_size_usd,0) ELSE 0 END),0) AS x
     FROM real_orders WHERE side='BUY' AND status IN ('placed','partial') AND exchange_order_id IS NOT NULL`,
  ).get() as { x: number };
  return (pos.x ?? 0) + (reserved.x ?? 0);
}

/** Open DRY exposure ($) — notional of open dry positions (size × avg). The virtual dry-bank's free is
 *  bank − this, so dry-order sizing rehearses real free dynamics (free shrinks as positions open). */
export function openDryExposureUsd(db: Database): number {
  const r = db.prepare(`SELECT COALESCE(SUM(size_shares * avg_price_cents / 100.0),0) AS x FROM real_positions WHERE dry=1 AND size_shares > 0`).get() as { x: number };
  return r.x ?? 0;
}

/** Orders placed in the last hour (the berserk-loop guard reads this). */
export function realOrdersLastHour(db: Database, nowMs: number): number {
  const rows = db.prepare(`SELECT created_at FROM real_orders`).all() as { created_at: string }[];
  return rows.filter((o) => nowMs - (Date.parse(o.created_at) || 0) <= 3_600_000).length;
}

/** Record a closing lot's realized-P&L delta (A4) — dated + dry-tagged, in its own table so it can't
 *  touch the cash balance. Written on each SELL that reduces a position. */
export function insertRealRealized(db: Database, e: { decisionId: string | null; tokenId: string | null; amountUsd: number; dry?: number; at: string }): void {
  db.prepare(`INSERT INTO real_realized(id,decision_id,token_id,amount_usd,dry,at) VALUES(?,?,?,?,?,?)`)
    .run(uid(), e.decisionId, e.tokenId, e.amountUsd, e.dry ?? 0, e.at);
}
/** Realized loss ($, positive) for the UTC day `dayPrefix` (YYYY-MM-DD) — A4 (audit #7). Sums real
 *  (dry=0) closed-lot realized deltas for the day. A BUY that merely OPENS a position writes no realized
 *  row → not a loss; dry P&L (dry=1) can neither mask nor trip the real breaker. Negative day → its
 *  magnitude is the loss. */
export function realRealizedLossTodayUsd(db: Database, dayPrefix: string): number {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_usd),0) AS net FROM real_realized WHERE dry=0 AND substr(at,1,10)=?`).get(dayPrefix) as { net: number };
  const net = r.net ?? 0;
  return net < 0 ? -net : 0;
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
export interface RealFillRow { id: string; order_id: string; client_order_id: string; token_id: string; side: "BUY" | "SELL"; size_usd: number; price_cents: number; fee_usd: number; dry: number; at: string; created_at: string }
export function insertRealFill(db: Database, f: Omit<RealFillRow, "id" | "dry"> & { dry?: number }): string {
  const id = uid();
  db.prepare(`INSERT INTO real_fills(id,order_id,client_order_id,token_id,side,size_usd,price_cents,fee_usd,dry,at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, f.order_id, f.client_order_id, f.token_id, f.side, f.size_usd, f.price_cents, f.fee_usd, f.dry ?? 0, f.at, f.created_at);
  return id;
}
export function realFillsForOrder(db: Database, orderId: string): RealFillRow[] {
  return db.prepare(`SELECT * FROM real_fills WHERE order_id=? ORDER BY at`).all(orderId) as RealFillRow[];
}

// ── real_positions ───────────────────────────────────────────────────────────
export interface RealPositionRow { token_id: string; match_id: string | null; strategy_id: string | null; size_shares: number; avg_price_cents: number | null; realized_pnl_usd: number; unrealized_pnl_usd: number | null; dry: number; updated_at: string }
export function upsertRealPosition(db: Database, p: Omit<RealPositionRow, "dry"> & { dry?: number }): void {
  db.prepare(
    `INSERT INTO real_positions(token_id,match_id,strategy_id,size_shares,avg_price_cents,realized_pnl_usd,unrealized_pnl_usd,dry,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(token_id) DO UPDATE SET match_id=excluded.match_id, strategy_id=excluded.strategy_id,
       size_shares=excluded.size_shares, avg_price_cents=excluded.avg_price_cents,
       realized_pnl_usd=excluded.realized_pnl_usd, unrealized_pnl_usd=excluded.unrealized_pnl_usd, dry=excluded.dry, updated_at=excluded.updated_at`,
  ).run(p.token_id, p.match_id, p.strategy_id, p.size_shares, p.avg_price_cents, p.realized_pnl_usd, p.unrealized_pnl_usd, p.dry ?? 0, p.updated_at);
}
/** Positions. `realOnly` (reconciliation / real balance) excludes dry-run simulated positions so a
 *  dry rehearsal can't pollute the real books when the owner flips dry_run→on. */
export function listRealPositions(db: Database, realOnly = false): RealPositionRow[] {
  return (realOnly
    ? db.prepare(`SELECT * FROM real_positions WHERE dry=0 ORDER BY updated_at DESC`).all()
    : db.prepare(`SELECT * FROM real_positions ORDER BY updated_at DESC`).all()) as RealPositionRow[];
}

/** Count of positions with live size opened by a REAL (sent) order — a real order has an
 *  exchange_order_id; DRY-run orders never do. So this counts genuine on-exchange exposure and
 *  is ZERO in pure dry-run (the orphan sentinel must not false-alarm on simulated positions). */
export function realOpenPositionCount(db: Database): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM real_positions p WHERE ABS(p.size_shares) > 1e-9 AND p.dry = 0
       AND EXISTS (SELECT 1 FROM real_orders o WHERE o.token_id = p.token_id AND o.exchange_order_id IS NOT NULL)`,
  ).get() as { n: number }).n;
}

// ── real_ledger ──────────────────────────────────────────────────────────────
export interface RealLedgerRow { id: string; kind: RealLedgerKind; amount_usd: number; token_id: string | null; order_id: string | null; ref: string | null; dry: number; at: string; created_at: string }
export function insertRealLedger(db: Database, e: Omit<RealLedgerRow, "id" | "dry"> & { dry?: number }): string {
  const id = uid();
  db.prepare(`INSERT INTO real_ledger(id,kind,amount_usd,token_id,order_id,ref,dry,at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id, e.kind, e.amount_usd, e.token_id, e.order_id, e.ref, e.dry ?? 0, e.at, e.created_at);
  return id;
}
/** Net USDC by kind (§4.4 reconciliation reasons by TYPE, not free text). `realOnly` excludes dry. */
export function realLedgerByKind(db: Database, realOnly = false): Record<string, number> {
  const rows = db.prepare(`SELECT kind, SUM(amount_usd) AS net FROM real_ledger ${realOnly ? "WHERE dry=0" : ""} GROUP BY kind`).all() as { kind: string; net: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.net;
  return out;
}
/** Ledger balance. `realOnly` (real reconciliation) excludes dry-run cash so a dry rehearsal
 *  doesn't show up as a real balance when the owner flips dry_run→on. */
export function realLedgerBalance(db: Database, realOnly = false): number {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_usd),0) AS bal FROM real_ledger ${realOnly ? "WHERE dry=0" : ""}`).get() as { bal: number };
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

// ── auto-pause (§4.1/§4.4) — a PERSISTENT operational state, stored in app_meta ──────────────
// The kill switch is read fresh from env, but the daily-loss / reconciliation PAUSE is a computed
// TRANSITION that must STICK across operations (and restarts) — else the next fresh env read (`on`)
// would silently un-pause it. So it lives in the DB, and the effective mode is the MOST RESTRICTIVE
// of (env, this). "Return to on" = clearRealAutoPause (owner action), NOT an env edit.
const AUTO_PAUSE_KEY = "real_auto_pause";
export interface RealAutoPause { state: "exits_only"; reason: string; at: string }
export function setRealAutoPause(db: Database, reason: string, at: string): void {
  const v = JSON.stringify({ state: "exits_only", reason, at } as RealAutoPause);
  db.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(AUTO_PAUSE_KEY, v, at);
}
export function getRealAutoPause(db: Database): RealAutoPause | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key=?`).get(AUTO_PAUSE_KEY) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as RealAutoPause; } catch { return null; }
}
/** Owner-only reset — clears the sticky pause so the env mode governs again. */
export function clearRealAutoPause(db: Database): void {
  db.prepare(`DELETE FROM app_meta WHERE key=?`).run(AUTO_PAUSE_KEY);
}

// ── orphan-positions alert (open real positions the effective mode can't exit) ───────────────
const ORPHAN_ALERT_KEY = "real_orphan_alert";
export interface RealOrphanAlert { message: string; at: string }
export function setRealOrphanAlert(db: Database, message: string, at: string): void {
  db.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(ORPHAN_ALERT_KEY, JSON.stringify({ message, at } as RealOrphanAlert), at);
}
export function getRealOrphanAlert(db: Database): RealOrphanAlert | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key=?`).get(ORPHAN_ALERT_KEY) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as RealOrphanAlert; } catch { return null; }
}
export function clearRealOrphanAlert(db: Database): void {
  db.prepare(`DELETE FROM app_meta WHERE key=?`).run(ORPHAN_ALERT_KEY);
}

// ── operator controls (§6) — persistent, in app_meta, since the app can't write env on Render ──────
// The operator mode is a CEILING the owner sets from the UI; effectiveTradingMode takes the MOST
// RESTRICTIVE of (env, this, auto-pause) — so the UI can only ever tighten, never exceed the env.
const OPERATOR_MODE_KEY = "real_operator_mode";
export function setOperatorMode(db: Database, mode: string, at: string): void {
  db.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(OPERATOR_MODE_KEY, mode, at);
}
export function getOperatorMode(db: Database): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key=?`).get(OPERATOR_MODE_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

// Caps override — a partial {maxOrderUsd?,...} the owner edits in the UI; loadSafetyCaps merges it
// over env/defaults. Also DB-persisted (env is read-only from the app).
const CAPS_OVERRIDE_KEY = "real_caps_override";
export function setCapsOverride(db: Database, partial: Record<string, number>, at: string): void {
  db.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(CAPS_OVERRIDE_KEY, JSON.stringify(partial), at);
}
export function getCapsOverride(db: Database): Record<string, number> {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key=?`).get(CAPS_OVERRIDE_KEY) as { value: string } | undefined;
  if (!row) return {};
  try { return JSON.parse(row.value) as Record<string, number>; } catch { return {}; }
}

// §6 control audit log — every owner money-state move (who/when/what).
export function logControl(db: Database, action: string, detail: string | null, actor: string, at: string): void {
  db.prepare(`INSERT INTO real_control_log(id,action,detail,actor,at) VALUES(?,?,?,?,?)`).run(uid(), action, detail, actor, at);
}
export function listControlLog(db: Database, limit = 50): { action: string; detail: string | null; actor: string | null; at: string }[] {
  return db.prepare(`SELECT action,detail,actor,at FROM real_control_log ORDER BY at DESC LIMIT ?`).all(limit) as any;
}

/** STOP: cancel every working (placed/partial) real order → status cancelled + a transition event.
 *  GREEDY + idempotent: a failure on one order does NOT abort the sweep — we try each, count what
 *  actually cancelled, and report {attempted, cancelled, failed} ("N of M"). The panic button must
 *  never die on the first bad order and leave the rest working. Open POSITIONS are NOT force-closed
 *  (a panic dump into a thin book is worse than a pause; they ride under exits-only, §4.2). */
export function cancelWorkingRealOrders(db: Database, at: string): { attempted: number; cancelled: number; failed: number } {
  const working = db.prepare(`SELECT id FROM real_orders WHERE status IN ('placed','partial')`).all() as { id: string }[];
  let cancelled = 0, failed = 0;
  for (const o of working) {
    try { transitionRealOrder(db, o.id, "cancelled", at, { note: "STOP — все висящие ордера отменены" }); cancelled++; }
    catch { failed++; }
  }
  return { attempted: working.length, cancelled, failed };
}
