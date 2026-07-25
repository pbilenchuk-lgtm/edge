// ============================================================
// EDGE LAB — PORTFOLIO report  [Phase 5.2 / 5.3 / 5.4, ratified master audit spec]
//
// ONE JSON the owner reads to see the whole book at a glance: every (strategy × market-family) cell on the
// clean epoch, collapsed to SIGNALS (R0.1 units), with the signal-level verdict, the money view, and — the
// decisive line — the CLV→realized correlation (does beating the closing line actually predict P&L?).
//
//   5.2  cells: {n signals, fee-adj EV, P&L, ROI, CLV-t, maturity, verdict}; plus a Week-over-Week delta of
//        P&L / CLV / verdict per cell (this 7-day window vs the prior 7-day window, from the bets themselves —
//        no snapshot store needed).
//   5.3  clvRealizedCorr: Pearson r between a signal's CLV (¢) and its realized book P&L, per cell AND overall.
//        This is the single most decisive validation of the whole line — kept front-and-centre.
//   5.4  BH (Benjamini-Hochberg) FDR control across the grid's win-vs-implied p-values: a 20-cell grid expects
//        ~1 false "winner" at α=0.05, so each cell carries its BH q-value + whether it survives FDR, and the
//        header states the multiple-testing correction explicitly.
// ============================================================

import type { Database } from "./db.js";
import { betRecords, type BetRec, type ProfileFilter } from "./profileAnalytics.js";
import { cleanEpochRecords, CLEAN_EPOCH_FLOOR } from "./profileEpochCut.js";
import { collapseToSignals, signalCohort, benjaminiHochberg, type Signal } from "./signals.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Pearson correlation of {x,y} pairs; null when <3 pairs or a degenerate (zero-variance) axis. */
export function pearson(pairs: { x: number; y: number }[]): { r: number | null; n: number } {
  const n = pairs.length;
  if (n < 3) return { r: null, n };
  const mx = mean(pairs.map((p) => p.x)), my = mean(pairs.map((p) => p.y));
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pairs) { const dx = p.x - mx, dy = p.y - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return { r: null, n };
  return { r: Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000, n };
}

/** CLV→realized correlation over decided signals carrying BOTH a CLV and a book P&L. The decisive validation. */
export function clvRealizedCorr(signals: Signal[]): { r: number | null; n: number } {
  const pairs = signals
    .filter((s) => s.settled && s.clvCents != null)
    .map((s) => ({ x: s.clvCents as number, y: s.pnl }));
  return pearson(pairs);
}

export interface PortfolioCell {
  strategyId: string; family: string;
  nSignals: number; nDecided: number; maturity: string; verdict: string;
  winPct: number | null; meanImpliedPct: number | null; binomP: number | null; beatsMarket: boolean;
  binomQ: number | null; survivesFdr: boolean;              // [5.4] BH-adjusted across the grid
  clvMeanCents: number | null; clvT: number | null; clvP: number | null; clvSignificant: boolean;
  pnlUsd: number; grossUsd: number; volumeUsd: number; roiPct: number | null;
  feeAdjEvPerSignalUsd: number | null;                       // realized book P&L per decided signal (already net of sim fees)
  clvRealizedCorr: { r: number | null; n: number };          // [5.3] per-cell
  wow: { thisPnlUsd: number; priorPnlUsd: number; pnlDeltaUsd: number; thisClvCents: number | null; priorClvCents: number | null; clvDeltaCents: number | null; verdictPrev: string; verdictNow: string };
  note: string;
}

