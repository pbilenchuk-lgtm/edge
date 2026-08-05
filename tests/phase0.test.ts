import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseToSignals, signalTests, signalKey, canonicalMarket, poissonBinomialUpperTail, binomUpperTail, studentTwoSidedP } from "../src/lib/signals.js";
import { profileComparison, type BetRec } from "../src/lib/profileAnalytics.js";
import { cleanEpochRecords } from "../src/lib/profileEpochCut.js";
import { epochNum } from "../src/lib/codeEpoch.js";

const rec = (o: Partial<BetRec>): BetRec => ({
  id: o.id ?? Math.random().toString(36).slice(2), matchId: o.matchId ?? "m1", matchLabel: "A — B", competitionId: "c", category: "MLS",
  strategyId: o.strategyId ?? "prematch_value", strategy: "PV", profileId: o.profileId ?? "medium", market: o.market ?? "Over 2.5",
  phase: o.phase ?? "prematch", minute: null, scoreHome: null, scoreAway: null, edge: null, aiProb: null, derivedProb: null, impliedProb: o.impliedProb ?? 0.5,
  marketPrice: null, liveProbAdjusted: null, entryCents: null, closingCents: null, kelly: null, sizeRequested: null, sizeFilled: null, entrySlipCents: null,
  calibration: null, branchWeightSum: null, thinnessUsd: null, winsOnEvent: false, codeVersion: o.codeVersion ?? "e7·m1", status: "settled_won", settledBy: null, outcome: o.outcome ?? "won", clvSource: "closing_line", closingLineCents: null, exitsAmbiguous: false, piecePnl: null, marketLabeled: 1,
  stake: o.stake ?? 100, payout: null, pnl: o.pnl ?? 50, bookPnl: "bookPnl" in o ? (o.bookPnl ?? null) : (o.pnl ?? 50), clvCents: o.clvCents ?? 5, finalScore: null,
  decisionId: null, createdAt: o.createdAt ?? "2026-07-24T18:00:00Z", kickoffAt: o.kickoffAt ?? null, exitCodeVersion: o.exitCodeVersion ?? null, exits: [], catchUp: false, unmarkedBook: false,
});

// ── #4 (X2) — cross-epoch quarantine in the clean cut ─────────────────────────
test("#4 X2: cleanEpochRecords drops an entry-e5 / exit-e7 cross-epoch bet", () => {
  const recs = [
    rec({ id: "clean", codeVersion: "e7·m1", exitCodeVersion: "e7·m1" }),   // same epoch → kept
    rec({ id: "cross", codeVersion: "e5", exitCodeVersion: "e7·m1" }),        // entry e5, exit e7 → quarantined
    rec({ id: "noexit", codeVersion: "e6·m1", exitCodeVersion: null }),       // no exit epoch → not cross → kept
  ];
  assert.deepEqual(cleanEpochRecords(recs).map((r) => r.id).sort(), ["clean", "noexit"]);
});

// ── #5 (H2) — stale/model-fill P&L barred from the signal book P&L ────────────
test("#5 H2: a stale-priced leg is void AND excluded from signal.pnl/bootstrap (grossPnl keeps it)", () => {
  const s = collapseToSignals([
    rec({ matchId: "m", outcome: "won", pnl: 40, bookPnl: 40 }),            // real book fill
    rec({ matchId: "m", outcome: "void", pnl: 1000, bookPnl: null }),        // stale/model-fill: no book P&L
  ]);
  assert.equal(s.length, 1);
  assert.equal(s[0].pnl, 40, "book P&L excludes the stale $1000");
  assert.equal(s[0].grossPnl, 1040, "gross keeps it for reference");
  const t = signalTests(s);
  assert.equal(t.pnl.totalUsd, 40);
  assert.equal(t.pnl.grossUsd, 1040);
});

