import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { exitDecision } from "../src/lib/thresholds.js";
import { autoEnter, evaluateExits, autoAnalyze, strategistExits } from "../src/lib/lifecycle.js";

const mockLLM = (a: unknown) => (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(a) }] }) })) as any;

test("exitDecision: take-profit, stop, edge-gone, hold", () => {
  const P = { takeProfit: 0.5, exitStop: 0.5 };
  assert.equal(exitDecision({ params: P, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 80 }).exit, true); // +60% -> TP
  assert.match(exitDecision({ params: P, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 80 }).reason, /тейк/);
  assert.match(exitDecision({ params: P, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 20 }).reason, /стоп/); // -60%
  assert.match(exitDecision({ params: P, aiProb: 0.4, entryPriceCents: 50, currentPriceCents: 60 }).reason, /край/); // edge gone
  assert.equal(exitDecision({ params: P, aiProb: 0.8, entryPriceCents: 50, currentPriceCents: 55 }).exit, false); // hold
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

test("strategistExits closes a position the strategy prompt says to cut", async () => {
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
  const exits = await strategistExits(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  const myExit = exits.find((e) => e.matchId === mid);
  assert.ok(myExit, "our position was cut by the strategist");
  assert.match(myExit!.reason, /стратег/);
  const b = R.betsForMatch(db, mid).find((x) => x.id === bid)!;
  assert.ok(b.status === "settled_won" || b.status === "settled_lost");
  assert.equal(b.payout, 72.73); // 100 * 40/55
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
