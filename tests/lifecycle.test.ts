import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { exitDecision, winsOnEventOccurrence } from "../src/lib/thresholds.js";
import { autoEnter, evaluateExits, autoAnalyze, autoRunStrategists, strategistReassess, advanceClocks, runLiveCycle, recordMatchStats, formatMatchStats } from "../src/lib/lifecycle.js";
import { analyzeMatch, runStrategists } from "../src/lib/analysis.js";
import type { SportsProvider, MatchDetail } from "../src/lib/sports.js";

const mockLLM = (a: unknown) => (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(a) }] }) })) as any;

test("exitDecision: take-profit, stop, edge-gone, hold", () => {
  const P = { takeProfit: 0.5, exitStop: 0.5 };
  assert.equal(exitDecision({ params: P, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 80 }).exit, true); // +60% -> TP
  assert.match(exitDecision({ params: P, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 80 }).reason, /тейк/);
  assert.match(exitDecision({ params: P, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 20 }).reason, /стоп/); // -60%
  assert.match(exitDecision({ params: P, aiProb: 0.4, entryPriceCents: 50, currentPriceCents: 60 }).reason, /край/); // edge gone
  assert.equal(exitDecision({ params: P, aiProb: 0.8, entryPriceCents: 50, currentPriceCents: 55 }).exit, false); // hold
  // edgeExit:false disables the "edge gone" auto-exit (strategist manages exits),
  // but take-profit and hard stop still fire — no in-match churn on a dip.
  const NE = { takeProfit: 0.5, exitStop: 0.5, edgeExit: false };
  assert.equal(exitDecision({ params: NE, aiProb: 0.4, entryPriceCents: 50, currentPriceCents: 60 }).exit, false); // edge gone → held
  assert.equal(exitDecision({ params: NE, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 80 }).exit, true);  // TP still fires
  assert.equal(exitDecision({ params: NE, aiProb: 0.9, entryPriceCents: 50, currentPriceCents: 20 }).exit, true);  // stop still fires
});

test("autoEnter fills proposed bets at the current price", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // m-lineup is seeded with proposed bets + priced markets
  const proposedBefore = R.betsForMatch(db, "m-lineup").filter((b) => b.status === "proposed");
  assert.ok(proposedBefore.length > 0);
  const filled = await autoEnter(db, { now: () => "t" });
  assert.ok(filled.length >= proposedBefore.length);
  const b = R.betsForMatch(db, "m-lineup").find((x) => x.id === proposedBefore[0].id)!;
  assert.equal(b.status, "open");
  assert.ok(b.entry_price != null && b.entry_price > 0);
  assert.ok(R.tradeLogForMatch(db, "m-lineup").some((l) => l.type === "enter"));
});

test("autoEnter holds a football bet until lineups are out (no pre-lineup entry)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "pl-1", match_id: mid, strategy_id: strat.id, market_label: "Over 2.5", status: "proposed", proposed_price: 55, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: null, result: null, payout: null, settled_by: null, created_at: "t" });
  await autoEnter(db, { now: () => "t" });
  assert.equal(R.getBet(db, "pl-1")!.status, "proposed", "held as a preview before lineups are out");
  // Lineups out = the provider confirmed the fixture (live coverage) — required
  // before any capital is deployed.
  R.updateMatch(db, mid, { lineup_out: true });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: JSON.stringify({ team: "A", formation: "4-4-2", starters: ["x"] }), away_lineup: null, stats: null, updated_at: "t" });
  await autoEnter(db, { now: () => "t" });
  assert.equal(R.getBet(db, "pl-1")!.status, "open", "enters once lineups are out");
});

test("autoEnter refuses to open a position on a match with no live data (blind = bleed)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  // "live" only by the clock: no provider minute, no match_live, no real events.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "2026-07-06T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "nd-1", match_id: mid, strategy_id: strat.id, market_label: "Over 2.5", status: "proposed", proposed_price: 55, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: null, result: null, payout: null, settled_by: null, created_at: "t" });

  await autoEnter(db, { now: () => "t" });
  assert.equal(R.getBet(db, "nd-1")!.status, "proposed", "no live data → held, not filled");
  // once the provider drives a real minute, coverage exists → it can fill
  R.updateMatch(db, mid, { minute: 30 });
  await autoEnter(db, { now: () => "t" });
  assert.equal(R.getBet(db, "nd-1")!.status, "open", "fills once live data is present");
});

test("autoEnter: clock-flipped LIVE match with only a lineup match_live (provider still 'pre') does NOT fill", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  // The Orlando–Kansas case: our clock flipped it to "live", but ESPN still shows
  // "pre" 28min in — frozen at 0', no events. Crucially ESPN wrote a ZEROS stats
  // object, so a naive `stats != null` check would false-positive: it must NOT.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Orlando", away: "Kansas", state: "live", lineup_out: true, kickoff_at: "2026-07-11T00:00:00Z", minute: null, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "usa.nwsl", home_lineup: JSON.stringify({ team: "Orlando", formation: "4-3-3", starters: ["x"] }), away_lineup: JSON.stringify({ team: "Kansas", formation: "4-4-2", starters: ["y"] }), stats: JSON.stringify({ home: { shots: 0 }, away: { shots: 0 } }), updated_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "op-1", match_id: mid, strategy_id: strat.id, market_label: "Over 2.5", status: "proposed", proposed_price: 55, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: null, result: null, payout: null, settled_by: null, created_at: "t" });

  await autoEnter(db, { now: () => "t" });
  assert.equal(R.getBet(db, "op-1")!.status, "proposed", "lineup-only match_live on a 'live' match ≠ live delivery → held, not filled");
  // Provider starts delivering (a real minute) → now it fills.
  R.updateMatch(db, mid, { minute: 12 });
  await autoEnter(db, { now: () => "t" });
  assert.equal(R.getBet(db, "op-1")!.status, "open", "fills once the provider drives a real minute");
});

test("autoEnter executes against the order book — VWAP fill + depth cap on a thin book", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 40, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" }); // live coverage
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 47, ai_prob: 0.55, liquidity: "1000", external_ref: "TOKEN", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "bk-1", match_id: mid, strategy_id: strat.id, market_label: "Over 1.5", status: "proposed", proposed_price: 47, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.55, stake: 500, rationale: null, entered_minute: null, result: null, payout: null, settled_by: null, created_at: "t" });

  // fair 55¢. asks: 47¢×200sh ($94), 48¢×100 ($48), 60¢ deep. floor 1.5 → edge
  // ceiling 53.5; impact 2 over 47 → 49. cap = min = 49¢ → only 47+48 qualify ⇒ ~$142.
  const book = { asks: [{ price: "0.47", size: "200" }, { price: "0.48", size: "100" }, { price: "0.60", size: "5000" }], bids: [{ price: "0.46", size: "300" }] };
  const fetchImpl = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? book : {}) })) as unknown as typeof fetch;
  const res = await autoEnter(db, { now: () => "t", polymarket: loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" }), fetchImpl });

  const b = R.getBet(db, "bk-1")!;
  assert.equal(b.status, "open");
  assert.ok(b.stake != null && b.stake <= 143 && b.stake > 100, `stake capped to book depth (~$142), got ${b.stake}`);
  // VWAP ~47.3¢ + taker fee (~0.75¢ near 50¢) → effective entry ~48¢, above best ask.
  assert.ok(b.entry_price != null && b.entry_price > 47.5 && b.entry_price < 49, `filled at VWAP+fee above best ask, got ${b.entry_price}`);
  assert.ok(res.some((r) => r.market === "Over 1.5"), "reported as entered");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "enter" && /VWAP.*комиссия/.test(l.text)), "execution + fee logged");
});

test("autoEnter: two profiles of the SAME strategy both fill the SAME market independently", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 50, ai_prob: 0.6, liquidity: "1000", external_ref: "TOKEN", snapshot_at: "t", is_closing: false });
  // same strategy, same market, DIFFERENT profiles → two independent trading units
  for (const [id, prof, stake] of [["agg", "aggressive", 200], ["med", "medium", 100]] as const)
    R.insertBet(db, { id, match_id: mid, strategy_id: strat.id, risk_profile_id: prof, market_label: "Over 1.5", status: "proposed", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake, rationale: null, entered_minute: null, result: null, payout: null, settled_by: null, created_at: "t" });

  // execution model off → fills at the quote, no order book needed
  await autoEnter(db, { now: () => "t" });

  const agg = R.getBet(db, "agg")!, med = R.getBet(db, "med")!;
  assert.equal(agg.status, "open", "aggressive pair filled");
  assert.equal(med.status, "open", "medium pair ALSO filled on the same market (not dropped as a dup)");
  assert.equal(agg.stake, 200); assert.equal(med.stake, 100);
});

test("buildAppData: a clock-flipped live match with no provider delivery is flagged liveNoData (UI shows «ждём данные», not LIVE)", async () => {
  const { buildAppData } = await import("../src/lib/view.js");
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const frozen = R.uid(), real = R.uid();
  // Frozen: "live" by the clock, ESPN still "pre" — lineup match_live (zeros stats), no minute/events.
  R.insertMatch(db, { id: frozen, competition_id: comp.id, home: "Orlando", away: "Kansas", state: "live", lineup_out: true, kickoff_at: "2026-07-11T00:00:00Z", minute: null, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: frozen });
  R.upsertMatchLive(db, { match_id: frozen, espn_event_id: "e", league: "usa.nwsl", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: {}, away: {} }), updated_at: "t" });
  // Really live: provider drives a real minute.
  R.insertMatch(db, { id: real, competition_id: comp.id, home: "Bay", away: "Racing", state: "live", lineup_out: true, kickoff_at: null, minute: 12, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: real });

  const app = buildAppData(db) as any;
  assert.equal(app.matchDb[frozen].liveNoData, true, "frozen live match flagged — no provider delivery");
  assert.equal(app.matchDb[frozen].minute, null, "no fabricated timer minute while awaiting data");
  assert.equal(app.matchDb[real].liveNoData, false, "a genuinely delivering live match is NOT flagged");
});

