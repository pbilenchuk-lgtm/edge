import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePoissonMarkets, applyOverrides, applyCoreAdjustments, deriveOutcomeScenarios } from "../src/lib/poisson.js";

const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;
const mkCore = (xg_home: number, xg_away: number, poisson_correction = 0) => ({ xg_home, xg_away, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction });

test("derivePoissonMarkets: 1X2 sums to 1 and favours the stronger side", () => {
  const d = derivePoissonMarkets({ xg_home: 1.6, xg_away: 1.0, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  const { home, draw, away } = d.outcome_90;
  assert.ok(near(home + draw + away, 1), `1X2 sums to 1, got ${home + draw + away}`);
  assert.ok(home > away, "home xG higher → home more likely");
  assert.ok(draw > 0.15 && draw < 0.35, `draw plausible, got ${draw}`);
});

test("derivePoissonMarkets: totals are monotone and match a known Poisson value", () => {
  // λ_total = 2.6. P(over 2.5) = P(≥3) = 1 − P(≤2) for Poisson(2.6) ≈ 0.482.
  const d = derivePoissonMarkets({ xg_home: 1.3, xg_away: 1.3, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  assert.ok(near(d.totals_match["2.5"], 0.482, 0.02), `over 2.5 ≈ 0.482, got ${d.totals_match["2.5"]}`);
  assert.ok(d.totals_match["0.5"] > d.totals_match["1.5"] && d.totals_match["1.5"] > d.totals_match["2.5"] && d.totals_match["2.5"] > d.totals_match["3.5"], "over-lines strictly decreasing");
});

test("derivePoissonMarkets: BTTS = (1−e^-λh)(1−e^-λa)", () => {
  const lh = 1.5, la = 1.1;
  const d = derivePoissonMarkets({ xg_home: lh, xg_away: la, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  const want = (1 - Math.exp(-lh)) * (1 - Math.exp(-la));
  assert.ok(near(d.btts, want, 0.01), `BTTS ${d.btts} ≈ ${want.toFixed(3)}`);
});

test("derivePoissonMarkets: halves split xG; 1H totals lower than 2H at default shares", () => {
  const d = derivePoissonMarkets({ xg_home: 1.5, xg_away: 1.3, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  assert.ok(d.totals_2h["1.5"] > d.totals_1h["1.5"], "more goals expected in 2H (share 0.44 in 1H)");
  assert.ok(d.totals_1h["0.5"] > 0.5 && d.totals_1h["0.5"] < 0.95, "1H over 0.5 plausible");
});

test("derivePoissonMarkets: knockout advance = win + half the draws; extra_time = draw", () => {
  const d = derivePoissonMarkets({ xg_home: 1.4, xg_away: 1.4, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  assert.ok(near(d.extra_time_prob, d.outcome_90.draw, 0.001), "extra time ≈ P(draw in 90)");
  assert.ok(near(d.advance.home, d.outcome_90.home + d.outcome_90.draw * 0.5, 0.001));
  assert.ok(near(d.advance.home + d.advance.away, 1, 0.01), "advance splits to 1");
});

test("derivePoissonMarkets: handicap −1.5 ⊂ win, and −2.5 ⊂ −1.5", () => {
  const d = derivePoissonMarkets({ xg_home: 2.1, xg_away: 0.8, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  assert.ok(d.handicap["home_-1.5"] < d.outcome_90.home, "cover by 2 is rarer than a plain win");
  assert.ok(d.handicap["home_-2.5"] < d.handicap["home_-1.5"], "cover by 3 rarer than by 2");
});

test("applyOverrides: reasoned override moves the market; reasonless dropped", () => {
  const d = derivePoissonMarkets({ xg_home: 1.4, xg_away: 1.4, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  const before = d.totals_match["2.5"];
  const n = applyOverrides(d, [
    { target: "totals_match.2.5.over", adjust: -0.08, reason: "обеим достаточно ничьей — игра сожмётся" },
    { target: "totals_match.1.5.over", adjust: -0.05, reason: "" }, // no reason → dropped
  ]);
  assert.equal(n, 1, "only the reasoned override applied");
  assert.ok(near(d.totals_match["2.5"], before - 0.08, 0.001), "over 2.5 nudged down by 0.08");
});

test("applyOverrides: outcome_90 stays normalised after a draw nudge", () => {
  const d = derivePoissonMarkets({ xg_home: 1.4, xg_away: 1.4, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  applyOverrides(d, [{ target: "outcome_90.draw", adjust: 0.06, reason: "оба садятся, ничья вероятнее" }]);
  const { home, draw, away } = d.outcome_90;
  assert.ok(near(home + draw + away, 1, 0.001), "1X2 renormalised to 1");
});

test("applyCoreAdjustments: multiply/add applied with reason, reasonless dropped, clamped", () => {
  const core = { xg_home: 1.5, xg_away: 1.0, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 };
  const { core: c, log } = applyCoreAdjustments(core, [
    { target: "xg_home", op: "multiply", value: 0.9, reason: "Мехико, высота — падение интенсивности" },
    { target: "xg_away", op: "add", value: 0.2, reason: "аутсайдер вынужден раскрыться" },
    { target: "xg_home", op: "add", value: 0.5, reason: "" },       // no reason → dropped
    { target: "poisson_correction", op: "add", value: 5, reason: "x" }, // clamped to 0.1
  ]);
  assert.ok(Math.abs(c.xg_home - 1.35) < 1e-9, "1.5 × 0.9");
  assert.ok(Math.abs(c.xg_away - 1.2) < 1e-9, "1.0 + 0.2");
  assert.equal(c.poisson_correction, 0.1, "correction clamped to 0.1");
  assert.equal(log.filter((l) => l.applied).length, 3, "three reasoned adjustments applied");
  assert.equal(log.filter((l) => !l.applied).length, 1, "the reasonless one logged as dropped");
});

test("derivePoissonMarkets: poisson_correction ρ>0 lifts the draw vs pure Poisson", () => {
  const base = derivePoissonMarkets({ xg_home: 1.3, xg_away: 1.3, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  const corr = derivePoissonMarkets({ xg_home: 1.3, xg_away: 1.3, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0.08 });
  assert.ok(corr.outcome_90.draw > base.outcome_90.draw, "low-score correction raises draw probability");
});

// ---- outcome_scenarios: 6-branch MECE tree (winner × BTTS) + match_shape ----

const SIX_IDS = ["fav_clean", "fav_concedes", "draw_0_0", "draw_scoring", "dog_clean", "dog_concedes"];

test("outcome_scenarios: 6 MECE branches whose weights sum to 1 across distributions", () => {
  for (const [h, a] of [[1.8, 0.9], [1.3, 1.3], [0.7, 2.2], [2.5, 0.4], [1.0, 1.1]] as const) {
    for (const mt of ["group", "knockout"] as const) {
      const { outcome_scenarios: s } = deriveOutcomeScenarios(mkCore(h, a), mt);
      assert.equal(s.length, 6, `6 branches for ${h}-${a} ${mt}`);
      assert.deepEqual(s.map((x) => x.id).sort(), [...SIX_IDS].sort(), "exactly the 6 branch ids");
      const sum = s.reduce((t, x) => t + x.prob, 0);
      assert.ok(Math.abs(sum - 1) <= 1e-3, `weights sum to 1 for ${h}-${a} ${mt}, got ${sum}`);
      // winner_side / btts homogeneity per branch id.
      for (const x of s) {
        const expWinner = x.id.startsWith("fav") ? "fav" : x.id.startsWith("dog") ? "dog" : "draw";
        assert.equal(x.winner_side, expWinner, `${x.id} winner_side`);
        assert.equal(x.btts, x.id.endsWith("concedes") || x.id === "draw_scoring" ? "yes" : "no", `${x.id} btts`);
      }
    }
  }
});

test("outcome_scenarios: MECE — every final score lands in exactly one branch by (winner × btts)", () => {
  // Reconstruct the classification for a coarse grid and check no score's (winner,
  // btts) signature could match two branches. The clustering is defined by winner
  // and BTTS, which are disjoint by construction; assert the branch clusters don't
  // share a score string.
  const { outcome_scenarios: s } = deriveOutcomeScenarios(mkCore(1.7, 1.0), "group");
  const seen = new Set<string>();
  for (const branch of s) for (const cell of branch.score_cluster) {
    assert.ok(!seen.has(cell), `score ${cell} appears in more than one branch`);
    seen.add(cell);
  }
});

test("outcome_scenarios: BTTS + Extra Time fall out of the tree, matching Poisson (self-consistency)", () => {
  for (const [h, a] of [[1.8, 0.9], [1.3, 1.3], [0.7, 2.2], [1.75, 1.05]] as const) {
    const { outcome_scenarios: s } = deriveOutcomeScenarios(mkCore(h, a), "knockout");
    const d = derivePoissonMarkets(mkCore(h, a), "knockout");
    const bttsYes = s.filter((x) => x.btts === "yes").reduce((t, x) => t + x.prob, 0);
    assert.ok(near(bttsYes, d.btts, 0.005), `BTTS-yes branches ${bttsYes} ≈ Poisson btts ${d.btts}`);
    const drawBranches = s.filter((x) => x.winner_side === "draw").reduce((t, x) => t + x.prob, 0);
    assert.ok(near(drawBranches, d.extra_time_prob, 0.005), `draw branches ${drawBranches} ≈ extra_time ${d.extra_time_prob}`);
    // Every draw branch (and only those) carries leads_to_extra_time in a knockout.
    for (const x of s) assert.equal(x.leads_to_extra_time, x.winner_side === "draw", `${x.id} ET flag`);
  }
});

test("outcome_scenarios: group draw branches are NOT extra-time; concedes branches carry a total_note", () => {
  const { outcome_scenarios: s } = deriveOutcomeScenarios(mkCore(1.6, 1.1), "group");
  assert.ok(s.every((x) => x.leads_to_extra_time === false), "group draws are final, no ET");
  for (const x of s) {
    if (x.id === "fav_concedes" || x.id === "dog_concedes") assert.match(x.total_note ?? "", /Over2\.5:\s*100%.*Over3\.5/, `${x.id} has a total_note (always Over 2.5)`);
    else assert.equal(x.total_note, null, `${x.id} total_note is null`);
  }
});

test("outcome_scenarios: favourite is the higher-xG side even when away is stronger", () => {
  const { outcome_scenarios: s } = deriveOutcomeScenarios(mkCore(0.8, 2.0), "group"); // away stronger
  assert.ok(s.every((x) => x.favorite === "away"), "away is the favourite");
  const favSide = s.filter((x) => x.winner_side === "fav").reduce((t, x) => t + x.prob, 0);
  const dogSide = s.filter((x) => x.winner_side === "dog").reduce((t, x) => t + x.prob, 0);
  assert.ok(favSide > dogSide, `fav (away) side ${favSide} > dog side ${dogSide}`);
});

test("match_shape: strong favourite → A, open even game → B, tight even → C", () => {
  assert.equal(deriveOutcomeScenarios(mkCore(2.5, 0.5), "group").match_shape, "A", "class favourite");
  assert.equal(deriveOutcomeScenarios(mkCore(1.9, 1.8), "group").match_shape, "B", "high-scoring even game is open");
  assert.equal(deriveOutcomeScenarios(mkCore(0.7, 0.7), "group").match_shape, "C", "low-scoring even game is tight");
});
