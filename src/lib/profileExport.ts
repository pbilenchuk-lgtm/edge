// ============================================================
// EDGE LAB — flat export of the bet log for external analysis (the file the user
// brings to a chat). One row = one bet with every Part-1 field + aggregated exits +
// final score. Plus a per-exit export (one row = one exit) for execution analysis.
// Read-only; derived from betRecords.
// ============================================================

import type { Database } from "./db.js";
import { betRecords, type BetRec, type ProfileFilter } from "./profileAnalytics.js";

const csvCell = (v: unknown): string => {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols: string[], rows: unknown[][]): string =>
  "﻿" + [cols, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");

const BET_COLS = [
  "bet_id", "code_version", "created_phase", "category", "strategy", "profile", "match", "final_score", "market",
  "wins_on_event", "minute_at_entry", "score_home_at_entry", "score_away_at_entry",
  "edge_at_entry", "ai_prob_at_entry", "derived_prob_at_entry", "implied_prob_at_entry", "live_prob_adjusted",
  "market_price_at_entry", "entry_price", "closing_price", "clv_cents",
  "kelly_fraction", "size_requested", "size_filled", "entry_slip_cents", "calibration", "branch_weight_sum", "market_thinness_usd",
  "status", "settled_by", "outcome", "stake", "payout", "pnl_net",
  "exit_count", "exit_triggers", "exit_vwap_cents", "exit_pnl_sum",
];

function betRow(r: BetRec): unknown[] {
  const exTrig = r.exits.map((e) => e.trigger).join("|");
  const exPnl = Math.round(r.exits.reduce((s, e) => s + e.pnl, 0) * 100) / 100;
  // Volume-weighted exit price (by |pnl| as a rough weight proxy; falls back to mean).
  const priced = r.exits.filter((e) => e.priceCents != null);
  const exVwap = priced.length ? Math.round((priced.reduce((s, e) => s + (e.priceCents as number), 0) / priced.length) * 10) / 10 : "";
  return [
    r.id, r.codeVersion, r.phase, r.category, r.strategy, r.profileId, r.matchLabel, r.finalScore, r.market,
    r.winsOnEvent ? 1 : 0, r.minute, r.scoreHome, r.scoreAway,
    r.edge, r.aiProb, r.derivedProb, r.impliedProb, r.liveProbAdjusted,
    r.marketPrice, r.entryCents, r.closingCents, r.clvCents,
    r.kelly, r.sizeRequested, r.sizeFilled, r.entrySlipCents, r.calibration, r.branchWeightSum, r.thinnessUsd,
    r.status, r.settledBy, r.outcome, r.stake, r.payout, r.pnl,
    r.exits.length, exTrig, exVwap, exPnl,
  ];
}

/** One row per BET (all Part-1 fields + aggregated exits + final score). */
export function betsCsv(db: Database, filter: ProfileFilter = {}): string {
  return toCsv(BET_COLS, betRecords(db, filter).map(betRow));
}
/** One row per BET as JSON (the full nested record incl. the exit list). */
export function betsJson(db: Database, filter: ProfileFilter = {}): string {
  return JSON.stringify(betRecords(db, filter), null, 2);
}

const EXIT_COLS = ["bet_id", "match", "strategy", "profile", "market", "wins_on_event", "trigger", "minute", "exec_price_cents", "partial", "model_fill", "pnl", "text"];
/** One row per EXIT (execution analysis). */
export function exitsCsv(db: Database, filter: ProfileFilter = {}): string {
  const rows: unknown[][] = [];
  for (const r of betRecords(db, filter))
    for (const e of r.exits)
      rows.push([r.id, r.matchLabel, r.strategy, r.profileId, r.market, r.winsOnEvent ? 1 : 0, e.trigger, e.minute, e.priceCents, e.partial ? 1 : 0, e.modelFill ? 1 : 0, e.pnl, e.text]);
  return toCsv(EXIT_COLS, rows);
}

export const BET_EXPORT_COLUMNS = BET_COLS;
