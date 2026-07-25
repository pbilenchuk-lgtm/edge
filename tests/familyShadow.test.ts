import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { recordFamilyShadowSignal, resolveFamilyShadowSignals, buildFamilyShadow, killedFamilies, isDemotedFamily } from "../src/lib/familyShadow.js";

function db() { const d = openDb(":memory:"); initSchema(d); R.upsertSport(d, "football", "Football"); R.upsertCompetition(d, { id: "c", sport_id: "football", name: "MLS", budget: 8000, external_league: "usa.1", created_at: "t" }); return d; }
function finished(d: any, id: string, home: string, away: string, sh: number, sa: number) {
  R.insertMatch(d, { id, competition_id: "c", home, away, state: "finished", lineup_out: true, kickoff_at: "2026-07-20T18:00:00Z", minute: null, score_home: sh, score_away: sa, final_score: `${sh}:${sa}`, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
}
const rec = (d: any, matchId: string, label: string) => recordFamilyShadowSignal(d, { matchId, strategyId: "prematch_value", label, family: label.toLowerCase().includes("both teams") ? "btts" : "other", ourProb: 0.6, implied: 0.3, edge: 0.3, wouldBeStake: 100, entryCents: 30, kickoffAt: null, codeVersion: "e7·m1", at: "2026-07-20T12:00:00Z" });

test("isDemotedFamily: only prematch_value non-totals is demoted", () => {
  assert.equal(isDemotedFamily("prematch_value", "btts"), true);
  assert.equal(isDemotedFamily("prematch_value", "totals"), false);
  assert.equal(isDemotedFamily("overreaction", "btts"), false); // other strategies still trade every family
});

test("record → resolve: a demoted BTTS signal is graded from the final score, ZERO money (no bet row)", () => {
  const d = db();
  finished(d, "m1", "Alpha", "Beta", 2, 1);   // both scored → BTTS Yes wins
  rec(d, "m1", "Both Teams to Score — Yes");
  const r = resolveFamilyShadowSignals(d, { now: () => "t" });
  assert.equal(r.resolved, 1);
  const row = d.prepare(`SELECT status FROM family_shadow_signals WHERE match_id='m1'`).get() as any;
  assert.equal(row.status, "won");
  // the whole point: NO money moved — there is no bet, only a shadow row.
  assert.equal(R.allBets(d).length, 0, "a demoted family produces NO bet — capital untouched");
});

test("record dedups by (match, market, strategy) — a repeat bumps hits, not a second row", () => {
  const d = db();
  finished(d, "m1", "Alpha", "Beta", 1, 1);
  rec(d, "m1", "Both Teams to Score — Yes");
  rec(d, "m1", "Both Teams to Score — Yes");
  const rows = d.prepare(`SELECT hits FROM family_shadow_signals WHERE match_id='m1'`).all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hits, 2);
});

test("buildFamilyShadow: a thin cohort is insufficient, not killed", () => {
  const d = db();
  finished(d, "m1", "Alpha", "Beta", 0, 0);
  rec(d, "m1", "Both Teams to Score — Yes");
  resolveFamilyShadowSignals(d, { now: () => "t" });
  const rep = buildFamilyShadow(d);
  const btts = rep.verdicts.find((v) => v.family === "btts")!;
  assert.equal(btts.source, "shadow");
  assert.equal(btts.matured, "none");
  assert.deepEqual(rep.killed, []);
});

test("kill-switch: a MATURED-negative shadow family is killed (off money AND shadow)", () => {
  const d = db();
  // 30 decided shadow signals, all LOST, implied 30% → winPct 0% < 30% → negative verdict at n≥25.
  const now = "2026-07-20T12:00:00Z";
  for (let i = 0; i < 30; i++) {
    d.prepare(
      `INSERT INTO family_shadow_signals (id, match_id, strategy_id, market_label, family, side, our_prob, implied, edge, would_be_stake, entry_cents, kickoff_at, code_version, hits, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,'lost',?)`,
    ).run(R.uid(), `m${i}`, "prematch_value", "Both Teams to Score — Yes", "btts", "yes", 0.6, 0.3, 0.3, 100, 30, null, "e7·m1", now);
  }
  const killed = killedFamilies(d);
  assert.ok(killed.has("prematch_value|btts"), "matured-negative BTTS shadow family is killed");
  const rep = buildFamilyShadow(d);
  assert.ok(rep.killed.includes("prematch_value|btts"));
  assert.equal(rep.verdicts.find((v) => v.family === "btts")!.verdict, "negative");
});

test("kill-switch is empty when nothing has matured", () => {
  const d = db();
  finished(d, "m1", "Alpha", "Beta", 2, 0);
  rec(d, "m1", "Both Teams to Score — Yes");
  resolveFamilyShadowSignals(d, { now: () => "t" });
  assert.equal(killedFamilies(d).size, 0);
});