test("evaluateExits HOLDS a position on a live match the provider isn't delivering (no noise-cut)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  // "live" by the clock, but frozen: no advancing minute, no events, only a lineup
  // match_live (zeros stats). A price crash (55¢ → 15¢) would normally hard-stop.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Orlando", away: "Kansas", state: "live", lineup_out: true, kickoff_at: "2026-07-11T00:00:00Z", minute: null, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "usa.nwsl", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { shots: 0 }, away: { shots: 0 } }), updated_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 15, ai_prob: 0.5, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });

  await evaluateExits(db, { now: () => "t" });
  assert.equal(R.getBet(db, bid)!.status, "open", "no delivery → held, not cut on unverifiable price noise");
  // Provider starts delivering a real minute → management resumes and the hard-stop fires.
  R.updateMatch(db, mid, { minute: 33 });
  await evaluateExits(db, { now: () => "t" });
  assert.ok(R.getBet(db, bid)!.status.startsWith("settled_"), "cut once the provider is actually delivering");
});

test("evaluateExits fills the close against the bid book — exit slippage into P&L", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  db.exec("DELETE FROM bets"); // isolate from seeded open positions (the mock book applies to every token)
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 80, ai_prob: 0.9, liquidity: "1000", external_ref: "TOKEN", snapshot_at: "t", is_closing: false });
  // entry 45¢; the position is marked (and the take-profit decided) on the EXECUTABLE
  // bid VWAP 73.4¢ → +63% ≥ medium 50% — NOT the optimistic 80¢ mid. ai_prob 90% keeps edge.
  R.insertBet(db, { id: "ex-1", match_id: mid, strategy_id: strat.id, market_label: "Over 1.5", status: "open", proposed_price: 45, entry_price: 45, current_price: 80, closing_price: null, ai_prob: 0.9, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  // 200 shares to sell. bids: 78¢×100 + 70¢×500 → sell 200 = 100@78 + 100@70 ⇒ VWAP 74¢ (not the 80¢ mid).
  const book = { asks: [{ price: "0.82", size: "100" }], bids: [{ price: "0.78", size: "100" }, { price: "0.70", size: "500" }] };
  const fetchImpl = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? book : {}) })) as unknown as typeof fetch;
  const exits = await evaluateExits(db, { now: () => "t", polymarket: loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" }), fetchImpl });

  assert.equal(exits.length, 1);
  const b = R.getBet(db, "ex-1")!;
  // 222 shares (100/0.45) sell 100@78 + 122@70 ⇒ VWAP 73.6¢, minus taker fee → 73¢ net.
  assert.equal(b.closing_price, 73, "closed at bid-book VWAP minus the exit taker fee, not the 80¢ mid");
  assert.equal(b.payout, 162.22, "100 × 73/45 — exit slippage + fee booked into P&L (vs 178 at the mid)");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "exit" && /выход VWAP.*комиссия/.test(l.text)), "exit execution + fee logged");
});

test("autoEnter: rejects a fill that lands far from the evaluated price / at a rail (entry_phantom_block)", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Mjallby", away: "AIK", state: "live", lineup_out: true, kickoff_at: null, minute: 88, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Both Teams to Score — No", price: 74, ai_prob: 0.9, liquidity: "3000", external_ref: "TOKP", snapshot_at: "t", is_closing: false });
  // strategist evaluated BTTS-No at 74.5¢; by fill the ask book has collapsed to ~1¢.
  R.insertBet(db, { id: "ph", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Both Teams to Score — No", status: "proposed", proposed_price: 74, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.9, stake: 28, rationale: "план", entered_minute: null, result: null, payout: null, created_at: "t" });
  const book = { asks: [{ price: "0.01", size: "100000" }], bids: [{ price: "0.005", size: "1000" }] };
  const fetchImpl = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? book : {}) })) as unknown as typeof fetch;
  const filled = await autoEnter(db, { now: () => "t", polymarket: poly, fetchImpl });
  assert.ok(!filled.some((f) => f.matchId === mid), "no fill — the evaluated market is gone");
  assert.equal(R.getBet(db, "ph")!.status, "not_filled", "proposed bet marked not_filled, not opened at the phantom");
  assert.ok(/entry_phantom_block/.test(R.getBet(db, "ph")!.rationale ?? ""), "reason records the phantom-fill rejection");
});

test("autoEnter: BLOCKS entry on a PLACEHOLDER market (empty book, fetch OK) — untradeable_market_block, terminal (not a retry)", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 6, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  // A placeholder ~50¢ market (the un-initialized Poisson artifact case) — a nominal
  // liquidity number, but NO real order book.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Draw — No", price: 50, ai_prob: 0.62, liquidity: "1000", external_ref: "TOKEN", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "pl-1", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Draw — No", status: "proposed", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "план", entered_minute: null, result: null, payout: null, created_at: "t" });
  // Empty book, but the fetch SUCCEEDS (200 ok) — a genuinely uninitialized market, not a
  // network outage. Previously this filled parametrically ("модель по ликвидности").
  const fetchImpl = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? { bids: [], asks: [] } : {}) })) as unknown as typeof fetch;
  const filled = await autoEnter(db, { now: () => "t", polymarket: poly, fetchImpl });

  assert.ok(!filled.some((f) => f.matchId === mid), "no fill on a placeholder market");
  const b = R.getBet(db, "pl-1")!;
  assert.equal(b.status, "not_filled", "placeholder market → terminal block, not opened on the parametric model");
  assert.ok(/untradeable_market_block/.test(b.rationale ?? ""), "reason records the untradeable-market gate");
  assert.ok(/стакан пуст/.test(b.rationale ?? ""), "reason distinguishes empty-book from unavailable");
});

test("autoEnter: order book UNAVAILABLE (fetch failed) HOLDS the proposal for a RETRY — stays proposed, not not_filled", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 6, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Draw — No", price: 50, ai_prob: 0.62, liquidity: "1000", external_ref: "TOKEN", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "un-1", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Draw — No", status: "proposed", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "план", entered_minute: null, result: null, payout: null, created_at: "t" });
  // The book fetch FAILS (5xx / network) — a transient outage must NOT permanently block
  // a legitimate market. The proposal is held (proposed) so the next cycle re-attempts it.
  const fetchImpl = (async (url: any) => (String(url).includes("/book")
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
  await autoEnter(db, { now: () => "t", polymarket: poly, fetchImpl });

  assert.equal(R.getBet(db, "un-1")!.status, "proposed", "transient outage keeps the proposal for the next cycle (retry), not not_filled");
});

test("untradeable-market gate is SYMMETRIC: one placeholder market blocks ENTRY and models the EXIT (fromBook=false) — same hasRealOrderbook source", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 33, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { shots: 1 }, away: { shots: 1 } }), updated_at: "t" });
  // ONE market/token. Mark has crashed to 12¢ — a stop-out on any OPEN position here.
  // Under 1.5 (a mirror "loses on the event" market) — keeps the price stop, so this test
  // still exercises the untradeable EXIT modelling rather than the optionality exemption.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 1.5", price: 12, ai_prob: 0.5, liquidity: "1000", external_ref: "TOKEN", snapshot_at: "t", is_closing: false });
  // (a) a fresh proposal on this market (aggressive) — the ENTRY side.
  R.insertBet(db, { id: "sym-entry", match_id: mid, strategy_id: strat.id, risk_profile_id: "aggressive", market_label: "Under 1.5", status: "proposed", proposed_price: 12, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "план", entered_minute: null, result: null, payout: null, created_at: "t" });
  // (b) an already-OPEN position on the SAME market (medium, different pair) — the EXIT side.
  R.insertBet(db, { id: "sym-open", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Under 1.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 12, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  // The SAME empty-but-fetch-OK book drives both sides.
  const emptyBook = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? { bids: [], asks: [] } : {}) })) as unknown as typeof fetch;

  // Entry side: the placeholder market is untradeable → blocked.
  await autoEnter(db, { now: () => "t", polymarket: poly, fetchImpl: emptyBook });
  assert.equal(R.getBet(db, "sym-entry")!.status, "not_filled", "entry blocked on the placeholder market");
  assert.ok(/untradeable_market_block/.test(R.getBet(db, "sym-entry")!.rationale ?? ""), "entry blocked by the untradeable-market gate");

  // Exit side, SAME empty book: the stop fills via the parametric model (fromBook=false),
  // and is NOT held by exit_phantom_block — proving the exit classifies the book the same
  // way the entry did (both read "no real order book" from the one classifier).
  await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: emptyBook });
  const closed = R.getBet(db, "sym-open")!;
  assert.ok(closed.status.startsWith("settled_"), "open position on the placeholder market exits via the model — not phantom-held on a missing book");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "exit" && /модель по ликвидности/.test(l.text)), "exit priced by the parametric model — no real book, same as the entry side saw");
});

