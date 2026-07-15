// ─────────────────────────────────────────────────────────────────────────────
// DryRunExecutor (spec §3) — the FULL real path (whitelist feeds it → belt → build
// → idempotency → accounting) but instead of sending, it fills against the LIVE
// book with TIF logic and books everything to real_* with status transitions.
// Zero real send, zero money. The dress rehearsal, as close to the real executor
// as possible. §9.6: fully deterministic, no LLM.
//
// DRY-FILL MODEL (documented — it is the footnote to every §7 metric):
//   PLACEMENT-SNAPSHOT, LIMIT-RESPECTING. At place time we VWAP-fill the order
//   against ONLY the book levels that satisfy the limit (asks ≤ limit for BUY,
//   bids ≥ limit for SELL). If nothing qualifies → the order EXPIRES at TIF (an
//   honest miss; anti-chasing, one order per leg). If depth < size → PARTIAL fill
//   to depth, remainder expires (no chase). We do NOT model the book EVOLVING
//   across the TIF window (a real resting order could fill later as the book
//   moves), so dry-run fill-rate is a LOWER-BOUND / snapshot-at-placement estimate.
//   A multi-tick resting-order model is future work (noted in build notes).
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import type { EngineDeps } from "../engine.js";
import type { OrderBookFetch, PolymarketConfig } from "../polymarket.js";
import { simulateBuy, simulateSell, takerFeeCents } from "../execution.js";
import { classifyOrderBook } from "./paperFill.js";
import * as RR from "../realRepo.js";
import type { Database } from "../db.js";
import { effectiveTradingMode, modeCaps, enforceCaps, conformOrderToMarket, loadSafetyCaps, type SafetyCaps } from "./safety.js";
import type { Executor, OrderRequest, OrderAck, CancelAck, Fill, Position, Balance, ExecutorHealth } from "./types.js";

// TODO(Phase E/F): tick + min are PER-MARKET (doc-spike #5) — fetch getTickSize / minimum_order_size
// live and pass them in. Until then dry-run conforms on the finest tick (0.01 = 1¢) + a $1 floor.
const DEFAULT_TICK_CENTS = 1;
const DEFAULT_MIN_ORDER_USD = 1;

export interface DryRunCtx {
  db: Database;
  env: Record<string, string | undefined>;
  poly: PolymarketConfig;
  deps: EngineDeps;
  bookCache?: Map<string, OrderBookFetch>;
  now: () => string;             // ISO clock
  caps?: SafetyCaps;
  whitelistVersion?: number | null;
}

interface DryFill { filledUsd: number; priceCents: number; feeUsd: number; shares: number; note: string }

/** Limit-respecting placement-snapshot fill (see model note above). */
function dryFill(side: "BUY" | "SELL", limitCents: number, sizeUsd: number, bookRes: OrderBookFetch, exec: PolymarketConfig["exec"]): DryFill {
  const book = bookRes.status === "ok" ? bookRes.book : null;
  const empty: DryFill = { filledUsd: 0, priceCents: 0, feeUsd: 0, shares: 0, note: "нет живой книги" };
  if (!book) return empty;
  if (side === "BUY") {
    const eligible = book.asks.filter((a) => a.priceCents <= limitCents); // never pay above the limit
    const f = simulateBuy(eligible, sizeUsd);
    if (f.filledUsd <= 0.009) return { ...empty, note: `лучший аск > лимит ${limitCents}¢ — истёк по TIF` };
    const fee = takerFeeCents(f.avgPriceCents, exec.takerFeeRate);
    const eff = Math.round((f.avgPriceCents + fee) * 10) / 10;
    return { filledUsd: f.filledUsd, priceCents: eff, feeUsd: (f.shares * fee) / 100, shares: f.shares, note: `VWAP ${f.avgPriceCents}¢ ≤ лимит ${limitCents}¢${f.unfilledUsd > 0.5 ? " · частично по глубине, остаток истёк" : ""}` };
  }
  const shares = limitCents > 0 ? sizeUsd / (limitCents / 100) : 0;
  const eligible = book.bids.filter((b) => b.priceCents >= limitCents); // never sell below the limit
  const f = simulateSell(eligible, shares);
  if (f.filledShares <= 1e-6) return { ...empty, note: `лучший бид < лимит ${limitCents}¢ — истёк по TIF` };
  const fee = takerFeeCents(f.avgPriceCents, exec.takerFeeRate);
  const eff = Math.round((f.avgPriceCents - fee) * 10) / 10;
  const frac = shares > 0 ? f.filledShares / shares : 1;
  return { filledUsd: Math.round(sizeUsd * frac * 100) / 100, priceCents: eff, feeUsd: (f.filledShares * fee) / 100, shares: f.filledShares, note: `выход VWAP ${f.avgPriceCents}¢ ≥ лимит ${limitCents}¢${f.unfilledShares > 1e-6 ? " · частично по глубине, остаток истёк" : ""}` };
}

