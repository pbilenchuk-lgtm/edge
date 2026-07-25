import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildThesisExposure, matchThesisExposure, matchThesisRoom, thesisCapUsd, dailyClusterCapUsd, dailyClusterRoom, dailyClusterExposure } from "../src/lib/thesisExposure.js";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "pm-mls", sport_id: "football", name: "MLS", budget: 8000, external_league: "usa.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "pm-mls", home: "Inter Miami", away: "Orlando City", state: "live", lineup_out: true, kickoff_at: "t", minute: 20, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  const bet = (id: string, market: string, stake: number, status = "open") => R.insertBet(db, { id, match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "max", market_label: market, status, proposed_price: 50, entry_price: 50, current_price: 55, closing_price: null, ai_prob: 0.7, stake, rationale: "r", entered_minute: null, result: null, payout: null, settled_by: null, created_at: "t" } as any);
  return { db, bet };
}

test("S5 thesis exposure: Over 0.5 + Over 1.5 + moneyline of ONE team = one thesis, stake summed, capped together", () => {
  const { db, bet } = seed();
  bet("b1", "Inter Miami Over 0.5", 60);
  bet("b2", "Inter Miami Over 1.5", 40);
  bet("b3", "Inter Miami", 30);            // moneyline — S5 joins the same dominance thesis
  bet("b4", "Orlando City Over 0.5", 25);  // the OTHER team → a different thesis (lone leg, not a stack)

  // match-wide thesis exposure for the Inter Miami dominance cluster
  const exp = matchThesisExposure(db, "m1", "dom:home", "Inter Miami", "Orlando City");
  assert.equal(exp, 130, "60+40+30 collapse to one thesis");

  const rep = buildThesisExposure(db, { THESIS_MATCH_CAP_USD: "100" });
  const home = rep.theses.find((t) => t.thesis === "dom:home")!;
  assert.equal(home.stakeUsd, 130);
  assert.equal(home.bets, 3, "three correlated legs");
  assert.ok(home.overCap, "130 > cap 100 → breach");
  assert.equal(rep.breaches, 1);
  // the single Orlando leg is NOT a stacked thesis (needs ≥2 legs) → not reported as a breach
  assert.ok(!rep.theses.some((t) => t.thesis === "dom:away"));

  // room = cap − current exposure; a further $10 fits, $50 doesn't
  assert.equal(matchThesisRoom(db, "m1", "dom:home", "Inter Miami", "Orlando City", { THESIS_MATCH_CAP_USD: "150" }), 20);
  assert.equal(matchThesisRoom(db, "m1", "dom:home", "Inter Miami", "Orlando City", {}), Infinity, "no cap → unbounded (paper unchanged)");
});

test("M12 (Phase 2.7): thesis cap as a FRACTION of bank, else the absolute constant", () => {
  assert.equal(thesisCapUsd({ THESIS_MATCH_CAP_FRAC: "0.05", THESIS_BANK_USD: "5000" }), 250, "5% of a $5000 bank");
  assert.equal(thesisCapUsd({ THESIS_MATCH_CAP_USD: "250" }), 250, "absolute fallback");
  assert.equal(thesisCapUsd({}), 0, "unset → disabled");
  assert.equal(dailyClusterCapUsd({ THESIS_MATCH_CAP_USD: "250" }), 500, "default 2× the per-match cap");
  assert.equal(dailyClusterCapUsd({ THESIS_MATCH_CAP_USD: "250", THESIS_DAILY_CLUSTER_MULT: "3" }), 750);
  assert.equal(dailyClusterCapUsd({}), 0, "off when the per-match cap is off");
});

test("M11 (Phase 2.7): the DAILY cross-match cluster sums one direction across the league's matches on a day", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "ucl", sport_id: "football", name: "UCL", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  // three CL matches on the SAME kickoff-day, each a "favourite (home) wins" thesis (dom:home) at $200.
  const day = "2026-07-26";
  for (const [id, home, away] of [["m1", "Alpha", "Beta"], ["m2", "Gamma", "Delta"], ["m3", "Epsilon", "Zeta"]] as const) {
    R.insertMatch(db, { id, competition_id: "ucl", home, away, state: "live", lineup_out: true, kickoff_at: `${day}T18:00:00Z`, minute: 10, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
    R.insertBet(db, { id: `b-${id}`, match_id: id, strategy_id: "prematch_value", risk_profile_id: "max", market_label: `${home} Over 0.5`, status: "open", proposed_price: 50, entry_price: 50, current_price: 55, closing_price: null, ai_prob: 0.7, stake: 200, rationale: "r", entered_minute: null, result: null, payout: null, settled_by: null, created_at: "t" } as any);
  }
  // $600 of one directional thesis across three matches — the per-match cap ($250) sees only $200 each.
  assert.equal(dailyClusterExposure(db, "ucl", day, "dom:home", ["open"]), 600);
  // daily cap 2×$250 = $500 → room is 0 (already over).
  assert.equal(dailyClusterRoom(db, "ucl", day, "dom:home", { THESIS_MATCH_CAP_USD: "250" }, ["open"]), 0);
  // disabled cap → unbounded (paper unchanged)
  assert.equal(dailyClusterRoom(db, "ucl", day, "dom:home", {}, ["open"]), Infinity);
  // the report surfaces the cross-match cluster as a breach
  const rep = buildThesisExposure(db, { THESIS_MATCH_CAP_USD: "250" });
  const cl = rep.dailyClusters.find((d) => d.direction === "dom:home" && d.day === day)!;
  assert.equal(cl.matches, 3);
  assert.equal(cl.stakeUsd, 600);
  assert.ok(cl.overCap, "$600 > daily cap $500");
});

test("M9 (Phase 2.6): a SAME-LABEL multi-profile stack is visible + breach-flagged (was hidden by markets.size≥2)", () => {
  const { db, bet } = seed();
  // three profiles each buying the SAME market label — one distinct label, three bets, $210 on one thesis.
  bet("s1", "Inter Miami Over 0.5", 90);
  bet("s2", "Inter Miami Over 0.5", 70);
  bet("s3", "Inter Miami Over 0.5", 50);
  const rep = buildThesisExposure(db, { THESIS_MATCH_CAP_USD: "100" });
  const home = rep.theses.find((t) => t.thesis === "dom:home");
  assert.ok(home, "a same-label 3-bet stack IS reported (bet count ≥2), not dropped for having 1 distinct label");
  assert.equal(home!.stakeUsd, 210, "combined stake of all three bets");
  assert.equal(home!.bets, 3, "bets counts BETS, not distinct labels");
  assert.ok(home!.overCap, "$210 > cap $100 → breach visible (was hidden before)");
  assert.equal(rep.breaches, 1);
});