test("evaluateExits HOLDS a stop that would fill into a PHANTOM bid (exit_phantom_block), takes a stop with a real book", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const liveMatch = (id: string, ref: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "Utah", away: "Gotham", state: "live", lineup_out: true, kickoff_at: null, minute: 23, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: ref });
  // Down ~-55% at the 18¢ mark (entry 40¢) → the medium hard-stop fires.
  const openBet = (id: string, mid: string) => R.insertBet(db, { id, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Gotham", status: "open", proposed_price: 35, entry_price: 40, current_price: 18, closing_price: null, ai_prob: 0.47, stake: 36, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  const bookFetch = (book: any) => (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? book : {}) })) as unknown as typeof fetch;

  // (1) PHANTOM 1¢ bid on a thin book → the stop is held, not filled at the phantom.
  const m1 = R.uid(); liveMatch(m1, "P1");
  R.insertMarket(db, { id: R.uid(), match_id: m1, label: "Gotham", price: 18, ai_prob: 0.47, liquidity: "93", external_ref: "TOKP", snapshot_at: "t", is_closing: false });
  openBet("phantom-bet", m1);
  const ex1 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.20", size: "50" }], bids: [{ price: "0.01", size: "10000" }] }) });
  assert.ok(!ex1.some((e) => e.matchId === m1), "no exit — stop into a phantom bid is held");
  assert.equal(R.getBet(db, "phantom-bet")!.status, "open", "position kept open through the phantom (rides to real settlement)");
  assert.ok(R.tradeLogForMatch(db, m1).some((l) => l.type === "hold" && /exit_phantom_block/.test(l.text)), "phantom hold logged once");

  // (2) SAME stop but a REAL bid book (17¢) → the stop executes normally (guard doesn't over-block).
  const m2 = R.uid(); liveMatch(m2, "P2");
  R.insertMarket(db, { id: R.uid(), match_id: m2, label: "Gotham", price: 18, ai_prob: 0.47, liquidity: "1000", external_ref: "TOKR", snapshot_at: "t", is_closing: false });
  openBet("real-bet", m2);
  const ex2 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.20", size: "500" }], bids: [{ price: "0.17", size: "5000" }] }) });
  assert.ok(ex2.some((e) => e.matchId === m2), "real-book stop executes (not over-blocked)");
  assert.ok(R.getBet(db, "real-bet")!.status.startsWith("settled"), "real stop settled");
});

test("evaluateExits HOLDS a stop when the full stake would SLIP far below the best bid (exit_slippage_block), executes it on a deep book", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets"); // isolate from seeded positions (the mock book applies to every token)
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const liveMatch = (id: string, ref: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "Orgryte", away: "Hacken", state: "live", lineup_out: true, kickoff_at: null, minute: 38, score_home: 1, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: ref });
  // Large $100 position entered at 52¢ (~192 shares) — enough to walk a thin book.
  const openBet = (id: string, mid: string) => R.insertBet(db, { id, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "BK Hacken Under 2.5", status: "open", proposed_price: 52, entry_price: 52, current_price: 40, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "35'", result: null, payout: null, created_at: "t" });
  const bookFetch = (book: any) => (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? book : {}) })) as unknown as typeof fetch;

  // (1) THIN book: best bid 42¢ with tiny size, then a cliff to 14¢. The full-stake dump
  // averages ~18¢ (a −24¢ slip below the 42¢ top). That crushed VWAP would self-trigger a
  // −65% stop — but the best bid can pay far more, so it's a depth artifact → HELD.
  const m1 = R.uid(); liveMatch(m1, "T1");
  R.insertMarket(db, { id: R.uid(), match_id: m1, label: "BK Hacken Under 2.5", price: 40, ai_prob: 0.6, liquidity: "2000", external_ref: "TOKT", snapshot_at: "t", is_closing: false });
  openBet("slip-bet", m1);
  const ex1 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.44", size: "500" }], bids: [{ price: "0.42", size: "30" }, { price: "0.14", size: "100000" }] }) });
  assert.ok(!ex1.some((e) => e.matchId === m1), "no exit — full-stake dump into a thin book is held");
  assert.equal(R.getBet(db, "slip-bet")!.status, "open", "position kept open (rides to a deeper book / settlement)");
  assert.ok(R.tradeLogForMatch(db, m1).some((l) => l.type === "hold" && /exit_slippage_block/.test(l.text)), "slippage hold logged");

  // (2) SAME stop, but a DEEP book at 18¢ (no size problem) → the stop executes normally.
  const m2 = R.uid(); liveMatch(m2, "T2");
  R.insertMarket(db, { id: R.uid(), match_id: m2, label: "BK Hacken Under 2.5", price: 40, ai_prob: 0.6, liquidity: "2000", external_ref: "TOKD", snapshot_at: "t", is_closing: false });
  openBet("deep-bet", m2);
  const ex2 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.44", size: "500" }], bids: [{ price: "0.18", size: "100000" }] }) });
  assert.ok(ex2.some((e) => e.matchId === m2), "deep-book stop executes (guard doesn't over-block a genuine low value)");
  assert.ok(R.getBet(db, "deep-bet")!.status.startsWith("settled"), "deep-book stop settled at the real price");
});

test("winsOnEventOccurrence: Over / BTTS-Yes are melting options (exempt); Under / No / directional keep the stop", () => {
  // wins by a future goal, loses only by the whistle → exempt from the price stop
  for (const l of ["Switzerland Over 0.5", "Argentina Over 1.5", "Over 2.5", "Both Teams to Score — Yes", "BTTS Yes"])
    assert.equal(winsOnEventOccurrence(l), true, `${l} should be exempt`);
  // loses on each goal (irreversible) OR directional → keep the stop (Örgryte Under class)
  for (const l of ["Switzerland Under 0.5", "Under 2.5", "Both Teams to Score — No", "Team to Advance — Argentina", "Draw — No", "Argentina (-1.5)", "Switzerland — Yes"])
    assert.equal(winsOnEventOccurrence(l), false, `${l} should keep the stop`);
});

test("evaluateExits: price stop is SUPPRESSED for a melting-option market, KEPT for its mirror, and a spent option hits the time-decay floor", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const liveMatch = (id: string, ref: string, minute: number) => R.insertMatch(db, { id, competition_id: comp.id, home: "Argentina", away: "Switzerland", state: "live", lineup_out: true, kickoff_at: null, minute, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: ref });
  const openBet = (id: string, mid: string, label: string, entry: number, cur: number) => R.insertBet(db, { id, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: label, status: "open", proposed_price: entry, entry_price: entry, current_price: cur, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  const bookFetch = (book: any) => (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? book : {}) })) as unknown as typeof fetch;
  const deep = (bid: number) => bookFetch({ asks: [{ price: "0.90", size: "500" }], bids: [{ price: String(bid), size: "100000" }] });

  // (1) EXEMPT «Switzerland Over 0.5» down −55% at 62' on a REAL deep book → stop SUPPRESSED
  //     (the exact Argentina–Switzerland loss: without this the stop cuts at 18¢ right before
  //     the 67' goal took it to 100¢). Held, logged price_stop_exempt.
  const m1 = R.uid(); liveMatch(m1, "AS1", 62);
  R.insertMarket(db, { id: R.uid(), match_id: m1, label: "Switzerland Over 0.5", price: 18, ai_prob: 0.6, liquidity: "2000", external_ref: "TOK1", snapshot_at: "t", is_closing: false });
  openBet("over-bet", m1, "Switzerland Over 0.5", 40, 18);
  const ex1 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: deep(0.18) });
  assert.ok(!ex1.some((e) => e.matchId === m1), "melting-option stop suppressed — no exit at 18¢");
  assert.equal(R.getBet(db, "over-bet")!.status, "open", "Over 0.5 held through the dip (rides to the goal / settlement)");
  assert.ok(R.tradeLogForMatch(db, m1).some((l) => l.type === "hold" && /price_stop_exempt/.test(l.text)), "suppression logged");

  // (2) MIRROR «Under 2.5» same −55% drawdown at 62' → stop STILL fires (each goal is an
  //     irreversible step down — Örgryte class). The fix must not exempt this.
  const m2 = R.uid(); liveMatch(m2, "AS2", 62);
  R.insertMarket(db, { id: R.uid(), match_id: m2, label: "Under 2.5", price: 18, ai_prob: 0.6, liquidity: "2000", external_ref: "TOK2", snapshot_at: "t", is_closing: false });
  openBet("under-bet", m2, "Under 2.5", 40, 18);
  const ex2 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: deep(0.18) });
  assert.ok(ex2.some((e) => e.matchId === m2), "Under (loses on the event) keeps the price stop");
  assert.ok(R.getBet(db, "under-bet")!.status.startsWith("settled"), "Under stop executed");

  // (3) EXEMPT but SPENT: «Over 0.5» at 3¢ on 85' → the time-decay floor closes it (a spent
  //     lottery ticket is not held to a 0¢ settle).
  const m3 = R.uid(); liveMatch(m3, "AS3", 85);
  R.insertMarket(db, { id: R.uid(), match_id: m3, label: "Switzerland Over 0.5", price: 3, ai_prob: 0.6, liquidity: "2000", external_ref: "TOK3", snapshot_at: "t", is_closing: false });
  openBet("dust-bet", m3, "Switzerland Over 0.5", 40, 3);
  const ex3 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: deep(0.03) });
  assert.ok(ex3.some((e) => e.matchId === m3), "spent option closed by the time-decay floor");
  assert.ok(R.tradeLogForMatch(db, m3).some((l) => l.type === "exit" && /time_decay_floor/.test(l.text)), "floor exit logged");
});

test("evaluateExits decides the take-profit on the EXECUTABLE bid, not a phantom-inflated mid", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const liveMatch = (id: string, ref: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "Mjallby", away: "AIK", state: "live", lineup_out: true, kickoff_at: null, minute: 35, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: ref });
  const openBet = (id: string, mid: string) => R.insertBet(db, { id, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Mjallby — Yes", status: "open", proposed_price: 34, entry_price: 34, current_price: 55, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  const bookFetch = (book: any) => (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? book : {}) })) as unknown as typeof fetch;

  // (1) MID 55¢ (+62% vs entry 34¢) would trip the take-profit — but the real bid is
  // 30¢ (−12%). Deciding on the executable bid, the "profit" doesn't exist → no exit.
  const m1 = R.uid(); liveMatch(m1, "P1");
  R.insertMarket(db, { id: R.uid(), match_id: m1, label: "Mjallby — Yes", price: 55, ai_prob: 0.6, liquidity: "3000", external_ref: "TOK1", snapshot_at: "t", is_closing: false });
  openBet("tp-phantom", m1);
  const ex1 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.60", size: "500" }], bids: [{ price: "0.30", size: "5000" }] }) });
  assert.ok(!ex1.some((e) => e.matchId === m1), "no phantom take-profit — decided on the 30¢ bid, not the 55¢ mid");
  assert.equal(R.getBet(db, "tp-phantom")!.status, "open", "position held (no fake profit booked)");

  // (2) same mid, but a REAL bid of 55¢ (+62% vs entry) — a genuine profit → take it.
  const m2 = R.uid(); liveMatch(m2, "P2");
  R.insertMarket(db, { id: R.uid(), match_id: m2, label: "Mjallby — Yes", price: 55, ai_prob: 0.6, liquidity: "3000", external_ref: "TOK2", snapshot_at: "t", is_closing: false });
  openBet("tp-real", m2);
  const ex2 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.60", size: "500" }], bids: [{ price: "0.55", size: "5000" }] }) });
  assert.ok(ex2.some((e) => e.matchId === m2 && e.pnl > 0), "genuine take-profit (real bid ≥ +50%) executes at a profit");
  assert.ok(R.getBet(db, "tp-real")!.status.startsWith("settled"), "real take-profit settled");
});

