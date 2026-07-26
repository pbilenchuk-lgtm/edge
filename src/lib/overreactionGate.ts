// ============================================================
// EDGE LAB — OVERREACTION EDGE-GATE  [R1, batch-10 ТЗ — UNIT-OF-MEASURE REPAIR]
//
// The old gate counted only RESOLUTION-settled cycles. For a strategy that cashes out ~100% of its positions
// by design, that gate is unmeasurable by construction: it waits for an event its own exit policy prevents.
// It is the same class of blindness as the PMV Brier gate that measured nothing until shadow scoring fixed the
// unit — and the precedent is why this repair is ratified rather than argued.
//
// The gate is now: CLOSED SIGNAL CYCLES WITH REALIZED P&L. A cash-out is a real, graded outcome — money came
// back, more or less than went out — so it counts. The unit is the SIGNAL (R0.1), not the bet row, so a
// 4-profile fan-out of one decision is one observation. Clean epoch and same-epoch filters stay; the verdict
// is triple agreement on signals (CLV t / win-vs-implied / bootstrap P&L) at n≥25 preliminary, n≥40 stable.
//
// STATED OPENLY, in code and in the report: this repairs the RULER, not the result. The cash-out cohort
// currently reads NEGATIVE (win ≈36%, CLV ≈ −5.2¢). We are adopting a measure that, as of today, argues
// against the strategy — which is exactly why it can be trusted. A gate that only ever opened on favourable
// arithmetic would be a marketing device, not a criterion.
//
// Read-only; never writes. Exposed at GET /api/real?report=overreaction_gate.
// ============================================================

import type { Database } from "./db.js";
import { codeEpochOf, crossEpoch, epochNum } from "./codeEpoch.js";
import { betRecords } from "./profileAnalytics.js";
import { cleanEpochRecords } from "./profileEpochCut.js";
import { signalCohort } from "./signals.js";


/** win% / P&L / CLV over a cohort — the SAME three verdict metrics, for the gate cohort and (diagnostically)
 *  the cash-out cohort side by side. */
export interface CohortMetrics { n: number; won: number; lost: number; winPct: number | null; pnlUsd: number; clvCents: number | null }

export interface OverreactionGate {
  target: number;              // the pre-set sample gate (30)
  cleanEpochMin: number;       // clean-epoch floor (5 = e5)
  cleanCycles: number;         // settled resolution cycles that COUNT (the gate numerator)
  progress: string;            // e.g. "6/30"
  won: number; lost: number;
  excluded: { void: number; cashOut: number; preEpoch: number; crossEpoch: number; settleSuspect: number };
  byEpoch: Record<string, { won: number; lost: number }>;
  // The gate cohort's three metrics (resolution settles — the verdict-bearing set).
  settleCohort: CohortMetrics;
  // DIAGNOSTIC ONLY (NOT the gate): the clean-epoch cash-out cycles the strategy closes early by design. Same
  // three metrics. If it AGREES with settleCohort it's corroborating evidence at verdict time; the gate stays
  // the ratified resolution-only n≥30 regardless — we do not refit the criterion to the larger cash-out set.
  cashOutCohort: CohortMetrics;
  verdict: "gate_open" | "accruing";
  // [R1 / batch-10] THE REPAIRED GATE — closed signal cycles with realized P&L (cash-outs included), scored
  // on SIGNALS with the same statistical machinery every other cohort uses. `legacyResolutionOnly` keeps the
  // old numerator visible so the change of ruler is auditable rather than silent.
  signalGate: {
    nSignals: number; nDecided: number; matured: "none" | "preliminary" | "stable";
    winPct: number | null; meanImpliedPct: number | null; binomP: number | null; beatsMarket: boolean;
    clvMeanCents: number | null; clvT: number | null; clvSignificant: boolean;
    pnlUsd: number; bootP: number | null; pnlPositiveSignificant: boolean;
    tripleAgreement: boolean; verdict: string; legacyResolutionOnly: number; note: string;
  };
  note: string;
}

