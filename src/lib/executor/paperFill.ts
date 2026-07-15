// ─────────────────────────────────────────────────────────────────────────────
// PAPER FILL ENGINE — the order-book fill orchestration, extracted from lifecycle
// so BOTH football and tennis (and later dry-run) share ONE fill model instead of
// football's book-VWAP vs tennis's naive 0¢/quote shortcut. Pure decision logic;
// the network book fetch is injected (classifyOrderBook).
//
// Behaviour parity: `paperBuyFill` / `paperSellFill` reproduce the exact numbers of
// the former private `executeEntry` / `sellVwapCents` in lifecycle.ts (the football
// suite is the snapshot net). Tennis, which never had a book model, is routed here
// deliberately — a FIX, not an invariant (spec §0 / build notes).
// ─────────────────────────────────────────────────────────────────────────────

import type { EngineDeps } from "./../engine.js";
import { fetchOrderBookResult, type OrderBookFetch, type PolymarketConfig } from "./../polymarket.js";
import { simulateBuy, simulateSell, maxExecutableBuyUsd, parametricSellAvgCents, takerFeeCents } from "./../execution.js";

export type ExecConfig = PolymarketConfig["exec"];

// A fill whose effective price has drifted this far (¢) from the strategist-evaluated
// price is a phantom/stale book (BTTS-No evaluated 74.5¢, filled 1.2¢), not the bet
// that was decided — don't open it. Env-tunable. (Moved here from lifecycle: it belongs
// with the fill engine so paper/dry-run/real share one guard.)
export const ENTRY_PHANTOM_DIVERGENCE = (() => { const n = Number(process.env.ENTRY_PHANTOM_DIVERGENCE); return Number.isFinite(n) && n > 0 ? n : 25; })();

/** Structured execution-cost of one fill — the fee + slippage folded into the
 *  effective price, kept separable so they can be aggregated (real-money leak). */
export interface FillCost {
  side: "buy" | "sell"; shares: number; notionalUsd: number;
  quoteCents: number; vwapCents: number;
  feeCents: number; feeUsd: number; slipCents: number; slipUsd: number; fromBook: boolean;
}

/** Scale a fill cost to a closed FRACTION (per-share cents/prices stay; totals scale). */
export function scaleCost(cost: FillCost, frac: number): FillCost {
  const f = Math.max(0, Math.min(1, frac));
  return { ...cost, shares: cost.shares * f, notionalUsd: cost.notionalUsd * f, feeUsd: cost.feeUsd * f, slipUsd: cost.slipUsd * f };
}

/**
 * Machine reason an entry did NOT fill — a two-fork liquidity map over time (build notes):
 *  - untradeable_market : book EMPTY / placeholder — nothing to trade, ever (coverage map)
 *  - orderbook_unavailable : book exists but no offers right now / fetch failed — transient
 *  - no_edge : depth exists but slippage eats the edge — priced out
 *  - phantom : effective price drifted from the decision — stale/phantom book
 * A THIN book (depth < requested size) does NOT reject — it fills SMALLER and sets `clamped`
 * (the "where we lose size" signal / the future partial-fill argument, §2.2).
 */
export type FillRejectReason = "untradeable_market" | "orderbook_unavailable" | "no_edge" | "phantom";

/** The result of an entry fill (was `EntryExec` in lifecycle). */
export interface EntryFillResult { skip: boolean; priceCents: number; stake: number; note?: string; retry?: boolean; cost?: FillCost; reason?: FillRejectReason; clamped?: boolean }
/** The result of an exit fill (was the return of `sellVwapCents`). `filledShares` < `requestedShares`
 *  on a THIN bid book → the caller sells what filled and holds the remainder (attention + retry, §2.2).
 *  `fromBook=false` is a MODELLED (stale) price — a defensive exit may use it flagged; a take must not. */
export interface SellFillResult { cents: number; note?: string; fromBook: boolean; bestBidCents?: number; cost?: FillCost; filledShares: number; requestedShares: number }

