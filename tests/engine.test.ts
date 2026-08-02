import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { parseEspnEvent, parseEspnSummary, MockSportsProvider, eventType } from "../src/lib/sports.js";
import {
  canReassess, syncMatchStatus, refreshMatchOdds, recomputeMetrics, enrichFromEspn, upsertImportedMatch, settleStaleOpenBets, settleMatch, reSettleSuspectBets, syncCompetitions, nameMatch, sameTeams, repairCategoryLeagues,
} from "../src/lib/engine.js";
import { matchContext } from "../src/lib/analysis.js";
import type { SportsMatchStatus, SportsProvider, MatchDetail } from "../src/lib/sports.js";
import { markUefaSettleSuspect, settleSuspectCount, backfillEspnEventDates, migrateFootballEpochUnknown } from "../src/lib/footballIntegrity.js";
import { betRecords } from "../src/lib/profileAnalytics.js";

const CFG = { config: { reassessGapMinutes: 5, priceMoveThreshold: 5 } };

// ---------------- sports adapter ----------------
test("parseEspnEvent maps state/score/minute", () => {
  const ev = {
    id: "42",
    competitions: [{ competitors: [
      { homeAway: "home", team: { displayName: "Arsenal" }, score: "2" },
      { homeAway: "away", team: { displayName: "Chelsea" }, score: "1" },
    ] }],
    status: { displayClock: "63'", type: { state: "in", completed: false, detail: "63'" } },
  };
  const s = parseEspnEvent(ev)!;
  assert.equal(s.state, "live");
  assert.equal(s.scoreHome, 2);
  assert.equal(s.scoreAway, 1);
  assert.equal(s.minute, 63);
  assert.equal(s.final, false);
  assert.equal(s.clock, "63'"); // raw display clock preserved

  // stoppage time: minute drops the "+2", clock keeps it
  const stoppage = parseEspnEvent({ ...ev, status: { displayClock: "45'+2'", type: { state: "in", completed: false, detail: "45'+2'" } } })!;
  assert.equal(stoppage.minute, 45);
  assert.equal(stoppage.clock, "45'+2'");

  const post = parseEspnEvent({ ...ev, status: { type: { state: "post", completed: true } } })!;
  assert.equal(post.state, "finished");
  assert.equal(post.final, true);
});

test("MockSportsProvider yields a scripted sequence", async () => {
  const seq: SportsMatchStatus[] = [
    { externalRef: "X", home: "A", away: "B", state: "live", minute: 10, scoreHome: 0, scoreAway: 0, final: false },
    { externalRef: "X", home: "A", away: "B", state: "finished", minute: 90, scoreHome: 1, scoreAway: 0, final: true },
  ];
  const p = new MockSportsProvider({ X: seq });
  assert.equal((await p.scoreboard())[0].minute, 10);
  assert.equal((await p.scoreboard())[0].state, "finished");
});

test("parseEspnSummary extracts lineups + typed key events", () => {
  const s = {
    rosters: [
      { homeAway: "home", team: { displayName: "Colombia" }, formation: "4-3-3", roster: [{ starter: true, athlete: { displayName: "James" } }, { starter: false, athlete: { displayName: "Sub" } }] },
      { homeAway: "away", team: { displayName: "Ghana" }, formation: "4-1-4-1", roster: [{ starter: true, athlete: { displayName: "Kudus" } }] },
    ],
    keyEvents: [
      { id: "1", type: { text: "Goal" }, clock: { displayValue: "23'" }, team: { displayName: "Colombia" }, text: "Goal by James" },
      { id: "2", type: { text: "Yellow Card" }, clock: { displayValue: "40'" }, team: { displayName: "Ghana" }, text: "Booking" },
    ],
  };
  const d = parseEspnSummary(s);
  assert.equal(d.lineupOut, true);            // both sides have starters
  assert.equal(d.lineups.home!.formation, "4-3-3");
  assert.deepEqual(d.lineups.home!.starters, ["James"]); // non-starters dropped
  assert.equal(d.events[0].type, "goal");
  assert.equal(d.events[0].minute, 23);
  assert.equal(d.events[0].team, "Colombia");
  assert.equal(d.events[1].type, "yellow_card");
});

test("eventType: a VAR-pending or overturned goal is NOT counted as a scored goal (NWSL Courage double-count)", () => {
  // Confirmed goals stay goals — including a goal VAR ultimately CONFIRMED/awarded.
  assert.equal(eventType("Goal by James"), "goal");
  assert.equal(eventType("Goal! Ashley Sanchez scores"), "goal");
  assert.equal(eventType("VAR: goal confirmed — Sanchez"), "goal");
  assert.equal(eventType("Goal awarded after VAR review"), "goal");
  // Pending review — outcome unknown → NOT a goal yet (resolves next tick). This is the exact NWSL
  // 52' "VAR Checking (Sanchez)" that was double-counted with the 50' goal.
  assert.equal(eventType("VAR Checking — possible goal North Carolina Courage (Ashley Sanchez)"), "other");
  assert.equal(eventType("Goal under review (VAR)"), "other");
  assert.equal(eventType("Possible goal being reviewed"), "other");
  // Overturned / never stood → NOT a goal.
  assert.equal(eventType("Goal disallowed by VAR — offside"), "other");
  assert.equal(eventType("Goal ruled out for offside"), "other");
  assert.equal(eventType("Goal overturned after VAR"), "other");
  assert.equal(eventType("No goal — chalked off"), "other");
  // Non-goal events unaffected.
  assert.equal(eventType("Red card for violent conduct"), "red_card");
  assert.equal(eventType("Penalty - Saved"), "penalty");
});

test("parseEspnSummary keeps the positional layout: role tags, ordered by formation slot", () => {
  const s = {
    rosters: [
      { homeAway: "home", team: { displayName: "Portugal" }, formation: "4-3-3", roster: [
        { starter: true, formationPlace: "9", position: { abbreviation: "F" }, athlete: { displayName: "Ronaldo" } },
        { starter: true, formationPlace: "1", position: { abbreviation: "G" }, athlete: { displayName: "Costa" } },
        { starter: true, formationPlace: "3", athlete: { displayName: "Dias", position: { abbreviation: "D" } } }, // pos on athlete
        { starter: false, formationPlace: "2", position: { abbreviation: "D" }, athlete: { displayName: "Bench" } },
      ] },
      { homeAway: "away", team: { displayName: "Croatia" }, formation: "4-1-4-1", roster: [
        { starter: true, athlete: { displayName: "Modrić" } }, // feed with no position/slot → bare name
      ] },
    ],
    keyEvents: [],
  };
  const d = parseEspnSummary(s);
  // sorted by formationPlace (1,3,9), role tagged, non-starter dropped
  assert.deepEqual(d.lineups.home!.starters, ["Costa (G)", "Dias (D)", "Ronaldo (F)"]);
  // graceful when a feed omits positions
  assert.deepEqual(d.lineups.away!.starters, ["Modrić"]);
});

test("parseEspnSummary extracts team statistics (possession, shots, chances)", () => {
  const s = {
    rosters: [],
    keyEvents: [],
    boxscore: { teams: [
      { homeAway: "home", team: { displayName: "Colombia" }, statistics: [
        { name: "possessionPct", displayValue: "58" }, { name: "totalShots", displayValue: "12" },
        { name: "shotsOnTarget", displayValue: "5" }, { name: "wonCorners", displayValue: "6" },
        { name: "unmapped", displayValue: "99" },
      ] },
      { homeAway: "away", team: { displayName: "Ghana" }, statistics: [
        { name: "possessionPct", displayValue: "42" }, { name: "totalShots", displayValue: "7" },
      ] },
    ] },
  };
  const d = parseEspnSummary(s);
  assert.ok(d.stats?.home);
  assert.equal(d.stats!.home!.team, "Colombia");
  const poss = d.stats!.home!.items.find((i) => i.label === "владение");
  assert.equal(poss?.value, "58");
  assert.ok(d.stats!.home!.items.some((i) => i.label === "удары" && i.value === "12"));
  assert.ok(!d.stats!.home!.items.some((i) => i.value === "99")); // unmapped stat dropped
  assert.equal(d.stats!.away!.items.find((i) => i.label === "владение")?.value, "42");
});

// Mock ESPN provider with lineups + a scripted goal.
function mockDetailProvider(detail: MatchDetail, status: Partial<SportsMatchStatus> = {}): SportsProvider {
  return {
    name: "mock",
    async scoreboard(_sport: string, league: string) {
      if (league !== "fifa.world") return []; // only our WC league lists this match
      return [{ externalRef: "E1", home: "Colombia", away: "Ghana", state: "live", minute: 30, scoreHome: 1, scoreAway: 0, final: false, ...status }];
    },
    async matchDetail() { return detail; },
  };
}

test("syncCompetitions drops a LIVE ESPN fixture Polymarket never listed (no markets), keeps upcoming", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-brazil-serie-b", sport_id: "football", name: "Brazil Serie B", budget: 8000, external_league: "bra.2", created_at: "t" });
  const prov: SportsProvider = {
    name: "mock",
    async scoreboard(_sport: string, league: string) {
      if (league !== "bra.2") return [];
      return [
        { externalRef: "L1", home: "Sport", away: "Botafogo-SP", state: "live", minute: 11, scoreHome: 0, scoreAway: 0, final: false },
        { externalRef: "U1", home: "Ceará", away: "Novorizontino", state: "upcoming", minute: null, scoreHome: null, scoreAway: null, final: false },
      ] as SportsMatchStatus[];
    },
    async matchDetail() { return null; },
  };
  // linkOdds off → no market ever attaches, mirroring a fixture Polymarket doesn't list.
  await syncCompetitions(db, prov, {}, { linkOdds: false });

  const matches = R.listMatches(db, "pm-brazil-serie-b");
  const live = matches.find((m) => m.home === "Sport");
  const upcoming = matches.find((m) => m.home === "Ceará");
  assert.equal(live, undefined, "market-less LIVE fixture dropped (untradeable, no Polymarket market)");
  assert.ok(upcoming, "market-less UPCOMING fixture kept — odds may still list closer to kickoff");
});

test("enrichFromEspn: a UEFA comp finds its fixture in the qualifying-round board (uefa.champions_qual)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // Comp maps to the MAIN slug (uefa.champions), which is empty during the summer qualifiers.
  R.upsertCompetition(db, { id: "pm-ucl-2025", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-ucl-2025", home: "SK Iberia 1999", away: "FC Flora", state: "lineup", lineup_out: true, kickoff_at: "2026-07-14T16:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });

  const provider: SportsProvider = {
    name: "mock",
    // The fixture exists ONLY in the qualifying board; the main board is empty (as in prod).
    async scoreboard(_sport: string, league: string) {
      if (league !== "uefa.champions_qual") return [];
      // A two-leg (UEFA) fixture now REQUIRES a positive date-match to bind (P1 batch-7): the event carries its
      // date, within a day of the record's kickoff, so it binds the right leg. No-date binding is the closed hatch.
      return [{ externalRef: "Q1", home: "SK Iberia 1999", away: "FC Flora", state: "live", minute: 20, scoreHome: 0, scoreAway: 1, final: false, date: "2026-07-14T16:00:00Z" }] as SportsMatchStatus[];
    },
    async matchDetail(_sport: string, league: string) {
      // matchDetail must be called with the BOARD's slug, not the comp's stored slug.
      assert.equal(league, "uefa.champions_qual", "lineups fetched under the qualifying slug");
      return { lineupOut: true, lineups: { home: { team: "SK Iberia 1999", formation: "4-4-2", starters: ["A"] }, away: { team: "FC Flora", formation: "4-3-3", starters: ["B"] } }, events: [] } as MatchDetail;
    },
  };

  const res = await enrichFromEspn(db, provider, {});
  assert.equal(res.enriched, 1, "the qualifier fixture was matched via the _qual board");
  const m = R.getMatch(db, mid)!;
  assert.equal(m.state, "live");
  assert.equal(m.score_away, 1, "live score synced from the qualifying board");
  const live = R.getMatchLive(db, mid);
  assert.ok(live && live.home_lineup && live.away_lineup, "lineups now present → football analysis is no longer gated");
});

