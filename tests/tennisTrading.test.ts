import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { resolveTennisWinner } from "../src/lib/settlement.js";
import { serializeEntryMeta } from "../src/lib/betMeta.js";
import { tennisFinalResult, settleTennisBets, chargeTennisMatch, finishTennisMatches, tennisExitTick, tennisTradingTick, tennisEntryMeta } from "../src/lib/tennisTrading.js";
import { migrateTennisStrategy } from "../src/lib/seed.js";
import { buildTennisCalibrationReport } from "../src/lib/tennisScout.js";
import { buildTennisFunnel } from "../src/lib/tennisTrading.js";
import { advanceClocks } from "../src/lib/lifecycle.js";

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

test("chargeTennisMatch: favourite is identified from the PRE-BREAK price even when the current price panicked", () => {
  const db = openDb(":memory:");
  // MARKET row now shows a coin-flip (the favourite's price crashed on the break) → no favourite by current price.
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 50, p2price: 50, p1liq: 5000, p2liq: 5000 });
  assert.equal(chargeTennisMatch(db, mid, { p1: "A. Vukic", p2: "L. Broady" }).favSide, null, "current 50/50 → favourite erased by the panic");
  // Pre-break price (80/20) recovers the favourite — this is what the tick now passes in.
  assert.equal(chargeTennisMatch(db, mid, { p1: "A. Vukic", p2: "L. Broady" }, { p1: 80, p2: 20 }).favSide, "first", "pre-break 80/20 → favourite = first");
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

