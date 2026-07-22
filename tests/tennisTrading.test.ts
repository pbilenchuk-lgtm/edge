import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { resolveTennisWinner } from "../src/lib/settlement.js";
import { serializeEntryMeta, parseEntryMeta } from "../src/lib/betMeta.js";
import { tennisFinalResult, settleTennisBets, chargeTennisMatch, finishTennisMatches, tennisExitTick, tennisTradingTick, tennisSetValueTick, tennisEntryMeta, pollTennisFinals } from "../src/lib/tennisTrading.js";
import { migrateTennisStrategy, migrateTennisSetValueStrategy } from "../src/lib/seed.js";
import { buildTennisCalibrationReport, tennisTourOf, collectTennisSnapshots, fetchTennisFixtures } from "../src/lib/tennisScout.js";
import { buildTennisFunnel } from "../src/lib/tennisTrading.js";
import { advanceClocks } from "../src/lib/lifecycle.js";

test("resolveTennisWinner: advances→YES, loser→NO, canceled→void, retirement→advancing wins", async () => {
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

test("migrateTennisStrategy: the tennis_overreaction strategy is seeded on boot (sport=tennis)", async () => {
  const db = openDb(":memory:");
  migrateTennisStrategy(db); // runs in getDb() on prod boot; tests invoke it directly
  const s = R.getStrategy(db, "tennis_overreaction");
  assert.ok(s, "seeded");
  assert.equal(s!.sport_id, "tennis");
  assert.ok((s!.prompt_live ?? "").length > 0, "has a live prompt");
});

function seedTennisMatch(db: ReturnType<typeof openDb>, opts: { p1: string; p2: string; p1liq?: number; p2liq?: number; p1price?: number; p2price?: number; compId?: string; compName?: string }) {
  migrateTennisStrategy(db); // FK target for tennis bets
  migrateTennisSetValueStrategy(db); // FK target for cross-strategy tests
  R.upsertSport(db, "tennis", "Теннис");
  const compId = opts.compId ?? "pm-atp";
  const compName = opts.compName ?? "ATP";
  R.upsertCompetition(db, { id: compId, sport_id: "tennis", name: compName, budget: 0, external_league: null, created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: compId, home: opts.p1, away: opts.p2, state: "live", lineup_out: true, kickoff_at: "2026-07-14T09:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // ONE moneyline market ("Tournament: A vs B", stored price = P(first-named player)); resolved
  // by structure (never a prop). The book is a single gate — thin either side thins the moneyline.
  const book = Math.min(opts.p1liq ?? 5000, opts.p2liq ?? 5000);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: `${compName}: ${opts.p1} vs ${opts.p2}`, price: opts.p1price ?? 80, ai_prob: null, liquidity: String(book), external_ref: "t1", snapshot_at: "t", is_closing: false });
  return mid;
}

test("chargeTennisMatch: identifies the favourite + gates tradeability on winner-book depth", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 78, p2price: 22, p1liq: 5000, p2liq: 5000 });
  const c = chargeTennisMatch(db, mid, { p1: "A. Vukic", p2: "L. Broady" });
  assert.equal(c.favSide, "first");
  assert.equal(c.tradeable, true);
  assert.equal(c.triggers.length, 1); // only early_break — lost_first_set moved to Set-Value
  // thin book on one side → not tradeable
  const mid2 = seedTennisMatch(db, { p1: "X Player", p2: "Y Player", p1price: 80, p2price: 20, p1liq: 5000, p2liq: 100 });
  assert.equal(chargeTennisMatch(db, mid2, { p1: "X Player", p2: "Y Player" }).tradeable, false);
});

test("chargeTennisMatch: favourite is identified from the PRE-BREAK price even when the current price panicked", async () => {
  const db = openDb(":memory:");
  // MARKET row now shows a coin-flip (the favourite's price crashed on the break) → no favourite by current price.
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 50, p2price: 50, p1liq: 5000, p2liq: 5000 });
  assert.equal(chargeTennisMatch(db, mid, { p1: "A. Vukic", p2: "L. Broady" }).favSide, null, "current 50/50 → favourite erased by the panic");
  // Pre-break price (80/20) recovers the favourite — this is what the tick now passes in.
  assert.equal(chargeTennisMatch(db, mid, { p1: "A. Vukic", p2: "L. Broady" }, { p1: 80, p2: 20 }).favSide, "first", "pre-break 80/20 → favourite = first");
});

