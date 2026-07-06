import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { exitDecision } from "../src/lib/thresholds.js";
import { autoEnter, evaluateExits, autoAnalyze, strategistReassess, advanceClocks, runLiveCycle, recordMatchStats, formatMatchStats } from "../src/lib/lifecycle.js";
import { analyzeMatch } from "../src/lib/analysis.js";
import type { SportsProvider, MatchDetail } from "../src/lib/sports.js";

const mockLLM = (a: unknown) => (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(a) }] }) })) as any;

test("exitDecision: take-profit, stop, edge-gone, hold", () => {
  const P = { takeProfit: 0.5, exitStop: 0.5 };
  assert.equal(exitDecision({ params: P, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 80 }).exit, true); // +60% -> TP
  assert.match(exitDecision({ params: P, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 80 }).reason, /тейк/);
  assert.match(exitDecision({ params: P, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 20 }).reason, /стоп/); // -60%
  assert.match(exitDecision({ params: P, aiProb: 0.4, entryPriceCents: 50, currentPriceCents: 60 }).reason, /край/); // edge gone
  assert.equal(exitDecision({ params: P, aiProb: 0.8, entryPriceCents: 50, currentPriceCents: 55 }).exit, false); // hold
  // edgeExit:false disables the "edge gone" auto-exit (strategist manages exits),
  // but take-profit and hard stop still fire — no in-match churn on a dip.
  const NE = { takeProfit: 0.5, exitStop: 0.5, edgeExit: false };
  assert.equal(exitDecision({ params: NE, aiProb: 0.4, entryPriceCents: 50, currentPriceCents: 60 }).exit, false); // edge gone → held
  assert.equal(exitDecision({ params: NE, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 80 }).exit, true);  // TP still fires
  assert.equal(exitDecision({ params: NE, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 20 }).exit, true);  // stop still fires
});

test("autoEnter fills proposed bets at the current price", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // m-lineup is seeded with proposed bets + priced markets
  const proposedBefore = R.betsForMatch(db, "m-lineup").filter((b) => b.status === "proposed");
  assert.ok(proposedBefore.length > 0);
  const filled = autoEnter(db, { now: () => "t" });
  assert.ok(filled.length >= proposedBefore.length);
  const b = R.betsForMatch(db, "m-lineup").find((x) => x.id === proposedBefore[0].id)!;
  assert.equal(b.status, "open");
  assert.ok(b.entry_price != null && b.entry_price > 0);
  assert.ok(R.tradeLogForMatch(db, "m-lineup").some((l) => l.type === "enter"));
});

test("autoEnter holds a football bet until lineups are out (no pre-lineup entry)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "pl-1", match_id: mid, strategy_id: strat.id, market_label: "Over 2.5", status: "proposed", proposed_price: 55, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: null, result: null, payout: null, settled_by: null, created_at: "t" });
  autoEnter(db, { now: () => "t" });
  assert.equal(R.getBet(db, "pl-1")!.status, "proposed", "held as a preview before lineups are out");
  R.updateMatch(db, mid, { lineup_out: true });
  autoEnter(db, { now: () => "t" });
  assert.equal(R.getBet(db, "pl-1")!.status, "open", "enters once lineups are out");
});

test("evaluateExits closes an open position when the edge is gone", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 62, ai_prob: 0.4, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 62, closing_price: null, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "40'", result: null, payout: null, created_at: "t" });

  const exits = evaluateExits(db, { now: () => "t" });
  assert.equal(exits.length, 1);
  assert.match(exits[0].reason, /край/);
  const b = R.betsForMatch(db, mid).find((x) => x.id === bid)!;
  assert.ok(b.status === "settled_won" || b.status === "settled_lost");
  assert.equal(b.payout, 124); // 100 * 62/50
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "exit"));
});

