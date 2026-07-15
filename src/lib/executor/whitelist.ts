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
import { isSettled } from "../repo.js";
import { loadSafetyCaps, effectiveTradingMode, modeCaps, readTradingMode } from "./safety.js";
import { DryRunExecutor } from "./dryRun.js";
import { clientOrderIdFor } from "./types.js";
import type { Executor, OrderRequest } from "./types.js";

export const WHITELIST_SPORT = "football"; // hard-pinned this stage (tennis can't reach real)
// A mirrored EXIT sell accepts down to (paper mark − this) so it fills at the going bid (§2.2), rather
// than resting above the live bid forever. Env-tunable; conservative default.
const EXIT_SELL_TOLERANCE_CENTS = (() => { const n = Number(process.env.REAL_EXIT_SELL_TOLERANCE_CENTS); return Number.isFinite(n) && n > 0 ? n : 5; })();

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
  return realSizeFromFraction(paperStakeUsd / paperBankUsd, realFreeUsd, rowMaxUsd);
}
/** The same, when the caller already holds the decision's conviction FRACTION (e.g. the shadow
 *  allocator's budget-independent Kelly×edge intensity) — real size = min(fraction × real free, row cap). */
export function realSizeFromFraction(fraction: number, realFreeUsd: number, rowMaxUsd: number): number {
  if (!(fraction > 0) || !(realFreeUsd > 0)) return 0;
  return Math.max(0, Math.min(fraction * realFreeUsd, rowMaxUsd));
}

// ── virtual dry-bank (condition 2: real free from a VIRTUAL bank, reserved by open dry positions) ──
/** The virtual real bank for dry-run sizing (env REAL_BANK_USD, default $400 = the future micro-real
 *  size). It is NOT real money — it exists so dry orders rehearse the size dynamics real sizing will
 *  have. Its FREE portion shrinks as dry positions open (like a real free), so large-order fill-rate
 *  is rehearsed against a realistic remaining bank, not a flat constant. */
