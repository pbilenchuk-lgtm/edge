// ============================================================
// EDGE LAB — provider coverage negative-cache (per provider × league).
//
// "fixture not resolved" for Sportmonks on swe.1 is a COVERAGE fact — the provider
// doesn't map that league — NOT a per-match one. So instead of re-resolving every
// tick on every match of an unsupported league (30 dead ~950ms calls per match),
// we mute the (provider, league) pair after a few consecutive not-resolved failures
// and drop to a SLOW re-probe. Soft, not permanent (mappings can appear late), and a
// TIMEOUT is transient (network blip) — it never mutes a genuinely covered league.
// ============================================================

import type { ProviderCoverageRow } from "./repo.js";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

// Consecutive not-resolved failures before muting the whole league.
export const COVERAGE_FAIL_THRESHOLD = (() => num(process.env.PROVIDER_COVERAGE_FAIL_THRESHOLD, 5))();
// While muted, re-probe the provider only this often (minutes) instead of every tick.
export const COVERAGE_SLOW_RETRY_MIN = (() => num(process.env.PROVIDER_COVERAGE_SLOW_RETRY_MIN, 20))();

export type FetchOutcome = "resolved" | "not_resolved" | "transient";

/** Classify a fetchProvider result for coverage purposes. A resolved provider ref means
 *  the mapping EXISTS (coverage confirmed) even if the data fetch then blipped. A
 *  "…not resolved" error means no mapping (a coverage gap). Anything else — timeout,
 *  unreachable, HTTP error — is a transient network failure and must NOT mute a league. */
export function classifyFetchOutcome(r: { resolvedRef?: string | null; error?: string | null; ok?: boolean }): FetchOutcome {
  if (r.resolvedRef) return "resolved";
  if (r.error && /not resolved/i.test(r.error)) return "not_resolved";
  return "transient";
}

/** Should we actually CALL the provider for this league this tick? True unless the pair
 *  is muted and the slow re-probe window hasn't elapsed. */
export function shouldCallProvider(state: ProviderCoverageRow | null, nowMs: number): boolean {
  if (!state || !state.muted_until) return true;
  return (Date.parse(state.muted_until) || 0) <= nowMs; // mute window elapsed → re-probe
}

/** Whether a call was SKIPPED because the pair is currently muted (for logging/tests). */
export function isMuted(state: ProviderCoverageRow | null, nowMs: number): boolean {
  return !!state?.muted_until && (Date.parse(state.muted_until) || 0) > nowMs;
}

/** Next coverage row after a call with the given outcome. Pure. */
export function nextCoverage(
  provider: string, league: string, prev: ProviderCoverageRow | null, outcome: FetchOutcome, nowIso: string,
): ProviderCoverageRow {
  const nowMs = Date.parse(nowIso) || Date.now();
  const base = prev ?? { provider, league, consec_fail: 0, muted_until: null, last_probe_at: null, updated_at: nowIso };
  if (outcome === "resolved") {
    return { ...base, consec_fail: 0, muted_until: null, last_probe_at: nowIso, updated_at: nowIso };
  }
  if (outcome === "not_resolved") {
    const consec = base.consec_fail + 1;
    const muted = consec >= COVERAGE_FAIL_THRESHOLD ? new Date(nowMs + COVERAGE_SLOW_RETRY_MIN * 60_000).toISOString() : base.muted_until;
    return { ...base, consec_fail: consec, muted_until: muted, last_probe_at: nowIso, updated_at: nowIso };
  }
  // transient: don't advance the fail count (a covered league mustn't mute on a blip). If we
  // were already muted, push the next re-probe out so a transient during re-probe doesn't
  // hammer every tick; a healthy (unmuted) league is left untouched.
  const muted = base.muted_until ? new Date(nowMs + COVERAGE_SLOW_RETRY_MIN * 60_000).toISOString() : null;
  return { ...base, muted_until: muted, last_probe_at: nowIso, updated_at: nowIso };
}
