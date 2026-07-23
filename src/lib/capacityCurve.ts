// ============================================================
// EDGE LAB — BANKROLL CAPACITY CURVE  [SERVER-ONLY, read-only]
//
// «Если банк был бы $20k/$50k/$100k/$200k — какой % дохода, с учётом стакана?» Capacity is a property of
// a STRATEGY × the markets it trades, NOT of the account. Overreaction lives in liquid live-panic
// moments; PMV-prematch filled dust books ($22 on the book). Their slippage profiles differ, so a single
// median coefficient over a mixed 684-bet portfolio is a spherical portfolio that will never exist.
//
// So the curve is cut by STRATEGY × EPOCH, and the VERDICT segment is the one that actually trades real
// money: Overreaction on the current epoch. The slippage coefficient `c` for a segment comes from THAT
// segment's OWN measured fills only (never the global median); when the measurement count is thin we
// report n and the width, not a smooth curve on borrowed slippage. Small-n & noisy is the truth about
// what we know — more useful than a smooth curve on poison.
//
// FIDELITY (a MODEL, not a replay against real books — we don't store book levels yet):
//   • ENTRY slippage only (exits — a take leg for Overreaction — degrade too → large sizes worse still).
//   • Rows whose scaled size runs past the biggest fill we've ever observed are flagged beyondObserved:
//     linear-slippage EXTRAPOLATION, not a forecast (a −100% row = «модель сломалась», not a number).
//   • The ×1 row reproduces realised P&L by construction — the curve starts at reality and decays.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { loadPolymarketConfig } from "./polymarket.js";
import { CODE_VERSION } from "./betMeta.js";

const DEFAULT_BANKS = [5000, 20000, 50000, 100000, 200000];
const VERDICT_STRATEGY = "overreaction";     // the real-whitelist strategy — the one the bank question is about
const C_MIN_OWN = 8;                          // ≥ this many own-class fills → "own"; 1–7 → "own_thin"; 0 → "none"

export interface CapacityRow { bank: number; mult: number; netPnl: number; returnPct: number | null; avgEntryCents: number | null; beyondObserved: boolean }
export interface CapacitySegment {
  key: string; strategyId: string; epoch: string;
  betsModeled: number; cN: number; cSource: "own" | "own_thin" | "none";
  cMedPer1k: number | null; cLoPer1k: number | null; cHiPer1k: number | null; // ¢ vwap move per $1k, median + range
  cMedPer1kWithModelled: number | null; // п.3: the OLD c-base (book+modelled) — for the old→new shift
  cModelledExcluded: number;            // how many modelled (from_book=false) buy-fills were dropped from c
  rows: CapacityRow[]; note: string;
}
export interface CapacityCurve {
  base: number; banks: number[];
  verdict: CapacitySegment | null;   // Overreaction · current epoch — the question that matters
  segments: CapacitySegment[];       // every strategy × epoch, diagnostic (verdict excluded)
  caveats: string[]; note: string;
}

const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const epochOf = (cv: string | null | undefined): string => (cv ? String(cv).split("·")[0] : "(none)");

