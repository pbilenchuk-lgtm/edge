// ============================================================
// EDGE LAB — Z4 (batch-5) REASSESS-THROTTLE AUDIT  [SERVER-ONLY, READ-ONLY]
//
// The live loop reassesses an open position on every trigger. Quiet matches already cost 0 LLM calls
// (P0.4 dead-trigger disarm), but a TRADED match burns 31–55 calls (Portland: 55 on 4 entries). The
// proposed throttle: reassess only on (a HARD event: goal/red/penalty) OR (|Δ position price| ≥ 5¢) OR
// (a timeout since the last reassessment), else a deterministic hold with NO LLM.
//
// Before enabling it we MEASURE on history: the throttle must not skip a single exit it could actually
// lose. Key distinction: the throttle only skips an LLM REASSESSMENT. Deterministic-guard exits (edge-gone,
// stop, phantom-floor, time-stop, gap-wake) run every tick REGARDLESS of whether the LLM was reassessed —
// the throttle cannot lose them. The only exits at risk are DISCRETIONARY ones: an exit the strategist
// (the LLM) decided at a reassessment — trade-log tag «· стратег: …» (lifecycle exit line, the strategist
// path). If its driving reassessment is skipped, that exit doesn't happen.
//
// So this report (1) shows the storm composition — which triggers hammer, the input to threshold
// calibration — and (2) counts DISCRETIONARY exits whose nearest preceding reassessment is a
// THROTTLE-CANDIDATE trigger (time / price_move), i.e. strategist exits the throttle might have gated.
// Deterministic exits that merely landed near a periodic reassessment are NOT counted (they'd fire anyway).
// It still errs strict inside the discretionary set (attributes to the nearest candidate reassessment
// without checking the price-move magnitude). verdict "safe_to_enable" only when that at-risk count is 0.
// Pure read; changes no behaviour and never enables the throttle.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

const THROTTLE_CANDIDATE = new Set(["time", "price_move"]); // the triggers the proposed throttle would gate
// How close (min) a reassessment must precede an exit to be considered its driver.
const NEAR_MIN = (() => { const n = Number(process.env.REASSESS_AUDIT_NEAR_MIN); return Number.isFinite(n) && n > 0 ? n : 3; })();
// A DISCRETIONARY (LLM-decided) exit — the only kind the throttle can lose — is tagged «стратег:» in the
// trade-log text (the strategist exit path). Deterministic-guard exits carry no such tag and fire anyway.
const isDiscretionaryExit = (text: string): boolean => text.includes("стратег:");

export interface ReassessAuditMatch { match: string; comp: string; reassessments: number; byTrigger: Record<string, number>; exits: number; discretionaryExits: number; atRiskExits: number }
export interface ReassessAudit {
  totalReassessments: number;
  byTrigger: Record<string, number>;
  throttleCandidateShare: number; // fraction of reassessments that are time/price_move (what the throttle gates)
  executedExits: number;
  discretionaryExits: number;     // exits the strategist (LLM) decided — the only exits the throttle could lose
  atRiskExits: number;            // discretionary exits whose nearest preceding reassessment is a throttle-candidate
  perMatch: ReassessAuditMatch[]; // worst (most reassessments) first
  verdict: "safe_to_enable" | "not_safe" | "insufficient";
  criterion: string;
  note: string;
}

export function buildReassessAudit(db: Database): ReassessAudit {
  const byTrigger: Record<string, number> = {};
  let totalReassessments = 0, executedExits = 0, discretionaryExits = 0, atRiskExits = 0;
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
    let mAtRisk = 0, mDiscretionary = 0;
    for (const ex of exits) {
      executedExits++;
      // Deterministic-guard exits fire every tick no matter what the throttle skips → not losable. Only a
      // strategist-decided exit can vanish when its reassessment is skipped; count only those as at-risk.
      if (!isDiscretionaryExit(ex.text)) continue;
      discretionaryExits++; mDiscretionary++;
      const exMs = Date.parse(ex.created_at) || 0;
      // nearest reassessment at or before the exit, within NEAR_MIN
      let nearest: (typeof rsSorted)[number] | null = null;
      for (const r of rsSorted) { const t = Date.parse(r.created_at) || 0; if (t <= exMs && exMs - t <= NEAR_MIN * 60_000) nearest = r; }
      if (nearest && THROTTLE_CANDIDATE.has(nearest.trigger ?? "")) { atRiskExits++; mAtRisk++; }
    }
    perMatch.push({ match: `${m.home} — ${m.away}`, comp, reassessments: rs.length, byTrigger: mByTrigger, exits: exits.length, discretionaryExits: mDiscretionary, atRiskExits: mAtRisk });
  }
  perMatch.sort((a, b) => b.reassessments - a.reassessments);
  const candidate = Object.entries(byTrigger).filter(([t]) => THROTTLE_CANDIDATE.has(t)).reduce((s, [, n]) => s + n, 0);
  const throttleCandidateShare = totalReassessments ? Math.round((candidate / totalReassessments) * 1000) / 1000 : 0;
  const criterion = `throttle включаем ТОЛЬКО когда at-risk дискреционных выходов = 0 на истории (пропущенный выход стратега воссоздать нельзя). Троттл срезает только ПЕРЕОЦЕНКУ ИИ — детерминированные стопы/защиты срабатывают на каждом тике независимо, их не потерять. Триггеры-кандидаты троттла: ${[...THROTTLE_CANDIDATE].join("/")}; окно привязки ${NEAR_MIN}м.`;
  const verdict: ReassessAudit["verdict"] = totalReassessments === 0 ? "insufficient" : atRiskExits === 0 ? "safe_to_enable" : "not_safe";
  const note = totalReassessments === 0
    ? "нет переоценок в истории — измерять нечего (копим)"
    : atRiskExits === 0
      ? `${totalReassessments} переоценок, ${executedExits} выходов (из них ${discretionaryExits} дискреционных = решённых стратегом); 0 дискреционных привязаны к троттл-кандидатному триггеру → троттл НИ ОДНОГО выхода стратега бы не срезал (детерминированные стопы срабатывают независимо): критерий выполнен, можно включать (пороги калибровать по составу шторма ниже)`
      : `${atRiskExits} из ${discretionaryExits} дискреционных выходов (всего выходов ${executedExits}) рядом с троттл-кандидатным триггером (time/price_move) — троттл МОГ БЫ пропустить решение стратега на выход. НЕ включать, пока не 0; разобрать эти выходы по perMatch (поле discretionaryExits>0)`;
  return { totalReassessments, byTrigger, throttleCandidateShare, executedExits, discretionaryExits, atRiskExits, perMatch, verdict, criterion, note };
}