test("evaluateExits fires the PROFILE's take-profit; edge-gone alone is left to the strategist", async () => {
  const db = openDb(":memory:");
  seedDatabase(db); // seeds the 3 risk profiles too
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const live = (id: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  // +60% position on MEDIUM (take_profit 0.50) → deterministic net fixes it.
  const mid = R.uid(); live(mid);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 80, ai_prob: 0.9, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 80, closing_price: null, ai_prob: 0.9, stake: 100, rationale: "r", entered_minute: "40'", result: null, payout: null, created_at: "t" });
  const exits = await evaluateExits(db, { now: () => "t" });
  assert.equal(exits.length, 1);
  assert.match(exits[0].reason, /тейк/, "closed on the profile take-profit (+60% ≥ medium 50%)");
  assert.ok(R.getBet(db, bid)!.status.startsWith("settled"));

  // the SAME +60% held under AGGRESSIVE (take_profit 0.80): net does not fire.
  const mid2 = R.uid(); live(mid2);
  R.insertMarket(db, { id: R.uid(), match_id: mid2, label: "Over 2.5", price: 80, ai_prob: 0.9, liquidity: null, external_ref: "t2", snapshot_at: "t", is_closing: false });
  const bid2 = R.uid();
  R.insertBet(db, { id: bid2, match_id: mid2, strategy_id: strat.id, risk_profile_id: "aggressive", market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 80, closing_price: null, ai_prob: 0.9, stake: 100, rationale: "r", entered_minute: "40'", result: null, payout: null, created_at: "t" });
  // edge-gone-only position (aiProb 0.4 < price/100) that is NEITHER at take nor stop → held.
  const mid3 = R.uid(); live(mid3);
  R.insertMarket(db, { id: R.uid(), match_id: mid3, label: "Over 2.5", price: 62, ai_prob: 0.4, liquidity: null, external_ref: "t3", snapshot_at: "t", is_closing: false });
  const bid3 = R.uid();
  R.insertBet(db, { id: bid3, match_id: mid3, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 62, closing_price: null, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "40'", result: null, payout: null, created_at: "t" });
  const exits2 = await evaluateExits(db, { now: () => "t" });
  assert.ok(!exits2.some((e) => e.matchId === mid2), "aggressive holds the +60% (take 0.80)");
  assert.ok(!exits2.some((e) => e.matchId === mid3), "edge-gone alone no longer force-closes — strategist owns it");
  assert.equal(R.getBet(db, bid2)!.status, "open");
  assert.equal(R.getBet(db, bid3)!.status, "open");
});

test("advanceClocks flips lineup_out ~1h before kickoff", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db)[0];
  const soon = R.uid(), far = R.uid();
  const base = (id: string, ko: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: false, kickoff_at: ko, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  base(soon, "2026-07-07T12:30:00Z"); // 30 min out
  base(far, "2026-07-07T20:00:00Z");  // 8h out
  advanceClocks(db, { now: () => "2026-07-07T12:00:00Z" });
  assert.equal(R.getMatch(db, soon)!.lineup_out, true);
  assert.equal(R.getMatch(db, far)!.lineup_out, false);
  assert.equal(R.getMatch(db, soon)!.state, "lineup");
  assert.equal(R.getMatch(db, far)!.state, "upcoming");
});

test("advanceClocks flips a time-scheduled match to LIVE at kickoff, and clock-finishes a stale no-bet one", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mk = (id: string, ko: string, state = "upcoming", minute: number | null = null) => R.insertMatch(db, { id, competition_id: comp.id, home: "A"+id, away: "B"+id, state: state as any, lineup_out: state !== "upcoming", kickoff_at: ko, minute, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  const now = "2026-07-07T18:00:00Z";
  const started = R.uid(), stale = R.uid(), espn = R.uid();
  mk(started, "2026-07-07T17:30:00Z");                 // kicked off 30 min ago → LIVE
  mk(stale, "2026-07-07T12:00:00Z", "live");           // 6h ago, clock-live (minute null), no bets → finished
  mk(espn, "2026-07-07T12:00:00Z", "live", 75);        // 6h ago BUT ESPN-driven (minute set) → stays live
  advanceClocks(db, { now: () => now });
  assert.equal(R.getMatch(db, started)!.state, "live", "kicked off → live");
  assert.equal(R.getMatch(db, started)!.lineup_out, true);
  assert.equal(R.getMatch(db, stale)!.state, "finished", "stale clock-live no-bet → finished");
  assert.equal(R.getMatch(db, espn)!.state, "live", "ESPN-driven live not clock-finished");
});

test("advanceClocks clock-finish is sport-aware — a football clock-live match past its ~2h ceiling finishes (was hanging until 4h)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mk = (id: string, ko: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "A"+id, away: "B"+id, state: "live" as any, lineup_out: true, kickoff_at: ko, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  const now = "2026-07-07T18:00:00Z";
  const done = R.uid(), young = R.uid();
  mk(done, "2026-07-07T15:20:00Z");   // 2h40m ago > 130min football ceiling → finished
  mk(young, "2026-07-07T16:30:00Z");  // 1h30m ago < ceiling → still live
  // Both are COVERED (provider matched them) so the uncovered-finish path is not
  // what's under test here — only the sport ceiling for a clock-only covered match.
  for (const id of [done, young]) R.upsertMatchLive(db, { match_id: id, espn_event_id: id, league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: now });
  advanceClocks(db, { now: () => now });
  assert.equal(R.getMatch(db, done)!.state, "finished", "past football ceiling → finished (no longer waits 4h)");
  assert.equal(R.getMatch(db, young)!.state, "live", "within ceiling → still live");
});

test("advanceClocks finishes an uncovered clock-only live match after the grace, keeps a covered one", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "tennis") ?? R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mk = (id: string, ko: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "P"+id, away: "Q"+id, state: "live" as any, lineup_out: true, kickoff_at: ko, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  const now = "2026-07-07T18:00:00Z";
  const uncovered = R.uid(), covered = R.uid();
  mk(uncovered, "2026-07-07T16:30:00Z"); // 1.5h live, no provider data → uncoverable
  mk(covered, "2026-07-07T16:30:00Z");   // 1.5h live BUT provider matched it (match_live)
  R.upsertMatchLive(db, { match_id: covered, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: now });
  advanceClocks(db, { now: () => now });
  assert.equal(R.getMatch(db, uncovered)!.state, "finished", "no live data past grace → finished");
  assert.equal(R.getMatch(db, covered)!.state, "live", "provider-covered fixture kept live");
});

test("advanceClocks reverts a clock-driven live match out of live when its kickoff moved to the future (postponed)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mk = (id: string, ko: string, minute: number | null) => R.insertMatch(db, { id, competition_id: comp.id, home: "A"+id, away: "B"+id, state: "live", lineup_out: true, kickoff_at: ko, minute, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  const now = "2026-07-07T18:00:00Z";
  const postponedSoon = R.uid(), postponedFar = R.uid(), reallyLive = R.uid();
  mk(postponedSoon, "2026-07-07T18:30:00Z", null);   // kickoff now 30 min ahead → lineup (not live)
  mk(postponedFar, "2026-07-09T18:00:00Z", null);    // moved 2 days out → upcoming
  mk(reallyLive, "2026-07-07T18:30:00Z", 12);        // future kickoff BUT provider-confirmed (minute set) → stays live
  advanceClocks(db, { now: () => now });
  assert.equal(R.getMatch(db, postponedSoon)!.state, "lineup", "postponed within lineup window → lineup, not live");
  assert.equal(R.getMatch(db, postponedFar)!.state, "upcoming", "postponed far out → upcoming");
  assert.equal(R.getMatch(db, reallyLive)!.state, "live", "provider-confirmed live is never clock-reverted");
});

