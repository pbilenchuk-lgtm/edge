// ─────────────────────────────────────────────────────────────────────────────
// realView — the read-only aggregate the Real UI (Phase G, iteration 1) renders.
// Pure reads; no control here (STOP / mode / whitelist edits are iteration 2, each
// its own audited endpoint). The mode is the EFFECTIVE one (env ∧ sticky pause), so
// a daily-loss / reconciliation pause is visible in the badge, not just the env value.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "../db.js";
import * as RR from "../realRepo.js";
import { effectiveTradingMode, type TradingMode } from "./safety.js";
import { realVsPaperReport, type RealVsPaperReport } from "./realVsPaper.js";

export interface RealOrderView {
  id: string; clientOrderId: string; decisionId: string; strategyId: string; profileId: string; category: string | null;
  side: string; leg: string; status: string; limitCents: number; avgFillCents: number | null; sizeUsd: number; filledUsd: number;
  dry: boolean; whitelistVersion: number | null; createdAt: string;
  events: { status: string; at: string; note: string | null }[];
  // twin-link delta (paper decision vs the real/dry fill)
  paperEntryCents: number | null; entrySlipCents: number | null; paperPnlUsd: number | null;
}

export interface RealView {
  mode: TradingMode;                 // effective (env ∧ sticky pause)
  envMode: TradingMode;              // raw env, so the UI can show "paused despite env=on"
  paused: RR.RealAutoPause | null;
  orphan: RR.RealOrphanAlert | null;
  bank: { realBalanceUsd: number; dryBalanceUsd: number; byKind: Record<string, number> };
  positions: RR.RealPositionRow[];
  orders: RealOrderView[];
  whitelist: RR.RealWhitelistRow[];
  whitelistVersion: number;
  report: RealVsPaperReport;
}

/** Build the whole read-only view. `limit` bounds the order feed (newest first). */
export function realView(db: Database, env: Record<string, string | undefined> = process.env, limit = 100): RealView {
  const effective = effectiveTradingMode(db, env);
  const envMode = (["on", "dry_run", "exits_only"].includes((env.REAL_TRADING ?? "off").toLowerCase()) ? (env.REAL_TRADING as string).toLowerCase() : "off") as TradingMode;

  const orderRows = db.prepare(
    `SELECT o.*, m.competition_id AS category, b.entry_price AS paper_entry, b.payout AS paper_payout, b.stake AS paper_stake
     FROM real_orders o LEFT JOIN matches m ON m.id=o.match_id LEFT JOIN bets b ON b.decision_id=o.decision_id
     ORDER BY o.created_at DESC LIMIT ?`,
  ).all(limit) as any[];

  const orders: RealOrderView[] = orderRows.map((o) => ({
    id: o.id, clientOrderId: o.client_order_id, decisionId: o.decision_id, strategyId: o.strategy_id, profileId: o.profile_id,
    category: o.category ?? null, side: o.side, leg: o.leg, status: o.status, limitCents: o.limit_price_cents,
    avgFillCents: o.avg_fill_cents, sizeUsd: o.size_usd, filledUsd: o.filled_size_usd, dry: o.exchange_order_id == null,
    whitelistVersion: o.whitelist_version, createdAt: o.created_at,
    events: RR.realOrderEvents(db, o.id),
    paperEntryCents: o.paper_entry ?? null,
    entrySlipCents: o.avg_fill_cents != null && o.paper_entry != null ? Math.round((o.avg_fill_cents - o.paper_entry) * 100) / 100 : null,
    paperPnlUsd: o.paper_payout != null && o.paper_stake != null ? Math.round((o.paper_payout - o.paper_stake) * 100) / 100 : null,
  }));

  return {
    mode: effective,
    envMode,
    paused: RR.getRealAutoPause(db),
    orphan: RR.getRealOrphanAlert(db),
    bank: { realBalanceUsd: RR.realLedgerBalance(db, true), dryBalanceUsd: RR.realLedgerBalance(db, false), byKind: RR.realLedgerByKind(db) },
    positions: RR.listRealPositions(db),
    orders,
    whitelist: RR.listWhitelist(db),
    whitelistVersion: RR.currentWhitelistVersion(db),
    report: realVsPaperReport(db),
  };
}
