import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { parseEspnEvent, parseEspnSummary, MockSportsProvider } from "../src/lib/sports.js";
import {
  canReassess, syncMatchStatus, refreshMatchOdds, recomputeMetrics, enrichFromEspn, upsertImportedMatch,
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
    polymarket: { enabled: true, gammaBase: "", clobBase: "", timeoutMs: 1000, discoverLimit: 300, maxMarketsPerMatch: 16 },
    config: { reassessGapMinutes: 5, priceMoveThreshold: 5 },
    now: () => "2026-07-03T13:00:00Z",
  });
  assert.ok(res.updated > 0);
  // Over 1.5 (62¢ -> 50¢, delta 12) => open edge bet marked to market + price_move trigger
  const over = R.latestMarkets(db, "m-live").find((m) => m.label === "Over 1.5")!;
  assert.equal(over.price, 50);
  assert.ok(R.latestMarkets(db, "m-live").length >= before); // new snapshots layered on
  const edgeOver = R.betsForMatch(db, "m-live", "edge").find((b) => b.market_label === "Over 1.5")!;
  assert.equal(edgeOver.current_price, 50);
  assert.ok(res.triggers.some((t) => t.created), "price_move reassessment fired");
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