test("advanceClocks flips lineup_out ~1h before kickoff", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db)[0];
  const soon = R.uid(), far = R.uid();
  const base = (id: string, ko: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: false, kickoff_at: ko, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  base(soon, "2026-07-07T12:30:00Z"); // 30 min out
  base(far, "2026-07-07T20:00:00Z");  // 8h out
  advanceClocks(db, { now: () => "2026-07-07T12:00:00Z" });
  assert.equal(R.getMatch(db, soon)!.lineup_out, true);
  assert.equal(R.getMatch(db, far)!.lineup_out, false);
  assert.equal(R.getMatch(db, soon)!.state, "lineup");
  assert.equal(R.getMatch(db, far)!.state, "upcoming");
});

test("advanceClocks flips a time-scheduled match to LIVE at kickoff, and clock-finishes a stale no-bet one", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mk = (id: string, ko: string, state = "upcoming", minute: number | null = null) => R.insertMatch(db, { id, competition_id: comp.id, home: "A"+id, away: "B"+id, state: state as any, lineup_out: state !== "upcoming", kickoff_at: ko, minute, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  const now = "2026-07-07T18:00:00Z";
  const started = R.uid(), stale = R.uid(), espn = R.uid();
  mk(started, "2026-07-07T17:30:00Z");                 // kicked off 30 min ago → LIVE
  mk(stale, "2026-07-07T12:00:00Z", "live");           // 6h ago, clock-live (minute null), no bets → finished
  mk(espn, "2026-07-07T12:00:00Z", "live", 75);        // 6h ago BUT ESPN-driven (minute set) → stays live
  advanceClocks(db, { now: () => now });
  assert.equal(R.getMatch(db, started)!.state, "live", "kicked off → live");
  assert.equal(R.getMatch(db, started)!.lineup_out, true);
  assert.equal(R.getMatch(db, stale)!.state, "finished", "stale clock-live no-bet → finished");
  assert.equal(R.getMatch(db, espn)!.state, "live", "ESPN-driven live not clock-finished");
});

test("advanceClocks reverts a clock-driven live match out of live when its kickoff moved to the future (postponed)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mk = (id: string, ko: string, minute: number | null) => R.insertMatch(db, { id, competition_id: comp.id, home: "A"+id, away: "B"+id, state: "live", lineup_out: true, kickoff_at: ko, minute, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  const now = "2026-07-07T18:00:00Z";
  const postponedSoon = R.uid(), postponedFar = R.uid(), reallyLive = R.uid();
  mk(postponedSoon, "2026-07-07T18:30:00Z", null);   // kickoff now 30 min ahead → lineup (not live)
  mk(postponedFar, "2026-07-09T18:00:00Z", null);    // moved 2 days out → upcoming
  mk(reallyLive, "2026-07-07T18:30:00Z", 12);        // future kickoff BUT provider-confirmed (minute set) → stays live
  advanceClocks(db, { now: () => now });
  assert.equal(R.getMatch(db, postponedSoon)!.state, "lineup", "postponed within lineup window → lineup, not live");
  assert.equal(R.getMatch(db, postponedFar)!.state, "upcoming", "postponed far out → upcoming");
  assert.equal(R.getMatch(db, reallyLive)!.state, "live", "provider-confirmed live is never clock-reverted");
});