test("P0.1 enrichFromEspn date gate: leg-1 event binds leg-1 record, is REJECTED for the leg-2 record (fixture_leg_mismatch)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-ucl", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  const leg1 = R.uid(), leg2 = R.uid();
  // SAME teams, two legs a week apart (the two-leg tie). Leg 2 is listed first in the DB.
  R.insertMatch(db, { id: leg2, competition_id: "pm-ucl", home: "Bohemian", away: "Ballkani", state: "upcoming", lineup_out: false, kickoff_at: "2026-07-29T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: leg2 });
  R.insertMatch(db, { id: leg1, competition_id: "pm-ucl", home: "Bohemian", away: "Ballkani", state: "lineup", lineup_out: true, kickoff_at: "2026-07-22T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: leg1 });
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_sport: string, league: string) {
      if (league !== "uefa.champions_qual") return [];
      // ONE event — leg 1's date. It must bind ONLY the leg-1 record, never leg 2.
      return [{ externalRef: "L1", home: "Bohemian", away: "Ballkani", state: "live", minute: 20, scoreHome: 2, scoreAway: 1, final: false, date: "2026-07-22T18:00:00Z" }] as SportsMatchStatus[];
    },
    async matchDetail() { return { lineupOut: true, lineups: { home: null, away: null }, events: [] } as MatchDetail; },
  };
  const res = await enrichFromEspn(db, provider, {});
  assert.equal(res.enriched, 1, "the event bound exactly one record");
  assert.equal(R.getMatch(db, leg1)!.score_home, 2, "leg-1 record got the score (date within 1 day)");
  assert.equal(R.getMatch(db, leg2)!.state, "upcoming", "leg-2 record UNTOUCHED — the date gate chose the right leg");
  assert.equal(R.getMatchLive(db, leg2), undefined, "no binding on the wrong leg — no cross-leg contamination");
});

test("P0.1 date gate: an event whose date matches NO record is REJECTED + counted (orphan foreign leg / reschedule)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-ucl", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  const mid = R.uid();
  // The only record kicks off on the 22nd; the ESPN event is 6 days later (the other leg) — must NOT bind.
  R.insertMatch(db, { id: mid, competition_id: "pm-ucl", home: "Bohemian", away: "Ballkani", state: "lineup", lineup_out: true, kickoff_at: "2026-07-22T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_sport: string, league: string) {
      if (league !== "uefa.champions_qual") return [];
      return [{ externalRef: "L2", home: "Bohemian", away: "Ballkani", state: "live", minute: 20, scoreHome: 0, scoreAway: 3, final: false, date: "2026-07-29T18:00:00Z" }] as SportsMatchStatus[];
    },
    async matchDetail() { return null; },
  };
  const res = await enrichFromEspn(db, provider, {});
  assert.equal(res.enriched, 0, "the foreign leg was refused");
  assert.equal(R.getMatch(db, mid)!.state, "lineup", "record untouched — no foreign-leg score wired");
  const tally = JSON.parse(R.metaGet(db, "fixture_leg_mismatch") as string);
  assert.ok(tally.dateGap >= 1, "the date_gap mismatch was counted");
});

test("P1(б7) two-leg binding: an event with NO date is REFUSED on a two-leg comp (no-date hatch closed)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-ucl", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-ucl", home: "Bohemian", away: "Ballkani", state: "lineup", lineup_out: true, kickoff_at: "2026-07-22T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_sport: string, league: string) {
      if (league !== "uefa.champions_qual") return [];
      // NO date on the event — on a two-leg comp we can't prove it's THIS leg, so it must NOT bind by name alone.
      return [{ externalRef: "L1", home: "Bohemian", away: "Ballkani", state: "live", minute: 20, scoreHome: 2, scoreAway: 1, final: false }] as SportsMatchStatus[];
    },
    async matchDetail() { return null; },
  };
  const res = await enrichFromEspn(db, provider, {});
  assert.equal(res.enriched, 0, "no positive date-match on a two-leg fixture → refused");
  assert.equal(R.getMatch(db, mid)!.state, "lineup", "record untouched — no team-name-only bind on a two-leg tie");
  const tally = JSON.parse(R.metaGet(db, "fixture_leg_mismatch") as string);
  assert.ok(tally.dateGap >= 1, "the two-leg no-date-match was counted");
});

test("P1(б7) two-leg binding: a record with NO kickoff is REFUSED on a two-leg comp (no-kickoff hatch closed)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-ucl", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  const mid = R.uid();
  // record has NO kickoff_at — previously the no-kickoff fallback bound it regardless of the event date.
  R.insertMatch(db, { id: mid, competition_id: "pm-ucl", home: "Bohemian", away: "Ballkani", state: "lineup", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_sport: string, league: string) {
      if (league !== "uefa.champions_qual") return [];
      return [{ externalRef: "L1", home: "Bohemian", away: "Ballkani", state: "live", minute: 20, scoreHome: 2, scoreAway: 1, final: false, date: "2026-07-22T18:00:00Z" }] as SportsMatchStatus[];
    },
    async matchDetail() { return null; },
  };
  const res = await enrichFromEspn(db, provider, {});
  assert.equal(res.enriched, 0, "a two-leg record with no kickoff can't be date-checked → refused");
  assert.equal(R.getMatch(db, mid)!.state, "lineup", "record untouched — the no-kickoff hatch is closed for two-leg");
});

test("P1(б7) orientation guard: an ambiguous straight-AND-mirrored name set is NOT bound (mirror hatch closed)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const compId = R.uid();
  R.upsertCompetition(db, { id: compId, sport_id: "football", name: "WC", budget: 1000, external_league: "fifa.world", created_at: "t" });
  const mid = R.uid();
  // Reserve-vs-senior ambiguity: DB "Barcelona" vs "Girona"; ESPN reports home "Barcelona", away "Barcelona B".
  // m.home matches BOTH ESPN sides → straight AND mirrored hold → orientation of the score is unprovable.
  R.insertMatch(db, { id: mid, competition_id: compId, home: "Barcelona", away: "Barcelona B", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_sport: string, league: string) {
      if (league !== "fifa.world") return [];
      return [{ externalRef: "E1", home: "Barcelona B", away: "Barcelona", state: "live", minute: 30, scoreHome: 3, scoreAway: 0, final: false }] as SportsMatchStatus[];
    },
    async matchDetail() { return null; },
  };
  const res = await enrichFromEspn(db, provider, {});
  assert.equal(res.enriched, 0, "ambiguous orientation → not bound (would risk a mirrored score)");
  assert.equal(R.getMatch(db, mid)!.score_home, null, "no score wired under ambiguous orientation");
  const tally = JSON.parse(R.metaGet(db, "fixture_leg_mismatch") as string);
  assert.ok(tally.orient >= 1, "the ambiguous-orientation refusal was counted");
});

test("P0.1 settle_suspect: settled bets on a UEFA two-leg comp are quarantined out of the verdict analytics", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-ucl", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-ucl", home: "Bohemian", away: "Ballkani", state: "finished", lineup_out: true, kickoff_at: "2026-07-22T18:00:00Z", minute: null, score_home: 2, score_away: 1, final_score: "2:1", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: mid });
  const strat = R.listStrategies(db).find((s) => s.sport_id === "football")!.id;
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat, risk_profile_id: null, market_label: "Bohemian — Yes", status: "settled_won", proposed_price: 40, entry_price: 40, current_price: 100, closing_price: 100, ai_prob: 0.6, stake: 50, rationale: "x", entered_minute: "23'", result: "won", payout: 125, settled_by: null, settled_at: "t", entry_meta: null, code_version: "e5", decision_id: null, created_at: "t" } as any);
  const before = betRecords(db).filter((r: any) => r.matchId === mid).length;
  assert.equal(before, 1, "the settled bet is in the analytics before quarantine");
  assert.equal(markUefaSettleSuspect(db), 1, "one settled UEFA bet tagged");
  assert.equal(settleSuspectCount(db), 1);
  const after = betRecords(db).filter((r: any) => r.matchId === mid).length;
  assert.equal(after, 0, "quarantined bet no longer feeds the verdict cut");
});

test("P1(в7) reSettleSuspectBets: a proven-clean two-leg suspect is re-graded off the corrected score", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-ucl", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  const strat = R.listStrategies(db).find((s) => s.sport_id === "football")!.id;
  // Raków-class: home won 3:1, but "Raków — Yes" was booked settled_LOST off the other leg.
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-ucl", home: "Raków", away: "Karabakh", state: "finished", lineup_out: true, kickoff_at: "2026-07-22T18:00:00Z", minute: null, score_home: 3, score_away: 1, final_score: "3:1", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: mid });
  // bound ESPN event date == kickoff → binding PROVEN clean; the 3:1 is the right leg's score.
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "E1", league: "uefa.champions", espn_event_date: "2026-07-22T18:05:00Z", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat, risk_profile_id: null, market_label: "Raków — Yes", status: "settled_lost", proposed_price: 40, entry_price: 40, current_price: 0, closing_price: 40, ai_prob: 0.6, stake: 50, rationale: "x", entered_minute: "предматч", result: "lost", payout: 0, settled_by: "match_score", settled_at: "t", entry_meta: null, code_version: "e5", decision_id: null, created_at: "t" } as any);
  assert.equal(markUefaSettleSuspect(db), 1, "the mislabeled bet is quarantined");

  const r = reSettleSuspectBets(db, {});
  assert.equal(r.regraded, 1, "the proven-clean suspect was re-graded");
  const bet = R.getBet(db, bid)!;
  assert.equal(bet.status, "settled_won", "Raków — Yes now honestly WON on the 3:1 corrected score");
  assert.ok((bet.payout ?? 0) > 0, "payout restored on the corrected win");
  assert.equal(settleSuspectCount(db), 0, "flag cleared — no longer an eternal suspect");
});

test("P1(в7) reSettleSuspectBets: an unprovable suspect (no ESPN date) is DEFERRED, not re-graded", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-ucl", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  const strat = R.listStrategies(db).find((s) => s.sport_id === "football")!.id;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-ucl", home: "Raków", away: "Karabakh", state: "finished", lineup_out: true, kickoff_at: "2026-07-22T18:00:00Z", minute: null, score_home: 3, score_away: 1, final_score: "3:1", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: mid });
  // NO match_live / espn_event_date → the binding can't be proven clean → must NOT re-grade off a maybe-wrong score.
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat, risk_profile_id: null, market_label: "Raków — Yes", status: "settled_lost", proposed_price: 40, entry_price: 40, current_price: 0, closing_price: 40, ai_prob: 0.6, stake: 50, rationale: "x", entered_minute: "предматч", result: "lost", payout: 0, settled_by: "match_score", settled_at: "t", entry_meta: null, code_version: "e5", decision_id: null, created_at: "t" } as any);
  markUefaSettleSuspect(db);
  const r = reSettleSuspectBets(db, {});
  assert.equal(r.regraded, 0);
  assert.equal(r.deferred, 1, "unprovable suspect deferred to PM-resolution (P2)");
  assert.equal(R.getBet(db, bid)!.status, "settled_lost", "left untouched — no re-grade off an unproven score");
  assert.equal(settleSuspectCount(db), 1, "stays flagged for the PM-resolution settler");
});