test("tennisFinalResult + settleTennisBets: settle a paper bet from the scout's final result", async () => {
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

test("finishTennisMatches: a live app match with a Finished scout snapshot transitions to finished", async () => {
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

test("tennisExitTick: take_price realizes the buyback when the favourite recovers to the pre-break level", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // Entered the buyback at the panicked 44¢; the pre-written plan takes profit at 59¢ (pre-break 62 − 3 buffer).
  R.insertBet(db, { id: "tex1", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 1", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: { take_price: { at_cents: 59, note: "возврат минус запас" } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Scout: the favourite recovered to 60¢ (≥ the 59¢ take level).
  R.insertTennisSnapshot(db, { event_key: "E9", provider: "apitennis", batch_at: "2026-07-14T10:10:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1, status: "Set 3", sets_p1: 1, sets_p2: 1, set_num: 3, games_p1: 2, games_p2: 1, game_points: null, server: "first", pm_match_id: mid, pm_mid_cents: 60, pm_p1_cents: 60, pm_p2_cents: 40, raw: "{}" });
  const n = await tennisExitTick(db, { now: () => "2026-07-14T10:10:05Z" });
  assert.equal(n, 1, "the recovery-take fired");
  const b = R.getBet(db, "tex1")!;
  assert.equal(b.status, "settled_won");
  assert.equal(b.settled_by, "early", "booked as a trading realize, not a prediction outcome");
  assert.equal(b.closing_price, 60);
  assert.equal(b.payout, Math.round(100 * (60 / 44) * 100) / 100, "payout = stake·current/entry");
});

test("tennisExitTick: thesis_stop cuts the position on a SECOND break of the favourite (price still low)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertBet(db, { id: "tex2", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Favourite (first) serving at 3-3, gets broken → 3-4, and it persists. Price stays at 40¢ (< 59 take), so the take never fires.
  const base = { provider: "apitennis", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1 as const, status: "Set 2", sets_p1: 1, sets_p2: 1, set_num: 2, game_points: null, pm_match_id: mid, pm_mid_cents: 40, pm_p2_cents: 60, raw: "{}" };
  R.insertTennisSnapshot(db, { ...base, event_key: "E10", batch_at: "2026-07-14T10:05:00Z", games_p1: 3, games_p2: 3, server: "first", pm_p1_cents: 40 });
  R.insertTennisSnapshot(db, { ...base, event_key: "E10", batch_at: "2026-07-14T10:06:00Z", games_p1: 3, games_p2: 4, server: "second", pm_p1_cents: 40 });
  R.insertTennisSnapshot(db, { ...base, event_key: "E10", batch_at: "2026-07-14T10:07:00Z", games_p1: 3, games_p2: 4, server: "second", pm_p1_cents: 40 });
  const n = await tennisExitTick(db, { now: () => "2026-07-14T10:07:05Z" });
  assert.equal(n, 1, "thesis_stop fired on the second favourite break");
  const b = R.getBet(db, "tex2")!;
  assert.equal(b.status, "settled_lost", "40¢ < 44¢ entry → the cut books a loss");
  assert.equal(b.settled_by, "early");
  assert.equal(b.closing_price, 40);
});

test("tennisExitTick: FAIL-CLOSED — no live price never fabricates a $0 exit, warns loudly, holds the position", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // Break the moneyline resolution: a SECOND " vs " market → ambiguous → tennisMoneyline returns null,
  // so with NO priced snapshot the exit tick has no live price to act on (the Travaglia–Navone shape).
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "ATP: Aleksandar Vukic vs Liam Broady (alt)", price: 44, ai_prob: null, liquidity: "5000", external_ref: "t2", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "texfc", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Favourite (first) gets broken in set 2 — thesis_stop WOULD fire — but every snapshot is price-blind.
  const base = { provider: "apitennis", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1 as const, status: "Set 2", sets_p1: 1, sets_p2: 1, set_num: 2, game_points: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: "{}" };
  R.insertTennisSnapshot(db, { ...base, event_key: "EFC", batch_at: "2026-07-14T10:05:00Z", games_p1: 3, games_p2: 3, server: "first" });
  R.insertTennisSnapshot(db, { ...base, event_key: "EFC", batch_at: "2026-07-14T10:06:00Z", games_p1: 3, games_p2: 4, server: "second" });
  R.insertTennisSnapshot(db, { ...base, event_key: "EFC", batch_at: "2026-07-14T10:07:00Z", games_p1: 3, games_p2: 4, server: "second" });
  const n = await tennisExitTick(db, { now: () => "2026-07-14T10:07:05Z" });
  assert.equal(n, 0, "no price → NO exit fired (never a phantom $0 close at entry price)");
  const b = R.getBet(db, "texfc")!;
  assert.equal(b.status, "open", "position held to await a real price / settlement, not silently cut to breakeven");
  const warned = R.tradeLogForMatch(db, mid).filter((l) => l.type === "skip" && /цена недоступна/.test(l.text ?? ""));
  assert.equal(warned.length, 1, "price-starvation is LOUD (one warning), not silent");
  // Idempotent: a second tick must not spam a duplicate warning.
  await tennisExitTick(db, { now: () => "2026-07-14T10:07:25Z" });
  assert.equal(R.tradeLogForMatch(db, mid).filter((l) => l.type === "skip" && /цена недоступна/.test(l.text ?? "")).length, 1, "warning throttled to once per match+strategy");
});

test("tennisExitTick: a BREAKEVEN cut (exit == entry) books settled_void/result null — a PUSH, not a win", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertBet(db, { id: "texbe", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Favourite (first) broken 3-3 → 3-4 (persists) → thesis_stop fires, but the price sits EXACTLY at
  // the 44¢ entry → realized P&L is $0.00: a breakeven, which must NOT be recorded as a win.
  const base = { provider: "apitennis", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1 as const, status: "Set 2", sets_p1: 1, sets_p2: 1, set_num: 2, game_points: null, pm_match_id: mid, pm_mid_cents: 44, pm_p2_cents: 56, raw: "{}" };
  R.insertTennisSnapshot(db, { ...base, event_key: "EBE", batch_at: "2026-07-14T10:05:00Z", games_p1: 3, games_p2: 3, server: "first", pm_p1_cents: 44 });
  R.insertTennisSnapshot(db, { ...base, event_key: "EBE", batch_at: "2026-07-14T10:06:00Z", games_p1: 3, games_p2: 4, server: "second", pm_p1_cents: 44 });
  R.insertTennisSnapshot(db, { ...base, event_key: "EBE", batch_at: "2026-07-14T10:07:00Z", games_p1: 3, games_p2: 4, server: "second", pm_p1_cents: 44 });
  assert.equal(await tennisExitTick(db, { now: () => "2026-07-14T10:07:05Z" }), 1, "thesis_stop still fired");
  const b = R.getBet(db, "texbe")!;
  assert.equal(b.status, "settled_void", "breakeven → settled_void (push), not settled_won");
  assert.equal(b.result, null, "breakeven → result null, so win-rate bins exclude it");
  assert.equal(b.payout, 100, "payout == stake (money-flat)");
});

// Compact snapshot helper for the exit-order tests (one event, ATP singles, live).
function snap(db: ReturnType<typeof openDb>, mid: string, o: { at: string; g1: number; g2: number; server: "first" | "second" | null; p1c: number | null; setNum?: number }) {
  R.insertTennisSnapshot(db, { event_key: "EX", provider: "apitennis", batch_at: o.at, p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1, status: "live", sets_p1: 1, sets_p2: 0, set_num: o.setNum ?? 2, games_p1: o.g1, games_p2: o.g2, game_points: null, server: o.server, pm_match_id: mid, pm_mid_cents: o.p1c, pm_p1_cents: o.p1c, pm_p2_cents: o.p1c == null ? null : 100 - o.p1c, raw: "{}" });
}
function buybackBet(db: ReturnType<typeof openDb>, mid: string, id: string, plan: any, profile = "medium") {
  R.insertBet(db, { id, match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: profile, market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: plan }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
}
// CLOB /book → the given book; everything else 404 (exits make no LLM call).
const bookFetch = (book: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] }) =>
  (async (url: any) => String(url).includes("/book") ? ({ ok: true, status: 200, json: async () => book } as any) : ({ ok: false, status: 404, json: async () => ({}) } as any)) as unknown as typeof fetch;
// Favourite (first) broken 3-3 → 3-4 (persists) → thesis_stop. Midpoint p1c stays 42 so `cur` resolves.
const brokenSeq = (db: ReturnType<typeof openDb>, mid: string) => {
  snap(db, mid, { at: "2026-07-14T10:05:00Z", g1: 3, g2: 3, server: "first", p1c: 42 });
  snap(db, mid, { at: "2026-07-14T10:06:00Z", g1: 3, g2: 4, server: "second", p1c: 42 });
  snap(db, mid, { at: "2026-07-14T10:07:00Z", g1: 3, g2: 4, server: "second", p1c: 42 });
};
const EXIT_NOW = { now: () => "2026-07-14T10:07:05Z" };

test("tennisExitTick (book-fill-m1): protective exit SELLS into the BID (38¢), not the ask (40¢)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "sellbid", { take_price: { at_cents: 90 }, catastrophic_floor: { at_cents: 10 }, game_count_stop: { receiver_games: 9 } });
  brokenSeq(db, mid);
  const n = await tennisExitTick(db, { ...EXIT_NOW, env: { POLYMARKET_ENABLED: "true" }, fetchImpl: bookFetch({ bids: [{ price: "0.38", size: "1000" }], asks: [{ price: "0.40", size: "1000" }] }) });
  assert.equal(n, 1, "thesis_stop fired");
  const b = R.getBet(db, "sellbid")!;
  assert.ok((b.closing_price ?? 0) >= 37 && (b.closing_price ?? 0) < 39, `sold at the 38¢ BID (−fee), never the 40¢ ask — got ${b.closing_price}`);
});

test("tennisExitTick (book-fill-m1): protective exit with NO bid book → stale price, flagged exitStalePrice", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "stale1", { take_price: { at_cents: 90 }, catastrophic_floor: { at_cents: 10 }, game_count_stop: { receiver_games: 9 } });
  brokenSeq(db, mid);
  const n = await tennisExitTick(db, { ...EXIT_NOW, env: { POLYMARKET_ENABLED: "true" }, fetchImpl: bookFetch({ bids: [], asks: [] }) });
  assert.equal(n, 1, "defensive exit MUST leave even with no book (§4.5)");
  const b = R.getBet(db, "stale1")!;
  assert.ok(R.isSettled(b.status), "position closed");
  assert.equal(parseEntryMeta(b.entry_meta)?.exitStalePrice, true, "flagged as executed at a stale/modelled price");
});

test("tennisExitTick (book-fill-m1): a TAKE with no live bid is NOT fabricated — skip + hold (retry next tick)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "notake", { take_price: { at_cents: 50 }, catastrophic_floor: { at_cents: 10 }, game_count_stop: { receiver_games: 9 } });
  // favourite recovered to 55¢ (≥ take 50) with NO break → take_price would fire; but the bid book is empty.
  snap(db, mid, { at: "2026-07-14T10:05:00Z", g1: 3, g2: 3, server: "second", p1c: 55 });
  snap(db, mid, { at: "2026-07-14T10:06:00Z", g1: 4, g2: 3, server: "first", p1c: 55 });
  const n = await tennisExitTick(db, { now: () => "2026-07-14T10:06:05Z", env: { POLYMARKET_ENABLED: "true" }, fetchImpl: bookFetch({ bids: [], asks: [{ price: "0.55", size: "1000" }] }) });
  assert.equal(n, 0, "no bid → take not fabricated");
  assert.equal(R.getBet(db, "notake")!.status, "open", "position rides on, retry next tick");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /тейк отложен/.test(l.text ?? "")), "deferred-take skip logged");
});

