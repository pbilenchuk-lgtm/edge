import { test } from "node:test";
import assert from "node:assert/strict";
import { signalKey, collapseToSignals, binomUpperTail, signalTests, signalCohort, marketFamily, type Signal } from "../src/lib/signals.js";
import type { BetRec } from "../src/lib/profileAnalytics.js";

// minimal BetRec factory — only the fields signals.ts reads
const rec = (o: Partial<BetRec>): BetRec => ({
  id: o.id ?? Math.random().toString(36).slice(2), matchId: o.matchId ?? "m1", matchLabel: "A — B", competitionId: "c", category: o.category ?? "MLS",
  strategyId: o.strategyId ?? "prematch_value", strategy: "PV", profileId: o.profileId ?? "max", market: o.market ?? "Over 2.5",
  phase: o.phase ?? "prematch", minute: null, scoreHome: null, scoreAway: null, edge: null, aiProb: null, derivedProb: null,
  impliedProb: o.impliedProb ?? 0.5, marketPrice: null, liveProbAdjusted: null, entryCents: null, closingCents: null, kelly: null,
  sizeRequested: null, sizeFilled: null, entrySlipCents: null, calibration: null, branchWeightSum: null, thinnessUsd: null,
  winsOnEvent: false, codeVersion: null, status: "settled_won", settledBy: null, outcome: o.outcome ?? "won",
  stake: o.stake ?? 100, payout: null, pnl: o.pnl ?? 50, clvCents: o.clvCents ?? 5, finalScore: null, decisionId: o.decisionId ?? null, exits: [],
});

test("signalKey: decision_id groups profiles+partials; without one, match|market|strategy", () => {
  assert.equal(signalKey(rec({ decisionId: "dec1", profileId: "max" })), signalKey(rec({ decisionId: "dec1", profileId: "medium" })));
  assert.notEqual(signalKey(rec({ decisionId: "dec1" })), signalKey(rec({ decisionId: "dec2" })));
  assert.equal(signalKey(rec({ matchId: "m", market: "Over 2.5", strategyId: "s" })), signalKey(rec({ matchId: "m", market: "over 2.5 ", strategyId: "s" })));
});

test("collapseToSignals: 4 profiles of ONE decision = 1 signal, P&L summed, outcome deduped", () => {
  const recs = ["max", "aggressive", "medium", "conservative"].map((p) => rec({ decisionId: "d1", profileId: p, pnl: 25, stake: 50, outcome: "won" }));
  const sigs = collapseToSignals(recs);
  assert.equal(sigs.length, 1, "one signal, not four");
  assert.equal(sigs[0].records, 4);
  assert.equal(sigs[0].pnl, 100, "summed P&L across profiles");
  assert.equal(sigs[0].outcome, "won");
});

test("binomUpperTail: exact upper-tail matches hand values", () => {
  assert.ok(Math.abs(binomUpperTail(8, 10, 0.5) - 0.0546875) < 1e-6);
  assert.ok(Math.abs(binomUpperTail(5, 10, 0.5) - 0.623046875) < 1e-6);
  assert.equal(binomUpperTail(0, 10, 0.5), 1);
});

test("signalTests: a strong cell beats market on all three + is concentration-robust", () => {
  // 30 signals, 27 wins at implied 0.5, each +$40 CLV +12 → win binom p tiny, CLV t large, bootstrap positive
  const sigs: BetRec[] = [];
  for (let i = 0; i < 30; i++) sigs.push(rec({ decisionId: `d${i}`, outcome: i < 27 ? "won" : "lost", pnl: i < 27 ? 40 : -60, clvCents: 8 + (i % 9), impliedProb: 0.5 }));
  const t = signalTests(collapseToSignals(sigs));
  assert.equal(t.nSignals, 30);
  assert.ok(t.winVsImplied.beatsMarket, "27/30 vs 50% beats market");
  assert.ok(t.clv.significant, "CLV t≥2");
  assert.ok(t.pnl.positiveSignificant, "bootstrap P(≤0)<0.05 with positive total");
  assert.ok(t.concentration.robust, "n≥40 OR top3≤50 — here n=30 but spread → top3 small");
});

test("signalCohort: n<25 → insufficient; a clean positive cell → positive verdict", () => {
  const few = Array.from({ length: 10 }, (_, i) => rec({ decisionId: `d${i}`, outcome: "won" }));
  assert.equal(signalCohort(few).verdict, "insufficient");
  const strong: BetRec[] = [];
  for (let i = 0; i < 44; i++) strong.push(rec({ decisionId: `s${i}`, outcome: i < 39 ? "won" : "lost", pnl: i < 39 ? 30 : -50, clvCents: 6 + (i % 9), impliedProb: 0.5 }));
  const c = signalCohort(strong, { strategyId: "prematch_value", family: "totals" });
  assert.equal(c.matured, "stable");
  assert.equal(c.verdict, "positive");
  assert.ok(c.tripleAgreement);
});

test("marketFamily classifies the tradeable families", () => {
  assert.equal(marketFamily("FC X Over 2.5"), "totals");
  assert.equal(marketFamily("Both Teams to Score — No"), "btts");
  assert.equal(marketFamily("X (-1.5) Handicap"), "handicap");
});