test("P0.5 football epoch: new bets carry the clean epoch; pre-fix bets are epoch_unknown + dropped from cuts", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-f", sport_id: "football", name: "F", budget: 8000, external_league: "eng.1", created_at: "t" });
  // seedDatabase seeds edge/flat/kelly; the real strategist ids (in FOOTBALL_STRATS) are seeded separately —
  // add prematch_value here so insertBet stamps the football epoch.
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "Pre-match Value", tag: "value", color: "#5b9bd5", version: 1, model: "m", model_live: "m", created_at: "t", prompt: "p", prompt_live: null, params: {} } as any);
  const comp = "pm-f";
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: mid });
  const mkBet = () => ({ id: R.uid(), match_id: mid, strategy_id: "prematch_value", risk_profile_id: null, market_label: "A — Yes", status: "settled_won", proposed_price: 40, entry_price: 40, current_price: 100, closing_price: 100, ai_prob: 0.6, stake: 50, rationale: "x", entered_minute: "23'", result: "won", payout: 125, settled_by: null, settled_at: "t", entry_meta: null, code_version: "e5", decision_id: null, created_at: "t" } as any);
  const fresh = mkBet(); R.insertBet(db, fresh);
  assert.equal(R.getBet(db, fresh.id)!.football_epoch, "f-clean-m1", "new football bet stamped with the clean epoch");
  // an OLD row with no epoch (simulate pre-fix): NULL it, then migrate → epoch_unknown
  const old = mkBet(); R.insertBet(db, old); R.updateBet(db, old.id, { football_epoch: null } as any);
  assert.equal(migrateFootballEpochUnknown(db), 1, "one pre-fix football bet tagged");
  assert.equal(R.getBet(db, old.id)!.football_epoch, "epoch_unknown");
  const recs = betRecords(db).filter((r: any) => r.matchId === mid);
  assert.equal(recs.length, 1, "the epoch_unknown bet is excluded; the clean one remains");
});

test("P0.1 backfill: re-fetched ESPN date freezes the field and CLEARS suspect on a proven-clean match", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-ucl", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-ucl", home: "Bohemian", away: "Ballkani", state: "finished", lineup_out: true, kickoff_at: "2026-07-22T18:00:00Z", minute: null, score_home: 2, score_away: 1, final_score: "2:1", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: mid });
  // an OLD binding with no frozen date, and a settled (conservatively-quarantined) bet on it
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "E9", league: "uefa.champions_qual", espn_event_date: null, home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  const strat = R.listStrategies(db).find((s) => s.sport_id === "football")!.id;
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat, risk_profile_id: null, market_label: "Bohemian — Yes", status: "settled_won", proposed_price: 40, entry_price: 40, current_price: 100, closing_price: 100, ai_prob: 0.6, stake: 50, rationale: "x", entered_minute: "23'", result: "won", payout: 125, settled_by: null, settled_at: "t", entry_meta: null, code_version: "e5", decision_id: null, created_at: "t" } as any);
  markUefaSettleSuspect(db);
  assert.equal(settleSuspectCount(db), 1, "quarantined first");
  // provider returns the event's TRUE date = the same day as kickoff → the match is clean.
  const provider: SportsProvider = { name: "mock", async scoreboard() { return []; }, async eventDate() { return "2026-07-22T18:00:00Z"; } };
  const r = await backfillEspnEventDates(db, provider, {});
  assert.ok(r.dated >= 1, "date fetched + frozen");
  assert.equal(r.cleared, 1, "clean match → suspect cleared");
  assert.equal(settleSuspectCount(db), 0, "no longer quarantined");
  assert.equal(R.getMatchLive(db, mid)!.espn_event_date, "2026-07-22T18:00:00Z", "date frozen on match_live");
});

test("enrichFromEspn stores lineups, records new events, reports triggers, and feeds matchContext", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const compId = R.uid();
  R.upsertCompetition(db, { id: compId, sport_id: "football", name: "WC", budget: 1000, external_league: "fifa.world", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: compId, home: "Colombia", away: "Ghana", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });

  const detail: MatchDetail = {
    lineupOut: true,
    lineups: {
      home: { team: "Colombia", formation: "4-3-3", starters: ["James", "Diaz", "Muñoz"] },
      away: { team: "Ghana", formation: "4-1-4-1", starters: ["Kudus", "Partey"] },
    },
    events: [{ key: "ev1", minute: 25, type: "goal", team: "Colombia", text: "Goal! Colombia 1-0" }],
  };
  const provider = mockDetailProvider(detail);

  const res = await enrichFromEspn(db, provider, {});
  assert.equal(res.enriched, 1);
  assert.ok(res.newEvents.some((e) => e.matchId === mid && e.type === "goal"), "goal surfaced as a trigger");
  const live = R.getMatchLive(db, mid);
  assert.ok(live && live.home_lineup && live.away_lineup, "lineups persisted");
  const m = R.getMatch(db, mid)!;
  assert.equal(m.lineup_out, true);   // real rosters flip the stage
  assert.equal(m.score_home, 1);      // live state synced from the board
  assert.equal(m.state, "live");

  // matchContext turns the stored lineups + events into a prompt string
  const ctx = matchContext(db, mid)!;
  assert.match(ctx, /Colombia \(4-3-3\)/);
  assert.match(ctx, /James/);
  assert.match(ctx, /goal/);

  // second pass: the same event is deduped (INSERT OR IGNORE) — no new trigger
  const res2 = await enrichFromEspn(db, provider, {});
  assert.equal(res2.newEvents.length, 0, "known events don't re-trigger");
});

test("enrichFromEspn is sport-generic: enriches a basketball match via a provider-declared league, sport-scoped", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertSport(db, "basketball", "Баскетбол");
  // a Polymarket-discovered basketball match (no ESPN league on its comp)
  R.upsertCompetition(db, { id: "pm-basketball", sport_id: "basketball", name: "PM · Баскет", budget: 0, external_league: null, created_at: "t" });
  const bid = R.uid();
  R.insertMatch(db, { id: bid, competition_id: "pm-basketball", home: "Los Angeles Lakers", away: "Boston Celtics", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: bid });
  // a same-named-nations football match that must NOT be hit by the basketball board
  const fid = R.uid();
  const fcomp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  R.insertMatch(db, { id: fid, competition_id: fcomp.id, home: "Boston Celtics", away: "Los Angeles Lakers", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: fid });

  const provider: SportsProvider = {
    name: "mock",
    leaguesFor: (sport) => (sport === "basketball" ? ["nba"] : []),
    async scoreboard(sport, league) {
      if (sport === "basketball" && league === "nba")
        return [{ externalRef: "B1", home: "Los Angeles Lakers", away: "Boston Celtics", state: "live", minute: 24, scoreHome: 55, scoreAway: 60, final: false }];
      return [];
    },
    async matchDetail() { return { lineupOut: false, lineups: { home: null, away: null }, events: [] }; },
  };

  const res = await enrichFromEspn(db, provider, {});
  assert.equal(res.enriched, 1, "only the basketball match enriched");
  const bm = R.getMatch(db, bid)!;
  assert.equal(bm.state, "live");
  assert.equal(bm.score_home, 55);
  assert.equal(bm.score_away, 60);
  const fm = R.getMatch(db, fid)!;
  assert.equal(fm.state, "upcoming", "football match of same nations left untouched (sport-scoped)");
});