test("tennisExitTick (book-fill-m1): protective exit on a THIN bid → partial sell + remainder attention", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "thin1", { take_price: { at_cents: 90 }, catastrophic_floor: { at_cents: 10 }, game_count_stop: { receiver_games: 9 } });
  brokenSeq(db, mid);
  // Position ≈ 227 shares (stake 100 / entry 44¢). Bid depth only 60 shares → partial fill ≈ 26%.
  const n = await tennisExitTick(db, { ...EXIT_NOW, env: { POLYMARKET_ENABLED: "true" }, fetchImpl: bookFetch({ bids: [{ price: "0.38", size: "60" }], asks: [] }) });
  assert.equal(n, 1, "partial protective exit counts as an action");
  const parent = R.getBet(db, "thin1")!;
  assert.equal(parent.status, "open", "remainder held open (never dumped below floor)");
  assert.equal(parseEntryMeta(parent.entry_meta)?.exitAttention, true, "remainder flagged attention (retry next tick)");
  const partial = R.betsForMatch(db, mid, "tennis_overreaction").find((x) => x.settled_by === "partial");
  assert.ok(partial, "a partial slice was booked at the bid");
});

test("tennis calibration: the entry plan carries the INTERIM defaults (K=3, epoch=token-fix-m1)", async () => {
  // The prop-priced 105-mark calibration was discarded (BACKLOG "price layer = the MONEYLINE"):
  // thresholds return to interim (K=3) until ~100 marks re-accumulate on the moneyline. The epoch
  // tag is now token-fix-m1 — the hard break where entries/exits transact the favourite's OWN token.
  const meta = tennisEntryMeta({ favPrice: 45, prePrice: 62, edge: 0.1, kelly: 0.2, stake: 100, thinnessUsd: 5000, setNum: 1 });
  const plan = meta.exitPlan as any;
  assert.equal(plan.game_count_stop.receiver_games, 3, "interim game-count stop");
  assert.equal(plan.armed_epoch, "token-fix-m1");
  assert.equal(plan.take_price.at_cents, 59, "pre-break 62 − 3¢ buffer (kept)");
  assert.equal(plan.catastrophic_floor.at_cents, 30, "entry 45 − 15¢ floor (held structural)");
});

test("tennisExitTick A1: game_count_stop fires after K receiving games with NO break-back", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a1", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 }, game_count_stop: { receiver_games: 2 } });
  // Favourite (first) is the receiver whenever server="second". Two opponent holds → 2 receiving games, no break-back. Price flat at 45 (no take, no floor).
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 45 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "first", p1c: 45 });  // opp held → recv #1
  snap(db, mid, { at: "2026-07-14T10:03:00Z", g1: 4, g2: 4, server: "second", p1c: 45 }); // fav held
  snap(db, mid, { at: "2026-07-14T10:04:00Z", g1: 4, g2: 5, server: "first", p1c: 45 });  // opp held → recv #2
  snap(db, mid, { at: "2026-07-14T10:05:00Z", g1: 4, g2: 5, server: "first", p1c: 45 });  // debounce confirm
  assert.equal(await tennisExitTick(db, { now: () => "2026-07-14T10:05:05Z" }), 1);
  const b = R.getBet(db, "a1")!;
  assert.equal(b.status, "settled_won", "closed at 45¢ > 44¢ entry → small win");
  assert.equal(b.closing_price, 45);
});

