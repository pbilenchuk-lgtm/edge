// ============================================================
// EDGE LAB — quality metrics (ТЗ §2.14)
//
// Brier       = mean( (ai_prob − outcome)^2 ), outcome ∈ {0,1}. Lower = better.
// CLV         = mean closing-line value. For a BUY position, value accrues
//               when the market closes ABOVE your entry (it moved your way),
//               so clv% = closing − entry in cents. ТЗ writes "(entry−closing)
//               в пользу ставки" and defines positive as "вошёл по цене лучше
//               закрытия"; for a long entry that is closing − entry. We follow
//               the STATED MEANING (positive = entered better than close).
// Calibration = per predicted-probability bucket, predicted avg vs actual freq.
// Verdict / low-data flag mirror the reference UI.
// ============================================================

import type { CalibrationBucket, PhaseMetric, MgmtMetric } from "./types.js";

export const MIN_SAMPLES = 20; // §9.8: below this, metrics are noise — flag it.

export interface MetricSample {
  aiProb: number; // 0..1
  outcome: 0 | 1; // did the backed outcome happen?
  entryPrice: number; // cents
  closingPrice: number | null; // cents (null => excluded from CLV)
  phase?: "pre" | "live"; // entry phase — for the per-phase breakdown
  pnl?: number; // realized P&L ($) — for the per-phase P&L
}

export interface MetricsResult {
  samples: number;
  brier: number | null;
  clv: number | null; // percentage points (cents)
  calibration: CalibrationBucket[];
  lowData: boolean;
  verdict: "эдж реален" | "эджа нет" | "неясно" | "мало данных";
}

export function brierScore(samples: MetricSample[]): number | null {
  if (!samples.length) return null;
  const sum = samples.reduce((a, s) => a + (s.aiProb - s.outcome) ** 2, 0);
  return round4(sum / samples.length);
}

/** Closing-line value in cents, averaged over bets with a closing price. */
export function clvValue(samples: MetricSample[]): number | null {
  const withClose = samples.filter((s) => s.closingPrice != null);
  if (!withClose.length) return null;
  const sum = withClose.reduce(
    (a, s) => a + ((s.closingPrice as number) - s.entryPrice),
    0,
  );
  return round2(sum / withClose.length);
}

/**
 * Calibration buckets by predicted probability. Default deciles; only
 * non-empty buckets are returned. `predicted` and `actual` are in %.
 */
export function calibration(
  samples: MetricSample[],
  edges: number[] = [0.5, 0.6, 0.7, 0.8, 1.0001],
): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  let lo = edges[0];
  // Everything below the first edge collapses into one low bucket if present.
  const lowBucket = samples.filter((s) => s.aiProb < edges[0]);
  if (lowBucket.length) {
    out.push(makeBucket(`<${pct(edges[0])}`, lowBucket));
  }
  for (let i = 0; i < edges.length - 1; i++) {
    lo = edges[i];
    const hi = edges[i + 1];
    const inBucket = samples.filter((s) => s.aiProb >= lo && s.aiProb < hi);
    if (inBucket.length) {
      const label = hi > 1 ? `${pct(lo)}+` : `${pct(lo)}-${pct(hi)}`;
      out.push(makeBucket(label, inBucket));
    }
  }
  return out;
}

export function computeMetrics(samples: MetricSample[]): MetricsResult {
  const brier = brierScore(samples);
  const clv = clvValue(samples);
  const lowData = samples.length < MIN_SAMPLES;
  return {
    samples: samples.length,
    brier,
    clv,
    calibration: calibration(samples),
    lowData,
    verdict: verdict(brier, clv, lowData),
  };
}

const PHASE_LABELS: Record<"pre" | "live", string> = {
  pre: "До матча",
  live: "В течение матча",
};

/**
 * Performance split by entry phase (pre-match vs in-match). Post-event is
 * folded into live — only the two phases remain. Same population as the
 * predictive metrics: resolution-settled bets, one row per phase.
 */
export function phaseBreakdown(samples: MetricSample[]): PhaseMetric[] {
  return (["pre", "live"] as const).map((id) => {
    const xs = samples.filter((s) => s.phase === id);
    const withClose = xs.filter((s) => s.closingPrice != null);
    const clv = withClose.length
      ? round2(
          withClose.reduce((a, s) => a + ((s.closingPrice as number) - s.entryPrice), 0) /
            withClose.length,
        )
      : null;
    return {
      id,
      label: PHASE_LABELS[id],
      bets: xs.length,
      wins: xs.reduce((a, s) => a + s.outcome, 0),
      pnl: round2(xs.reduce((a, s) => a + (s.pnl ?? 0), 0)),
      clv,
    };
  });
}

/**
 * Value of active management: realized P&L of managed (early/partial) exits vs
 * what the same slices would have returned held to settlement. `pairs` are only
 * the managed positions whose held-to-end outcome is knowable (match finished).
 */
export function managementValue(
  pairs: { actual: number; heldToEnd: number }[],
): MgmtMetric | null {
  if (!pairs.length) return null;
  return {
    actualPnl: round2(pairs.reduce((a, p) => a + p.actual, 0)),
    heldToEndPnl: round2(pairs.reduce((a, p) => a + p.heldToEnd, 0)),
    managed: pairs.length,
  };
}

/** Cumulative realized P&L across settled matches (chronological), starting at 0. */
export function equityCurve(matchPnls: number[]): number[] {
  const out = [0];
  let acc = 0;
  for (const p of matchPnls) {
    acc = round2(acc + p);
    out.push(acc);
  }
  return out;
}

/** ТЗ §4.4: «эдж реален / неясно / эджа нет», with a low-data guard. */
export function verdict(
  brier: number | null,
  clv: number | null,
  lowData: boolean,
): MetricsResult["verdict"] {
  if (lowData) return "мало данных";
  if (clv == null || brier == null) return "неясно";
  if (clv > 1 && brier < 0.2) return "эдж реален";
  if (clv < 0) return "эджа нет";
  return "неясно";
}

function makeBucket(label: string, xs: MetricSample[]): CalibrationBucket {
  const predicted = (xs.reduce((a, s) => a + s.aiProb, 0) / xs.length) * 100;
  const actual = (xs.reduce((a, s) => a + s.outcome, 0) / xs.length) * 100;
  return {
    bucket: label,
    predicted: Math.round(predicted),
    actual: Math.round(actual),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