function updatePosition(db: Database, o: OrderRequest, fill: DryFill, nowIso: string): void {
  const existing = RR.listRealPositions(db).find((p) => p.token_id === o.tokenId);
  const prevShares = existing?.size_shares ?? 0, prevAvg = existing?.avg_price_cents ?? 0, prevReal = existing?.realized_pnl_usd ?? 0;
  if (o.side === "BUY") {
    const newShares = prevShares + fill.shares;
    const newAvg = newShares > 0 ? (prevShares * prevAvg + fill.shares * fill.priceCents) / newShares : 0;
    RR.upsertRealPosition(db, { token_id: o.tokenId, match_id: o.matchId, strategy_id: o.strategyId, size_shares: newShares, avg_price_cents: Math.round(newAvg * 100) / 100, realized_pnl_usd: prevReal, unrealized_pnl_usd: null, dry: 1, updated_at: nowIso });
  } else {
    const newShares = prevShares - fill.shares;
    const realized = prevReal + (fill.shares * (fill.priceCents - prevAvg)) / 100;
    RR.upsertRealPosition(db, { token_id: o.tokenId, match_id: o.matchId, strategy_id: o.strategyId, size_shares: newShares, avg_price_cents: prevAvg, realized_pnl_usd: Math.round(realized * 100) / 100, unrealized_pnl_usd: null, dry: 1, updated_at: nowIso });
  }
}

export class DryRunExecutor implements Executor {
  constructor(private ctx: DryRunCtx) {}

  private ack(order: OrderRequest, status: OrderAck["status"], filledUsd: number, avgCents: number | null, note: string, clamped = false): OrderAck {
    return { clientOrderId: order.clientOrderId, exchangeOrderId: null, status, filledSizeUsd: filledUsd, avgFillPriceCents: avgCents, clamped, note };
  }

