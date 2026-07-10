import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase, migrateSharesToAggressive, migrateSharesAllPairs, migrateSharesGrid, migrateSeedStrategists, migratePrematchValueV3, migrateOverreactionV2, migrateLiveXgV2 } from "../src/lib/seed.js";
import { assembleFootball } from "../src/lib/assembler.js";
import { distributionContext, strategistContext } from "../src/lib/analysis.js";
import { normalizeStrategistJson } from "../src/lib/llm.js";
import { seedRiskProfiles } from "../src/lib/riskConfig.js";
import { loadPolymarketConfig } from "../src/lib/polymarket.js";
import * as R from "../src/lib/repo.js";

test("loadPolymarketConfig: taker fee defaults to the real Polymarket SPORTS rate (0.75%)", () => {
  assert.equal(loadPolymarketConfig({}).exec.takerFeeRate, 0.0075);
  // env still overrides for a schedule change
  assert.equal(loadPolymarketConfig({ POLYMARKET_TAKER_FEE_RATE: "0.01" }).exec.takerFeeRate, 0.01);
});

test("migrateSharesAllPairs: every football category gets all 3×3 pairs, evenly, once", () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Футбол");
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-a", sport_id: "football", name: "A", budget: 900, external_league: null, created_at: "t" });
  R.upsertCompetition(db, { id: "pm-tennis", sport_id: "tennis", name: "T", budget: 900, external_league: null, created_at: "t" });

  migrateSharesAllPairs(db, "t");

  const rows = R.sharesForComp(db, "pm-a");
  assert.equal(rows.length, 9, "3 strategists × 3 profiles = 9 pairs");
  assert.deepEqual([...new Set(rows.map((r) => r.risk_profile_id))].sort(), ["aggressive", "conservative", "medium"]);
  assert.deepEqual([...new Set(rows.map((r) => r.strategy_id))].sort(), ["live_xg", "overreaction", "prematch_value"]);
  assert.ok(rows.every((r) => r.pct === rows[0].pct), "funds split evenly across pairs");
  assert.ok(rows[0].pct > 11 && rows[0].pct < 12, `~11.11% each, got ${rows[0].pct}`);
  // non-football category untouched
  assert.equal(R.sharesForComp(db, "pm-tennis").length, 0, "tennis has no strategists → no pairs");
  // idempotent — a later manual reallocation survives a re-run
  R.clearShares(db, "pm-a");
  migrateSharesAllPairs(db, "t2");
  assert.equal(R.sharesForComp(db, "pm-a").length, 0, "re-run no-ops after the marker is set");
});

test("migrateSharesGrid: funds only ESPN-covered categories; live_xg only on WC; uncovered defunded", () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "pm-csl", sport_id: "football", name: "CSL", budget: 8000, external_league: null, created_at: "t" });        // UNCOVERED (no ESPN league)
  R.upsertCompetition(db, { id: "pm-epl", sport_id: "football", name: "EPL", budget: 1200, external_league: "eng.1", created_at: "t" });     // covered, non-WC
  R.upsertCompetition(db, { id: "pm-soccer-fifwc", sport_id: "football", name: "ЧМ", budget: 1200, external_league: "fifa.world", created_at: "t" }); // WC
  seedRiskProfiles(db, "t"); // 3 presets

  migrateSharesGrid(db, "t");
  // Uncovered (external_league=null) → DEFUNDED: no shares, budget 0.
  assert.equal(R.sharesForComp(db, "pm-csl").length, 0, "uncovered CSL gets no shares");
  assert.equal(R.listCompetitions(db).find((c) => c.id === "pm-csl")!.budget, 0, "uncovered CSL defunded to $0");
  // Covered non-WC: overreaction + prematch_value → 2 × 3 = 6, no live_xg.
  const rowsEpl = R.sharesForComp(db, "pm-epl");
  assert.equal(rowsEpl.length, 6, "covered non-WC: 2 strategists × 3 profiles");
  assert.ok(!rowsEpl.some((r) => r.strategy_id === "live_xg"), "non-WC has NO live_xg pair");
  // WC: all three → 3 × 3 = 9, includes live_xg.
  const rowsWc = R.sharesForComp(db, "pm-soccer-fifwc");
  assert.equal(rowsWc.length, 9, "WC: 3 strategists × 3 profiles");
  assert.ok(rowsWc.some((r) => r.strategy_id === "live_xg"), "WC keeps live_xg");
  // $1000/pair on the funded ones.
  assert.equal(R.listCompetitions(db).find((c) => c.id === "pm-epl")!.budget, 6000, "EPL budget = 6 × $1000");
  assert.equal(R.listCompetitions(db).find((c) => c.id === "pm-soccer-fifwc")!.budget, 9000, "WC budget = 9 × $1000");

  // profile set change re-lays; uncovered stays empty
  R.upsertRiskProfile(db, { id: "lite", name: "Lite", content: JSON.stringify({}), sort: 9, created_at: "t" });
  migrateSharesGrid(db, "t2");
  assert.equal(R.sharesForComp(db, "pm-csl").length, 0, "uncovered stays defunded after re-lay");
  assert.equal(R.sharesForComp(db, "pm-epl").length, 8, "covered non-WC: 2 × 4");
  assert.equal(R.sharesForComp(db, "pm-soccer-fifwc").length, 12, "WC: 3 × 4");

  // stable profile set → a manual reallocation survives (no re-run)
  R.setShare(db, { competition_id: "pm-epl", strategy_id: "overreaction", risk_profile_id: "lite", pct: 40 });
  migrateSharesGrid(db, "t3");
  assert.equal(R.sharesForComp(db, "pm-epl").find((r) => r.strategy_id === "overreaction" && r.risk_profile_id === "lite")!.pct, 40, "manual edit preserved while profile set unchanged");
});

