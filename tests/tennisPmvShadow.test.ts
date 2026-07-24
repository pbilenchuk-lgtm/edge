import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { recordPmvShadowSignal, resolvePmvShadowSignals, buildPmvShadowCalibration } from "../src/lib/tennisPmvShadow.js";

const NOW = "2026-07-14T15:00:00.000Z";

function finishedMatch(db: any, id: string) {
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  R.insertMatch(db, { id, competition_id: "pm-atp", home: "Carlos Alcaraz", away: "Jannik Sinner", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: id } as any);
  // Second Player won 2-0 (sets 0-2), games 4-6 / 3-6 → 2 sets total, 19 games.
  R.insertTennisSnapshot(db, { event_key: "W", provider: "apitennis", batch_at: "2026-07-14T14:00:00Z", p1: "C. Alcaraz", p2: "J. Sinner", tournament: "ATP", event_type: "ATP Singles", live: 0, status: "Finished", sets_p1: 0, sets_p2: 2, set_num: 2, games_p1: 3, games_p2: 6, game_points: null, server: null, pm_match_id: id, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "Second Player", scores: [{ score_set: 1, score_first: 4, score_second: 6 }, { score_set: 2, score_first: 3, score_second: 6 }] }) } as any);
}
const sig = (over: number, extra: Partial<Parameters<typeof recordPmvShadowSignal>[1]> = {}): any =>
  ({ matchId: "m1", label: `ATP: Alcaraz vs Sinner Total Sets: ${over ? "Over" : "Under"} 2.5`, family: "total_sets", side: over ? "over" : "under", firstIsP1: true, theoCents: 60, midCents: 55, deviation: 5, delta: 3, bookUsd: 4000, tour: "atp", surface: "hard", epoch: "e5·shadow-s1", at: NOW, ...extra });

test("record: freezes one row per (match, prop); a repeat bumps hits, adds NO row", () => {
  const db = openDb(":memory:"); initSchema(db); finishedMatch(db, "m1");
  recordPmvShadowSignal(db, sig(0));
  recordPmvShadowSignal(db, sig(0)); // same match+label → dedup
  recordPmvShadowSignal(db, sig(1)); // different prop → new row
  const rows = db.prepare(`SELECT market_label, hits FROM pmv_shadow_signals ORDER BY market_label`).all() as any[];
  assert.equal(rows.length, 2, "two distinct props");
  const under = rows.find((r) => /Under/.test(r.market_label))!;
  assert.equal(under.hits, 2, "the repeated signal bumped hits, not a new row");
});

test("resolve: post-match via the same settlement code — Under 2.5 wins, Over 2.5 loses (2 sets)", () => {
  const db = openDb(":memory:"); initSchema(db); finishedMatch(db, "m1");
  recordPmvShadowSignal(db, sig(0)); // Under 2.5 → should WIN (2 sets)
  recordPmvShadowSignal(db, sig(1)); // Over 2.5  → should LOSE
  const r = resolvePmvShadowSignals(db, { now: () => NOW });
  assert.equal(r.resolved, 2); assert.equal(r.unresolved, 0);
  const st = (label: RegExp) => (db.prepare(`SELECT status FROM pmv_shadow_signals WHERE market_label LIKE ?`).get("%" + (label.source.includes("Under") ? "Under" : "Over") + "%") as any).status;
  assert.equal(st(/Under/), "won");
  assert.equal(st(/Over/), "lost");
});

test("resolve: a match that is NOT finished stays pending (not a failure)", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  R.insertMatch(db, { id: "m1", competition_id: "pm-atp", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  recordPmvShadowSignal(db, sig(0));
  const r = resolvePmvShadowSignals(db, { now: () => NOW });
  assert.equal(r.resolved + r.unresolved, 0);
  assert.equal((db.prepare(`SELECT status FROM pmv_shadow_signals`).get() as any).status, "pending");
});

test("calibration: Brier markov vs implied on frozen mid; insufficient until n≥40; counts + repeats", () => {
  const db = openDb(":memory:"); initSchema(db);
  const ins = (status: string, theo: number, mid: number, hits = 1) =>
    db.prepare(`INSERT INTO pmv_shadow_signals (id, match_id, market_label, family, side, theo_cents, mid_cents, epoch, hits, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(R.uid(), "m" + Math.random(), "L" + Math.random(), "total_sets", "over", theo, mid, "e5·shadow-s1", hits, status, NOW);
  ins("won", 70, 60);       // markov (.7-1)^2=.09  implied (.6-1)^2=.16
  ins("lost", 40, 45, 3);   // markov (.4)^2=.16    implied (.45)^2=.2025 ; hits=3 → repeats +2
  ins("void", 50, 50);      // excluded from Brier
  ins("unresolved", 50, 50);
  ins("pending", 50, 50);
  const cal = buildPmvShadowCalibration(db);
  assert.equal(cal.scored, 2);
  assert.equal(cal.counts.won, 1); assert.equal(cal.counts.lost, 1); assert.equal(cal.counts.void, 1); assert.equal(cal.counts.unresolved, 1); assert.equal(cal.counts.pending, 1);
  assert.equal(cal.counts.repeats, 2, "the lost row re-fired twice (hits=3)");
  assert.equal(cal.brierMarkov, 0.125, `markov ${cal.brierMarkov}`);
  assert.equal(cal.brierImplied, 0.181, `implied ${cal.brierImplied} (0.18125 rounded to 3dp)`);
  assert.equal(cal.criterion.markovBeatsImplied, true, "model beats market here");
  assert.equal(cal.verdict, "insufficient", "n=2 < 40 → not matured (but no longer a MUTE zero)");
  assert.equal(cal.unresolvedPct, 25, "1 unresolved of 4 terminal");
});

test("C sideBias: a family×side whose model theo consistently overshoots reality is measured (optimismPp) and flagged", () => {
  const db = openDb(":memory:"); initSchema(db);
  // 12 matches, each a 2-set match → Over 2.5 (theo 60¢) LOSES every time = a systematic over-lean.
  for (let i = 0; i < 12; i++) {
    const id = `mo${i}`; finishedMatch(db, id);
    recordPmvShadowSignal(db, { matchId: id, label: `ATP: A vs B Total Sets: Over 2.5`, family: "total_sets", side: "over", firstIsP1: true, theoCents: 60, midCents: 55, deviation: 5, delta: 3, bookUsd: 4000, tour: "atp", surface: "hard", epoch: "e5·shadow-s1", at: NOW } as any);
  }
  resolvePmvShadowSignals(db, { now: () => NOW });
  const cal = buildPmvShadowCalibration(db);
  const over = cal.sideBias.find((b) => b.family === "total_sets" && b.side === "over")!;
  assert.equal(over.n, 12);
  assert.equal(over.winPctActual, 0, "Over 2.5 lost every 2-set match");
  assert.equal(over.theoMeanPct, 60, "model said 60% on average");
  assert.equal(over.optimismPp, 60, "measured over-optimism = theo − actual");
  assert.ok(cal.biasFlags.some((f) => f.includes("total_sets·over")), "the sized lean is flagged");
});
