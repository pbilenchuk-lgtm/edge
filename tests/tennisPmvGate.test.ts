import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { propFamily, buildTennisPropLiquidity } from "../src/lib/tennisScout.js";

test("propFamily: classifies a tennis prop label into a PMV family (moneyline → null)", () => {
  const P = "Iasi Open: Kawa vs Waltert ";
  assert.equal(propFamily(P + "Set 1 Winner"), "set_winner");
  assert.equal(propFamily(P + "Set 2 Winner"), "set_winner");
  assert.equal(propFamily(P + "Match Over 23.5"), "total_games");
  assert.equal(propFamily(P + "Set 1 Under 8.5"), "total_games");
  assert.equal(propFamily(P + "Total Sets: Under 2.5"), "total_sets");
  assert.equal(propFamily(P + "Set Handicap -1.5"), "set_handicap");
  assert.equal(propFamily("Iasi Open: Kawa vs Waltert"), null, "the moneyline carries no prop keyword");
});

function seedComp(db: ReturnType<typeof openDb>) {
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
}
function seedMatchWithProp(db: ReturnType<typeof openDb>, i: number, propLiq: number) {
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-atp", home: `A${i}`, away: `B${i}`, state: "live", lineup_out: true, kickoff_at: "2026-07-14T09:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: `ATP: A${i} vs B${i}`, price: 70, ai_prob: null, liquidity: "60000", external_ref: "ml", snapshot_at: "t", is_closing: false }); // moneyline
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: `ATP: A${i} vs B${i} Match Over 23.5`, price: 55, ai_prob: null, liquidity: String(propLiq), external_ref: "p", snapshot_at: "t", is_closing: false });
  return mid;
}

test("Gate 0.1: <15% of matches carry a ≥$500 prop → PARK (honest close)", () => {
  const db = openDb(":memory:");
  seedComp(db);
  // 12 matches with props; only 1 has a prop above the $500 book gate → 8.3% < 15% → park.
  for (let i = 0; i < 11; i++) seedMatchWithProp(db, i, 120);
  seedMatchWithProp(db, 99, 900);
  const r = buildTennisPropLiquidity(db);
  assert.equal(r.matchesWithProps, 12);
  assert.equal(r.matchesQualifying, 1);
  assert.equal(r.verdict, "park", `${(r.qualifyingPct * 100).toFixed(1)}% < 15%`);
  assert.ok(r.families.some((f) => f.family === "total_games"), "family survey present");
});

test("Gate 0.1: ≥15% carry a deep prop → BUILD", () => {
  const db = openDb(":memory:");
  seedComp(db);
  for (let i = 0; i < 6; i++) seedMatchWithProp(db, i, 120);
  for (let i = 0; i < 4; i++) seedMatchWithProp(db, 100 + i, 1500); // 4/10 = 40% ≥ 15%
  const r = buildTennisPropLiquidity(db);
  assert.equal(r.verdict, "build");
  assert.ok(r.qualifyingPct >= 0.15);
});

test("Gate 0.1: <10 matches with props → insufficient_data (don't decide on noise)", () => {
  const db = openDb(":memory:");
  seedComp(db);
  seedMatchWithProp(db, 0, 900);
  const r = buildTennisPropLiquidity(db);
  assert.equal(r.verdict, "insufficient_data");
});
