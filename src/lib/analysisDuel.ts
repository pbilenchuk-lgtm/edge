// ============================================================
// EDGE LAB — two-model ANALYSIS duel (head-to-head accuracy test).
//
// To find out which model analyses matches better, we don't run both on the same
// match (double cost) — we ALTERNATE: each match is analysed by exactly one of two
// models, chosen by a stable hash of its id (≈50/50, idempotent so pre_lineup and
// post_lineup re-analysis pick the SAME model). Every match's analysis logs (base xG,
// probs, calibration) and its resulting bets are tagged with which model produced
// them (via the model tag folded into `code_version`), so after 5-10 matches the
// «Профили» tab and the match logs compare the two head-to-head: calibration of the
// predicted probs and CLV of the bets each model's analysis drove.
//
// Default: OFF (single configured analytics model). Turn ON via env ANALYSIS_DUEL —
// "on" uses the default pair (Opus 4.8 vs Fable 5); the production deploy sets it in
// render.yaml. Code default stays off so it's an explicit, reversible experiment.
// §9.6 untouched — this only chooses which model reasons and labels the output.
// ============================================================

import { resolveModel } from "./llm.js";

export interface AnalysisDuel { enabled: boolean; models: [string, string]; }

const DEFAULT_A = "Claude Opus 4.8";
const DEFAULT_B = "Claude Fable 5";

/**
 * Load the duel config from env. OFF by default (explicit, reversible experiment).
 *   ANALYSIS_DUEL unset / "off"/"0"/…   → OFF (single configured analytics model)
 *   ANALYSIS_DUEL "on"                   → ON, default pair (Opus 4.8 vs Fable 5)
 *   ANALYSIS_DUEL "Model A | Model B"    → ON with that pair (split on | , or ;)
 * A pair that doesn't resolve, or isn't two DISTINCT models, disables the duel so a
 * typo can't silently break analysis on half the slate.
 */
export function loadAnalysisDuel(env: Record<string, string | undefined> = process.env): AnalysisDuel {
  const raw = (env.ANALYSIS_DUEL ?? "").trim();
  if (raw === "" || /^(off|0|false|no)$/i.test(raw)) return { enabled: false, models: [DEFAULT_A, DEFAULT_B] };
  let a = DEFAULT_A, b = DEFAULT_B;
  if (!/^on$/i.test(raw)) {
    const parts = raw.split(/[|,;]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) { a = parts[0]; b = parts[1]; }
  }
  if (!resolveModel(a) || !resolveModel(b) || a === b) return { enabled: false, models: [a, b] };
  return { enabled: true, models: [a, b] };
}

/** Deterministic per-match model pick — stable across re-analysis, balanced ~50/50 by a
 *  hash of the match id (NOT arrival order, so it's idempotent and unbiased). */
export function pickAnalysisModel(matchId: string, duel: AnalysisDuel): string {
  let h = 0;
  for (let i = 0; i < matchId.length; i++) h = (h * 31 + matchId.charCodeAt(i)) | 0;
  return duel.models[Math.abs(h) % 2];
}

/** Short label-safe slug of a model for the code_version tag ("Claude Opus 4.8" → "opus48"). */
export function analysisModelTag(model: string): string {
  return model.toLowerCase().replace(/claude\s+/g, "").replace(/[^a-z0-9]+/g, "").slice(0, 12) || "model";
}
