import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import {
  SHADOW_DEFAULTS, shadowOnEntries, shadowOnExit, shadowPoolState, sweepSettled,
  shadowAnalytics, loadShadowConfig, saveShadowConfig, shadowReplay,
  type ShadowConfig, type ShadowEntryRequest, type ReplayEntry,
} from "../src/lib/shadow.js";

const T0 = "2026-07-11T20:00:00Z";
const plusMin = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();
const cfg = (over: Partial<ShadowConfig> = {}): ShadowConfig => ({ ...SHADOW_DEFAULTS, bankTotal: 1000, ...over });
type DB = ReturnType<typeof openDb>;
const seedReserve = (db: DB, o: { size: number; isLive?: boolean; cat?: string; strat?: string; match?: string; state?: "reserved" | "settling"; settleAt?: string }) =>
  R.insertShadowReserve(db, { id: R.uid(), bet_id: R.uid(), match_id: o.match ?? R.uid(), competition_id: o.cat ?? "cat", strategy_id: o.strat ?? "strat", profile_id: "medium", size: o.size, is_live: o.isLive ? 1 : 0, edge: 0, state: o.state ?? "reserved", settle_at: o.settleAt ?? null, created_at: T0 });
const req = (o: Partial<ShadowEntryRequest> & { size: number }): ShadowEntryRequest => ({ betId: R.uid(), matchId: "M", competitionId: "cat", strategyId: "strat", profileId: "medium", edge: 0.1, isLive: false, ...o });
const last = (db: DB) => R.listShadowEvents(db, 1)[0];

test("shadow: a fill reserves capital; a close moves it to settling and it frees only after the lag", () => {
  const db = openDb(":memory:");
  const c = cfg({ settlementLagMin: 45 });
  const r = req({ betId: "b1", size: 100, edge: 0.1 });
  shadowOnEntries(db, [r], c, T0);
  let p = shadowPoolState(db, c, T0);
  assert.equal(p.reserved, 100, "reserved after the fill");
  assert.equal(p.free, 900);
  assert.equal(last(db).verdict, "allowed");
  // the config in effect is snapshotted on the event (attributable after later changes)
  assert.equal(JSON.parse(last(db).config_snapshot as string).bankTotal, 1000, "config snapshot stored per event");

  shadowOnExit(db, "b1", 1, c, T0);              // full close → settling
  p = shadowPoolState(db, c, T0);
  assert.equal(p.reserved, 0, "no longer reserved");
  assert.equal(p.settling, 100, "sits in settling");
  assert.equal(p.free, 900, "still locked (free = bank − reserved − settling)");

  assert.equal(sweepSettled(db, plusMin(T0, 44)), 0, "before the lag → not freed");
  assert.equal(shadowPoolState(db, c, plusMin(T0, 44)).settling, 100);
  assert.equal(sweepSettled(db, plusMin(T0, 46)), 1, "after the lag → freed");
  const done = shadowPoolState(db, c, plusMin(T0, 46));
  assert.equal(done.settling, 0);
  assert.equal(done.free, 1000, "capital is back");
});

test("shadow: a partial close settles only its fraction of the reserve", () => {
  const db = openDb(":memory:");
  const c = cfg();
  shadowOnEntries(db, [req({ betId: "b1", size: 100 })], c, T0);
  shadowOnExit(db, "b1", 0.4, c, T0);            // fix 40%
  const p = shadowPoolState(db, c, T0);
  assert.equal(p.reserved, 60, "60% remains reserved");
  assert.equal(p.settling, 40, "40% is settling");
});

test("shadow: BLOCK insufficient_free when the pool is fully committed", () => {
  const db = openDb(":memory:");
  const c = cfg();
  seedReserve(db, { size: 1000, cat: "x", strat: "y", match: "z" }); // bank fully used
  shadowOnEntries(db, [req({ isLive: true, size: 50 })], c, T0);
  const e = last(db);
  assert.equal(e.verdict, "blocked");
  assert.equal(e.reason, "insufficient_free");
  assert.equal(e.size_reserved, 0);
});

test("shadow: BLOCK cash_reserve — the never-spend floor is inviolable", () => {
  const db = openDb(":memory:");
  const c = cfg(); // cash floor 10% = $100
  seedReserve(db, { size: 950, cat: "x", strat: "y", match: "z" }); // free = 50 < floor
  shadowOnEntries(db, [req({ isLive: true, size: 100 })], c, T0); // live ignores buffer → floor binds
  const e = last(db);
  assert.equal(e.verdict, "blocked");
  assert.equal(e.reason, "cash_reserve");
});

