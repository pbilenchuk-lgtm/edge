// ============================================================
// EDGE LAB — Z4 (batch-5) REASSESS-THROTTLE AUDIT  [SERVER-ONLY, READ-ONLY]
//
// The live loop reassesses an open position on every trigger. Quiet matches already cost 0 LLM calls
// (P0.4 dead-trigger disarm), but a TRADED match burns 31–55 calls (Portland: 55 on 4 entries). The
// proposed throttle: reassess only on (a HARD event: goal/red/penalty) OR (|Δ position price| ≥ 5¢) OR
// (a timeout since the last reassessment), else a deterministic hold with NO LLM.
//
// Before enabling it we MEASURE on history: the throttle must not skip a single ACTUALLY-EXECUTED exit
// (a skipped exit can't be undone). This report is that measurement. It (1) shows the storm composition —
// which triggers hammer, the input to threshold calibration — and (2) conservatively counts executed
// exits whose nearest preceding reassessment is a THROTTLE-CANDIDATE trigger (time / price_move), i.e.
// exits the throttle might have gated. Over-counting is deliberate (it includes deterministic exits that
// merely landed near a periodic reassessment) so the zero-miss gate errs strict. verdict "safe_to_enable"
// only when the at-risk count is 0. Pure read; changes no behaviour and never enables the throttle.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

const THROTTLE_CANDIDATE = new Set(["time", "price_move"]); // the triggers the proposed throttle would gate
// How close (min) a reassessment must precede an exit to be considered its driver.
const NEAR_MIN = (() => { const n = Number(process.env.REASSESS_AUDIT_NEAR_MIN); return Number.isFinite(n) && n > 0 ? n : 3; })();

export interface ReassessAuditMatch { match: string; comp: string; reassessments: number; byTrigger: Record<string, number>; exits: number; atRiskExits: number }
export interface ReassessAudit {
  totalReassessments: number;
  byTrigger: Record<string, number>;
  throttleCandidateShare: number; // fraction of reassessments that are time/price_move (what the throttle gates)
  executedExits: number;
  atRiskExits: number;            // executed exits whose nearest preceding reassessment is a throttle-candidate
  perMatch: ReassessAuditMatch[]; // worst (most reassessments) first
  verdict: "safe_to_enable" | "not_safe" | "insufficient";
  criterion: string;
  note: string;
}

export function buildReassessAudit(db: Database): ReassessAudit {
  const byTrigger: Record<string, number> = {};
  let totalReassessments = 0, executedExits = 0, atRiskExits = 0;
  const perMatch: ReassessAuditMatch[] = [];
  const footballMatchIds = R.listCompetitions(db).filter((c) => c.sport_id === "football")
    .flatMap((c) => R.listMatches(db, c.id).map((m) => ({ comp: c.id, m })));
  for (const { comp, m } of footballMatchIds) {
    const rs = R.reassessmentsForMatch(db, m.id);
    if (!rs.length) continue;
    const mByTrigger: Record<string, number> = {};
    for (const r of rs) { const t = r.trigger ?? "?"; mByTrigger[t] = (mByTrigger[t] ?? 0) + 1; byTrigger[t] = (byTrigger[t] ?? 0) + 1; }
    totalReassessments += rs.length;
    // Executed exits for the match, each attributed to its nearest PRECEDING reassessment.
    const exits = R.tradeLogForMatch(db, m.id).filter((e) => e.type === "exit");
    const rsSorted = [...rs].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    let mAtRisk = 0;
    for (const ex of exits) {
      executedExits++;
      const exMs = Date.parse(ex.created_at) || 0;
      // nearest reassessment at or before the exit, within NEAR_MIN
      let nearest: (typeof rsSorted)[number] | null = null;
      for (const r of rsSorted) { const t = Date.parse(r.created_at) || 0; if (t <= exMs && exMs - t <= NEAR_MIN * 60_000) nearest = r; }
      if (nearest && THROTTLE_CANDIDATE.has(nearest.trigger ?? "")) { atRiskExits++; mAtRisk++; }
    }
    perMatch.push({ match: `${m.home} — ${m.away}`, comp, reassessments: rs.length, byTrigger: mByTrigger, exits: exits.length, atRiskExits: mAtRisk });
  }
  perMatch.sort((a, b) => b.reassessments - a.reassessments);
  const candidate = Object.entries(byTrigger).filter(([t]) => THROTTLE_CANDIDATE.has(t)).reduce((s, [, n]) => s + n, 0);
  const throttleCandidateShare = totalReassessments ? Math.round((candidate / totalReassessments) * 1000) / 1000 : 0;
  const criterion = `throttle включаем ТОЛЬКО когда at-risk-выходов = 0 на истории (пропущенный исполненный выход резать нельзя). Триггеры-кандидаты троттла: ${[...THROTTLE_CANDIDATE].join("/")}; окно привязки ${NEAR_MIN}м.`;
  const verdict: ReassessAudit["verdict"] = totalReassessments === 0 ? "insufficient" : atRiskExits === 0 ? "safe_to_enable" : "not_safe";
  const note = totalReassessments === 0
    ? "нет переоценок в истории — измерять нечего (копим)"
    : atRiskExits === 0
      ? `${totalReassessments} переоценок, ${executedExits} исполненных выходов, 0 из них привязаны к троттл-кандидатному триггеру → троттл НИ ОДНОГО выхода бы не срезал: критерий выполнен, можно включать (пороги калибровать по составу шторма ниже)`
      : `${atRiskExits} из ${executedExits} выходов рядом с троттл-кандидатным триггером (time/price_move) — троттл МОГ БЫ их пропустить (оценка консервативная, включает и детерминированные выходы). НЕ включать, пока не 0; разобрать эти выходы по perMatch`;
  return { totalReassessments, byTrigger, throttleCandidateShare, executedExits, atRiskExits, perMatch, verdict, criterion, note };
}