test("dedupeMatches drops a market-less provider clone but keeps the tradeable twin (Djurgardens vs Djurgården)", async () => {
  const { dedupeMatches } = await import("../src/lib/engine.js");
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mkMatch = (id: string, home: string, away: string) => R.insertMatch(db, { id, competition_id: comp.id, home, away, state: "live", lineup_out: true, kickoff_at: null, minute: 40, score_home: 1, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  // the Polymarket row (markets + a bet) and a bare provider clone with the
  // inflected name — they are the SAME fixture and must collapse to one.
  mkMatch("poly", "BK Hacken", "Djurgardens IF");
  mkMatch("clone", "BK Häcken", "Djurgården");
  R.insertMarket(db, { id: R.uid(), match_id: "poly", label: "Over 1.5", price: 90, ai_prob: 0.6, liquidity: "5000", external_ref: "tok", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "b1", match_id: "poly", strategy_id: R.listStrategies(db, "football")[0].id, market_label: "Over 1.5", status: "open", proposed_price: 90, entry_price: 90, current_price: 90, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: "10'", result: null, payout: null, created_at: "t" });

  const removed = dedupeMatches(db);
  assert.equal(removed, 1, "the market-less clone is removed");
  assert.ok(R.getMatch(db, "poly"), "tradeable twin (markets + bet) kept");
  assert.equal(R.getMatch(db, "clone"), null, "bare clone gone");
  assert.ok(R.getBet(db, "b1"), "bet preserved");
});

test("dedupeMatches merges the Tromsø/Tromso split — ø doesn't NFD-decompose, so it needs letter-folding", async () => {
  const { dedupeMatches } = await import("../src/lib/engine.js");
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mkMatch = (id: string, home: string, away: string) => R.insertMatch(db, { id, competition_id: comp.id, home, away, state: "live", lineup_out: true, kickoff_at: null, minute: 40, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  // Polymarket row (quotes) vs the ESPN clone with the ø spelling + a suffix — SAME fixture.
  mkMatch("poly", "Tromsø IL", "Vålerenga Fotball");
  mkMatch("clone", "Tromso", "Valerenga");
  R.insertMarket(db, { id: R.uid(), match_id: "poly", label: "Over 1.5", price: 78, ai_prob: 0.6, liquidity: "4800", external_ref: "tok", snapshot_at: "t", is_closing: false });

  assert.equal(dedupeMatches(db), 1, "the quote-less ø-clone is merged away");
  assert.ok(R.getMatch(db, "poly"), "tradeable Polymarket twin kept");
  assert.equal(R.getMatch(db, "clone"), null, "ESPN ø-clone gone (no more no-quotes duplicate)");
});

test("enrichFromEspn reconciles a short-named esports match (e.g. 'T1') the provider reports finished", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertSport(db, "esports", "Киберспорт");
  R.upsertCompetition(db, { id: "pm-lol", sport_id: "esports", name: "PM · LoL", budget: 0, external_league: null, created_at: "t" });
  const eid = R.uid();
  // 'T1' is a 2-char org name — the exact case that produced an empty token set
  // and left the fixture stranded "live" forever despite the provider finishing it.
  R.insertMatch(db, { id: eid, competition_id: "pm-lol", home: "T1", away: "FURIA Esports", state: "live", lineup_out: true, kickoff_at: "2026-07-06T08:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: eid });

  const provider: SportsProvider = {
    name: "mock",
    leaguesFor: (sport) => (sport === "esports" ? ["sp:esports"] : []),
    async scoreboard(sport, league) {
      if (sport === "esports" && league === "sp:esports")
        return [{ externalRef: "L1", home: "T1", away: "FURIA Esports", state: "finished", minute: null, scoreHome: 3, scoreAway: 0, final: true }];
      return [];
    },
    async matchDetail() { return { lineupOut: false, lineups: { home: null, away: null }, events: [] }; },
  };

  const res = await enrichFromEspn(db, provider, { now: () => "2026-07-06T10:01:00Z" });
  assert.equal(res.enriched, 1, "the short-named esports match now reconciles with the provider");
  const em = R.getMatch(db, eid)!;
  assert.equal(em.state, "finished", "provider 'Finished' status finishes it — no more infinite clock");
  assert.equal(em.final_score, "3:0");
  // ESPN owns the finish for covered matches, so enrich (not syncMatchStatus) must stamp
  // the Warsaw finish time — else the card reads a bare «финал» («до сих пор не отображается»).
  assert.ok(em.end_time, "enrich stamps a Warsaw end_time on the finish it drives");
  assert.ok(em.kickoff_time, "kickoff_time stamped");
  assert.equal(em.duration, "2 ч 1 мин", "duration from kickoff→finish");
});

test("enrichFromEspn aligns scores/lineups when the DB match orientation is reversed", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const compId = R.uid();
  R.upsertCompetition(db, { id: compId, sport_id: "football", name: "WC", budget: 1000, external_league: "fifa.world", created_at: "t" });
  const mid = R.uid();
  // DB match orientation (from the Polymarket title) is REVERSED vs ESPN:
  // DB home=Ghana, away=Colombia — ESPN reports Colombia (home) 1 - Ghana (away) 0.
  R.insertMatch(db, { id: mid, competition_id: compId, home: "Ghana", away: "Colombia", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const detail: MatchDetail = { lineupOut: true, lineups: { home: { team: "Colombia", formation: "4-3-3", starters: ["James"] }, away: { team: "Ghana", formation: "4-1-4-1", starters: ["Kudus"] } }, events: [] };
  await enrichFromEspn(db, mockDetailProvider(detail), {});
  const m = R.getMatch(db, mid)!;
  assert.equal(m.score_home, 0, "Ghana (DB home) gets ESPN away score 0");
  assert.equal(m.score_away, 1, "Colombia (DB away) gets ESPN home score 1");
  const live = R.getMatchLive(db, mid)!;
  assert.match(live.home_lineup!, /Ghana/, "home_lineup is the DB-home team (Ghana)");
  assert.match(live.away_lineup!, /Colombia/, "away_lineup is the DB-away team (Colombia)");
});

test("upsertImportedMatch merges into a same-fixture twin instead of duplicating", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const compId = R.uid();
  R.upsertCompetition(db, { id: compId, sport_id: "football", name: "WC", budget: 0, external_league: "fifa.world", created_at: "t" });
  // a Polymarket-discovered match already exists (pm: ref)
  const pmMatch = { id: R.uid(), competition_id: compId, home: "Colombia", away: "Ghana", state: "upcoming" as const, lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "pm:football:colombia-ghana" };
  R.insertMatch(db, pmMatch);
  // ESPN import for the SAME fixture (different, numeric ref) must not duplicate
  const r = upsertImportedMatch(db, compId, { externalRef: "760501", home: "Colombia", away: "Ghana", state: "live", minute: 30, scoreHome: 1, scoreAway: 0, final: false });
  assert.equal(r.created, false, "no new row created");
  assert.equal(R.listMatches(db, compId).length, 1, "still one match for the fixture");
  assert.equal(r.match.external_ref, "760501", "ESPN id adopted so status sync can settle it");
  assert.equal(R.getMatch(db, pmMatch.id)!.external_ref, "760501");
});

test("upsertImportedMatch aligns a REVERSED twin's orientation to ESPN (no mirrored settlement)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const compId = R.uid();
  R.upsertCompetition(db, { id: compId, sport_id: "football", name: "WC", budget: 0, external_league: "fifa.world", created_at: "t" });
  // Polymarket-discovered twin stored REVERSED vs ESPN (home=Ghana, away=Colombia)
  const twin = { id: R.uid(), competition_id: compId, home: "Ghana", away: "Colombia", state: "upcoming" as const, lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "pm:football:colombia-ghana" };
  R.insertMatch(db, twin);
  // ESPN reports Colombia (home) vs Ghana (away)
  const r = upsertImportedMatch(db, compId, { externalRef: "760501", home: "Colombia", away: "Ghana", state: "live", minute: 30, scoreHome: 1, scoreAway: 0, final: false });
  assert.equal(r.created, false, "still merged into the twin");
  const m = R.getMatch(db, twin.id)!;
  assert.equal(m.home, "Colombia", "twin home flipped to ESPN's home");
  assert.equal(m.away, "Ghana", "twin away flipped to ESPN's away");
  assert.equal(r.match.home, "Colombia");
  // so a later syncMatchStatus writing scoreHome=1 lands on Colombia, not Ghana
});

test("recomputeMetrics counts only resolution-settled bets, not early/partial cash-outs", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets; DELETE FROM quality_metrics");
  const strat = R.listStrategies(db, "football")[0];
  const mk = (settledBy: string | null, prob: number, result: "won" | "lost") =>
    R.insertBet(db, { id: R.uid(), match_id: "m-finished", strategy_id: strat.id, market_label: "Over 2.5", status: result === "won" ? "settled_won" : "settled_lost", proposed_price: 50, entry_price: 50, current_price: 60, closing_price: 55, ai_prob: prob, stake: 100, rationale: null, entered_minute: "3'", result, payout: result === "won" ? 120 : 0, settled_by: settledBy, created_at: "t" });
  mk(null, 0.6, "won");      // resolution → counts
  mk(null, 0.4, "lost");     // resolution → counts
  mk("early", 0.9, "won");   // cash-out → excluded
  mk("partial", 0.9, "won"); // partial fixation → excluded
  recomputeMetrics(db, strat.id);
  assert.equal(R.getQuality(db, strat.id)!.samples, 2, "only the two resolution-settled bets feed metrics");
});

test("settleStaleOpenBets settles a finished-with-score match whose bet was left open", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const m = R.getMatch(db, "m-finished")!;
  assert.equal(m.state, "finished");
  assert.ok(m.score_home != null && m.score_away != null, "m-finished has a known score");
  const strat = R.listStrategies(db, "football")[0];
  // a bet the finish-before-score path left open (settleMatch's skip branch)
  R.insertBet(db, { id: "stale-1", match_id: "m-finished", strategy_id: strat.id, market_label: "Over 0.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.7, stake: 100, rationale: null, entered_minute: "предматч", result: null, payout: null, settled_by: null, created_at: "t" });
  const settled = settleStaleOpenBets(db);
  assert.ok(settled >= 1, "the sweep settled the stale open bet");
  assert.notEqual(R.getBet(db, "stale-1")!.status, "open", "bet is no longer open");
});

test("upsertImportedMatch does not merge fixtures that only share a club suffix", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const compId = R.uid();
  R.upsertCompetition(db, { id: compId, sport_id: "football", name: "EPL", budget: 0, external_league: "eng.1", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: compId, home: "Manchester United", away: "Arsenal", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "pm:mu-ars" });
  // "Newcastle United vs Arsenal" shares only the "United"/"Arsenal" tokens — a
  // DIFFERENT fixture; must NOT merge (the old teamKey bug merged on "united").
  const diff = upsertImportedMatch(db, compId, { externalRef: "espn-1", home: "Newcastle United", away: "Arsenal", state: "live", minute: 10, scoreHome: 0, scoreAway: 0, final: false });
  assert.equal(diff.created, true, "different fixture → new row");
  assert.equal(R.getMatch(db, mid)!.external_ref, "pm:mu-ars", "Man United match left untouched");
  // the SAME fixture (exact names) DOES merge and adopts the ESPN ref
  const same = upsertImportedMatch(db, compId, { externalRef: "espn-2", home: "Manchester United", away: "Arsenal", state: "live", minute: 10, scoreHome: 0, scoreAway: 0, final: false });
  assert.equal(same.created, false, "same fixture → merged");
  assert.equal(R.getMatch(db, mid)!.external_ref, "espn-2", "ESPN id adopted");
});

// ---------------- triggers + rate limit (§9.7) ----------------
test("canReassess enforces the minute gap", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  assert.equal(canReassess(db, "m-live", "flat", 30, 5), true); // no prior for flat
  R.insertReassessment(db, { id: R.uid(), match_id: "m-live", strategy_id: "flat", minute: "30'", body: "x", confidence: "средняя", trigger: "goal", created_at: "t" });
  assert.equal(canReassess(db, "m-live", "flat", 33, 5), false); // gap 3 < 5
  assert.equal(canReassess(db, "m-live", "flat", 40, 5), true); // gap 10 >= 5
});

test("canReassess ignores a later null-minute (manual) reassessment for the gap", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.insertReassessment(db, { id: R.uid(), match_id: "m-live", strategy_id: "flat", minute: "30'", body: "x", confidence: "средняя", trigger: "goal", created_at: "t1" });
  R.insertReassessment(db, { id: R.uid(), match_id: "m-live", strategy_id: "flat", minute: null, body: "manual", confidence: "средняя", trigger: "manual", created_at: "t2" });
  // Must still measure the gap against minute 30 (the null-minute manual one
  // used to reset the limit and let a too-soon auto trigger through).
  assert.equal(canReassess(db, "m-live", "flat", 33, 5), false); // gap 3 < 5
  assert.equal(canReassess(db, "m-live", "flat", 40, 5), true);
});

test("latestMarkets picks the last-inserted snapshot on equal timestamps", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const ts = "2026-07-04T00:00:00.000Z";
  R.insertMarket(db, { id: R.uid(), match_id: "m-live", label: "TieBreak", price: 40, ai_prob: null, liquidity: null, external_ref: "t", snapshot_at: ts, is_closing: false });
  R.insertMarket(db, { id: R.uid(), match_id: "m-live", label: "TieBreak", price: 55, ai_prob: null, liquidity: null, external_ref: "t", snapshot_at: ts, is_closing: false });
  const m = R.latestMarkets(db, "m-live").find((x) => x.label === "TieBreak")!;
  assert.equal(m.price, 55); // rowid DESC tiebreaker => last write wins
});

test("syncMatchStatus: goal triggers reassessment then rate-limits", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.updateMatch(db, "m-live", { external_ref: "SIM1" });
  const st = (sh: number, sa: number, min: number, state: any = "live", final = false): SportsMatchStatus =>
    ({ externalRef: "SIM1", home: "Бразилия", away: "Англия", state, minute: min, scoreHome: sh, scoreAway: sa, final });

  const goal1 = await syncMatchStatus(db, st(2, 0, 75), CFG);
  assert.equal(goal1!.goals, 1);
  assert.ok(goal1!.reassessments.some((r) => r.strategyId === "flat" && r.created));

  const goal2 = await syncMatchStatus(db, st(3, 0, 76), CFG);
  assert.ok(goal2!.reassessments.every((r) => !r.created)); // all rate-limited
  assert.ok(goal2!.reassessments.some((r) => /rate-limited/.test(r.reason ?? "")));
});

test("syncMatchStatus: finish settles open bets and recomputes metrics", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.updateMatch(db, "m-live", { external_ref: "SIM1" });
  const final: SportsMatchStatus = { externalRef: "SIM1", home: "Бразилия", away: "Англия", state: "finished", minute: 90, scoreHome: 3, scoreAway: 0, final: true };
  const res = await syncMatchStatus(db, final, CFG, { "Advance Бразилия": true });
  assert.equal(res!.to, "finished");
  assert.ok(res!.settlement!.settled >= 3);

  const bets = R.betsForMatch(db, "m-live");
  assert.ok(bets.every((b) => b.status.startsWith("settled")));
  assert.ok(bets.every((b) => b.payout != null));

  const q = R.getQuality(db, "edge");
  assert.ok(q!.samples >= 2, "metrics recomputed from settled bets");
});