export function buildCapacityCurve(db: Database, env: Record<string, string | undefined> = process.env, banks: number[] = DEFAULT_BANKS): CapacityCurve {
  const feeRate = loadPolymarketConfig(env).exec.takerFeeRate;
  const base = banks[0];

  // Per-bet buy slippage coefficient c (¢ of vwap per $ of size): c = Σ slip_cents / Σ notional, and the
  // biggest single fill we ever observed for that bet (the extrapolation frontier).
  // batch-4 п.3: the c-BASE must be honest slippage only. A `from_book=false` fill is MODELLED (quote-
  // fallback / paper-midpoint) — its "slippage" is a parametric artifact, not a measured book cost, and the
  // 0-slip paper epoch was flooding the median downward → an OPTIMISTIC capacity curve. Exclude modelled
  // fills from c by MODE (from_book), NEVER by value: a genuine 0¢ slip on a deep book IS a real measure and
  // stays. We keep a SEPARATE all-fills aggregate purely to show the old→new c shift as a number.
  const buyAgg = new Map<string, { slip: number; notional: number; maxFill: number }>();       // book-only (honest c)
  const buyAggAll = new Map<string, { slip: number; notional: number }>();                       // incl. modelled (old, for comparison)
  for (const f of R.allFillCosts(db)) {
    if (f.side !== "buy" || !f.bet_id) continue;
    const a = buyAggAll.get(f.bet_id) ?? { slip: 0, notional: 0 };
    a.slip += (f.slip_cents ?? 0); a.notional += (f.notional_usd ?? 0); buyAggAll.set(f.bet_id, a);
    if (!f.from_book) continue; // MODELLED fill → excluded from the honest c-base (mode filter, not value)
    const e = buyAgg.get(f.bet_id) ?? { slip: 0, notional: 0, maxFill: 0 };
    e.slip += (f.slip_cents ?? 0); e.notional += (f.notional_usd ?? 0); e.maxFill = Math.max(e.maxFill, f.notional_usd ?? 0);
    buyAgg.set(f.bet_id, e);
  }
  const cByBet = new Map<string, number>();
  for (const [betId, e] of buyAgg) { if (e.notional > 0) { const c = e.slip / e.notional; if (c > 0) cByBet.set(betId, c); } }
  const cByBetAll = new Map<string, number>(); // old basis (book + modelled) — comparison only
  for (const [betId, a] of buyAggAll) { if (a.notional > 0) { const c = a.slip / a.notional; if (c > 0) cByBetAll.set(betId, c); } }

  const settled = R.allBets(db).filter((b) => (b.status === "settled_won" || b.status === "settled_lost") && b.entry_price != null && b.stake != null && (b.stake ?? 0) > 0);

  // Group bets by strategy × epoch.
  const groups = new Map<string, typeof settled>();
  for (const b of settled) { const key = `${b.strategy_id}·${epochOf((b as any).code_version)}`; (groups.get(key) ?? groups.set(key, []).get(key)!).push(b); }

  const segFor = (key: string, bets: typeof settled): CapacitySegment => {
    const [strategyId, epoch] = [bets[0].strategy_id, epochOf((bets[0] as any).code_version)];
    // c comes from THIS segment's OWN fills only — never a global median.
    const ownCs: number[] = [], ownMax: number[] = [], ownCsAll: number[] = [];
    let modelledExcluded = 0;
    for (const b of bets) {
      const c = cByBet.get(b.id); if (c != null) { ownCs.push(c); ownMax.push(buyAgg.get(b.id)?.maxFill ?? 0); }
      const cAll = cByBetAll.get(b.id); if (cAll != null) ownCsAll.push(cAll);
      if (cByBetAll.has(b.id) && !cByBet.has(b.id)) modelledExcluded++; // had a c on the old basis, dropped as modelled
    }
    const cN = ownCs.length;
    const cMed = median(ownCs);
    const cMedAll = median(ownCsAll);
    const cSource: CapacitySegment["cSource"] = cN >= C_MIN_OWN ? "own" : cN >= 1 ? "own_thin" : "none";
    const maxObsNotional = ownMax.length ? Math.max(...ownMax) : 0;
    const medStake = median(bets.map((b) => b.stake as number)) ?? 0;

    const modeled = bets.map((b) => {
      const s0 = b.stake as number, entry = b.entry_price as number, won = b.result === "won";
      const c = cByBet.get(b.id) ?? cMed ?? 0;           // own measurement, else the segment's own median
      const quote = Math.max(1, entry - c * s0);
      return { s0, quote, c, won };
    });
    const rows: CapacityRow[] = banks.map((bank) => {
      const F = base > 0 ? bank / base : 1;
      let net = 0, entrySum = 0, n = 0;
      for (const m of modeled) {
        const s = m.s0 * F, vwap = Math.min(99, Math.max(1, m.quote + m.c * s));
        const shares = s / (vwap / 100), fee = feeRate * (vwap / 100) * (1 - vwap / 100) * shares;
        net += (m.won ? shares - s : -s) - fee; entrySum += vwap; n++;
      }
      const scaledMed = medStake * F;
      return { bank, mult: Math.round(F * 10) / 10, netPnl: Math.round(net), returnPct: bank > 0 ? Math.round(net / bank * 1000) / 10 : null, avgEntryCents: n ? Math.round(entrySum / n * 10) / 10 : null, beyondObserved: maxObsNotional > 0 && scaledMed > maxObsNotional };
    });
    const note = cSource === "none"
      ? `нет замеренного slippage у этого класса (c=0) → кривая плоская, ёмкость НЕ видна. Нужны свои fill-замеры.`
      : cSource === "own_thin"
        ? `c из ТОЛЬКО ${cN} собственных замеров (тонко) — медиана ${median(ownCs) != null ? Math.round((cMed as number) * 1000 * 10) / 10 : "?"}¢/\$1k, разброс [${Math.round(Math.min(...ownCs) * 1000 * 10) / 10}…${Math.round(Math.max(...ownCs) * 1000 * 10) / 10}]. Кривая шумная — это правда о том, сколько мы знаем.`
        : `c из ${cN} собственных замеров.`;
    return {
      key, strategyId, epoch, betsModeled: bets.length, cN, cSource,
      cMedPer1k: cMed != null ? Math.round(cMed * 1000 * 10) / 10 : null,
      cLoPer1k: ownCs.length ? Math.round(Math.min(...ownCs) * 1000 * 10) / 10 : null,
      cHiPer1k: ownCs.length ? Math.round(Math.max(...ownCs) * 1000 * 10) / 10 : null,
      cMedPer1kWithModelled: cMedAll != null ? Math.round(cMedAll * 1000 * 10) / 10 : null,
      cModelledExcluded: modelledExcluded,
      rows, note,
    };
  };

  const segments = [...groups.entries()].map(([k, b]) => segFor(k, b)).sort((a, b) => b.betsModeled - a.betsModeled);
  const verdictKey = `${VERDICT_STRATEGY}·${CODE_VERSION}`;
  const verdict = segments.find((s) => s.key === verdictKey) ?? null;

  return {
    base, banks,
    verdict,
    segments: segments.filter((s) => s.key !== verdictKey),
    caveats: [
      "Ёмкость — свойство СТРАТЕГИИ × её рынков, не аккаунта. Вердикт — Overreaction (real-whitelist) на текущей эпохе, не смесь портфеля.",
      "п.3: c-база — ТОЛЬКО замеренный по книге slippage (from_book). Модельные (quote-fallback/paper-0) филлы исключены по РЕЖИМУ, не по значению 0 — честный 0¢ на глубокой книге остаётся. Старая база (с модельными) занижала c → оптимистичная ёмкость.",
      verdict && verdict.cMedPer1kWithModelled != null && verdict.cMedPer1k != null
        ? `Сдвиг c у вердикта: старая база ${verdict.cMedPer1kWithModelled}¢/$1k (с модельными) → новая ${verdict.cMedPer1k}¢/$1k (только книга), исключено модельных ${verdict.cModelledExcluded}. Решения по банку читать ТОЛЬКО с новой кривой.`
        : verdict
          ? `Сдвиг c у вердикта: новая база (только книга) даёт ${verdict.cMedPer1k ?? "нет"} ¢/$1k; модельных исключено ${verdict.cModelledExcluded}. Если новая база пуста — ёмкость пока не измерить честно (нужны book-филлы).`
          : "c-сдвиг: нет вердиктного сегмента на текущей эпохе.",
      "c берётся из СОБСТВЕННЫХ замеров сегмента (никогда глобальная медиана). Тонкий n → показываем n и разброс, не гладкую кривую на чужом slippage.",
      "МОДЕЛЬ, не замер: линейный slippage, книгу не пере-VWAP-или. Строки beyondObserved — экстраполяция за наблюдённые размеры («модель сломалась»), не прогноз.",
      "Только ВХОД. У Overreaction выход (выкуп→тейк) — часть эджа, большой размер портит ОБЕ ноги → оценка оптимистична.",
      "×1 воспроизводит реализованный P&L. Замеренный capacity (по реальной книге) — отдельная ветка, копится с деплоя захвата.",
    ],
    note: verdict
      ? (verdict.cSource === "none"
        ? `Вердикт (Overreaction·${CODE_VERSION}): нет своих fill-замеров — ёмкость пока НЕ измерить, только форма от медианы недоступна. Ждём замеров/захвата книги.`
        : `Вердикт (Overreaction·${CODE_VERSION}, n=${verdict.betsModeled}, c из ${verdict.cN} замеров): ${verdict.note} Форму читать до ~$50k; дальше — экстраполяция.`)
      : `Нет расчётных ставок Overreaction на эпохе ${CODE_VERSION} — вердиктной ёмкости пока нет (копится). Ниже — диагностика по прочим сегментам.`,
  };
}