test("strategistReassess skips a pre-lineup match (no reassessment before lineups/live)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const pm = R.uid();
  // upcoming, NO lineup, but carrying an open position → must NOT be reassessed
  R.insertMatch(db, { id: pm, competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: pm });
  R.insertMarket(db, { id: R.uid(), match_id: pm, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "pm-open", match_id: pm, strategy_id: strat.id, market_label: "Over 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: "предматч", result: null, payout: null, settled_by: null, created_at: "t" });
  await strategistReassess(db, { fetchImpl: mockLLM({ picks: [], exits: [], note: "x" }), env: { ANTHROPIC_API_KEY: "k" } }, { max: 50 });
  assert.equal(R.reassessmentsForMatch(db, pm).length, 0, "no pre-lineup reassessment even with an open position");
});

test("strategistReassess skips a time-flipped lineup match that is not yet live (no pre-match churn)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const pm = R.uid();
  // lineup_out flipped by the 1h-before-kickoff timer (advanceClocks), NOT by a
  // real teamsheet, and the ball has NOT kicked off. Holds an open position.
  // This is the exact leak that churned not-yet-started matches — must stay quiet.
  R.insertMatch(db, { id: pm, competition_id: comp.id, home: "A", away: "B", state: "lineup", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: pm });
  R.insertMarket(db, { id: R.uid(), match_id: pm, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "lm-open", match_id: pm, strategy_id: strat.id, market_label: "Over 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: null, ai_prob: 0.6, stake: 50, rationale: null, entered_minute: "предматч", result: null, payout: null, settled_by: null, created_at: "t" });
  await strategistReassess(db, { fetchImpl: mockLLM({ picks: [], exits: [], note: "x" }), env: { ANTHROPIC_API_KEY: "k" } }, { max: 50, newEventMatchIds: new Set([pm]) });
  assert.equal(R.reassessmentsForMatch(db, pm).length, 0, "no reassessment on a not-yet-live lineup match");
});

test("evaluateExits holds an open position pre-match (lineup_out, not live) — no churn", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  // Pre-match: lineups out by the timer, a +60% take-profit would fire IF live —
  // but the match is NOT live, so nothing should be closed.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "lineup", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 80, ai_prob: 0.9, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 80, closing_price: null, ai_prob: 0.9, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  const exits = await evaluateExits(db, { now: () => "t" });
  assert.equal(exits.length, 0, "no pre-match exit");
  assert.equal(R.getBet(db, bid)!.status, "open", "position held until kickoff");
  // once live, the profile take-profit (+60% ≥ medium 50%) fires
  R.updateMatch(db, mid, { state: "live", minute: 10 });
  assert.equal((await evaluateExits(db, { now: () => "t" })).length, 1, "closes once live");
});
test("strategistReassess supports partial fixation (fraction)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 40, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 80, ai_prob: 0.7, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, risk_profile_id: "aggressive", market_label: "Under 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 80, closing_price: null, ai_prob: 0.7, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Under 2.5", fraction: 0.5, reason: "фиксирую половину на пике (п.4.2)" }] }) }] }) }) as any);
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  const bets = R.betsForMatch(db, mid);
  const open = bets.find((b) => b.status === "open")!;
  const settled = bets.find((b) => b.status === "settled_won");
  assert.equal(open.stake, 50);        // half of 100 remains open
  assert.ok(settled && settled.stake === 50); // half booked
  assert.equal(settled!.payout, 80);   // 50 * 80/50
  // the partial-fixation child must carry the SAME profile — else per-profile PnL
  // attribution is polluted (the «overreaction/?» rows in the logs).
  assert.equal(settled!.risk_profile_id, "aggressive", "partial fixation keeps the profile");
});

test("strategistReassess hands the model minute estimate, price movement, liquidity and a no-score note", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  // Live match the provider IS delivering (a real card event) but with no minute/
  // score yet — kicked off 25 min ago. The event is what qualifies it for reassess;
  // the timer estimate + no-score note then fill the gap the provider left.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "BK Hacken", away: "Djurgardens IF", state: "live", lineup_out: true, kickoff_at: "2026-07-06T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMatchEvent(db, { id: R.uid(), match_id: mid, event_key: "yc1", minute: null, type: "yellow_card", team: "BK Hacken", text: "Yellow card", created_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 94, ai_prob: 0.6, liquidity: "5900", external_ref: "t", snapshot_at: "t", is_closing: false });
  R.captureOpenOdds(db, mid, "2026-07-06T18:00:00Z"); // open = 94 initially
  // now move the live price down so there is a delta to report
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 88, ai_prob: 0.6, liquidity: "5900", external_ref: "t", snapshot_at: "t2", is_closing: false });

  let sentPrompt = ""; // accumulate every prompt — the reassess sweeps several seeded matches too
  const mock = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sentPrompt += "\n" + body.messages.map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [], note: "ok" }) }] }) } as any;
  }) as unknown as typeof fetch;
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => "2026-07-06T18:25:00Z" }, { newEventMatchIds: new Set([mid]), max: 50 });
  assert.match(sentPrompt, /≈25' \(оценка по таймеру\)/, "timer minute estimate handed over");
  assert.match(sentPrompt, /старт 94¢, -6¢/, "price movement from open reported");
  assert.match(sentPrompt, /ликв\. \$5900/, "liquidity reported");
  assert.match(sentPrompt, /провайдер пока не отдаёт счёт/, "no-score fallback guidance included");
});

test("strategistReassess closes a position the strategy prompt says to cut", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 60, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: 0.5, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  // strategist says to exit "Under 2.5" (goal broke the thesis)
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Under 2.5", reason: "гол сломал сценарий few-goals (п.4.2)" }], note: "" }) }] }) }) as any);
  const { exits } = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  const myExit = exits.find((e) => e.matchId === mid);
  assert.ok(myExit, "our position was cut by the strategist");
  assert.match(myExit!.reason, /стратег/);
  const b = R.betsForMatch(db, mid).find((x) => x.id === bid)!;
  assert.ok(b.status === "settled_won" || b.status === "settled_lost");
  assert.equal(b.payout, 72.73); // 100 * 40/55
});

test("strategistReassess HOLDS a strategist exit (thesis_stop) that would dump into a PHANTOM bid, executes it against a real book (exit_phantom_block, symmetric to evaluateExits)", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  // Open position marked at 40¢. The strategist asks to cut it (thesis_stop). If the
  // executable bid is a phantom (1¢ while the mark is 40¢), a real stop HOLDS — the
  // strategist exit must do the same, not realize a fake near-total loss.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 60, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: 0.5, liquidity: "2000", external_ref: "TOKEN", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  // fetchImpl: `/book` → order book; anything else → the strategist's exit decision.
  const exitDec = { picks: [], exits: [{ market: "Under 2.5", reason: "thesis_stop — гол сломал сценарий few-goals" }], note: "" };
  const makeFetch = (book: any) => (async (url: any) => (String(url).includes("/book")
    ? { ok: true, status: 200, json: async () => book }
    : { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(exitDec) }] }) })) as unknown as typeof fetch;

  // Phantom bid (1¢ under a 40¢ mark) → the strategist exit is HELD, not executed.
  const phantom = { asks: [{ price: "0.42", size: "500" }], bids: [{ price: "0.01", size: "5000" }] };
  const r1 = await strategistReassess(db, { fetchImpl: makeFetch(phantom), polymarket: poly, env: { ANTHROPIC_API_KEY: "k" } });
  assert.ok(!r1.exits.some((e) => e.matchId === mid), "strategist exit NOT taken into the phantom bid");
  assert.equal(R.getBet(db, bid)!.status, "open", "position held — a strategist thesis_stop does not dump into a phantom, same as a mechanical stop");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "hold" && /exit_phantom_block/.test(l.text)), "the hold is logged with the phantom-guard reason");

  // Real bid (38¢ under a 40¢ mark) → the very same strategist exit now EXECUTES.
  const realBook = { asks: [{ price: "0.42", size: "500" }], bids: [{ price: "0.38", size: "5000" }] };
  const r2 = await strategistReassess(db, { fetchImpl: makeFetch(realBook), polymarket: poly, env: { ANTHROPIC_API_KEY: "k" } });
  assert.ok(r2.exits.some((e) => e.matchId === mid), "with a real book the strategist exit is taken");
  assert.ok(R.getBet(db, bid)!.status.startsWith("settled_"), "position closed against the real bid — the guard holds only phantoms");
});

test("module 5: live reassess uses the LIVE prompt + battle sheet, sizes by risk_config, tags the profile", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  // a two-phase strategy with a DISTINCT live prompt, assigned on the aggressive profile
  R.insertStrategy(db, { id: "s5", sport_id: "football", name: "S5", tag: null, color: "#fff", version: 1, model: null, model_live: null, prompt: "ПРЕДМАТЧ-ТЕЛО-XYZ", prompt_live: "ЛАЙВ-ТЕЛО-QWE", params: {}, created_at: "t" });
  R.clearShares(db, comp.id);
  R.setShare(db, { competition_id: comp.id, strategy_id: "s5", risk_profile_id: "aggressive", pct: 60 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "A wins", price: 45, ai_prob: 0.62, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  // battle sheet for the pair (prematch plan) that the live executor should receive
  R.saveArtifact(db, { match_id: mid, kind: "battle_sheet", label: "S5 · aggressive", stage: "post_lineup", content: JSON.stringify({ plan: "BATTLE-SHEET-MARKER", live_triggers_armed: [] }), model: null, created_at: "t" });

  let sent = "";
  const mock = (async (_url: any, init: any) => { sent = init.body; return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "A wins", conviction: "высокая", reason: "выкуп по плану" }], exits: [], note: "" }) }] }) }; }) as any;
  const res = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set([mid]), max: 50, onlyStrategyId: "s5" });

  assert.match(sent, /ЛАЙВ-ТЕЛО-QWE/, "the LIVE prompt (prompt_live) was used, not the prematch one");
  assert.ok(!/ПРЕДМАТЧ-ТЕЛО-XYZ/.test(sent), "the prematch prompt was NOT used");
  assert.match(sent, /BATTLE-SHEET-MARKER/, "the pair's battle sheet was fed to the live strategist");
  const bet = R.betsForMatch(db, mid, "s5").find((b) => b.status === "proposed");
  assert.ok(bet, "a live entry was opened");
  assert.equal(bet!.risk_profile_id, "aggressive", "the entry is tagged with the pair's profile");
  assert.ok(res.entries.some((e) => e.market === "A wins"));
});

