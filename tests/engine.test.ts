import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { parseEspnEvent, MockSportsProvider } from "../src/lib/sports.js";
import {
  canReassess, syncMatchStatus, refreshMatchOdds, recomputeMetrics,
} from "../src/lib/engine.js";
import type { SportsMatchStatus } from "../src/lib/sports.js";

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
