// ─────────────────────────────────────────────────────────────────────────────
// EXECUTOR CONTRACT (spec §1)
//
// One interface, three implementations living behind it: PaperExecutor (current
// behavior, extracted), DryRunExecutor (real path, fills vs the live book, no
// send), RealExecutor (Polymarket CLOB — deferred). Strategists / sizing / gates
// NEVER know which executor is under them: every money-gate (untradeable, phantom,
// slippage, staleness, correlation caps) runs BEFORE the executor and is untouched.
//
// §9.6: the LLM already judged (in the decision). The executor moves money and is
// fully deterministic — no LLM call lives below this line.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

/** A price in cents, 0–100 (the whole app speaks cents, not 0–1 probabilities). */
export type Cents = number;
export type OrderSide = "BUY" | "SELL";

/** The leg of a decision an order belongs to — part of the idempotency key so an
 *  entry and a (later) exit for the SAME decision never collide on clientOrderId. */
export type OrderLeg = "entry" | "exit" | "exit_partial" | "settle";

/**
 * One order the executor is asked to place. Built by the whitelist filter from a
 * paper decision (spec §5) — NEVER by a strategist directly. `clientOrderId` is
 * generated BEFORE sending (deterministic from decisionId+leg) and is the
 * idempotency key: a re-place with the same id must not create a second order (§4.3).
 */
export interface OrderRequest {
  clientOrderId: string;
  tokenId: string;            // CLOB token_id = markets.external_ref
  side: OrderSide;
  limitPriceCents: Cents;     // decision price ± execution tolerance (limit ONLY — no market orders)
  sizeUsd: number;            // notional; the executor may fill LESS (partial) or clamp (caps)
  timeInForceSec: number;     // order lifetime; on expiry → cancel + `order_expired` (no eternal orders)
  decisionId: string;         // twin link to the paper bet (spec §0.1)
  strategyId: string;
  profileId: string;
  matchId: string;
}

/** Lifecycle status of a real/dry-run order (mirrors the real_orders table). */
export type OrderStatus =
  | "created"    // row written, not yet sent
  | "placed"     // acked by the exchange (has exchangeOrderId)
  | "partial"    // partially filled, still working
  | "filled"     // fully filled
  | "expired"    // TIF elapsed unfilled/partially → honest miss (anti-chasing)
  | "cancelled"  // cancelled by us ([STOP] / kill switch / reconciliation)
  | "rejected"   // exchange or safety-belt rejected
  | "dry_run";   // simulated only, never sent (DryRunExecutor)

/** Ack from place(): the order as the executor now knows it. */
export interface OrderAck {
  clientOrderId: string;
  exchangeOrderId: string | null; // null for paper / dry-run
  status: OrderStatus;
  filledSizeUsd: number;          // actually filled so far (partial-aware; §2.2)
  avgFillPriceCents: Cents | null;
  note?: string;                  // human trace (VWAP / slippage / clamp / skip reason)
}

export interface CancelAck { clientOrderId: string; cancelled: boolean; note?: string }

/** One fill event (price/size/fee) — accounting is by ACTUAL filled size (§2.2). */
export interface Fill {
  clientOrderId: string;
  tokenId: string;
  side: OrderSide;
  sizeUsd: number;
  priceCents: Cents;      // effective price incl. slippage
  feeUsd: number;
  atMs: number;           // exchange/fill timestamp
}

/** The executor's own view of a position (independent of the sim's bets table). */
export interface Position {
  tokenId: string;
  sizeShares: number;
  avgPriceCents: Cents;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number | null;
}

/** USDC available / reserved, as the executor sees it. */
export interface Balance { availableUsd: number; reservedUsd: number }

/** Exchange/wallet reachability — drives fail-closed + reconciliation. */
export interface ExecutorHealth { ok: boolean; note?: string; checkedAtMs: number }

/**
 * The contract. Paper/DryRun/Real all implement it; nothing above the executor
 * branches on which one is live (spec §1).
 */
export interface Executor {
  place(order: OrderRequest): Promise<OrderAck>;
  cancel(clientOrderId: string): Promise<CancelAck>;
  fills(sinceMs?: number): Promise<Fill[]>;
  positions(): Promise<Position[]>;
  balance(): Promise<Balance>;
  health(): Promise<ExecutorHealth>;
}

// ── Idempotency: deterministic clientOrderId ─────────────────────────────────
// clientOrderId = f(decisionId, leg) — stable across process restarts, so a
// crash-retry re-derives the SAME id and the exchange lookup (§4.3) dedupes it.
// A decision's entry and exit get DISTINCT ids via the leg suffix.
export function clientOrderIdFor(decisionId: string, leg: OrderLeg, seq = 0): string {
  const h = createHash("sha256").update(`${decisionId}|${leg}|${seq}`).digest("hex");
  // format as a uuid-shaped string (stable, collision-safe for our volume)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