test("live reassess DEDUPS across risk profiles: ONE LLM call per strategy, shared pick sized per profile (§9.6)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  R.insertStrategy(db, { id: "sD", sport_id: "football", name: "Dedup", tag: null, color: "#fff", version: 1, model: "Claude Opus 4.8", model_live: "Claude Sonnet 5", prompt: "p", prompt_live: "LIVE-БОДИ", params: {}, created_at: "t" });
  R.clearShares(db, comp.id);
  // one strategy funded on THREE risk profiles — the old code fired 3 LLM calls
  for (const pid of ["aggressive", "medium", "conservative"])
    R.setShare(db, { competition_id: comp.id, strategy_id: "sD", risk_profile_id: pid, pct: 20 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "A wins", price: 40, ai_prob: 0.7, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });

  let calls = 0;
  const mock = (async () => { calls++; return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "A wins", prob: 0.7, conviction: "высокая", reason: "edge" }], exits: [], note: "" }) }] }) }; }) as any;
  // triggeredOnly isolates to the one triggered match (the seed has other live matches)
  const res = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set([mid]), triggeredOnly: true, max: 50, onlyStrategyId: "sD" });

  assert.equal(calls, 1, "ONE strategist call for the strategy, not one per (strategy × profile) pair");
  assert.equal(res.llmCalls, 1, "run-level llmCalls counts one, not three");
  // the single shared judgment is applied to each funded profile with its own sizing
  const proposed = R.betsForMatch(db, mid, "sD").filter((b) => b.status === "proposed");
  const profs = new Set(proposed.map((b) => b.risk_profile_id));
  assert.ok(profs.size >= 2, `shared pick entered on multiple profiles (got ${[...profs].join(",")})`);
});

test("strategistReassess opens a fresh entry on a live trigger (no prior position)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // priced market with a model probability well above price → positive edge to size
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "A wins", price: 40, ai_prob: 0.7, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });

  // strategist picks the market a live goal opened; no exits
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "A wins", conviction: "высокая", reason: "гол открыл камбэк-паттерн (п.4.3)" }], exits: [], note: "" }) }] }) }) as any);
  const res = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set([mid]), max: 50 });

  assert.ok(res.entries.some((e) => e.matchId === mid && e.market === "A wins"), "strategist opened a fresh entry on the trigger");
  const proposed = R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed");
  assert.equal(proposed.length, 1);
  assert.ok((proposed[0].stake ?? 0) > 0);
  assert.match(proposed[0].rationale ?? "", /переоценка/);

  // a non-triggered match with no open positions is left alone (no model call needed)
  const res2 = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set(), max: 50 });
  assert.ok(!res2.entries.some((e) => e.matchId === mid), "no re-entry without a trigger or position");
});

test("strategistReassess: re-entry cooldown blocks re-buying a market this pair just closed at a LOSS", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.clearShares(db, comp.id); // isolate to ONE (strategy, profile) pair
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: "medium", pct: 50 });
  const now = "2026-07-11T14:00:00Z";
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Mjallby", away: "AIK", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Mjallby — Yes", price: 26, ai_prob: 0.55, liquidity: "3000", external_ref: "t", snapshot_at: "t", is_closing: false });
  // this pair closed «Mjallby — Yes» at a LOSS 5 min ago (early cash-out).
  R.insertBet(db, { id: "loss", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Mjallby — Yes", status: "settled_lost", proposed_price: 34, entry_price: 34, current_price: 20, closing_price: 20, ai_prob: 0.5, stake: 30, rationale: "r", entered_minute: "предматч", result: "lost", payout: 17, settled_by: "early", settled_at: "2026-07-11T13:55:00Z", created_at: "t" });
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "Mjallby — Yes", conviction: "высокая", reason: "докупаю падение", prob: 0.55 }], exits: [], note: "" }) }] }) }) as any);

  // within the 10-min cooldown → the re-entry is blocked (no falling-knife chase).
  const res = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => now }, { newEventMatchIds: new Set([mid]), max: 50 });
  assert.ok(!res.entries.some((e) => e.market === "Mjallby — Yes"), "cooldown blocks re-entry into the just-lost market");
  assert.equal(R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed").length, 0, "no fresh proposal within the cooldown");

  // move the losing close OUTSIDE the window → the pair may re-enter (price had time to confirm).
  R.updateBet(db, "loss", { settled_at: "2026-07-11T13:40:00Z" });
  const res2 = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => now }, { newEventMatchIds: new Set([mid]), max: 50 });
  assert.ok(res2.entries.some((e) => e.market === "Mjallby — Yes"), "past the cooldown, re-entry is allowed");
});

test("strategistReassess sizes off the strategist's LIVE prob, refreshing the stale market ai_prob", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  // 0:2 game: "Over 1.5" already won, but the stored ai_prob is STALE at 0.50
  // (== price 50¢ → zero edge → would be skipped if we sized off it).
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 0, score_away: 2, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const mkId = R.uid();
  R.insertMarket(db, { id: mkId, match_id: mid, label: "Over 1.5", price: 50, ai_prob: 0.5, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });

  // strategist re-estimates prob 0.98 for the current 0:2 state → big real edge
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "Over 1.5", conviction: "высокая", reason: "2 гола уже забиты", prob: 0.98 }], exits: [], note: "" }) }] }) }) as any);
  const res = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set([mid]), max: 50 });

  assert.ok(res.entries.some((e) => e.market === "Over 1.5"), "entered off the fresh prob, despite the stale market prob giving no edge");
  const bet = R.betsForMatch(db, mid, strat.id).find((b) => b.status === "proposed")!;
  assert.equal(bet.ai_prob, 0.98, "bet stores the strategist's live prob");
  assert.equal(R.latestMarkets(db, mid).find((m) => m.id === mkId)!.ai_prob, 0.98, "market ai_prob refreshed to the live estimate");
});

test("runLiveCycle reacts to a live goal, and quiet re-runs don't re-fire the strategist", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0 && c.external_league === "fifa.world")!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Colombia", away: "Ghana", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // market with no external_ref → odds refresh skips it (no CLOB mock needed)
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: 0.5, liquidity: null, external_ref: null, snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  let detailCalls = 0;
  const goal: MatchDetail = { lineupOut: true, lineups: { home: null, away: null }, events: [{ key: "g1", minute: 14, type: "goal", team: "Colombia", text: "Goal!" }] };
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_s, league) { return league === "fifa.world" ? [{ externalRef: "E1", home: "Colombia", away: "Ghana", state: "live", minute: 30, scoreHome: 1, scoreAway: 0, final: false }] : []; },
    async matchDetail() { detailCalls++; return goal; },
  };
  // strategist says to cut the Under after the goal
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Under 2.5", reason: "гол сломал few-goals (п.4.2)" }] }) }] }) }) as any);

  const r1 = await runLiveCycle(db, provider, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  assert.ok(r1.live >= 1, "a live match is in play");
  assert.equal(r1.triggers, 1, "the goal is a trigger");
  assert.ok(r1.exits >= 1, "strategist cut the position on the goal");
  assert.ok(R.betsForMatch(db, mid).find((b) => b.id === bid)!.status.startsWith("settled"), "position closed");
  assert.equal(R.openOddsFor(db, mid)["Under 2.5"], 40, "kickoff price captured for the live match");

  // second pass: same goal (deduped) → no new trigger → strategist not re-called
  const r2 = await runLiveCycle(db, provider, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r2.triggers, 0, "known event doesn't re-trigger");
});

test("runLiveCycle reassesses on the periodic heartbeat with no on-pitch event", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0 && c.external_league === "fifa.world")!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  // Retire the seeded demo's other live matches so `mid` is the sole periodic
  // candidate — otherwise they'd compete for the per-run reassessment budget.
  for (const c of R.listCompetitions(db)) for (const mm of R.listMatches(db, c.id)) R.updateMatch(db, mm.id, { state: "finished" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Japan", away: "Peru", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: 0.5, liquidity: null, external_ref: null, snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

  // provider surfaces the match but reports NO new events — nothing on the pitch
  const provider: SportsProvider = {
    name: "mock",
    async scoreboard(_s, league) { return league === "fifa.world" ? [{ externalRef: "E1", home: "Japan", away: "Peru", state: "live", minute: 55, scoreHome: 0, scoreAway: 0, final: false }] : []; },
    async matchDetail() { return { lineupOut: true, lineups: { home: null, away: null }, events: [] }; },
  };
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [], note: "Держу Under, темп низкий." }) }] }) }) as any);

  const before = R.reassessmentsForMatch(db, mid).length;
  const r = await runLiveCycle(db, provider, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r.triggers, 0, "no on-pitch event trigger");
  const notes = R.reassessmentsForMatch(db, mid);
  assert.ok(notes.length > before, "periodic heartbeat still wrote a reassessment note");
  assert.equal(notes[notes.length - 1].trigger, "time", "labelled as a periodic (time) reassessment");
  assert.match(notes[notes.length - 1].body, /Держу/, "narrative note carries the strategist's read");
});

test("runLiveCycle: an on-pitch event reassesses IMMEDIATELY, independent of the periodic heartbeat (events don't wait)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0 && c.external_league === "fifa.world")!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  for (const c of R.listCompetitions(db)) for (const mm of R.listMatches(db, c.id)) R.updateMatch(db, mm.id, { state: "finished" }); // isolate `mid`
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Colombia", away: "Ghana", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: 0.5, liquidity: null, external_ref: null, snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });
  const now = "2026-07-11T20:00:00Z";
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [], note: "реагирую" }) }] }) }) as any);
  const provider = (events: any[]): SportsProvider => ({
    name: "mock",
    async scoreboard(_s, league) { return league === "fifa.world" ? [{ externalRef: "E1", home: "Colombia", away: "Ghana", state: "live", minute: 30, scoreHome: 1, scoreAway: 0, final: false }] : []; },
    async matchDetail() { return { lineupOut: true, lineups: { home: null, away: null }, events }; },
  });

  // Pass 1 (no events): the periodic heartbeat writes the FIRST reassessment (never reassessed before).
  const r1 = await runLiveCycle(db, provider([]), { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => now });
  assert.equal(r1.triggers, 0, "no on-pitch event → periodic-only");
  assert.equal(R.reassessmentsForMatch(db, mid).at(-1)!.trigger, "time", "pass 1 is a periodic (time) reassessment");

  // Pass 2 at the SAME instant → the periodic heartbeat is NOT due (just reassessed 0 min ago),
  // but a fresh GOAL arrives: it must reassess RIGHT NOW, not wait for the 10-min interval.
  const r2 = await runLiveCycle(db, provider([{ key: "g1", minute: 14, type: "goal", team: "Colombia", text: "Goal!" }]), { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => now });
  assert.equal(r2.triggers, 1, "the goal triggered a reassessment despite the heartbeat not being due");
  assert.equal(R.reassessmentsForMatch(db, mid).at(-1)!.trigger, "goal", "event-driven — labelled 'goal', not 'time'");
});

