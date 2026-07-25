import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { autoEnter } from "../src/lib/lifecycle.js";
import { correlationKey } from "../src/lib/strategist.js";
import { matchThesisExposure } from "../src/lib/thesisExposure.js";

// Test #1 (audit Part 8 / spec 2.1): several (strategy×profile) pairs propose onto ONE dom:home thesis before
// any fills. Before the fix each saw room = cap − 0 and autoEnter filled them all (2.1× the cap). The fill-time
// re-check must clamp/skip so the COMBINED open exposure never exceeds THESIS_MATCH_CAP_USD.
test("2.1 X1: correlated proposals cannot collectively exceed the thesis cap after autoEnter", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const comp = R.listCompetitions(db).find((c: any) => c.sport_id === "football")!;
  const mid = R.uid();
  // upcoming + lineups out + a match_live row → hasLiveData true (fills) and the live-only zombie map is inert.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Alpha", away: "Beta", state: "upcoming", lineup_out: true, kickoff_at: "2026-07-26T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  // two markets of the SAME dominance thesis (team Over-line + team moneyline both → dom:home)
  assert.equal(correlationKey("Alpha Over 0.5", "Alpha", "Beta"), "dom:home");
  assert.equal(correlationKey("Alpha", "Alpha", "Beta"), "dom:home");
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Alpha Over 0.5", price: 50, ai_prob: 0.7, liquidity: "5000", external_ref: "t1", token_second: null, snapshot_at: "t", is_closing: false } as any);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Alpha", price: 50, ai_prob: 0.7, liquidity: "5000", external_ref: "t2", token_second: null, snapshot_at: "t", is_closing: false } as any);
  const bet = (id: string, label: string) => R.insertBet(db, { id, match_id: mid, strategy_id: "edge", risk_profile_id: "medium", market_label: label, status: "proposed", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.7, stake: 150, rationale: null, entered_minute: null, result: null, payout: null, settled_by: null, entry_meta: JSON.stringify({ phase: "prematch" }), created_at: "t" } as any);
  bet("A", "Alpha Over 0.5");
  bet("B", "Alpha"); // two 150 proposals = 300 requested on ONE thesis, cap 250

  await autoEnter(db, { now: () => "t", env: { THESIS_MATCH_CAP_USD: "250" } });

  const exposure = matchThesisExposure(db, mid, "dom:home", "Alpha", "Beta", ["open"]);
  assert.ok(exposure <= 250 + 1e-6, `combined dom:home open exposure $${exposure} must be ≤ cap 250`);
  // and the cap is actually BINDING here: 300 was requested, so real clamping happened (not both skipped).
  assert.ok(exposure >= 249, `the cap should be ~filled ($${exposure}), proving clamp — not a trivial 0`);
});

test("2.1 X1: with the cap DISABLED (0/unset) nothing is clamped — paper behaviour unchanged", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const comp = R.listCompetitions(db).find((c: any) => c.sport_id === "football")!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Alpha", away: "Beta", state: "upcoming", lineup_out: true, kickoff_at: "2026-07-26T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Alpha Over 0.5", price: 50, ai_prob: 0.7, liquidity: "5000", external_ref: "t1", token_second: null, snapshot_at: "t", is_closing: false } as any);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Alpha", price: 50, ai_prob: 0.7, liquidity: "5000", external_ref: "t2", token_second: null, snapshot_at: "t", is_closing: false } as any);
  R.insertBet(db, { id: "A", match_id: mid, strategy_id: "edge", risk_profile_id: "medium", market_label: "Alpha Over 0.5", status: "proposed", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.7, stake: 150, rationale: null, entered_minute: null, result: null, payout: null, settled_by: null, entry_meta: JSON.stringify({ phase: "prematch" }), created_at: "t" } as any);
  R.insertBet(db, { id: "B", match_id: mid, strategy_id: "edge", risk_profile_id: "medium", market_label: "Alpha", status: "proposed", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.7, stake: 150, rationale: null, entered_minute: null, result: null, payout: null, settled_by: null, entry_meta: JSON.stringify({ phase: "prematch" }), created_at: "t" } as any);
  await autoEnter(db, { now: () => "t", env: {} }); // cap unset → Infinity room
  assert.equal(matchThesisExposure(db, mid, "dom:home", "Alpha", "Beta", ["open"]), 300, "both fill in full, no clamp");
});
