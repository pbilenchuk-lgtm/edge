import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { recordSvShadowSignal, resolveSvShadowSignals, buildSvShadowCalibration, svRetroCohort, buildSvCohort, SV_SHADOW_EPOCH } from "../src/lib/tennisSetValueShadow.js";

const TRIG = "2026-07-22T18:14:00.000Z";  // set-2 trigger time
const NOW = "2026-07-22T19:30:00.000Z";

function seedMatch(db: any, id: string, opts: { favIsP1: boolean; finalFavSets: number; finalOppSets: number; set2FavPrices: number[] }) {
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-wta", sport_id: "tennis", name: "WTA", budget: 0, external_league: null, created_at: "t" });
  R.insertMatch(db, { id, competition_id: "pm-wta", home: "Fav", away: "Opp", state: "finished", lineup_out: true, kickoff_at: "2026-07-22T16:55:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: id } as any);
  const snap = (o: any) => R.insertTennisSnapshot(db, { event_key: "W", provider: "apitennis", p1: "Fav", p2: "Opp", tournament: "WTA Palermo", event_type: "WTA Singles", game_points: null, server: null, pm_match_id: id, pm_mid_cents: null, raw: JSON.stringify({ event_winner: opts.finalFavSets > opts.finalOppSets ? (o.favIsP1 ? "First Player" : "Second Player") : (o.favIsP1 ? "Second Player" : "First Player") }), ...o } as any);
  const favCol = opts.favIsP1 ? "pm_p1_cents" : "pm_p2_cents";
  const oppCol = opts.favIsP1 ? "pm_p2_cents" : "pm_p1_cents";
  // prematch snapshot BEFORE kickoff — favourite strong at 66¢
  snap({ batch_at: "2026-07-22T16:50:00Z", live: 1, status: "Set 1", sets_p1: 0, sets_p2: 0, set_num: 0, games_p1: 0, games_p2: 0, [favCol]: 66, [oppCol]: 34, favIsP1: opts.favIsP1 });
  // set 1: favourite lost 5-7
  snap({ batch_at: "2026-07-22T17:40:00Z", live: 1, status: "Set 1", sets_p1: opts.favIsP1 ? 0 : 1, sets_p2: opts.favIsP1 ? 1 : 0, set_num: 1, games_p1: opts.favIsP1 ? 5 : 7, games_p2: opts.favIsP1 ? 7 : 5, [favCol]: 33, [oppCol]: 67, favIsP1: opts.favIsP1 });
  // set 2 price path (after the trigger)
  opts.set2FavPrices.forEach((p, i) => snap({ batch_at: `2026-07-22T18:${20 + i}:00Z`, live: 1, status: "Set 2", sets_p1: opts.favIsP1 ? 0 : 1, sets_p2: opts.favIsP1 ? 1 : 0, set_num: 2, games_p1: 2, games_p2: 3, [favCol]: p, [oppCol]: 100 - p, favIsP1: opts.favIsP1 }));
  // final snapshot
  snap({ batch_at: "2026-07-22T19:10:00Z", live: 0, status: "Finished", sets_p1: opts.favIsP1 ? opts.finalFavSets : opts.finalOppSets, sets_p2: opts.favIsP1 ? opts.finalOppSets : opts.finalFavSets, set_num: 3, games_p1: 6, games_p2: 4, [favCol]: opts.finalFavSets > opts.finalOppSets ? 100 : 0, [oppCol]: opts.finalFavSets > opts.finalOppSets ? 0 : 100, favIsP1: opts.favIsP1 });
}

const input = (matchId: string, favSide: "first" | "second", extra: any = {}): any =>
  ({ matchId, tour: "WTA Palermo", eventType: "WTA Singles", favSide, favToken: "tokF", firstIsP1: favSide === "first", prematchMlCents: 66, prematchSrc: "prematch", triggerCents: 33, set1GamesFav: 5, set1GamesOpp: 7, setNum: 2, edgeConst: 0.17, epoch: SV_SHADOW_EPOCH, at: TRIG, ...extra });

test("record: one row per match (dedup); a repeat trigger bumps hits, adds NO row", () => {
  const db = openDb(":memory:"); initSchema(db); seedMatch(db, "m1", { favIsP1: true, finalFavSets: 2, finalOppSets: 1, set2FavPrices: [33, 40, 58] });
  recordSvShadowSignal(db, input("m1", "first"));
  recordSvShadowSignal(db, input("m1", "first")); // same match → dedup
  const rows = db.prepare(`SELECT hits FROM sv_shadow_signals`).all() as any[];
  assert.equal(rows.length, 1, "one row per match");
  assert.equal(rows[0].hits, 2, "repeat bumped hits");
});

test("resolve: comeback (fav wins 2-1) → set2 won + match won; price path min/max captured", () => {
  const db = openDb(":memory:"); initSchema(db); seedMatch(db, "m1", { favIsP1: true, finalFavSets: 2, finalOppSets: 1, set2FavPrices: [33, 40, 58] });
  recordSvShadowSignal(db, input("m1", "first"));
  const r = resolveSvShadowSignals(db, { now: () => NOW });
  assert.equal(r.resolved, 1); assert.equal(r.unresolved, 0);
  const row = db.prepare(`SELECT status, set2_outcome, match_outcome, min_cents, max_cents FROM sv_shadow_signals`).get() as any;
  assert.equal(row.status, "resolved");
  assert.equal(row.set2_outcome, "won", "fav reached ≥1 set = won set 2");
  assert.equal(row.match_outcome, "won", "fav reached 2 sets = won match");
  assert.equal(row.min_cents, 33, "drawdown floor over set 2");
  assert.equal(row.max_cents, 58, "take available over set 2");
});

test("resolve: collapse (fav loses 0-2) → set2 lost + match lost", () => {
  const db = openDb(":memory:"); initSchema(db); seedMatch(db, "m2", { favIsP1: false, finalFavSets: 0, finalOppSets: 2, set2FavPrices: [33, 20, 9] });
  recordSvShadowSignal(db, input("m2", "second"));
  const r = resolveSvShadowSignals(db, { now: () => NOW });
  assert.equal(r.resolved, 1);
  const row = db.prepare(`SELECT set2_outcome, match_outcome, min_cents FROM sv_shadow_signals`).get() as any;
  assert.equal(row.set2_outcome, "lost");
  assert.equal(row.match_outcome, "lost");
  assert.equal(row.min_cents, 9, "collapse captured as the drawdown");
});

test("P1.1 retro cohort: reconstructs a favourite-lost-set-1 comeback from snapshot history (prices, not decisions)", () => {
  const db = openDb(":memory:");
  initSchema(db);
  // fav = first, prematch 66¢, lost set 1 (0-1), came back to win 2-1
  seedMatch(db, "m1", { favIsP1: true, finalFavSets: 2, finalOppSets: 1, set2FavPrices: [33, 58] });
  // fav = second, prematch 66¢, lost set 1, collapsed 0-2
  seedMatch(db, "m2", { favIsP1: false, finalFavSets: 0, finalOppSets: 2, set2FavPrices: [33, 9] });
  const rows = svRetroCohort(db);
  assert.equal(rows.length, 2, "both matches reconstructed from history");
  const m1 = rows.find((r) => r.set2 === "won")!;
  assert.equal(m1.match, "won");
  assert.equal(m1.prematchCents, 66, "frozen favourite strength from the pre-kickoff snapshot");
  assert.ok(rows.some((r) => r.set2 === "lost" && r.match === "lost"), "the collapse is captured");

  const cohort = buildSvCohort(db);
  assert.equal(cohort.sources.retro, 2);
  assert.equal(cohort.verdict, "insufficient", "2 << 40/80 thresholds");
  assert.ok(cohort.overall, "an overall verdict bin (≥60¢) exists");
  assert.equal(cohort.overall!.comebackSet2Pct, 50, "1 of 2 came back = 50% measured (vs the 0.5 guess)");
});

test("calibration: bins by favourite strength × tour; insufficient until n≥40; measured comeback% vs 0.5", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedMatch(db, "m1", { favIsP1: true, finalFavSets: 2, finalOppSets: 1, set2FavPrices: [33, 58] });
  seedMatch(db, "m2", { favIsP1: false, finalFavSets: 0, finalOppSets: 2, set2FavPrices: [33, 9] });
  recordSvShadowSignal(db, input("m1", "first"));
  recordSvShadowSignal(db, input("m2", "second"));
  resolveSvShadowSignals(db, { now: () => NOW });
  const cal = buildSvShadowCalibration(db);
  assert.equal(cal.counts.resolved, 2);
  assert.equal(cal.verdict, "insufficient", "2 << 40 verdict-bin threshold");
  assert.equal(cal.constComebackProb, 0.5);
  assert.ok(cal.overall, "overall bin exists");
  assert.equal(cal.overall!.n, 2);
  assert.equal(cal.overall!.comebackSet2Pct, 50, "1 of 2 came back = 50% measured");
});

test("T1 cap: capTennisSnapshots never evicts snapshots of a match with a PENDING shadow signal", () => {
  const db = openDb(":memory:");
  const ins = (mid: string, at: string) => R.insertTennisSnapshot(db, { event_key: "E", provider: "apitennis", batch_at: at, p1: "A", p2: "B", tournament: "T", event_type: "ATP Singles", live: 1, status: "live", sets_p1: 0, sets_p2: 1, set_num: 2, games_p1: 1, games_p2: 0, game_points: null, server: "first", pm_match_id: mid, pm_mid_cents: 40, pm_p1_cents: 40, pm_p2_cents: 60, raw: "{}" });
  ins("m-pending", "2026-07-20T10:00:00Z"); // OLD — but its shadow signal is unresolved
  ins("m-other", "2026-07-21T10:00:00Z");
  ins("m-other", "2026-07-22T10:00:00Z");
  db.prepare(`INSERT INTO sv_shadow_signals(id,match_id,trigger_cents,epoch,status,created_at) VALUES(?,?,?,?,?,?)`).run("sig1", "m-pending", 40, SV_SHADOW_EPOCH, "pending", "2026-07-20T10:00:00Z");
  // keep=1 would normally drop the 2 oldest — but the oldest belongs to a pending-shadow match.
  R.capTennisSnapshots(db, 1);
  const left = db.prepare(`SELECT DISTINCT pm_match_id AS m FROM tennis_snapshots`).all().map((r: any) => r.m).sort();
  assert.ok(left.includes("m-pending"), "the pending-shadow match's final snapshot survives (resolve can still read it)");
});