export function realBankUsd(env: Record<string, string | undefined>): number {
  const n = Number(env.REAL_BANK_USD); return Number.isFinite(n) && n > 0 ? n : 400;
}
export function dryVirtualFreeUsd(db: Database, env: Record<string, string | undefined>): number {
  return Math.max(0, realBankUsd(env) - RR.openDryExposureUsd(db));
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
  // Sizing: the decision's conviction FRACTION (budget-independent — the shadow allocator's
  // intensity), applied to realFreeUsd. Preferred; else paperStake/paperBankUsd.
  sizeFraction?: number;
  paperStakeUsd?: number;
  paperBankUsd?: number;
  realFreeUsd: number;           // real (virtual, in dry) USDC free to scale into
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
  // GATE-FIRST (condition 1): a pure env read, BEFORE any DB read or book fetch. In the prod default
  // (REAL_TRADING=off) this returns instantly with zero cost — autoEnter is the hot path; a no-op must
  // be a no-op in COST, not just effect. (The call-site also skips before building the ctx.)
  if (readTradingMode(ctx.env) === "off") return { mirrored: false, note: "off — no-op" };
  try {
    // Hard sport gate — tennis (or anything non-football) can NEVER reach real this stage.
    if (ctx.sport !== WHITELIST_SPORT) return { mirrored: false, note: `sport ${ctx.sport} не допускается в реал` };
    const mode = effectiveTradingMode(db, ctx.env);
    const caps = modeCaps(mode);
    if (!caps.simulate && !caps.realEntry) return { mirrored: false, note: `режим «${mode}» — реал не строится` };
    const row = matchWhitelist(db, { strategyId: bet.strategy_id, categoryId: ctx.categoryId });
    if (!row) return { mirrored: false, note: "не в whitelist — только paper" }; // expected, high-volume — stays silent
    // Past the whitelist = this entry was INTENDED for the real contour. ANY skip from here is a
    // "wanted to mirror, couldn't" — make it LOUD via onError (a silent skip once hid 280 no-op entries).
    const skip = (note: string) => { try { (ctx.onError ?? (() => {}))(`skip: ${note}`); } catch { /* logger must not throw */ } return { mirrored: false, note }; };
    const size = ctx.sizeFraction != null
      ? realSizeFromFraction(ctx.sizeFraction, ctx.realFreeUsd, row.max_order_usd)
      : proportionalRealSize(ctx.paperStakeUsd ?? bet.stake ?? 0, ctx.paperBankUsd ?? 0, ctx.realFreeUsd, row.max_order_usd);
    if (size <= 0) return skip("реальный размер 0 (доля входа ≤0 / банк)");
    if (!bet.decision_id || !bet.entry_price) return skip("нет decision_id/цены входа (ставка до Phase A?)");

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

// ── the EXIT mirror (condition 3: symmetry — a dry position must also CLOSE) ─────────────────────
// The dublér closes by MIRRORING the paper twin's exit, not by its own exit logic: when a decision's
// paper bet has SETTLED, the dry position it opened is sold at the book bid, same decision_id, leg exit.
// A robust SWEEP (not wired into each of the 5 paper exit triggers) — decoupled, idempotent, and it
// catches every exit path. Without it dry positions would balloon forever-open and the slippage metric
// would only ever see the entry half.
export interface SweepCtx {
  env: Record<string, string | undefined>;
  poly: PolymarketConfig;
  deps: EngineDeps;
  now: () => string;
  bookCache?: Map<string, OrderBookFetch>;
  executorFor?: (mode: ReturnType<typeof effectiveTradingMode>) => Executor | null;
  onError?: (msg: string) => void;
}

/** Close one dry position by mirroring its twin's exit (a dry SELL at the paper closing price). */
async function mirrorDryExit(db: Database, pos: RR.RealPositionRow, decisionId: string, markCents: number, ctx: SweepCtx): Promise<boolean> {
  const mode = effectiveTradingMode(db, ctx.env);
  if (pos.size_shares <= 1e-6 || !(markCents > 0)) return false;
  // A SELL won't accept below its limit, so the limit must sit BELOW the going bid, not at the paper
  // mark (§2.2: sell at bid − tolerance) — else a mark above the live bid never fills. The book-VWAP
  // then fills at the actual (better) bid. Env-tunable.
  const limitCents = Math.max(1, markCents - EXIT_SELL_TOLERANCE_CENTS);
  // The executor derives shares = sizeUsd/(limit/100), so size the notional AT THE LIMIT to sell the
  // EXACT held share count (close the whole position), not a notional-at-avg that leaves a remainder.
  const sizeUsd = Math.round(pos.size_shares * (limitCents / 100) * 100) / 100;
  const order: OrderRequest = {
    clientOrderId: clientOrderIdFor(decisionId, "exit"), leg: "exit", tokenId: pos.token_id, side: "SELL",
    limitPriceCents: limitCents, sizeUsd, timeInForceSec: 15, decisionId,
    strategyId: pos.strategy_id ?? "", profileId: "medium", matchId: pos.match_id ?? "", expiryMode: "client-cancel",
  };
  const executor = ctx.executorFor
    ? ctx.executorFor(mode)
    : modeCaps(mode).simulate
      ? new DryRunExecutor({ db, env: ctx.env, poly: ctx.poly, deps: ctx.deps, bookCache: ctx.bookCache, now: ctx.now, whitelistVersion: RR.currentWhitelistVersion(db) })
      : null;
  if (!executor) return false;
  const ack = await executor.place(order);
  return ack.status === "filled" || ack.status === "partial";
}

/** Sweep: every open DRY position whose paper twin has SETTLED is closed by a mirrored dry sell.
 *  Gate-first (off → nothing). Isolated per position (one failure never stops the sweep or paper). */
export async function sweepDryExits(db: Database, ctx: SweepCtx): Promise<number> {
  if (readTradingMode(ctx.env) === "off") return 0; // hot-path no-op
  let closed = 0, fetched = 0;
  // OOM guard (the incident): each swept position fetches its book, so an unbounded scan × per-tick
  // is the get_fixtures OOM class. Cap the WORK per tick — the rest are swept next tick (the twins are
  // already settled and going nowhere). Env-tunable.
  const MAX = (() => { const n = Number(ctx.env.MAX_DRY_SWEEP); return Number.isFinite(n) && n > 0 ? n : 25; })();
  for (const pos of RR.listRealPositions(db)) {
    if (pos.dry !== 1 || Math.abs(pos.size_shares) < 1e-6) continue;
    if (fetched >= MAX) break; // bound the book fetches this tick
    fetched++;
    try {
      const entry = db.prepare(`SELECT decision_id FROM real_orders WHERE token_id=? AND leg='entry' ORDER BY created_at LIMIT 1`).get(pos.token_id) as { decision_id: string } | undefined;
      if (!entry?.decision_id) continue;
      const bet = db.prepare(`SELECT * FROM bets WHERE decision_id=?`).get(entry.decision_id) as { status: string; closing_price: number | null } | undefined;
      if (!bet || !isSettled(bet.status)) continue; // twin still open → hold the dry position (mirror it later)
      const limit = bet.closing_price ?? pos.avg_price_cents ?? 0;
      if (await mirrorDryExit(db, pos, entry.decision_id, limit, ctx)) closed++;
    } catch (e) {
      try { (ctx.onError ?? (() => {}))(`dry-exit sweep failed for ${pos.token_id} (paper unaffected): ${e instanceof Error ? e.message : String(e)}`); } catch { /* logger must not throw */ }
    }
  }
  return closed;
}
