import { test } from "node:test";
import assert from "node:assert/strict";
import { signalKey, collapseToSignals, binomUpperTail, signalTests, signalCohort, marketFamily, FLAG_ONLY_STRATEGIES, type Signal } from "../src/lib/signals.js";
import type { BetRec } from "../src/lib/profileAnalytics.js";

const rec = (o: Partial<BetRec>): BetRec => ({
  id: o.id ?? Math.random().toString(36).slice(2), matchId: o.matchId ?? "m1", matchLabel: "A — B", competitionId: "c", category: o.category ?? "MLS",
  strategyId: o.strategyId ?? "prematch_value", strategy: "PV", profileId: o.profileId ?? "max", market: o.market ?? "Over 2.5",
  phase: o.phase ?? "prematch", minute: null, scoreHome: null, scoreAway: null, edge: null, aiProb: null, derivedProb: null, impliedProb: o.impliedProb ?? 0.5,
  marketPrice: null, liveProbAdjusted: null, entryCents: null, closingCents: null, kelly: null, sizeRequested: null, sizeFilled: null, entrySlipCents: null,
  calibration: null, branchWeightSum: null, thinnessUsd: null, winsOnEvent: false, codeVersion: o.codeVersion ?? null, status: "settled_won", settledBy: null, outcome: o.outcome ?? "won",
  stake: o.stake ?? 100, payout: null, pnl: o.pnl ?? 50, bookPnl: "bookPnl" in o ? (o.bookPnl ?? null) : (o.pnl ?? 50), clvCents: o.clvCents ?? 5, finalScore: null, decisionId: o.decisionId ?? null, createdAt: o.createdAt ?? "2026-07-24T18:00:00Z", kickoffAt: o.kickoffAt ?? null, exitCodeVersion: o.exitCodeVersion ?? null, exits: [],
});

test("signalKey: match×market×strategy×day; per-bet decision_id is IGNORED (was the 1:1 units-bug)", () => {
  // 4 profiles of one decision — each with its OWN decision_id — collapse to ONE key
  assert.equal(signalKey(rec({ decisionId: "a", profileId: "max" })), signalKey(rec({ decisionId: "b", profileId: "medium" })));
  // different market → different signal (Over 0.5 ≠ Over 1.5)
  assert.notEqual(signalKey(rec({ market: "Over 0.5" })), signalKey(rec({ market: "Over 1.5" })));
  // a re-entry on another day → different signal (episode)
  assert.notEqual(signalKey(rec({ createdAt: "2026-07-24T18:00:00Z" })), signalKey(rec({ createdAt: "2026-07-25T18:00:00Z" })));
});

test("collapseToSignals: 4 profiles × partials of ONE market/day = 1 signal, P&L summed; ratio >1", () => {
  const recs = ["max", "aggressive", "medium", "conservative"].flatMap((p) => [rec({ profileId: p, pnl: 25, stake: 50 }), rec({ profileId: p, pnl: 5, stake: 10 })]); // 8 records (4 profiles × 2 partials)
  const s = collapseToSignals(recs);
  assert.equal(s.length, 1);
  assert.equal(s[0].records, 8);
  assert.equal(s[0].pnl, 120);
  const t = signalTests(s);
  assert.equal(t.recordsPerSignal, 8);
});

test("ACCEPTANCE (export): golden totals cell — 8 distinct match×market groups of sizes {2,3,3,3,4,6,7,12} collapse to 8 signals, ratio 5.0", () => {
  const sizes = [2, 3, 3, 3, 4, 6, 7, 12]; // the real group sizes from bets.json
  const recs: BetRec[] = [];
  sizes.forEach((sz, gi) => { for (let k = 0; k < sz; k++) recs.push(rec({ matchId: `match${gi}`, market: "Over 2.5", pnl: 10, outcome: "won" })); });
  const s = collapseToSignals(recs);
  assert.equal(recs.length, 40, "40 records");
  assert.equal(s.length, 8, "→ 8 signals, not 40 (the 1:1 bug)");
  assert.equal(signalTests(s).recordsPerSignal, 5, "5.0 records/signal");
});

test("binomUpperTail: exact upper-tail matches hand values", () => {
  assert.ok(Math.abs(binomUpperTail(8, 10, 0.5) - 0.0546875) < 1e-6);
  assert.ok(Math.abs(binomUpperTail(5, 10, 0.5) - 0.623046875) < 1e-6);
});

test("signalTests: a strong 30-match cell beats market on all three + is concentration-robust", () => {
  const recs: BetRec[] = [];
  for (let i = 0; i < 30; i++) recs.push(rec({ matchId: `mm${i}`, outcome: i < 27 ? "won" : "lost", pnl: i < 27 ? 40 : -60, clvCents: 8 + (i % 9), impliedProb: 0.5 }));
  const t = signalTests(collapseToSignals(recs));
  assert.equal(t.nSignals, 30);
  assert.ok(t.winVsImplied.beatsMarket && t.clv.significant && t.pnl.positiveSignificant);
  assert.ok(t.concentration.robust, "30 spread contributors, top3 small");
});

test("fix #4: a degenerate cell (few decided, top-3 = 100%) is NOT robust, even with many total signals", () => {
  const recs: BetRec[] = [];
  // 60 signals but only 3 P&L-bearing (rest void/open) → top3 = 100% on 3 contributors
  for (let i = 0; i < 3; i++) recs.push(rec({ matchId: `d${i}`, outcome: "lost", pnl: -30 }));
  for (let i = 0; i < 57; i++) recs.push(rec({ matchId: `v${i}`, outcome: "void", pnl: 0, clvCents: null }));
  const t = signalTests(collapseToSignals(recs));
  assert.equal(t.concentration.contributors, 3);
  assert.equal(t.concentration.robust, false, "3 contributors → not robust regardless of total n");
});

test("signalCohort: maturity keys on DECIDED signals; golden 8-signal cell → insufficient (not a fake stable)", () => {
  const sizes = [2, 3, 3, 3, 4, 6, 7, 12];
  const recs: BetRec[] = [];
  sizes.forEach((sz, gi) => { for (let k = 0; k < sz; k++) recs.push(rec({ matchId: `g${gi}`, market: "Over 2.5", outcome: "won", pnl: 20, clvCents: 10 + (gi % 5) })); });
  const c = signalCohort(recs, { strategyId: "prematch_value", family: "totals" });
  assert.equal(c.nSignals, 8);
  assert.equal(c.nDecided, 8);
  assert.equal(c.matured, "none", "8 decided < 25 → still accruing (honest)");
  assert.equal(c.verdict, "insufficient");
});

test("fix #3: a flag-only strategy (tennis_pmv) returns legacy_diagnostic, not a verdict", () => {
  assert.ok(FLAG_ONLY_STRATEGIES.tennis_pmv);
  const recs = Array.from({ length: 44 }, (_, i) => rec({ matchId: `t${i}`, strategyId: "tennis_pmv", outcome: i < 3 ? "lost" : "void", pnl: i < 3 ? -30 : 0 }));
  const c = signalCohort(recs, { strategyId: "tennis_pmv" });
  assert.equal(c.verdict, "legacy_diagnostic");
  assert.match(c.note, /shadow/i);
});

test("marketFamily classifies the tradeable families", () => {
  assert.equal(marketFamily("FC X Over 2.5"), "totals");
  assert.equal(marketFamily("Both Teams to Score — No"), "btts");
});