/** Count clean-epoch, same-epoch, resolution-settled Overreaction cycles against the n≥30 gate. */
export function buildOverreactionGate(db: Database, target = 30, cleanEpochMin = 5): OverreactionGate {
  const rows = db.prepare(
    `SELECT b.status, b.settled_by, b.code_version, b.exit_code_version, b.settle_suspect,
            b.payout, b.stake, b.entry_price, b.closing_price
       FROM bets b JOIN matches m ON m.id = b.match_id JOIN competitions c ON c.id = m.competition_id
      WHERE c.sport_id = 'football' AND b.strategy_id = 'overreaction'
        AND b.status IN ('settled_won','settled_lost','settled_void')`,
  ).all() as { status: string; settled_by: string | null; code_version: string | null; exit_code_version: string | null; settle_suspect: number | null; payout: number | null; stake: number | null; entry_price: number | null; closing_price: number | null }[];

  // Accumulator for the three verdict metrics over a cohort.
  const acc = () => ({ n: 0, won: 0, lost: 0, pnl: 0, clvSum: 0, clvN: 0 });
  const settleAcc = acc(), cashOutAcc = acc();
  const tally = (a: ReturnType<typeof acc>, r: typeof rows[number], won1: boolean) => {
    a.n++; if (won1) a.won++; else a.lost++;
    a.pnl += (r.payout ?? 0) - (r.stake ?? 0);
    if (r.closing_price != null && r.entry_price != null) { a.clvSum += r.closing_price - r.entry_price; a.clvN++; }
  };
  const finalize = (a: ReturnType<typeof acc>): CohortMetrics => ({
    n: a.n, won: a.won, lost: a.lost, winPct: (a.won + a.lost) ? Math.round((a.won / (a.won + a.lost)) * 1000) / 10 : null,
    pnlUsd: Math.round(a.pnl * 100) / 100, clvCents: a.clvN ? Math.round((a.clvSum / a.clvN) * 10) / 10 : null,
  });

  let cleanCycles = 0, won = 0, lost = 0;
  const excluded = { void: 0, cashOut: 0, preEpoch: 0, crossEpoch: 0, settleSuspect: 0 };
  const byEpoch: Record<string, { won: number; lost: number }> = {};
  for (const b of rows) {
    // P1(б): a two-leg-mislabel settle (settle_suspect=1) is a wrong grade on the final score — it must not
    // count toward the clean-cycle gate. Exclude before any won/lost tally; count it so the exclusion is visible.
    if (Number(b.settle_suspect) === 1) { excluded.settleSuspect++; continue; }
    if (b.status === "settled_void") { excluded.void++; continue; }
    const won1 = b.status === "settled_won";
    // early/partial = discretionary cash-out; not a verdict-bearing outcome for the GATE. But — same clean-epoch,
    // same-epoch filters — it feeds the DIAGNOSTIC cash-out cohort (corroborating, never the gate).
    if (b.settled_by === "early" || b.settled_by === "partial") {
      excluded.cashOut++;
      if (epochNum(b.code_version) >= cleanEpochMin && !crossEpoch(b)) tally(cashOutAcc, b, won1);
      continue;
    }
    if (epochNum(b.code_version) < cleanEpochMin) { excluded.preEpoch++; continue; }
    if (crossEpoch(b)) { excluded.crossEpoch++; continue; }
    cleanCycles++;
    tally(settleAcc, b, won1);
    if (won1) won++; else lost++;
    const ep = codeEpochOf(b.code_version) || "e?";
    const e = (byEpoch[ep] ??= { won: 0, lost: 0 });
    if (won1) e.won++; else e.lost++;
  }
  const settleCohort = finalize(settleAcc), cashOutCohort = finalize(cashOutAcc);

  const verdict: OverreactionGate["verdict"] = cleanCycles >= target ? "gate_open" : "accruing";
  // The cash-out diagnostic AGREES with the gate cohort when win%/P&L-sign/CLV-sign line up — corroborating, not
  // gating. Reported so the 93-cycle discretionary path informs the verdict without redefining the gate.
  const agree = cashOutCohort.n > 0 && settleCohort.winPct != null && cashOutCohort.winPct != null
    && Math.sign(settleCohort.pnlUsd) === Math.sign(cashOutCohort.pnlUsd)
    && Math.abs((settleCohort.winPct ?? 0) - (cashOutCohort.winPct ?? 0)) <= 15;
  const diag = cashOutCohort.n > 0
    ? ` · ДИАГНОСТИКА кэш-аут-когорты (НЕ гейт, n=${cashOutCohort.n}): win ${cashOutCohort.winPct}%, P&L $${cashOutCohort.pnlUsd}, CLV ${cashOutCohort.clvCents ?? "n/a"}¢ vs сеттл win ${settleCohort.winPct ?? "n/a"}%, P&L $${settleCohort.pnlUsd}, CLV ${settleCohort.clvCents ?? "n/a"}¢ — ${agree ? "согласуется (усиливающее свидетельство к вердикту)" : "расходится (осторожно)"}; гейт остаётся ратифицированным resolution-only n≥30`
    : "";
  // ── [R1] THE REPAIRED GATE: closed signal cycles with realized P&L ──────────────────────────────
  // Every clean-epoch, same-epoch Overreaction position that CLOSED with money back — cash-out or resolution
  // alike — collapsed to signals and scored by the standard tests. betRecords already drops settle_suspect,
  // epoch_unknown and token-poisoned rows; cleanEpochRecords adds the e5 floor and the cross-epoch quarantine,
  // so the two filters agree with the legacy numerator by construction.
  const recs = cleanEpochRecords(betRecords(db, { strategyId: "overreaction" }), cleanEpochMin);
  const cohort = signalCohort(recs, { strategyId: "overreaction" });
  const sg = {
    nSignals: cohort.nSignals, nDecided: cohort.nDecided, matured: cohort.matured,
    winPct: cohort.winVsImplied.winPct, meanImpliedPct: cohort.winVsImplied.meanImpliedPct,
    binomP: cohort.winVsImplied.binomP, beatsMarket: cohort.winVsImplied.beatsMarket,
    clvMeanCents: cohort.clv.meanCents, clvT: cohort.clv.t, clvSignificant: cohort.clv.significant,
    pnlUsd: cohort.pnl.totalUsd, bootP: cohort.pnl.bootP, pnlPositiveSignificant: cohort.pnl.positiveSignificant,
    tripleAgreement: cohort.tripleAgreement, verdict: cohort.verdict, legacyResolutionOnly: cleanCycles,
    note: `[R1] ЕДИНИЦА ИЗМЕРЕНИЯ ИСПРАВЛЕНА: гейт считает ЗАКРЫТЫЕ СИГНАЛЬНЫЕ ЦИКЛЫ с реализованным P&L (кэш-ауты входят) — resolution-only ворота для стратегии, кэш-аутящей ~100% позиций, неизмеримы по построению (тот же класс слепоты, что Brier у PMV). n=${cohort.nSignals} сигналов, решённых ${cohort.nDecided} (${cohort.matured}); старый resolution-only числитель был ${cleanCycles}. ` +
      `ОГОВОРКА ОТКРЫТО: это ремонт ЛИНЕЙКИ, а не результата — текущее чтение против нас (кэш-аут-когорта win ${cashOutCohort.winPct ?? "n/a"}%, CLV ${cashOutCohort.clvCents ?? "n/a"}¢). Принимаем меру, которая сегодня спорит со стратегией: гейт, открывающийся только на удобной арифметике, был бы не критерием, а рекламой. ` + cohort.note,
  };

  const note = (verdict === "gate_open"
    ? `✅ ГЕЙТ ОТКРЫТ: ${cleanCycles}/${target} чистых Overreaction-циклов — выборки достаточно, вердикт (CLV+win%+P&L) можно читать`
    : `⏳ КОПИМ: ${cleanCycles}/${target} чистых циклов (won ${won} / lost ${lost}) — до n≥30 вердикт по Overreaction ещё преждевременный; исключено ${excluded.void} void, ${excluded.cashOut} кэш-аут, ${excluded.preEpoch} до-e5, ${excluded.crossEpoch} cross-epoch, ${excluded.settleSuspect} settle_suspect (two-leg мислейбл)`) + diag;
  return { target, cleanEpochMin, cleanCycles, progress: `${cleanCycles}/${target}`, won, lost, excluded, byEpoch, settleCohort, cashOutCohort, verdict, signalGate: sg, note };
}
