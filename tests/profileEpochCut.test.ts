import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEpochRecords, profileStratCell, conservativeAnomaly, CLEAN_EPOCH_FLOOR } from "../src/lib/profileEpochCut.js";
import type { BetRec } from "../src/lib/profileAnalytics.js";

const rec = (o: Partial<BetRec>): BetRec => ({
  id: o.id ?? Math.random().toString(36).slice(2), matchId: o.matchId ?? "m1", matchLabel: "A — B", competitionId: "c", category: "MLS",
  strategyId: o.strategyId ?? "prematch_value", strategy: "PV", profileId: o.profileId ?? "medium", market: o.market ?? "Over 2.5",
  phase: o.phase ?? "prematch", minute: null, scoreHome: null, scoreAway: null, edge: null, aiProb: null, derivedProb: null, impliedProb: o.impliedProb ?? 0.5,
  marketPrice: null, liveProbAdjusted: null, entryCents: null, closingCents: null, kelly: null, sizeRequested: null, sizeFilled: null, entrySlipCents: null,
  calibration: null, branchWeightSum: null, thinnessUsd: null, winsOnEvent: false, codeVersion: "codeVersion" in o ? (o.codeVersion ?? null) : "e7·m1", status: "settled_won", settledBy: null, outcome: o.outcome ?? "won",
  stake: o.stake ?? 100, payout: null, pnl: o.pnl ?? 50, bookPnl: "bookPnl" in o ? (o.bookPnl ?? null) : (o.pnl ?? 50), clvCents: o.clvCents ?? 5, finalScore: null, decisionId: null, createdAt: o.createdAt ?? "2026-07-24T18:00:00Z", kickoffAt: o.kickoffAt ?? null, exitCodeVersion: o.exitCodeVersion ?? null, exits: [],
});

test("cleanEpochRecords: pre-e5 entry code-epoch and null code_version are dropped; e5+ kept", () => {
  const recs = [
    rec({ id: "a", codeVersion: "e7·m1" }),   // clean
    rec({ id: "b", codeVersion: "e5" }),        // clean (floor)
    rec({ id: "c", codeVersion: "e3·m2" }),     // pre-clean → dropped
    rec({ id: "d", codeVersion: null }),         // no epoch → dropped
  ];
  const clean = cleanEpochRecords(recs);
  assert.deepEqual(clean.map((r) => r.id).sort(), ["a", "b"]);
  assert.equal(CLEAN_EPOCH_FLOOR, 5);
});

test("profileStratCell: a profile's own signals, beat-close % and ROI computed on signals", () => {
  // conservative took 3 distinct-match decisions; 2 beat the close (clv>0), 1 didn't (clv<0)
  const recs = [
    rec({ matchId: "m1", profileId: "conservative", clvCents: 4, pnl: 60, stake: 100, outcome: "won" }),
    rec({ matchId: "m2", profileId: "conservative", clvCents: 6, pnl: 40, stake: 100, outcome: "won" }),
    rec({ matchId: "m3", profileId: "conservative", clvCents: -3, pnl: -100, stake: 100, outcome: "lost" }),
    // an aggressive record on m1 must NOT bleed into the conservative cell
    rec({ matchId: "m1", profileId: "aggressive", clvCents: 4, pnl: 200, stake: 300, outcome: "won" }),
  ];
  const cell = profileStratCell(recs, "prematch_value", "conservative");
  assert.equal(cell.nSignals, 3, "3 distinct-match signals for conservative alone");
  assert.equal(cell.nDecided, 3);
  assert.equal(cell.beatClosePct, 66.67, "2 of 3 signals closed > entry");
  assert.equal(cell.volumeUsd, 300);
  assert.equal(cell.pnlUsd, 0, "60+40-100");
  assert.equal(cell.roiPct, 0);
});

test("conservativeAnomaly: entry bar SKIPS peer signals; CLV deficit is localized", () => {
  // conservative entered ONLY m1 (a ~high-edge signal). Peers entered m1 + m2 + m3 (lower-bar signals).
  const recs = [
    rec({ matchId: "m1", profileId: "conservative", clvCents: 2, pnl: 30, stake: 100, outcome: "won" }),
    rec({ matchId: "m1", profileId: "medium", clvCents: 2, pnl: 45, stake: 150, outcome: "won" }),
    rec({ matchId: "m1", profileId: "aggressive", clvCents: 2, pnl: 90, stake: 300, outcome: "won" }),
    // m2, m3 — peers only (conservative's bar skipped them). One won, one lost.
    rec({ matchId: "m2", profileId: "medium", clvCents: 10, pnl: 45, stake: 150, outcome: "won" }),
    rec({ matchId: "m3", profileId: "aggressive", clvCents: 12, pnl: -300, stake: 300, outcome: "lost" }),
  ];
  const a = conservativeAnomaly(recs, "prematch_value");
  assert.equal(a.conservative!.nSignals, 1);
  assert.equal(a.peers!.nSignals, 3, "m1, m2, m3 as peer signals");
  // conservative CLV = 2; peer CLV = mean(2,10,12) = 8 → deficit = -6
  assert.equal(a.conservative!.clvMeanCents, 2);
  assert.equal(a.peers!.clvMeanCents, 8);
  assert.equal(a.clvDeficitCents, -6);
  // the bar skipped exactly m2 + m3 (peer signals with no conservative key)
  assert.equal(a.skippedByConservative.count, 2);
  assert.equal(a.skippedByConservative.peerWins, 1);
  assert.equal(a.skippedByConservative.peerLosses, 1);
  assert.match(a.note, /порог входа пропустил 2/);
});

test("conservativeAnomaly: no conservative signals → conservative null but peers still reported", () => {
  const recs = [rec({ matchId: "m1", profileId: "medium", clvCents: 5 }), rec({ matchId: "m2", profileId: "aggressive", clvCents: 7 })];
  const a = conservativeAnomaly(recs, "prematch_value");
  assert.equal(a.conservative, null);
  assert.equal(a.peers!.nSignals, 2);
  assert.equal(a.clvDeficitCents, null, "no deficit computable without conservative");
  assert.match(a.note, /не имеет сигналов/);
});
