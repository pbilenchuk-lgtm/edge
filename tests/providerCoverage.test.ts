import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import {
  classifyFetchOutcome, shouldCallProvider, isMuted, nextCoverage,
  COVERAGE_FAIL_THRESHOLD, COVERAGE_SLOW_RETRY_MIN,
} from "../src/lib/providerCoverage.js";

const T0 = "2026-07-13T18:00:00.000Z";
const plusMin = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

test("classifyFetchOutcome: resolved / not_resolved / transient are distinguished", () => {
  assert.equal(classifyFetchOutcome({ resolvedRef: "12345" }), "resolved");
  assert.equal(classifyFetchOutcome({ resolvedRef: "12345", ok: false, error: "sportmonks unreachable" }), "resolved", "a mapping exists even if the data fetch blipped");
  assert.equal(classifyFetchOutcome({ resolvedRef: null, error: "fixture not resolved" }), "not_resolved");
  assert.equal(classifyFetchOutcome({ resolvedRef: null, error: "match not resolved" }), "not_resolved");
  assert.equal(classifyFetchOutcome({ resolvedRef: null, error: "timeout" }), "transient");
  assert.equal(classifyFetchOutcome({ resolvedRef: null, error: "sportmonks unreachable" }), "transient");
});

test("nextCoverage: a run of not-resolved mutes the league at the threshold, then slow-probes", () => {
  let cov = null as any;
  for (let i = 1; i < COVERAGE_FAIL_THRESHOLD; i++) {
    cov = nextCoverage("sportmonks", "swe.1", cov, "not_resolved", T0);
    assert.equal(cov.consec_fail, i);
    assert.equal(cov.muted_until, null, `not muted yet at ${i} failures`);
    assert.ok(shouldCallProvider(cov, Date.parse(T0)), "still calling before the threshold");
  }
  cov = nextCoverage("sportmonks", "swe.1", cov, "not_resolved", T0); // Nth failure → mute
  assert.equal(cov.consec_fail, COVERAGE_FAIL_THRESHOLD);
  assert.ok(cov.muted_until, "muted at the threshold");
  const t = Date.parse(T0);
  assert.ok(isMuted(cov, t), "muted right after");
  assert.ok(!shouldCallProvider(cov, t + 60_000), "skipped inside the mute window");
  assert.ok(shouldCallProvider(cov, t + (COVERAGE_SLOW_RETRY_MIN + 1) * 60_000), "re-probes after the slow window");
});

test("nextCoverage: a resolve clears the mute; a transient never mutes a healthy league", () => {
  const muted = nextCoverage("sportmonks", "swe.1", { provider: "sportmonks", league: "swe.1", consec_fail: 9, muted_until: plusMin(T0, 20), last_probe_at: T0, updated_at: T0 }, "resolved", plusMin(T0, 21));
  assert.equal(muted.consec_fail, 0);
  assert.equal(muted.muted_until, null, "resolved clears the mute");
  // Transient on a healthy (unmuted) league → no mute, no fail bump.
  const healthy = nextCoverage("thestatsapi", "eng.1", null, "transient", T0);
  assert.equal(healthy.consec_fail, 0);
  assert.equal(healthy.muted_until, null, "a network blip must not mute a covered league");
});

test("provider_coverage repo round-trips", () => {
  const db = openDb(":memory:");
  R.upsertProviderCoverage(db, { provider: "sportmonks", league: "swe.1", consec_fail: 5, muted_until: plusMin(T0, 20), last_probe_at: T0, updated_at: T0 });
  const got = R.getProviderCoverage(db, "sportmonks", "swe.1");
  assert.equal(got?.consec_fail, 5);
  assert.equal(got?.muted_until, plusMin(T0, 20));
  // upsert updates in place
  R.upsertProviderCoverage(db, { provider: "sportmonks", league: "swe.1", consec_fail: 0, muted_until: null, last_probe_at: plusMin(T0, 21), updated_at: plusMin(T0, 21) });
  assert.equal(R.getProviderCoverage(db, "sportmonks", "swe.1")?.consec_fail, 0);
  assert.equal(R.getProviderCoverage(db, "sportmonks", "swe.1")?.muted_until, null);
});