test("F2: a premature finish (46', no abandoned flag) FREEZES settlement (state_suspect); a valid finish settles", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.updateMatch(db, "m-live", { external_ref: "SIM1" });
  // Feed dies at half-time and reports finished@46' — the state machine must NOT settle on the HT score.
  const premature: SportsMatchStatus = { externalRef: "SIM1", home: "Бразилия", away: "Англия", state: "finished", minute: 46, scoreHome: 1, scoreAway: 0, final: true };
  const r1 = await syncMatchStatus(db, premature, CFG, { "Advance Бразилия": true });
  assert.equal(r1!.settlement, undefined, "no settlement on a suspect finish");
  assert.ok(R.betsForMatch(db, "m-live").every((b) => !b.status.startsWith("settled")), "positions stay open (money not resolved)");
  const { isStateSuspect } = await import("../src/lib/engine.js");
  assert.equal(isStateSuspect(db, "m-live"), true, "match flagged state_suspect");
  assert.equal(await import("../src/lib/engine.js").then((e) => e.settleStaleOpenBets(db, CFG)), 0, "the sweep also refuses to settle a suspect finish");
  // The feed resumes and reports a VALID full-time finish → un-freeze, and the sweep settles it.
  const valid: SportsMatchStatus = { externalRef: "SIM1", home: "Бразилия", away: "Англия", state: "finished", minute: 90, scoreHome: 3, scoreAway: 0, final: true };
  await syncMatchStatus(db, valid, CFG, { "Advance Бразилия": true });
  assert.equal(isStateSuspect(db, "m-live"), false, "valid finish clears the suspect mark");
  const swept = await import("../src/lib/engine.js").then((e) => e.settleStaleOpenBets(db, CFG));
  assert.ok(swept >= 1, "now the sweep settles it");
  assert.ok(R.betsForMatch(db, "m-live").every((b) => b.status.startsWith("settled")), "positions settled on the real full-time result");
});

test("syncMatchStatus: first finish stamps a Warsaw end_time + Warsaw kickoff + duration", async () => {
  const { durationLabel } = await import("../src/lib/time.js");
  assert.equal(durationLabel("2026-07-11T14:00:00Z", "2026-07-11T16:01:00Z"), "2 ч 1 мин");
  assert.equal(durationLabel("x", "2026-07-11T16:01:00Z"), null, "non-ISO → null");

  const db = openDb(":memory:");
  seedDatabase(db);
  R.updateMatch(db, "m-live", { external_ref: "SIM1", kickoff_at: "2026-07-11T14:00:00.000Z" });
  const final: SportsMatchStatus = { externalRef: "SIM1", home: "Бразилия", away: "Англия", state: "finished", minute: 90, scoreHome: 2, scoreAway: 2, final: true };
  await syncMatchStatus(db, final, { ...CFG, now: () => "2026-07-11T16:01:00.000Z" } as any);
  const m = R.getMatch(db, "m-live")!;
  // end_time is now stored as the raw ISO instant (so the UI can render both the clock AND the dated
  // label from it, matching tennis); it renders to 18:01 Warsaw (16:01 UTC + CEST) via warsawClock.
  const { warsawClock, warsawLabel } = await import("../src/lib/time.js");
  assert.equal(m.end_time, "2026-07-11T16:01:00.000Z", "stored as the ISO instant, not a pre-formatted clock");
  assert.equal(warsawClock(m.end_time), "18:01", "renders to 18:01 Warsaw (CEST)");
  assert.match(warsawLabel(m.end_time)!, /11\.07.*18:01/, "the dated label the football card now shows");
  assert.equal(m.kickoff_time, "16:00", "14:00 UTC → 16:00 Warsaw");
  assert.equal(m.duration, "2 ч 1 мин", "14:00→16:01 span");
});

// ---------------- odds refresh: versioned snapshot + mark-to-market + price_move ----------------
test("refreshMatchOdds writes a snapshot, marks to market, and triggers on a big move", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.updateMatch(db, "m-live", { minute: 90 }); // past the seeded 63' reassessment so price_move isn't rate-limited
  const before = R.latestMarkets(db, "m-live").length;
  // mock CLOB midpoint 0.50 -> 50¢ for every token
  const fetchImpl = (async () => ({ ok: true, json: async () => ({ mid: "0.50" }) })) as unknown as typeof fetch;
  const res = await refreshMatchOdds(db, "m-live", {
    fetchImpl,
    polymarket: { enabled: true, gammaBase: "", clobBase: "", timeoutMs: 1000, discoverLimit: 300, maxMarketsPerMatch: 16, minLiquidity: 0, exec: { edgeFloorCents: 1.5, maxImpactCents: 2, fallbackK: 4, takerFeeRate: 0.03 } },
    config: { reassessGapMinutes: 5, priceMoveThreshold: 5 },
    now: () => "2026-07-03T13:00:00Z",
  });
  assert.ok(res.updated > 0);
  // Over 1.5 (62¢ -> 50¢, delta 12) => open edge bet marked to market + price_move trigger
  const over = R.latestMarkets(db, "m-live").find((m) => m.label === "Over 1.5")!;
  assert.equal(over.price, 50);
  assert.ok(R.latestMarkets(db, "m-live").length >= before); // new snapshots layered on
  const edgeOver = R.betsForMatch(db, "m-live", "edge").find((b) => b.market_label === "Over 1.5")!;
  // marked to LIQUIDATION value (mid 50¢ haircut for exit slippage + exit fee), i.e.
  // below the raw mid — this bet is large vs the market's liquidity, so the haircut
  // is sizeable, which is exactly the point: a thin-market position isn't overstated.
  assert.ok(edgeOver.current_price != null && edgeOver.current_price > 0 && edgeOver.current_price < 50, `liquidation MTM below mid, got ${edgeOver.current_price}`);
  assert.ok(res.triggers.some((t) => t.created), "price_move reassessment fired");
});

test("refreshMatchOdds marks to market but fires NO price_move trigger pre-match (not live)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mid = R.uid();
  // lineup_out by the timer, but NOT live: a big pre-match Polymarket move must
  // mark to market yet NOT trigger a reassessment (§3.3 — triggers are live-only).
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "lineup", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 62, ai_prob: 0.6, liquidity: null, external_ref: "tok-a", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: "edge", market_label: "Over 1.5", status: "open", proposed_price: 62, entry_price: 62, current_price: 62, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  const fetchImpl = (async () => ({ ok: true, json: async () => ({ mid: "0.50" }) })) as unknown as typeof fetch;
  const res = await refreshMatchOdds(db, mid, {
    fetchImpl,
    polymarket: { enabled: true, gammaBase: "", clobBase: "", timeoutMs: 1000, discoverLimit: 300, maxMarketsPerMatch: 16, minLiquidity: 0, exec: { edgeFloorCents: 1.5, maxImpactCents: 2, fallbackK: 4, takerFeeRate: 0.03 } },
    config: { reassessGapMinutes: 5, priceMoveThreshold: 5 },
    now: () => "2026-07-03T13:00:00Z",
  });
  assert.ok(res.updated > 0, "still re-quotes / marks to market");
  assert.equal(res.triggers.length, 0, "no price_move reassessment pre-match");
  assert.equal(R.reassessmentsForMatch(db, mid).length, 0);
});

// ---------------- metrics recompute directly ----------------
test("recomputeMetrics writes quality from settled bets", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // m-finished already has settled bets for edge
  recomputeMetrics(db, "edge");
  const q = R.getQuality(db, "edge");
  assert.ok(q && q.samples >= 2);
});

test("pruneStaleMatches keeps funded finished matches but drops unfunded/stale no-bet ones", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const funded = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const unfunded = R.listCompetitions(db).find((c) => c.sport_id === "football" && (c.budget ?? 0) <= 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mk = (id: string, compId: string, state: string, kickoff: string | null) => R.insertMatch(db, { id, competition_id: compId, home: "A"+id, away: "B"+id, state: state as any, lineup_out: false, kickoff_at: kickoff, minute: null, score_home: state === "finished" ? 1 : null, score_away: state === "finished" ? 0 : null, final_score: state === "finished" ? "1:0" : null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });

  mk("fin-funded", funded.id, "finished", "2026-07-05T00:00:00Z");  // finished in funded comp, fresh → KEEP
  mk("fin-funded-stale", funded.id, "finished", "2000-01-01T00:00:00Z"); // finished in funded comp but long past → prune
  mk("fin-unfunded", unfunded.id, "finished", null);               // finished, no budget → prune immediately
  mk("fin-withbet", unfunded.id, "finished", null);                // finished WITH a bet → keep even unfunded
  mk("live-nobet", funded.id, "live", null);                       // live, no bets → keep
  mk("upcoming-fresh", funded.id, "upcoming", "2999-01-01T00:00:00Z"); // future → keep
  mk("upcoming-stale", funded.id, "upcoming", "2000-01-01T00:00:00Z"); // long past, no bets → prune

  // give fin-withbet a settled bet + child rows on fin-unfunded to prove cascade
  R.insertBet(db, { id: "b-keep", match_id: "fin-withbet", strategy_id: strat.id, market_label: "Over 1.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: 55, ai_prob: 0.6, stake: 100, rationale: null, entered_minute: "3'", result: "won", payout: 120, settled_by: null, created_at: "t" });
  // child rows on the ONLY match this now prunes (upcoming-stale) to prove the cascade.
  R.insertMarket(db, { id: R.uid(), match_id: "upcoming-stale", label: "Over 2.5", price: 50, ai_prob: null, liquidity: null, external_ref: "tk", snapshot_at: "t", is_closing: false });
  R.insertReassessment(db, { id: R.uid(), match_id: "upcoming-stale", strategy_id: strat.id, minute: "10'", body: "x", confidence: null, trigger: "time", created_at: "t" });

  const removed = R.pruneStaleMatches(db, { staleBeforeMs: Date.parse("2020-01-01T00:00:00Z") });
  // NEW contract: FINISHED matches are the log archive — NEVER age-pruned here; only a stale NON-finished
  // import (upcoming that never resolved) is pruned. capMatchLogArchive bounds the finished archive by count.
  assert.equal(removed, 1, "only the stale upcoming import is pruned; finished matches are archived");
  assert.ok(R.getMatch(db, "fin-funded"), "funded finished kept");
  assert.ok(R.getMatch(db, "fin-funded-stale"), "even an OLD finished no-bet match is kept (archive)");
  assert.ok(R.getMatch(db, "fin-unfunded"), "even an unfunded finished no-bet match is kept (archive)");
  assert.equal(R.getMatch(db, "upcoming-stale"), null, "the stale upcoming import (never finished) is pruned");
  assert.ok(R.getMatch(db, "fin-withbet"), "match with betting history kept");
  assert.ok(R.getMatch(db, "live-nobet"), "live match kept");
  assert.ok(R.getMatch(db, "upcoming-fresh"), "future match kept");
  // children of the pruned match are gone (no FK-orphan / no leftover rows)
  assert.equal(R.latestMarkets(db, "upcoming-stale").length, 0);
  assert.equal(R.reassessmentsForMatch(db, "upcoming-stale").length, 0);
  assert.ok(R.getBet(db, "b-keep"));
  // audit trail: the one pruned match is recorded with a reason («куда попропало»).
  const audit = JSON.parse(R.metaGet(db, "pruned_matches_recent") as string);
  assert.equal(audit.total, 1);
  assert.ok(audit.pruned.every((p: any) => typeof p.reason === "string" && p.match && p.at), "carries match + reason + timestamp");
  assert.ok(audit.pruned.some((p: any) => /не завершился/.test(p.reason)), "the stale-import reason is captured");
});

test("listMatchLogs + capMatchLogArchive: the archive lists finished matches and the cap keeps the newest no-bet ones", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const fin = (id: string, end: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "H" + id, away: "A" + id, state: "finished", lineup_out: false, kickoff_at: end, minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: end, duration: null, end_note: null, external_ref: id });
  fin("old1", "2026-07-20T10:00:00Z");
  fin("old2", "2026-07-21T10:00:00Z");
  fin("new1", "2026-07-23T10:00:00Z");
  fin("bet1", "2026-07-19T10:00:00Z"); // has a bet → never capped
  R.insertBet(db, { id: R.uid(), match_id: "bet1", strategy_id: strat.id, market_label: "Over 1.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: 55, ai_prob: 0.6, stake: 100, rationale: null, entered_minute: "3'", result: "won", payout: 120, settled_by: null, created_at: "t" });

  const logs = R.listMatchLogs(db, 100);
  assert.ok(logs.length >= 4, "all finished matches listed");
  assert.equal(logs[0].id, "new1", "newest finish first");
  assert.equal(logs.find((l) => l.id === "bet1")!.betCount, 1, "bet count surfaced");

  // cap to the newest 2 NO-BET finished → old1 (oldest no-bet) pruned; new1+old2 kept; bet1 never touched.
  const removed = R.capMatchLogArchive(db, 2);
  assert.equal(removed, 1);
  assert.equal(R.getMatch(db, "old1"), null, "oldest no-bet finished pruned past the cap");
  assert.ok(R.getMatch(db, "new1") && R.getMatch(db, "old2"), "newest no-bet kept");
  assert.ok(R.getMatch(db, "bet1"), "bet-bearing match never capped");
});

test("listMatchLogs: out-of-perimeter tennis (ITF/Challenger/125/quali/doubles) is excluded; ATP/WTA + football stay", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const foot = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "itf", sport_id: "tennis", name: "ITF W15 Monastir", budget: 0, external_league: null, created_at: "t" } as any);
  R.upsertCompetition(db, { id: "chl", sport_id: "tennis", name: "Challenger Como", budget: 0, external_league: null, created_at: "t" } as any);
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP Washington", budget: 0, external_league: null, created_at: "t" } as any);
  const fin = (id: string, comp: string) => R.insertMatch(db, { id, competition_id: comp, home: "P" + id, away: "Q" + id, state: "finished", lineup_out: false, kickoff_at: "2026-07-24T10:00:00Z", minute: null, score_home: null, score_away: null, final_score: "2:0", kickoff_time: null, end_time: "2026-07-24T12:00:00Z", duration: null, end_note: null, external_ref: id } as any);
  fin("itf1", "itf"); fin("chl1", "chl"); fin("atp1", "atp"); fin("foot1", foot.id);
  const logs = R.listMatchLogs(db, 100);
  const ids = new Set(logs.map((l) => l.id));
  assert.ok(!ids.has("itf1"), "ITF excluded");
  assert.ok(!ids.has("chl1"), "Challenger excluded");
  assert.ok(ids.has("atp1"), "ATP kept");
  assert.ok(ids.has("foot1"), "football kept");
});