test("strategistReassess THROTTLES a repeat partial take-profit (partial_tp_throttle) but NEVER a defensive exit or a full close", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  for (const c of R.listCompetitions(db)) for (const mm of R.listMatches(db, c.id)) R.updateMatch(db, mm.id, { state: "finished" }); // isolate cases
  const now = "2026-07-11T20:10:00Z";
  const setup = (mid: string, openId: string) => {
    R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 60, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
    R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: null, snapshot_at: "t", is_closing: false });
    R.insertBet(db, { id: openId, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Under 2.5", status: "open", proposed_price: 40, entry_price: 40, current_price: 55, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });
    // a partial fixation 2 min ago (< 8-min throttle window)
    R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Under 2.5", status: "settled_won", proposed_price: 40, entry_price: 40, current_price: 52, closing_price: 52, ai_prob: 0.6, stake: 30, rationale: "частичная фиксация 30%", entered_minute: "10'", result: "won", payout: 39, settled_by: "partial", settled_at: "2026-07-11T20:08:00Z", created_at: "2026-07-11T20:08:00Z" });
  };
  const runWith = (exit: any) => strategistReassess(db, { fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [exit] }) }] }) })) as any, env: { ANTHROPIC_API_KEY: "k" }, now: () => now });

  // (1) a repeat partial TAKE-PROFIT, 2 min after the last partial → THROTTLED (held, no nibble).
  const m1 = R.uid(); setup(m1, "tp-open");
  const r1 = await runWith({ market: "Under 2.5", fraction: 0.5, reason: "take_price: цена достигла оценки, edge исчерпан", trigger: "take_price" });
  assert.ok(!r1.exits.some((e) => e.matchId === m1), "repeat partial take-profit is throttled");
  assert.equal(R.getBet(db, "tp-open")!.stake, 100, "position untouched — no further nibble");
  assert.ok(R.tradeLogForMatch(db, m1).some((l) => l.type === "hold" && /partial_tp_throttle/.test(l.text)), "throttle logged");
  R.updateMatch(db, m1, { state: "finished" });

  // (2) a DEFENSIVE exit (thesis_stop) with the SAME recent partial → NOT throttled, executes.
  const m2 = R.uid(); setup(m2, "def-open");
  const r2 = await runWith({ market: "Under 2.5", fraction: 0.5, reason: "thesis_stop — гол сломал сценарий", trigger: "thesis_stop" });
  assert.ok(r2.exits.some((e) => e.matchId === m2), "a defensive exit is never throttled");
  assert.ok(R.getBet(db, "def-open")!.stake! < 100, "position reduced by the defensive exit");
  R.updateMatch(db, m2, { state: "finished" });

  // (3) a FULL take-profit close (fraction 1) → not a partial → not throttled.
  const m3 = R.uid(); setup(m3, "full-open");
  const r3 = await runWith({ market: "Under 2.5", fraction: 1, reason: "take_price — фиксирую полностью", trigger: "take_price" });
  assert.ok(r3.exits.some((e) => e.matchId === m3), "a full close is never throttled");
  assert.ok(R.getBet(db, "full-open")!.status.startsWith("settled"), "position fully closed");
});

test("captureOpenOdds locks the kickoff price (first write wins)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db)[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 5, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: null, liquidity: null, external_ref: "t", snapshot_at: "t1", is_closing: false });
  assert.equal(R.captureOpenOdds(db, mid, "t1"), 1);
  // price moves; a second capture must NOT overwrite the kickoff price
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 62, ai_prob: null, liquidity: null, external_ref: "t", snapshot_at: "t2", is_closing: false });
  assert.equal(R.captureOpenOdds(db, mid, "t2"), 0, "already captured — no-op");
  assert.equal(R.openOddsFor(db, mid)["Under 2.5"], 40, "kickoff price preserved, not the moved 62");
});

test("runLiveCycle is a cheap no-op when nothing is in play", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("UPDATE matches SET state='finished'");
  const r = await runLiveCycle(db, null, {});
  assert.deepEqual(r, { live: 0, oddsUpdated: 0, enriched: 0, triggers: 0, exits: 0, entries: 0, llmCalls: 0, llmFail: 0 });
});

test("analyzeMatch re-run doesn't re-propose on an already-open market or breach budget (§9.3)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 100 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "lineup", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 3.5", price: 30, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  // already holds a near-full-budget open position on Over 3.5 (from the pre-lineup stage)
  const held = Math.round(comp.budget * 0.9);
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "Over 3.5", status: "open", proposed_price: 30, entry_price: 30, current_price: 30, closing_price: null, ai_prob: 0.6, stake: held, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  // combined mock: valid assessment AND a strategist pick on the held market
  const combined = { confidence: "высокая", short: "s", body: "b", verdict: "v", markets: [{ label: "Over 3.5", prob: 0.6 }], picks: [{ label: "Over 3.5", conviction: "высокая", reason: "добрать" }], exits: [] };
  await analyzeMatch(db, mid, { fetchImpl: mockLLM(combined), env: { ANTHROPIC_API_KEY: "k" } });
  const bets = R.betsForMatch(db, mid, strat.id);
  assert.equal(bets.filter((b) => b.status === "proposed" && b.market_label === "Over 3.5").length, 0, "no re-propose on the held market");
  const exposure = bets.filter((b) => b.status === "open" || b.status === "proposed").reduce((n, b) => n + (b.stake ?? 0), 0);
  assert.ok(exposure <= comp.budget, `open+proposed exposure ${exposure} within budget ${comp.budget}`);
});

test("autoAnalyze analyzes an eligible match once per stage", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // clear seeded assessments so matches become eligible
  db.exec("DELETE FROM assessments");
  // football → structured Layer-1 analysis (CORE, not per-market probs)
  const deps = { fetchImpl: mockLLM({ match_type: "group", match_type_reason: "ничья есть", core: { xg_home: 1.5, xg_away: 1.1, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 8, notes: "" }, unknowns: [] }), env: { ANTHROPIC_API_KEY: "k" } };

  const first = await autoAnalyze(db, deps);
  const lineup = first.find((a) => a.matchId === "m-lineup");
  assert.ok(lineup && lineup.ok, "m-lineup analyzed");
  assert.ok(R.assessmentsForMatch(db, "m-lineup").some((a) => a.status === "ok"));

  const second = await autoAnalyze(db, deps);
  assert.ok(!second.some((a) => a.matchId === "m-lineup"), "not re-analyzed for the same stage");
});

test("live-unanalysed match: back-fill analyses it (feeds live reassess) but SKIPS the pre-match strategist pass", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM assessments; DELETE FROM analysis_artifacts;");
  const deps = { fetchImpl: mockLLM({ match_type: "group", match_type_reason: "ничья есть", core: { xg_home: 1.5, xg_away: 1.1, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 8, notes: "" }, unknowns: [] }), env: { ANTHROPIC_API_KEY: "k" } };

  // liveOnly ignores the seeded match while it's still pre-kickoff (lineup).
  assert.ok(!(await autoAnalyze(db, deps, { liveOnly: true })).some((a) => a.matchId === "m-lineup"), "liveOnly skips a non-live match");

  // The match reaches LIVE having never been analysed (scheduler gap over kickoff).
  R.updateMatch(db, "m-lineup", { state: "live", minute: 30 });
  const ran = await autoAnalyze(db, deps, { liveOnly: true });
  const hit = ran.find((a) => a.matchId === "m-lineup");
  assert.ok(hit && hit.ok, "live-unanalysed match rescued by the back-fill");
  assert.equal(hit!.bets, 0, "no bets: the pre-match strategist pass is skipped on a live back-fill");
  assert.ok(R.assessmentsForMatch(db, "m-lineup").some((a) => a.status === "ok"), "assessment stored");
  assert.ok(R.artifactsForMatch(db, "m-lineup").some((a) => a.kind === "distribution"), "distribution artifact produced — the live reassessment is no longer blind");
  assert.ok(!R.artifactsForMatch(db, "m-lineup").some((a) => a.kind === "battle_sheet"), "NO battle_sheet — pre-match proposals don't fire on a live match");
});

test("live match that JUST kicked off (0:0, within grace): pre-match strategist STILL gets its one shot; deep-live still skips", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM assessments; DELETE FROM analysis_artifacts;");
  const nowIso = "2026-07-11T00:02:00.000Z";
  const deps = { now: () => nowIso, fetchImpl: mockLLM({ match_type: "group", match_type_reason: "ничья есть", core: { xg_home: 1.5, xg_away: 1.1, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 8, notes: "" }, unknowns: [] }), env: { ANTHROPIC_API_KEY: "k" } };

  // FIRST analysis lands 2 min after kickoff (scheduler gap spanned the whistle),
  // score still 0:0 → justKickedOff → the pre-match strategist gets its shot.
  R.updateMatch(db, "m-lineup", { state: "live", minute: 2, score_home: 0, score_away: 0, kickoff_at: "2026-07-11T00:00:00.000Z" });
  const ran = await autoAnalyze(db, deps, { liveOnly: true });
  assert.ok(ran.find((a) => a.matchId === "m-lineup")?.ok, "just-kicked-off live match analysed");
  assert.ok(R.artifactsForMatch(db, "m-lineup").some((a) => a.kind === "battle_sheet"), "battle_sheet produced — pre-match strategist ran despite live (just kicked off)");

  // Contrast: a live match 30 min past kickoff is genuinely into the game — the
  // pre-match window is closed, the strategist is skipped (live reassess owns it).
  db.exec("DELETE FROM assessments; DELETE FROM analysis_artifacts;");
  R.updateMatch(db, "m-lineup", { state: "live", minute: 30, score_home: 0, score_away: 0, kickoff_at: "2026-07-10T23:32:00.000Z" });
  await autoAnalyze(db, deps, { liveOnly: true });
  assert.ok(R.artifactsForMatch(db, "m-lineup").some((a) => a.kind === "distribution"), "distribution still produced (live reassess not blind)");
  assert.ok(!R.artifactsForMatch(db, "m-lineup").some((a) => a.kind === "battle_sheet"), "NO battle_sheet — 30' in, past the grace, pre-match strategist skipped");
});

