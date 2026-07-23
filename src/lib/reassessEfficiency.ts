// ============================================================
// EDGE LAB — F5: reassessment efficiency  [MEASUREMENT ONLY]
//
// P0.4 put a deterministic pre-LLM gate in front of live reassessment: no open positions AND no armed live
// trigger → skip the LLM. The «LLM-мельница» base was ~26–42 strategist calls per TRADED match, almost all
// returning «воздерживаюсь». This re-measures that ratio post-P0.4 from the running counters, giving the gate
// a hard number instead of a vibe: calls per traded match, and the share of ticks the gate short-circuited.
//
// Honest denominator: the counters are anchored (reassess_counter_since) at first bump, so «traded matches»
// counts only football entries created SINCE the anchor — not the all-time match count, which would dilute
// the ratio with pre-P0.4 history. Read-only; never a money decision.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

export const FOOTBALL_STRATS = ["prematch_value", "overreaction", "live_xg"];
// The pre-P0.4 baseline the operator is comparing against (strategist calls per traded match).
export const BASELINE_CALLS_PER_MATCH = { min: 26, max: 42 };

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ReassessEfficiency {
  since: string | null;               // counter anchor (null → counters never bumped yet)
  llmCalls: number; gateSkips: number; // cumulative since the anchor
  gateSkipRatioPct: number | null;    // skips / (calls + skips) — how often the gate short-circuited a tick
  tradedMatches: number;              // distinct football matches with a real entry since the anchor
  callsPerTradedMatch: number | null; // the headline ratio, vs the baseline band
  baseline: { min: number; max: number };
  verdict: "below_baseline" | "within_baseline" | "above_baseline" | "insufficient";
  note: string;
}

/** Distinct football matches with a REAL entry (settled/open, not proposed/not_filled) since `since`. */
function tradedMatchCount(db: Database, since: string | null): number {
  const ph = FOOTBALL_STRATS.map(() => "?").join(",");
  const sinceClause = since ? "AND created_at >= ?" : "";
  const args: unknown[] = [...FOOTBALL_STRATS];
  if (since) args.push(since);
  const row = db.prepare(
    `SELECT COUNT(DISTINCT match_id) n FROM bets
     WHERE strategy_id IN (${ph}) AND status NOT IN ('proposed','not_filled') ${sinceClause}`,
  ).get(...args) as { n: number };
  return Number(row?.n ?? 0);
}

export function buildReassessEfficiency(db: Database): ReassessEfficiency {
  const since = R.metaGet(db, "reassess_counter_since");
  const llmCalls = Number(R.metaGet(db, "reassess_llm_calls_total") ?? 0);
  const gateSkips = Number(R.metaGet(db, "reassess_gate_skips_total") ?? 0);
  const ticks = llmCalls + gateSkips;
  const tradedMatches = tradedMatchCount(db, since);
  const callsPerTradedMatch = tradedMatches > 0 ? r2(llmCalls / tradedMatches) : null;
  let verdict: ReassessEfficiency["verdict"] = "insufficient";
  if (callsPerTradedMatch != null && tradedMatches >= 3) {
    verdict = callsPerTradedMatch < BASELINE_CALLS_PER_MATCH.min ? "below_baseline"
      : callsPerTradedMatch <= BASELINE_CALLS_PER_MATCH.max ? "within_baseline" : "above_baseline";
  }
  return {
    since, llmCalls, gateSkips,
    gateSkipRatioPct: ticks > 0 ? r2((gateSkips / ticks) * 100) : null,
    tradedMatches, callsPerTradedMatch, baseline: BASELINE_CALLS_PER_MATCH, verdict,
    note: "calls/traded-match vs база 26–42. below_baseline = P0.4 gate снизил мельницу. Знаменатель — футбольные входы с момента anchor.",
  };
}
