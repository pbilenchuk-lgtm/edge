// ============================================================
// EDGE LAB — TENNIS SHADOW-COHORT MATURITY  [SERVER-ONLY, read-only]  (P6 STOP-1, batch-7)
//
// The two winning flag_only tennis signals are NOT unblocked on the strength of two anecdotes — that's exactly
// what a pre-fixed criterion protects against. Instead this surfaces the MATURITY of each shadow cohort as DATA:
// how far each is from its (fixed-before-the-data) sample criterion, and the ETA at the current recording rate.
// Decisions by criteria, not by highlights.
//
//   • PMV Brier cohort   — Brier(markov) vs Brier(implied@frozen-mid); read only at n≥40 scored.
//   • Set-Value shadow   — P(comeback set-2) by favourite-strength bin; read only at verdict-bin n≥40 AND total n≥80.
//
// ETA = remaining / (resolved rows in the trailing window ÷ window days). Honest "n/a" when no rate yet.
// Exposed at GET /api/tennis-scout?report=maturity. Read-only.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { buildPmvShadowCalibration } from "./tennisPmvShadow.js";
import { buildSvShadowCalibration } from "./tennisSetValueShadow.js";

export interface CohortMaturity {
  cohort: "pmv_brier" | "set_value_shadow";
  haveN: number; needN: number;               // the primary sample gate (scored / verdict-bin)
  secondary?: { label: string; haveN: number; needN: number } | null; // set_value's total-N gate
  matured: boolean;
  ratePerDay: number | null;                   // resolved rows/day over the trailing window
  etaDays: number | null;                      // remaining / rate; null when rate is 0/unknown
  verdict: string;                             // the underlying calibration verdict
  note: string;
}
export interface TennisMaturity {
  windowDays: number;
  cohorts: CohortMaturity[];
  note: string;
}

/** Resolved rows/day for a shadow table over the trailing window (a rate for the ETA). Keyed on resolved_at so
 *  it works for BOTH tables' terminal-status conventions (pmv: won/lost/void; sv: 'resolved'). Null when 0. */
function resolveRatePerDay(db: Database, table: string, nowMs: number, windowDays: number): number | null {
  const fromIso = new Date(nowMs - windowDays * 86_400_000).toISOString();
  let n = 0;
  try { n = Number((db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE resolved_at IS NOT NULL AND resolved_at >= ?`).get(fromIso) as { c: number }).c) || 0; }
  catch { return null; }
  const rate = n / windowDays;
  return rate > 0 ? Math.round(rate * 100) / 100 : null;
}
const etaOf = (remaining: number, rate: number | null): number | null => (rate && rate > 0 && remaining > 0 ? Math.ceil(remaining / rate) : remaining <= 0 ? 0 : null);

/** Compose the two shadow cohorts' maturity + ETA. Read-only. */
export function buildTennisMaturity(db: Database, opts: { nowMs?: number; windowDays?: number } = {}): TennisMaturity {
  const nowMs = opts.nowMs ?? Date.now();
  const windowDays = opts.windowDays ?? 14;

  const pmv = buildPmvShadowCalibration(db);
  const pmvRate = resolveRatePerDay(db, "pmv_shadow_signals", nowMs, windowDays);
  const pmvRemaining = Math.max(0, pmv.criterion.needN - pmv.criterion.haveN);
  const pmvCohort: CohortMaturity = {
    cohort: "pmv_brier",
    haveN: pmv.criterion.haveN, needN: pmv.criterion.needN, secondary: null, matured: pmv.criterion.matured,
    ratePerDay: pmvRate, etaDays: etaOf(pmvRemaining, pmvRate), verdict: pmv.verdict,
    note: pmv.criterion.matured
      ? `Brier-когорта PMV созрела (${pmv.criterion.haveN}/${pmv.criterion.needN}) — вердикт «${pmv.verdict}» читаем`
      : `Brier PMV ${pmv.criterion.haveN}/${pmv.criterion.needN}${pmvRate != null ? `, темп ${pmvRate}/день → ETA ≈ ${etaOf(pmvRemaining, pmvRate)}д` : ", темпа нет (0 разрешено в окне)"}`,
  };

  const sv = buildSvShadowCalibration(db);
  const svRate = resolveRatePerDay(db, "sv_shadow_signals", nowMs, windowDays);
  const svTotalHave = sv.overall?.n ?? 0;
  // sv.criterion.verdictBinN/totalN are the THRESHOLDS; the achieved counts are the biggest bin + total scored.
  const svBinNeed = sv.criterion.verdictBinN, svTotalNeed = sv.criterion.totalN;
  const svBiggestBinN = sv.bins.reduce((mx, b) => Math.max(mx, b.n), 0);
  const svRemaining = Math.max(svBinNeed - svBiggestBinN, svTotalNeed - svTotalHave, 0);
  const svCohort: CohortMaturity = {
    cohort: "set_value_shadow",
    haveN: svBiggestBinN, needN: svBinNeed,
    secondary: { label: "всего разрешённых", haveN: svTotalHave, needN: svTotalNeed },
    matured: sv.criterion.verdictBinMet && sv.criterion.totalMet, ratePerDay: svRate, etaDays: etaOf(svRemaining, svRate),
    verdict: sv.verdict,
    note: sv.verdict === "measured"
      ? `set_value shadow ИЗМЕРЕНО (бин ${svBiggestBinN}/${svBinNeed}, всего ${svTotalHave}/${svTotalNeed})`
      : `set_value shadow: крупнейший бин ${svBiggestBinN}/${svBinNeed}, всего ${svTotalHave}/${svTotalNeed}${svRate != null ? `, темп ${svRate}/день → ETA ≈ ${etaOf(svRemaining, svRate)}д` : ", темпа нет"}`,
  };

  const note = `flag_only НЕ разблокируется по хайлайтам — решения по критериям. ${pmvCohort.matured ? "PMV созрела" : "PMV копит"}; ${svCohort.matured ? "set_value созрел" : "set_value копит"}.`;
  return { windowDays, cohorts: [pmvCohort, svCohort], note };
}
