// ============================================================
// EDGE LAB — invariants (ТЗ §9). "Проверять всегда."
//
// The numeric invariants (1–4, 8) are validated here. The behavioural ones
// are enforced by architecture and noted for reference:
//   §9.5  analytics never sees money; strategies read analytics  -> module split
//   §9.6  bet sizes computed by code, not the LLM                 -> thresholds.sizeBet
//   §9.7  reassessment only on a trigger, rate-limited            -> reassessments.trigger + limiter
//   §9.9  API keys never in the browser/DB in cleartext           -> .env / server-only
//   §9.10 strategies compared by ROI & quality, not absolute P&L  -> money.roi + metrics
// ============================================================

import { freeBalance, sharesTotal, stakeWithinBudget } from "./money.js";
import { MIN_SAMPLES } from "./metrics.js";

export interface Violation {
  code: string;
  message: string;
}

export interface InvariantState {
  totalBalance: number;
  competitions: { id: string; budget: number }[];
  /** shares grouped by competition id */
  sharesByComp: Record<string, { strategy_id: string; pct: number }[]>;
  /** for §9.3: per competition+strategy, the bets on each match and the $ budget */
  stakeGroups: {
    competitionId: string;
    strategyId: string;
    matchId: string;
    strategyBudget: number;
    bets: { stake: number | null }[];
  }[];
  /** for §9.4: per match, the assessment stages present */
  assessmentsByMatch: Record<string, { stage: string; status: string }[]>;
  /** for §9.8 (informational): per strategy sample counts */
  sampleCounts?: Record<string, number>;
}

export function checkInvariants(state: InvariantState): {
  ok: boolean;
  violations: Violation[];
} {
  const violations: Violation[] = [];

  // §9.1 free balance >= 0
  const free = freeBalance(state.totalBalance, state.competitions);
  if (free < -1e-9) {
    violations.push({
      code: "9.1",
      message: `Свободный остаток казны отрицателен: ${free.toFixed(2)}`,
    });
  }

  // §9.2 sum of shares per competition <= 100
  for (const [compId, shares] of Object.entries(state.sharesByComp)) {
    const total = sharesTotal(shares);
    if (total > 100 + 1e-9) {
      violations.push({
        code: "9.2",
        message: `Сумма долей на «${compId}» = ${total}% > 100%`,
      });
    }
  }

  // §9.3 strategy stake on a match <= its budget on the competition
  for (const g of state.stakeGroups) {
    if (!stakeWithinBudget(g.bets, g.strategyBudget)) {
      const total = g.bets.reduce((a, b) => a + (b.stake || 0), 0);
      violations.push({
        code: "9.3",
        message: `Стратегия ${g.strategyId} на матче ${g.matchId}: ставки ${total} > бюджет ${g.strategyBudget}`,
      });
    }
  }

  // §9.4 at most one pre + one post assessment per match
  for (const [matchId, list] of Object.entries(state.assessmentsByMatch)) {
    const pre = list.filter((a) => a.stage === "pre_lineup").length;
    const post = list.filter((a) => a.stage === "post_lineup").length;
    if (pre > 1 || post > 1) {
      violations.push({
        code: "9.4",
        message: `Матч ${matchId}: должно быть <=1 pre и <=1 post оценки (pre=${pre}, post=${post})`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/** §9.8 helper: is a strategy's sample size large enough to trust metrics? */
export function metricsTrustworthy(sampleCount: number): boolean {
  return sampleCount >= MIN_SAMPLES;
}