test("tennisExitTick: take_price realizes the buyback when the favourite recovers to the pre-break level", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // Entered the buyback at the panicked 44¢; the pre-written plan takes profit at 59¢ (pre-break 62 − 3 buffer).
  R.insertBet(db, { id: "tex1", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 1", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: { take_price: { at_cents: 59, note: "возврат минус запас" } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Scout: the favourite recovered to 60¢ (≥ the 59¢ take level).
  R.insertTennisSnapshot(db, { event_key: "E9", provider: "apitennis", batch_at: "2026-07-14T10:10:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1, status: "Set 3", sets_p1: 1, sets_p2: 1, set_num: 3, games_p1: 2, games_p2: 1, game_points: null, server: "first", pm_match_id: mid, pm_mid_cents: 60, pm_p1_cents: 60, pm_p2_cents: 40, raw: "{}" });
  const n = tennisExitTick(db, { now: () => "2026-07-14T10:10:05Z" });
  assert.equal(n, 1, "the recovery-take fired");
  const b = R.getBet(db, "tex1")!;
  assert.equal(b.status, "settled_won");
  assert.equal(b.settled_by, "early", "booked as a trading realize, not a prediction outcome");
  assert.equal(b.closing_price, 60);
  assert.equal(b.payout, Math.round(100 * (60 / 44) * 100) / 100, "payout = stake·current/entry");
});

test("tennisExitTick: thesis_stop cuts the position on a SECOND break of the favourite (price still low)", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertBet(db, { id: "tex2", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Favourite (first) serving at 3-3, gets broken → 3-4, and it persists. Price stays at 40¢ (< 59 take), so the take never fires.
  const base = { provider: "apitennis", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1 as const, status: "Set 2", sets_p1: 1, sets_p2: 1, set_num: 2, game_points: null, pm_match_id: mid, pm_mid_cents: 40, pm_p2_cents: 60, raw: "{}" };
  R.insertTennisSnapshot(db, { ...base, event_key: "E10", batch_at: "2026-07-14T10:05:00Z", games_p1: 3, games_p2: 3, server: "first", pm_p1_cents: 40 });
  R.insertTennisSnapshot(db, { ...base, event_key: "E10", batch_at: "2026-07-14T10:06:00Z", games_p1: 3, games_p2: 4, server: "second", pm_p1_cents: 40 });
  R.insertTennisSnapshot(db, { ...base, event_key: "E10", batch_at: "2026-07-14T10:07:00Z", games_p1: 3, games_p2: 4, server: "second", pm_p1_cents: 40 });
  const n = tennisExitTick(db, { now: () => "2026-07-14T10:07:05Z" });
  assert.equal(n, 1, "thesis_stop fired on the second favourite break");
  const b = R.getBet(db, "tex2")!;
  assert.equal(b.status, "settled_lost", "40¢ < 44¢ entry → the cut books a loss");
  assert.equal(b.settled_by, "early");
  assert.equal(b.closing_price, 40);
});

// Compact snapshot helper for the exit-order tests (one event, ATP singles, live).
function snap(db: ReturnType<typeof openDb>, mid: string, o: { at: string; g1: number; g2: number; server: "first" | "second" | null; p1c: number | null; setNum?: number }) {
  R.insertTennisSnapshot(db, { event_key: "EX", provider: "apitennis", batch_at: o.at, p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1, status: "live", sets_p1: 1, sets_p2: 0, set_num: o.setNum ?? 2, games_p1: o.g1, games_p2: o.g2, game_points: null, server: o.server, pm_match_id: mid, pm_mid_cents: o.p1c, pm_p1_cents: o.p1c, pm_p2_cents: o.p1c == null ? null : 100 - o.p1c, raw: "{}" });
}
function buybackBet(db: ReturnType<typeof openDb>, mid: string, id: string, plan: any, profile = "medium") {
  R.insertBet(db, { id, match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: profile, market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: plan }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
}

test("tennis calibration: the entry plan carries the CALIBRATED defaults (K=2, epoch=calibrated)", () => {
  // From 105 §4/B marks: recovery p75 = 1 min → K=2; strategy validated → epoch=calibrated.
  const meta = tennisEntryMeta({ favPrice: 45, prePrice: 62, edge: 0.1, kelly: 0.2, stake: 100, thinnessUsd: 5000, setNum: 1 });
  const plan = meta.exitPlan as any;
  assert.equal(plan.game_count_stop.receiver_games, 2, "calibrated game-count stop");
  assert.equal(plan.armed_epoch, "calibrated");
  assert.equal(plan.take_price.at_cents, 59, "pre-break 62 − 3¢ buffer (kept)");
  assert.equal(plan.catastrophic_floor.at_cents, 30, "entry 45 − 15¢ floor (held structural)");
});

test("tennisExitTick A1: game_count_stop fires after K receiving games with NO break-back", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a1", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 }, game_count_stop: { receiver_games: 2 } });
  // Favourite (first) is the receiver whenever server="second". Two opponent holds → 2 receiving games, no break-back. Price flat at 45 (no take, no floor).
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 45 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "first", p1c: 45 });  // opp held → recv #1
  snap(db, mid, { at: "2026-07-14T10:03:00Z", g1: 4, g2: 4, server: "second", p1c: 45 }); // fav held
  snap(db, mid, { at: "2026-07-14T10:04:00Z", g1: 4, g2: 5, server: "first", p1c: 45 });  // opp held → recv #2
  snap(db, mid, { at: "2026-07-14T10:05:00Z", g1: 4, g2: 5, server: "first", p1c: 45 });  // debounce confirm
  assert.equal(tennisExitTick(db, { now: () => "2026-07-14T10:05:05Z" }), 1);
  const b = R.getBet(db, "a1")!;
  assert.equal(b.status, "settled_won", "closed at 45¢ > 44¢ entry → small win");
  assert.equal(b.closing_price, 45);
});

test("tennisExitTick A1: a BREAK-BACK (counter-break) suppresses game_count_stop — position holds", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a1b", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 }, game_count_stop: { receiver_games: 2 } });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 45 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 4, g2: 3, server: "first", p1c: 45 });  // fav BROKE opp serve → counter-break (recv #1)
  snap(db, mid, { at: "2026-07-14T10:03:00Z", g1: 5, g2: 3, server: "second", p1c: 45 }); // fav held
  snap(db, mid, { at: "2026-07-14T10:04:00Z", g1: 5, g2: 4, server: "first", p1c: 45 });  // opp held → recv #2
  snap(db, mid, { at: "2026-07-14T10:05:00Z", g1: 5, g2: 4, server: "first", p1c: 45 });  // debounce
  assert.equal(tennisExitTick(db, { now: () => "2026-07-14T10:05:05Z" }), 0, "recovery underway (break-back) → don't stop");
  assert.equal(R.getBet(db, "a1b")!.status, "open");
});

test("tennisExitTick A2: catastrophic_floor fires only on a PERSISTENT collapse (phantom-guarded)", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // floor at 29¢ (entry 44 − 15). Two consecutive snapshots ≤ 29 → confirmed collapse.
  buybackBet(db, mid, "a2", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 } });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 27 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 3, server: "second", p1c: 26 });
  assert.equal(tennisExitTick(db, { now: () => "2026-07-14T10:02:05Z" }), 1);
  const b = R.getBet(db, "a2")!;
  assert.equal(b.status, "settled_lost");
  assert.equal(b.closing_price, 26);
});

