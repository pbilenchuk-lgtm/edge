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
import { transact, type Database } from "../db.js";
import { effectiveCodeVersion } from "../codeEpoch.js";
import { effectiveTradingMode, modeCaps, enforceCaps, conformOrderToMarket, resolveSafetyCaps, type SafetyCaps } from "./safety.js";
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
  // Per-market tick + min size for the conform cap (doc-spike #5). Supplied by the whitelist layer
  // (Phase E) so conform is NOT hardcoded in the executor; the VALUES are still defaults until Phase F
  // wires live getTickSize / minimum_order_size. Absent → the finest tick (1¢) + $1 floor.
  marketConstraints?: (tokenId: string) => { tickCents: number; minOrderUsd: number };
}

// grossUsd = actual cash before fee (BUY: VWAP notional paid; SELL: shares × gross VWAP proceeds). The
// ledger books grossUsd (B3), not the limit-price notional, so the cash ledger matches realized P&L.
interface DryFill { filledUsd: number; grossUsd: number; priceCents: number; feeUsd: number; shares: number; note: string }

/** Limit-respecting placement-snapshot fill (see model note above). */
function dryFill(side: "BUY" | "SELL", limitCents: number, sizeUsd: number, bookRes: OrderBookFetch, exec: PolymarketConfig["exec"]): DryFill {
  const book = bookRes.status === "ok" ? bookRes.book : null;
  const empty: DryFill = { filledUsd: 0, grossUsd: 0, priceCents: 0, feeUsd: 0, shares: 0, note: "нет живой книги" };
  if (!book) return empty;
  if (side === "BUY") {
    const eligible = book.asks.filter((a) => a.priceCents <= limitCents); // never pay above the limit
    const f = simulateBuy(eligible, sizeUsd);
    if (f.filledUsd <= 0.009) return { ...empty, note: `лучший аск > лимит ${limitCents}¢ — истёк по TIF` };
    const fee = takerFeeCents(f.avgPriceCents, exec.takerFeeRate);
    const eff = Math.round((f.avgPriceCents + fee) * 10) / 10;
    return { filledUsd: f.filledUsd, grossUsd: f.filledUsd, priceCents: eff, feeUsd: (f.shares * fee) / 100, shares: f.shares, note: `VWAP ${f.avgPriceCents}¢ ≤ лимит ${limitCents}¢${f.unfilledUsd > 0.5 ? " · частично по глубине, остаток истёк" : ""}` };
  }
  const shares = limitCents > 0 ? sizeUsd / (limitCents / 100) : 0;
  const eligible = book.bids.filter((b) => b.priceCents >= limitCents); // never sell below the limit
  const f = simulateSell(eligible, shares);
  if (f.filledShares <= 1e-6) return { ...empty, note: `лучший бид < лимит ${limitCents}¢ — истёк по TIF` };
  const fee = takerFeeCents(f.avgPriceCents, exec.takerFeeRate);
  const eff = Math.round((f.avgPriceCents - fee) * 10) / 10;
  const frac = shares > 0 ? f.filledShares / shares : 1;
  // B3: gross proceeds = filled shares × the ACTUAL bid VWAP (not the limit) — the real cash in. The
  // ledger books this; fee is booked separately, so ledger cash matches realized P&L.
  const grossUsd = Math.round((f.filledShares * f.avgPriceCents) / 100 * 100) / 100;
  return { filledUsd: Math.round(sizeUsd * frac * 100) / 100, grossUsd, priceCents: eff, feeUsd: (f.filledShares * fee) / 100, shares: f.filledShares, note: `выход VWAP ${f.avgPriceCents}¢ ≥ лимит ${limitCents}¢${f.unfilledShares > 1e-6 ? " · частично по глубине, остаток истёк" : ""}` };
}