test("listMatchLogs: a BROKEN no-bet match (abandoned junk) is hidden; a broken match WITH a bet is kept", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const foot = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mk = (id: string, note: string | null) => R.insertMatch(db, { id, competition_id: foot.id, home: "H" + id, away: "A" + id, state: "finished", lineup_out: false, kickoff_at: "2026-07-24T10:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: "2026-07-24T12:00:00Z", duration: null, end_note: note, external_ref: id } as any);
  mk("clean", null);                          // normal finished no-bet → kept
  mk("broken_nobet", "⚠ поломан: заброшен"); // broken + no bet → hidden
  mk("broken_bet", "⚠ поломан: заброшен");   // broken + a real bet → kept (worth reviewing)
  R.insertBet(db, { id: R.uid(), match_id: "broken_bet", strategy_id: strat.id, market_label: "Over 1.5", status: "settled_lost", proposed_price: 50, entry_price: 50, current_price: 0, closing_price: 50, ai_prob: 0.5, stake: 40, rationale: "r", entered_minute: "3'", result: "lost", payout: 0, settled_by: null, created_at: "t" } as any);
  const ids = new Set(R.listMatchLogs(db, 100).map((l) => l.id));
  assert.ok(ids.has("clean"), "normal no-bet finished kept");
  assert.ok(!ids.has("broken_nobet"), "broken + no-bet abandoned junk hidden");
  assert.ok(ids.has("broken_bet"), "broken WITH a bet kept for review");
});

test("strategyCompExposure / strategyCompRealized aggregate across the whole competition", async () => {
  const { strategyCompExposure, strategyCompRealized } = await import("../src/lib/analysis.js");
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mA = R.uid(), mB = R.uid();
  for (const id of [mA, mB]) R.insertMatch(db, { id, competition_id: comp.id, home: "A"+id, away: "B"+id, state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  R.insertBet(db, { id: R.uid(), match_id: mA, strategy_id: strat.id, market_label: "Over 1.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 40, rationale: null, entered_minute: "10'", result: null, payout: null, created_at: "t" });
  R.insertBet(db, { id: R.uid(), match_id: mB, strategy_id: strat.id, market_label: "Under 2.5", status: "proposed", proposed_price: 55, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake: 30, rationale: null, entered_minute: null, result: null, payout: null, created_at: "t" });
  R.insertBet(db, { id: R.uid(), match_id: mB, strategy_id: strat.id, market_label: "BTTS", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: 55, ai_prob: 0.6, stake: 20, rationale: null, entered_minute: "5'", result: "won", payout: 44, created_at: "t" });
  assert.equal(strategyCompExposure(db, comp.id, strat.id), 70, "open 40 (mA) + proposed 30 (mB)"); // settled excluded
  assert.equal(strategyCompRealized(db, comp.id, strat.id), 24, "payout 44 − stake 20");
});

test("settleMatch: CLV closing = kickoff for pre-match bets, entry (neutral) for in-match", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Home", away: "Away", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 2, score_away: 0, final_score: "2:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // kickoff snapshot for the market = 40¢
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 40, ai_prob: 0.6, liquidity: null, external_ref: "tk", snapshot_at: "t1", is_closing: false });
  R.captureOpenOdds(db, mid, "t1");
  const pre = R.uid(), inm = R.uid();
  R.insertBet(db, { id: pre, match_id: mid, strategy_id: strat.id, market_label: "Over 1.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 60, closing_price: null, ai_prob: 0.6, stake: 100, rationale: null, entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  R.insertBet(db, { id: inm, match_id: mid, strategy_id: strat.id, market_label: "Over 1.5", status: "open", proposed_price: 70, entry_price: 70, current_price: 60, closing_price: null, ai_prob: 0.6, stake: 100, rationale: null, entered_minute: "63'", result: null, payout: null, created_at: "t" });
  settleMatch(db, R.getMatch(db, mid)!, {});
  assert.equal(R.getBet(db, pre)!.closing_price, 40, "pre-match bet benchmarked to kickoff (40)");
  assert.equal(R.getBet(db, inm)!.closing_price, 70, "in-match bet neutral (closing = entry 70)");
});

test("settleMatch: releases the shadow-bank reserve when a bet settles by result (no orphaned reserve)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "H", away: "A", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 2, score_away: 0, final_score: "2:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 60, ai_prob: 0.6, liquidity: null, external_ref: "tk", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Over 1.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 60, closing_price: null, ai_prob: 0.6, stake: 100, rationale: null, entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  // The shadow bank reserved capital against this bet at entry.
  R.insertShadowReserve(db, { id: R.uid(), bet_id: bid, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size: 45, is_live: 0, edge: 0.1, state: "reserved", settle_at: null, created_at: "t" });
  assert.equal(R.allShadowReserves(db).filter((r) => r.state === "reserved").length, 1, "reserve held while open");

  settleMatch(db, R.getMatch(db, mid)!, {});
  // The reserve is no longer 'reserved' — it moved to settling (frees after the lag),
  // so it's not orphaned capital inflating the pool for a bet that's already settled.
  assert.equal(R.allShadowReserves(db).filter((r) => r.state === "reserved").length, 0, "reserve released on result-settlement");
});

test("deleteStrategy: removes its shadow reserves/events/fill_costs (no leaked capital) (audit [6])", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid(), betId = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "H", away: "A", state: "live", lineup_out: true, kickoff_at: null, minute: 50, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertBet(db, { id: betId, match_id: mid, strategy_id: strat.id, market_label: "Over 1.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 55, closing_price: null, ai_prob: 0.5, stake: 100, rationale: null, entered_minute: "10'", result: null, payout: null, created_at: "t" });
  R.insertShadowReserve(db, { id: R.uid(), bet_id: betId, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size: 50, is_live: 0, edge: 0.1, state: "reserved", settle_at: null, created_at: "t" });
  R.insertShadowEvent(db, { id: R.uid(), bet_id: betId, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size_requested: 50, size_reserved: 50, verdict: "allowed", reason: null, is_live: 0, edge: 0.1, contention: 0, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.02, created_at: "t" });

  R.deleteStrategy(db, strat.id);
  assert.equal(R.allShadowReserves(db).filter((r) => r.strategy_id === strat.id).length, 0, "reserves removed with the strategy");
  assert.equal(R.allShadowEvents(db).filter((e) => e.strategy_id === strat.id).length, 0, "events removed with the strategy");
});

test("releaseOrphanReserves: drops a reserve whose bet already settled, keeps open & bet-less ones", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "H", away: "A", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const settledBet = R.uid(), openBet = R.uid();
  R.insertBet(db, { id: settledBet, match_id: mid, strategy_id: strat.id, market_label: "M1", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 100, closing_price: 100, ai_prob: 0.6, stake: 100, rationale: null, entered_minute: "10'", result: "won", payout: 200, created_at: "t" });
  R.insertBet(db, { id: openBet, match_id: mid, strategy_id: strat.id, market_label: "M2", status: "open", proposed_price: 50, entry_price: 50, current_price: 55, closing_price: null, ai_prob: 0.5, stake: 100, rationale: null, entered_minute: "10'", result: null, payout: null, created_at: "t" });
  const rsv = (betId: string, size: number) => R.insertShadowReserve(db, { id: R.uid(), bet_id: betId, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size, is_live: 0, edge: 0.1, state: "reserved", settle_at: null, created_at: "t" });
  rsv(settledBet, 45); // orphan — bet already settled
  rsv(openBet, 30);    // legit — bet still open
  rsv(R.uid(), 10);    // bet-less (isolated) — must be left untouched

  const released = R.releaseOrphanReserves(db);
  assert.equal(released, 1, "only the settled bet's reserve is dropped");
  const remaining = R.allShadowReserves(db).filter((r) => r.state === "reserved");
  assert.equal(remaining.length, 2, "open + bet-less reserves remain");
  assert.ok(!remaining.some((r) => r.bet_id === settledBet), "the orphaned reserve is gone");
});

test("settleMatch: orphaned PROPOSED bets are closed out as not_filled (never stuck «предлагается»)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Shandong", away: "Yunnan", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 2, score_away: 1, final_score: "2:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 1.5", price: 20, ai_prob: 0.4, liquidity: null, external_ref: "tk", snapshot_at: "t1", is_closing: false });
  // a proposal that never filled (no live coverage) — must not stay "proposed"
  const prop = R.uid();
  R.insertBet(db, { id: prop, match_id: mid, strategy_id: strat.id, market_label: "Under 1.5", status: "proposed", proposed_price: 20, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.4, stake: 72, rationale: "«Under 1.5»: edge …", entered_minute: null, result: null, payout: null, created_at: "t" });

  settleMatch(db, R.getMatch(db, mid)!, {});

  const b = R.getBet(db, prop)!;
  assert.equal(b.status, "not_filled", "orphaned proposal closed as not_filled, not left «предлагается»");
  assert.match(b.rationale ?? "", /вход не открывался/, "reason recorded on the bet");
});