test("shadow: live_buffer is reserved for LIVE entries — a prematch entry can't spend it, a live one can", () => {
  const db = openDb(":memory:");
  const c = cfg({ capMatchPct: 1, capCategoryPct: 1, capStrategyPct: 1 }); // isolate the buffer
  // 700 used (prematch) → free 300; buffer 25%·1000 = 250 held for live; cash floor 100.
  seedReserve(db, { size: 700, cat: "x", strat: "y", match: "z" });
  shadowOnEntries(db, [req({ betId: "pm", isLive: false, size: 100 })], c, T0);
  const pm = last(db);
  assert.equal(pm.verdict, "blocked");
  assert.equal(pm.reason, "live_buffer", "prematch blocked — only the live buffer remains");

  shadowOnEntries(db, [req({ betId: "lv", isLive: true, size: 100 })], c, T0);
  const lv = last(db);
  assert.equal(lv.verdict, "allowed", "a LIVE entry may dip into the buffer");
});

test("shadow: cap_match / cap_category / cap_strategy each TRIM the entry to the ceiling", () => {
  // cap_match: 20%·1000 = 200; 150 already on the match → 50 room.
  let db = openDb(":memory:"); let c = cfg();
  seedReserve(db, { size: 150, cat: "cat", strat: "strat", match: "M" });
  shadowOnEntries(db, [req({ matchId: "M", size: 100 })], c, T0);
  assert.equal(last(db).verdict, "trimmed");
  assert.equal(last(db).reason, "cap_match");
  assert.equal(last(db).size_reserved, 50);

  // cap_category: 40%·1000 = 400; 380 already in the category (spread across matches/strats) → 20 room.
  db = openDb(":memory:"); c = cfg();
  seedReserve(db, { size: 190, cat: "C", strat: "s1", match: "m1" });
  seedReserve(db, { size: 190, cat: "C", strat: "s2", match: "m2" });
  shadowOnEntries(db, [req({ competitionId: "C", strategyId: "s3", matchId: "m3", size: 100 })], c, T0);
  assert.equal(last(db).reason, "cap_category");
  assert.equal(last(db).size_reserved, 20);

  // cap_strategy: 40%·1000 = 400; 380 already on the strategy (spread) → 20 room.
  db = openDb(":memory:"); c = cfg();
  seedReserve(db, { size: 190, cat: "c1", strat: "S", match: "m1" });
  seedReserve(db, { size: 190, cat: "c2", strat: "S", match: "m2" });
  shadowOnEntries(db, [req({ competitionId: "c3", strategyId: "S", matchId: "m3", size: 100 })], c, T0);
  assert.equal(last(db).reason, "cap_strategy");
  assert.equal(last(db).size_reserved, 20);
});

test("shadow: contention — when the pool is short, higher edge is funded first (deterministic)", () => {
  const db = openDb(":memory:");
  const c = cfg({ cashReservePct: 0, liveBufferPct: 0, capMatchPct: 1, capCategoryPct: 1, capStrategyPct: 1 });
  // Two entries want $600 each but only $1000 is free — they compete THIS tick.
  const lowEdge = req({ betId: "low", size: 600, edge: 0.05 });
  const highEdge = req({ betId: "high", size: 600, edge: 0.15 });
  shadowOnEntries(db, [lowEdge, highEdge], c, T0); // batch order shouldn't matter — edge does
  const evs = R.allShadowEvents(db);
  const hi = evs.find((e) => e.bet_id === "high")!, lo = evs.find((e) => e.bet_id === "low")!;
  assert.equal(hi.verdict, "allowed", "higher edge funded in full");
  assert.equal(hi.size_reserved, 600);
  assert.equal(lo.verdict, "trimmed", "lower edge gets what's left");
  assert.equal(lo.size_reserved, 400);
  assert.equal(hi.contention, 1, "both flagged as decided amid contention");
  assert.equal(lo.contention, 1);
});

test("shadow: analytics — blocked/trimmed rates, reason tally, and missed P&L of un-funded winners", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const c = cfg();
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.listCompetitions(db).flatMap((comp) => R.listMatches(db, comp.id))[0].id;
  // A real bet that WON in the isolated sim, but the shadow pool would have blocked it.
  R.insertBet(db, { id: "won-bet", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "X", status: "settled_won", proposed_price: 40, entry_price: 40, current_price: 80, closing_price: 80, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "10'", result: "won", payout: 180, created_at: T0 });
  R.insertShadowEvent(db, { id: R.uid(), bet_id: "won-bet", match_id: mid, competition_id: "c", strategy_id: strat.id, profile_id: "medium", size_requested: 100, size_reserved: 0, verdict: "blocked", reason: "cap_category", is_live: 0, edge: 0.2, contention: 0, free_at: 10, pool_snapshot: null, created_at: T0 });
  R.insertShadowEvent(db, { id: R.uid(), bet_id: null, match_id: mid, competition_id: "c", strategy_id: strat.id, profile_id: "medium", size_requested: 50, size_reserved: 50, verdict: "allowed", reason: null, is_live: 0, edge: 0.1, contention: 0, free_at: 500, pool_snapshot: null, created_at: T0 });

  const a = shadowAnalytics(db, c);
  assert.equal(a.total, 2);
  assert.equal(a.blocked, 1);
  assert.equal(a.allowed, 1);
  assert.equal(a.blockedPct, 50);
  assert.equal(a.byReason.cap_category, 1);
  assert.equal(a.missedPnl, 80, "the blocked winner's realised P&L (180−100) is the deficit's cost");
});