test("reconcileFootballCategories: backfills mapping, funds covered-unfunded, deletes proven-blind", async () => {
  const { reconcileFootballCategories, migrateSeedStrategists } = await import("../src/lib/seed.js");
  const { espnLeagueForSeries } = await import("../src/lib/engine.js");
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Футбол");
  seedRiskProfiles(db, "t");
  migrateSeedStrategists(db, "t"); // register the 3 strategists so the grid has pairs
  const mkMatch = (id: string, comp: string, state: "upcoming" | "live" | "finished") => R.insertMatch(db, { id, competition_id: comp, home: "H", away: "A", state, lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });

  // (1) UCL: mapping missing at import (external_league null), one upcoming match — must be BACKFILLED + FUNDED, never deleted.
  R.upsertCompetition(db, { id: "pm-uefa-champions-league", sport_id: "football", name: "UEFA Champions League", budget: 0, external_league: null, created_at: "t" });
  mkMatch("m-ucl", "pm-uefa-champions-league", "upcoming");
  // (2) EPL: already mapped but UNFUNDED (budget 0, no shares), with an observed live match — must be FUNDED.
  R.upsertCompetition(db, { id: "pm-epl", sport_id: "football", name: "EPL", budget: 0, external_league: "eng.1", created_at: "t" });
  mkMatch("m-epl", "pm-epl", "finished");
  R.upsertMatchLive(db, { match_id: "m-epl", espn_event_id: "e1", league: "eng.1", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  // (3) CSL: unmapped (no provider will ever cover it), only a NOT-FILLED phantom
  // bet, and an UPCOMING match — must STILL be DELETED (pending doesn't save an
  // unmapped category now that StatPal/TheStatsAPI are gone).
  R.upsertCompetition(db, { id: "pm-chinese-super-league", sport_id: "football", name: "Chinese Super League", budget: 0, external_league: null, created_at: "t" });
  mkMatch("m-csl", "pm-chinese-super-league", "upcoming");
  R.insertBet(db, { id: "b-csl", match_id: "m-csl", strategy_id: R.listStrategies(db, "football")[0].id, market_label: "Over 2.5", status: "not_filled", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.5, stake: 0, rationale: null, entered_minute: null, result: null, payout: null, created_at: "t" });
  // (4) Botola: UNMAPPABLE (ESPN doesn't cover), all finished, never observed, but
  // carries REAL P&L → KEPT (never destroy settled history), even though blind.
  R.upsertCompetition(db, { id: "pm-morocco-botola", sport_id: "football", name: "Morocco Botola", budget: 0, external_league: null, created_at: "t" });
  mkMatch("m-bo", "pm-morocco-botola", "finished");
  R.insertBet(db, { id: "b-bo", match_id: "m-bo", strategy_id: R.listStrategies(db, "football")[0].id, market_label: "Over 2.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 60, closing_price: 55, ai_prob: 0.5, stake: 100, rationale: null, entered_minute: "3'", result: "won", payout: 120, created_at: "t" });

  const r = reconcileFootballCategories(db, "t2", espnLeagueForSeries);

  // UCL backfilled + funded, still present.
  const ucl = R.listCompetitions(db).find((c) => c.id === "pm-uefa-champions-league");
  assert.equal(ucl?.external_league, "uefa.champions", "UCL mapping backfilled");
  assert.ok(ucl!.budget > 0, "UCL funded after backfill");
  assert.ok(R.sharesForComp(db, "pm-uefa-champions-league").length > 0, "UCL got its share grid");
  // EPL funded.
  assert.ok(R.listCompetitions(db).find((c) => c.id === "pm-epl")!.budget > 0, "covered-unfunded EPL funded");
  assert.ok(R.sharesForComp(db, "pm-epl").length > 0);
  // CSL deleted despite an upcoming match (unmapped → no provider ever).
  assert.equal(R.listCompetitions(db).find((c) => c.id === "pm-chinese-super-league"), undefined, "unmapped CSL deleted even with a pending match");
  // Botola kept (real P&L) despite being unmapped + never observed.
  assert.ok(R.listCompetitions(db).find((c) => c.id === "pm-morocco-botola"), "P&L-bearing category preserved");

  assert.equal(r.backfilled, 1, "one backfill (UCL)");
  assert.ok(r.funded >= 2, "UCL + EPL funded");
  assert.equal(r.deleted, 1, "one deletion (CSL)");

  // idempotent second run: no further changes.
  const r2 = reconcileFootballCategories(db, "t3", espnLeagueForSeries);
  assert.deepEqual(r2, { backfilled: 0, funded: 0, deleted: 0 }, "second run is a no-op");
});

test("migrateSharesToAggressive: every share → aggressive, live bets retagged, idempotent", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // sanity: seeded shares exist on some competition
  const comp = R.listCompetitions(db).find((c) => R.sharesForComp(db, c.id).length > 0)!;
  assert.ok(comp, "a seeded competition has shares");
  const before = R.sharesForComp(db, comp.id);
  const totalBefore = before.reduce((a, s) => a + s.pct, 0);
  assert.ok(before.some((s) => s.risk_profile_id !== "aggressive"), "starts on a non-aggressive profile");

  // a live bet tagged medium should be retagged; a settled one must NOT be
  const strat = before[0].strategy_id;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 10, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertBet(db, { id: "open-1", match_id: mid, strategy_id: strat, risk_profile_id: "medium", market_label: "X", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.5, stake: 100, rationale: null, entered_minute: "10'", result: null, payout: null, settled_by: null, created_at: "t" });
  R.insertBet(db, { id: "done-1", match_id: mid, strategy_id: strat, risk_profile_id: "medium", market_label: "Y", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 100, closing_price: 100, ai_prob: 0.5, stake: 100, rationale: null, entered_minute: "10'", result: "won", payout: 200, settled_by: "settlement", created_at: "t" });

  migrateSharesToAggressive(db, "2026-07-07T00:00:00Z");

  const after = R.sharesForComp(db, comp.id);
  assert.ok(after.every((s) => s.risk_profile_id === "aggressive"), "all shares now aggressive");
  assert.equal(after.reduce((a, s) => a + s.pct, 0), totalBefore, "total pct preserved");
  assert.equal(R.getBet(db, "open-1")!.risk_profile_id, "aggressive", "open bet retagged");
  assert.equal(R.getBet(db, "done-1")!.risk_profile_id, "medium", "settled bet keeps its historical tag");

  // idempotent — a later manual switch back to medium survives a re-run
  R.setShare(db, { competition_id: comp.id, strategy_id: strat, risk_profile_id: "medium", pct: 5 });
  migrateSharesToAggressive(db, "2026-07-08T00:00:00Z");
  assert.ok(R.sharesForComp(db, comp.id).some((s) => s.risk_profile_id === "medium"), "re-run is a no-op after the marker is set");
});

test("migratePrematchValueV3: brings prompts to v3 once, bumps version, idempotent", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  migrateSeedStrategists(db, "2026-01-01T00:00:00Z"); // ensure the roster exists
  // Simulate an existing DB carrying pre-v3 prompts.
  R.updateStrategy(db, "prematch_value", { prompt: "СТАРЫЙ предматч промпт", prompt_live: "СТАРЫЙ live промпт" });
  const v0 = R.getStrategy(db, "prematch_value")!.version;

  migratePrematchValueV3(db);
  const s = R.getStrategy(db, "prematch_value")!;
  assert.ok(s.prompt.includes("v3.1 · 6-branch"), "prematch prompt updated to v3");
  assert.ok((s.prompt_live ?? "").includes("v3.1 · 6-branch"), "live prompt updated to v3");
  assert.ok(s.prompt.includes("outcome_scenarios"), "v3 references the 6-branch tree");
  assert.equal(s.version, v0 + 1, "version bumped once (prior archived)");

  migratePrematchValueV3(db); // marker present now → no-op
  assert.equal(R.getStrategy(db, "prematch_value")!.version, v0 + 1, "idempotent: no re-bump on re-run");
});

test("migrateOverreactionV2: brings prompts to v2 once, bumps version, idempotent", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  migrateSeedStrategists(db, "2026-01-01T00:00:00Z");
  R.updateStrategy(db, "overreaction", { prompt: "СТАРЫЙ overreaction", prompt_live: "СТАРЫЙ live" });
  const v0 = R.getStrategy(db, "overreaction")!.version;

  migrateOverreactionV2(db);
  const s = R.getStrategy(db, "overreaction")!;
  assert.ok(s.prompt.includes("OVERREACTION (v2)"), "prematch prompt updated to v2");
  assert.ok((s.prompt_live ?? "").includes("OVERREACTION (v2)"), "live prompt updated to v2");
  assert.ok((s.prompt_live ?? "").includes("live_triggers_armed"), "live window reads the armed triggers");
  assert.equal(s.version, v0 + 1, "version bumped once");

  migrateOverreactionV2(db);
  assert.equal(R.getStrategy(db, "overreaction")!.version, v0 + 1, "idempotent: no re-bump");
});

test("migrateLiveXgV2: brings prompts to v2 once, bumps version, idempotent", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  migrateSeedStrategists(db, "2026-01-01T00:00:00Z");
  R.updateStrategy(db, "live_xg", { prompt: "СТАРЫЙ live_xg", prompt_live: "СТАРЫЙ live" });
  const v0 = R.getStrategy(db, "live_xg")!.version;

  migrateLiveXgV2(db);
  const s = R.getStrategy(db, "live_xg")!;
  assert.ok(s.prompt.includes("LIVE xG MOMENTUM (v2)"), "prematch prompt updated to v2");
  assert.ok((s.prompt_live ?? "").includes("LIVE xG MOMENTUM (v2)"), "live prompt updated to v2");
  assert.ok(s.prompt.includes("match_shape"), "prematch threshold keys off match_shape");
  assert.equal(s.version, v0 + 1, "version bumped once");

  migrateLiveXgV2(db);
  assert.equal(R.getStrategy(db, "live_xg")!.version, v0 + 1, "idempotent: no re-bump");
});

