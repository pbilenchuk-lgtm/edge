import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { parseEspnEvent, parseEspnSummary, MockSportsProvider } from "../src/lib/sports.js";
import {
  canReassess, syncMatchStatus, refreshMatchOdds, recomputeMetrics, enrichFromEspn, upsertImportedMatch, settleStaleOpenBets, settleMatch, syncCompetitions,
} from "../src/lib/engine.js";
import { matchContext } from "../src/lib/analysis.js";
import type { SportsMatchStatus, SportsProvider, MatchDetail } from "../src/lib/sports.js";

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

  const res = await enrichFromEspn(db, provider, {});
  assert.equal(res.enriched, 1, "the short-named esports match now reconciles with the provider");
  const em = R.getMatch(db, eid)!;
  assert.equal(em.state, "finished", "provider 'Finished' status finishes it — no more infinite clock");
  assert.equal(em.final_score, "3:0");
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
  R.insertMarket(db, { id: R.uid(), match_id: "fin-unfunded", label: "Over 2.5", price: 50, ai_prob: null, liquidity: null, external_ref: "tk", snapshot_at: "t", is_closing: false });
  R.insertReassessment(db, { id: R.uid(), match_id: "fin-unfunded", strategy_id: strat.id, minute: "10'", body: "x", confidence: null, trigger: "time", created_at: "t" });

  const removed = R.pruneStaleMatches(db, { staleBeforeMs: Date.parse("2020-01-01T00:00:00Z") });
  assert.equal(removed, 3, "fin-funded-stale + fin-unfunded + upcoming-stale pruned");
  assert.ok(R.getMatch(db, "fin-funded"), "funded finished match kept for review");
  assert.equal(R.getMatch(db, "fin-funded-stale"), null);
  assert.equal(R.getMatch(db, "fin-unfunded"), null);
  assert.equal(R.getMatch(db, "upcoming-stale"), null);
  assert.ok(R.getMatch(db, "fin-withbet"), "match with betting history kept");
  assert.ok(R.getMatch(db, "live-nobet"), "live match kept");
  assert.ok(R.getMatch(db, "upcoming-fresh"), "future match kept");
  // children of the pruned match are gone (no FK-orphan / no leftover rows)
  assert.equal(R.latestMarkets(db, "fin-unfunded").length, 0);
  assert.equal(R.reassessmentsForMatch(db, "fin-unfunded").length, 0);
  // the kept bet survives
  assert.ok(R.getBet(db, "b-keep"));
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

test("pruneRemovedCategories retires a dropped sport ENTIRELY — funded comp + strategy + shares + bets", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.upsertSport(db, "tennis", "Теннис");
  // a FUNDED tennis category with a tennis strategy, a share, a match and a bet —
  // exactly the state that used to survive pruning (budget + shares + P&L guards).
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 10000, external_league: null, created_at: "t" });
  R.insertStrategy(db, { id: "tn1", sport_id: "tennis", name: "Serve Edge", tag: null, color: "#fff", version: 1, model: "Claude Sonnet 5", prompt: "x", prompt_live: null, params: {}, created_at: "t" });
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
  assert.equal(espnLeagueForSeries("Morocco Botola", "soccer-botola"), null);      // ESPN doesn't cover → skip
  assert.equal(espnLeagueForSeries(null, "atp-alcaraz-sinner"), null);             // tennis → no mapping → skip
  assert.equal(espnLeagueForSeries(null, null), null);
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
  // skips them and they're never funded: K-League, Australia Cup, Chinese Super League.
  assert.equal(espnLeagueForSeries("K-league", "k-league"), null);
  assert.equal(espnLeagueForSeries("Australia Cup", "soccer-auc"), null);
  assert.equal(espnLeagueForSeries("Chinese Super League", "chinese-super-league"), null);
});