test("shadow: the autoEnter hook records ONE shadow event + reserve when a real bet fills (single-source)", async () => {
  const { autoEnter } = await import("../src/lib/lifecycle.js");
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 50, ai_prob: 0.6, liquidity: "1000", external_ref: "TOKEN", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "sb", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Over 1.5", status: "proposed", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "p", entered_minute: null, result: null, payout: null, created_at: "t" });

  await autoEnter(db, { now: () => T0 }); // execution model off → fills at the quote
  assert.equal(R.getBet(db, "sb")!.status, "open", "the bet really filled in the real sim");
  const evs = R.allShadowEvents(db).filter((e) => e.bet_id === "sb");
  assert.equal(evs.length, 1, "the fill produced exactly one shadow event (single-source hook)");
  assert.equal(evs[0].verdict, "allowed", "with an empty $5000 pool the $100 fill is allowed");
  assert.equal(R.shadowReservedForBet(db, "sb")!.size, 100, "and $100 is reserved in the shadow pool");
});

test("shadow replay: a smaller bank creates deficit (edge-priority), a trimmed loser gives negative missed P&L", () => {
  const entries: ReplayEntry[] = [
    { at: "2026-07-11T20:00:00Z", size: 600, edge: 0.15, isLive: false, matchId: "m1", competitionId: "c1", strategyId: "s1", exitAt: null, realPnl: 100 },
    { at: "2026-07-11T20:00:00Z", size: 600, edge: 0.05, isLive: false, matchId: "m2", competitionId: "c1", strategyId: "s1", exitAt: null, realPnl: -50 },
  ];
  const flat = { cashReservePct: 0, liveBufferPct: 0, capMatchPct: 1, capCategoryPct: 1, capStrategyPct: 1 };
  const big = shadowReplay(entries, cfg({ bankTotal: 5000, ...flat }));
  assert.equal(big.blocked + big.trimmed, 0, "a big bank funds both in full");

  const small = shadowReplay(entries, cfg({ bankTotal: 1000, ...flat }));
  assert.equal(small.allowed, 1, "higher-edge entry funded in full");
  assert.equal(small.trimmed, 1, "lower-edge entry trimmed to the remaining $400");
  assert.ok(small.blockedPct + small.trimmedPct > 0, "the smaller bank shows a deficit");
  assert.ok(small.missedPnl < 0, "the trimmed leg was a loser → deficit AVOIDED a loss (negative missed P&L)");
});

test("shadow replay: a reserve is released after the lag, so a later entry gets the freed capital", () => {
  const entries: ReplayEntry[] = [
    { at: "2026-07-11T20:00:00Z", size: 900, edge: 0.2, isLive: false, matchId: "m1", competitionId: "c1", strategyId: "s1", exitAt: "2026-07-11T20:10:00Z", realPnl: 0 },
    { at: "2026-07-11T21:00:00Z", size: 900, edge: 0.1, isLive: false, matchId: "m2", competitionId: "c2", strategyId: "s2", exitAt: null, realPnl: 0 },
  ];
  const c = cfg({ bankTotal: 1000, cashReservePct: 0, liveBufferPct: 0, capMatchPct: 1, capCategoryPct: 1, capStrategyPct: 1, settlementLagMin: 45 });
  // entry1 reserves 900 at 20:00, closes 20:10, frees at 20:55; entry2 at 21:00 sees it freed.
  assert.equal(shadowReplay(entries, c).allowed, 2, "the freed capital funds the later entry");
  // with a longer lag the reserve is still locked at 21:00 → the later entry is trimmed.
  assert.equal(shadowReplay(entries, cfg({ ...c, settlementLagMin: 120 })).allowed, 1, "a longer lag keeps capital locked → deficit");
});

test("shadow: config precedence — defaults < env < saved app_meta (user settings win)", () => {
  const db = openDb(":memory:");
  assert.equal(loadShadowConfig(db, {}).bankTotal, 5000, "default bank");
  assert.equal(loadShadowConfig(db, { SHADOW_BANK_TOTAL: "8000" }).bankTotal, 8000, "env override");
  saveShadowConfig(db, { bankTotal: 12000 }, T0);
  assert.equal(loadShadowConfig(db, { SHADOW_BANK_TOTAL: "8000" }).bankTotal, 12000, "saved settings win over env");
});
