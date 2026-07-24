// ============================================================
// EDGE LAB — OVERREACTION EDGE-GATE COUNTER  [SERVER-ONLY, read-only]
//
// The football Overreaction verdict (CLV + win% + P&L agreement) is only readable once the strategy has
// accumulated ENOUGH clean cycles — the pre-set sample gate is n≥30. Until then the edge is a rumour, not a
// result. That progress ("6/30") lived only in my head across chats; a mute counter that no report exposes is
// exactly the «немой ноль» this codebase keeps fixing. This makes it DATA.
//
// A cycle COUNTS toward the gate iff it is:
//   • football strategy_id='overreaction' (the live-buyback cohort, not PMV / tennis)
//   • terminally settled by RESOLUTION — settled_won / settled_lost (a real grade on the final score),
//     NOT void and NOT an early/partial cash-out (settled_by 'early'/'partial' are discretionary, not a
//     verdict-bearing outcome)
//   • on the CLEAN epoch — code-epoch ≥ e5 (pre-e5 numbers mean something different)
//   • SAME-epoch — entry and exit under one rule-set (crossEpoch cycles are governed by two, quarantined)
// verdict = "gate_open" once cleanCycles ≥ 30, else "accruing". Read-only; never writes.
// Exposed at GET /api/real?report=overreaction_gate.
// ============================================================

import type { Database } from "./db.js";
import { codeEpochOf, crossEpoch } from "./codeEpoch.js";

/** e5 → 5, "e7·m1·opus48" → 7, "" / legacy → 0. The numeric code-epoch used for the clean-epoch gate. */
function epochNum(cv: string | null | undefined): number {
  const m = /^e(\d+)/.exec(codeEpochOf(cv));
  return m ? Number(m[1]) : 0;
}

export interface OverreactionGate {
  target: number;              // the pre-set sample gate (30)
  cleanEpochMin: number;       // clean-epoch floor (5 = e5)
  cleanCycles: number;         // settled resolution cycles that COUNT (the gate numerator)
  progress: string;            // e.g. "6/30"
  won: number; lost: number;
  excluded: { void: number; cashOut: number; preEpoch: number; crossEpoch: number; settleSuspect: number };
  byEpoch: Record<string, { won: number; lost: number }>;
  verdict: "gate_open" | "accruing";
  note: string;
}

/** Count clean-epoch, same-epoch, resolution-settled Overreaction cycles against the n≥30 gate. */
export function buildOverreactionGate(db: Database, target = 30, cleanEpochMin = 5): OverreactionGate {
  const rows = db.prepare(
    `SELECT b.status, b.settled_by, b.code_version, b.exit_code_version, b.settle_suspect
       FROM bets b JOIN matches m ON m.id = b.match_id JOIN competitions c ON c.id = m.competition_id
      WHERE c.sport_id = 'football' AND b.strategy_id = 'overreaction'
        AND b.status IN ('settled_won','settled_lost','settled_void')`,
  ).all() as { status: string; settled_by: string | null; code_version: string | null; exit_code_version: string | null; settle_suspect: number | null }[];

  let cleanCycles = 0, won = 0, lost = 0;
  const excluded = { void: 0, cashOut: 0, preEpoch: 0, crossEpoch: 0, settleSuspect: 0 };
  const byEpoch: Record<string, { won: number; lost: number }> = {};
  for (const b of rows) {
    // P1(б): a two-leg-mislabel settle (settle_suspect=1) is a wrong grade on the final score — it must not
    // count toward the clean-cycle gate. Exclude before any won/lost tally; count it so the exclusion is visible.
    if (Number(b.settle_suspect) === 1) { excluded.settleSuspect++; continue; }
    if (b.status === "settled_void") { excluded.void++; continue; }
    // early/partial = discretionary cash-out; not a verdict-bearing outcome. null/resolution settle counts.
    if (b.settled_by === "early" || b.settled_by === "partial") { excluded.cashOut++; continue; }
    if (epochNum(b.code_version) < cleanEpochMin) { excluded.preEpoch++; continue; }
    if (crossEpoch(b)) { excluded.crossEpoch++; continue; }
    cleanCycles++;
    const won1 = b.status === "settled_won";
    if (won1) won++; else lost++;
    const ep = codeEpochOf(b.code_version) || "e?";
    const e = (byEpoch[ep] ??= { won: 0, lost: 0 });
    if (won1) e.won++; else e.lost++;
  }

  const verdict: OverreactionGate["verdict"] = cleanCycles >= target ? "gate_open" : "accruing";
  const note = verdict === "gate_open"
    ? `✅ ГЕЙТ ОТКРЫТ: ${cleanCycles}/${target} чистых Overreaction-циклов — выборки достаточно, вердикт (CLV+win%+P&L) можно читать`
    : `⏳ КОПИМ: ${cleanCycles}/${target} чистых циклов (won ${won} / lost ${lost}) — до n≥30 вердикт по Overreaction ещё преждевременный; исключено ${excluded.void} void, ${excluded.cashOut} кэш-аут, ${excluded.preEpoch} до-e5, ${excluded.crossEpoch} cross-epoch, ${excluded.settleSuspect} settle_suspect (two-leg мислейбл)`;
  return { target, cleanEpochMin, cleanCycles, progress: `${cleanCycles}/${target}`, won, lost, excluded, byEpoch, verdict, note };
}
