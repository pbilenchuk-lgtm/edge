// ─────────────────────────────────────────────────────────────────────────────
// real_vs_paper metrics (spec §7) — the showcase that answers "how much is the
// paper lying?" from the dry-run (and later real) contour. Every real order has a
// paper TWIN (same decision_id), so we join and compare. Pure reads; the model
// footnote from Phase D (dry fill-rate is a lower bound) applies to every number here.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "../db.js";
import * as RR from "../realRepo.js";

const med = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100);

export interface FillRateRow { category: string; total: number; filled: number; partial: number; expired: number; rejected: number; fillPct: number }
export interface RealVsPaperReport {
  orders: number;
  fillRateByCategory: FillRateRow[];
  slippage: { entryMedianCents: number | null; entryMeanCents: number | null; exitMedianCents: number | null; n: number };
  latency: { decisionToPlaceMsMedian: number | null; placeToFillMsMedian: number | null; n: number };
  missedFills: { count: number; edgeLostUsd: number };      // expired entries → the paper twin's realized P&L
  costs: { feeUsd: number; gasUsd: number; per100TurnoverUsd: number | null };
  pnlDelta: { realRealizedUsd: number; paperTwinPnlUsd: number; deltaUsd: number }; // real vs its twins
  note: string;
}

/** Build the §7 report from real_orders/fills/ledger joined to their paper twins (by decision_id). */
export function realVsPaperReport(db: Database): RealVsPaperReport {
  const entries = db.prepare(
    `SELECT o.id, o.decision_id, o.status, o.leg, o.avg_fill_cents, o.filled_size_usd, o.match_id,
            m.competition_id AS category, b.entry_price AS paper_entry, b.payout AS paper_payout, b.stake AS paper_stake,
            b.status AS paper_status, b.entry_meta AS paper_meta
     FROM real_orders o
     LEFT JOIN matches m ON m.id = o.match_id
     LEFT JOIN bets b ON b.decision_id = o.decision_id
     WHERE o.leg = 'entry'`,
  ).all() as any[];

  // fill-rate by category
  const cat = new Map<string, FillRateRow>();
  for (const e of entries) {
    const k = e.category ?? "(unknown)";
    const row = cat.get(k) ?? { category: k, total: 0, filled: 0, partial: 0, expired: 0, rejected: 0, fillPct: 0 };
    row.total++;
    if (e.status === "filled") row.filled++;
    else if (e.status === "partial") row.partial++;
    else if (e.status === "expired") row.expired++;
    else if (e.status === "rejected") row.rejected++;
    cat.set(k, row);
  }
  const fillRateByCategory = [...cat.values()].map((r) => ({ ...r, fillPct: r.total ? Math.round((100 * (r.filled + r.partial)) / r.total) : 0 })).sort((a, b) => b.total - a.total);

  // slippage (entry): real fill − the paper decision price
  const entrySlip = entries.filter((e) => (e.status === "filled" || e.status === "partial") && e.avg_fill_cents != null && e.paper_entry != null).map((e) => e.avg_fill_cents - e.paper_entry);
  const exitFills = db.prepare(`SELECT f.price_cents, o.limit_price_cents FROM real_fills f JOIN real_orders o ON o.id=f.order_id WHERE f.side='SELL'`).all() as any[];
  const exitSlip = exitFills.filter((x) => x.price_cents != null && x.limit_price_cents != null).map((x) => x.price_cents - x.limit_price_cents);

  // latency (dry ≈ 0 by construction; real fills once F round-trips)
  const dp: number[] = [], pf: number[] = [];
  for (const e of entries) {
    const a = RR.realOrderLatencyMs(db, e.id, "created", "placed"); if (a != null) dp.push(a);
    const b = RR.realOrderLatencyMs(db, e.id, "placed", "filled") ?? RR.realOrderLatencyMs(db, e.id, "placed", "partial"); if (b != null) pf.push(b);
  }

  // missed fills — an EXPIRED entry whose paper twin nonetheless realized P&L = edge we couldn't capture
  const missed = entries.filter((e) => e.status === "expired");
  const edgeLostUsd = r2(missed.reduce((s, e) => s + ((e.paper_payout ?? 0) - (e.paper_stake ?? 0)), 0)) ?? 0;

  // costs (fees + gas) and turnover
  const byKind = RR.realLedgerByKind(db);
  const feeUsd = -(byKind.fee ?? 0), gasUsd = -(byKind.gas ?? 0);
  const turnover = (db.prepare(`SELECT COALESCE(SUM(size_usd),0) t FROM real_fills`).get() as any).t ?? 0;

  // realized P&L (real) vs the twins' P&L
  const realRealized = r2(RR.listRealPositions(db).reduce((s, p) => s + (p.realized_pnl_usd ?? 0), 0)) ?? 0;
  const twinPnl = r2(entries.reduce((s, e) => s + ((e.paper_payout ?? 0) - (e.paper_stake ?? 0)), 0)) ?? 0;

  return {
    orders: entries.length,
    fillRateByCategory,
    slippage: { entryMedianCents: r2(med(entrySlip)), entryMeanCents: r2(mean(entrySlip)), exitMedianCents: r2(med(exitSlip)), n: entrySlip.length },
    latency: { decisionToPlaceMsMedian: r2(med(dp)), placeToFillMsMedian: r2(med(pf)), n: dp.length },
    missedFills: { count: missed.length, edgeLostUsd },
    costs: { feeUsd: r2(feeUsd) ?? 0, gasUsd: r2(gasUsd) ?? 0, per100TurnoverUsd: turnover > 0 ? r2((100 * (feeUsd + gasUsd)) / turnover) : null },
    pnlDelta: { realRealizedUsd: realRealized, paperTwinPnlUsd: twinPnl, deltaUsd: r2(realRealized - twinPnl) ?? 0 },
    note: "dry-run fill-rate is a lower bound (placement-snapshot model); a real resting order can fill as price approaches within TIF.",
  };
}

/** Per-order CSV for offline analysis (spec §7 export). One row per real ENTRY order + its twin delta. */
export function realVsPaperCsv(db: Database): string {
  const rows = db.prepare(
    `SELECT o.created_at, o.decision_id, o.strategy_id, o.profile_id, m.competition_id AS category, o.status,
            o.limit_price_cents, o.avg_fill_cents, o.size_usd, o.filled_size_usd, o.whitelist_version,
            b.entry_price AS paper_entry, b.stake AS paper_stake, b.payout AS paper_payout
     FROM real_orders o LEFT JOIN matches m ON m.id=o.match_id LEFT JOIN bets b ON b.decision_id=o.decision_id
     WHERE o.leg='entry' ORDER BY o.created_at`,
  ).all() as any[];
  const head = ["created_at", "decision_id", "strategy", "profile", "category", "status", "limit_cents", "fill_cents", "size_usd", "filled_usd", "whitelist_v", "paper_entry_cents", "entry_slip_cents", "paper_stake", "paper_pnl"];
  const esc = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = rows.map((r) => [
    r.created_at, r.decision_id, r.strategy_id, r.profile_id, r.category, r.status, r.limit_price_cents, r.avg_fill_cents,
    r.size_usd, r.filled_size_usd, r.whitelist_version, r.paper_entry,
    r.avg_fill_cents != null && r.paper_entry != null ? Math.round((r.avg_fill_cents - r.paper_entry) * 100) / 100 : "",
    r.paper_stake, r.paper_payout != null && r.paper_stake != null ? Math.round((r.paper_payout - r.paper_stake) * 100) / 100 : "",
  ].map(esc).join(","));
  return [head.join(","), ...lines].join("\n");
}
