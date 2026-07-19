// ============================================================
// EDGE LAB — OUR REAL BETTING BUDGET. Not the per-strategy simulation budgets
// (those are isolated, only to measure how each strategy performs — that lives on
// the Metrics tab). This is the ONE real bank we bet with: $5000 (the shadow
// allocator's bankTotal) and what happens to it — balance, invested, earned,
// lost, and what's in-progress right now.
//
// Every position's money is scaled to what the BANK committed to it (the
// allocator's size_reserved), NOT the isolated sim stake — so the totals are the
// real $5000's story, not a sum of simulation budgets. Read-only.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { loadShadowConfig, shadowPoolState } from "./shadow.js";
import { summarizeFillCosts } from "./fillCosts.js";

export interface BudgetPosition {
  bank: number;            // the real betting bank ($5000)
  balance: number;         // bank + realised P&L — the bank's current worth
  equity: number;          // balance + unrealised (mark-to-market total worth right now)
  free: number;            // available to deploy now
  invested: number;        // bank capital committed to OPEN positions
  settling: number;        // committed capital of CLOSED positions still in the resolve lag
  // Realised — decided money (bank-scaled).
  earned: number; lostMoney: number; netRealized: number;
  settled: number; won: number; lost: number;
  // In-progress — open positions, marked to the freshest quote (bank-scaled).
  openCount: number; openMarkValue: number; openPnl: number;
  openPlus: number; openPlusPnl: number; openMinus: number; openMinusPnl: number;
  // Execution drag on the bank (fees + slippage), scaled to the bank's commitment.
  fees: number; slippage: number; costTotal: number;
  // Bank equity over settle time: base ($5000) → balance, cumulative bank-scaled realised P&L by day.
  curve: { points: { at: string; equity: number }[]; base: number; current: number; realized: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function budgetPosition(db: Database, nowIso?: string): BudgetPosition {
  const cfg = loadShadowConfig(db);
  const bank = cfg.bankTotal;
  const pool = shadowPoolState(db, cfg, nowIso ?? new Date().toISOString());

  // How much the BANK committed to each funded bet (allocator reserve at entry).
  const committedByBet = new Map<string, number>();
  for (const e of R.allShadowEvents(db)) {
    if (e.bet_id && e.size_reserved > 0) committedByBet.set(e.bet_id, (committedByBet.get(e.bet_id) ?? 0) + e.size_reserved);
  }

  // A position may be partially fixed: closeBetPortion books each closed slice as a NEW
  // child bet (settled_by='partial', fresh id — NO shadow_event) and shrinks the parent's
  // stake in place. So the bank's realised P&L must (a) scale by the ORIGINAL stake
  // (remainder + all closed slices), not the shrunken remainder, and (b) include the child
  // slices' P&L. We attribute each slice its share of the bank commitment: for a position
  // with original stake S0 and commitment C, a slice of stake s and payout p returns
  // (C/S0)·(p − s). Group children to their parent by (match·strategy·profile·market);
  // if that key has >1 funded parent (a re-entry), don't attach children — fall back to
  // parent-only (bounded, rare) rather than double-count across parents.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const posKey = (b: { match_id: string; strategy_id: string; risk_profile_id?: string | null; market_label: string }) =>
    `${b.match_id}::${b.strategy_id}::${b.risk_profile_id ?? "medium"}::${norm(b.market_label)}`;
  const betsCache = new Map<string, ReturnType<typeof R.betsForMatch>>();
  const matchBets = (matchId: string) => { let a = betsCache.get(matchId); if (!a) { a = R.betsForMatch(db, matchId); betsCache.set(matchId, a); } return a; };
  const parentBet = new Map<string, ReturnType<typeof R.getBet>>();
  const parentsByKey = new Map<string, number>();
  for (const betId of committedByBet.keys()) {
    const b = R.getBet(db, betId); if (!b) continue;
    parentBet.set(betId, b); parentsByKey.set(posKey(b), (parentsByKey.get(posKey(b)) ?? 0) + 1);
  }

  // Realised P&L of the bank, per funded position, summed across its settled slices.
  let earned = 0, lostMoney = 0, settled = 0, won = 0, lost = 0;
  const timed: { at: string; pnl: number }[] = []; let untimedPnl = 0; // bank-scaled realised, for the equity curve
  const ratioByBet = new Map<string, number>(); // committed / original stake — reused for cost scaling
  for (const [betId, committed] of committedByBet) {
    const b = parentBet.get(betId);
    if (!b) continue;
    const key = posKey(b);
    const children = parentsByKey.get(key) === 1
      ? matchBets(b.match_id).filter((c) => c.settled_by === "partial" && c.id !== b.id && posKey(c) === key)
      : [];
    const childStake = children.reduce((s, c) => s + (c.stake ?? 0), 0);
    const s0 = (b.stake ?? 0) + childStake;                 // original stake = open/settled remainder + closed slices
    const r = s0 > 0 ? committed / s0 : 0;                  // bank commitment per $ of original stake
    ratioByBet.set(betId, r);
    const parentSettled = R.isSettled(b.status);
    const slices = parentSettled ? [...children, b] : children; // an OPEN remainder is unrealised (counted via reserves)
    for (const s of slices) {
      const pnl = r * ((s.payout ?? 0) - (s.stake ?? 0));
      if (pnl >= 0) earned += pnl; else lostMoney += -pnl;
      const at = s.settled_at ?? null; // same bank-scaled pnl, placed on its settle day for the curve
      if (at && /^\d{4}-\d\d-\d\dT/.test(at)) timed.push({ at, pnl }); else untimedPnl += pnl;
    }
    if (parentSettled && b.settled_by == null) { settled++; if (b.result === "won") won++; else lost++; }
  }

  // In-progress: the bank's OPEN reserves, marked to the freshest quote per market.
  const priceCache = new Map<string, Record<string, number>>();
  const priceFor = (matchId: string, label: string): number | null => {
    let p = priceCache.get(matchId);
    if (!p) { p = {}; for (const mk of R.latestMarkets(db, matchId)) if (mk.price != null) p[mk.label] = mk.price; priceCache.set(matchId, p); }
    return p[label] ?? null;
  };
  let openCount = 0, invested = 0, openMarkValue = 0, openPnl = 0;
  let openPlus = 0, openPlusPnl = 0, openMinus = 0, openMinusPnl = 0;
  for (const rsv of R.allShadowReserves(db)) {
    if (rsv.state !== "reserved") continue;
    const b = rsv.bet_id ? R.getBet(db, rsv.bet_id) : null;
    if (!b || b.status !== "open") continue;
    const entry = b.entry_price ?? 0;
    const cur = priceFor(b.match_id, b.market_label) ?? b.current_price ?? entry;
    const mark = entry > 0 ? rsv.size * (cur / entry) : rsv.size; // bank commitment marked to market
    const pnl = mark - rsv.size;
    openCount++; invested += rsv.size; openMarkValue += mark; openPnl += pnl;
    if (pnl >= 0) { openPlus++; openPlusPnl += pnl; } else { openMinus++; openMinusPnl += pnl; }
  }

  // Execution costs scaled to the bank's commitment. The fill ledger is at sim-stake
  // notional; the bank's share is committed/ORIGINAL-stake (ratioByBet), constant per
  // position — NOT committed/current-stake, which inflates after a partial fixation
  // shrinks the parent's stake while the fills stay booked under it.
  const scaledCosts = R.allFillCosts(db).map((f) => {
    const scale = f.bet_id ? Math.min(4, ratioByBet.get(f.bet_id) ?? 0) : 0;
    return { ...f, fee_usd: f.fee_usd * scale, slip_usd: f.slip_usd * scale, notional_usd: f.notional_usd * scale };
  });
  const fc = summarizeFillCosts(scaledCosts as R.FillCostRow[]);

  const netRealized = earned - lostMoney;
  // Free = the bank's current worth (bank + realised P&L) minus what's tied up in open
  // positions and still-settling capital. Money-consistent: with nothing invested, free
  // equals the balance — realised winnings ARE available (unlike pool.free, which is off
  // the fixed bank base and used only for the allocator's caps/live-buffer mechanics).
  const balance = bank + netRealized;
  const free = Math.max(0, balance - invested - pool.settling);

  // Bank equity curve: fold any realised-without-timestamp into the start, then walk the timed slices by
  // settle day. Ends at `balance` (bank + netRealized) by construction. Dashed reference sits at `bank`.
  const curveStart = r2(bank + untimedPnl);
  timed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const byDay = new Map<string, number>();
  let eq = curveStart;
  for (const t of timed) { eq = r2(eq + t.pnl); byDay.set(t.at.slice(0, 10), eq); }
  const curve = { points: [{ at: "старт", equity: curveStart }, ...[...byDay.entries()].map(([at, equity]) => ({ at, equity }))], base: r2(bank), current: r2(balance), realized: r2(netRealized) };

  return {
    bank: r2(bank), balance: r2(balance), equity: r2(balance + openPnl),
    free: r2(free), invested: r2(invested), settling: r2(pool.settling),
    earned: r2(earned), lostMoney: r2(lostMoney), netRealized: r2(netRealized),
    settled, won, lost,
    openCount, openMarkValue: r2(openMarkValue), openPnl: r2(openPnl),
    openPlus, openPlusPnl: r2(openPlusPnl), openMinus, openMinusPnl: r2(openMinusPnl),
    fees: fc.feeUsd, slippage: fc.slipUsd, costTotal: fc.totalUsd,
    curve,
  };
}
