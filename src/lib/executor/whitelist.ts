// ─────────────────────────────────────────────────────────────────────────────
// WHITELIST FILTER (spec §5) — the ONLY gate from simulation into real. Every paper
// decision, AFTER it has been filled in the sim, is run through here: matched
// against real_whitelist, and (only on a match) a real OrderRequest is BUILT and
// handed to the executor. The simulation NEVER changes because of this — it's a
// read-only mirror (spec §0.2). Starts EMPTY (real trades nothing). sport is
// hard-pinned football this stage.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import type { EngineDeps } from "../engine.js";
import type { OrderBookFetch, PolymarketConfig } from "../polymarket.js";
import type { Bet } from "../types.js";
import * as RR from "../realRepo.js";
import { loadSafetyCaps, effectiveTradingMode, modeCaps } from "./safety.js";
import { DryRunExecutor } from "./dryRun.js";
import { clientOrderIdFor } from "./types.js";
import type { Executor, OrderRequest } from "./types.js";

export const WHITELIST_SPORT = "football"; // hard-pinned this stage (tennis can't reach real)

// ── whitelist management (versioned from the FIRST row; every change journals) ─────────────────
export interface AddWhitelistInput { strategyId: string; categories: string[]; maxOrderUsd: number; enabled?: boolean }
/** Add a whitelist row. Validates sport=football (enforced again by the DB CHECK) and
 *  maxOrderUsd ≤ REAL_MAX_ORDER_USD. Bumps the version and journals the change — so the FIRST row,
 *  and every later edit (even by hand this stage), carries an auditable version. Returns the new version. */
