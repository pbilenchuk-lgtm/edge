import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { resolveTennisWinner } from "../src/lib/settlement.js";
import { serializeEntryMeta } from "../src/lib/betMeta.js";
import { tennisFinalResult, settleTennisBets, chargeTennisMatch, finishTennisMatches } from "../src/lib/tennisTrading.js";
import { migrateTennisStrategy } from "../src/lib/seed.js";

test("resolveTennisWinner: advances→YES, loser→NO, canceled→void, retirement→advancing wins", () => {
  // Vukic advances (won or Broady retired)
  assert.equal(resolveTennisWinner("Aleksandar Vukic", "Aleksandar Vukic", "Liam Broady", "first", false), true);
  assert.equal(resolveTennisWinner("Liam Broady", "Aleksandar Vukic", "Liam Broady", "first", false), false);
  // canceled / not played → 50-50 → void (null)
  assert.equal(resolveTennisWinner("Aleksandar Vukic", "Aleksandar Vukic", "Liam Broady", null, true), null);
  // retirement is handled by the caller setting `advancing` to the non-retiring player:
  assert.equal(resolveTennisWinner("Liam Broady", "Aleksandar Vukic", "Liam Broady", "second", false), true, "Broady advances on Vukic's retirement");
  // ambiguous label → null (unresolvable, keep open)
  assert.equal(resolveTennisWinner("The Draw", "Vukic", "Broady", "first", false), null);
});

test("migrateTennisStrategy: the tennis_overreaction strategy is seeded on boot (sport=tennis)", () => {
  const db = openDb(":memory:");
  migrateTennisStrategy(db); // runs in getDb() on prod boot; tests invoke it directly
  const s = R.getStrategy(db, "tennis_overreaction");
  assert.ok(s, "seeded");
  assert.equal(s!.sport_id, "tennis");
  assert.ok((s!.prompt_live ?? "").length > 0, "has a live prompt");
});

function seedTennisMatch(db: ReturnType<typeof openDb>, opts: { p1: string; p2: string; p1liq?: number; p2liq?: number; p1price?: number; p2price?: number }) {
  migrateTennisStrategy(db); // FK target for tennis bets
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-atp", home: opts.p1, away: opts.p2, state: "live", lineup_out: true, kickoff_at: "2026-07-14T09:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: opts.p1, price: opts.p1price ?? 80, ai_prob: null, liquidity: String(opts.p1liq ?? 5000), external_ref: "t1", snapshot_at: "t", is_closing: false });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: opts.p2, price: opts.p2price ?? 20, ai_prob: null, liquidity: String(opts.p2liq ?? 5000), external_ref: "t2", snapshot_at: "t", is_closing: false });
  return mid;
}

test("chargeTennisMatch: identifies the favourite + gates tradeability on winner-book depth", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 78, p2price: 22, p1liq: 5000, p2liq: 5000 });
  const c = chargeTennisMatch(db, mid, { p1: "A. Vukic", p2: "L. Broady" });
  assert.equal(c.favSide, "first");
  assert.equal(c.tradeable, true);
  assert.equal(c.triggers.length, 2);
  // thin book on one side → not tradeable
  const mid2 = seedTennisMatch(db, { p1: "X Player", p2: "Y Player", p1price: 80, p2price: 20, p1liq: 5000, p2liq: 100 });
  assert.equal(chargeTennisMatch(db, mid2, { p1: "X Player", p2: "Y Player" }).tradeable, false);
});

test("tennisFinalResult + settleTennisBets: settle a paper bet from the scout's final result", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 60 });
  // scout final: Vukic (first) won, finished.
  R.insertTennisSnapshot(db, { event_key: "E1", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Finished", sets_p1: 2, sets_p2: 1, set_num: 3, games_p1: 6, games_p2: 4, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: 60, pm_p2_cents: 40, raw: JSON.stringify({ event_winner: "First Player" }) });
  const fin = tennisFinalResult(db, mid)!;
  assert.equal(fin.finished, true); assert.equal(fin.advancing, "first");
  // open a paper bet on the favourite (Vukic) @ 60¢
  R.insertBet(db, { id: "tb1", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 60, entry_price: 60, current_price: 60, closing_price: null, ai_prob: 0.7, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live" }), code_version: "e5", created_at: "t" } as any);
  const n = settleTennisBets(db, { now: () => "2026-07-14T13:00:00Z" });
  assert.equal(n, 1);
  const b = R.getBet(db, "tb1")!;
  assert.equal(b.status, "settled_won");
  assert.equal(b.payout, Math.round(100 / 0.6 * 100) / 100, "payout = stake / (60/100)");
});

test("finishTennisMatches: a live app match with a Finished scout snapshot transitions to finished", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // no scout yet → stays live
  assert.equal(finishTennisMatches(db, { now: () => "2026-07-14T13:00:00Z" }), 0);
  assert.equal(R.getMatch(db, mid)!.state, "live");
  // scout says finished → the match is driven to finished (else it piles up in live forever)
  R.insertTennisSnapshot(db, { event_key: "E3", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Finished", sets_p1: 2, sets_p2: 0, set_num: 2, games_p1: 6, games_p2: 3, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  assert.equal(finishTennisMatches(db, { now: () => "2026-07-14T13:00:00Z" }), 1);
  assert.equal(R.getMatch(db, mid)!.state, "finished");
  // idempotent — already finished, no re-count
  assert.equal(finishTennisMatches(db, { now: () => "2026-07-14T13:05:00Z" }), 0);
});

test("settleTennisBets: a retirement resolves to the advancing (non-retiring) player", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // Broady retired → Vukic (First Player) advances.
  R.insertTennisSnapshot(db, { event_key: "E2", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Retired", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 3, games_p2: 1, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  R.insertBet(db, { id: "tb2", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Liam Broady", status: "open", proposed_price: 40, entry_price: 40, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e5", created_at: "t" } as any);
  settleTennisBets(db, { now: () => "2026-07-14T13:00:00Z" });
  const b = R.getBet(db, "tb2")!;
  assert.equal(b.status, "settled_lost", "the Broady bet loses — Vukic advanced on retirement");
});
