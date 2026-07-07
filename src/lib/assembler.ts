// ============================================================
// EDGE LAB — deterministic analysis assembler (no LLM).
//
// Folds the Layer-1 base analysis and an optional Layer-2 category delta (e.g. the
// World Cup modifier) into one final distribution — pure arithmetic only, so the
// numbers never "drift": all the math is taken away from the model and done here.
//   1) apply category core_adjustments to base.core (multiply/add, reasoned only),
//   2) derive the whole market from the final core by Poisson,
//   3) merge + apply overrides (base + category), renormalising the tied groups,
//   4) merge metadata (drivers, scenarios, calibration±deltas, unknowns, notes).
// ============================================================

import { applyCoreAdjustments, applyOverrides, derivePoissonMarkets, type AnalysisCore, type AnalysisOverride, type DerivedMarkets, type CoreAdjustLog } from "./poisson.js";
import type { FootballAnalysis, CategoryDelta } from "./llm.js";

export interface AssembledAnalysis {
  matchType: FootballAnalysis["matchType"];
  matchTypeReason: string;
  core: AnalysisCore;
  overrides: AnalysisOverride[];
  drivers: FootballAnalysis["drivers"];
  scenarios: FootballAnalysis["scenarios"];
  calibration: FootballAnalysis["calibration"];
  unknowns: string[];
  categoryNotes: string;
  derived: DerivedMarkets;
  coreLog: CoreAdjustLog[]; // debug: which core_adjustments applied / were dropped
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** A scenario node is only useful for live management if it says HOW the
 *  distribution moves — a trigger plus either real `shifts` or a note. A node
 *  with empty shifts AND empty note is garbage (declares an event, tells the
 *  live layer nothing) and is dropped. */
function usefulScenario(s: FootballAnalysis["scenarios"][number]): boolean {
  if (!s || !s.trigger || !String(s.trigger).trim()) return false;
  const hasShifts = !!s.shifts && typeof s.shifts === "object" && Object.keys(s.shifts).length > 0;
  const hasNote = typeof s.note === "string" && s.note.trim().length > 0;
  return hasShifts || hasNote;
}

export function assembleFootball(base: FootballAnalysis, category: CategoryDelta | null): AssembledAnalysis {
  const useCat = !!category?.ok;

  // 1) core = base.core with category core_adjustments applied.
  const { core, log: coreLog } = useCat ? applyCoreAdjustments(base.core, category!.coreAdjustments) : { core: base.core, log: [] as CoreAdjustLog[] };

  // 2) derive the whole market from the final core; 3) merge + apply overrides.
  const derived = derivePoissonMarkets(core);
  const overrides: AnalysisOverride[] = [...base.overrides, ...(useCat ? category!.overrideAdjustments : [])];
  applyOverrides(derived, overrides);

  // 4) merge metadata.
  const calibration = { ...base.calibration };
  if (useCat) {
    calibration.xg_confidence = clamp01(calibration.xg_confidence + category!.confidenceXgDelta);
    calibration.scenario_confidence = clamp01(calibration.scenario_confidence + category!.confidenceScenarioDelta);
  }

  return {
    matchType: base.matchType,
    matchTypeReason: base.matchTypeReason,
    core,
    overrides,
    drivers: [...base.drivers, ...(useCat ? category!.newDrivers : [])],
    scenarios: [...base.scenarios, ...(useCat ? category!.newScenarios : [])].filter(usefulScenario),
    calibration,
    unknowns: base.unknowns,
    categoryNotes: useCat ? category!.notes : "",
    derived,
    coreLog,
  };
}