test("tennisExitTick A2: a SINGLE spike below floor (then recovers) does NOT trigger — phantom guard", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a2b", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 } });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 45 }); // prev above floor
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 3, server: "second", p1c: 24 }); // one print below — a phantom
  assert.equal(tennisExitTick(db, { now: () => "2026-07-14T10:02:05Z" }), 0, "single print ≤ floor is not confirmed → hold");
  assert.equal(R.getBet(db, "a2b")!.status, "open");
});

test("tennisExitTick A2: game jitter ABOVE the floor never triggers the backstop", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a2c", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 } });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 36 }); // −8¢ deuce jitter
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 3, server: "second", p1c: 36 });
  assert.equal(tennisExitTick(db, { now: () => "2026-07-14T10:02:05Z" }), 0, "±8¢ never reaches entry−15 → hold");
  assert.equal(R.getBet(db, "a2c")!.status, "open");
});

test("tennisExitTick A4: on simultaneous thesis_stop + catastrophic_floor, the THESIS (defensive, higher) wins", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a4", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 } });
  // A second break of the favourite (server first loses) AND price collapsed ≤ floor at the same time.
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 26 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 24 }); // fav's serve broken
  snap(db, mid, { at: "2026-07-14T10:03:00Z", g1: 3, g2: 4, server: "second", p1c: 24 }); // debounce
  assert.equal(tennisExitTick(db, { now: () => "2026-07-14T10:03:05Z" }), 1);
  const logs = R.tradeLogForMatch(db, mid).filter((l) => l.type === "exit");
  assert.ok(logs.some((l) => /thesis_stop/.test(l.text)), "thesis_stop fired");
  assert.ok(!logs.some((l) => /catastrophic_floor/.test(l.text)), "floor did NOT also fire (single close, defensive priority)");
});

test("tennisTradingTick A3: when EVERY profile already holds a buyback on the match, the break is blocked (no LLM call)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 80, p2price: 20 });
  // Hold an open buyback for EACH default profile → no free profile left → block before the LLM.
  for (const p of ["aggressive", "medium", "conservative"]) buybackBet(db, mid, "held-" + p, { take_price: { at_cents: 59 } }, p);
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 50, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 });
  // No fetchImpl: if the block fails and the LLM is reached, the call throws → test surfaces it.
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: {} });
  assert.equal(opened, 0, "all profiles held → no new buyback");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /blocked_second_buyback/.test(l.text)), "block is logged");
});

