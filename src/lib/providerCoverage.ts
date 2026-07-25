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
// [batch-9] Consecutive failures after which a league is treated as OUT OF PLAN rather than "unlucky".
// Prod evidence: Sportmonks on a World-Cup plan returned `fifa.world` cleanly (consec_fail 0) while every club
// league accumulated 16-235 consecutive not-resolved — those will never resolve, because the subscription does
// not include them. The old flat 20-minute retry treated a 5-failure league and a 235-failure league
// identically and re-probed both forever, so ~250 hopeless resolutions burned per day AND — the real cost —
// the system could never SAY «this is plan scope, not an outage». Five days passed with Sportmonks
// contributing nothing before anyone noticed.
export const COVERAGE_OUT_OF_PLAN_AT = (() => num(process.env.PROVIDER_COVERAGE_OUT_OF_PLAN_AT, 50))();
// Cap for the escalating re-probe backoff (minutes). A hopeless league still gets a daily probe, so a plan
// upgrade or a late mapping is picked up on its own — muting is soft by design, never permanent.
export const COVERAGE_MAX_RETRY_MIN = (() => num(process.env.PROVIDER_COVERAGE_MAX_RETRY_MIN, 1440))();

/** Re-probe interval for a league with `consec` consecutive not-resolved failures: the slow retry, doubled
 *  per full threshold-worth of failures, capped. 5 fails → 20m; 15 → 80m; 50+ → a daily probe. Pure. */
export function coverageRetryMin(consec: number): number {
  const steps = Math.max(0, Math.floor(consec / Math.max(1, COVERAGE_FAIL_THRESHOLD)) - 1);
  return Math.min(COVERAGE_MAX_RETRY_MIN, COVERAGE_SLOW_RETRY_MIN * Math.pow(2, steps));
}

export type CoverageScope = "healthy" | "degraded" | "out_of_plan";
/** What the failure history MEANS, so an owner reads a verdict instead of a raw counter. */
export function coverageScope(state: ProviderCoverageRow | null): CoverageScope {
  const consec = state?.consec_fail ?? 0;
  if (consec >= COVERAGE_OUT_OF_PLAN_AT) return "out_of_plan";
  return consec >= COVERAGE_FAIL_THRESHOLD ? "degraded" : "healthy";
}
/** One-line human verdict for the coverage report / weekly self-report. */
export function coverageVerdictNote(provider: string, league: string, state: ProviderCoverageRow | null): string {
  const consec = state?.consec_fail ?? 0;
  const scope = coverageScope(state);
  if (scope === "healthy") return `${provider}·${league}: покрытие в норме (подряд неудач ${consec})`;
  if (scope === "degraded") return `${provider}·${league}: деградация — ${consec} неудач подряд, перепрос раз в ${coverageRetryMin(consec)}м`;
  return `${provider}·${league}: ВНЕ ПЛАНА — ${consec} неудач подряд, лига не резолвится структурно (подписка её не покрывает). Перепрос снижен до ${coverageRetryMin(consec)}м. Решение экономическое: расширить план или отключить провайдера для этой лиги — инженерно тут чинить нечего.`;
}

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
    // Escalating backoff: the longer a league has been failing, the less often it is worth asking. A league
    // that is out of plan (50+ consecutive) drops to a daily probe instead of every 20 minutes forever.
    const muted = consec >= COVERAGE_FAIL_THRESHOLD ? new Date(nowMs + coverageRetryMin(consec) * 60_000).toISOString() : base.muted_until;
    return { ...base, consec_fail: consec, muted_until: muted, last_probe_at: nowIso, updated_at: nowIso };
  }
  // transient: don't advance the fail count (a covered league mustn't mute on a blip). If we
  // were already muted, push the next re-probe out so a transient during re-probe doesn't
  // hammer every tick; a healthy (unmuted) league is left untouched.
  const muted = base.muted_until ? new Date(nowMs + coverageRetryMin(base.consec_fail) * 60_000).toISOString() : null;
  return { ...base, muted_until: muted, last_probe_at: nowIso, updated_at: nowIso };
}
