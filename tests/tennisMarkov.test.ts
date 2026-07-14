import { test } from "node:test";
import assert from "node:assert/strict";
import { setDistribution, matchDistribution, matchWinProbA, deltaFromMoneyline, tennisTheo, tiebreakProbA } from "../src/lib/tennisMarkov.js";

const sum = (d: number[]) => d.reduce((a, b) => a + (b ?? 0), 0);

test("core: δ=0 (equal players) → everything is symmetric 50/50", () => {
  const set = setDistribution(0.75, 0.75, true, 0);
  assert.ok(Math.abs(set.pA - 0.5) < 1e-9, "equal holds → set is a coin flip");
  assert.ok(Math.abs(matchWinProbA(0.75, 0) - 0.5) < 1e-9, "match too");
  const t = tennisTheo(0.5, 0.75);
  assert.ok(Math.abs(t.set1WinnerA - 0.5) < 1e-6);
  assert.ok(Math.abs(t.setHandicapA15 - 0.25) < 1e-6, "P(2-0) = 0.25 when each set is 50/50");
  assert.ok(Math.abs(t.totalSetsOver25 - 0.5) < 1e-6, "P(3 sets) = 0.5");
});

test("core: distributions sum to 1", () => {
  const set = setDistribution(0.82, 0.70, true, 0.12);
  assert.ok(Math.abs(sum([...set.scoreProb.values()]) - 1) < 1e-9, "set score dist");
  assert.ok(Math.abs(sum(set.totalGames) - 1) < 1e-9, "set total-games dist");
  const m = matchDistribution(0.82, 0.70, 0.12);
  assert.ok(Math.abs(sum(m.matchTotalGames) - 1) < 1e-9, "match total-games dist");
  assert.ok(Math.abs((m.sets.a20 + m.sets.a21 + m.sets.b21 + m.sets.b20) - 1) < 1e-9, "set-score outcomes");
});

test("core: monotonic in δ (bigger class gap → higher match-win prob)", () => {
  let prev = -1;
  for (const d of [-0.3, -0.15, 0, 0.15, 0.3]) { const p = matchWinProbA(0.78, d); assert.ok(p > prev, `p(${d})=${p.toFixed(3)} > ${prev.toFixed(3)}`); prev = p; }
});

test("core: δ solves FROM the moneyline (round-trip within tolerance)", () => {
  for (const pM of [0.55, 0.7, 0.85, 0.35]) {
    const t = tennisTheo(pM, 0.80);
    assert.ok(Math.abs(t.dist.pMatchA - pM) < 0.02, `theo reproduces moneyline ${pM}: got ${t.dist.pMatchA.toFixed(3)}`);
  }
  assert.ok(Math.abs(deltaFromMoneyline(0.5, 0.8)) < 1e-3, "50% moneyline → δ≈0");
  assert.ok(deltaFromMoneyline(0.75, 0.8) > 0, "favourite → positive δ");
});

test("core: tiebreak control point — a holdy set reaches 6-6 far more often than a breaky one", () => {
  const tb = (p: number) => (setDistribution(p, p, true, 0).scoreProb.get("7-6") ?? 0) + (setDistribution(p, p, true, 0).scoreProb.get("6-7") ?? 0);
  const holdy = tb(0.85), breaky = tb(0.60);
  assert.ok(holdy > breaky, `holdy ${holdy.toFixed(3)} > breaky ${breaky.toFixed(3)}`);
  assert.ok(holdy > 0.25 && holdy < 0.7, `0.85-hold set reaches a tiebreak ~a third+ of the time (${holdy.toFixed(3)})`);
  assert.ok(Math.abs(tiebreakProbA(0) - 0.5) < 1e-9, "even δ → 50/50 tiebreak");
});

test("core: prop prices move the RIGHT way as the favourite gets stronger", () => {
  const even = tennisTheo(0.55, 0.80), lop = tennisTheo(0.85, 0.80);
  assert.ok(lop.setHandicapA15 > even.setHandicapA15, "stronger favourite → higher P(2-0)");
  assert.ok(lop.totalSetsOver25 < even.totalSetsOver25, "stronger favourite → fewer 3-set matches");
  assert.ok(lop.matchGamesOver(21.5) < even.matchGamesOver(21.5), "a blowout carries fewer games");
  assert.ok(lop.set1WinnerA > even.set1WinnerA, "stronger favourite more likely to take a set");
});
