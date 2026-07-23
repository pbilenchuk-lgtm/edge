// ============================================================
// EDGE LAB — risk-profile identity + isolation  [SERVER-ONLY]
//
// Owner decision 23.07.2026 (option b): the super-risky profile formerly `rp-lite-mrca9dz8` is legitimized
// and RENAMED to `max`. Its config (Kelly ×0.50, no calibration floor) is kept AS-IS — that is now design,
// not a default. Two permanent rules live here:
//
//   1. canonicalProfileId — legacy `rp-lite*` ids fold to `max` at READ time. History is NOT rewritten in the
//      DB (we avoid "reconstructing history" everywhere else too); readers alias old→new so the line glues.
//   2. MAIN_PROFILE_IDS — every VERDICT cut / gate computes its main line over the aggressive/medium/
//      conservative TRIO only, and shows `max` as a separate line beside it. max trades a DIFFERENT set of
//      entries (no calibration floor), so mixing it in breaks both Model-A purity (same-input size comparison)
//      and gate readability.
// ============================================================

export const MAX_PROFILE_ID = "max";
export const MAIN_PROFILE_IDS = ["aggressive", "medium", "conservative"] as const;
// The legacy super-risky id(s). The live profile is `rp-lite-mrca9dz8`; match the whole `rp-lite` family so a
// differently-suffixed clone folds too. Kept narrow (prefix) so a real profile named e.g. "rapid" never folds.
const LEGACY_MAX_RE = /^rp-lite/i;

/** Fold a legacy super-risky profile id (`rp-lite*`) to `max`; every other id passes through unchanged. */
export function canonicalProfileId(id: string | null | undefined): string {
  const s = String(id ?? "");
  return LEGACY_MAX_RE.test(s) ? MAX_PROFILE_ID : s;
}

/** True for the super-risky `max` profile (or any legacy `rp-lite*` alias of it). */
export function isMaxProfile(id: string | null | undefined): boolean {
  return canonicalProfileId(id) === MAX_PROFILE_ID;
}

/** True for one of the three MAIN profiles that make up a verdict cut's main line. */
export function isMainProfile(id: string | null | undefined): boolean {
  return (MAIN_PROFILE_IDS as readonly string[]).includes(canonicalProfileId(id));
}