test("tennisTradingTick: one overreaction opens a bet per FREE risk profile, each on its own budget (side-by-side)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 80, p2price: 20, p1liq: 8000, p2liq: 8000 });
  // Favourite (first) broken in set 1, price 50¢ → passes the gate.
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 50, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 });
  // Mock the strategist to confirm the overreaction (buy the favourite) — ONE call, shared.
  const body = { content: [{ text: JSON.stringify({ picks: [{ label: "Aleksandar Vukic", prob: 0.7, reason: "выкуп переоценки" }] }) }] };
  let llmCalls = 0;
  const fetchImpl = (async () => { llmCalls++; return { ok: true, status: 200, json: async () => body }; }) as unknown as typeof fetch;
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { ANTHROPIC_API_KEY: "k" }, fetchImpl });
  assert.equal(llmCalls, 1, "the real_shift question is asked ONCE, not per profile (Model-A dedup)");
  assert.equal(opened, 3, "one bet per default profile (aggressive/medium/conservative)");
  const bets = R.betsForMatch(db, mid, "tennis_overreaction").filter((b) => b.status === "open");
  assert.deepEqual([...new Set(bets.map((b) => b.risk_profile_id))].sort(), ["aggressive", "conservative", "medium"], "distinct profiles, side-by-side");
  assert.ok(bets.every((b) => (b.stake ?? 0) > 0 && b.code_version?.includes("calibrated")), "each sized > 0 and carries the calibrated epoch");
});

test("Part B buildTennisCalibrationReport: splits marks into recovery vs no-recovery", () => {
  const db = openDb(":memory:");
  const mk = (id: string, pre: number, floor: number, rec5: number, early: number) => R.insertTennisBreakMark(db, {
    event_key: id, match_id: null, players: "A vs B", tournament: "ATP Granby", event_type: "Atp Singles", set_num: 1,
    broken_side: "first", broke_early: early, t_event: "2026-07-14T10:00:00Z", pre_cents: pre, floor_cents: floor, t_floor_sec: 60,
    panic_cents: pre - floor, recovery_1: 0, recovery_2: Math.round(rec5 / 2), recovery_3: rec5, recovery_5: rec5, window_quotes: 10, confidence_flags: null, code_version: "e5", created_at: id,
  });
  // Recovered: pre 62, floor 40 (panic 22); recovery_5 = 20 ≥ panic−buffer(22−3=19) → recovered.
  mk("r1", 62, 40, 20, 1);
  // No-recovery: pre 60, floor 30 (panic 30); best recovery 8 < 27 → never came back.
  mk("n1", 60, 30, 8, 1);
  mk("n2", 70, 25, 5, 0); // deep slide 45, no recovery
  const rep = buildTennisCalibrationReport(db);
  assert.equal(rep.measured, 3);
  assert.equal(rep.recovery.n, 1, "one mark recovered to within the take buffer");
  assert.equal(rep.noRecovery.n, 2);
  assert.equal(rep.ready, false, "3 < 100 → interim, not ready");
  assert.ok((rep.noRecovery.slideCents.p90 ?? 0) >= 30, "no-recovery slide tail informs the floor");
  assert.ok(rep.byContext.some((c) => /ATP/.test(c.context)), "context split present");
});

test("advanceClocks tennis: kickoff passed but NO scout data → stays upcoming (no clock-phantom live)", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.updateMatch(db, mid, { state: "upcoming", lineup_out: false }); // reset from seed's "live"
  // kickoff is in the past; a football match would flip to live here. Tennis must NOT (no scout).
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "upcoming", "the clock never fabricates tennis live");
});

test("advanceClocks tennis: a FRESH in-play scout snapshot flips the match to live", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.updateMatch(db, mid, { state: "upcoming", lineup_out: false });
  snap(db, mid, { at: "2026-07-14T11:59:00Z", g1: 2, g2: 1, server: "first", p1c: 60 }); // live=1, fresh
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "live", "scout confirms in-play → live");
});

test("advanceClocks tennis: a clock-phantom live match (scout silent, no position) is un-lived", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // seeded state "live"
  // no scout snapshots at all → not in-play. No open bet. kickoff in the past.
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "upcoming", "phantom dropped out of live");
});

test("advanceClocks tennis: an open position keeps a stale-scout match LIVE (never strand a bet)", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // state "live"
  R.insertBet(db, { id: "keep", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "сет 1", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "live", "position is babysat, not stranded");
});

