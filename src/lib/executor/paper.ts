// ─────────────────────────────────────────────────────────────────────────────
// PaperExecutor — the current simulation behaviour behind the Executor contract
// (spec §1). place() fills against the SAME shared engine (paperBuyFill /
// paperSellFill) that football's executeEntry/sellVwapCents now delegate to, so a
// decision routed through the contract fills identically. Positions/balance/fills
// are lightweight paper stubs — the sim's own bets table remains the book of record;
// this view exists only so DryRun/Real can share the interface.
//
// §9.6: fully deterministic, no LLM below this line.
// ─────────────────────────────────────────────────────────────────────────────

import type { EngineDeps } from "../engine.js";
import type { OrderBookFetch, PolymarketConfig } from "../polymarket.js";
import { classifyOrderBook, paperBuyFill, paperSellFill, ENTRY_PHANTOM_DIVERGENCE } from "./paperFill.js";
import type { Executor, OrderRequest, OrderAck, CancelAck, Fill, Position, Balance, ExecutorHealth } from "./types.js";

export interface PaperExecutorCtx {
  poly: PolymarketConfig;
  deps: EngineDeps;
  bookCache?: Map<string, OrderBookFetch>;
  nowMs: () => number;
}

/** No-book / staleness reason surfaced to the caller so tennis (and dry-run) can log
 *  `no_book_liquidity` and SKIP rather than fill a fabricated price (build notes). */
export const NO_BOOK_LIQUIDITY = "no_book_liquidity";

export class PaperExecutor implements Executor {
  constructor(private ctx: PaperExecutorCtx) {}

  async place(order: OrderRequest): Promise<OrderAck> {
    const { poly, deps, bookCache } = this.ctx;
    if (!poly.enabled) {
      // Execution model off → quote fill at the limit (legacy paper behaviour).
      return { clientOrderId: order.clientOrderId, exchangeOrderId: null, status: "filled", filledSizeUsd: order.sizeUsd, avgFillPriceCents: order.limitPriceCents, note: "execution model off — quote fill" };
    }
    const bookRes = await classifyOrderBook(order.tokenId, poly, deps, bookCache);
    if (order.side === "BUY") {
      const fair = order.fairValueCents ?? order.limitPriceCents;
      const r = paperBuyFill(bookRes, order.sizeUsd, fair, order.limitPriceCents, order.limitPriceCents, poly.exec, ENTRY_PHANTOM_DIVERGENCE);
      if (r.skip) {
        // No tradeable book / phantom → NEVER a fabricated fill. Honest reject; `reason`
        // is the machine code (untradeable_market = empty/placeholder vs orderbook_unavailable
        // = transient vs no_edge vs phantom) so the caller maps it to the right skip counter.
        return { clientOrderId: order.clientOrderId, exchangeOrderId: null, status: "rejected", filledSizeUsd: 0, avgFillPriceCents: null, reason: r.reason ?? "untradeable_market", note: r.note ?? NO_BOOK_LIQUIDITY };
      }
      return { clientOrderId: order.clientOrderId, exchangeOrderId: null, status: "filled", filledSizeUsd: r.stake, avgFillPriceCents: r.priceCents, clamped: r.clamped, note: r.note };
    }
    // SELL: sell the shares implied by sizeUsd at the limit into the bid side.
    const shares = order.limitPriceCents > 0 ? order.sizeUsd / (order.limitPriceCents / 100) : 0;
    const r = paperSellFill(bookRes, shares, order.sizeUsd, order.limitPriceCents, 0, poly.exec);
    if (!r.fromBook && bookRes.status !== "ok") {
      // A protective exit still needs to leave (spec §4.5) but must not price off an
      // empty book — surface the stale/no-book condition to the caller, which decides
      // (last bid + stale flag for defensive exits; skip otherwise).
      return { clientOrderId: order.clientOrderId, exchangeOrderId: null, status: "rejected", filledSizeUsd: 0, avgFillPriceCents: r.cents, note: `${NO_BOOK_LIQUIDITY}: ${r.note ?? "нет книги на продажу"}` };
    }
    return { clientOrderId: order.clientOrderId, exchangeOrderId: null, status: "filled", filledSizeUsd: order.sizeUsd, avgFillPriceCents: r.cents, note: r.note };
  }

  // Paper has no resting orders, no separate wallet, no exchange — these satisfy the
  // contract so DryRun/Real can be swapped in without the caller branching.
  async cancel(clientOrderId: string): Promise<CancelAck> { return { clientOrderId, cancelled: true, note: "paper: nothing resting" }; }
  async fills(): Promise<Fill[]> { return []; } // fills are booked as bet rows, not tracked here
  async positions(): Promise<Position[]> { return []; }
  async balance(): Promise<Balance> { return { availableUsd: Infinity, reservedUsd: 0 }; } // paper is unbounded by design
  async health(): Promise<ExecutorHealth> { return { ok: true, note: "paper", checkedAtMs: this.ctx.nowMs() }; }
}