test("tennisExitTick A1: a BREAK-BACK (counter-break) suppresses game_count_stop — position holds", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a1b", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 }, game_count_stop: { receiver_games: 2 } });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 45 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 4, g2: 3, server: "first", p1c: 45 });  // fav BROKE opp serve → counter-break (recv #1)
  snap(db, mid, { at: "2026-07-14T10:03:00Z", g1: 5, g2: 3, server: "second", p1c: 45 }); // fav held
  snap(db, mid, { at: "2026-07-14T10:04:00Z", g1: 5, g2: 4, server: "first", p1c: 45 });  // opp held → recv #2
  snap(db, mid, { at: "2026-07-14T10:05:00Z", g1: 5, g2: 4, server: "first", p1c: 45 });  // debounce
  assert.equal(await tennisExitTick(db, { now: () => "2026-07-14T10:05:05Z" }), 0, "recovery underway (break-back) → don't stop");
  assert.equal(R.getBet(db, "a1b")!.status, "open");
});

test("tennisExitTick A2: catastrophic_floor fires only on a PERSISTENT collapse (phantom-guarded)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // floor at 29¢ (entry 44 − 15). Two consecutive snapshots ≤ 29 → confirmed collapse.
  buybackBet(db, mid, "a2", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 } });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 27 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 3, server: "second", p1c: 26 });
  assert.equal(await tennisExitTick(db, { now: () => "2026-07-14T10:02:05Z" }), 1);
  const b = R.getBet(db, "a2")!;
  assert.equal(b.status, "settled_lost");
  assert.equal(b.closing_price, 26);
});

test("tennisExitTick A2: a SINGLE spike below floor (then recovers) does NOT trigger — phantom guard", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a2b", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 } });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 45 }); // prev above floor
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 3, server: "second", p1c: 24 }); // one print below — a phantom
  assert.equal(await tennisExitTick(db, { now: () => "2026-07-14T10:02:05Z" }), 0, "single print ≤ floor is not confirmed → hold");
  assert.equal(R.getBet(db, "a2b")!.status, "open");
});

test("tennisExitTick A2: game jitter ABOVE the floor never triggers the backstop", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a2c", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 } });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "second", p1c: 36 }); // −8¢ deuce jitter
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 3, server: "second", p1c: 36 });
  assert.equal(await tennisExitTick(db, { now: () => "2026-07-14T10:02:05Z" }), 0, "±8¢ never reaches entry−15 → hold");
  assert.equal(R.getBet(db, "a2c")!.status, "open");
});

test("tennisExitTick A4: on simultaneous thesis_stop + catastrophic_floor, the THESIS (defensive, higher) wins", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  buybackBet(db, mid, "a4", { take_price: { at_cents: 59 }, catastrophic_floor: { at_cents: 29 } });
  // A second break of the favourite (server first loses) AND price collapsed ≤ floor at the same time.
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 26 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 24 }); // fav's serve broken
  snap(db, mid, { at: "2026-07-14T10:03:00Z", g1: 3, g2: 4, server: "second", p1c: 24 }); // debounce
  assert.equal(await tennisExitTick(db, { now: () => "2026-07-14T10:03:05Z" }), 1);
  const logs = R.tradeLogForMatch(db, mid).filter((l) => l.type === "exit");
  assert.ok(logs.some((l) => /thesis_stop/.test(l.text)), "thesis_stop fired");
  assert.ok(!logs.some((l) => /catastrophic_floor/.test(l.text)), "floor did NOT also fire (single close, defensive priority)");
});

test("tennisTradingTick A3: when EVERY profile already holds a buyback on the match, the break is blocked (no LLM call)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 80, p2price: 20 });
  // Hold an open buyback for EACH default profile → no free profile left → block before the LLM.
  for (const p of ["aggressive", "medium", "conservative"]) buybackBet(db, mid, "held-" + p, { take_price: { at_cents: 59 } }, p);
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 60, setNum: 1 }); // pre-break: a REAL favourite (≥52¢), so the frozen-favourite guard passes
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 });
  // No fetchImpl: if the block fails and the LLM is reached, the call throws → test surfaces it.
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { TENNIS_OVR_PARKED: "false", } });
  assert.equal(opened, 0, "all profiles held → no new buyback");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /blocked_second_buyback/.test(l.text)), "block is logged");
});

test("tennisTradingTick: one overreaction opens a bet per FREE risk profile, each on its own budget (side-by-side)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 80, p2price: 20, p1liq: 8000, p2liq: 8000 });
  // Favourite (first) at a PRE-BREAK 62¢, broken in set 1, price panics to 50¢ → real 12% edge.
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 62, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 });
  // Mock the strategist to confirm the overreaction AND report an INFLATED prob (0.70 > the 0.62
  // pre-break reference) — the §9.6 clamp must ignore the inflation and size off 0.62.
  const body = { content: [{ text: JSON.stringify({ picks: [{ label: "Aleksandar Vukic", prob: 0.7, reason: "выкуп переоценки" }] }) }] };
  let llmCalls = 0;
  const fetchImpl = (async () => { llmCalls++; return { ok: true, status: 200, json: async () => body }; }) as unknown as typeof fetch;
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { TENNIS_OVR_PARKED: "false",  ANTHROPIC_API_KEY: "k" }, fetchImpl });
  assert.equal(llmCalls, 1, "the real_shift question is asked ONCE, not per profile (Model-A dedup)");
  assert.equal(opened, 3, "one bet per default profile (aggressive/medium/conservative)");
  const bets = R.betsForMatch(db, mid, "tennis_overreaction").filter((b) => b.status === "open");
  assert.deepEqual([...new Set(bets.map((b) => b.risk_profile_id))].sort(), ["aggressive", "conservative", "medium"], "distinct profiles, side-by-side");
  assert.ok(bets.every((b) => b.ai_prob === 0.62), "§9.6: the LLM's inflated 0.70 was clamped to the armed pre-break 0.62 — no self-attributed edge");
});

test("tennisTradingTick PARKED (default): a would-be buyback places NO entry — Overreaction is no_go (ovr_cohort)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 80, p2price: 20, p1liq: 8000, p2liq: 8000 });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 62, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 });
  let llmCalls = 0;
  const fetchImpl = (async () => { llmCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "Aleksandar Vukic", prob: 0.7, reason: "выкуп" }] }) }] }) }; }) as unknown as typeof fetch;
  // Default env (no TENNIS_OVR_PARKED) → parked → NO entry, and the strategist is never even asked.
  const parked = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { ANTHROPIC_API_KEY: "k" }, fetchImpl });
  assert.equal(parked, 0, "parked → zero entries");
  assert.equal(llmCalls, 0, "parked short-circuits before any strategist call");
  assert.equal(R.betsForMatch(db, mid, "tennis_overreaction").filter((b) => b.status === "open").length, 0, "no open buyback");
  // The SAME break with the park flag off still trades — the entry machinery is intact, only gated.
  const live = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { TENNIS_OVR_PARKED: "false", ANTHROPIC_API_KEY: "k" }, fetchImpl });
  assert.ok(live > 0, "with the park flag off, the same setup enters (machinery intact)");
});

