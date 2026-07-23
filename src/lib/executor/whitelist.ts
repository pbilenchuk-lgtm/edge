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
import { parseEntryMeta } from "../betMeta.js";
import { isMaxProfile } from "../riskProfiles.js";
import { loadSafetyCaps, effectiveTradingMode, modeCaps, readTradingMode } from "./safety.js";
import { DryRunExecutor } from "./dryRun.js";
import { classifyOrderBook } from "./paperFill.js";
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
/** Enable/disable a row — a versioned, journaled change. C5 (audit #M5): a no-such-id UPDATE affects 0
 *  rows → NO version bump, NO journal entry, returns null (a phantom toggle must not lie in the log). */
export function setWhitelistEnabled(db: Database, id: string, enabled: boolean, actor: string, nowIso: string): number | null {
  const version = RR.currentWhitelistVersion(db) + 1;
  const res = db.prepare(`UPDATE real_whitelist SET enabled=?, version=?, updated_at=? WHERE id=?`).run(enabled ? 1 : 0, version, nowIso, id);
  if ((res.changes as number) === 0) return null;
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
    // The super-risky `max` profile (Kelly ×0.50, no calibration floor) is NEVER mirrored to real, on ANY
    // whitelisted strategy — реал запрещён до отдельной ратификации владельца (решение 23.07.2026 b). Belt at
    // the mirror gate; the whitelist itself is per-strategy and has no profile column.
    if (isMaxProfile(bet.risk_profile_id)) return { mirrored: false, note: "max: реал запрещён до ратификации — только paper" };
    const row = matchWhitelist(db, { strategyId: bet.strategy_id, categoryId: ctx.categoryId });
    if (!row) return { mirrored: false, note: "не в whitelist — только paper" }; // expected, high-volume — stays silent
    // Past the whitelist = this entry was INTENDED for the real contour. ANY skip from here is a
    // "wanted to mirror, couldn't" — make it LOUD via onError (a silent skip once hid 280 no-op entries).
    const skip = (note: string) => { try { (ctx.onError ?? (() => {}))(`skip: ${note}`); } catch { /* logger must not throw */ } return { mirrored: false, note }; };
    // B5 (audit #13): size from the paper twin's ACTUAL sized fraction — kellyFraction stored in entry_meta,
    // AFTER every down-scale (calibration, correlation, liquidity). Don't recompute a fresh raw intensity
    // (that ignores the down-scales and over-sizes the "twin"). Fall back to ctx/proportional only if absent.
    const storedFraction = (() => { try { return parseEntryMeta(bet.entry_meta)?.kellyFraction ?? null; } catch { return null; } })();
    const fraction = storedFraction ?? ctx.sizeFraction ?? null;
    const size = fraction != null
      ? realSizeFromFraction(fraction, ctx.realFreeUsd, row.max_order_usd)
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

/** B4: close one dry position by a SELL whose limit sits BELOW the given cents (live bid − tolerance), so
 *  the book VWAP fills at the going bid. seq lets a partial-exit remainder be re-quoted (C2). */
async function mirrorDryExit(db: Database, pos: RR.RealPositionRow, decisionId: string, sellLimitCents: number, ctx: SweepCtx, seq = 0): Promise<"filled" | "partial" | "none"> {
  const mode = effectiveTradingMode(db, ctx.env);
  const limitCents = Math.max(1, Math.round(sellLimitCents));
  if (pos.size_shares <= 1e-6 || !(limitCents > 0)) return "none";
  // Size the notional AT THE LIMIT so shares = sizeUsd/(limit/100) = the exact held count.
  const sizeUsd = Math.round(pos.size_shares * (limitCents / 100) * 100) / 100;
  const order: OrderRequest = {
    clientOrderId: clientOrderIdFor(decisionId, "exit", seq), leg: "exit", tokenId: pos.token_id, side: "SELL",
    limitPriceCents: limitCents, sizeUsd, timeInForceSec: 15, decisionId,
    strategyId: pos.strategy_id ?? "", profileId: pos.profile_id ?? "medium", matchId: pos.match_id ?? "", expiryMode: "client-cancel",
  };
  const executor = ctx.executorFor
    ? ctx.executorFor(mode)
    : modeCaps(mode).simulate
      ? new DryRunExecutor({ db, env: ctx.env, poly: ctx.poly, deps: ctx.deps, bookCache: ctx.bookCache, now: ctx.now, whitelistVersion: RR.currentWhitelistVersion(db) })
      : null;
  if (!executor) return "none";
  const ack = await executor.place(order);
  return ack.status === "filled" ? "filled" : ack.status === "partial" ? "partial" : "none";
}

/** B4: no live book + the twin settled by RESULT → close the dry position at 0/100 (or avg for a void),
 *  crediting a redemption cash line + a realized-P&L memo. Directly flat — no book needed. */
function resolutionCloseDry(db: Database, pos: RR.RealPositionRow, decisionId: string, resolveCents: number, nowIso: string): void {
  const shares = pos.size_shares, avg = pos.avg_price_cents ?? 0;
  const proceeds = Math.round(shares * (resolveCents / 100) * 100) / 100;
  const realizedDelta = Math.round((shares * (resolveCents - avg)) / 100 * 100) / 100;
  if (proceeds > 0.004) RR.insertRealLedger(db, { kind: "redemption", amount_usd: proceeds, token_id: pos.token_id, order_id: null, ref: decisionId, dry: 1, at: nowIso, created_at: nowIso });
  if (Math.abs(realizedDelta) > 0.004) RR.insertRealRealized(db, { decisionId, tokenId: pos.token_id, amountUsd: realizedDelta, dry: 1, at: nowIso });
  RR.upsertRealPosition(db, { token_id: pos.token_id, decision_id: decisionId, profile_id: pos.profile_id ?? null, match_id: pos.match_id, strategy_id: pos.strategy_id, size_shares: 0, avg_price_cents: avg, realized_pnl_usd: Math.round((pos.realized_pnl_usd + realizedDelta) * 100) / 100, unrealized_pnl_usd: null, dry: 1, updated_at: nowIso });
}

/** Sweep: every open DRY position whose paper twin has SETTLED is closed — by a SELL at the live bid, or
 *  (no book) a resolution-close at 0/100. B1: resolves the EXACT twin by the position's own decision_id
 *  (never a token-merged blob). C1: settled twins first (oldest updated_at), only they consume the
 *  book-fetch budget, and truncation is logged. Gate-first; isolated per position. */
export async function sweepDryExits(db: Database, ctx: SweepCtx): Promise<number> {
  if (readTradingMode(ctx.env) === "off") return 0; // hot-path no-op
  const nowIso = ctx.now();
  let closed = 0, worked = 0, truncated = 0;
  const MAX = (() => { const n = Number(ctx.env.MAX_DRY_SWEEP); return Number.isFinite(n) && n > 0 ? n : 25; })();
  // C1: oldest-first — settled twins (untouched since open) sort ahead of freshly-opened positions, so
  // the ones that NEED closing aren't starved by new ones once there are > MAX live dry positions.
  const positions = RR.listRealPositions(db)
    .filter((p) => p.dry === 1 && p.legacy !== 1 && Math.abs(p.size_shares) > 1e-6 && p.decision_id)
    .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0));
  for (const pos of positions) {
    try {
      const decisionId = pos.decision_id!;
      const bet = db.prepare(`SELECT status FROM bets WHERE decision_id=?`).get(decisionId) as { status: string } | undefined;
      if (!bet) { // C4 (audit #19): the twin vanished (deleted / re-settled) — a dry position with no twin
        // would silently never close. Make it LOUD instead of a silent continue.
        try { (ctx.onError ?? (() => {}))(`orphan dry position ${pos.token_id} (decision ${decisionId}): бумажный близнец пропал — не свипается, нужен ручной разбор`); } catch { /* logger must not throw */ }
        continue;
      }
      if (!isSettled(bet.status)) continue; // twin open → hold (does NOT consume the budget)
      if (worked >= MAX) { truncated++; continue; } // only settled twins that reach the fetch count
      worked++;
      // C2 (audit #15): seq = exit orders already placed for this decision, so a partial's residual
      // re-quotes as a NEW order (the one sanctioned second-order-on-a-leg case) instead of hitting the
      // idempotency guard and stranding the remainder forever.
      const seq = (db.prepare(`SELECT COUNT(*) AS n FROM real_orders WHERE decision_id=? AND leg='exit'`).get(decisionId) as { n: number }).n;
      // B4: exit from the LIVE bid; fall back to resolution-close when the book is gone.
      const bookRes = await classifyOrderBook(pos.token_id, ctx.poly, ctx.deps, ctx.bookCache);
      const bestBid = bookRes.status === "ok" ? bookRes.book.bids.reduce((m, b) => Math.max(m, b.priceCents), 0) : 0;
      if (bestBid > 0) {
        const r = await mirrorDryExit(db, pos, decisionId, bestBid - EXIT_SELL_TOLERANCE_CENTS, ctx, seq);
        if (r !== "none") closed++;
      } else {
        const resolveCents = bet.status === "settled_won" ? 100 : bet.status === "settled_lost" ? 0 : (pos.avg_price_cents ?? 0);
        resolutionCloseDry(db, pos, decisionId, resolveCents, nowIso);
        closed++;
      }
    } catch (e) {
      try { (ctx.onError ?? (() => {}))(`dry-exit sweep failed for ${pos.token_id} (paper unaffected): ${e instanceof Error ? e.message : String(e)}`); } catch { /* logger must not throw */ }
    }
  }
  if (truncated > 0) { try { (ctx.onError ?? (() => {}))(`dry-exit sweep: обрезано ${truncated} settled-позиций на кэпе ${MAX}/тик — добьём в следующий тик`); } catch { /* logger must not throw */ } }
  return closed;
}