test("strategistReassess skips a pre-lineup match (no reassessment before lineups/live)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const pm = R.uid();
  // upcoming, NO lineup, but carrying an open position → must NOT be reassessed
  R.insertMatch(db, { id: pm, competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: pm });
  R.insertMarket(db, { id: R.uid(), match_id: pm, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "pm-open", match_id: pm, strategy_id: strat.id, market_label: "Over 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: "предматч", result: null, payout: null, settled_by: null, created_at: "t" });
  await strategistReassess(db, { fetchImpl: mockLLM({ picks: [], exits: [], note: "x" }), env: { ANTHROPIC_API_KEY: "k" } }, { max: 50 });
  assert.equal(R.reassessmentsForMatch(db, pm).length, 0, "no pre-lineup reassessment even with an open position");
});

test("strategistReassess skips a time-flipped lineup match that is not yet live (no pre-match churn)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const pm = R.uid();
  // lineup_out flipped by the 1h-before-kickoff timer (advanceClocks), NOT by a
  // real teamsheet, and the ball has NOT kicked off. Holds an open position.
  // This is the exact leak that churned not-yet-started matches — must stay quiet.
  R.insertMatch(db, { id: pm, competition_id: comp.id, home: "A", away: "B", state: "lineup", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: pm });
  R.insertMarket(db, { id: R.uid(), match_id: pm, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "lm-open", match_id: pm, strategy_id: strat.id, market_label: "Over 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: "предматч", result: null, payout: null, settled_by: null, created_at: "t" });
  await strategistReassess(db, { fetchImpl: mockLLM({ picks: [], exits: [], note: "x" }), env: { ANTHROPIC_API_KEY: "k" } }, { max: 50, newEventMatchIds: new Set([pm]) });
  assert.equal(R.reassessmentsForMatch(db, pm).length, 0, "no reassessment on a not-yet-live lineup match");
});

test("evaluateExits holds an open position pre-match (lineup_out, not live) — no churn", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  // Pre-match: lineups out by the timer, edge would read as "gone" (aiProb 0.4,
  // price 62) — but the match is NOT live, so nothing should be closed.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "lineup", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 62, ai_prob: 0.4, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 62, closing_price: null, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  const exits = evaluateExits(db, { now: () => "t" });
  assert.equal(exits.length, 0, "no pre-match exit");
  assert.equal(R.getBet(db, bid)!.status, "open", "position held until kickoff");
  // once live, the same edge-gone rule fires
  R.updateMatch(db, mid, { state: "live", minute: 10 });
  assert.equal(evaluateExits(db, { now: () => "t" }).length, 1, "closes once live");
});
test("strategistReassess supports partial fixation (fraction)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 40, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 80, ai_prob: 0.7, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Under 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 80, closing_price: null, ai_prob: 0.7, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Under 2.5", fraction: 0.5, reason: "фиксирую половину на пике (п.4.2)" }] }) }] }) }) as any);
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  const bets = R.betsForMatch(db, mid);
  const open = bets.find((b) => b.status === "open")!;
  const settled = bets.find((b) => b.status === "settled_won");
  assert.equal(open.stake, 50);        // half of 100 remains open
  assert.ok(settled && settled.stake === 50); // half booked
  assert.equal(settled!.payout, 80);   // 50 * 80/50
});

test("strategistReassess closes a position the strategy prompt says to cut", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 60, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: 0.5, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  // strategist says to exit "Under 2.5" (goal broke the thesis)
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Under 2.5", reason: "гол сломал сценарий few-goals (п.4.2)" }], note: "" }) }] }) }) as any);
  const { exits } = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  const myExit = exits.find((e) => e.matchId === mid);
  assert.ok(myExit, "our position was cut by the strategist");
  assert.match(myExit!.reason, /стратег/);
  const b = R.betsForMatch(db, mid).find((x) => x.id === bid)!;
  assert.ok(b.status === "settled_won" || b.status === "settled_lost");
  assert.equal(b.payout, 72.73); // 100 * 40/55
});

test("strategistReassess opens a fresh entry on a live trigger (no prior position)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // priced market with a model probability well above price → positive edge to size
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "A wins", price: 40, ai_prob: 0.7, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });

  // strategist picks the market a live goal opened; no exits
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "A wins", conviction: "высокая", reason: "гол открыл камбэк-паттерн (п.4.3)" }], exits: [], note: "" }) }] }) }) as any);
  const res = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set([mid]), max: 50 });

  assert.ok(res.entries.some((e) => e.matchId === mid && e.market === "A wins"), "strategist opened a fresh entry on the trigger");
  const proposed = R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed");
  assert.equal(proposed.length, 1);
  assert.ok((proposed[0].stake ?? 0) > 0);
  assert.match(proposed[0].rationale ?? "", /переоценка/);

  // a non-triggered match with no open positions is left alone (no model call needed)
  const res2 = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set(), max: 50 });
  assert.ok(!res2.entries.some((e) => e.matchId === mid), "no re-entry without a trigger or position");
});