/** Fetch + cache a token's order book, classified (empty / ok / unavailable). The
 *  book is per-TOKEN, so two risk profiles on one market fetch it once per cycle. */
export async function classifyOrderBook(
  token: string | null, poly: PolymarketConfig, deps: EngineDeps,
  bookCache?: Map<string, OrderBookFetch>,
): Promise<OrderBookFetch> {
  if (!token) return { status: "empty" };
  if (bookCache && bookCache.has(token)) return bookCache.get(token)!;
  const r = await fetchOrderBookResult(token, poly, deps);
  if (bookCache) bookCache.set(token, r);
  return r;
}

/**
 * Entry fill against the real book: VWAP price (slippage), size capped to what the
 * book absorbs while keeping edge and bounding price impact. NO real tradeable book
 * → honest skip (never a parametric/placeholder fill): a fill on an empty book is a
 * fabricated price. `refCents` is the phantom reference (the strategist-evaluated
 * price); `fairCents` is the decision fair value driving the edge floor.
 */
export function paperBuyFill(
  bookRes: OrderBookFetch, sizeUsd: number, fairCents: number, refCents: number,
  quoteCents: number, exec: ExecConfig, phantomDivergence: number,
): EntryFillResult {
  // Entry-phantom guard: a fill at a rail, or one that drifted far from the price the
  // strategist sized against, is not the bet that was sized — reject it.
  const phantomFill = (eff: number): string | null =>
    eff <= 2 || eff >= 98 ? `цена исполнения ${eff}¢ у планки — рынок решён, вход отклонён (entry_phantom_block)`
    : refCents > 0 && Math.abs(eff - refCents) >= phantomDivergence ? `цена исполнения ${eff}¢ ушла от оценённой ${refCents}¢ на ${Math.abs(eff - refCents).toFixed(0)}¢ — рынок сместился, вход отклонён (entry_phantom_block)` : null;
  const book = bookRes.status === "ok" ? bookRes.book : null;
  if (book && book.asks.length) {
    const bestAsk = book.asks[0].priceCents;
    const capUsd = maxExecutableBuyUsd(book.asks, fairCents, { edgeFloorCents: exec.edgeFloorCents, maxImpactCents: exec.maxImpactCents, feeRate: exec.takerFeeRate });
    if (capUsd <= 0) return { skip: true, priceCents: quoteCents, stake: 0, reason: "no_edge", note: `нет объёма с эджем (аск ${bestAsk}¢ vs справ. ${fairCents.toFixed(0)}¢, слиппедж съедает край)` };
    const stake = Math.min(sizeUsd, capUsd);
    const fill = simulateBuy(book.asks, stake);
    const fee = takerFeeCents(fill.avgPriceCents, exec.takerFeeRate);
    const eff = Math.round((fill.avgPriceCents + fee) * 10) / 10;
    const slip = Math.round((fill.avgPriceCents - bestAsk) * 10) / 10;
    const ph = phantomFill(eff);
    if (ph) return { skip: true, priceCents: eff, stake: 0, reason: "phantom", note: ph };
    const capped = stake < sizeUsd - 0.5; // depth < requested → THIN: filled smaller (not a reject)
    const note = `VWAP ${fill.avgPriceCents}¢ (котир. ${bestAsk}¢${slip > 0 ? `, слип +${slip}¢` : ""}) + комиссия ${fee}¢ · сдвиг→${fill.newTopCents}¢${capped ? ` · урезан по глубине $${Math.round(sizeUsd)}→$${Math.round(stake)}` : ""}`;
    const slipAdverse = Math.max(0, slip);
    const cost: FillCost = {
      side: "buy", shares: fill.shares, notionalUsd: fill.filledUsd || stake,
      quoteCents: bestAsk, vwapCents: fill.avgPriceCents,
      feeCents: fee, feeUsd: (fill.shares * fee) / 100,
      slipCents: slipAdverse, slipUsd: (fill.shares * slipAdverse) / 100, fromBook: true,
    };
    return { skip: false, priceCents: eff, stake: Math.round(stake), note, cost, clamped: capped };
  }
  // No tradeable ask book → never a parametric fill (won't open a position we couldn't
  // price against a live book). Split the reason so a transient outage != a placeholder:
  //   empty       → uninitialized market (placeholder) — terminal block
  //   ok w/o asks → book exists but no offers right now — skip, retry next cycle
  //   unavailable → book fetch failed — skip THIS cycle, retry next
  if (bookRes.status === "empty")
    return { skip: true, priceCents: quoteCents, stake: 0, note: `стакан пуст — рынок не инициализирован, вход отклонён (untradeable_market_block)` };
  if (bookRes.status === "ok")
    return { skip: true, retry: true, priceCents: quoteCents, stake: 0, note: `нет предложений на продажу в стакане — вход отложен до след. цикла (orderbook_unavailable)` };
  return { skip: true, retry: true, priceCents: quoteCents, stake: 0, note: `стакан недоступен — книга не получена, вход отложен до след. цикла (orderbook_unavailable)` };
}

