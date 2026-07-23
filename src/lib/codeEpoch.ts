// ============================================================
// EDGE LAB — effective bet epoch = code epoch × model epoch.
//
// CODE_VERSION (betMeta.ts) is a source-level epoch we bump when a FIX changes what
// the numbers MEAN. But model choice (Opus vs Sonnet vs Fable, per stage) is ALSO an
// experiment we want to A/B — and it changes at RUNTIME from the Models screen, not in
// source. So bets carry a combined label `${CODE_VERSION}·m${N}`, where N is a monotone
// "model epoch" counter stored in app_meta and bumped every time a model assignment
// changes. Flipping analysis Opus→Fable therefore starts a fresh, self-describing epoch
// ("e5·m2") that the «Профили» tab already segments on — no code change, no manual
// version edit. §9.6 untouched: this only LABELS bets, it never sizes or moves money.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { CODE_VERSION } from "./betMeta.js";

const MODEL_EPOCH_KEY = "model_epoch";

/** Current model-epoch counter (≥1). Unset (pre-knob DB) reads as 1. */
export function modelEpoch(db: Database): number {
  const raw = R.metaGet(db, MODEL_EPOCH_KEY);
  const n = raw == null ? 1 : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** The label stamped on every new bet: code epoch × model epoch, e.g. "e5·m2". An
 *  optional model tag (from an active analysis duel) is appended so the two duel arms
 *  segment as distinct code_versions, e.g. "e5·m2·opus48" vs "e5·m2·fable5". */
export function effectiveCodeVersion(db: Database, modelTag?: string | null): string {
  const base = `${CODE_VERSION}·m${modelEpoch(db)}`;
  return modelTag ? `${base}·${modelTag}` : base;
}

/** The CODE-epoch part of an effective code_version label ("e5·m2·opus48" → "e5"). A DEPLOY that changes
 *  what the numbers mean bumps this; the model-epoch (·mN) and duel tag do not. Used by cross_epoch. */
export function codeEpochOf(cv: string | null | undefined): string { return cv ? String(cv).split("·")[0] : ""; }

/** п.2 (batch-4): a bet whose life spanned a deploy — its ENTRY code-epoch (code_version) differs from its
 *  EXIT code-epoch (exit_code_version, stamped at settle). Such cycles must be QUARANTINED from per-epoch
 *  verdict slices and exit-rule comparisons (the position was governed by two different rule-sets). Returns
 *  false when the exit epoch is unknown (never settled, or a pre-field historical bet) — safe default. */
export function crossEpoch(bet: { code_version?: string | null; exit_code_version?: string | null }): boolean {
  const inE = codeEpochOf(bet.code_version), outE = codeEpochOf(bet.exit_code_version);
  return inE !== "" && outE !== "" && inE !== outE;
}

/** Advance the model epoch (call once per model-assignment change). Returns the new
 *  epoch. Idempotent per change site — callers should only invoke it when a model
 *  value ACTUALLY changed, so the «Профили» dropdown doesn't fill with empty epochs. */
export function bumpModelEpoch(db: Database, nowIso: string): number {
  const next = modelEpoch(db) + 1;
  R.metaSet(db, MODEL_EPOCH_KEY, String(next), nowIso);
  return next;
}