test("runLiveCycle reacts to a live goal, and quiet re-runs don't re-fire the strategist", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0 && c.external_league === "fifa.world")!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Colombia", away: "Ghana", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // market with no external_ref → odds refresh skips it (no CLOB mock needed)
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: 0.5, liquidity: null, external_ref: null, snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  let detailCalls = 0;
  const goal: MatchDetail = { lineupOut: true, lineups: { home: null, away: null }, events: [{ key: "g1", minute: 14, type: "goal", team: "Colombia", text: "Goal!" }] };
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_s, league) { return league === "fifa.world" ? [{ externalRef: "E1", home: "Colombia", away: "Ghana", state: "live", minute: 30, scoreHome: 1, scoreAway: 0, final: false }] : []; },
    async matchDetail() { detailCalls++; return goal; },
  };
  // strategist says to cut the Under after the goal
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Under 2.5", reason: "гол сломал few-goals (п.4.2)" }] }) }] }) }) as any);

  const r1 = await runLiveCycle(db, provider, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  assert.ok(r1.live >= 1, "a live match is in play");
  assert.equal(r1.triggers, 1, "the goal is a trigger");
  assert.ok(r1.exits >= 1, "strategist cut the position on the goal");
  assert.ok(R.betsForMatch(db, mid).find((b) => b.id === bid)!.status.startsWith("settled"), "position closed");
  assert.equal(R.openOddsFor(db, mid)["Under 2.5"], 40, "kickoff price captured for the live match");

  // second pass: same goal (deduped) → no new trigger → strategist not re-called
  const r2 = await runLiveCycle(db, provider, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r2.triggers, 0, "known event doesn't re-trigger");
});

test("runLiveCycle reassesses on the 5-min heartbeat with no on-pitch event", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0 && c.external_league === "fifa.world")!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  // Retire the seeded demo's other live matches so `mid` is the sole periodic
  // candidate — otherwise they'd compete for the per-run reassessment budget.
  for (const c of R.listCompetitions(db)) for (const mm of R.listMatches(db, c.id)) R.updateMatch(db, mm.id, { state: "finished" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Japan", away: "Peru", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: 0.5, liquidity: null, external_ref: null, snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  // provider surfaces the match but reports NO new events — nothing on the pitch
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_s, league) { return league === "fifa.world" ? [{ externalRef: "E1", home: "Japan", away: "Peru", state: "live", minute: 55, scoreHome: 0, scoreAway: 0, final: false }] : []; },
    async matchDetail() { return { lineupOut: true, lineups: { home: null, away: null }, events: [] }; },
  };
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [], note: "Держу Under, темп низкий." }) }] }) }) as any);

  const before = R.reassessmentsForMatch(db, mid).length;
  const r = await runLiveCycle(db, provider, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r.triggers, 0, "no on-pitch event trigger");
  const notes = R.reassessmentsForMatch(db, mid);
  assert.ok(notes.length > before, "periodic heartbeat still wrote a reassessment note");
  assert.equal(notes[notes.length - 1].trigger, "time", "labelled as a periodic (time) reassessment");
  assert.match(notes[notes.length - 1].body, /Держу/, "narrative note carries the strategist's read");
});

test("captureOpenOdds locks the kickoff price (first write wins)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db)[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 5, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: null, liquidity: null, external_ref: "t", snapshot_at: "t1", is_closing: false });
  assert.equal(R.captureOpenOdds(db, mid, "t1"), 1);
  // price moves; a second capture must NOT overwrite the kickoff price
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 62, ai_prob: null, liquidity: null, external_ref: "t", snapshot_at: "t2", is_closing: false });
  assert.equal(R.captureOpenOdds(db, mid, "t2"), 0, "already captured — no-op");
  assert.equal(R.openOddsFor(db, mid)["Under 2.5"], 40, "kickoff price preserved, not the moved 62");
});

test("runLiveCycle is a cheap no-op when nothing is in play", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("UPDATE matches SET state='finished'");
  const r = await runLiveCycle(db, null, {});
  assert.deepEqual(r, { live: 0, oddsUpdated: 0, enriched: 0, triggers: 0, exits: 0, entries: 0 });
});

