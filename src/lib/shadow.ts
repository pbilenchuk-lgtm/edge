// ============================================================
// EDGE LAB — SHADOW capital allocator (Окно «Бюджет (shadow)»)  [SERVER-ONLY]
//
// A PARALLEL, observe-only layer that models how ONE shared limited bank (~$5000)
// would have lived — competing for capital across categories / matches / strategies —
// WITHOUT touching the real isolated per-pair budgets or any money path. It runs off
// the SAME execution points as real fills/closes (single-source hooks), never blocks a
// real operation, and is 100% deterministic (zero LLM). Its whole job: answer «how
// often and where would capital have been the bottleneck» before going to real money.
//
// Pool: bank_total; reserved (open positions); settling (closed, freeing after a lag,
// modelling Polymarket resolution); free = bank − reserved − settling. A live_buffer is
// held back for LIVE-triggered entries only (prematch can't spend it); a cash_reserve is
// an inviolable floor. Per-category / per-strategy / per-match ceilings cap concentration.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

export interface ShadowConfig {
  enabled: boolean;
  bankTotal: number;        // $ total shadow bank
  liveBufferPct: number;    // 0..1 — held back for live-triggered entries only
  settlementLagMin: number; // minutes a closed reserve sits in `settling` before freeing
  capCategoryPct: number;   // 0..1 — max reserves on one category (competition)
  capStrategyPct: number;   // 0..1 — max on one strategy
  capMatchPct: number;      // 0..1 — max on one match
  cashReservePct: number;   // 0..1 — never-spend floor
}

