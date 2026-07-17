// ============================================================
// EDGE LAB — DRY-FILL WATCH  [SERVER-ONLY, read-only]
//
// The Pre-F gate is the first END-TO-END dry fill on a liquid book. A bare "0 dry fills" is mute: it
// can't tell "no live liquid matches yet" from "the gate is closed at the wrong stage". This makes the
// zero LOUD — it walks the whole funnel, from football paper entries down to an actual dry fill, and
// names WHERE it stops:
//   candidates → [whitelist/size/decision replay] → would_mirror → real_orders built →
//     · rejected (mode/cap/conform)      — gate misconfigured
//     · нет живой книги                  — reached the executor, but no LIVE LIQUID book (need a match)
//     · истёк по TIF                     — price/edge crossed away before fill
//     · partial / filled                — 🎯 END-TO-END DRY FILL
// Read-only; never writes. Exposed at GET /api/real?report=dry_fill_watch.
// ============================================================

import type { Database } from "../db.js";
import * as RR from "../realRepo.js";
import { matchWhitelist, realSizeFromFraction, dryVirtualFreeUsd } from "./whitelist.js";
import { getProfileConfig } from "../riskConfig.js";

export interface DryFillWatch {
  windowHours: number;
  candidates: number; // football paper entries in the window (the top of the funnel)
  funnel: { strategyMiss: number; categoryMiss: number; sizeZero: number; noDecision: number; wouldMirror: number };
  missingCategories: { id: string; name: string; n: number }[];
  orders: { total: number; byStatus: Record<string, number>; noLiveBook: number; tifExpired: number; gateRejected: number; partial: number; filled: number; recentNotes: { status: string; note: string; at: string }[] };
  dryFillsInWindow: number;
  dryFillsAllTime: number;
  dryFilledUsdInWindow: number;
  openDryPositions: number;
  verdict: "dry_fill_achieved" | "reached_executor_no_live_book" | "gate_rejected" | "executor_never_built" | "gated_pre_executor" | "quiet_calendar";
  note: string;
}

const classifyNote = (n: string | null): "no_live_book" | "tif_expired" | "gate_rejected" | "other" => {
  const s = n ?? "";
  if (/нет живой книги/.test(s)) return "no_live_book";
  if (/истёк по TIF|лимит/.test(s)) return "tif_expired";
  if (/кэп|conform|режим|whitelist/.test(s)) return "gate_rejected";
  return "other";
};

/** Walk the paper→dry-fill funnel over a recent window and localise where it stops. `nowMs`/`env`
 *  injectable for tests; prod reads live. Never throws for a caller — pure reads. */
