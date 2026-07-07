import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePoissonMarkets } from "../src/lib/poisson.js";
import { footballLabelProb } from "../src/lib/footballMarkets.js";

const d = derivePoissonMarkets({ xg_home: 1.8, xg_away: 0.9, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 });
const H = "Brazil", A = "Norway";
const P = (label: string) => footballLabelProb(label, H, A, d);
const eq = (a: number | null, b: number | null) => assert.equal(a, b);

test("footballLabelProb: match totals over/under", () => {
  eq(P("Over 2.5"), d.totals_match["2.5"]);
  eq(P("Under 2.5"), Math.round((1 - d.totals_match["2.5"]) * 10000) / 10000);
  eq(P("Over 1.5"), d.totals_match["1.5"]);
});

test("footballLabelProb: team + half totals scope", () => {
  eq(P("Brazil Over 1.5"), d.totals_home["1.5"]);
  eq(P("Norway Under 0.5"), Math.round((1 - d.totals_away["0.5"]) * 10000) / 10000);
  eq(P("Over 0.5 - 1st Half"), d.totals_1h["0.5"]);
  eq(P("Over 1.5 - 2nd Half"), d.totals_2h["1.5"]);
});

test("footballLabelProb: BTTS yes/no and second half", () => {
  eq(P("Both Teams to Score — Yes"), d.btts);
  eq(P("Both Teams to Score — No"), Math.round((1 - d.btts) * 10000) / 10000);
  eq(P("Both Teams to Score - 2nd Half"), d.btts_2h);
});

test("footballLabelProb: 1X2 — team win and draw", () => {
  eq(P("Brazil"), d.outcome_90.home);
  eq(P("Norway"), d.outcome_90.away);
  eq(P("Draw"), d.outcome_90.draw);
  eq(P("Draw (Brazil vs. Norway) — No"), Math.round((1 - d.outcome_90.draw) * 10000) / 10000);
});

test("footballLabelProb: handicap home cover and away complement", () => {
  eq(P("Brazil (-1.5)"), d.handicap["home_-1.5"]);
  eq(P("Brazil (-2.5)"), d.handicap["home_-2.5"]);
  eq(P("Norway (+1.5)"), Math.round((1 - d.handicap["home_-1.5"]) * 10000) / 10000);
});

test("footballLabelProb: advance + extra time (knockout)", () => {
  eq(P("Team to Advance — Norway"), d.advance.away);
  eq(P("Brazil to Advance"), d.advance.home);
  eq(P("Extra Time — Yes"), d.extra_time_prob);
});

test("footballLabelProb: unmapped market → null", () => {
  eq(P("First Goalscorer: Neymar"), null);
  eq(P("Corners Over 9.5"), null);   // 9.5 isn't a derived total line
  eq(P("Red Card in Match"), null);
});
