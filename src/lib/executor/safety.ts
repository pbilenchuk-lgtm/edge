// ─────────────────────────────────────────────────────────────────────────────
// SAFETY BELT (spec §4) — the SECOND belt, independent of the strategies. Every
// check here runs IN the executor, AFTER all upstream sizing/gates, and trusts no
// upper layer: it is the last line before money moves. All logic is exchange-
// INDEPENDENT and pure/deterministic (§9.6) — Phase F only FEEDS it live inputs
// (market tick/min, the exchange lookup, the exchange view for reconciliation).
// Nothing here runs until REAL_TRADING is on.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "../db.js";
import * as RR from "../realRepo.js";

// ── §4.2 kill switch — the four states, read FRESH on every operation ─────────
export type TradingMode = "off" | "dry_run" | "exits_only" | "on";
/** Read REAL_TRADING on EVERY call (never cached at boot) → flipping it takes effect on the next
 *  operation with no deploy. Unknown/blank → "off" (fail-safe: default is do-nothing). */
export function readTradingMode(env: Record<string, string | undefined> = process.env): TradingMode {
  const v = (env.REAL_TRADING ?? "off").toLowerCase().trim();
  return v === "on" || v === "dry_run" || v === "exits_only" ? v : "off";
}
/** New ENTRIES are allowed only in "on"; "exits_only"/"dry_run"/"off" forbid opening real risk. */
export const entriesAllowed = (m: TradingMode) => m === "on";
/** Real order SEND happens only in "on" (exits included) or "dry_run" (simulated). off/exits_only send nothing new. */
export const sendsRealOrders = (m: TradingMode) => m === "on";

// Restrictiveness rank (higher = fewer real-money actions). dry_run outranks exits_only because it
// sends NO real orders at all, whereas exits_only still lets a real exit through.
const MODE_RANK: Record<TradingMode, number> = { off: 3, dry_run: 2, exits_only: 1, on: 0 };
const moreRestrictive = (a: TradingMode, b: TradingMode): TradingMode => (MODE_RANK[a] >= MODE_RANK[b] ? a : b);

/**
 * The mode that ACTUALLY governs = the MOST RESTRICTIVE of the fresh env read and the PERSISTED
 * auto-pause (§4.1/§4.4). The env kill switch is read fresh (a flip acts next op), but a daily-loss /
 * reconciliation pause is a computed transition that must STICK — so it lives in the DB and floors the
 * effective mode at exits_only until the owner clears it. Without this, a fresh env=`on` read would
 * silently un-pause. This is the seam where "fresh read" and "sticky pause" could annihilate.
 */
export function effectiveTradingMode(db: Database, env: Record<string, string | undefined> = process.env): TradingMode {
  const base = readTradingMode(env);
  return RR.getRealAutoPause(db) ? moreRestrictive(base, "exits_only") : base;
}

// ── §4.2 mode → executor matrix (CODE, not convention) ────────────────────────
// Which contour is active is a FUNCTION of the mode, one belt underneath. Phase D/E/F branch on this.
export interface ModeCaps { simulate: boolean; realEntry: boolean; realExit: boolean }
export function modeCaps(m: TradingMode): ModeCaps {
  switch (m) {
    case "on": return { simulate: false, realEntry: true, realExit: true };          // real entries + exits
    case "exits_only": return { simulate: false, realEntry: false, realExit: true }; // real exits only (paused entries)
    case "dry_run": return { simulate: true, realEntry: false, realExit: false };    // full path SIMULATED (entries+exits), zero real send
    case "off": default: return { simulate: false, realEntry: false, realExit: false }; // real contour dormant
  }
}

// ── §4.1 hard caps (env, conservative defaults) ──────────────────────────────
export interface SafetyCaps { maxOrderUsd: number; maxExposureUsd: number; maxDailyLossUsd: number; maxOrdersPerHour: number }
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export function loadSafetyCaps(env: Record<string, string | undefined> = process.env): SafetyCaps {
  return {
    maxOrderUsd: num(env.REAL_MAX_ORDER_USD, 50),
    maxExposureUsd: num(env.REAL_MAX_EXPOSURE_USD, 200),
    maxDailyLossUsd: num(env.REAL_MAX_DAILY_LOSS_USD, 60),
    maxOrdersPerHour: num(env.REAL_MAX_ORDERS_PER_HOUR, 20),
  };
}

export interface CapDecision {
  action: "allow" | "reject" | "pause"; // pause = trip the daily-loss auto-pause → caller sets exits_only
  sizeUsd: number;                       // possibly clamped down from the request
  clamped: boolean;
  reason?: string;
}
/**
 * §4.1 — enforce the four caps IN the executor, after every upstream gate. Entries are fully gated;
 * a defensive EXIT is NEVER blocked here (a stop must always be able to leave — blocking it is the
 * worse failure). Reads live state from real_orders/real_ledger (the belt owns the truth, not the caller).
 */