export interface Portfolio {
  cleanEpochFloor: number | null;
  generatedAtMs: number;
  cells: PortfolioCell[];
  clvRealizedCorrOverall: { r: number | null; n: number };   // [5.3] the whole book
  fdr: { q: number; m: number; threshold: number | null };
  multipleTestingNote: string;
  note: string;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Restrict records to a [loMs, hiMs) createdAt window (for the WoW split). */
function inWindow(recs: BetRec[], loMs: number, hiMs: number): BetRec[] {
  return recs.filter((r) => { const t = Date.parse(r.createdAt ?? "") || 0; return t >= loMs && t < hiMs; });
}
function windowSummary(recs: BetRec[]): { pnlUsd: number; clvCents: number | null; verdict: string } {
  const signals = collapseToSignals(recs);
  const settled = signals.filter((s) => s.settled);
  const pnl = r2(settled.reduce((a, s) => a + s.pnl, 0));
  const clvs = signals.map((s) => s.clvCents).filter((x): x is number => x != null);
  const cohort = signalCohort(recs);
  return { pnlUsd: pnl, clvCents: clvs.length ? r2(mean(clvs)) : null, verdict: cohort.verdict };
}

/**
 * Build the portfolio. `nowMs` anchors the WoW windows (override for deterministic tests). The clean-epoch
 * floor is the default scope for every sport; pass filter.includeAllEpochs to keep dirty rows.
 */
export function buildPortfolio(db: Database, opts: { filter?: ProfileFilter; nowMs?: number } = {}): Portfolio {
  const filter = opts.filter ?? {};
  const nowMs = opts.nowMs ?? Date.now();
  const all = betRecords(db, filter);
  const recs = filter.includeAllEpochs ? all : cleanEpochRecords(all, CLEAN_EPOCH_FLOOR);

  // Group by (strategy × family). family is derived from the market label (signals.marketFamily via the signal).
  const groups = new Map<string, BetRec[]>();
  for (const r of recs) {
    const fam = collapseToSignals([r])[0]?.family ?? "other";
    const key = `${r.strategyId}||${fam}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  const thisLo = nowMs - WEEK_MS, priorLo = nowMs - 2 * WEEK_MS;

  const cellsRaw = [...groups.entries()].map(([key, rs]) => {
    const [strategyId, family] = key.split("||");
    const cohort = signalCohort(rs, { strategyId, family });
    const signals = collapseToSignals(rs);
    const settled = signals.filter((s) => s.settled);
    const volume = settled.reduce((a, s) => a + s.stake, 0);
    const pnl = settled.reduce((a, s) => a + s.pnl, 0);
    const evPerSignal = cohort.nDecided > 0 ? r2(pnl / cohort.nDecided) : null;
    const thisW = windowSummary(inWindow(rs, thisLo, nowMs));
    const priorW = windowSummary(inWindow(rs, priorLo, thisLo));
    return {
      strategyId, family,
      nSignals: cohort.nSignals, nDecided: cohort.nDecided, maturity: cohort.matured, verdict: cohort.verdict,
      winPct: cohort.winVsImplied.winPct, meanImpliedPct: cohort.winVsImplied.meanImpliedPct,
      binomP: cohort.winVsImplied.binomP, beatsMarket: cohort.winVsImplied.beatsMarket,
      binomQ: null as number | null, survivesFdr: false,
      clvMeanCents: cohort.clv.meanCents, clvT: cohort.clv.t, clvP: cohort.clv.p, clvSignificant: cohort.clv.significant,
      pnlUsd: r2(pnl), grossUsd: r2(settled.reduce((a, s) => a + s.grossPnl, 0)), volumeUsd: r2(volume), roiPct: volume > 0 ? r2((pnl / volume) * 100) : null,
      feeAdjEvPerSignalUsd: evPerSignal,
      clvRealizedCorr: clvRealizedCorr(signals),
      wow: {
        thisPnlUsd: thisW.pnlUsd, priorPnlUsd: priorW.pnlUsd, pnlDeltaUsd: r2(thisW.pnlUsd - priorW.pnlUsd),
        thisClvCents: thisW.clvCents, priorClvCents: priorW.clvCents,
        clvDeltaCents: thisW.clvCents != null && priorW.clvCents != null ? r2(thisW.clvCents - priorW.clvCents) : null,
        verdictPrev: priorW.verdict, verdictNow: thisW.verdict,
      },
      note: cohort.note,
    };
  });

  // [5.4] BH across the grid's win-vs-implied p-values (only cells that HAVE a p — matured enough to test).
  const bh = benjaminiHochberg(cellsRaw.map((c) => c.binomP), 0.05);
  cellsRaw.forEach((c, i) => { c.binomQ = bh.qValues[i]; c.survivesFdr = bh.rejected[i]; });

  // Sort: matured + surviving-FDR + biggest P&L first (the owner's eye goes to proven money).
  const cells = cellsRaw.sort((a, b) => Number(b.survivesFdr) - Number(a.survivesFdr) || b.pnlUsd - a.pnlUsd);

  const overall = clvRealizedCorr(collapseToSignals(recs));

  return {
    cleanEpochFloor: filter.includeAllEpochs ? null : CLEAN_EPOCH_FLOOR,
    generatedAtMs: nowMs,
    cells,
    clvRealizedCorrOverall: overall,
    fdr: { q: bh.q, m: bh.m, threshold: bh.threshold },
    multipleTestingNote: `Множественное тестирование: ${bh.m} ячеек с p-значением win-vs-implied прогнаны через Benjamini-Hochberg (FDR q=${bh.q}). survivesFdr=true — ячейка переживает коррекцию (не случайный «победитель»); binomQ — BH-скорректированное q. Сырое beatsMarket без survivesFdr на сетке — подозрительно.`,
    note: `Единица — СИГНАЛ (R0.1). Разрез стратегия×семья на чистой эпохе (e5+ по умолчанию; includeAllEpochs — override). P&L — book (уже за вычетом комиссий sim); feeAdjEvPerSignalUsd = book-P&L / решённый сигнал. clvRealizedCorr — корреляция CLV↔реализованный P&L, самая решающая валидация линейки: r>0 значит «бить клоуз предсказывает деньги». WoW — это 7-дневное окно против предыдущего 7-дневного (по created_at ставок).`,
  };
}