// The invariant that closes the whole class of "prompt references data the engine
// never passes" bugs: for each strategist, every data key its v-latest prompt
// references must appear in the context the engine actually assembles.
test("INVARIANT: each strategist's context carries the data its prompt references", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  migrateSeedStrategists(db, "2026-01-01T00:00:00Z");
  migratePrematchValueV3(db); migrateOverreactionV2(db); migrateLiveXgV2(db);

  // A live football match: lineups (matchContext), a live-xG snapshot (the stream
  // Live xG needs), and a distribution artifact (the tree + match_shape + scenarios).
  const comp = R.listCompetitions(db)[0]!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "France", away: "Morocco", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: null, league: null, home_lineup: JSON.stringify({ team: "France", formation: "4-3-3", starters: ["Maignan", "Koundé"] }), away_lineup: JSON.stringify({ team: "Morocco", formation: "4-1-4-1", starters: ["Bounou"] }), stats: null, updated_at: "t" });
  R.insertProviderSnapshot(db, { match_id: mid, batch_at: "2026-01-01T00:05:00Z", provider: "sportmonks", phase: "live", ok: true, http_status: 200, provider_ref: "x", minute: 30, latency_ms: 100, extracted: { xg: { present: true, home: 1.2, away: 0.3 } }, raw: null });
  const base = { ok: true, matchType: "knockout" as const, matchTypeReason: "", core: { xg_home: 1.75, xg_away: 1.05, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0.03 }, overrides: [], drivers: [], scenarios: [{ trigger: "ранний гол андердога", prob: 0.25, shifts: null, note: "рынок переоценит" }], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 0, notes: "" }, unknowns: [] };
  R.saveArtifact(db, { match_id: mid, kind: "distribution", stage: "post_lineup", content: JSON.stringify(assembleFootball(base, null)), model: "x", created_at: "2026-01-01T00:00:00Z" });

  const ctx = strategistContext(db, mid)!;
  // ── Presence AND validity (a field that is present-but-degenerate is the next,
  //    quieter failure: it passes a "field exists" check yet leaves the strategist
  //    without usable data). So assert the values are real, not just present. ──
  // Live xG (prematch threshold) + Pre-match Value key off match_shape — and it
  // must be a REAL shape, not "?"/"unavailable".
  assert.match(ctx, /match_shape=(A|B|C|mixed)\b/, "match_shape present AND a real value (not ?)");
  // Pre-match Value reasons over the 6-branch tree: all six ids present with weights.
  for (const id of ["fav_clean", "fav_concedes", "draw_0_0", "draw_scoring", "dog_clean", "dog_concedes"]) assert.ok(ctx.includes(id), `context names branch ${id}`);
  const weights = [...ctx.matchAll(/вес=([\d.]+)/g)].map((m) => Number(m[1]));
  assert.equal(weights.length, 6, "six branch weights are rendered");
  assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 0.02, `branch weights sum to ~1, got ${weights.reduce((a, b) => a + b, 0)}`);
  assert.ok(weights.every((w) => w > 0), "no branch is a degenerate zero-weight");
  // Overreaction + Pre-match Value read the event scenarios — at least one real node.
  assert.match(ctx, /Событийные сценарии \(scenarios\): •/, "event scenarios present AND non-empty");
  // Live xG Momentum needs the live-xG stream with REAL numbers (not an empty line).
  assert.match(ctx, /Live xG \([^)]*\): дом [\d.]+ – [\d.]+ гости · перекос [\d.]+/, "live-xG stream present AND numeric");

  // Cross-check against the source of truth: the distribution's derived tree.
  const dist = JSON.parse(R.artifactsForMatch(db, mid).find((a) => a.kind === "distribution")!.content);
  assert.equal(dist.derived.outcome_scenarios.length, 6, "distribution carries exactly 6 branches");
  assert.ok(Math.abs(dist.derived.outcome_scenarios.reduce((s: number, b: any) => s + b.prob, 0) - 1) < 1e-3, "source weights sum to 1 (rounded probs; raw is exact by the poisson guard)");

  // Battle-sheet-carried arming: present AND non-empty (an empty array/object is the
  // same quiet failure — "arming survived" but there is nothing to execute).
  const bs = (extra: object) => JSON.stringify({ pair: "p", positions: [], ...extra });
  const armed = normalizeStrategistJson({ pre_match_positions: [], live_triggers_armed: [{ scenario_trigger: "гол андердога", buyback_target: "38¢" }] });
  assert.ok(Array.isArray(armed.liveTriggersArmed) && armed.liveTriggersArmed.length > 0, "overreaction arming is captured non-empty");
  assert.match(bs({ live_triggers_armed: armed.liveTriggersArmed }), /scenario_trigger/, "arming survives into the battle sheet with content");
  const cfg = normalizeStrategistJson({ pre_match_positions: [], live_entry_config: { xg_gap_threshold: 1.2, min_pressure_duration_min: 20 } });
  assert.ok(cfg.liveEntryConfig && (cfg.liveEntryConfig as any).xg_gap_threshold === 1.2, "live_xg config captured with a real threshold");
  // "present but empty" must NOT masquerade as armed: an empty array/object is dropped.
  assert.equal(normalizeStrategistJson({ live_triggers_armed: [] }).liveTriggersArmed, undefined, "empty armed array is not captured");
  assert.equal(normalizeStrategistJson({ live_entry_config: {} }).liveEntryConfig, undefined, "empty config object is not captured");
});