function updatePosition(db: Database, o: OrderRequest, fill: DryFill, nowIso: string): void {
  // B1: the position is the EXACT twin (token, decision, dry) — never a blob merged across decisions.
  const existing = RR.getRealPosition(db, o.tokenId, o.decisionId, 1);
  const prevShares = existing?.size_shares ?? 0, prevAvg = existing?.avg_price_cents ?? 0, prevReal = existing?.realized_pnl_usd ?? 0;
  const base = { token_id: o.tokenId, decision_id: o.decisionId, profile_id: o.profileId, match_id: o.matchId, strategy_id: o.strategyId, dry: 1, updated_at: nowIso };
  if (o.side === "BUY") {
    const newShares = prevShares + fill.shares;
    const newAvg = newShares > 0 ? (prevShares * prevAvg + fill.shares * fill.priceCents) / newShares : 0;
    RR.upsertRealPosition(db, { ...base, size_shares: newShares, avg_price_cents: Math.round(newAvg * 100) / 100, realized_pnl_usd: prevReal, unrealized_pnl_usd: null });
  } else {
    const newShares = prevShares - fill.shares;
    const realizedDelta = Math.round((fill.shares * (fill.priceCents - prevAvg)) / 100 * 100) / 100;
    const realized = Math.round((prevReal + realizedDelta) * 100) / 100;
    RR.upsertRealPosition(db, { ...base, size_shares: newShares, avg_price_cents: prevAvg, realized_pnl_usd: realized, unrealized_pnl_usd: null });
    // A4 (audit #7): date + dry-tag this close's realized delta (own table, not the cash ledger) so the
    // daily-loss breaker reads real closed-lot P&L, not cash flow, and dry P&L can't trip it.
    if (Math.abs(realizedDelta) > 0.004) RR.insertRealRealized(db, { decisionId: o.decisionId, tokenId: o.tokenId, amountUsd: realizedDelta, dry: 1, at: nowIso });
  }
}

export class DryRunExecutor implements Executor {
  constructor(private ctx: DryRunCtx) {}

  private ack(order: OrderRequest, status: OrderAck["status"], filledUsd: number, avgCents: number | null, note: string, clamped = false): OrderAck {
    return { clientOrderId: order.clientOrderId, exchangeOrderId: null, status, filledSizeUsd: filledUsd, avgFillPriceCents: avgCents, clamped, note };
  }