test("advanceClocks tennis: a scout FINAL finishes a live match (no open position)", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // state "live"
  R.insertTennisSnapshot(db, { event_key: "EF", provider: "apitennis", batch_at: "2026-07-14T11:58:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Finished", sets_p1: 2, sets_p2: 0, set_num: 2, games_p1: 6, games_p2: 3, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "finished", "scout final → finished, not un-lived to upcoming");
});

test("buildTennisFunnel: reconstructs the funnel + names each live match's drop-out stage", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 80, p2price: 20 });
  // A favourite (first) broken in set 1 with the price in the buyback zone → passes the gate.
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 50, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 });
  const f = buildTennisFunnel(db);
  assert.equal(f.liveApp, 1);
  assert.equal(f.linked, 1, "the match has ≥2 mapped scout snapshots");
  assert.equal(f.withFavourite, 1);
  assert.equal(f.tradeable, 1, "book $5000 both sides ≥ $2000");
  assert.equal(f.withBreak, 1);
  assert.equal(f.favBreak, 1, "the favourite's serve was broken");
  assert.equal(f.gatePass, 1);
  assert.equal(f.perMatch[0].stage, "armed→LLM", "gate passed, no position yet → armed for the LLM");
  assert.equal(f.entriesAllTime, 0);
});

test("buildTennisFunnel: a live match with no linked scout snapshots is surfaced (no_scout_link), not dropped", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // live match, but NO tennis_snapshots for it
  const f = buildTennisFunnel(db);
  assert.equal(f.liveApp, 1);
  assert.equal(f.linked, 0, "no mapped scout snapshots → invisible to the tick");
  assert.equal(f.perMatch[0].stage, "no_scout_link", "the coverage blocker is named, not silent");
});

test("buildTennisFunnel: an underdog break is named a non-setup, not a silent skip", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 80, p2price: 20 });
  // The UNDERDOG (second) is broken → not our setup.
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 82, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 4, g2: 3, server: "first", p1c: 82, setNum: 1 });
  const f = buildTennisFunnel(db);
  assert.equal(f.linked, 1);
  assert.equal(f.favBreak, 0);
  assert.equal(f.gatePass, 0);
  assert.equal(f.perMatch[0].stage, "underdog_broken");
});

test("tennisExitTick: a position with neither trigger stays OPEN (rides on)", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertBet(db, { id: "tex3", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Price at 50¢ — above entry but below the 59 take; no new break. Hold.
  R.insertTennisSnapshot(db, { event_key: "E11", provider: "apitennis", batch_at: "2026-07-14T10:08:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1, status: "Set 2", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 4, games_p2: 3, game_points: null, server: "first", pm_match_id: mid, pm_mid_cents: 50, pm_p1_cents: 50, pm_p2_cents: 50, raw: "{}" });
  assert.equal(tennisExitTick(db, { now: () => "2026-07-14T10:08:05Z" }), 0);
  assert.equal(R.getBet(db, "tex3")!.status, "open", "held — buyback not yet recovered, thesis intact");
});

test("tennisFinalResult: a mid-match DEFAULT/disqualification resolves to the advancer (not void) — matches Polymarket", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertTennisSnapshot(db, { event_key: "ED", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Default", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 3, games_p2: 1, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  const fin = tennisFinalResult(db, mid)!;
  assert.equal(fin.finished, true);
  assert.equal(fin.retired, true, "default/DQ is classified in the advancer family, not void");
  assert.equal(fin.canceled, false);
  assert.equal(fin.advancing, "first", "Vukic advances on the opponent's default");
});

test("tennisFinalResult: a WALKOVER (pre-start withdrawal) is VOID, not an advancer win — matches Polymarket", () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertTennisSnapshot(db, { event_key: "EW", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Walkover", sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 0, games_p2: 0, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  const fin = tennisFinalResult(db, mid)!;
  assert.equal(fin.finished, true);
  assert.equal(fin.canceled, true, "walkover → void (50-50), even though a winner is named");
  assert.equal(fin.advancing, null);
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