// ── #6 (H1) — drawdown/streak ordered by createdAt, not random UUID ───────────
test("#6 H1: max drawdown & loss streak use createdAt order (id is a timeless UUID)", () => {
  // chronological loss(-100) → win(+50) → loss(-100): peak 0, trough -150 → maxDD 150, longest streak 1.
  // ids are chosen so a wrong id-sort (aaa,mmm,zzz) would give a DIFFERENT curve (maxDD 250, streak 2).
  const recs = [
    rec({ id: "zzz", profileId: "medium", outcome: "lost", pnl: -100, createdAt: "2026-07-24T10:00:00Z" }),
    rec({ id: "aaa", profileId: "medium", outcome: "won", pnl: 50, createdAt: "2026-07-24T11:00:00Z" }),
    rec({ id: "mmm", profileId: "medium", outcome: "lost", pnl: -100, createdAt: "2026-07-24T12:00:00Z" }),
  ];
  const p = profileComparison(recs).find((x) => x.profileId === "medium")!;
  assert.equal(p.maxDrawdown, 150, "createdAt order → 150 (id-order would wrongly give 250)");
  assert.equal(p.longestLossStreak, 1, "loss, win, loss → longest streak 1 (id-order would give 2)");
});

// ── #7 (M1) — concentration robustness: no more n≥40 escape ───────────────────
test("#7 M1: a top-3≈87% cell is NOT robust even at 40 decided (the n≥40 escape is gone)", () => {
  const recs: BetRec[] = [];
  [900, 850, 800].forEach((v, i) => recs.push(rec({ matchId: `big${i}`, outcome: "won", pnl: v, bookPnl: v })));
  for (let i = 0; i < 37; i++) recs.push(rec({ matchId: `s${i}`, outcome: i % 2 ? "won" : "lost", pnl: i % 2 ? 10 : -10, bookPnl: i % 2 ? 10 : -10 }));
  const t = signalTests(collapseToSignals(recs));
  assert.equal(t.nDecided, 40);
  assert.equal(t.concentration.robust, false, "top-3 ≫ 70% → not robust regardless of n");
});
test("#7b M1: the ≤70% band IS robust once ≥40 decided (replaces the old unconditional escape)", () => {
  const recs: BetRec[] = [];
  [300, 300, 300].forEach((v, i) => recs.push(rec({ matchId: `b${i}`, outcome: "won", pnl: v, bookPnl: v })));
  for (let i = 0; i < 37; i++) recs.push(rec({ matchId: `m${i}`, outcome: "won", pnl: 16, bookPnl: 16 }));
  const t = signalTests(collapseToSignals(recs));
  assert.equal(t.nDecided, 40);
  assert.ok(t.concentration.top3ShareOfGrossPct != null && t.concentration.top3ShareOfGrossPct > 50 && t.concentration.top3ShareOfGrossPct <= 70);
  assert.equal(t.concentration.robust, true, "50–70% at ≥40 decided → robust");
});

// ── #12 — epochNum unit table ─────────────────────────────────────────────────
test("#12: epochNum parses the e-prefix and tolerates suffixes; empty/null/non-e → 0", () => {
  assert.equal(epochNum("e7"), 7);
  assert.equal(epochNum("e5"), 5);
  assert.equal(epochNum("e7·m1·opus48"), 7);
  assert.equal(epochNum("e10"), 10);
  assert.equal(epochNum(""), 0);
  assert.equal(epochNum(null), 0);
  assert.equal(epochNum("7"), 0);
  assert.equal(epochNum("E7"), 0, "known-safe-fail: uppercase → 0 (conservatively excluded)");
});

// ── 0.6 (M2) — Poisson-binomial vs pooled mean-p binomial ─────────────────────
test("0.6 M2: Poisson-binomial reduces to the binomial for equal p, differs for heterogeneous p", () => {
  const equal = Array(10).fill(0.5);
  assert.ok(Math.abs(poissonBinomialUpperTail(5, equal) - binomUpperTail(5, 10, 0.5)) < 1e-9, "equal p ⇒ binomial");
  const mixed = [...Array(20).fill(0.9), ...Array(20).fill(0.1)]; // mean 0.5, but far lower variance
  const pb = poissonBinomialUpperTail(25, mixed);
  const pooled = binomUpperTail(25, 40, 0.5);
  assert.ok(Math.abs(pb - pooled) > 0.01, "heterogeneous implied ⇒ different tail than pooled mean-p");
});