  async place(order: OrderRequest): Promise<OrderAck> {
    const { db, env, poly, deps, bookCache } = this.ctx;
    const caps = this.ctx.caps ?? loadSafetyCaps(env);
    const nowIso = this.ctx.now();
    const nowMs = Date.parse(nowIso) || 0;

    // §4.2 — the DryRunExecutor acts only when the EFFECTIVE mode permits simulation (dry_run; and the
    // persisted auto-pause is honoured because effectiveTradingMode consults it).
    const mode = effectiveTradingMode(db, env);
    if (!modeCaps(mode).simulate) return this.ack(order, "rejected", 0, null, `режим «${mode}» — DryRunExecutor неактивен (не dry_run)`);

    // §4.1 belt: hard caps (entries gated; a defensive exit passes). Clamp/reject/pause.
    const isEntry = order.leg === "entry";
    const cap = enforceCaps(db, { sizeUsd: order.sizeUsd, isEntry }, nowMs, caps);
    if (cap.action !== "allow") return this.ack(order, "rejected", 0, null, `кэп (${cap.action}): ${cap.reason}`);

    // §4.1 fifth cap: conform to tick + min (default tick/min for now — Phase E/F feeds per-market).
    const conf = conformOrderToMarket({ side: order.side, limitPriceCents: order.limitPriceCents, sizeUsd: cap.sizeUsd }, { tickCents: DEFAULT_TICK_CENTS, minOrderUsd: DEFAULT_MIN_ORDER_USD, tolCents: 1 });
    if (!conf.ok) return this.ack(order, "rejected", 0, null, `conform: ${conf.reason}`);
    const limit = conf.limitPriceCents, sizeUsd = cap.sizeUsd;

    // §4.3 idempotency: persist (created) keyed by client_order_id; a re-place returns the same order.
    const existing = RR.getRealOrderByClientId(db, order.clientOrderId);
    if (existing && existing.status !== "created") return this.ack(order, existing.status, existing.filled_size_usd, existing.avg_fill_cents, `идемпотентно: ордер уже ${existing.status}`);
    const orderId = existing?.id ?? randomUUID();
    if (!existing) {
      RR.insertRealOrder(db, {
        id: orderId, client_order_id: order.clientOrderId, exchange_order_id: null, decision_id: order.decisionId,
        strategy_id: order.strategyId, profile_id: order.profileId, match_id: order.matchId, token_id: order.tokenId,
        side: order.side, leg: order.leg, limit_price_cents: limit, size_usd: sizeUsd, tif_sec: order.timeInForceSec,
        expiry_mode: order.expiryMode ?? null,
        client_cancel_deadline: order.expiryMode === "client-cancel" ? new Date(nowMs + order.timeInForceSec * 1000).toISOString() : null,
        code_version: null, whitelist_version: this.ctx.whitelistVersion ?? null,
        note: `dry-run${cap.clamped ? ` · урезан кэпом до $${sizeUsd}` : ""}`, created_at: nowIso,
      });
    }
    RR.transitionRealOrder(db, orderId, "placed", nowIso, { note: "dry-run placed (не отправлено)" });

    // dry-fill against the live book (placement-snapshot, limit-respecting).
    const bookRes = await classifyOrderBook(order.tokenId, poly, deps, bookCache);
    const fill = dryFill(order.side, limit, sizeUsd, bookRes, poly.exec);
    if (fill.filledUsd <= 0.009) {
      RR.transitionRealOrder(db, orderId, "expired", nowIso, { filledSizeUsd: 0, note: `TIF expired · ${fill.note}` });
      return this.ack(order, "expired", 0, null, fill.note, cap.clamped);
    }
    // accounting: fill row + ledger (fill cash + fee) + position.
    RR.insertRealFill(db, { order_id: orderId, client_order_id: order.clientOrderId, token_id: order.tokenId, side: order.side, size_usd: fill.filledUsd, price_cents: fill.priceCents, fee_usd: Math.round(fill.feeUsd * 100) / 100, dry: 1, at: nowIso, created_at: nowIso });
    RR.insertRealLedger(db, { kind: "fill", amount_usd: order.side === "BUY" ? -fill.filledUsd : fill.filledUsd, token_id: order.tokenId, order_id: orderId, ref: null, dry: 1, at: nowIso, created_at: nowIso });
    if (fill.feeUsd > 0.004) RR.insertRealLedger(db, { kind: "fee", amount_usd: -Math.round(fill.feeUsd * 100) / 100, token_id: order.tokenId, order_id: orderId, ref: null, dry: 1, at: nowIso, created_at: nowIso });
    updatePosition(db, order, fill, nowIso);

    const full = fill.filledUsd >= sizeUsd - 0.5;
    RR.transitionRealOrder(db, orderId, full ? "filled" : "partial", nowIso, { filledSizeUsd: fill.filledUsd, avgFillCents: fill.priceCents, note: `dry-fill ${full ? "full" : "partial (остаток истёк по TIF, no chase)"} · ${fill.note}` });
    return this.ack(order, full ? "filled" : "partial", fill.filledUsd, fill.priceCents, fill.note, cap.clamped);
  }

  // Dry-run has no resting orders to cancel and no separate wallet — the DB is the record.
  async cancel(clientOrderId: string): Promise<CancelAck> {
    const o = RR.getRealOrderByClientId(this.ctx.db, clientOrderId);
    if (o && (o.status === "placed" || o.status === "partial")) RR.transitionRealOrder(this.ctx.db, o.id, "cancelled", this.ctx.now(), { note: "dry-run cancel" });
    return { clientOrderId, cancelled: !!o, note: "dry-run" };
  }
  async fills(): Promise<Fill[]> { return []; }
  async positions(): Promise<Position[]> {
    return RR.listRealPositions(this.ctx.db).map((p) => ({ tokenId: p.token_id, sizeShares: p.size_shares, avgPriceCents: p.avg_price_cents ?? 0, realizedPnlUsd: p.realized_pnl_usd, unrealizedPnlUsd: p.unrealized_pnl_usd }));
  }
  async balance(): Promise<Balance> { return { availableUsd: RR.realLedgerBalance(this.ctx.db), reservedUsd: 0 }; }
  async health(): Promise<ExecutorHealth> { return { ok: true, note: "dry-run", checkedAtMs: Date.parse(this.ctx.now()) || 0 }; }
}