test("distributionContext: formats the 6-branch tree + scenarios for the strategist", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db)[0]!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "France", away: "Morocco", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  assert.equal(distributionContext(db, mid), undefined, "no artifact → undefined");

  const base = { ok: true, matchType: "knockout" as const, matchTypeReason: "", core: { xg_home: 1.75, xg_away: 1.05, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0.03 }, overrides: [], drivers: [], scenarios: [{ trigger: "ранний гол фаворита", prob: 0.3, shifts: null, note: "рынок переоценивает" }], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 0, notes: "" }, unknowns: [] };
  const as = assembleFootball(base, null);
  R.saveArtifact(db, { match_id: mid, kind: "distribution", stage: "pre_lineup", content: JSON.stringify(as), model: "x", created_at: "2026-01-01T00:00:00Z" });

  const ctx = distributionContext(db, mid)!;
  assert.match(ctx, /match_shape=/, "carries match_shape");
  for (const id of ["fav_clean", "fav_concedes", "draw_0_0", "draw_scoring", "dog_clean", "dog_concedes"]) assert.ok(ctx.includes(id), `mentions ${id}`);
  assert.match(ctx, /→ET/, "marks the extra-time draw branches");
  assert.match(ctx, /total_note=/, "carries the concedes total_note");
  assert.match(ctx, /ранний гол фаворита/, "carries the event scenarios");
});
