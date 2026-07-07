import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePoissonMarkets, applyOverrides } from "../src/lib/poisson.js";

const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

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

test("derivePoissonMarkets: poisson_correction ρ>0 lifts the draw vs pure Poisson", () => {
  const base = derivePoissonMarkets({ xg_home: 1.3, xg_away: 1.3, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
  const corr = derivePoissonMarkets({ xg_home: 1.3, xg_away: 1.3, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0.08 });
  assert.ok(corr.outcome_90.draw > base.outcome_90.draw, "low-score correction raises draw probability");
});