export const SHADOW_DEFAULTS: ShadowConfig = {
  enabled: true, bankTotal: 5000, liveBufferPct: 0.25, settlementLagMin: 45,
  capCategoryPct: 0.40, capStrategyPct: 0.40, capMatchPct: 0.20, cashReservePct: 0.10,
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const numOr = (v: string | undefined | null, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** Config precedence: hardcoded defaults → env (deploy default) → app_meta (user settings,
 *  edited in the tab). User settings win, applied from the change forward (no history recompute). */
export function loadShadowConfig(db: Database, env: Record<string, string | undefined> = process.env): ShadowConfig {
  const cfg: ShadowConfig = { ...SHADOW_DEFAULTS };
  if (env.SHADOW_ENABLED != null) cfg.enabled = env.SHADOW_ENABLED.toLowerCase() === "true";
  cfg.bankTotal = numOr(env.SHADOW_BANK_TOTAL, cfg.bankTotal);
  cfg.liveBufferPct = numOr(env.SHADOW_LIVE_BUFFER_PCT, cfg.liveBufferPct);
  cfg.settlementLagMin = numOr(env.SHADOW_SETTLEMENT_LAG_MIN, cfg.settlementLagMin);
  cfg.capCategoryPct = numOr(env.SHADOW_CAP_CATEGORY_PCT, cfg.capCategoryPct);
  cfg.capStrategyPct = numOr(env.SHADOW_CAP_STRATEGY_PCT, cfg.capStrategyPct);
  cfg.capMatchPct = numOr(env.SHADOW_CAP_MATCH_PCT, cfg.capMatchPct);
  cfg.cashReservePct = numOr(env.SHADOW_CASH_RESERVE_PCT, cfg.cashReservePct);
  try {
    const raw = R.metaGet(db, "shadow_config");
    if (raw) Object.assign(cfg, JSON.parse(raw));
  } catch { /* bad JSON → keep env/defaults */ }
  return cfg;
}

export function saveShadowConfig(db: Database, patch: Partial<ShadowConfig>, nowIso: string): ShadowConfig {
  const cur = loadShadowConfig(db);
  const next: ShadowConfig = { ...cur, ...patch };
  R.metaSet(db, "shadow_config", JSON.stringify(next), nowIso);
  return next;
}

export interface ShadowBucket { used: number; cap: number }
export interface ShadowPoolState {
  bank: number; reserved: number; settling: number; free: number;
  liveBufferTotal: number; liveBufferUsed: number; liveBufferFree: number; cashFloor: number;
  byCategory: Record<string, ShadowBucket>;
  byStrategy: Record<string, ShadowBucket>;
  byMatch: Record<string, ShadowBucket>;
}

/** Free elapsed `settling` reserves (lazy sweep by settle_at). Call before any read/eval. */
export function sweepSettled(db: Database, nowIso: string): number {
  try { return R.releaseSettledShadow(db, nowIso); } catch { return 0; }
}

/** Current pool state, derived from the live reserve rows (after sweeping settled). */
export function shadowPoolState(db: Database, cfg: ShadowConfig, nowIso: string): ShadowPoolState {
  sweepSettled(db, nowIso);
  const rows = R.allShadowReserves(db);
  const bank = cfg.bankTotal;
  let reserved = 0, settling = 0, liveUsed = 0;
  const byCategory: Record<string, ShadowBucket> = {};
  const byStrategy: Record<string, ShadowBucket> = {};
  const byMatch: Record<string, ShadowBucket> = {};
  const bump = (map: Record<string, ShadowBucket>, key: string, size: number, cap: number) => {
    (map[key] ??= { used: 0, cap }).used = round2(map[key].used + size);
  };
  for (const r of rows) {
    if (r.state === "settling") settling += r.size; else reserved += r.size;
    if (r.is_live) liveUsed += r.size;
    bump(byCategory, r.competition_id, r.size, round2(cfg.capCategoryPct * bank));
    bump(byStrategy, r.strategy_id, r.size, round2(cfg.capStrategyPct * bank));
    bump(byMatch, r.match_id, r.size, round2(cfg.capMatchPct * bank));
  }
  reserved = round2(reserved); settling = round2(settling);
  const liveBufferTotal = round2(cfg.liveBufferPct * bank);
  const liveBufferUsed = round2(Math.min(liveUsed, liveBufferTotal));
  const liveBufferFree = round2(Math.max(0, liveBufferTotal - liveUsed));
  return {
    bank, reserved, settling, free: round2(bank - reserved - settling),
    liveBufferTotal, liveBufferUsed, liveBufferFree, cashFloor: round2(cfg.cashReservePct * bank),
    byCategory, byStrategy, byMatch,
  };
}

export interface ShadowEntryRequest {
  betId: string; matchId: string; competitionId: string; strategyId: string;
  profileId: string; size: number; edge: number; isLive: boolean;
}
export type ShadowVerdict = "allowed" | "blocked" | "trimmed";

// Running pool usage while evaluating a batch/timeline. `used` sums BOTH reserved and
// settling (both hold capital until settling frees), so free = bank − used.
interface PoolTotals { used: number; liveUsed: number; cat: Record<string, number>; strat: Record<string, number>; match: Record<string, number>; }
interface EntryReq { size: number; edge: number; isLive: boolean; competitionId: string; strategyId: string; matchId: string; }
const emptyTotals = (): PoolTotals => ({ used: 0, liveUsed: 0, cat: {}, strat: {}, match: {} });

/** THE single-source allocation decision for one entry against a running pool — used by
 *  BOTH the live evaluator and the offline replay so they can never drift. Mutates `t`
 *  when capital is reserved. Prematch keeps the live buffer; live may spend it; the
 *  cash floor is inviolable; per-match/category/strategy ceilings cap concentration. */
function decideEntry(t: PoolTotals, req: EntryReq, cfg: ShadowConfig): { verdict: ShadowVerdict; reserved: number; reason: string | null; freeAt: number; liveBufferFree: number } {
  const bank = cfg.bankTotal, size = round2(req.size);
  const freeGeneral = bank - t.used;
  const liveBufferFree = Math.max(0, cfg.liveBufferPct * bank - t.liveUsed);
  const cashFloor = cfg.cashReservePct * bank;
  const rooms: { room: number; reason: string }[] = [
    { room: freeGeneral - cashFloor, reason: freeGeneral <= 0.01 ? "insufficient_free" : "cash_reserve" },
    { room: cfg.capMatchPct * bank - (t.match[req.matchId] ?? 0), reason: "cap_match" },
    { room: cfg.capCategoryPct * bank - (t.cat[req.competitionId] ?? 0), reason: "cap_category" },
    { room: cfg.capStrategyPct * bank - (t.strat[req.strategyId] ?? 0), reason: "cap_strategy" },
  ];
  if (!req.isLive) rooms.push({ room: freeGeneral - cashFloor - liveBufferFree, reason: "live_buffer" });
  let binding = rooms[0];
  for (const r of rooms) if (r.room < binding.room) binding = r;
  const minRoom = round2(binding.room);
  let verdict: ShadowVerdict, reserved: number, reason: string | null;
  if (minRoom <= 0.01) { verdict = "blocked"; reserved = 0; reason = binding.reason; }
  else if (minRoom < size) { verdict = "trimmed"; reserved = minRoom; reason = binding.reason; }
  else { verdict = "allowed"; reserved = size; reason = null; }
  if (reserved > 0) {
    t.used += reserved; if (req.isLive) t.liveUsed += reserved;
    t.cat[req.competitionId] = (t.cat[req.competitionId] ?? 0) + reserved;
    t.strat[req.strategyId] = (t.strat[req.strategyId] ?? 0) + reserved;
    t.match[req.matchId] = (t.match[req.matchId] ?? 0) + reserved;
  }
  return { verdict, reserved, reason, freeAt: round2(freeGeneral), liveBufferFree: round2(liveBufferFree) };
}

/** Evaluate a BATCH of real fills against the shared pool, as if they'd all asked for
 *  money this tick. Higher-edge entries win first (deterministic sort). Each records one
 *  shadow_event (allowed / blocked / trimmed + reason) and, when funded, reserves capital.
 *  Best-effort: any throw is swallowed by the caller — shadow never breaks the real flow. */
export function shadowOnEntries(db: Database, requests: ShadowEntryRequest[], cfg: ShadowConfig, nowIso: string): void {
  if (!cfg.enabled || !requests.length) return;
  sweepSettled(db, nowIso);
  const bank = cfg.bankTotal;
  // running totals, seeded from existing reserves so a live add stacks on prior cycles
  const t = emptyTotals();
  for (const r of R.allShadowReserves(db)) {
    t.used += r.size; if (r.is_live) t.liveUsed += r.size;
    t.cat[r.competition_id] = (t.cat[r.competition_id] ?? 0) + r.size;
    t.strat[r.strategy_id] = (t.strat[r.strategy_id] ?? 0) + r.size;
    t.match[r.match_id] = (t.match[r.match_id] ?? 0) + r.size;
  }
  // Edge-priority: the pool funds the strongest first; ties broken by betId for determinism.
  const ordered = [...requests].sort((a, b) => (b.edge - a.edge) || (a.betId < b.betId ? -1 : 1));
  let poolShort = false; // contention = >1 entry competed AND ≥1 was pool-limited this tick
  const decisions: { req: ShadowEntryRequest; verdict: ShadowVerdict; reserved: number; reason: string | null; freeAt: number; snap: string }[] = [];
  for (const req of ordered) {
    const d = decideEntry(t, req, cfg);
    if (d.verdict !== "allowed" && d.reason && isPoolReason(d.reason)) poolShort = true;
    if (d.reserved > 0) {
      try {
        R.insertShadowReserve(db, {
          id: R.uid(), bet_id: req.betId, match_id: req.matchId, competition_id: req.competitionId,
          strategy_id: req.strategyId, profile_id: req.profileId, size: d.reserved, is_live: req.isLive ? 1 : 0,
          edge: req.edge, state: "reserved", settle_at: null, created_at: nowIso,
        });
      } catch { /* best-effort */ }
    }
    const snap = JSON.stringify({ bank, reserved: round2(bank - d.freeAt), settling: 0, free: d.freeAt, liveBufferFree: d.liveBufferFree });
    decisions.push({ req, verdict: d.verdict, reserved: d.reserved, reason: d.reason, freeAt: d.freeAt, snap });
  }
  const contended = requests.length > 1 && poolShort;
  // Snapshot the config IN EFFECT so a decision stays attributable to the caps/floors that
  // produced it, even after the user later changes settings (cheap now, irrecoverable later).
  const configSnap = JSON.stringify(cfg);
  for (const d of decisions) {
    try {
      R.insertShadowEvent(db, {
        id: R.uid(), bet_id: d.req.betId, match_id: d.req.matchId, competition_id: d.req.competitionId,
        strategy_id: d.req.strategyId, profile_id: d.req.profileId, size_requested: round2(d.req.size),
        size_reserved: d.reserved, verdict: d.verdict, reason: d.reason, is_live: d.req.isLive ? 1 : 0,
        edge: d.req.edge, contention: contended ? 1 : 0, free_at: d.freeAt, pool_snapshot: d.snap,
        config_snapshot: configSnap, created_at: nowIso,
      });
    } catch { /* best-effort */ }
  }
}

function isPoolReason(r: string): boolean {
  return r === "insufficient_free" || r === "cash_reserve" || r === "live_buffer";
}

/** A real close (full or partial) moves the matching shadow reserve into `settling`, where
 *  it returns to `free` only after settlement_lag_min — modelling Polymarket resolution. */
export function shadowOnExit(db: Database, betId: string, fraction: number, cfg: ShadowConfig, nowIso: string): void {
  if (!cfg.enabled) return;
  const res = R.shadowReservedForBet(db, betId);
  if (!res) return; // this bet was blocked (never reserved) → nothing to release
  const settleAt = new Date((Date.parse(nowIso) || Date.now()) + cfg.settlementLagMin * 60_000).toISOString();
  const f = Math.min(Math.max(fraction, 0), 1);
  if (f >= 1) { // full close → the whole remaining reserve settles
    R.updateShadowReserve(db, res.id, { state: "settling", settle_at: settleAt });
    return;
  }
  const move = round2(res.size * f);
  if (move <= 0) return;
  R.updateShadowReserve(db, res.id, { size: round2(res.size - move) });
  try {
    R.insertShadowReserve(db, {
      id: R.uid(), bet_id: res.bet_id, match_id: res.match_id, competition_id: res.competition_id,
      strategy_id: res.strategy_id, profile_id: res.profile_id, size: move, is_live: res.is_live,
      edge: res.edge, state: "settling", settle_at: settleAt, created_at: nowIso,
    });
  } catch { /* best-effort */ }
}

export interface ShadowAnalytics {
  total: number; allowed: number; blocked: number; trimmed: number;
  blockedPct: number; trimmedPct: number;
  byReason: Record<string, number>;
  /** realised P&L of the entries the pool would have blocked/trimmed — the direct cost of
   *  the capital deficit (those bets DID execute in the real isolated sim, so their outcome
   *  is known). Blocked = full P&L; trimmed = the un-funded fraction's P&L. */
  missedPnl: number;
  contentionEvents: number;
  utilization: { t: string; free: number; reserved: number }[];
}

export function shadowAnalytics(db: Database, cfg: ShadowConfig): ShadowAnalytics {
  const events = R.allShadowEvents(db);
  const total = events.length;
  let allowed = 0, blocked = 0, trimmed = 0, missedPnl = 0, contentionEvents = 0;
  const byReason: Record<string, number> = {};
  for (const e of events) {
    if (e.verdict === "allowed") allowed++;
    else if (e.verdict === "blocked") blocked++;
    else trimmed++;
    if (e.verdict !== "allowed" && e.reason) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
    if (e.contention) contentionEvents++;
    // Missed P&L: look up the real bet (it executed in the isolated sim) and attribute the
    // un-funded fraction's realised P&L to the deficit.
    if (e.verdict !== "allowed" && e.bet_id) {
      const bet = R.getBet(db, e.bet_id);
      if (bet && bet.payout != null && bet.stake != null && (bet.status === "settled_won" || bet.status === "settled_lost")) {
        const realPnl = bet.payout - bet.stake;
        const unfundedFrac = e.size_requested > 0 ? (e.size_requested - e.size_reserved) / e.size_requested : 0;
        missedPnl += realPnl * unfundedFrac;
      }
    }
  }
  // Utilization series: chronological free/reserved snapshots from the event ledger.
  const utilization = events
    .slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .filter((e) => e.pool_snapshot)
    .map((e) => { try { const s = JSON.parse(e.pool_snapshot as string); return { t: e.created_at, free: Number(s.free) || 0, reserved: Number(s.reserved) || 0 }; } catch { return null; } })
    .filter((x): x is { t: string; free: number; reserved: number } => !!x)
    .slice(-200);
  return {
    total, allowed, blocked, trimmed,
    blockedPct: total ? round2((blocked / total) * 100) : 0,
    trimmedPct: total ? round2((trimmed / total) * 100) : 0,
    byReason, missedPnl: round2(missedPnl), contentionEvents, utilization,
  };
}

export interface ReplayEntry {
  at: string; size: number; edge: number; isLive: boolean;
  matchId: string; competitionId: string; strategyId: string;
  exitAt: string | null; realPnl: number | null;
}
export interface ReplaySummary {
  total: number; allowed: number; blocked: number; trimmed: number;
  blockedPct: number; trimmedPct: number; byReason: Record<string, number>;
  missedPnl: number; peakUtilPct: number;
}

/** Reconstruct the historical entry stream from the ledger + the real bets — entry time
 *  from the event, exit time + realised P&L from the bet. Raw material for offline replay. */
export function buildReplayEntries(db: Database): ReplayEntry[] {
  return R.allShadowEvents(db).map((e) => {
    const bet = e.bet_id ? R.getBet(db, e.bet_id) : null;
    const settled = !!bet && (bet.status === "settled_won" || bet.status === "settled_lost");
    return {
      at: e.created_at, size: e.size_requested, edge: e.edge, isLive: !!e.is_live,
      matchId: e.match_id, competitionId: e.competition_id, strategyId: e.strategy_id,
      exitAt: settled ? (bet!.settled_at ?? null) : null,
      realPnl: settled && bet!.payout != null && bet!.stake != null ? bet!.payout - bet!.stake : null,
    };
  });
}

/** Deterministically REPLAY the recorded entry stream under a CANDIDATE config — without
 *  touching stored history. Reconstructs the reserve→settling→free timeline (entries batch
 *  by identical timestamp, edge-priority via the SAME decideEntry the live path uses; a
 *  close frees its reserve after the candidate's lag) and reports the resulting deficit.
 *  This is the calibration tool — «what if the bank were $3000 / the buffer 15%?». */
export function shadowReplay(entries: ReplayEntry[], cfg: ShadowConfig): ReplaySummary {
  const lagMs = cfg.settlementLagMin * 60_000;
  const t = emptyTotals();
  const reservedOf = new Map<ReplayEntry, number>();
  const freeEvents: { ms: number; e: ReplayEntry }[] = [];
  const s: ReplaySummary = { total: 0, allowed: 0, blocked: 0, trimmed: 0, blockedPct: 0, trimmedPct: 0, byReason: {}, missedPnl: 0, peakUtilPct: 0 };
  // Group ENTERs by identical timestamp so a same-cycle batch competes together (edge-priority).
  const byTime = new Map<number, ReplayEntry[]>();
  for (const e of entries) { const ms = Date.parse(e.at) || 0; const a = byTime.get(ms) ?? []; a.push(e); byTime.set(ms, a); }
  const sweep = (upto: number) => {
    for (let i = freeEvents.length - 1; i >= 0; i--) if (freeEvents[i].ms <= upto) {
      const e = freeEvents[i].e, r = reservedOf.get(e) ?? 0;
      if (r > 0) { t.used -= r; if (e.isLive) t.liveUsed -= r; t.cat[e.competitionId] -= r; t.strat[e.strategyId] -= r; t.match[e.matchId] -= r; }
      freeEvents.splice(i, 1);
    }
  };
  for (const ms of [...byTime.keys()].sort((a, b) => a - b)) {
    sweep(ms); // release reserves whose (exit + lag) has elapsed by this batch's time
    for (const e of byTime.get(ms)!.slice().sort((a, b) => (b.edge - a.edge) || (a.at < b.at ? -1 : 1))) {
      const d = decideEntry(t, e, cfg);
      s.total++;
      if (d.verdict === "allowed") s.allowed++; else if (d.verdict === "blocked") s.blocked++; else s.trimmed++;
      if (d.verdict !== "allowed" && d.reason) s.byReason[d.reason] = (s.byReason[d.reason] ?? 0) + 1;
      const unfunded = e.size > 0 ? (e.size - d.reserved) / e.size : 0;
      if (unfunded > 0 && e.realPnl != null) s.missedPnl += e.realPnl * unfunded;
      s.peakUtilPct = Math.max(s.peakUtilPct, cfg.bankTotal > 0 ? (t.used / cfg.bankTotal) * 100 : 0);
      if (d.reserved > 0) { reservedOf.set(e, d.reserved); if (e.exitAt) freeEvents.push({ ms: (Date.parse(e.exitAt) || ms) + lagMs, e }); }
    }
  }
  s.blockedPct = s.total ? round2((s.blocked / s.total) * 100) : 0;
  s.trimmedPct = s.total ? round2((s.trimmed / s.total) * 100) : 0;
  s.missedPnl = round2(s.missedPnl); s.peakUtilPct = round2(s.peakUtilPct);
  return s;
}