export function buildDryFillWatch(db: Database, env: Record<string, string | undefined> = process.env, nowMs = Date.now(), windowHours = 48): DryFillWatch {
  const cutoff = new Date(nowMs - windowHours * 3_600_000).toISOString();
  const realFree = dryVirtualFreeUsd(db, env);
  const wlStrategies = new Set(RR.listWhitelist(db, true).map((r) => r.strategy_id));

  // ── TOP: replay the mirror's pre-executor gates over every filled football entry in the window
  //    (identical logic to scripts/dry-diagnose.ts — one source of truth for the funnel shape).
  const bets = db.prepare(
    `SELECT b.strategy_id, b.risk_profile_id, b.ai_prob, b.entry_price, b.decision_id,
            m.competition_id AS cat, c.name AS cat_name
     FROM bets b JOIN matches m ON m.id=b.match_id JOIN competitions c ON c.id=m.competition_id
     WHERE c.sport_id='football' AND b.status IN ('open','settled_won','settled_lost','settled_void')
       AND b.entry_price IS NOT NULL AND b.created_at >= ?`,
  ).all(cutoff) as any[];
  const funnel = { strategyMiss: 0, categoryMiss: 0, sizeZero: 0, noDecision: 0, wouldMirror: 0 };
  const missCats = new Map<string, { name: string; n: number }>();
  for (const b of bets) {
    if (!wlStrategies.has(b.strategy_id)) { funnel.strategyMiss++; continue; }
    const row = matchWhitelist(db, { strategyId: b.strategy_id, categoryId: b.cat });
    if (!row) { funnel.categoryMiss++; const e = missCats.get(b.cat) ?? { name: b.cat_name ?? b.cat, n: 0 }; e.n++; missCats.set(b.cat, e); continue; }
    const pp = (b.entry_price ?? 0) / 100, ourP = b.ai_prob ?? 0;
    const kEdge = pp > 0 && pp < 1 ? (ourP - pp) / (1 - pp) : 0;
    const pcfg = getProfileConfig(db, b.risk_profile_id ?? "medium");
    const kFrac = Math.min(Math.max(pcfg.sizing.kelly_fraction_base, pcfg.sizing.kelly_fraction_clamp[0]), pcfg.sizing.kelly_fraction_clamp[1]);
    const intensity = kEdge > 0 ? Math.min(kFrac * kEdge, pcfg.sizing.max_position_pct) : 0;
    const size = realSizeFromFraction(Math.round(intensity * 10000) / 10000, realFree, row.max_order_usd);
    if (size <= 0) { funnel.sizeZero++; continue; }
    if (!b.decision_id || !b.entry_price) { funnel.noDecision++; continue; }
    funnel.wouldMirror++;
  }

  // ── BOTTOM: real_orders ACTUALS (in the dry regime every order is dry). Window-scoped, plus an
  //    all-time filled count so a historical first-fill still reads as "achieved".
  const allOrders = RR.listRealOrders(db);
  const windowOrders = allOrders.filter((o) => o.created_at >= cutoff);
  const byStatus: Record<string, number> = {};
  let noLiveBook = 0, tifExpired = 0, gateRejected = 0, partial = 0, filled = 0, filledUsd = 0;
  for (const o of windowOrders) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    if (o.status === "filled") { filled++; filledUsd += o.filled_size_usd; }
    else if (o.status === "partial") { partial++; filledUsd += o.filled_size_usd; }
    else { const c = classifyNote(o.note); if (c === "no_live_book") noLiveBook++; else if (c === "tif_expired") tifExpired++; else if (c === "gate_rejected") gateRejected++; }
  }
  const recentNotes = windowOrders.filter((o) => o.filled_size_usd <= 0).slice(-8).map((o) => ({ status: o.status, note: o.note ?? "", at: o.created_at }));
  const dryFillsAllTime = allOrders.filter((o) => o.filled_size_usd > 0).length;
  const openDryPositions = (db.prepare(`SELECT COUNT(*) n FROM real_positions WHERE dry=1 AND size_shares > 0`).get() as { n: number }).n;

  // ── LOUD-ZERO verdict: name the exact stage the funnel dies at.
  let verdict: DryFillWatch["verdict"], note: string;
  if (filled + partial > 0) { verdict = "dry_fill_achieved"; note = `🎯 ${filled + partial} dry-филл(ов) в окне ($${Math.round(filledUsd)}) — Pre-F гейт ПРОЙДЕН end-to-end`; }
  else if (windowOrders.length > 0 && noLiveBook >= gateRejected && noLiveBook >= tifExpired) { verdict = "reached_executor_no_live_book"; note = `дошли до исполнителя, но ${noLiveBook} ордер(ов) без живой ликвидной книги — гейт открыт правильно, нужен ЛИКВИДНЫЙ живой матч (не гейт закрыт)`; }
  else if (gateRejected > 0 && gateRejected >= tifExpired) { verdict = "gate_rejected"; note = `${gateRejected} ордер(ов) отклонены гейтом (режим/кэп/conform) — гейт закрыт не тем; смотри recentNotes`; }
  else if (windowOrders.length > 0) { verdict = "reached_executor_no_live_book"; note = `${windowOrders.length} ордер(ов) построены, ни один не налит (в осн. TIF/цена) — книга есть, но цена ушла; нужен матч с держащейся ликвидностью`; }
  else if (funnel.wouldMirror > 0) { verdict = "executor_never_built"; note = `${funnel.wouldMirror} входов ДОЛЖНЫ были дать ордер, но real_orders=0 — исполнитель не строит (копать place()/tokenId)`; }
  else if (bets.length === 0) { verdict = "quiet_calendar"; note = "футбольных входов в окне нет — тихий календарь, не гейт (жди матчей)"; }
  else { verdict = "gated_pre_executor"; const dom = Math.max(funnel.categoryMiss, funnel.strategyMiss, funnel.sizeZero, funnel.noDecision); note = `0 ордеров: доминирует ${dom === funnel.categoryMiss ? "category_miss (whitelist не покрывает лиги — дыра в списке)" : dom === funnel.noDecision ? "no_decision (ставки до Phase A / нет decision_id)" : dom === funnel.sizeZero ? "size_zero (edge≤0 → доля 0)" : "strategy_miss (стратегия не в whitelist)"}`; }

  return {
    windowHours, candidates: bets.length, funnel,
    missingCategories: [...missCats.entries()].sort((a, b) => b[1].n - a[1].n).map(([id, v]) => ({ id, name: v.name, n: v.n })),
    orders: { total: windowOrders.length, byStatus, noLiveBook, tifExpired, gateRejected, partial, filled, recentNotes },
    dryFillsInWindow: filled + partial, dryFillsAllTime, dryFilledUsdInWindow: Math.round(filledUsd * 100) / 100, openDryPositions,
    verdict, note,
  };
}