export function addWhitelistRow(db: Database, o: AddWhitelistInput, actor: string, nowIso: string): { ok: boolean; version?: number; error?: string } {
  const caps = loadSafetyCaps();
  if (o.maxOrderUsd > caps.maxOrderUsd) return { ok: false, error: `maxOrderUsd $${o.maxOrderUsd} > REAL_MAX_ORDER_USD $${caps.maxOrderUsd}` };
  if (!(o.maxOrderUsd > 0)) return { ok: false, error: "maxOrderUsd must be > 0" };
  const version = RR.currentWhitelistVersion(db) + 1;
  db.prepare(`INSERT INTO real_whitelist(id,strategy_id,sport,categories,max_order_usd,enabled,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), o.strategyId, WHITELIST_SPORT, JSON.stringify(o.categories ?? []), o.maxOrderUsd, o.enabled ? 1 : 0, version, nowIso, nowIso);
  RR.appendWhitelistLog(db, version, "add", JSON.stringify(o), actor, nowIso);
  return { ok: true, version };
}
/** Enable/disable a row — also a versioned, journaled change. */
export function setWhitelistEnabled(db: Database, id: string, enabled: boolean, actor: string, nowIso: string): number {
  const version = RR.currentWhitelistVersion(db) + 1;
  db.prepare(`UPDATE real_whitelist SET enabled=?, version=?, updated_at=? WHERE id=?`).run(enabled ? 1 : 0, version, nowIso, id);
  RR.appendWhitelistLog(db, version, enabled ? "enable" : "disable", JSON.stringify({ id }), actor, nowIso);
  return version;
}

/** The enabled row matching (strategy, category), or null. A row lists the categories it covers. */
export function matchWhitelist(db: Database, q: { strategyId: string; categoryId: string }): RR.RealWhitelistRow | null {
  for (const r of RR.listWhitelist(db, true)) {
    if (r.strategy_id !== q.strategyId) continue;
    let cats: string[] = [];
    try { cats = JSON.parse(r.categories || "[]"); } catch { cats = []; }
    if (cats.includes(q.categoryId)) return r;
  }
  return null;
}

// ── proportional sizing (condition 1: PROPORTION, never absolute) ──────────────────────────────
/**
 * Real size = the paper decision's FRACTION of its budget, applied to the real free bank — then
 * capped by the whitelist row's per-row ceiling. This keeps real sizing EDGE-PROPORTIONAL: a bigger
 * paper conviction → a bigger real order. Carrying the ABSOLUTE paper stake instead would be wrong —
 * paper banks are orders of magnitude larger, so min($paper, $50) would flatten every real order to
 * the cap, and slippage / fill-rate would become incomparable across edge zones (the real-vs-paper
 * metric dies). Proportion, not absolute.
 */
export function proportionalRealSize(paperStakeUsd: number, paperBankUsd: number, realFreeUsd: number, rowMaxUsd: number): number {
  if (!(paperBankUsd > 0) || !(realFreeUsd > 0)) return 0;
  const frac = paperStakeUsd / paperBankUsd;            // the paper decision's share of its bank
  return Math.max(0, Math.min(frac * realFreeUsd, rowMaxUsd));
}

// ── the mirror hook (condition 2: ASYNC to paper, never delays/crashes it) ──────────────────────
export interface MirrorCtx {
  env: Record<string, string | undefined>;
  poly: PolymarketConfig;
  deps: EngineDeps;
  now: () => string;
  bookCache?: Map<string, OrderBookFetch>;
  sport: string;                 // the bet's sport (only football is mirrored)
  categoryId: string;            // the match's category id (for whitelist matching)
  tokenId: string;               // CLOB token of the market being entered
  paperBankUsd: number;          // the (strategy, profile) paper budget the stake was sized within
  realFreeUsd: number;           // real USDC available to scale into
  tifSec?: number;
  onError?: (msg: string) => void;
  // Test seam: override the executor (default: DryRunExecutor in dry_run; real not wired until Phase F).
  executorFor?: (mode: ReturnType<typeof effectiveTradingMode>) => Executor | null;
}

/**
 * Mirror one FILLED paper entry into the real contour. ISOLATION (§0.2): the entire body is wrapped
 * so ANY failure — whitelist read, order build, book timeout, executor throw — degrades to "no real
 * order, paper untouched" + a log. It NEVER re-throws into the paper path. Returns the ack (or null
 * when nothing was mirrored). This is the most fragile seam in the system, so it fails soft by design.
 */
export async function mirrorPaperEntryToReal(db: Database, bet: Bet, ctx: MirrorCtx): Promise<{ mirrored: boolean; note: string }> {
  try {
    // Hard sport gate — tennis (or anything non-football) can NEVER reach real this stage.
    if (ctx.sport !== WHITELIST_SPORT) return { mirrored: false, note: `sport ${ctx.sport} не допускается в реал` };
    const mode = effectiveTradingMode(db, ctx.env);
    const caps = modeCaps(mode);
    if (!caps.simulate && !caps.realEntry) return { mirrored: false, note: `режим «${mode}» — реал не строится` };
    const row = matchWhitelist(db, { strategyId: bet.strategy_id, categoryId: ctx.categoryId });
    if (!row) return { mirrored: false, note: "не в whitelist — только paper" };
    const size = proportionalRealSize(bet.stake ?? 0, ctx.paperBankUsd, ctx.realFreeUsd, row.max_order_usd);
    if (size <= 0) return { mirrored: false, note: "реальный размер 0 (пропорция/банк)" };
    if (!bet.decision_id || !bet.entry_price) return { mirrored: false, note: "нет decision_id/цены входа" };

    const order: OrderRequest = {
      clientOrderId: clientOrderIdFor(bet.decision_id, "entry"), leg: "entry", tokenId: ctx.tokenId, side: "BUY",
      limitPriceCents: bet.entry_price, sizeUsd: size, timeInForceSec: ctx.tifSec ?? 45, decisionId: bet.decision_id,
      strategyId: bet.strategy_id, profileId: bet.risk_profile_id ?? "medium", matchId: bet.match_id,
      fairValueCents: (bet.ai_prob ?? 0) * 100, expiryMode: "client-cancel",
    };
    const executor = ctx.executorFor
      ? ctx.executorFor(mode)
      : caps.simulate
        ? new DryRunExecutor({ db, env: ctx.env, poly: ctx.poly, deps: ctx.deps, bookCache: ctx.bookCache, now: ctx.now, whitelistVersion: RR.currentWhitelistVersion(db) })
        : null; // real executor is Phase F
    if (!executor) return { mirrored: false, note: `режим «${mode}» требует реального исполнителя (Phase F) — пропущено` };
    const ack = await executor.place(order);
    return { mirrored: ack.status === "filled" || ack.status === "partial", note: `${ack.status}: ${ack.note ?? ""}` };
  } catch (e) {
    // §0.2 — the real contour must never break the paper flow. Swallow, log, degrade to paper-only.
    const msg = `real mirror failed (paper unaffected): ${e instanceof Error ? e.message : String(e)}`;
    try { (ctx.onError ?? (() => {}))(msg); } catch { /* even the logger must not throw here */ }
    return { mirrored: false, note: msg };
  }
}