test("seriesAllowFor: tennis unrestricted by default (liquidity + live-data gate), narrowable via env", async () => {
  const { seriesAllowFor } = await import("../src/lib/engine.js");
  assert.equal(seriesAllowFor("tennis", {}), null, "no series whitelist — show any liquid, covered tennis");
  assert.deepEqual([...seriesAllowFor("tennis", { TENNIS_SERIES: "atp, wta" })!].sort(), ["atp", "wta"]);
  assert.equal(seriesAllowFor("football", {}), null);
});

test("pruneRemovedCategories drops cricket + non-ATP tennis (no-bet), keeps ATP + bet-bearing", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertSport(db, "cricket", "Крикет");
  const strat = R.listStrategies(db, "football")[0];
  const mk = (comp: string, sport: string) => {
    R.upsertSport(db, sport, sport);
    R.upsertCompetition(db, { id: comp, sport_id: sport, name: comp, budget: 0, external_league: null, created_at: "t" });
    const id = R.uid();
    R.insertMatch(db, { id, competition_id: comp, home: "A"+id, away: "B"+id, state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
    return id;
  };
  mk("pm-atp", "tennis");                 // keep (ATP)
  mk("pm-wta", "tennis");                 // drop (non-ATP)
  mk("pm-atp-doubles", "tennis");         // drop (non-ATP)
  mk("pm-football", "football");          // drop (seriesless «прочее» catch-all)
  mk("pm-major-league-cricket", "cricket"); // drop (untracked sport)
  const betMatch = mk("pm-itf", "tennis");  // non-ATP but HAS a bet → keep
  R.insertBet(db, { id: R.uid(), match_id: betMatch, strategy_id: strat.id, market_label: "П1", status: "settled_won", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: 55, ai_prob: 0.6, stake: 40, rationale: null, entered_minute: "10'", result: "won", payout: 72, created_at: "t" });

  const removed = R.pruneRemovedCategories(db, { keepSports: new Set(["football", "tennis", "basketball", "esports"]), tennisSeriesAllow: new Set(["atp"]) });
  assert.equal(removed, 4, "wta, atp-doubles, pm-football catch-all, cricket removed");
  assert.ok(!R.listCompetitions(db).some((c) => c.id === "pm-football"), "«прочее» catch-all gone");
  assert.ok(R.listCompetitions(db).some((c) => c.id === "pm-atp"), "ATP kept");
  assert.ok(R.listCompetitions(db).some((c) => c.id === "pm-itf"), "bet-bearing tennis kept");
  assert.ok(!R.listCompetitions(db).some((c) => c.id === "pm-wta"), "WTA gone");
  assert.ok(!R.listCompetitions(db).some((c) => c.id === "pm-major-league-cricket"), "cricket gone");
  assert.equal(db.prepare("SELECT 1 FROM sports WHERE id='cricket'").get(), undefined, "empty cricket sport row dropped");
  assert.ok(db.prepare("SELECT 1 FROM sports WHERE id='tennis'").get(), "tennis sport row kept (still has comps)");
});

test("pruneRemovedCategories: UNRESTRICTED tennis (null allow) keeps every liquid series — display-only tennis survives", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertSport(db, "tennis", "Теннис");
  const mk = (comp: string) => {
    R.upsertCompetition(db, { id: comp, sport_id: "tennis", name: comp, budget: 0, external_league: null, created_at: "t" });
    const id = R.uid();
    R.insertMatch(db, { id, competition_id: comp, home: "A"+id, away: "B"+id, state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  };
  mk("pm-swiss-open"); mk("pm-itf-irvine"); mk("pm-wta-cervia");
  // null allow-list = no series restriction (the real default via seriesAllowFor).
  const removed = R.pruneRemovedCategories(db, { keepSports: new Set(["football", "tennis"]), tennisSeriesAllow: null });
  assert.equal(removed, 0, "no tennis category pruned when unrestricted");
  for (const id of ["pm-swiss-open", "pm-itf-irvine", "pm-wta-cervia"])
    assert.ok(R.listCompetitions(db).some((c) => c.id === id), `${id} kept`);
});

test("pruneRemovedCategories: DOUBLES is always pruned, even when tennis is otherwise unrestricted", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertSport(db, "tennis", "Теннис");
  const mk = (id: string) => {
    R.upsertCompetition(db, { id, sport_id: "tennis", name: id, budget: 0, external_league: null, created_at: "t" });
    return id;
  };
  mk("pm-atp-singles"); mk("pm-wta-doubles"); mk("pm-atp-mixed-doubles");
  // unrestricted (null) — singles kept, but doubles are never tradeable → always gone.
  const removed = R.pruneRemovedCategories(db, { keepSports: new Set(["football", "tennis"]), tennisSeriesAllow: null });
  assert.equal(removed, 2, "both doubles comps pruned");
  assert.ok(R.listCompetitions(db).some((c) => c.id === "pm-atp-singles"), "singles kept");
  assert.ok(!R.listCompetitions(db).some((c) => c.id === "pm-wta-doubles"), "wta-doubles gone");
  assert.ok(!R.listCompetitions(db).some((c) => c.id === "pm-atp-mixed-doubles"), "mixed-doubles gone");
});

test("pruneRemovedCategories retires a dropped sport ENTIRELY — funded comp + strategy + shares + bets", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertSport(db, "tennis", "Теннис");
  // a FUNDED tennis category with a tennis strategy, a share, a match and a bet —
  // exactly the state that used to survive pruning (budget + shares + P&L guards).
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 10000, external_league: null, created_at: "t" });
  R.insertStrategy(db, { id: "tn1", sport_id: "tennis", name: "Serve Edge", tag: null, color: "#fff", version: 1, model: "Claude Sonnet 5", model_live: null, prompt: "x", prompt_live: null, params: {}, created_at: "t" });
  R.setShare(db, { competition_id: "pm-atp", strategy_id: "tn1", pct: 100 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-atp", home: "Alcaraz", away: "Sinner", state: "finished", lineup_out: true, kickoff_at: null, minute: null, score_home: 2, score_away: 1, final_score: "2:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertBet(db, { id: "b-tn", match_id: mid, strategy_id: "tn1", market_label: "П1", status: "settled_won", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: 55, ai_prob: 0.6, stake: 100, rationale: null, entered_minute: "10'", result: "won", payout: 180, created_at: "t" });

  // tennis is NOT in keepSports → the whole sport is retired regardless of funding.
  R.pruneRemovedCategories(db, { keepSports: new Set(["football"]), tennisSeriesAllow: new Set() });
  assert.ok(!R.listCompetitions(db).some((c) => c.id === "pm-atp"), "funded tennis comp removed");
  assert.equal(R.getStrategy(db, "tn1"), null, "tennis strategy removed");
  assert.equal(R.getMatch(db, mid), null, "tennis match removed");
  assert.equal(R.getBet(db, "b-tn"), null, "tennis bet removed");
  assert.equal(db.prepare("SELECT 1 FROM strategy_shares WHERE strategy_id='tn1'").get(), undefined, "share removed");
  assert.equal(db.prepare("SELECT 1 FROM sports WHERE id='tennis'").get(), undefined, "tennis sport row (tab) gone");
  // football untouched
  assert.ok(db.prepare("SELECT 1 FROM sports WHERE id='football'").get(), "football kept");
  assert.ok(R.listStrategies(db, "football").length >= 1, "football strategies kept");
});

test("espnLeagueForSeries: covered leagues resolve, uncovered (tennis/minor) return null", async () => {
  const { espnLeagueForSeries } = await import("../src/lib/engine.js");
  assert.equal(espnLeagueForSeries("FIFA World Cup", "soccer-fifwc"), "fifa.world");
  assert.equal(espnLeagueForSeries("UEFA Champions League", "soccer-ucl"), "uefa.champions");
  assert.equal(espnLeagueForSeries("Allsvenskan", "soccer-allsvenskan"), "swe.1"); // via name inference
  assert.equal(espnLeagueForSeries("Chinese Super League", "soccer-csl"), "chn.1"); // ESPN chn.1 DOES carry it
  assert.equal(espnLeagueForSeries("Denmark Superliga", "denmark-superliga"), "den.1"); // NOT tur.1 — Turkish süper-lig rule must not swallow "Superliga"
  assert.equal(espnLeagueForSeries("Süper Lig", "super-lig"), "tur.1");                 // real Turkish league still maps
  assert.equal(espnLeagueForSeries("Morocco Botola", "soccer-botola"), null);      // ESPN doesn't cover → skip
  assert.equal(espnLeagueForSeries(null, "atp-alcaraz-sinner"), null);             // tennis → no mapping → skip
  assert.equal(espnLeagueForSeries(null, null), null);
  // [H4 / Phase 3.2] the championship rule is anchored to the ENGLISH second tier only.
  assert.equal(espnLeagueForSeries("EFL Championship", null), "eng.2");
  assert.equal(espnLeagueForSeries("English Championship", null), "eng.2");
  assert.notEqual(espnLeagueForSeries("European Championship", null), "eng.2", "the bare word no longer binds English 2nd-tier data");
  assert.notEqual(espnLeagueForSeries("Scottish Championship", null), "eng.2");
});

test("espnLeagueForSeries: UEFA cups resolve by NAME (fixes null/aus.1 mis-map) and don't collide", async () => {
  const { espnLeagueForSeries } = await import("../src/lib/engine.js");
  // These arrived from Polymarket with slugs the SERIES_ESPN_LEAGUE table doesn't
  // list, so they must resolve via name inference — previously UCL→null (unfunded)
  // and UEL wrongly matched /a-?league/ → aus.1.
  assert.equal(espnLeagueForSeries("UEFA Champions League 2025", "champions-league-2025"), "uefa.champions");
  assert.equal(espnLeagueForSeries("UEFA Europa League 2025", "europa-league-2025"), "uefa.europa");
  assert.equal(espnLeagueForSeries("UEFA Europa Conference League", "conference-league"), "uefa.europa.conf");
  assert.equal(espnLeagueForSeries("UEFA Women's Champions League", "womens-champions-league"), "uefa.wchampions");
  // Real A-League still resolves; "Europa League" no longer leaks into it.
  assert.equal(espnLeagueForSeries("Australian A-League", "a-league"), "aus.1");
  // Newly-linked leagues (ESPN codes verified live against the scoreboard API).
  assert.equal(espnLeagueForSeries("NWSL", "nwsl"), "usa.nwsl");
  assert.equal(espnLeagueForSeries("Brazil Serie B", "brazil-serie-b"), "bra.2");
  assert.equal(espnLeagueForSeries("Brazil Serie A", "brazil-serie-a"), "bra.1"); // Serie B rule doesn't swallow A
  assert.equal(espnLeagueForSeries("Liga 1", "liga-1"), "per.1");     // Polymarket "Liga 1" = Peru (pinned by slug)
  assert.equal(espnLeagueForSeries("Romania 1", "romania-1"), "rou.1");
  // NOT on ESPN (scoreboard returns no league object) → stay UNMAPPED, so discovery
  // skips them and they're never funded: K-League, Australia Cup.
  assert.equal(espnLeagueForSeries("K-league", "k-league"), null);
  assert.equal(espnLeagueForSeries("Australia Cup", "soccer-auc"), null);
  // Chinese Super League used to be here, but ESPN's chn.1 feed DOES carry it (probed live) — now mapped.
  assert.equal(espnLeagueForSeries("Chinese Super League", "chinese-super-league"), "chn.1");
});