test("tennisTradingTick G: a transient strategist failure does NOT burn the break — next tick retries and enters", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 80, p2price: 20, p1liq: 8000, p2liq: 8000 });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 62, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 });
  // Tick 1: strategist fails (500) → no entry, and the break's ACTED marker must NOT be set.
  const failFetch = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch;
  assert.equal(await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { TENNIS_OVR_PARKED: "false",  ANTHROPIC_API_KEY: "k" }, fetchImpl: failFetch }), 0, "transient failure → no entry");
  // Tick 2: strategist recovers → the SAME break is retried and entered (proves the marker was not burned).
  const okBody = { content: [{ text: JSON.stringify({ picks: [{ label: "Aleksandar Vukic", prob: 0.6, reason: "выкуп" }] }) }] };
  const okFetch = (async () => ({ ok: true, status: 200, json: async () => okBody })) as unknown as typeof fetch;
  const opened2 = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:15Z", env: { TENNIS_OVR_PARKED: "false",  ANTHROPIC_API_KEY: "k" }, fetchImpl: okFetch });
  assert.ok(opened2 >= 1, "the transient failure did not permanently skip the break — retry entered");
});

test("tennisSetValueTick F: a transient strategist failure does NOT burn the match's Set-Value shot", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 67, p2price: 33, p1liq: 8000, p2liq: 8000 });
  const base = { provider: "apitennis", p1: "A. Vukic", p2: "L. Broady", tournament: "ATP Granby", event_type: "ATP Singles", live: 1 as const, game_points: null, pm_match_id: mid, pm_mid_cents: null, raw: "{}" };
  // START → favourite = first (67¢). Then first LOSES set 1 (sets 0-1), price drops into the 30-45 band.
  R.insertTennisSnapshot(db, { ...base, event_key: "SV", batch_at: "2026-07-14T10:00:00Z", status: "Set 1", sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 2, games_p2: 1, server: "first", pm_p1_cents: 67, pm_p2_cents: 33 });
  R.insertTennisSnapshot(db, { ...base, event_key: "SV", batch_at: "2026-07-14T10:40:00Z", status: "Set 2", sets_p1: 0, sets_p2: 1, set_num: 2, games_p1: 3, games_p2: 2, server: "first", pm_p1_cents: 39, pm_p2_cents: 61 });
  const failFetch = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch;
  assert.equal(await tennisSetValueTick(db, { now: () => "2026-07-14T10:40:05Z", env: { ANTHROPIC_API_KEY: "k", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: failFetch }), 0, "transient failure → no entry");
  const okBody = { content: [{ text: JSON.stringify({ picks: [{ label: "Aleksandar Vukic", prob: 0.5, reason: "конкурентный сет" }] }) }] };
  const okFetch = (async () => ({ ok: true, status: 200, json: async () => okBody })) as unknown as typeof fetch;
  const opened2 = await tennisSetValueTick(db, { now: () => "2026-07-14T10:40:15Z", env: { ANTHROPIC_API_KEY: "k", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: okFetch });
  assert.ok(opened2 >= 1, "the match's Set-Value shot survived the transient failure — retry entered");
});

test("Part B buildTennisCalibrationReport: splits marks into recovery vs no-recovery", async () => {
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

test("advanceClocks tennis: kickoff passed but NO scout data → stays upcoming (no clock-phantom live)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.updateMatch(db, mid, { state: "upcoming", lineup_out: false }); // reset from seed's "live"
  // kickoff is in the past; a football match would flip to live here. Tennis must NOT (no scout).
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "upcoming", "the clock never fabricates tennis live");
});

test("advanceClocks tennis: a FRESH in-play scout snapshot flips the match to live", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.updateMatch(db, mid, { state: "upcoming", lineup_out: false });
  snap(db, mid, { at: "2026-07-14T11:59:00Z", g1: 2, g2: 1, server: "first", p1c: 60 }); // live=1, fresh
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "live", "scout confirms in-play → live");
});

test("advanceClocks tennis: a clock-phantom live match (scout silent, no position) is un-lived", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // seeded state "live"
  // no scout snapshots at all → not in-play. No open bet. kickoff in the past.
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "upcoming", "phantom dropped out of live");
});

test("advanceClocks tennis: an open position keeps a stale-scout match LIVE (never strand a bet)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // state "live"
  R.insertBet(db, { id: "keep", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "сет 1", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "live", "position is babysat, not stranded");
});

