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

// ---- outcome_scenarios tree + match_shape ----

test("outcome_scenarios: 5 branches whose weights sum to 1 across distributions", () => {
  for (const [h, a] of [[1.8, 0.9], [1.3, 1.3], [0.7, 2.2], [2.5, 0.4], [1.0, 1.1]] as const) {
    for (const mt of ["group", "knockout"] as const) {
      const { outcome_scenarios: s } = deriveOutcomeScenarios(mkCore(h, a), mt);
      assert.equal(s.length, 5, `5 branches for ${h}-${a} ${mt}`);
      const sum = s.reduce((t, x) => t + x.prob, 0);
      assert.ok(Math.abs(sum - 1) <= 1e-3, `weights sum to 1 for ${h}-${a} ${mt}, got ${sum}`);
      const ids = new Set(s.map((x) => x.id));
      assert.equal(ids.size, 5, "all five branch ids present and distinct");
    }
  }
});

test("outcome_scenarios: branches are mutually exclusive (no score in two clusters)", () => {
  const { outcome_scenarios: s } = deriveOutcomeScenarios(mkCore(1.7, 1.0), "group");
  const seen = new Set<string>();
  for (const branch of s) for (const cell of branch.score_cluster) {
    assert.ok(!seen.has(cell), `score ${cell} appears in more than one branch`);
    seen.add(cell);
  }
});

test("outcome_scenarios: knockout puts ALL draws in the tight branch (→ extra time); group does not", () => {
  const ko = deriveOutcomeScenarios(mkCore(1.3, 1.3), "knockout");
  const gp = deriveOutcomeScenarios(mkCore(1.3, 1.3), "group");
  const koTight = ko.outcome_scenarios.find((x) => x.id === "tight_low_or_draw")!;
  const gpTight = gp.outcome_scenarios.find((x) => x.id === "tight_low_or_draw")!;
  assert.equal(koTight.leads_to_extra_time, true, "knockout draw branch → ET");
  assert.equal(gpTight.leads_to_extra_time, false, "group draw branch is final");
  // Knockout absorbs 1:1/2:2 into tight, so it is heavier than the group tight (0:0 only).
  assert.ok(koTight.prob > gpTight.prob, `knockout tight ${koTight.prob} > group tight ${gpTight.prob}`);
  // The knockout tight weight ≈ P(draw in 90).
  const d = derivePoissonMarkets(mkCore(1.3, 1.3), "knockout");
  assert.ok(near(koTight.prob, d.outcome_90.draw, 0.01), "knockout tight ≈ P(draw 90)");
  // Group moves the open draws into open_both_score instead.
  const gpOpen = gp.outcome_scenarios.find((x) => x.id === "open_both_score")!;
  const koOpen = ko.outcome_scenarios.find((x) => x.id === "open_both_score")!;
  assert.ok(gpOpen.prob > koOpen.prob, "group open branch carries the both-scored draws");
});

test("outcome_scenarios: favourite is the higher-xG side even when away is stronger", () => {
  const { outcome_scenarios: s } = deriveOutcomeScenarios(mkCore(0.8, 2.0), "group"); // away stronger
  assert.ok(s.every((x) => x.favorite === "away"), "away is the favourite");
  // Comfortable favourite branch should carry real weight when away is much stronger.
  const comf = s.find((x) => x.id === "fav_comfortable")!;
  assert.ok(comf.prob > 0.2, `away-fav comfortable branch has weight, got ${comf.prob}`);
});

test("match_shape: strong favourite → A, open even game → B, tight even → C", () => {
  assert.equal(deriveOutcomeScenarios(mkCore(2.3, 0.6), "group").match_shape, "A", "class favourite grinds");
  assert.equal(deriveOutcomeScenarios(mkCore(1.9, 1.8), "group").match_shape, "B", "high-scoring even game is open");
  assert.equal(deriveOutcomeScenarios(mkCore(0.7, 0.7), "group").match_shape, "C", "low-scoring even game is tight");
});