export function enforceCaps(db: Database, o: { sizeUsd: number; isEntry: boolean }, nowMs: number, caps: SafetyCaps): CapDecision {
  // Exits bypass exposure / orders-per-hour / daily-loss (a defensive exit must always leave). They are
  // still size-clamped only if truly absurd — but a position exit sells what's held, so we pass it through.
  if (!o.isEntry) return { action: "allow", sizeUsd: o.sizeUsd, clamped: false };

  // Daily-loss auto-pause (§4.4): realized loss today ≥ cap → PERSIST the pause (it must STICK past a
  // fresh env=on read / a restart) and return pause. "Day" = UTC calendar day (substr of the ISO `at`,
  // so the boundary is UTC-midnight — recorded, not sliding-24h).
  const dayPrefix = new Date(nowMs).toISOString().slice(0, 10); // UTC yyyy-mm-dd
  const lossToday = RR.realRealizedLossTodayUsd(db, dayPrefix);
  if (lossToday >= caps.maxDailyLossUsd) {
    const reason = `дневной убыток $${lossToday.toFixed(0)} ≥ лимит $${caps.maxDailyLossUsd} → авто-пауза (exits_only)`;
    RR.setRealAutoPause(db, reason, new Date(nowMs).toISOString()); // sticky until owner clears
    return { action: "pause", sizeUsd: 0, clamped: false, reason };
  }

  // Berserk-loop guard: too many orders this hour → reject (a bug spamming orders hits the cap, not the
  // bank). Reads the PERSISTENT real_orders table, so the count survives a process restart (not an
  // in-memory counter) — a restart mid-berserk doesn't reset the guard to zero.
  if (RR.realOrdersLastHour(db, nowMs) >= caps.maxOrdersPerHour) return { action: "reject", sizeUsd: 0, clamped: false, reason: `${caps.maxOrdersPerHour} ордеров/час достигнут — предохранитель от цикла-берсерка` };

  // Order-size clamp: whatever the sizer asked, never exceed the per-order ceiling.
  let size = o.sizeUsd, clamped = false;
  if (size > caps.maxOrderUsd) { size = caps.maxOrderUsd; clamped = true; }

  // Exposure ceiling: current open real exposure + this order must stay under the cap.
  const exposure = RR.openRealExposureUsd(db);
  if (exposure + size > caps.maxExposureUsd) return { action: "reject", sizeUsd: 0, clamped, reason: `экспозиция $${exposure.toFixed(0)}+$${size.toFixed(0)} > лимит $${caps.maxExposureUsd}` };

  return { action: "allow", sizeUsd: size, clamped, reason: clamped ? `урезан до потолка ордера $${caps.maxOrderUsd}` : undefined };
}

// ── §4.1 (fifth cap) conform to the market's tick + min size ──────────────────
// Doc-spike: tick size and minimum order size are PER-MARKET, not global. A fixed ±1¢ tolerance is
// exactly one tick at 0.01 but sub-tick (meaningless) on coarse (0.025/0.1) ticks. This is the last
// belt — pure logic here; Phase E/F only FEEDS real tick/min per market (never hardcode them).
export interface MarketConstraints { tickCents: number; minOrderUsd: number; tolCents: number }
export interface ConformResult { ok: boolean; limitPriceCents: number; reason?: string }
/** Clamp the limit to the market tick (BUY floors — never overpay; SELL ceils — never undersell) and
 *  reject when the ±tol band spans less than one tick, or the notional is below the market minimum. */
export function conformOrderToMarket(o: { side: "BUY" | "SELL"; limitPriceCents: number; sizeUsd: number }, m: MarketConstraints): ConformResult {
  if (!(m.tickCents > 0)) return { ok: false, limitPriceCents: o.limitPriceCents, reason: "tick unknown" };
  // ±tol band must be at least one tick, else there's no valid price our tolerance can name.
  if (m.tolCents < m.tickCents) return { ok: false, limitPriceCents: o.limitPriceCents, reason: `допуск ±${m.tolCents}¢ < тик ${m.tickCents}¢ — суб-тик рынок, лимит бессмыслен (skip)` };
  if (o.sizeUsd < m.minOrderUsd) return { ok: false, limitPriceCents: o.limitPriceCents, reason: `ноционал $${o.sizeUsd.toFixed(2)} < мин. размер рынка $${m.minOrderUsd} (skip)` };
  const ticks = o.limitPriceCents / m.tickCents;
  const clamped = (o.side === "BUY" ? Math.floor(ticks) : Math.ceil(ticks)) * m.tickCents;
  const limit = Math.round(clamped * 1e6) / 1e6; // kill FP dust
  if (limit <= 0 || limit >= 100) return { ok: false, limitPriceCents: limit, reason: `цена ${limit}¢ у планки после клампа к тику` };
  return { ok: true, limitPriceCents: limit };
}