  async place(order: OrderRequest): Promise<OrderAck> {
    const { db, env, poly, deps, bookCache } = this.ctx;
    const caps = this.ctx.caps ?? resolveSafetyCaps(db, env);
    const nowIso = this.ctx.now();
    const nowMs = Date.parse(nowIso) || 0;

    // §4.2 — the DryRunExecutor acts only when the EFFECTIVE mode permits simulation (dry_run; and the
    // persisted auto-pause is honoured because effectiveTradingMode consults it).
    const mode = effectiveTradingMode(db, env);
    if (!modeCaps(mode).simulate) return this.ack(order, "rejected", 0, null, `режим «${mode}» — DryRunExecutor неактивен (не dry_run)`);

    // §4.1 belt: hard caps (entries gated; a defensive exit passes). Clamp/reject/pause.
    const isEntry = order.leg === "entry";
    const cap = enforceCaps(db, { sizeUsd: order.sizeUsd, isEntry, dry: 1 }, nowMs, caps);
    if (cap.action !== "allow") return this.ack(order, "rejected", 0, null, `кэп (${cap.action}): ${cap.reason}`);

    // §4.1 fifth cap: conform to the market tick + min. The whitelist layer feeds per-market values
    // (Phase E plumbing); still defaults until Phase F wires live getTickSize / minimum_order_size.
    const mc = this.ctx.marketConstraints?.(order.tokenId) ?? { tickCents: DEFAULT_TICK_CENTS, minOrderUsd: DEFAULT_MIN_ORDER_USD };
    const conf = conformOrderToMarket({ side: order.side, limitPriceCents: order.limitPriceCents, sizeUsd: cap.sizeUsd }, { tickCents: mc.tickCents, minOrderUsd: mc.minOrderUsd, tolCents: 1 });
    if (!conf.ok) return this.ack(order, "rejected", 0, null, `conform: ${conf.reason}`);
    const limit = conf.limitPriceCents, sizeUsd = cap.sizeUsd;

    // §4.3 idempotency: a re-place of an order already past 'created' returns the same ack. B2 re-fill
    // guard: if a fill row already exists for this client id, the accounting ran — never double-fill.
    const existing = RR.getRealOrderByClientId(db, order.clientOrderId);
    if (existing && existing.status !== "created") return this.ack(order, existing.status, existing.filled_size_usd, existing.avg_fill_cents, `идемпотентно: ордер уже ${existing.status}`);
    if (existing && RR.realFillsForOrder(db, existing.id).length > 0) return this.ack(order, "filled", existing.filled_size_usd, existing.avg_fill_cents, "идемпотентно: филл уже записан");
    const orderId = existing?.id ?? randomUUID();

    // B2: fetch the book + compute the dry-fill BEFORE the transaction (the only await). Then insert →
    // placed → fill → ledger → position → final transition run in ONE db.transaction, so a crash can
    // never leave cash/position moved against a stuck 'placed' order — it's all-or-nothing.
    const bookRes = await classifyOrderBook(order.tokenId, poly, deps, bookCache);
    const fill = dryFill(order.side, limit, sizeUsd, bookRes, poly.exec);
    const expired = fill.filledUsd <= 0.009;
    const full = !expired && fill.filledUsd >= sizeUsd - 0.5;
    transact(db, () => {
      if (!existing) RR.insertRealOrder(db, {
        id: orderId, client_order_id: order.clientOrderId, exchange_order_id: null, decision_id: order.decisionId,
        strategy_id: order.strategyId, profile_id: order.profileId, match_id: order.matchId, token_id: order.tokenId,
        side: order.side, leg: order.leg, limit_price_cents: limit, size_usd: sizeUsd, tif_sec: order.timeInForceSec,
        expiry_mode: order.expiryMode ?? null,
        client_cancel_deadline: order.expiryMode === "client-cancel" ? new Date(nowMs + order.timeInForceSec * 1000).toISOString() : null,
        // S3b: stamp the ENTRY epoch (same source as bets.code_version) so dry-order cuts read a real
        // epoch instead of collapsing every fill into «legacy» — a verdict is only readable per clean epoch.
        code_version: effectiveCodeVersion(db), whitelist_version: this.ctx.whitelistVersion ?? null,
        note: `dry-run${cap.clamped ? ` · урезан кэпом до $${sizeUsd}` : ""}`, dry: 1, created_at: nowIso,
      });
      RR.transitionRealOrder(db, orderId, "placed", nowIso, { note: "dry-run placed (не отправлено)" });
      if (expired) { RR.transitionRealOrder(db, orderId, "expired", nowIso, { filledSizeUsd: 0, note: `TIF expired · ${fill.note}` }); return; }
      RR.insertRealFill(db, { order_id: orderId, client_order_id: order.clientOrderId, token_id: order.tokenId, side: order.side, size_usd: fill.filledUsd, price_cents: fill.priceCents, fee_usd: Math.round(fill.feeUsd * 100) / 100, dry: 1, at: nowIso, created_at: nowIso });
      // B3: book the ACTUAL gross proceeds (grossUsd), not the limit-price notional — cash matches realized P&L.
      RR.insertRealLedger(db, { kind: "fill", amount_usd: order.side === "BUY" ? -fill.grossUsd : fill.grossUsd, token_id: order.tokenId, order_id: orderId, ref: null, dry: 1, at: nowIso, created_at: nowIso });
      if (fill.feeUsd > 0.004) RR.insertRealLedger(db, { kind: "fee", amount_usd: -Math.round(fill.feeUsd * 100) / 100, token_id: order.tokenId, order_id: orderId, ref: null, dry: 1, at: nowIso, created_at: nowIso });
      updatePosition(db, order, fill, nowIso);
      RR.transitionRealOrder(db, orderId, full ? "filled" : "partial", nowIso, { filledSizeUsd: fill.filledUsd, avgFillCents: fill.priceCents, note: `dry-fill ${full ? "full" : "partial (остаток истёк по TIF, no chase)"} · ${fill.note}` });
    });
    if (expired) return this.ack(order, "expired", 0, null, fill.note, cap.clamped);
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