// ── 0.6 (M8) — canonical market key ───────────────────────────────────────────
test("0.6 M8: canonical market merges unit-suffix drift but keeps team/line distinctions", () => {
  assert.equal(canonicalMarket("Over 2.5 Goals"), "over 2.5");
  assert.equal(canonicalMarket("Over 2.5"), "over 2.5");
  const k = (m: string) => signalKey(rec({ matchId: "m", market: m }));
  assert.equal(k("Over 2.5"), k("Over 2.5 Goals"), "same market, label drift → one signal");
  assert.notEqual(k("Inter Miami Over 0.5"), k("Orlando City Over 0.5"), "different team totals stay distinct");
});

// ── 0.6 (M7) — episode = match kickoff, not the bet's UTC day ──────────────────
test("0.6 M7: same fixture across two bet-days collapses via the shared kickoff episode", () => {
  const ko = "2026-07-26T19:00:00Z";
  const s = collapseToSignals([
    rec({ matchId: "m", market: "Over 2.5", kickoffAt: ko, createdAt: "2026-07-24T23:59:00Z" }),
    rec({ matchId: "m", market: "Over 2.5", kickoffAt: ko, createdAt: "2026-07-25T00:01:00Z" }),
  ]);
  assert.equal(s.length, 1, "shared kickoff → one decision, no UTC-midnight split");
});

// ── 0.4 (M5) — stake-weighted CLV/implied ─────────────────────────────────────
test("0.4 M5: signal CLV is stake-weighted across legs, not first-non-null", () => {
  const s = collapseToSignals([
    rec({ matchId: "m", clvCents: 0, stake: 100 }),
    rec({ matchId: "m", clvCents: 10, stake: 300 }),
  ]);
  assert.equal(s.length, 1);
  assert.equal(s[0].clvCents, 7.5, "(0*100 + 10*300)/400 = 7.5");
});

// ── 0.4 (M6) — outcome precedence ─────────────────────────────────────────────
test("0.4 M6: a mixed won+lost signal is 'void' (not a win); a partial-open signal is 'open'", () => {
  const mixed = collapseToSignals([rec({ matchId: "x", outcome: "won", pnl: 40 }), rec({ matchId: "x", outcome: "lost", pnl: -40 })]);
  assert.equal(mixed[0].outcome, "void", "won+lost is not decided as a win");
  const partial = collapseToSignals([rec({ matchId: "y", outcome: "won", pnl: 40 }), rec({ matchId: "y", outcome: "open", pnl: 0 })]);
  assert.equal(partial[0].outcome, "open");
  assert.equal(partial[0].settled, false, "a partial-open decision is not settled/decided");
});

// ── 0.5 (M3) — CLV significance needs n≥8 and a real Student-t p ───────────────
test("0.5 M3: CLV is not 'significant' below n=8 even with a strong mean; a real t-p is emitted", () => {
  const strong = (n: number) => { const rs: BetRec[] = []; for (let i = 0; i < n; i++) rs.push(rec({ matchId: `g${i}`, outcome: "won", clvCents: 8 + (i % 3) })); return signalTests(collapseToSignals(rs)); };
  const t7 = strong(7);
  assert.equal(t7.clv.significant, false, "n=7 < 8 → never significant");
  const t20 = strong(20);
  assert.ok(t20.clv.p != null && t20.clv.p < 0.05 && t20.clv.significant, "n=20 strong positive CLV → significant with p<0.05");
  // studentTwoSidedP sanity: t=0 → p=1, large t → p→0
  assert.equal(Math.round(studentTwoSidedP(0, 10)), 1);
  assert.ok(studentTwoSidedP(6, 10) < 0.001);
});