test("runStrategists (Model A): ONE strategist call per strategy, shared across its risk profiles; profiles size the SAME picks deterministically", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  // the SAME strategy funded under THREE risk profiles
  R.clearShares(db, comp.id);
  for (const p of ["aggressive", "medium", "conservative"]) R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: p, pct: 20 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "lineup", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 40, ai_prob: 0.6, liquidity: "3000", external_ref: "TOK", snapshot_at: "t", is_closing: false });
  R.upsertAssessment(db, { id: R.uid(), match_id: mid, stage: "post_lineup", confidence: "высокая", short: "s", body: "b", verdict: "v", model: "Claude Opus 4.8", status: "ok", created_at: "t" });

  // Count strategist LLM calls: pre-Model-A this was one PER profile (3); Model A shares one.
  let calls = 0;
  const decision = { picks: [{ label: "Over 2.5", prob: 0.6, conviction: "высокая", reason: "класс-дисбаланс" }], exits: [] };
  const fetchImpl = (async () => { calls++; return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(decision) }] }) }; }) as any;

  await runStrategists(db, mid, { now: () => "t", fetchImpl, env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(calls, 1, "exactly ONE strategist LLM call for the strategy — the judgment is shared across all 3 profiles");
  assert.equal(R.artifactsForMatch(db, mid).filter((a) => a.kind === "battle_sheet").length, 3, "still one battle_sheet per profile (sizing is per-profile)");
  const proposed = R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed");
  assert.equal(proposed.length, 3, "all three profiles sized the SAME shared pick — a nested subset of one candidate list, not divergent LLM picks");
  assert.ok(proposed.every((b) => b.market_label === "Over 2.5"), "identical market across profiles (determinism restored)");
});

test("autoRunStrategists re-runs the engine for a NEW roster pair, without re-analysis, self-limiting", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM assessments; DELETE FROM analysis_artifacts;");
  const deps = { fetchImpl: mockLLM({ match_type: "group", match_type_reason: "ничья есть", core: { xg_home: 1.6, xg_away: 1.1, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 8, notes: "" }, unknowns: [] }), env: { ANTHROPIC_API_KEY: "k" } };
  await autoAnalyze(db, deps); // analyses m-lineup → ok assessment + battle_sheets for the seeded (medium) pairs
  assert.ok(R.assessmentsForMatch(db, "m-lineup").some((a) => a.status === "ok"));

  // roster change: drop the seeded pairs, assign edge on the AGGRESSIVE profile
  R.clearShares(db, "wc2026");
  R.setShare(db, { competition_id: "wc2026", strategy_id: "edge", risk_profile_id: "aggressive", pct: 60 });
  assert.ok(!R.artifactsForMatch(db, "m-lineup").some((a) => a.kind === "battle_sheet" && a.label.includes("aggressive")), "no aggressive battle_sheet yet");

  const ran = await autoRunStrategists(db, deps);
  assert.ok(ran.some((x) => x.matchId === "m-lineup"), "engine re-ran m-lineup for the new pair");
  assert.ok(R.artifactsForMatch(db, "m-lineup").some((a) => a.kind === "battle_sheet" && a.label.includes("Edge Tiered · aggressive")), "aggressive battle_sheet produced without re-analysis");
  // no new assessment was written (analysis was NOT re-run)
  assert.equal(R.assessmentsForMatch(db, "m-lineup").filter((a) => a.status === "ok").length, 1, "analysis not re-run");

  // self-limiting: the roster is now covered → second pass skips this match
  const again = await autoRunStrategists(db, deps);
  assert.ok(!again.some((x) => x.matchId === "m-lineup"), "not re-run once every current pair has a battle_sheet");
});

test("pruneMarketSnapshots caps non-closing history, keeps closing snapshots", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const now = (n: number) => `2026-07-01T00:${String(n).padStart(2, "0")}:00.000Z`;
  // 20 non-closing snapshots + 1 closing snapshot for one market label
  for (let i = 0; i < 20; i++) R.insertMarket(db, { id: R.uid(), match_id: "m-live", label: "PRUNE ME", price: 50 + i, ai_prob: null, liquidity: null, external_ref: `tok-${i}`, snapshot_at: now(i), is_closing: false });
  R.insertMarket(db, { id: R.uid(), match_id: "m-live", label: "PRUNE ME", price: 99, ai_prob: null, liquidity: null, external_ref: "tok-close", snapshot_at: now(30), is_closing: true });
  const before = (db.prepare("SELECT COUNT(*) c FROM markets WHERE label='PRUNE ME'").get() as any).c;
  assert.equal(before, 21);
  R.pruneMarketSnapshots(db, 8);
  const nonClosing = (db.prepare("SELECT COUNT(*) c FROM markets WHERE label='PRUNE ME' AND is_closing=0").get() as any).c;
  const closing = (db.prepare("SELECT COUNT(*) c FROM markets WHERE label='PRUNE ME' AND is_closing=1").get() as any).c;
  assert.equal(nonClosing, 8, "kept only the latest 8 non-closing");
  assert.equal(closing, 1, "closing snapshot preserved");
});

test("matchByMarketTokens finds a fixture by a shared CLOB token", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const tok = R.latestMarkets(db, "m-live")[0]?.external_ref;
  assert.ok(tok, "seed market has a token ref");
  const hit = R.matchByMarketTokens(db, ["nope", tok as string]);
  assert.equal(hit?.id, "m-live");
  assert.equal(R.matchByMarketTokens(db, ["does-not-exist"]), null);
});

test("formatMatchStats renders a compact home–away line, null when empty", () => {
  const json = JSON.stringify({
    home: { team: "Real", items: [{ label: "владение", value: "58%" }, { label: "удары", value: "7" }] },
    away: { team: "City", items: [{ label: "владение", value: "42%" }, { label: "удары", value: "4" }, { label: "угловые", value: "2" }] },
  });
  assert.equal(formatMatchStats(json), "владение 58%–42% · удары 7–4 · угловые —–2");
  assert.equal(formatMatchStats(null), null);
  assert.equal(formatMatchStats("{bad json"), null);
  assert.equal(formatMatchStats(JSON.stringify({ home: { team: "A", items: [] }, away: { team: "B", items: [] } })), null);
});

test("recordMatchStats writes a stats event for a live match, then rate-limits to 5 min", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Real", away: "City", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "E1", league: "eng.1", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { team: "Real", items: [{ label: "владение", value: "58%" }] }, away: { team: "City", items: [{ label: "владение", value: "42%" }] } }), updated_at: "t" });

  recordMatchStats(db, { now: () => "2026-07-05T18:00:00Z" });
  const evts = R.eventsForMatch(db, mid).filter((e) => e.type === "stats");
  assert.equal(evts.length, 1, "first snapshot written");
  assert.match(evts[0].text, /владение 58%–42%/);

  // 3 min later — within the 5-min interval → no new snapshot for this match
  recordMatchStats(db, { now: () => "2026-07-05T18:03:00Z" });
  assert.equal(R.eventsForMatch(db, mid).filter((e) => e.type === "stats").length, 1, "rate-limited within 5 min");
  // 6 min later — a fresh snapshot lands
  recordMatchStats(db, { now: () => "2026-07-05T18:06:00Z" });
  assert.equal(R.eventsForMatch(db, mid).filter((e) => e.type === "stats").length, 2, "new snapshot after the interval");
});

test("recordMatchStats: market-snapshot fallback when no ESPN stats; skips non-live and marketless", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const up = R.uid(), noMkt = R.uid(), fb = R.uid();
  // upcoming (even with stats) → skipped: not live
  R.insertMatch(db, { id: up, competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: true, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: up });
  R.upsertMatchLive(db, { match_id: up, espn_event_id: "E", league: "x", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { team: "A", items: [{ label: "владение", value: "50%" }] }, away: { team: "B", items: [] } }), updated_at: "t" });
  // live, no ESPN stats AND no markets → nothing to snapshot → skipped
  R.insertMatch(db, { id: noMkt, competition_id: comp.id, home: "C", away: "D", state: "live", lineup_out: true, kickoff_at: null, minute: 10, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: noMkt });
  // live, no ESPN stats, but HAS markets → market-snapshot fallback
  R.insertMatch(db, { id: fb, competition_id: comp.id, home: "Alcaraz", away: "Sinner", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: fb });
  R.insertMarket(db, { id: R.uid(), match_id: fb, label: "Alcaraz", price: 62, ai_prob: null, liquidity: "300K", external_ref: "t1", snapshot_at: "t", is_closing: false });
  R.insertMarket(db, { id: R.uid(), match_id: fb, label: "Sinner", price: 38, ai_prob: null, liquidity: "200K", external_ref: "t2", snapshot_at: "t", is_closing: false });

  recordMatchStats(db, { now: () => "2026-07-05T18:00:00Z" });
  assert.equal(R.eventsForMatch(db, up).filter((e) => e.type === "stats").length, 0, "upcoming skipped");
  assert.equal(R.eventsForMatch(db, noMkt).filter((e) => e.type === "stats").length, 0, "live without markets skipped");
  const snaps = R.eventsForMatch(db, fb).filter((e) => e.type === "stats");
  assert.equal(snaps.length, 1, "market-snapshot fallback written");
  assert.match(snaps[0].text, /рынок: Alcaraz 62¢ · Sinner 38¢/); // favourite (higher price) first
});
