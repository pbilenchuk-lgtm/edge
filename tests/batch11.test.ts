import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { scoreConsistency, scoreTrustedForDisarm, SCORE_RACE_MAX_WAIT_SEC } from "../src/lib/scoreRace.js";
import { probeDrawCanon, buildDrawCanonProbe, PROBE_NEED_OBS } from "../src/lib/drawCanonProbe.js";

// ── G1: the score race that cost $263 ────────────────────────────────────────────────────────────
// Brann–Vålerenga: the reassessment fired ON the 41' goal and was handed a 0:1 snapshot, so the strategist
// reasoned that two more goals were still needed and held. enrichFromEspn writes the scoreboard score before
// fetching matchDetail, so the event list is newer than the score it would be answered with.

function brann(db: any, scoreHome: number, scoreAway: number, goalMinutes: number[]) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "Eliteserien", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertMatch(db, { id: "m-brann", competition_id: "c1", home: "SK Brann", away: "Vålerenga", state: "live",
    lineup_out: true, kickoff_at: "2026-07-27T16:00:00Z", minute: 42, score_home: scoreHome, score_away: scoreAway,
    final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m-brann" } as any);
  for (const min of goalMinutes) {
    R.insertMatchEvent(db, { id: R.uid(), match_id: "m-brann", event_key: `goal-${min}`, minute: min, type: "goal",
      team: "Vålerenga", text: `Goal at ${min}'`, created_at: "2026-07-27T16:42:00Z" });
  }
  return R.getMatch(db, "m-brann")!;
}

test("G1: a snapshot that lags its own goal feed is NOT reasoned on — the Brann timeline", () => {
  const db = openDb(":memory:"); initSchema(db);
  const now = Date.parse("2026-07-27T16:42:00Z");
  // The exact failure: two goals in the feed (24', 41'), scoreboard still says 0:1.
  const stale = brann(db, 0, 1, [24, 41]);
  const c = scoreConsistency(db, stale, now, {});
  assert.equal(c.ok, false, "2 goal events vs a 1-goal scoreboard — the snapshot is behind its own feed");
  assert.equal(c.goalEvents, 2); assert.equal(c.scoreTotal, 1);
  assert.match(c.reason, /обоснованно НЕВЕРНЫМ/, "and the reason says WHY waiting beats deciding");
  assert.equal(scoreTrustedForDisarm(c), false, "…so it also may not be used to stand a guard down");

  // Once the score catches up, the same call proceeds — this must not be a one-way latch.
  R.updateMatch(db, "m-brann", { score_home: 0, score_away: 2 });
  const fixed = scoreConsistency(db, R.getMatch(db, "m-brann")!, now, {});
  assert.equal(fixed.ok, true, "0:2 matches the two goals in the feed");
  assert.equal(fixed.forced, false, "and it is genuinely consistent, not forced through");
  assert.equal(scoreTrustedForDisarm(fixed), true);
});

test("G1: waiting is BOUNDED — a VAR-cancelled goal must not blank live management for the rest of the match", () => {
  const db = openDb(":memory:"); initSchema(db);
  const t0 = Date.parse("2026-07-27T16:42:00Z");
  const m = brann(db, 0, 1, [24, 41]);
  assert.equal(scoreConsistency(db, m, t0, {}).ok, false, "first sighting → wait");
  // The inconsistency never resolves (the goal was chalked off; the event row stays behind).
  const later = t0 + (SCORE_RACE_MAX_WAIT_SEC({}) + 1) * 1000;
  const forced = scoreConsistency(db, m, later, {});
  assert.equal(forced.ok, true, "past the deadline the call proceeds — a permanent wait would be a blackout");
  assert.equal(forced.forced, true, "…but it is flagged as forced, never passed off as consistent");
  assert.match(forced.reason, /VAR/, "and the note names the case that makes the deadline necessary");
  assert.equal(scoreTrustedForDisarm(forced), false,
    "G2: a forced read still may NOT disarm a stop — the two consumers fail in opposite directions on purpose");
});

test("G1: a match with no goals and no score is consistent, and a normal score is not held up", () => {
  const db = openDb(":memory:"); initSchema(db);
  const now = Date.parse("2026-07-27T16:42:00Z");
  const m0 = brann(db, 0, 0, []);
  assert.equal(scoreConsistency(db, m0, now, {}).ok, true, "0:0 with no goal events — nothing contradicts it");
  R.updateMatch(db, "m-brann", { score_home: 3, score_away: 1 });
  R.insertMatchEvent(db, { id: R.uid(), match_id: "m-brann", event_key: "g1", minute: 10, type: "goal", team: "SK Brann", text: "g", created_at: "t" });
  assert.equal(scoreConsistency(db, R.getMatch(db, "m-brann")!, now, {}).ok, true,
    "a scoreboard AHEAD of the feed is fine — the feed missing a goal never makes us hold a decision back");
});

// ── G5: measure the Draw canon before deciding anything about Draw ───────────────────────────────
function drawMatch(db: any, id: string) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertMatch(db, { id, competition_id: "c1", home: "A", away: "B", state: "live", lineup_out: true,
    kickoff_at: "2026-07-27T16:00:00Z", minute: 40, score_home: 0, score_away: 0, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
}

test("G5: the probe records what the canon WOULD pick and whether that book is simultaneously quarantined", () => {
  const db = openDb(":memory:"); initSchema(db);
  drawMatch(db, "m1");
  const markets = [{ label: "Draw — Yes" }, { label: "Draw — No" }, { label: "Draw (A vs. B) — Yes" }];
  const zombie = new Map<string, any>([["Draw — Yes", { code: "notation_desync", detail: "13¢" }]]);
  probeDrawCanon(db, "m1", markets, zombie, "2026-07-27T16:40:00Z", {});
  const rep = buildDrawCanonProbe(db);
  assert.equal(rep.observations, 1, "one observation recorded");
  assert.equal(rep.matches, 1);
  assert.equal(rep.mature, false, `one row is not ${PROBE_NEED_OBS}`);
  assert.match(rep.note, /Draw ни разу не предлагался, а не поломкой канона/,
    "the note carries WHY the logs were empty — the canon runs at the fill choke, and no Draw ever reached it");
});

test("G5: identical conditions across ticks collapse to ONE observation — otherwise the counter measures tick rate", () => {
  const db = openDb(":memory:"); initSchema(db);
  drawMatch(db, "m1");
  const markets = [{ label: "Draw — Yes" }, { label: "Draw — No" }];
  const zombie = new Map<string, any>([["Draw — Yes", { code: "notation_desync", detail: "13¢" }]]);
  for (let i = 0; i < 25; i++) probeDrawCanon(db, "m1", markets, zombie, `2026-07-27T16:${String(40 + i).padStart(2, "0")}:00Z`, {});
  assert.equal(buildDrawCanonProbe(db).observations, 1,
    "a market sitting in the same state for 25 ticks is one fact, not 25 — else the double-lock rate would just track tick frequency");
  // A CHANGE of condition is a new observation.
  probeDrawCanon(db, "m1", markets, new Map(), "2026-07-27T17:10:00Z", {});
  assert.equal(buildDrawCanonProbe(db).observations, 2, "quarantine lifting is a genuinely different observation");
});

test("G5: a match with no draw book produces no observation at all", () => {
  const db = openDb(":memory:"); initSchema(db);
  drawMatch(db, "m1");
  probeDrawCanon(db, "m1", [{ label: "Over 2.5" }, { label: "Under 2.5" }], new Map(), "2026-07-27T16:40:00Z", {});
  assert.equal(buildDrawCanonProbe(db).observations, 0, "nothing to say about a match that has no draw market");
});