test("advanceClocks tennis: a scout FINAL finishes a live match (no open position)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // state "live"
  R.insertTennisSnapshot(db, { event_key: "EF", provider: "apitennis", batch_at: "2026-07-14T11:58:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Finished", sets_p1: 2, sets_p2: 0, set_num: 2, games_p1: 6, games_p2: 3, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  advanceClocks(db, { now: () => "2026-07-14T12:00:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "finished", "scout final → finished, not un-lived to upcoming");
});

test("buildTennisFunnel: reconstructs the funnel + names each live match's drop-out stage", async () => {
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

test("buildTennisFunnel: a live match with no linked scout snapshots is surfaced (no_scout_link), not dropped", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // live match, but NO tennis_snapshots for it
  const f = buildTennisFunnel(db);
  assert.equal(f.liveApp, 1);
  assert.equal(f.linked, 0, "no mapped scout snapshots → invisible to the tick");
  assert.equal(f.perMatch[0].stage, "no_scout_link", "the coverage blocker is named, not silent");
});

test("buildTennisFunnel: an underdog break is named a non-setup, not a silent skip", async () => {
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

test("tennisExitTick: a position with neither trigger stays OPEN (rides on)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertBet(db, { id: "tex3", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 44, entry_price: 44, current_price: 44, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Price at 50¢ — above entry but below the 59 take; no new break. Hold.
  R.insertTennisSnapshot(db, { event_key: "E11", provider: "apitennis", batch_at: "2026-07-14T10:08:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1, status: "Set 2", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 4, games_p2: 3, game_points: null, server: "first", pm_match_id: mid, pm_mid_cents: 50, pm_p1_cents: 50, pm_p2_cents: 50, raw: "{}" });
  assert.equal(await tennisExitTick(db, { now: () => "2026-07-14T10:08:05Z" }), 0);
  assert.equal(R.getBet(db, "tex3")!.status, "open", "held — buyback not yet recovered, thesis intact");
});

test("tennisFinalResult: a mid-match DEFAULT/disqualification resolves to the advancer (not void) — matches Polymarket", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertTennisSnapshot(db, { event_key: "ED", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Default", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 3, games_p2: 1, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  const fin = tennisFinalResult(db, mid)!;
  assert.equal(fin.finished, true);
  assert.equal(fin.retired, true, "default/DQ is classified in the advancer family, not void");
  assert.equal(fin.canceled, false);
  assert.equal(fin.advancing, "first", "Vukic advances on the opponent's default");
});

test("tennisFinalResult: a WALKOVER (pre-start withdrawal) is VOID, not an advancer win — matches Polymarket", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertTennisSnapshot(db, { event_key: "EW", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Walkover", sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 0, games_p2: 0, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  const fin = tennisFinalResult(db, mid)!;
  assert.equal(fin.finished, true);
  assert.equal(fin.canceled, true, "walkover → void (50-50), even though a winner is named");
  assert.equal(fin.advancing, null);
});

test("tennisTourOf: ATP/WTA singles in scope; ITF / Challenger / doubles out (shared by every tennis strategy)", async () => {
  assert.equal(tennisTourOf({ id: "pm-atp", name: "ATP" }), "atp");
  assert.equal(tennisTourOf({ id: "pm-wta", name: "WTA" }), "wta");
  assert.equal(tennisTourOf({ id: "pm-itf", name: "ITF Sao Paulo" }), null, "ITF out of scope");
  assert.equal(tennisTourOf({ id: "x", name: "ATP Challenger Lima" }), null, "Challenger out of scope");
  assert.equal(tennisTourOf({ id: "pm-atp", name: "ATP Doubles" }), null, "doubles out of scope");
  assert.equal(tennisTourOf({ id: "x", name: "Some Exhibition" }), null, "unknown tour → skip");
  // Women's second tier is named by prize level ("125"), not "challenger" — must be excluded by number.
  assert.equal(tennisTourOf({ id: "x", name: "WTA 125 Contrexeville" }), null, "WTA 125 out of scope");
  assert.equal(tennisTourOf({ id: "x", name: "WTA125 Reus", external_league: "wta 125" }), null, "WTA125 (no space) out of scope");
  assert.equal(tennisTourOf({ id: "x", name: "ATP 125 Challenger" }), null, "ATP 125 out of scope");
  assert.equal(tennisTourOf({ id: "x", name: "WTA Qualifying Rome" }), null, "qualifying out of scope");
  // Main-tour prize tiers (250/500/1000) stay in scope — the number filter is 125-specific.
  assert.equal(tennisTourOf({ id: "x", name: "ATP 250 Adelaide" }), "atp", "ATP 250 main-tour in scope");
  assert.equal(tennisTourOf({ id: "x", name: "WTA 1000 Miami" }), "wta", "WTA 1000 main-tour in scope");
});

test("tennisTradingTick: an ITF match is NOT traded (tour scope — favourite-reversion thesis invalid there)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "I. Barrera", p2: "M. Reasco", p1price: 80, p2price: 20, compId: "pm-itf", compName: "ITF Sao Paulo" });
  // A textbook favourite-broken-in-set-1 setup — the ONLY reason it doesn't trade is the ITF scope gate.
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 50, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 });
  const fetchImpl = (async () => { throw new Error("LLM must not be reached for an out-of-scope ITF match"); }) as unknown as typeof fetch;
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { TENNIS_OVR_PARKED: "false",  ANTHROPIC_API_KEY: "k" }, fetchImpl });
  assert.equal(opened, 0, "ITF is out of scope → no entry");
  assert.equal(R.betsForMatch(db, mid, "tennis_overreaction").length, 0, "no bet created for the ITF match");
  // Single-source: the scope decision lives in chargeTennisMatch (charge.outOfScope / tradeable=false).
  const charge = chargeTennisMatch(db, mid, { p1: "I. Barrera", p2: "M. Reasco" });
  assert.equal(charge.outOfScope, true);
  assert.equal(charge.tradeable, false, "an out-of-scope comp is never tradeable, for ANY strategy");
  // …and the funnel names it distinctly (not mislabelled thin_book).
  assert.equal(buildTennisFunnel(db).perMatch[0].stage, "out_of_scope");
});

test("tennisTradingTick BUG-1 flip: after the pre-match favourite loses set 1, the opponent's set-2 break is an UNDERDOG break (no favourite flip)", async () => {
  const db = openDb(":memory:");
  // Pre-match favourite = FIRST (67¢). First then LOSES set 1; the market flips SECOND to 69¢.
  const mid = seedTennisMatch(db, { p1: "I. Barrera", p2: "M. Reasco", p1price: 67, p2price: 33 });
  const base = { provider: "apitennis", p1: "I. Barrera", p2: "M. Reasco", tournament: "ATP Granby", event_type: "ATP Singles", live: 1 as const, game_points: null, pm_match_id: mid, pm_mid_cents: null, raw: "{}" };
  // START snapshot (set 1): pm_p1=67 → startPrices anchors the favourite to FIRST (the pre-match favourite).
  R.insertTennisSnapshot(db, { ...base, event_key: "F", batch_at: "2026-07-14T10:00:00Z", status: "Set 1", sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 2, games_p2: 1, server: "first", pm_p1_cents: 67, pm_p2_cents: 33 });
  // Set 2: FIRST lost set 1 (sets 0-1); SECOND is now the market-favourite (69¢), serving at 3-3…
  R.insertTennisSnapshot(db, { ...base, event_key: "F", batch_at: "2026-07-14T10:30:00Z", status: "Set 2", sets_p1: 0, sets_p2: 1, set_num: 2, games_p1: 3, games_p2: 3, server: "second", pm_p1_cents: 31, pm_p2_cents: 69 });
  // …and SECOND's serve is broken (game to first → 4-3, server flips to first). br.server = second.
  R.insertTennisSnapshot(db, { ...base, event_key: "F", batch_at: "2026-07-14T10:31:00Z", status: "Set 2", sets_p1: 0, sets_p2: 1, set_num: 2, games_p1: 4, games_p2: 3, server: "first", pm_p1_cents: 38, pm_p2_cents: 62 });
  const f = buildTennisFunnel(db);
  assert.equal(f.withFavourite, 1, "favourite still identified (first, from the START price — not the flipped current price)");
  assert.equal(f.favBreak, 0, "the broken side (second, the set-1 WINNER) is the underdog — NOT a favourite buyback");
  assert.equal(f.gatePass, 0, "no phantom buyback armed on the flip");
  assert.equal(f.perMatch[0].stage, "underdog_broken");
});

test("tennisTradingTick BUG-3: cross-strategy block is symmetric — Overreaction does NOT stack on an open Set-Value position", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady", p1price: 80, p2price: 20 });
  // Set-Value already holds an open position on EACH profile (favourite bought back after losing set 1).
  for (const p of ["aggressive", "medium", "conservative"]) {
    R.insertBet(db, { id: "sv-" + p, match_id: mid, strategy_id: "tennis_set_value", risk_profile_id: p, market_label: "Aleksandar Vukic", status: "open", proposed_price: 39, entry_price: 39, current_price: 39, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "set-value", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  }
  // A fresh favourite break that WOULD arm Overreaction if the cross-strategy block were absent.
  snap(db, mid, { at: "2026-07-14T10:01:00Z", g1: 3, g2: 3, server: "first", p1c: 60, setNum: 1 }); // pre-break: a REAL favourite (≥52¢) so the frozen-favourite guard passes
  snap(db, mid, { at: "2026-07-14T10:02:00Z", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 });
  const fetchImpl = (async () => { throw new Error("LLM must not be reached — a Set-Value hold should block Overreaction"); }) as unknown as typeof fetch;
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { TENNIS_OVR_PARKED: "false",  ANTHROPIC_API_KEY: "k" }, fetchImpl });
  assert.equal(opened, 0, "every profile holds a Set-Value position → Overreaction is blocked (no opposite-side double exposure)");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /blocked_second_buyback/.test(l.text)), "the cross-strategy block is logged");
});

test("tennisFinalResult B: a retirement with NO event_winner is MANUAL — never guess the advancer from set count", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // Vukic LEADS 1-0 in sets, then retires (injury while ahead). No event_winner in raw.
  R.insertTennisSnapshot(db, { event_key: "R", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Retired", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 3, games_p2: 1, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: "{}" });
  const fin = tennisFinalResult(db, mid)!;
  assert.equal(fin.finished, true); assert.equal(fin.retired, true);
  assert.equal(fin.manual, true, "no event_winner on a retirement → manual (the leader often IS the retiree)");
  assert.equal(fin.advancing, null, "never a set-count guess for a retirement");
});

test("tennisFinalResult B: leader retires but event_winner names the ADVANCER → correct, not inverted", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // Vukic leads 1-0 but retires; Broady (Second Player) advances — event_winner is authoritative.
  R.insertTennisSnapshot(db, { event_key: "R2", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Retired", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 3, games_p2: 1, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "Second Player" }) });
  const fin = tennisFinalResult(db, mid)!;
  assert.equal(fin.advancing, "second", "Broady advances though Vukic led on sets — event_winner rules");
  assert.equal(fin.manual, false);
});

test("tennisFinalResult B: event_winner that DISAGREES with a decisive set score → MANUAL (trust neither)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertTennisSnapshot(db, { event_key: "R3", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Finished", sets_p1: 0, sets_p2: 2, set_num: 2, games_p1: 3, games_p2: 6, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  const fin = tennisFinalResult(db, mid)!;
  assert.equal(fin.manual, true, "winner=first but sets 0-2 → contradiction → manual");
});

test("settleTennisBets B: a manual (winner-unknown) match flags the bet and leaves it OPEN — no guess", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertTennisSnapshot(db, { event_key: "R4", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Retired", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 3, games_p2: 1, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: "{}" });
  R.insertBet(db, { id: "mb", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Aleksandar Vukic", status: "open", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e5", created_at: "t" } as any);
  assert.equal(settleTennisBets(db, { now: () => "2026-07-14T13:00:00Z" }), 0, "manual → nothing settled");
  assert.equal(R.getBet(db, "mb")!.status, "open", "left open for manual review (capital honestly still committed)");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /РУЧНОЙ РАЗБОР/.test(l.text)), "loud manual-review log emitted");
});

test("pollTennisFinals A: a stranded open position is settled from get_fixtures (finished match dropped from the live feed)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // state 'live'
  // Last LIVE snapshot is ~2h stale; match never got a terminal row (it just vanished from live).
  R.insertTennisSnapshot(db, { event_key: "EV99", provider: "apitennis", batch_at: "2026-07-14T10:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1, status: "Set 2", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 4, games_p2: 3, game_points: null, server: "first", pm_match_id: mid, pm_mid_cents: 60, pm_p1_cents: 60, pm_p2_cents: 40, raw: "{}" });
  buybackBet(db, mid, "sb", { take_price: { at_cents: 59 } }); // open Overreaction bet on Vukic
  assert.ok(tennisFinalResult(db, mid) == null || !tennisFinalResult(db, mid)!.finished, "not finished before the poll");
  // Mock get_fixtures: EV99 finished, Vukic (First Player) won 6-4 6-3.
  const fixturesBody = { result: [{ event_key: "EV99", event_first_player: "A. Vukic", event_second_player: "L. Broady", tournament_name: "Granby", event_type_type: "ATP Singles", event_live: "0", event_status: "Finished", event_final_result: "2 - 0", event_winner: "First Player", scores: [{ score_set: 1, score_first: 6, score_second: 4 }, { score_set: 2, score_first: 6, score_second: 3 }], event_serve: null, event_game_result: null }] };
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => fixturesBody, text: async () => JSON.stringify(fixturesBody) })) as unknown as typeof fetch;
  const now = () => "2026-07-14T12:00:00Z";
  const written = await pollTennisFinals(db, { now, env: { API_TENNIS_KEY: "k" }, fetchImpl });
  assert.equal(written, 1, "terminal snapshot written from fixtures for the stranded match");
  assert.equal(tennisFinalResult(db, mid)!.finished, true, "now finished (advancer = first)");
  assert.equal(settleTennisBets(db, { now }), 1, "the settle path picks up the fixtures-written terminal snapshot");
  assert.equal(R.getBet(db, "sb")!.status, "settled_won", "Vukic (bet side) won 2-0 → settled won end-to-end");
});