test("analyzeMatch re-run doesn't re-propose on an already-open market or breach budget (§9.3)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 100 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "lineup", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 3.5", price: 30, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  // already holds a near-full-budget open position on Over 3.5 (from the pre-lineup stage)
  const held = Math.round(comp.budget * 0.9);
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "Over 3.5", status: "open", proposed_price: 30, entry_price: 30, current_price: 30, closing_price: null, ai_prob: 0.6, stake: held, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  // combined mock: valid assessment AND a strategist pick on the held market
  const combined = { confidence: "высокая", short: "s", body: "b", verdict: "v", markets: [{ label: "Over 3.5", prob: 0.6 }], picks: [{ label: "Over 3.5", conviction: "высокая", reason: "добрать" }], exits: [] };
  await analyzeMatch(db, mid, { fetchImpl: mockLLM(combined), env: { ANTHROPIC_API_KEY: "k" } });
  const bets = R.betsForMatch(db, mid, strat.id);
  assert.equal(bets.filter((b) => b.status === "proposed" && b.market_label === "Over 3.5").length, 0, "no re-propose on the held market");
  const exposure = bets.filter((b) => b.status === "open" || b.status === "proposed").reduce((n, b) => n + (b.stake ?? 0), 0);
  assert.ok(exposure <= comp.budget, `open+proposed exposure ${exposure} within budget ${comp.budget}`);
});

test("autoAnalyze analyzes an eligible match once per stage", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // clear seeded assessments so matches become eligible
  db.exec("DELETE FROM assessments");
  const labels = R.latestMarkets(db, "m-lineup").map((m) => m.label);
  const deps = { fetchImpl: mockLLM({ confidence: "высокая", short: "s", body: "b", verdict: "v", markets: labels.map((l) => ({ label: l, prob: 0.6 })) }), env: { ANTHROPIC_API_KEY: "k" } };

  const first = await autoAnalyze(db, deps);
  const lineup = first.find((a) => a.matchId === "m-lineup");
  assert.ok(lineup && lineup.ok, "m-lineup analyzed");
  assert.ok(R.assessmentsForMatch(db, "m-lineup").some((a) => a.status === "ok"));

  const second = await autoAnalyze(db, deps);
  assert.ok(!second.some((a) => a.matchId === "m-lineup"), "not re-analyzed for the same stage");
});

test("pruneMarketSnapshots caps non-closing history, keeps closing snapshots", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const now = (n: number) => `2026-07-01T00:${String(n).padStart(2, "0")}:00.000Z`;
  // 20 non-closing snapshots + 1 closing snapshot for one market label
  for (let i = 0; i < 20; i++) R.insertMarket(db, { id: R.uid(), match_id: "m-live", label: "PRUNE ME", price: 50 + i, ai_prob: null, liquidity: null, external_ref: `tok-${i}`, snapshot_at: now(i), is_closing: false });
  R.insertMarket(db, { id: R.uid(), match_id: "m-live", label: "PRUNE ME", price: 99, ai_prob: null, liquidity: null, external_ref: "tok-close", snapshot_at: now(30), is_closing: true });
  const before = (db.prepare("SELECT COUNT(*) c FROM markets WHERE label='PRUNE ME'").get() as any).c;
  assert.equal(before, 21);
  R.pruneMarketSnapshots(db, 8);
  const nonClosing = (db.prepare("SELECT COUNT(*) c FROM markets WHERE label='PRUNE ME' AND is_closing=0").get() as any).c;
  const closing = (db.prepare("SELECT COUNT(*) c FROM markets WHERE label='PRUNE ME' AND is_closing=1").get() as any).c;
  assert.equal(nonClosing, 8, "kept only the latest 8 non-closing");
  assert.equal(closing, 1, "closing snapshot preserved");
});

test("matchByMarketTokens finds a fixture by a shared CLOB token", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const tok = R.latestMarkets(db, "m-live")[0]?.external_ref;
  assert.ok(tok, "seed market has a token ref");
  const hit = R.matchByMarketTokens(db, ["nope", tok as string]);
  assert.equal(hit?.id, "m-live");
  assert.equal(R.matchByMarketTokens(db, ["does-not-exist"]), null);
});