// ── §4.3 idempotent retry protocol ───────────────────────────────────────────
// Doc-spike: the CLOB has NO client-supplied order id — server dedup is by the HASH of a SIGNED
// struct that includes a random salt. So RE-SIGN after a timeout = new salt = new hash = a SECOND
// order. The retry rule: persist the signed blob (salt+hash) BEFORE send; on timeout RESEND THE SAME
// blob (never re-sign); only if the blob is lost do we look up the market and, on confirmed absence,
// sign a NEW intent. This function is the pure decision; the executor performs the chosen action.
export type ExchangeLookup = "exists" | "absent" | "unknown"; // does our order appear on the exchange?
export type RetryAction = "resend_same" | "new_intent" | "wait";
export function resolveRetry(persisted: { orderHash: string | null }, lookup: ExchangeLookup): RetryAction {
  if (persisted.orderHash) {
    // We still hold the exact signed blob → resending is idempotent (same hash; server dedups). Only
    // skip the resend if the exchange already shows it (it's live — just wait for the fill).
    return lookup === "exists" ? "wait" : "resend_same";
  }
  // Blob lost — NEVER blind re-sign. Only a CONFIRMED absence licenses a fresh (new-hash) intent;
  // anything unconfirmed means an order may be live, so wait rather than risk a duplicate.
  return lookup === "absent" ? "new_intent" : "wait";
}

// ── §4.4 reconciliation ──────────────────────────────────────────────────────
export interface ExchangeView { balanceUsd: number; positions: { tokenId: string; sizeShares: number }[] }
export interface ReconResult { ok: boolean; action: "ok" | "exits_only"; discrepancies: string[] }
/** Compare the exchange's own positions/balance against our ledger/positions. Any gap beyond tolerance
 *  ($1 / 1 token) → force exits_only + a loud discrepancy list (return to "on" is a MANUAL owner call).
 *  Pure: Phase F supplies the live ExchangeView; here we just diff. */
export function reconcile(local: { ledgerBalanceUsd: number; positions: { tokenId: string; sizeShares: number }[] }, exchange: ExchangeView, tol = { usd: 1, tokens: 1 }): ReconResult {
  const d: string[] = [];
  if (Math.abs(local.ledgerBalanceUsd - exchange.balanceUsd) > tol.usd)
    d.push(`баланс: наш $${local.ledgerBalanceUsd.toFixed(2)} vs биржа $${exchange.balanceUsd.toFixed(2)}`);
  const exByTok = new Map(exchange.positions.map((p) => [p.tokenId, p.sizeShares]));
  const seen = new Set<string>();
  for (const p of local.positions) {
    seen.add(p.tokenId);
    const ex = exByTok.get(p.tokenId) ?? 0;
    if (Math.abs(p.sizeShares - ex) > tol.tokens) d.push(`позиция ${p.tokenId}: наша ${p.sizeShares} vs биржа ${ex}`);
  }
  for (const p of exchange.positions) if (!seen.has(p.tokenId) && Math.abs(p.sizeShares) > tol.tokens) d.push(`позиция ${p.tokenId}: у нас нет, биржа ${p.sizeShares}`);
  return d.length ? { ok: false, action: "exits_only", discrepancies: d } : { ok: true, action: "ok", discrepancies: [] };
}

/** Reconciliation with the side effect: on a discrepancy, PERSIST the auto-pause (sticky exits_only
 *  until the owner clears it) — the reconciliation-cycle entry point Phase F calls every 5 min. */
export function runReconciliation(db: Database, local: { ledgerBalanceUsd: number; positions: { tokenId: string; sizeShares: number }[] }, exchange: ExchangeView, nowIso: string, tol = { usd: 1, tokens: 1 }): ReconResult {
  const r = reconcile(local, exchange, tol);
  if (!r.ok) RR.setRealAutoPause(db, `сверка §4.4: ${r.discrepancies.join("; ")}`, nowIso);
  return r;
}

// ── Orphan-positions sentinel — the covert mode combo (found in review) ───────
// The rank (dry_run > exits_only) is monotone in "reality" but NOT in "safety of OPEN positions":
// real positions open + auto-pause=exits_only + owner flips env→dry_run/off ⇒ effective realExit=false
// ⇒ live positions with NO exit management. off is a DELIBERATE freeze (e.g. suspected bug in exit
// logic itself); the danger is reaching this UNKNOWINGLY. So: a loud, persistent alert whenever open
// real positions exist and the effective mode can't exit them. Runs in the reconciliation cycle.
export interface OrphanCheck { alert: boolean; openPositions: number; message?: string }
export function checkOrphanPositions(db: Database, mode: TradingMode, nowIso: string): OrphanCheck {
  // Only REAL positions (opened by a sent order) count — a dry-run open position is simulated and
  // carries no real risk, so the sentinel stays silent through normal dry-run operation.
  const open = RR.realOpenPositionCount(db);
  if (open > 0 && !modeCaps(mode).realExit) {
    const message = `⚠ ${open} РЕАЛЬНЫХ позиций БЕЗ exit-управления: режим «${mode}» не разрешает выходы. Флип в on/exits_only чтобы управлять, либо это осознанная заморозка.`;
    RR.setRealOrphanAlert(db, message, nowIso); // persistent → UI + logs; cleared when the combo resolves
    return { alert: true, openPositions: open, message };
  }
  RR.clearRealOrphanAlert(db); // condition resolved (no open positions or exits are possible again)
  return { alert: false, openPositions: open };
}