test("pollTennisFinals A: a fresh (recently-live) match is NOT chased — only stale strays trigger the poll", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  R.insertTennisSnapshot(db, { event_key: "EVf", provider: "apitennis", batch_at: "2026-07-14T11:58:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 1, status: "Set 2", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 4, games_p2: 3, game_points: null, server: "first", pm_match_id: mid, pm_mid_cents: 60, pm_p1_cents: 60, pm_p2_cents: 40, raw: "{}" });
  buybackBet(db, mid, "fb", { take_price: { at_cents: 59 } });
  let called = 0;
  const fetchImpl = (async () => { called++; return { ok: true, status: 200, json: async () => ({ result: [] }) }; }) as unknown as typeof fetch;
  const written = await pollTennisFinals(db, { now: () => "2026-07-14T12:00:00Z", env: { API_TENNIS_KEY: "k" }, fetchImpl }); // only 2min stale
  assert.equal(written, 0);
  assert.equal(called, 0, "a fresh snapshot (2min) is not stranded → no fixtures call");
});

test("pollTennisFinals: a match STUCK live past the ceiling (FRESH feed) is still resolved from get_fixtures (the 300' phantom)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // kickoff 09:00, state 'live'
  // A FRESH live snapshot (5min old) but 235min since kickoff — a stuck/looping feed, not a real match.
  snap(db, mid, { at: "2026-07-14T12:55:00Z", g1: 5, g2: 4, server: "first", p1c: 60 });
  const fixturesBody = { result: [{ event_key: "EX", event_first_player: "A. Vukic", event_second_player: "L. Broady", tournament_name: "Granby", event_type_type: "ATP Singles", event_live: "0", event_status: "Finished", event_final_result: "2 - 0", event_winner: "First Player", scores: [{ score_set: 1, score_first: 6, score_second: 4 }, { score_set: 2, score_first: 7, score_second: 5 }], event_serve: null, event_game_result: null }] };
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => fixturesBody, text: async () => JSON.stringify(fixturesBody) })) as unknown as typeof fetch;
  const written = await pollTennisFinals(db, { now: () => "2026-07-14T13:00:00Z", env: { API_TENNIS_KEY: "k" }, fetchImpl });
  assert.equal(written, 1, "past the 200min ceiling → get_fixtures polled despite a fresh snapshot");
  assert.equal(tennisFinalResult(db, mid)!.finished, true, "resolved to finished from the fixtures result");
});

