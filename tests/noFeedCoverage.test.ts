import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildNoFeedCoverage, buildNoFeedProbe, isEuroCupLeague, persistNoFeedCoverage } from "../src/lib/noFeedCoverage.js";
import type { SportsProvider } from "../src/lib/sports.js";

const NOW = "2026-07-24T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  return db;
}
function comp(db: any, id: string, league: string | null) {
  R.upsertCompetition(db, { id, sport_id: "football", name: id, budget: 1000, external_league: league, created_at: NOW });
}
function match(db: any, id: string, compId: string, home: string, away: string, kickoff = NOW) {
  R.insertMatch(db, { id, competition_id: compId, home, away, state: "upcoming", lineup_out: false, kickoff_at: kickoff, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
  // a Polymarket market makes it a link candidate
  R.insertMarket(db, { id: R.uid(), match_id: id, label: `${home} — Yes`, price: 50, ai_prob: 0.5, liquidity: "1000", external_ref: "TOK-" + id, token_second: null, snapshot_at: NOW, is_closing: false } as any);
}
function cover(db: any, matchId: string) {
  R.upsertMatchLive(db, { match_id: matchId, espn_event_id: "E-" + matchId, league: "uefa.champions", espn_event_date: NOW, home_lineup: null, away_lineup: null, stats: null, updated_at: NOW });
}

test("isEuroCupLeague: UEFA/CONMEBOL cups (incl _qual) are euro; domestic leagues are not", () => {
  assert.equal(isEuroCupLeague("uefa.champions"), true);
  assert.equal(isEuroCupLeague("uefa.champions_qual"), true);
  assert.equal(isEuroCupLeague("conmebol.libertadores"), true);
  assert.equal(isEuroCupLeague("eng.1"), false);
  assert.equal(isEuroCupLeague(null), false);
});

test("noFeedCoverage: euro link-rate counts covered vs blind and verdicts against the ≥85% target", () => {
  const db = seed();
  comp(db, "ucl", "uefa.champions");
  comp(db, "epl", "eng.1");
  // 3 euro pairs: 1 covered, 2 blind → euro link-rate 33.3% < 85% → below target.
  match(db, "u1", "ucl", "Raków", "Karabakh"); cover(db, "u1");
  match(db, "u2", "ucl", "Bohemian", "Ballkani");      // blind
  match(db, "u3", "ucl", "Lugano", "Basel");           // blind
  // a domestic pair, covered — should not move the euro cohort.
  match(db, "e1", "epl", "Arsenal", "Chelsea"); cover(db, "e1");

  const r = buildNoFeedCoverage(db, { nowMs: NOW_MS });
  assert.equal(r.euro.total, 3);
  assert.equal(r.euro.covered, 1);
  assert.equal(r.euro.blind, 2);
  assert.equal(r.euro.linkRatePct, 33.3);
  assert.equal(r.euro.meetsTarget, false);
  assert.match(r.note, /НИЖЕ ЦЕЛИ/);
  // overall folds in the domestic pair
  assert.equal(r.overall.total, 4);
  assert.equal(r.overall.covered, 2);
  // the 2 blind euro pairs are enumerated with a derived reason
  assert.equal(r.blindEuroPairs.length, 2);
  assert.ok(r.blindEuroPairs.every((p) => p.euro && /match_live/.test(p.reason)));
  assert.ok(r.blindEuroPairs.some((p) => p.match === "Bohemian—Ballkani"));
});

test("noFeedCoverage: an unlinked competition (empty external_league) → distinct 'лига не привязана' reason", () => {
  const db = seed();
  comp(db, "cup", null); // no external_league → never mapped to a provider board
  match(db, "c1", "cup", "A", "B");
  const r = buildNoFeedCoverage(db, { nowMs: NOW_MS });
  assert.equal(r.overall.blind, 1);
  assert.match(r.blindPairsSample[0].reason, /лига не привязана/);
});

test("noFeedCoverage: byLeagueDay lists only days with blind pairs; meets target → ✅ verdict", () => {
  const db = seed();
  comp(db, "ucl", "uefa.champions");
  // 9 covered, 1 blind → 90% ≥ 85% → meets target.
  for (let i = 0; i < 9; i++) { match(db, "w" + i, "ucl", "H" + i, "A" + i); cover(db, "w" + i); }
  match(db, "wb", "ucl", "Blind", "Pair", "2026-07-25T18:00:00Z");
  const r = buildNoFeedCoverage(db, { nowMs: NOW_MS });
  assert.equal(r.euro.meetsTarget, true);
  assert.match(r.note, /ЦЕЛЬ ДОСТИГНУТА/);
  assert.equal(r.byLeagueDay.length, 1, "only the one day carrying a blind pair is listed");
  assert.equal(r.byLeagueDay[0].day, "2026-07-25");
  assert.equal(r.byLeagueDay[0].blind, 1);
});

test("noFeedCoverage: a fixture with no Polymarket market is NOT a link candidate; out-of-window excluded", () => {
  const db = seed();
  comp(db, "ucl", "uefa.champions");
  // no market → not a candidate
  R.insertMatch(db, { id: "nm", competition_id: "ucl", home: "X", away: "Y", state: "upcoming", lineup_out: false, kickoff_at: NOW, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "nm" } as any);
  // far out of the ±14d window
  match(db, "old", "ucl", "Old", "Fixture", "2025-01-01T00:00:00Z");
  const r = buildNoFeedCoverage(db, { nowMs: NOW_MS, windowDays: 14 });
  assert.equal(r.overall.total, 0, "no candidates: one has no market, one is out of window");
});

test("noFeedCoverage: near-kickoff slice strips future fixtures ESPN hasn't boarded yet", () => {
  const db = seed();
  comp(db, "ucl", "uefa.champions");
  // an imminent blind pair (kicks off in 12h — ESPN should have it) and a far-future blind pair (+10 days).
  match(db, "soon", "ucl", "A", "B", "2026-07-25T00:00:00Z");         // +12h → near
  match(db, "far", "ucl", "C", "D", "2026-08-03T12:00:00Z");          // +10d → future noise
  const r = buildNoFeedCoverage(db, { nowMs: NOW_MS });
  assert.equal(r.euro.total, 2, "full window counts both (link-rate deflated by the future pair)");
  assert.equal(r.nearKickoff.euro.total, 1, "near-kickoff counts only the imminent fixture");
  assert.equal(r.nearKickoff.euro.blind, 1);
  assert.equal(r.nearKickoff.withinHours, 48);
});

test("noFeedCoverage: bind rejections surface with a 1–3 day gap flagged as a possible reschedule", () => {
  const db = seed();
  comp(db, "ucl", "uefa.champions");
  match(db, "m1", "ucl", "A", "B");
  R.metaSet(db, "fixture_bind_rejections", JSON.stringify({ at: NOW, rejects: [
    { home: "Raków", away: "Karabakh", recordKickoff: NOW, espnDate: "2026-07-26T12:00:00Z", gapHours: 48, league: "uefa.champions", reason: "date_gap" },     // +2d → reschedule-suspect
    { home: "Bohemian", away: "Ballkani", recordKickoff: NOW, espnDate: "2026-07-31T12:00:00Z", gapHours: 168, league: "uefa.champions", reason: "date_gap" }, // +7d → genuine other leg
  ] }), NOW);
  const r = buildNoFeedCoverage(db, { nowMs: NOW_MS });
  assert.equal(r.bindRejections.length, 2);
  const rakow = r.bindRejections.find((x) => x.home === "Raków")!;
  const boh = r.bindRejections.find((x) => x.home === "Bohemian")!;
  assert.equal(rakow.possibleReschedule, true, "a +2d gap could be a real match the gate over-tightly cut");
  assert.equal(boh.possibleReschedule, false, "a +7d gap is a genuine other leg — correctly rejected");
});

test("noFeedProbe: reveals the ESPN spelling for a blind euro fixture (name_mismatch_fixable) vs not_on_board", async () => {
  const db = seed();
  comp(db, "uel", "uefa.europa");
  match(db, "b1", "uel", "Rīgas Futbola Skola", "ÍF Vestri", "2026-07-24T18:00:00Z");   // blind, near kickoff
  match(db, "b2", "uel", "Nonexistent Club", "Ghost FC", "2026-07-24T18:00:00Z");        // blind, not on board
  // ESPN board carries "RFS" (the aliasable spelling) and Vestri — but nothing for the ghost fixture.
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_sport: string, league: string) {
      if (!/uefa\.europa/.test(league)) return [];
      return [{ externalRef: "E1", home: "RFS Riga", away: "Vestri", state: "upcoming", minute: null, scoreHome: null, scoreAway: null, final: false, date: "2026-07-24T18:00:00Z" }] as any;
    },
    async matchDetail() { return null; },
  };
  const r = await buildNoFeedProbe(db, provider, { nowMs: NOW_MS });
  const b1 = r.rows.find((x) => /Rīgas/.test(x.match))!;
  const b2 = r.rows.find((x) => /Nonexistent/.test(x.match))!;
  assert.equal(b1.verdict, "name_mismatch_fixable", "the board has a close-name event → aliasable");
  assert.ok(b1.candidates.some((c) => /RFS|Vestri/.test(c.espnHome + c.espnAway)), "shows ESPN's actual spelling");
  assert.equal(b2.verdict, "not_on_board", "no board candidate → ESPN doesn't carry it");
});

test("persistNoFeedCoverage: writes the blind_pairs_daily digest", () => {
  const db = seed();
  comp(db, "ucl", "uefa.champions");
  match(db, "u1", "ucl", "A", "B");
  persistNoFeedCoverage(db, NOW, { nowMs: NOW_MS });
  const raw = R.metaGet(db, "blind_pairs_daily");
  assert.ok(raw, "digest persisted");
  const d = JSON.parse(raw!);
  assert.equal(d.at, NOW);
  assert.equal(d.euro.blind, 1);
});