test("F1 nameMatch: city exonyms bridge Polymarket↔ESPN spellings", () => {
  // the two confirmed coverage casualties from the 23.07 batch
  assert.ok(nameMatch("SK Rapid Wien", "Rapid Vienna"), "Wien↔Vienna");
  assert.ok(nameMatch("FK BATE Barysaŭ", "BATE Borisov"), "Barysaŭ↔Borisov");
  assert.ok(nameMatch("Bayern München", "Bayern Munich"), "München↔Munich");
  // full-fixture orientation via sameTeams (home/away either way)
  assert.ok(sameTeams("FC Santa Coloma", "SK Rapid Wien", "Santa Coloma", "Rapid Vienna"));
  // MUST NOT create false matches: two different Vienna clubs stay distinct (distinctive token differs)
  assert.equal(nameMatch("Rapid Wien", "Austria Wien"), false, "shared city alone must not match");
  assert.equal(nameMatch("SK Rapid Wien", "Rapid Bucharest"), false);
});

test("P3 batch-7 nameMatch: club-name variants from the &probe audit bridge to ESPN's spelling", () => {
  assert.ok(nameMatch("AEK Lárnakas", "AEK Larnaca"), "Lárnakas↔Larnaca");
  assert.ok(nameMatch("FK Polissia", "Polissya Zhitomir"), "Polissia↔Polissya");
  assert.ok(nameMatch("Tobyl FK", "Tobol Kostanay"), "Tobyl↔Tobol");
  assert.ok(nameMatch("NK Varaždin", "Varteks"), "Varaždin↔Varteks (historical name)");
  assert.ok(nameMatch("Zirə FK", "Zira FK"), "schwa ə folds to a");
  // no false matches: the aliases only bridge the intended pairs, distinctive tokens still gate
  assert.equal(nameMatch("AEK Lárnakas", "AEK Athens"), false, "AEK alone (a shared prefix) must not match");
  assert.equal(nameMatch("Tobyl FK", "Astana FK"), false);
});

test("R2(а) repairCategoryLeagues: a stale wrong slug (Denmark stamped tur.1) is corrected to den.1; a null is backfilled; a correct one is untouched; tennis is never touched", () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Football");
  R.upsertSport(db, "tennis", "Tennis");
  // stale/wrong: "Denmark Superliga" inference is den.1, but stored tur.1 (pre-rule value)
  R.upsertCompetition(db, { id: "pm-denmark-superliga", sport_id: "football", name: "Denmark Superliga", budget: 8000, external_league: "tur.1", created_at: "t" });
  // null → should be backfilled to swe.1
  R.upsertCompetition(db, { id: "pm-sweden-allsvenskan-2026", sport_id: "football", name: "Sweden Allsvenskan 2026", budget: 8000, external_league: null, created_at: "t" });
  // already correct → left alone (no churn)
  R.upsertCompetition(db, { id: "pm-brazil-serie-b", sport_id: "football", name: "Brazil Serie B", budget: 8000, external_league: "bra.2", created_at: "t" });
  // tennis comp with a NON-ESPN scope slug → must never be "corrected"
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 1000, external_league: "atp", created_at: "t" });

  const fixes = repairCategoryLeagues(db, "2026-07-24T00:00:00Z");
  const byComp = new Map(fixes.map((f) => [f.comp, f]));
  assert.equal(byComp.get("pm-denmark-superliga")?.from, "tur.1");
  assert.equal(byComp.get("pm-denmark-superliga")?.to, "den.1");
  assert.ok(byComp.has("pm-sweden-allsvenskan-2026")); // null → swe.1 backfill counts as a fix
  assert.equal(byComp.get("pm-sweden-allsvenskan-2026")?.to, "swe.1");
  assert.ok(!byComp.has("pm-brazil-serie-b"), "already-correct comp not touched");
  assert.ok(!byComp.has("pm-atp"), "tennis comp never touched");

  const comps = new Map(R.listCompetitions(db).map((c) => [c.id, c.external_league]));
  assert.equal(comps.get("pm-denmark-superliga"), "den.1", "Denmark now queries the Danish board");
  assert.equal(comps.get("pm-atp"), "atp", "tennis scope slug preserved");

  // idempotent: a second pass finds nothing
  assert.equal(repairCategoryLeagues(db, "2026-07-24T00:01:00Z").length, 0);
  // audit ring recorded the correction
  const ring = JSON.parse(R.metaGet(db, "league_map_fixes_recent") ?? "[]");
  assert.ok(ring.some((r: { comp: string; to: string }) => r.comp === "pm-denmark-superliga" && r.to === "den.1"));
});

test("R2(б) name-fold: Swedish å romanized 'aa' (Vasteraas) matches ESPN 'Västerås' so a covered swe.1 fixture binds", () => {
  assert.ok(nameMatch("Vasteraas SK", "Västerås SK"), "Vasteraas ↔ Västerås");
  assert.ok(nameMatch("Orgryte IS", "Örgryte IS"), "Orgryte ↔ Örgryte");
  assert.ok(sameTeams("Vasteraas SK", "Orgryte IS", "Örgryte IS", "Västerås SK"), "reversed pair still matches");
});

test("R2(б) listBlindFundedFootball: funded football past kickoff with no match_live is flagged (no silent blindness); bound/tennis/pre-kickoff/no-budget are not", () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Football");
  R.upsertSport(db, "tennis", "Tennis");
  R.upsertCompetition(db, { id: "pm-denmark-superliga", sport_id: "football", name: "Denmark Superliga", budget: 8000, external_league: "den.1", created_at: "t" });
  R.upsertCompetition(db, { id: "pm-romania-1", sport_id: "football", name: "Romania 1", budget: 8000, external_league: null, created_at: "t" });
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 1000, external_league: "atp", created_at: "t" });
  R.upsertCompetition(db, { id: "pm-unfunded", sport_id: "football", name: "Some League", budget: 0, external_league: "eng.1", created_at: "t" });
  const now = Date.parse("2026-07-24T22:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const mk = (id: string, comp: string, koMs: number, live = false) => {
    R.insertMatch(db, { id, competition_id: comp, home: `${id}H`, away: `${id}A`, state: "finished", lineup_out: false, kickoff_at: iso(koMs), minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
    if (live) R.upsertMatchLive(db, { match_id: id, espn_event_id: "e"+id, league: "den.1", espn_event_date: null, home_lineup: null, away_lineup: null, stats: null, updated_at: iso(koMs) } as any);
  };
  mk("blindDen", "pm-denmark-superliga", now - 3 * 3600_000);         // funded, past kickoff, no bind → flagged unbound
  mk("blindRou", "pm-romania-1", now - 3 * 3600_000);                 // funded, no external_league → flagged no_league
  mk("boundDen", "pm-denmark-superliga", now - 3 * 3600_000, true);   // has match_live → NOT flagged
  mk("preDen", "pm-denmark-superliga", now + 3 * 3600_000);           // kickoff in future → NOT flagged
  mk("tennisM", "pm-atp", now - 3 * 3600_000);                        // tennis → NOT flagged
  mk("unfunded", "pm-unfunded", now - 3 * 3600_000);                  // budget 0 → NOT flagged

  const blind = R.listBlindFundedFootball(db, { nowMs: now });
  const ids = new Set(blind.map((b) => b.id));
  assert.ok(ids.has("blindDen") && ids.has("blindRou"), "both blind funded football matches flagged");
  assert.ok(!ids.has("boundDen") && !ids.has("preDen") && !ids.has("tennisM") && !ids.has("unfunded"), "bound/pre-kickoff/tennis/unfunded excluded");
  assert.equal(blind.find((b) => b.id === "blindDen")?.reason, "unbound");
  assert.equal(blind.find((b) => b.id === "blindRou")?.reason, "no_league");
});

// ── ПОЛОВИНА ЗАПИСИ: КОРЕНЬ КЛАССА `bound_no_score` ──────────────────────────────────────────────
// enrich всегда писал счёт по сторонам, а строку `final_score` — только при флаге `s.final`. Матч,
// доехавший до finished через `state === "finished"` без `completed`, получал половину записи: счёт в
// соседней колонке есть, строки нет. Это и был весь класс на проде — 3 матча MLS 23.07 с 14 ставками,
// выглядевшие как «счёт не добрался». Вторым багом в той же строке было `${sh ?? 0}:${sa ?? 0}`:
// неизвестный счёт превращался в утверждение «0:0», то есть дыра закрашивалась нулём.

test("завершённость БЕЗ флага final всё равно даёт final_score — половина записи и есть корень bound_no_score", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-mls", sport_id: "football", name: "MLS 2025", budget: 8000, external_league: "usa.1", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-mls", home: "Portland Timbers", away: "FC Dallas", state: "live", lineup_out: true, kickoff_at: "2026-07-23T02:30:00Z", minute: 80, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });

  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_s: string, league: string) {
      if (league !== "usa.1") return [];
      // ИМЕННО ТАК приходил прод: состояние finished, но флаг completed НЕ выставлен.
      return [{ externalRef: "E1", home: "Portland Timbers", away: "FC Dallas", state: "finished", minute: 90, scoreHome: 2, scoreAway: 1, final: false, date: "2026-07-23T02:30:00Z" }] as SportsMatchStatus[];
    },
    async matchDetail() { return { lineupOut: false, lineups: { home: null, away: null }, events: [] } as MatchDetail; },
  };

  await enrichFromEspn(db, provider, {});
  const m = R.getMatch(db, mid)!;
  assert.equal(m.state, "finished");
  assert.equal(m.score_home, 2);
  assert.equal(m.final_score, "2:1", "строка обязана появиться по ЗАВЕРШЁННОСТИ, а не по флагу final");
});

test("завершённое событие БЕЗ счёта не получает выдуманное «0:0» — дыра не закрашивается нулём", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertCompetition(db, { id: "pm-mls", sport_id: "football", name: "MLS 2025", budget: 8000, external_league: "usa.1", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-mls", home: "LA Galaxy", away: "St. Louis City SC", state: "live", lineup_out: true, kickoff_at: "2026-07-23T02:30:00Z", minute: 80, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });

  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_s: string, league: string) {
      if (league !== "usa.1") return [];
      return [{ externalRef: "E2", home: "LA Galaxy", away: "St. Louis City SC", state: "finished", minute: 90, scoreHome: null, scoreAway: null, final: true, date: "2026-07-23T02:30:00Z" }] as SportsMatchStatus[];
    },
    async matchDetail() { return { lineupOut: false, lineups: { home: null, away: null }, events: [] } as MatchDetail; },
  };

  await enrichFromEspn(db, provider, {});
  const m = R.getMatch(db, mid)!;
  assert.equal(m.state, "finished");
  assert.equal(m.final_score, null, "нет счёта — нет строки; «0:0» было бы утверждением о безголевой ничьей");
});
