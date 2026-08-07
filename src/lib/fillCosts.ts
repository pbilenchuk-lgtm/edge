// ============================================================
// EDGE LAB — execution-cost aggregation (fees + slippage). The effective fill price
// already folds these into P&L; this rolls the SEPARATE ledger (fill_costs) up so the
// leak is visible and tunable before real money. Pure functions over the rows.
// ============================================================

import type { FillCostRow } from "./repo.js";
import type { Database } from "./db.js";
import type { FillCost } from "./executor/paperFill.js";
import * as R from "./repo.js";

export interface FillCostSummary {
  fills: number; buys: number; sells: number;
  notionalUsd: number;
  feeUsd: number; slipUsd: number; totalUsd: number;
  feeBuyUsd: number; feeSellUsd: number; slipBuyUsd: number; slipSellUsd: number;
  /** total cost (fee+slip) as a fraction of transacted notional — the drag per $ traded. */
  costPctOfNotional: number;
  /** mean adverse slippage per share (¢), volume-agnostic — the book-quality read. */
  avgSlipCents: number;
  modelledFills: number; // fills priced off a parametric model (no real book), for transparency
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function summarizeFillCosts(rows: FillCostRow[]): FillCostSummary {
  let notionalUsd = 0, feeUsd = 0, slipUsd = 0, feeBuyUsd = 0, feeSellUsd = 0, slipBuyUsd = 0, slipSellUsd = 0;
  let buys = 0, sells = 0, modelledFills = 0, slipCentsSum = 0;
  for (const f of rows) {
    notionalUsd += f.notional_usd; feeUsd += f.fee_usd; slipUsd += f.slip_usd;
    slipCentsSum += f.slip_cents;
    if (!f.from_book) modelledFills++;
    if (f.side === "buy") { buys++; feeBuyUsd += f.fee_usd; slipBuyUsd += f.slip_usd; }
    else { sells++; feeSellUsd += f.fee_usd; slipSellUsd += f.slip_usd; }
  }
  const totalUsd = feeUsd + slipUsd;
  return {
    fills: rows.length, buys, sells, notionalUsd: r2(notionalUsd),
    feeUsd: r2(feeUsd), slipUsd: r2(slipUsd), totalUsd: r2(totalUsd),
    feeBuyUsd: r2(feeBuyUsd), feeSellUsd: r2(feeSellUsd), slipBuyUsd: r2(slipBuyUsd), slipSellUsd: r2(slipSellUsd),
    costPctOfNotional: notionalUsd > 0 ? r2((totalUsd / notionalUsd) * 100) : 0,
    avgSlipCents: rows.length ? r2(slipCentsSum / rows.length) : 0,
    modelledFills,
  };
}

/** Group rows by a key (e.g. competition_id / strategy_id) → summary per group. */
export function groupFillCosts(rows: FillCostRow[], keyOf: (r: FillCostRow) => string): Map<string, FillCostSummary> {
  const buckets = new Map<string, FillCostRow[]>();
  for (const r of rows) { const k = keyOf(r); (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(r); }
  const out = new Map<string, FillCostSummary>();
  for (const [k, rs] of buckets) out.set(k, summarizeFillCosts(rs));
  return out;
}


/**
 * [T5 07.08] ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ИЗДЕРЖКИ ПОПАДАЮТ В ЛЕДЖЕР.
 *
 * Раньше эта функция жила приватной в `lifecycle.ts` — и была доступна только футбольному пути.
 * Теннис ходит через исполнителя и до неё не дотягивался: его леджер списывал $0 комиссий, хотя
 * net_ev-гейт той же ветки знает про 2.6¢ и режет ими кандидатов. Две ноги портфеля считались в
 * РАЗНЫХ единицах, а сравнивались как в одной.
 *
 * Наблюдение-only: падение записи никогда не ломает филл — но и молчать не должно, поэтому счётчик
 * отказов ведётся вызывающим, а не прячется здесь.
 */
export function recordFill(
  db: Database,
  ids: { betId: string | null; matchId: string; competitionId: string; strategyId: string; profileId: string },
  cost: FillCost, now: string,
): boolean {
  const r2v = (n: number) => Math.round(n * 100) / 100;
  try {
    R.insertFillCost(db, {
      id: R.uid(), bet_id: ids.betId, match_id: ids.matchId, competition_id: ids.competitionId,
      strategy_id: ids.strategyId, profile_id: ids.profileId, side: cost.side,
      shares: r2v(cost.shares), notional_usd: r2v(cost.notionalUsd),
      quote_cents: cost.quoteCents, vwap_cents: cost.vwapCents,
      fee_cents: cost.feeCents, fee_usd: r2v(cost.feeUsd),
      slip_cents: cost.slipCents, slip_usd: r2v(cost.slipUsd),
      from_book: cost.fromBook ? 1 : 0, created_at: now,
    });
    return true;
  } catch { return false; }
}