test("formatMatchStats renders a compact home–away line, null when empty", () => {
  const json = JSON.stringify({
    home: { team: "Real", items: [{ label: "владение", value: "58%" }, { label: "удары", value: "7" }] },
    away: { team: "City", items: [{ label: "владение", value: "42%" }, { label: "удары", value: "4" }, { label: "угловые", value: "2" }] },
  });
  assert.equal(formatMatchStats(json), "владение 58%–42% · удары 7–4 · угловые —–2");
  assert.equal(formatMatchStats(null), null);
  assert.equal(formatMatchStats("{bad json"), null);
  assert.equal(formatMatchStats(JSON.stringify({ home: { team: "A", items: [] }, away: { team: "B", items: [] } })), null);
});

test("recordMatchStats writes a stats event for a live match, then rate-limits to 5 min", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Real", away: "City", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "E1", league: "eng.1", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { team: "Real", items: [{ label: "владение", value: "58%" }] }, away: { team: "City", items: [{ label: "владение", value: "42%" }] } }), updated_at: "t" });

  recordMatchStats(db, { now: () => "2026-07-05T18:00:00Z" });
  const evts = R.eventsForMatch(db, mid).filter((e) => e.type === "stats");
  assert.equal(evts.length, 1, "first snapshot written");
  assert.match(evts[0].text, /владение 58%–42%/);

  // 3 min later — within the 5-min interval → no new snapshot for this match
  recordMatchStats(db, { now: () => "2026-07-05T18:03:00Z" });
  assert.equal(R.eventsForMatch(db, mid).filter((e) => e.type === "stats").length, 1, "rate-limited within 5 min");
  // 6 min later — a fresh snapshot lands
  recordMatchStats(db, { now: () => "2026-07-05T18:06:00Z" });
  assert.equal(R.eventsForMatch(db, mid).filter((e) => e.type === "stats").length, 2, "new snapshot after the interval");
});

test("recordMatchStats: market-snapshot fallback when no ESPN stats; skips non-live and marketless", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const up = R.uid(), noMkt = R.uid(), fb = R.uid();
  // upcoming (even with stats) → skipped: not live
  R.insertMatch(db, { id: up, competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: up });
  R.upsertMatchLive(db, { match_id: up, espn_event_id: "E", league: "x", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { team: "A", items: [{ label: "владение", value: "50%" }] }, away: { team: "B", items: [] } }), updated_at: "t" });
  // live, no ESPN stats AND no markets → nothing to snapshot → skipped
  R.insertMatch(db, { id: noMkt, competition_id: comp.id, home: "C", away: "D", state: "live", lineup_out: true, kickoff_at: null, minute: 10, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: noMkt });
  // live, no ESPN stats, but HAS markets → market-snapshot fallback
  R.insertMatch(db, { id: fb, competition_id: comp.id, home: "Alcaraz", away: "Sinner", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: fb });
  R.insertMarket(db, { id: R.uid(), match_id: fb, label: "Alcaraz", price: 62, ai_prob: null, liquidity: "300K", external_ref: "t1", snapshot_at: "t", is_closing: false });
  R.insertMarket(db, { id: R.uid(), match_id: fb, label: "Sinner", price: 38, ai_prob: null, liquidity: "200K", external_ref: "t2", snapshot_at: "t", is_closing: false });

  recordMatchStats(db, { now: () => "2026-07-05T18:00:00Z" });
  assert.equal(R.eventsForMatch(db, up).filter((e) => e.type === "stats").length, 0, "upcoming skipped");
  assert.equal(R.eventsForMatch(db, noMkt).filter((e) => e.type === "stats").length, 0, "live without markets skipped");
  const snaps = R.eventsForMatch(db, fb).filter((e) => e.type === "stats");
  assert.equal(snaps.length, 1, "market-snapshot fallback written");
  assert.match(snaps[0].text, /рынок: Alcaraz 62¢ · Sinner 38¢/); // favourite (higher price) first
});