test("fetchTennisFixtures OOM guard: an over-cap payload is skipped (never parsed) + wantedKeys bounds retention", async () => {
  const cfg = { enabled: true, key: "k", base: "https://x/", timeoutMs: 8000 } as any;
  // A body larger than the 6MB cap must be dropped WITHOUT JSON.parse (the OOM cause on a 512MB box).
  const huge = "x".repeat(6_000_001);
  const hugeFetch = (async () => ({ ok: true, status: 200, text: async () => huge })) as unknown as typeof fetch;
  assert.deepEqual(await fetchTennisFixtures(cfg, "2026-07-14", "2026-07-14", { fetchImpl: hugeFetch }), [], "over-cap payload skipped, not parsed");
  // wantedKeys returns ONLY the requested event_key (retention bounded to what we asked for).
  const body = { result: [
    { event_key: "A", event_first_player: "a", event_second_player: "b", event_live: "0", event_status: "Finished", scores: [] },
    { event_key: "B", event_first_player: "c", event_second_player: "d", event_live: "0", event_status: "Finished", scores: [] },
  ] };
  const okFetch = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })) as unknown as typeof fetch;
  const res = await fetchTennisFixtures(cfg, "2026-07-14", "2026-07-14", { fetchImpl: okFetch }, new Set(["A"]));
  assert.equal(res.length, 1); assert.equal(res[0].eventKey, "A");
});

test("advanceClocks tennis: a no-bet match stuck live past the ceiling is FINISHED (bounds the phantom 300')", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" }); // kickoff 09:00, state 'live'
  snap(db, mid, { at: "2026-07-14T14:25:00Z", g1: 5, g2: 4, server: "first", p1c: 60 }); // fresh live=1 (scout stuck)
  advanceClocks(db, { now: () => "2026-07-14T14:30:00Z" }); // 330min since kickoff > 300 ceiling, no open bet
  assert.equal(R.getMatch(db, mid)!.state, "finished", "stuck-live no-bet match force-finished");
});

test("advanceClocks tennis: a match with an OPEN bet stuck live past the ceiling is NOT force-finished (poller owns money)", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  snap(db, mid, { at: "2026-07-14T14:25:00Z", g1: 5, g2: 4, server: "first", p1c: 60 });
  buybackBet(db, mid, "hold", { take_price: { at_cents: 59 } }); // open position
  advanceClocks(db, { now: () => "2026-07-14T14:30:00Z" });
  assert.equal(R.getMatch(db, mid)!.state, "live", "a position is never mis-finished on a feed glitch — the fixtures poller resolves it");
});

test("collectTennisSnapshots #3: a terminal transition row (live=0 Finished) is KEPT, not dropped by the live filter", async () => {
  const db = openDb(":memory:");
  const body = { result: [
    { event_key: "T1", event_first_player: "A One", event_second_player: "B Two", tournament_name: "ATP X", event_type_type: "ATP Singles", event_live: "0", event_status: "Finished", event_final_result: "2 - 0", scores: [{ score_set: 1, score_first: 6, score_second: 4 }], event_serve: null, event_game_result: null },
    { event_key: "T2", event_first_player: "C Three", event_second_player: "D Four", tournament_name: "ATP X", event_type_type: "ATP Singles", event_live: "0", event_status: "Set 2", scores: [{ score_set: 2, score_first: 3, score_second: 2 }], event_serve: "First Player", event_game_result: null },
  ] };
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
  const written = await collectTennisSnapshots(db, { now: () => "2026-07-14T12:00:00Z", env: { API_TENNIS_KEY: "k" }, fetchImpl });
  assert.equal(written, 1, "the terminal Finished row (T1) is kept; the non-terminal live=0 row (T2) is still dropped");
});

test("capTennisSnapshots: hard row-cap keeps the newest N (prevents the 1.2GB bloat)", async () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "tennis", "Теннис");
  for (let i = 0; i < 25; i++) R.insertTennisSnapshot(db, { event_key: "E", provider: "p", batch_at: `2026-07-14T00:${String(i).padStart(2, "0")}:00Z`, p1: "a", p2: "b", tournament: null, event_type: null, live: 1, status: null, sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 0, games_p2: 0, game_points: null, server: null, pm_match_id: "m", pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: "{}" });
  assert.equal(R.capTennisSnapshots(db, 10), 15, "dropped the oldest 15");
  assert.equal(R.tennisSnapshotCount(db), 10, "newest 10 kept");
  assert.equal(R.capTennisSnapshots(db, 10), 0, "idempotent — already at cap");
});

test("settleTennisBets: a retirement resolves to the advancing (non-retiring) player", async () => {
  const db = openDb(":memory:");
  const mid = seedTennisMatch(db, { p1: "Aleksandar Vukic", p2: "Liam Broady" });
  // Broady retired → Vukic (First Player) advances.
  R.insertTennisSnapshot(db, { event_key: "E2", provider: "apitennis", batch_at: "2026-07-14T11:00:00Z", p1: "A. Vukic", p2: "L. Broady", tournament: "Granby", event_type: "ATP Singles", live: 0, status: "Retired", sets_p1: 1, sets_p2: 0, set_num: 2, games_p1: 3, games_p2: 1, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "First Player" }) });
  R.insertBet(db, { id: "tb2", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Liam Broady", status: "open", proposed_price: 40, entry_price: 40, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e5", created_at: "t" } as any);
  settleTennisBets(db, { now: () => "2026-07-14T13:00:00Z" });
  const b = R.getBet(db, "tb2")!;
  assert.equal(b.status, "settled_lost", "the Broady bet loses — Vukic advanced on retirement");
});