/**
 * Exit fill: sell `shares` into the bid side of the real book (VWAP), booking exit
 * slippage into P&L. No real book → a MODELLED price (fromBook=false) via the
 * parametric liquidity fallback, so the phantom-bid guard stays off a mere
 * illiquidity haircut. `basisUsd` labels the cost's notional only.
 */
export function paperSellFill(
  bookRes: OrderBookFetch, shares: number, basisUsd: number, quoteCents: number,
  mkLiquidity: number, exec: ExecConfig,
): SellFillResult {
  const book = bookRes.status === "ok" ? bookRes.book : null;
  if (shares > 0 && book && book.bids.length) {
    const f = simulateSell(book.bids, shares); // sells into BIDS (best/highest first) — never asks
    const bestBid = book.bids[0].priceCents;
    const fee = takerFeeCents(f.avgPriceCents, exec.takerFeeRate);
    const eff = Math.round((f.avgPriceCents - fee) * 10) / 10;
    const slip = Math.round((bestBid - f.avgPriceCents) * 10) / 10;
    const slipAdverse = Math.max(0, slip);
    const filled = f.filledShares; // < shares when the bid book is thin (partial exit → attention + retry)
    const cost: FillCost = {
      side: "sell", shares: filled, notionalUsd: basisUsd * (shares > 0 ? filled / shares : 1), quoteCents: bestBid, vwapCents: f.avgPriceCents,
      feeCents: fee, feeUsd: (filled * fee) / 100, slipCents: slipAdverse, slipUsd: (filled * slipAdverse) / 100, fromBook: true,
    };
    const partialNote = f.unfilledShares > 1e-6 ? ` · бид тонкий: исполнено ${Math.round((filled / shares) * 100)}%` : "";
    return { cents: eff, fromBook: true, bestBidCents: bestBid, cost, filledShares: filled, requestedShares: shares, note: `выход VWAP ${f.avgPriceCents}¢ (бид ${bestBid}¢${slip > 0 ? `, слип −${slip}¢` : ""}) − комиссия ${fee}¢${partialNote}` };
  }
  const avg = parametricSellAvgCents(quoteCents, basisUsd, mkLiquidity, exec.fallbackK);
  const fee = takerFeeCents(avg, exec.takerFeeRate);
  const eff = Math.round((avg - fee) * 10) / 10;
  const slipModel = Math.max(0, Math.round((quoteCents - avg) * 10) / 10);
  const cost: FillCost = {
    side: "sell", shares, notionalUsd: basisUsd, quoteCents, vwapCents: avg,
    feeCents: fee, feeUsd: (shares * fee) / 100, slipCents: slipModel, slipUsd: (shares * slipModel) / 100, fromBook: false,
  };
  // fromBook=false: MODELLED/stale price (no live bids). A defensive exit may use it (flagged); a take must skip.
  return { cents: eff, fromBook: false, cost, filledShares: shares, requestedShares: shares, note: `≈выход ${avg}¢ − комиссия ${fee}¢ (модель по ликвидности — нет живого бида)` };
}
