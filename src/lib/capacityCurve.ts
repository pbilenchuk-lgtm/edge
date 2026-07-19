// ============================================================
// EDGE LAB — BANKROLL CAPACITY CURVE  [SERVER-ONLY, read-only]
//
// «Если банк был бы $20k/$50k/$100k/$200k вместо $5k — какой % дохода, с учётом стакана?» Доход НЕ
// масштабируется линейно: больший размер вгрызается глубже в книгу → хуже VWAP входа → ниже %. This
// re-prices every settled bet at each bankroll multiple through the SAME parametric slippage the sim
// fills with (vwap = quote + c·size), and reports net P&L + return% per bankroll.
//
// FIDELITY — this is a MODEL, not a replay against real books (we don't store book levels):
//   • ANCHORED on REALISED slippage where a buy fill_cost exists: c = slip_cents / notional ($→¢). The
//     bet's OWN measured slippage is extrapolated linearly — not declared (Gamma) liquidity, which
//     overstates depth. Bets with no measured slip get the MEDIAN anchored c (labelled `fallback`).
//   • ENTRY slippage only — exit degradation is NOT modelled, so large-size returns are, if anything,
//     OPTIMISTIC.
//   • Assumes size scales linearly with bankroll (ignores Kelly/cap non-linearity) and that WE are a
//     price-taker (our size doesn't change the outcome) — both weaken far above observed sizes.
// The base column (×1) reproduces realised P&L by construction — the curve starts at reality and decays.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { loadPolymarketConfig } from "./polymarket.js";

const DEFAULT_BANKS = [5000, 20000, 50000, 100000, 200000];

export interface CapacityRow { bank: number; mult: number; netPnl: number; returnPct: number | null; avgEntryCents: number | null }
export interface CapacityCurve {
  base: number; banks: number[];
  rows: CapacityRow[];
  betsModeled: number; anchored: number; fallback: number; voidSkipped: number; medianSlipPer1k: number | null;
  caveats: string[];
  note: string;
}

const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function buildCapacityCurve(db: Database, env: Record<string, string | undefined> = process.env, banks: number[] = DEFAULT_BANKS): CapacityCurve {
  const cfg = loadPolymarketConfig(env);
  const feeRate = cfg.exec.takerFeeRate;
  const base = banks[0];

  // Per-bet buy slippage coefficient c (¢ of vwap per $ of size), anchored on the realised buy fill(s):
  //   vwap − quote = c · notional  →  c = Σ slip_cents / Σ notional  (notional-weighted).
  const buyAgg = new Map<string, { slip: number; notional: number }>();
  for (const f of R.allFillCosts(db)) {
    if (f.side !== "buy" || !f.bet_id) continue;
    const e = buyAgg.get(f.bet_id) ?? { slip: 0, notional: 0 };
    e.slip += (f.slip_cents ?? 0); e.notional += (f.notional_usd ?? 0);
    buyAgg.set(f.bet_id, e);
  }
  const cByBet = new Map<string, number>();
  const anchoredCs: number[] = [];
  for (const [betId, e] of buyAgg) { if (e.notional > 0) { const c = e.slip / e.notional; if (c > 0) { cByBet.set(betId, c); anchoredCs.push(c); } } }
  const cMed = median(anchoredCs) ?? 0; // fallback coefficient for bets with no measured slip

  const settled = R.allBets(db).filter((b) => (b.status === "settled_won" || b.status === "settled_lost") && b.entry_price != null && b.stake != null && (b.stake ?? 0) > 0);
  let anchored = 0, fallbackN = 0;
  const modeled = settled.map((b) => {
    const s0 = b.stake as number, entry = b.entry_price as number, won = b.result === "won";
    const anchoredC = cByBet.get(b.id);
    const c = anchoredC != null ? (anchored++, anchoredC) : (fallbackN++, cMed);
    const quote = Math.max(1, entry - c * s0); // implied top-of-book: at ×1, vwap = entry (reproduces reality)
    return { s0, quote, c, won };
  });
  const voidSkipped = R.allBets(db).filter((b) => b.status === "settled_void").length;

  const rows: CapacityRow[] = banks.map((bank) => {
    const F = base > 0 ? bank / base : 1;
    let net = 0, entrySum = 0, entryN = 0;
    for (const m of modeled) {
      const s = m.s0 * F;
      const vwap = Math.min(99, Math.max(1, m.quote + m.c * s));
      const shares = s / (vwap / 100);
      const feeUsd = feeRate * (vwap / 100) * (1 - vwap / 100) * shares; // taker fee at fill price
      net += (m.won ? shares - s : -s) - feeUsd;
      entrySum += vwap; entryN++;
    }
    return { bank, mult: Math.round((F) * 10) / 10, netPnl: Math.round(net), returnPct: bank > 0 ? Math.round(net / bank * 1000) / 10 : null, avgEntryCents: entryN ? Math.round(entrySum / entryN * 10) / 10 : null };
  });

  return {
    base, banks, rows,
    betsModeled: modeled.length, anchored, fallback: fallbackN, voidSkipped,
    medianSlipPer1k: cMed ? Math.round(cMed * 1000 * 10) / 10 : null, // ¢ of vwap move per $1k of size
    caveats: [
      "МОДЕЛЬ, не замер: линейный slippage (vwap=quote+c·size); книгу не пере-VWAP-или (уровни не храним).",
      "Заякорено на РЕАЛИЗОВАННЫЙ slippage там, где есть buy-fill (c=slip/notional); прочие — медианный c (fallback).",
      "Только ВХОД: exit-деградация не моделируется → большие размеры на деле ещё хуже (оценка оптимистична).",
      "Линейный масштаб размера с банком (Kelly/капы игнор) + price-taker (наш размер не меняет исход) — слабеет далеко за наблюдёнными размерами.",
      "База (×1) воспроизводит реализованный P&L по построению — кривая стартует с реальности и падает.",
    ],
    note: `${modeled.length} расчётных ставок (${anchored} на замеренном slippage, ${fallbackN} на медианном). ` +
      (rows.length && rows[0].returnPct != null && rows.at(-1)!.returnPct != null
        ? `Доход ${rows[0].returnPct}% при $${(base / 1000)}k → ${rows.at(-1)!.returnPct}% при $${(banks.at(-1)! / 1000)}k — смотри, где % начинает валиться, там и потолок ёмкости.`
        : "Недостаточно расчётов для кривой."),
  };
}
