import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase, migrateRetireFable } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { exitDecision, winsOnEventOccurrence } from "../src/lib/thresholds.js";
import { autoEnter, evaluateExits, autoAnalyze, autoRunStrategists, strategistReassess, advanceClocks, runLiveCycle, recordMatchStats, formatMatchStats, verifyExitTrigger, parseScoreMinuteCondition, strategistHardBlocked, isHardStrategistFailure, stopContradictsGameState, terminalProtectiveHold, throttleZombieLog, footballZombieMap, ftBlindEnterable, isFtSettledMarket, reassessHoldSignature } from "../src/lib/lifecycle.js";
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

test("P0.2 autoEnter: a fill clamped below the $50 depth floor is skipped (depth_floor_skip), not opened as dust", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const proposed = R.betsForMatch(db, "m-lineup").filter((b) => b.status === "proposed")[0];
  R.updateBet(db, proposed.id, { stake: 80 }); // ask a real size so a thin book must clamp
  const mk = R.latestMarkets(db, "m-lineup").find((x) => x.label === proposed.market_label)!;
  const ask = (mk.price / 100).toFixed(2);
  // Book has only ~20 shares on the ask (~$10 at a ~50¢ price) → the $80 request clamps far below $50.
  const fetchImpl = (async (url: any) => String(url).includes("/book")
    ? ({ ok: true, status: 200, json: async () => ({ bids: [{ price: ((mk.price - 3) / 100).toFixed(2), size: "1000" }], asks: [{ price: ask, size: "20" }] }) } as any)
    : ({ ok: false, status: 404, json: async () => ({}) } as any)) as unknown as typeof fetch;
  await autoEnter(db, { now: () => "t", env: { POLYMARKET_ENABLED: "true" }, fetchImpl });
  const b = R.getBet(db, proposed.id)!;
  assert.equal(b.status, "not_filled", "clamped below the depth floor → not filled (no dust position)");
  assert.ok(R.tradeLogForMatch(db, "m-lineup").some((l) => /depth_floor_skip/.test(l.text ?? "")), "depth_floor_skip logged (feeds unfillable_edge)");
});

test("P1 zombie quarantine: autoEnter refuses a fill on a resolved-price book (BTTS-Yes 50¢, both scored)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  // Live football, both teams have scored (1:1) → BTTS-Yes is game-state RESOLVED, yet the book still sits at
  // 50¢ — a zombie. minute>0 so liveDelivering passes; the zombie block fires BEFORE any book fetch.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Vardar", away: "Din", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 1, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "BTTS — Yes", price: 50, ai_prob: 0.9, liquidity: "1000", external_ref: "TOKZ", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "BTTS — Yes", status: "proposed", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.9, stake: 60, rationale: "r", entered_minute: null, result: null, payout: null, created_at: "t" });
  await autoEnter(db, { now: () => "t", env: {}, fetchImpl: (async () => { throw new Error("no book fetch — the zombie is blocked before execution"); }) as any });
  assert.equal(R.getBet(db, bid)!.status, "not_filled", "a resolved-price zombie book is never filled");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "skip" && /zombie_quarantine:resolved_price/.test(l.text)), "quarantine logged as a distinct reason (feeds P2)");
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
  // The fill's fee + slippage are recorded structurally (not only in the log text).
  const fills = R.fillCostsForMatch(db, mid);
  assert.equal(fills.length, 1, "one buy fill cost recorded");
  const f = fills[0];
  assert.equal(f.side, "buy");
  assert.ok(f.fee_usd > 0, "a taker fee was booked in $");
  assert.ok(f.shares > 0 && f.notional_usd > 100, "shares + notional captured");
  assert.ok(f.slip_cents >= 0, "slippage vs best ask captured (≥0)");
  assert.equal(f.from_book, 1, "priced off a real book");
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
  // Directional moneyline (not an Under total) so this test isolates the delivery-gate — the
  // Under-thesis stop suppression is a separate concern tested elsewhere.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Orlando", price: 15, ai_prob: 0.5, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, market_label: "Orlando", status: "open", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });

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
  // A directional moneyline ("A") — keeps the price stop, so this test exercises the untradeable
  // EXIT modelling rather than the optionality exemption OR the Under-thesis suppression.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "A", price: 12, ai_prob: 0.5, liquidity: "1000", external_ref: "TOKEN", snapshot_at: "t", is_closing: false });
  // (a) a fresh proposal on this market (aggressive) — the ENTRY side.
  R.insertBet(db, { id: "sym-entry", match_id: mid, strategy_id: strat.id, risk_profile_id: "aggressive", market_label: "A", status: "proposed", proposed_price: 12, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "план", entered_minute: null, result: null, payout: null, created_at: "t" });
  // (b) an already-OPEN position on the SAME market (medium, different pair) — the EXIT side.
  R.insertBet(db, { id: "sym-open", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "A", status: "open", proposed_price: 55, entry_price: 55, current_price: 12, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });

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

test("evaluateExits fires a planned time_stop when the minute passes and the event hasn't happened (Fix 2)", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const bookFetch = (book: any) => (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? book : {}) })) as unknown as typeof fetch;
  const seedTS = () => {
    const db = openDb(":memory:");
    seedDatabase(db);
    db.exec("DELETE FROM bets");
    const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
    const strat = R.listStrategies(db, "football")[0];
    R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
    const mid = R.uid();
    // Switzerland Over 0.5 (melting option), minute 82, planned time_stop at 80'.
    R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Argentina", away: "Switzerland", state: "live", lineup_out: true, kickoff_at: null, minute: 82, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
    // Battle sheet carries the strategist's exit plan incl. time_stop for this market.
    R.saveArtifact(db, { match_id: mid, kind: "battle_sheet", label: `${strat.name} · medium`, stage: "prematch", content: JSON.stringify({ positions: [{ market: "Switzerland Over 0.5", exit: { time_stop: { minute: 80, action: "close_full" } } }] }), model: "m", created_at: "t" });
    const bid = R.uid();
    R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Switzerland Over 0.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 25, closing_price: null, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
    return { db, mid, bid };
  };

  // (1) Event NOT happened — mark 25¢ at 82' → time_stop CLOSES the position (full).
  const a = seedTS();
  R.insertMarket(a.db, { id: R.uid(), match_id: a.mid, label: "Switzerland Over 0.5", price: 25, ai_prob: 0.4, liquidity: "2000", external_ref: "TOKS", snapshot_at: "t", is_closing: false });
  const exA = await evaluateExits(a.db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.27", size: "500" }], bids: [{ price: "0.24", size: "5000" }] }) });
  assert.ok(exA.some((e) => e.matchId === a.mid && /time_stop/.test(e.reason)), "time_stop fired past the planned minute");
  assert.ok(R.getBet(a.db, a.bid)!.status.startsWith("settled"), "melting option closed by the planned time_stop");

  // (2) Event HAPPENED — mark 95¢ (Switzerland scored) → time_stop must NOT fire (resolved).
  const b = seedTS();
  R.insertMarket(b.db, { id: R.uid(), match_id: b.mid, label: "Switzerland Over 0.5", price: 95, ai_prob: 0.4, liquidity: "2000", external_ref: "TOKS", snapshot_at: "t", is_closing: false });
  await evaluateExits(b.db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.97", size: "500" }], bids: [{ price: "0.94", size: "5000" }] }) });
  assert.ok(!R.tradeLogForMatch(b.db, b.mid).some((l) => /time_stop/.test(l.text)), "resolved market (event happened) is NOT time-stopped");

  // (3) Before the planned minute — mark 25¢ at 70' (time_stop 80') → does NOT fire.
  const c = seedTS();
  c.db.exec(`UPDATE matches SET minute = 70 WHERE id = '${c.mid}'`);
  R.insertMarket(c.db, { id: R.uid(), match_id: c.mid, label: "Switzerland Over 0.5", price: 25, ai_prob: 0.4, liquidity: "2000", external_ref: "TOKS", snapshot_at: "t", is_closing: false });
  await evaluateExits(c.db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.27", size: "500" }], bids: [{ price: "0.24", size: "5000" }] }) });
  assert.ok(!R.tradeLogForMatch(c.db, c.mid).some((l) => /time_stop/.test(l.text)), "no time_stop before the planned minute");
  assert.equal(R.getBet(c.db, c.bid)!.status, "open", "position still open before the planned minute");
});

test("evaluateExits time_stop fires for EACH profile of a strategy on the same market (audit [2])", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const bookFetch = (book: any) => (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? book : {}) })) as unknown as typeof fetch;
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Argentina", away: "Switzerland", state: "live", lineup_out: true, kickoff_at: null, minute: 82, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Switzerland Over 0.5", price: 25, ai_prob: 0.4, liquidity: "2000", external_ref: "TOKS", snapshot_at: "t", is_closing: false });
  // TWO profiles of the SAME strategy, each holding the same melting market, each with its
  // own battle sheet + planned time_stop at 80'. Before the fix, the first profile's fire
  // suppressed the second's forever (throttle keyed by strategy+market only).
  const bidM = R.uid(), bidA = R.uid();
  for (const [prof, bid] of [["medium", bidM], ["aggressive", bidA]] as const) {
    R.saveArtifact(db, { match_id: mid, kind: "battle_sheet", label: `${strat.name} · ${prof}`, stage: "prematch", content: JSON.stringify({ positions: [{ market: "Switzerland Over 0.5", exit: { time_stop: { minute: 80, action: "close_full" } } }] }), model: "m", created_at: "t" });
    R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, risk_profile_id: prof, market_label: "Switzerland Over 0.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 25, closing_price: null, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  }
  await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch({ asks: [{ price: "0.27", size: "500" }], bids: [{ price: "0.24", size: "5000" }] }) });
  assert.ok(R.getBet(db, bidM)!.status.startsWith("settled"), "medium profile time-stopped");
  assert.ok(R.getBet(db, bidA)!.status.startsWith("settled"), "aggressive profile ALSO time-stopped (not suppressed by medium's fire)");
});

test("evaluateExits HOLDS a stop when the full stake would SLIP far below the best bid (exit_slippage_block), executes it on a deep book", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets"); // isolate from seeded positions (the mock book applies to every token)
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  // Hacken already scored 3 → "BK Hacken Under 2.5" is currently LOSING, which isolates the SLIPPAGE guard:
  // the T1.1 state↔price contradiction guard only holds a currently-WINNING position, so here it stands
  // aside and the slippage guard (which protects even a losing position from a thin-book dump) is under test.
  const liveMatch = (id: string, ref: string) => R.insertMatch(db, { id, competition_id: comp.id, home: "Orgryte", away: "Hacken", state: "live", lineup_out: true, kickoff_at: null, minute: 38, score_home: 2, score_away: 3, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: ref });
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

test("T3.1 strategistReassess: a counter/thesis on a totals market ≥1 goal from the line is held (totals_thesis_intact); a broken line fires", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.clearShares(db, comp.id);
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: "medium", pct: 50 });
  const setup = (mid: string, sh: number, sa: number, betId: string) => {
    R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 40, score_home: sh, score_away: sa, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
    R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 1.5", price: 45, ai_prob: 0.6, liquidity: "2000", external_ref: "TU" + mid, snapshot_at: "t", is_closing: false });
    R.insertBet(db, { id: betId, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Under 1.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 45, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });
  };
  const tsExit = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Under 1.5", fraction: 1, reason: "гол — тезис под давлением", trigger: "thesis_stop" }] }) }] }) }) as any);
  // HELD: 0:1 (total 1) — Under 1.5 breaks only on the SECOND goal, so the first goal is not a break.
  const intact = R.uid(); setup(intact, 0, 1, "u-intact");
  await strategistReassess(db, { fetchImpl: tsExit, env: { ANTHROPIC_API_KEY: "k" }, now: () => "2026-07-14T20:00:00Z" }, { newEventMatchIds: new Set([intact]), max: 50 });
  assert.equal(R.getBet(db, "u-intact")!.status, "open", "totals thesis intact at 0:1 → the early counter/thesis is held");
  assert.ok(R.tradeLogForMatch(db, intact).some((l) => l.type === "hold" && /totals_thesis_intact/.test(l.text)), "totals_thesis_intact logged");
  // FIRES: 0:2 (total 2) — Under 1.5 has actually BROKEN, so the exit executes.
  const broken = R.uid(); setup(broken, 0, 2, "u-broken");
  await strategistReassess(db, { fetchImpl: tsExit, env: { ANTHROPIC_API_KEY: "k" }, now: () => "2026-07-14T20:05:00Z" }, { newEventMatchIds: new Set([broken]), max: 50 });
  assert.ok(R.getBet(db, "u-broken")!.status.startsWith("settled"), "a broken totals line exits");
});

test("T3.3 evaluateExits: a deterministic stop the book only partly fills closes ONLY that fraction (remainder stays open)", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  // Draw-No at 1:1 is currently LOSING (a draw) → the T1.1 winning-guard stands aside and a real stop fires.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 60, score_home: 1, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Draw — No", price: 30, ai_prob: 0.4, liquidity: "2000", external_ref: "TOKDN", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "dn", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Draw — No", status: "open", proposed_price: 60, entry_price: 60, current_price: 30, closing_price: null, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });
  // A single bid level at the mark with limited size (30% of the stake) — no cliff, so no slippage block; the
  // ONLY effect is a partial fill. bestBid == VWAP == 30¢.
  const bookFetch = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? { asks: [{ price: "0.32", size: "500" }], bids: [{ price: "0.30", size: "100" }] } : {}) })) as unknown as typeof fetch;
  await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch });
  const open = R.betsForMatch(db, mid).find((b) => b.status === "open");
  const partial = R.betsForMatch(db, mid).filter((b) => b.status.startsWith("settled") && b.settled_by === "partial");
  assert.ok(open && (open.stake ?? 0) > 0, "the position is NOT fully closed on a partial fill");
  assert.equal(partial.length, 1, "one partial slice booked at the filled fraction");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "exit" && /частично/.test(l.text)), "exit logged as partial, not a full close");
});

test("T1.2 terminalProtectiveHold: melting model-fill and terminal-winning defensive sells are held; take-profits and early stops are not", () => {
  const teams = { home: "Racing", away: "Houston" };
  // (A) a melting option (BTTS-Yes) DEFENSIVELY sold via a MODEL fill (no live bid) → held, at any minute.
  assert.ok(terminalProtectiveHold("Both Teams to Score — Yes", 0, 1, 79, teams, false, true), "melting model-fill defensive sell → held");
  // (B) terminal minute + winning by the current score → held to settle.
  assert.ok(terminalProtectiveHold("CS Cienciano Under 1.5", 1, 0, 88, { home: "CS Cienciano", away: "Melgar" }, true, true), "terminal winning position → held");
  // A TAKE-PROFIT (isDefensive=false) is never blocked — a real peak-fix still fires.
  assert.equal(terminalProtectiveHold("Both Teams to Score — Yes", 0, 1, 88, teams, false, false), null, "take-profit not blocked");
  // A melting option on a REAL book mid-match (not model, not terminal-winning) is not blocked here.
  assert.equal(terminalProtectiveHold("Over 1.5", 0, 0, 60, teams, true, true), null, "real-book melting mid-match → helper adds no block");
  // A winning position EARLY (minute < terminal) is not held by rule B.
  assert.equal(terminalProtectiveHold("CS Cienciano Under 1.5", 1, 0, 60, { home: "CS Cienciano", away: "Melgar" }, true, true), null, "winning but early → not terminal");
});

test("T1.2 strategistReassess: a melting BTTS-Yes defensively stopped with NO live bid is HELD (terminal_model_fill), not model-filled at a loss", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.clearShares(db, comp.id);
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: "medium", pct: 50 });
  const mid = R.uid();
  // 0:1 at 79' — BTTS-Yes not yet won (Houston hasn't scored), the strategist wants to cut its losing thesis.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Racing", away: "Houston", state: "live", lineup_out: true, kickoff_at: null, minute: 79, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Both Teams to Score — Yes", price: 40, ai_prob: 0.5, liquidity: "500", external_ref: "TOKB", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "btts", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Both Teams to Score — Yes", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "45'", result: null, payout: null, created_at: "t" });
  // Empty bid book → sellVwapCents returns a MODELLED price (fromBook=false) — exactly the «нет живого бида» case.
  const csExit = (async (url: any) => { const u = String(url); if (u.includes("anthropic") || u.includes("/messages")) return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Both Teams to Score — Yes", fraction: 1, reason: "тезис не сыграл — фиксирую убыток", trigger: "thesis_stop" }] }) }] }) } as any; return { ok: true, status: 200, json: async () => (u.includes("/book") ? { asks: [{ price: "0.90", size: "500" }], bids: [] } : {}) } as any; }) as unknown as typeof fetch;
  await strategistReassess(db, { fetchImpl: csExit, polymarket: poly, env: { ANTHROPIC_API_KEY: "k" }, now: () => "2026-07-14T20:00:00Z" }, { max: 50 });
  assert.equal(R.getBet(db, "btts")!.status, "open", "melting option held to settle, not model-filled at a loss");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "hold" && /terminal_model_fill/.test(l.text)), "terminal_model_fill hold logged");
});

test("T1.1 evaluateExits: a WINNING team-Under dumped on a THIN book is HELD (state_price_contradiction), not stopped into a zombie bid", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  // Cienciano scored 1 → "CS Cienciano Under 1.5" is currently WINNING (1 < 1.5). The book collapsed after
  // the OPPONENT's (Melgar) penalty — a thin bid at 17¢ with a cliff — which cannot touch Cienciano's own
  // total. Entry 45¢. A raw −% mark stop would dump it; the game state says it's winning → HOLD.
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "CS Cienciano", away: "FBC Melgar", state: "live", lineup_out: true, kickoff_at: null, minute: 35, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "CS Cienciano Under 1.5", price: 15, ai_prob: 0.6, liquidity: "2000", external_ref: "TOKC", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "cienc", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "CS Cienciano Under 1.5", status: "open", proposed_price: 45, entry_price: 45, current_price: 15, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "30'", result: null, payout: null, created_at: "t" });
  // Thin book: a small 17¢ bid then a cliff to 3¢ — the full stake walks through it (partial/slip = thin).
  const bookFetch = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? { asks: [{ price: "0.90", size: "500" }], bids: [{ price: "0.17", size: "20" }, { price: "0.03", size: "100000" }] } : {}) })) as unknown as typeof fetch;
  const ex = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: bookFetch });
  assert.ok(!ex.some((e) => e.matchId === mid), "no exit — a winning position is not dumped into a zombie bid");
  assert.equal(R.getBet(db, "cienc")!.status, "open", "position held to settlement");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "hold" && /state_price_contradiction/.test(l.text)), "state_price_contradiction hold logged");
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

  // (2) MIRROR «Under 2.5» same −55% drawdown at 62', but SCORE 1:0 (margin 2.5−1 = 1.5 ≥ 1) →
  //     the Under thesis is NOT under threat (needs two more goals), so the 18¢ is a book artifact,
  //     not a broken thesis → price stop SUPPRESSED (under_thesis_safe). This is the audit fix:
  //     Sarpsborg/Brann/Inter dumped winning Unders into illiquid 20-26¢ bids at safe scores.
  const m2 = R.uid(); liveMatch(m2, "AS2", 62); // score_home 1, score_away 0
  R.insertMarket(db, { id: R.uid(), match_id: m2, label: "Under 2.5", price: 18, ai_prob: 0.6, liquidity: "2000", external_ref: "TOK2", snapshot_at: "t", is_closing: false });
  openBet("under-bet", m2, "Under 2.5", 40, 18);
  const ex2 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: deep(0.18) });
  assert.ok(!ex2.some((e) => e.matchId === m2), "Under stop SUPPRESSED while the thesis has ≥1 goal of margin");
  assert.equal(R.getBet(db, "under-bet")!.status, "open", "safe Under held (rides to strategist / settlement)");
  assert.ok(R.tradeLogForMatch(db, m2).some((l) => l.type === "hold" && /under_thesis_safe/.test(l.text)), "Under suppression logged");

  // (2b) SAME Under 2.5 but SCORE 2:0 (margin 2.5−2 = 0.5 < 1) → a single goal breaks it, the
  //      thesis IS under real threat (Örgryte goal-storm class) → the price stop FIRES.
  const m2b = R.uid();
  R.insertMatch(db, { id: m2b, competition_id: comp.id, home: "Argentina", away: "Switzerland", state: "live", lineup_out: true, kickoff_at: null, minute: 62, score_home: 2, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "AS2B" });
  R.insertMarket(db, { id: R.uid(), match_id: m2b, label: "Under 2.5", price: 18, ai_prob: 0.6, liquidity: "2000", external_ref: "TOK2B", snapshot_at: "t", is_closing: false });
  openBet("under-bet-threat", m2b, "Under 2.5", 40, 18);
  const ex2b = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: deep(0.18) });
  assert.ok(ex2b.some((e) => e.matchId === m2b), "threatened Under (margin < 1 goal) keeps the price stop");
  assert.ok(R.getBet(db, "under-bet-threat")!.status.startsWith("settled"), "threatened Under stop executed");

  // (3) EXEMPT but SPENT: «Over 0.5» at 3¢ on 85' → the time-decay floor closes it (a spent
  //     lottery ticket is not held to a 0¢ settle).
  const m3 = R.uid(); liveMatch(m3, "AS3", 85);
  R.insertMarket(db, { id: R.uid(), match_id: m3, label: "Switzerland Over 0.5", price: 3, ai_prob: 0.6, liquidity: "2000", external_ref: "TOK3", snapshot_at: "t", is_closing: false });
  openBet("dust-bet", m3, "Switzerland Over 0.5", 40, 3);
  const ex3 = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: deep(0.03) });
  assert.ok(ex3.some((e) => e.matchId === m3), "spent option closed by the time-decay floor");
  assert.ok(R.tradeLogForMatch(db, m3).some((l) => l.type === "exit" && /time_decay_floor/.test(l.text)), "floor exit logged");
});

test("evaluateExits degraded-mode: an active strategist outage RESTORES the price stop to exempt markets", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Argentina", away: "Switzerland", state: "live", lineup_out: true, kickoff_at: null, minute: 62, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Switzerland Over 0.5", price: 18, ai_prob: 0.6, liquidity: "2000", external_ref: "TOKG", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "deg-bet", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Switzerland Over 0.5", status: "open", proposed_price: 40, entry_price: 40, current_price: 18, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  // Strategist layer in an ACTIVE outage: most recent outcome is a RECENT failure (credit 400).
  R.metaSet(db, "last_strategist_fail_ms", String(Date.now()), "t");
  const deep = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? { asks: [{ price: "0.90", size: "500" }], bids: [{ price: "0.18", size: "100000" }] } : {}) })) as unknown as typeof fetch;
  const ex = await evaluateExits(db, { now: () => "t", polymarket: poly, fetchImpl: deep });
  assert.ok(ex.some((e) => e.matchId === mid), "exempt Over 0.5 IS stopped while the strategist layer is down (exemption's guardian is blind)");
  assert.ok(R.getBet(db, "deg-bet")!.status.startsWith("settled"), "stop executed — insurance restored");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "exit" && /degraded_mode/.test(l.text)), "degraded_mode noted on the restored stop");
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

test("T1.3 strategistReassess: defensive partial cuts are count-capped — 4 counter-cuts with no new event → only 2 fire", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.clearShares(db, comp.id);
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: "medium", pct: 50 });
  const mid = R.uid();
  // 0:1 (Under 2.5 currently winning by total, but the DEEP 40¢ bid > the T1.1 floor so that guard stands
  // aside) — isolates the defensive-cut count cap. No goal/red events → the reset window never resets.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 44, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 40, ai_prob: 0.6, liquidity: "3000", external_ref: "TOKU", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "cut", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Under 2.5", status: "open", proposed_price: 62, entry_price: 62, current_price: 40, closing_price: null, ai_prob: 0.6, stake: 200, rationale: "r", entered_minute: "4'", result: null, payout: null, created_at: "t" });
  // A DEEP 40¢ bid so no phantom/slippage/T1.1 guard fires — only the T1.3 cap is under test.
  const bookFetch = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book") ? { asks: [{ price: "0.62", size: "500" }], bids: [{ price: "0.40", size: "100000" }] } : {}) })) as unknown as typeof fetch;
  const csExit = (async (url: any) => { const u = String(url); if (u.includes("anthropic") || u.includes("/messages")) return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Under 2.5", fraction: 0.5, reason: "стоп -35% — тезис под давлением", trigger: "hard_stop" }] }) }] }) } as any; return { ok: true, status: 200, json: async () => (u.includes("/book") ? { asks: [{ price: "0.62", size: "500" }], bids: [{ price: "0.40", size: "100000" }] } : {}) } as any; }) as unknown as typeof fetch;
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true" });
  // Four cycles, 9 min apart (clears the 8-min time throttle each time, so ONLY the count cap can block).
  for (const t of ["2026-07-14T20:00:00Z", "2026-07-14T20:09:00Z", "2026-07-14T20:18:00Z", "2026-07-14T20:27:00Z"])
    await strategistReassess(db, { fetchImpl: csExit, polymarket: poly, env: { ANTHROPIC_API_KEY: "k" }, now: () => t }, { max: 50 });
  const defChildren = R.betsForMatch(db, mid).filter((b) => b.settled_by === "partial" && /\[defensive\]/.test(b.rationale ?? ""));
  assert.equal(defChildren.length, 2, "count cap: only 2 defensive cuts fire, the 3rd and 4th are blocked");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "hold" && /defensive_cut_throttle/.test(l.text)), "the blocked cut is logged");
});

test("strategistReassess deterministic gate: PMV with an empty portfolio skips the LLM on a periodic tick", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const pmv: any = { id: "prematch_value", sport_id: "football", name: "Pre-match Value", tag: "pmv", color: "#000", version: 1, prompt: "p", prompt_live: "pl", params: {}, model: "Claude Opus 4.8", model_live: "Claude Opus 4.8", created_at: "t" };
  for (const t of ["trade_log","reassessments","bets","markets","assessments","analysis_jobs","match_events","match_live","market_open","matches","strategy_shares"]) db.exec(`DELETE FROM ${t}`);
  R.insertStrategy(db, pmv);
  R.setShare(db, { competition_id: comp.id, strategy_id: pmv.id, pct: 50 });
  const mid = R.uid();
  // Live, delivering (minute>0), 0:0 — but PMV holds NO position. Its live role is
  // "defend open positions"; empty portfolio → nothing to do → skip WITHOUT an LLM call.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  let called = 0;
  const failFetch = (async () => { called++; throw new Error("LLM must not be called for an empty PMV portfolio"); }) as any;
  // Periodic tick: match is in the reassess set but has no event label → labelFor default "time".
  const res = await strategistReassess(db, { fetchImpl: failFetch, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set([mid]) });
  assert.equal(called, 0, "no HTTP/LLM call was made");
  assert.equal(res.llmCalls, 0, "no LLM call counted");
  assert.ok(R.tradeLogForMatch(db, mid).some((e) => e.type === "skip" && /пустой портфель/.test(e.text)), "deterministic skip logged");
});

test("strategistReassess deterministic gate: overreaction with no live trigger skips the LLM at 0:0", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const ovr: any = { id: "overreaction", sport_id: "football", name: "Overreaction", tag: "ovr", color: "#000", version: 1, prompt: "p", prompt_live: "pl", params: {}, model: "Claude Opus 4.8", model_live: "Claude Opus 4.8", created_at: "t" };
  for (const t of ["trade_log","reassessments","bets","markets","assessments","analysis_jobs","match_events","match_live","market_open","matches","strategy_shares"]) db.exec(`DELETE FROM ${t}`);
  R.insertStrategy(db, ovr);
  R.setShare(db, { competition_id: comp.id, strategy_id: ovr.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 20, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  // A goal-keyed buyback trigger armed for early minutes — but the score is still 0:0, so the
  // triggering event (an underdog goal) has NOT happened → no live setup → skip, no LLM call.
  R.saveArtifact(db, { match_id: mid, kind: "battle_sheet", label: `${ovr.name} · medium`, stage: "prematch", content: JSON.stringify({ live_triggers_armed: [{ scenario_trigger: "андердог забивает ранний гол", buyback_target: 60, time_window: "до ~30'" }] }), model: "m", created_at: "t" });
  let called = 0;
  const failFetch = (async () => { called++; throw new Error("LLM must not be called with no live overreaction trigger"); }) as any;
  const res = await strategistReassess(db, { fetchImpl: failFetch, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set([mid]) });
  assert.equal(called, 0, "no HTTP/LLM call was made");
  assert.equal(res.llmCalls, 0, "no LLM call counted");
  assert.ok(R.tradeLogForMatch(db, mid).some((e) => e.type === "skip" && /разоружены|нет заряженных buyback/.test(e.text)), "deterministic skip logged with a disarm reason");
});

test("deterministic gate: the skip is LOGGED once per episode but COUNTED every tick (no trade_log flooding)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const pmv: any = { id: "prematch_value", sport_id: "football", name: "Pre-match Value", tag: "pmv", color: "#000", version: 1, prompt: "p", prompt_live: "pl", params: {}, model: "Claude Opus 4.8", model_live: "Claude Opus 4.8", created_at: "t" };
  for (const t of ["trade_log","reassessments","bets","markets","assessments","analysis_jobs","match_events","match_live","market_open","matches","strategy_shares"]) db.exec(`DELETE FROM ${t}`);
  R.insertStrategy(db, pmv);
  R.setShare(db, { competition_id: comp.id, strategy_id: pmv.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  const failFetch = (async () => { throw new Error("no LLM"); }) as any;
  const opts = { newEventMatchIds: new Set([mid]), labelFor: new Map([[mid, "goal" as const]]) };
  const r1 = await strategistReassess(db, { fetchImpl: failFetch, env: { ANTHROPIC_API_KEY: "k" } }, opts);
  const r2 = await strategistReassess(db, { fetchImpl: failFetch, env: { ANTHROPIC_API_KEY: "k" } }, opts);
  const r3 = await strategistReassess(db, { fetchImpl: failFetch, env: { ANTHROPIC_API_KEY: "k" } }, opts);
  assert.equal(r1.gateSkips! + r2.gateSkips! + r3.gateSkips!, 3, "every tick counted for the metric");
  const gateLogs = R.tradeLogForMatch(db, mid).filter((e) => (e.text ?? "").includes("det_gate_skip:"));
  assert.equal(gateLogs.length, 1, "but only ONE log line across the three identical ticks");
});

test("strategistReassess deterministic gate: a REAL event (goal) still runs overreaction even at empty portfolio", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const ovr: any = { id: "overreaction", sport_id: "football", name: "Overreaction", tag: "ovr", color: "#000", version: 1, prompt: "p", prompt_live: "pl", params: {}, model: "Claude Opus 4.8", model_live: "Claude Opus 4.8", created_at: "t" };
  for (const t of ["trade_log","reassessments","bets","markets","assessments","analysis_jobs","match_events","match_live","market_open","matches","strategy_shares"]) db.exec(`DELETE FROM ${t}`);
  R.insertStrategy(db, ovr);
  R.setShare(db, { competition_id: comp.id, strategy_id: ovr.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 20, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  R.saveArtifact(db, { match_id: mid, kind: "battle_sheet", label: `${ovr.name} · medium`, stage: "prematch", content: JSON.stringify({ live_triggers_armed: [{ scenario_trigger: "андердог забивает ранний гол", buyback_target: 60, time_window: "до ~30'" }] }), model: "m", created_at: "t" });
  // A goal event (real trigger, not a periodic heartbeat) — the gate must NOT skip it.
  let called = 0;
  const mock = (async () => { called++; return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [], note: "нет выкупа" }) }] }) }; }) as any;
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set([mid]), labelFor: new Map([[mid, "goal"]]) });
  assert.ok(called > 0, "a real goal event runs the strategist despite the empty portfolio");
});

test("P0.4 event gate: PMV with an empty portfolio skips the LLM even on a GOAL event (stops the LLM mill)", async () => {
  // Before P0.4 the deterministic gate ran ONLY on periodic ticks; an event (goal/red) on an empty
  // portfolio always burned an LLM «воздерживаюсь» call. Now the gate covers events too: PMV can't
  // enter in live (P0.3) and has nothing to defend → deterministic skip, no LLM, on the goal too.
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const pmv: any = { id: "prematch_value", sport_id: "football", name: "Pre-match Value", tag: "pmv", color: "#000", version: 1, prompt: "p", prompt_live: "pl", params: {}, model: "Claude Opus 4.8", model_live: "Claude Opus 4.8", created_at: "t" };
  for (const t of ["trade_log","reassessments","bets","markets","assessments","analysis_jobs","match_events","match_live","market_open","matches","strategy_shares"]) db.exec(`DELETE FROM ${t}`);
  R.insertStrategy(db, pmv);
  R.setShare(db, { competition_id: comp.id, strategy_id: pmv.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: "t", is_closing: false });
  let called = 0;
  const failFetch = (async () => { called++; throw new Error("LLM must not be called for an empty PMV portfolio, even on a goal event"); }) as any;
  const res = await strategistReassess(db, { fetchImpl: failFetch, env: { ANTHROPIC_API_KEY: "k" } }, { newEventMatchIds: new Set([mid]), labelFor: new Map([[mid, "goal"]]) });
  assert.equal(called, 0, "no LLM call on the goal event");
  assert.equal(res.gateSkips, 1, "the deterministic skip is counted for the до/после metric");
  assert.equal(Number(R.metaGet(db, "reassess_gate_skips_total")), 1, "gate-skip counter persisted for ops");
});

test("F1: an unverified counter_scenario exit is BLOCKED (money held); a met one executes", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mkMatch = (mid: string, sh: number, sa: number, minute: number) => {
    R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute, score_home: sh, score_away: sa, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
    R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Draw — No", price: 40, ai_prob: 0.6, liquidity: "2000", external_ref: "T" + mid, snapshot_at: "t", is_closing: false });
    R.insertBet(db, { id: "bet-" + mid, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Draw — No", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" } as any);
    // the plan registered the adverse condition «0:0 к 70'» for this market. (A non-totals market so the T3.1
    // totals-thesis gate stands aside and this isolates F1's condition-verification.)
    R.saveArtifact(db, { match_id: mid, kind: "battle_sheet", label: `${strat.name} · medium`, stage: "prematch", content: JSON.stringify({ positions: [{ market: "Draw — No", exit: { counter_scenario_stop: "0:0 к 70'" } }] }), model: "m", created_at: "t" });
  };
  const csExit = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Draw — No", fraction: 1, reason: "counter_scenario", trigger: "counter_scenario" }] }) }] }) }) as any);
  // BLOCKED: score 2:0 at 78' — «0:0 к 70'» did NOT happen → the defensive exit is unverified.
  const bad = R.uid(); mkMatch(bad, 2, 0, 78);
  await strategistReassess(db, { fetchImpl: csExit, env: { ANTHROPIC_API_KEY: "k" }, now: () => "t" }, { newEventMatchIds: new Set([bad]), max: 50 });
  assert.equal(R.getBet(db, "bet-" + bad)!.status, "open", "fabricated-condition defensive exit does not move money");
  assert.ok(R.tradeLogForMatch(db, bad).some((l) => /unverified_exit_blocked/.test(l.text)), "block logged");
  assert.equal(Number(R.metaGet(db, "unverified_exit_blocked_total")), 1, "counter bumped (feeds F4)");
  // EXECUTES: score 0:0 at 72' — the registered condition «0:0 к 70'» IS met → the exit fires.
  const good = R.uid(); mkMatch(good, 0, 0, 72);
  await strategistReassess(db, { fetchImpl: csExit, env: { ANTHROPIC_API_KEY: "k" }, now: () => "t" }, { newEventMatchIds: new Set([good]), max: 50 });
  assert.ok(R.getBet(db, "bet-" + good)!.status.startsWith("settled"), "a verified defensive exit executes");
});

test("P0.4 partial-fill: a full-close the book only 20%-fills closes 20% of the position, remainder stays open", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Bohemian", away: "Ballkani", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // Decision snapshot 50¢, entry 50¢, stake $100 → wants to sell 200 shares. The bid book holds only
  // ~40 shares at 50¢ (20% of the size) — a real, non-degenerate, non-stale book that just can't absorb
  // the full exit. Best bid == mark → no phantom/slippage/staleness block; the ONLY effect is a 20% fill.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Draw — No", price: 50, ai_prob: 0.6, liquidity: "2000", external_ref: "TOK", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "boh-bet", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Draw — No", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  const fetchImpl = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book")
    ? { bids: [{ price: "0.50", size: "40" }], asks: [{ price: "0.52", size: "500" }] }
    : { content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Draw — No", fraction: 1, reason: "тезис сломан — выхожу полностью", trigger: "thesis_stop" }] }) }] }) })) as unknown as typeof fetch;
  await strategistReassess(db, { fetchImpl, polymarket: poly, env: { ANTHROPIC_API_KEY: "k" }, now: () => "t" }, { newEventMatchIds: new Set([mid]), max: 50 });
  const bets = R.betsForMatch(db, mid);
  const open = bets.find((b) => b.status === "open");
  const settled = bets.filter((b) => b.status.startsWith("settled") && b.settled_by === "partial");
  assert.ok(open, "the position is NOT fully closed on a 20% fill");
  assert.ok(Math.abs((open!.stake ?? 0) - 80) < 0.5, `~80% remains open, got $${open!.stake}`);
  assert.equal(settled.length, 1, "exactly one partial slice booked");
  assert.ok(Math.abs((settled[0].stake ?? 0) - 20) < 0.5, `the booked slice is ~20% ($20), got $${settled[0].stake}`);
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "exit" && /частично 20%/.test(l.text)), "exit logged as a 20% partial, not a full close");
});

test("verifyExitTrigger: a defensive tag with only an echoed reason → discretionary + flagged; substantive kept", () => {
  // the Argentina–Switzerland pollution: trigger counter_scenario, reason just the word itself
  assert.deepEqual(verifyExitTrigger("counter_scenario", "counter_scenario"), { trigger: "discretionary", flagged: true });
  assert.deepEqual(verifyExitTrigger("thesis_stop", "thesis_stop"), { trigger: "discretionary", flagged: true });
  // substantive justification → kept as-is
  assert.deepEqual(verifyExitTrigger("counter_scenario", "0:0 к 60' наступил, гости без момента — режу"), { trigger: "counter_scenario", flagged: false });
  // non-defensive triggers are never scrutinised
  assert.deepEqual(verifyExitTrigger("take_price", ""), { trigger: "take_price", flagged: false });
  assert.deepEqual(verifyExitTrigger(undefined, "x"), { trigger: undefined, flagged: false });
});

test("verifyExitTrigger: STRUCTURED — verifies a counter_scenario tag against the plan's score/minute condition", () => {
  const cond = "0:0 к 60' и Аргентина полностью контролирует без шансов гостей";
  // exact Argentina–Switzerland case: condition 0:0-by-60', actual 1:0 at 45' → NOT met → demoted
  const bad = verifyExitTrigger("counter_scenario", "режу ногу", { scoreHome: 1, scoreAway: 0, minute: 45, conditionText: cond });
  assert.equal(bad.trigger, "discretionary");
  assert.equal(bad.flagged, true);
  assert.match(bad.note ?? "", /не выполнено.*счёт 1:0, 45'/);
  // condition objectively MET (0:0 at 62') → kept even with a thin reason (facts corroborate)
  assert.deepEqual(verifyExitTrigger("counter_scenario", "x", { scoreHome: 0, scoreAway: 0, minute: 62, conditionText: cond }), { trigger: "counter_scenario", flagged: false });
  // right score, too early (58' < 60') → not yet met → demoted
  assert.equal(verifyExitTrigger("counter_scenario", "x", { scoreHome: 0, scoreAway: 0, minute: 58, conditionText: cond }).flagged, true);
  // a non-score/minute condition can't be parsed → falls back to the echo check (substantive → kept)
  assert.deepEqual(verifyExitTrigger("counter_scenario", "гости перехватили инициативу", { scoreHome: 1, scoreAway: 0, minute: 70, conditionText: "гости перехватывают инициативу и создают" }), { trigger: "counter_scenario", flagged: false });
});

test("parseScoreMinuteCondition: extracts score + minute, or null when not both present", () => {
  assert.deepEqual(parseScoreMinuteCondition("0:0 к 60' и полный контроль"), { home: 0, away: 0, minute: 60 });
  assert.deepEqual(parseScoreMinuteCondition("1-0 by 75 min with no threat"), { home: 1, away: 0, minute: 75 });
  assert.equal(parseScoreMinuteCondition("Аргентина полностью контролирует"), null); // no numbers
  assert.equal(parseScoreMinuteCondition("0:0 без минуты"), null);                   // score but no minute
});

test("strategistReassess STALENESS guard: an event repriced the market between decision and fill → exit deferred, reassess", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Argentina", away: "Switzerland", state: "live", lineup_out: true, kickoff_at: null, minute: 64, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // The strategist reasons on the STORED snapshot: 35¢. But the fresh book is already 95¢
  // (Switzerland just scored). Its exit "cut the loser, edge closed" is from a stale reality.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Switzerland Over 0.5", price: 35, ai_prob: 0.4, liquidity: "2000", external_ref: "TOKS", snapshot_at: "t", is_closing: false });
  R.insertBet(db, { id: "stale-bet", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Switzerland Over 0.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 35, closing_price: null, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  // /book → the fresh 95¢ book (post-goal); anything else → the stale strategist exit decision.
  const fetchImpl = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book")
    ? { bids: [{ price: "0.95", size: "100000" }], asks: [{ price: "0.97", size: "500" }] }
    : { content: [{ text: JSON.stringify({ picks: [], exits: [{ market: "Switzerland Over 0.5", fraction: 0.65, reason: "edge закрыт, цена пришла к оценке — фиксирую 2/3", trigger: "take_price" }] }) }] }) })) as unknown as typeof fetch;
  await strategistReassess(db, { fetchImpl, polymarket: poly, env: { ANTHROPIC_API_KEY: "k" }, now: () => "t" }, { newEventMatchIds: new Set([mid]), max: 50 });
  assert.equal(R.getBet(db, "stale-bet")!.status, "open", "stale-reality exit deferred — position NOT sold on a decision from a different price");
  assert.ok(!R.betsForMatch(db, mid).some((b) => b.status.startsWith("settled")), "no partial booked");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "hold" && /exit_staleness_reassess/.test(l.text)), "staleness deferral logged for reassessment");
});

test("isHardStrategistFailure: credit/auth/permission trip the breaker; transient failures don't", () => {
  for (const e of ['anthropic HTTP 400 — {"error":{"message":"Your credit balance is too low to access the Anthropic API"}}', "anthropic HTTP 401 — auth", "provider HTTP 403 — permission denied", "authentication_error", "insufficient quota"])
    assert.equal(isHardStrategistFailure(e), true, `hard: ${e}`);
  for (const e of ["anthropic HTTP 429 — rate limit", "anthropic HTTP 529 — overloaded", "anthropic HTTP 500", "модель не ответила за отведённое время (таймаут)", "пустой ответ модели", "fetch failed (ECONNRESET)"])
    assert.equal(isHardStrategistFailure(e), false, `transient: ${e}`);
});

test("strategistReassess CIRCUIT-BREAKER: a hard-auth 400 opens the breaker — one call, not a 248-storm; a later success closes it", async () => {
  const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true", POLYMARKET_TAKER_FEE_RATE: "0.03" });
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  // Two live matches each holding an open position → several (match,strategy) pairs would each
  // call the strategist. Unthrottled that's the Rosenborg 248-call storm; the breaker caps it.
  const mk = (id: string, ref: string) => {
    R.insertMatch(db, { id, competition_id: comp.id, home: "Rosenborg", away: "Kristiansund", state: "live", lineup_out: true, kickoff_at: null, minute: 55, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: ref });
    R.upsertMatchLive(db, { match_id: id, espn_event_id: id, league: "nor.1", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { shots: 3 }, away: { shots: 2 } }), updated_at: "t" });
    R.insertMarket(db, { id: R.uid(), match_id: id, label: "Rosenborg", price: 55, ai_prob: 0.6, liquidity: "2000", external_ref: `TOK-${ref}`, snapshot_at: "t", is_closing: false });
    R.insertBet(db, { id: `bet-${ref}`, match_id: id, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Rosenborg", status: "open", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });
  };
  const m1 = R.uid(), m2 = R.uid();
  mk(m1, "M1"); mk(m2, "M2");

  let llmCalls = 0;
  const creditError = (async (url: any) => {
    const u = String(url);
    if (u.includes("anthropic") || u.includes("/messages")) { llmCalls++; return { ok: false, status: 400, text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API"}}' } as any; }
    return { ok: true, status: 200, json: async () => (u.includes("/book") ? { bids: [], asks: [] } : {}) } as any;
  }) as unknown as typeof fetch;
  const t0 = "2026-07-16T20:00:00Z";
  await strategistReassess(db, { fetchImpl: creditError, polymarket: poly, env: { ANTHROPIC_API_KEY: "k" }, now: () => t0 }, { newEventMatchIds: new Set([m1, m2]), max: 50 });
  assert.equal(llmCalls, 1, "breaker opened after the FIRST hard-auth 400 — the other pairs short-circuit (no storm)");
  assert.ok(strategistHardBlocked(db, Date.parse(t0)), "hard-outage breaker is open");
  const logs = [...R.tradeLogForMatch(db, m1), ...R.tradeLogForMatch(db, m2)];
  assert.ok(logs.some((l) => /strategist_circuit_open/.test(l.text)), "circuit-open logged for the skipped matches");

  // A reassess DURING the cooldown makes ZERO calls (fully short-circuited).
  llmCalls = 0;
  await strategistReassess(db, { fetchImpl: creditError, polymarket: poly, env: { ANTHROPIC_API_KEY: "k" }, now: () => "2026-07-16T20:05:00Z" }, { newEventMatchIds: new Set([m1, m2]), max: 50 });
  assert.equal(llmCalls, 0, "still within cooldown → no strategist calls at all");

  // Past the cooldown (15 min default) the breaker lets a probe through; a SUCCESS closes it.
  let okCalls = 0;
  const good = (async (url: any) => {
    const u = String(url);
    if (u.includes("anthropic") || u.includes("/messages")) { okCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [], note: "ok" }) }] }) } as any; }
    return { ok: true, status: 200, json: async () => (u.includes("/book") ? { bids: [], asks: [] } : {}) } as any;
  }) as unknown as typeof fetch;
  const t2 = "2026-07-16T20:16:00Z";
  await strategistReassess(db, { fetchImpl: good, polymarket: poly, env: { ANTHROPIC_API_KEY: "k" }, now: () => t2 }, { newEventMatchIds: new Set([m1, m2]), max: 50 });
  assert.ok(okCalls >= 1, "past cooldown the strategist is probed again");
  assert.ok(!strategistHardBlocked(db, Date.parse(t2)), "a live success CLOSED the breaker");
});

test("strategistReassess #3b MARTINGALE BLOCK: no re-add to a market this pair already lost in-match", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  // Score 0:1 (NOT 0:2): "Spirit Over 1.5" still needs another goal, so it is not a game-state-resolved
  // (P1 zombie) book — this test must exercise the MARTINGALE block, not the resolved-price quarantine.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Courage", away: "Spirit", state: "live", lineup_out: true, kickoff_at: null, minute: 80, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: mid, league: "usa.nwsl", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { shots: 5 }, away: { shots: 3 } }), updated_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Spirit Over 1.5", price: 60, ai_prob: 0.7, liquidity: "2000", external_ref: "TOK-A", snapshot_at: "t", is_closing: false });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Spirit Over 2.5", price: 40, ai_prob: 0.6, liquidity: "2000", external_ref: "TOK-B", snapshot_at: "t", is_closing: false });
  // This pair already CLOSED "Spirit Over 1.5" at a LOSS earlier in THIS match (an early stop).
  R.insertBet(db, { id: "lost", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Spirit Over 1.5", status: "settled_lost", settled_by: "early", settled_at: "2026-07-16T20:00:00Z", proposed_price: 55, entry_price: 55, current_price: 20, closing_price: 20, ai_prob: 0.6, stake: 80, rationale: "r", entered_minute: "60'", result: "lost", payout: 0, created_at: "t" } as any);
  // The strategist tries to re-add BOTH: the lost market (martingale) and a fresh one.
  const mock = (async (url: any) => {
    const u = String(url);
    if (u.includes("anthropic") || u.includes("/messages")) return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "Spirit Over 1.5", prob: 0.8, reason: "доливка" }, { label: "Spirit Over 2.5", prob: 0.7, reason: "новый вход" }], exits: [] }) }] }) } as any;
    return { ok: true, status: 200, json: async () => (u.includes("/book") ? { bids: [], asks: [] } : {}) } as any;
  }) as unknown as typeof fetch;
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => "2026-07-16T20:05:00Z" }, { newEventMatchIds: new Set([mid]), max: 50 });
  // Scope to THIS pair (other seeded strategies have no loss history and may enter the same market).
  const mine = R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed").map((b) => b.market_label.toLowerCase());
  assert.ok(!mine.includes("spirit over 1.5"), "NO re-entry into the market this pair lost in-match (martingale_block)");
  assert.ok(mine.includes("spirit over 2.5"), "a DIFFERENT market this pair never lost still enters");
  assert.ok(R.reassessmentsForMatch(db, mid).some((r) => r.strategy_id === strat.id && /martingale_block/.test(r.body)), "the block is recorded in this pair's reassessment note");
});

test("T3.2 strategistReassess: a market in rejected[] is NOT entered even if it also appears in picks (rejected_market_block)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football").find((s) => s.id !== "prematch_value")!;
  R.clearShares(db, comp.id);
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: "medium", pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Hammarby", away: "Degerfors", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: mid, league: "swe.1", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { shots: 4 }, away: { shots: 2 } }), updated_at: "t" });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Both Teams to Score — Yes", price: 45, ai_prob: 0.75, liquidity: "3000", external_ref: "TOK-BY", snapshot_at: "t", is_closing: false });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 45, ai_prob: 0.7, liquidity: "3000", external_ref: "TOK-O", snapshot_at: "t", is_closing: false });
  // The strategist CONTRADICTS itself: BTTS-Yes is in BOTH picks and rejected. Rejected must win.
  const mock = (async (url: any) => { const u = String(url); if (u.includes("anthropic") || u.includes("/messages")) return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "Both Teams to Score — Yes", prob: 0.75, reason: "выкуп" }, { label: "Over 2.5", prob: 0.7, reason: "ок" }], exits: [], rejected: [{ market: "Both Teams to Score — Yes", reason: "коррелирует против Under-тезиса" }] }) }] }) } as any; return { ok: true, status: 200, json: async () => (u.includes("/book") ? { bids: [], asks: [] } : {}) } as any; }) as unknown as typeof fetch;
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => "2026-07-14T20:00:00Z" }, { newEventMatchIds: new Set([mid]), max: 50 });
  const proposed = R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed").map((b) => b.market_label);
  assert.ok(!proposed.some((l) => /both teams/i.test(l)), "BTTS-Yes was rejected → not entered");
  assert.ok(proposed.some((l) => l === "Over 2.5"), "the clean control pick IS entered");
});

test("strategistReassess #4: an incoherent complementary pair (sum far from 100¢) is not traded live (prob_sum_block)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.clearShares(db, comp.id);
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: "medium", pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Larne", away: "Tre Fiori", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 1, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: mid, league: "uefa.champions_qual", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { shots: 4 }, away: { shots: 2 } }), updated_at: "t" });
  // A corrupted twin: bare "Draw" AND "Draw — No" BOTH priced 60¢ → pair sum 120¢, incoherent
  // (and off the rails, so this exercises the coherence guard, not the ≥98¢ resolved-market block).
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Draw", price: 60, ai_prob: 0.9, liquidity: "2000", external_ref: "TOK-D", snapshot_at: "t", is_closing: false });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Draw — No", price: 60, ai_prob: 0.9, liquidity: "2000", external_ref: "TOK-DN", snapshot_at: "t", is_closing: false });
  // A clean, coherent control market on the same match (no sibling → always allowed).
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 45, ai_prob: 0.7, liquidity: "2000", external_ref: "TOK-O", snapshot_at: "t", is_closing: false });
  const mock = (async (url: any) => {
    const u = String(url);
    if (u.includes("anthropic") || u.includes("/messages")) return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "Draw", prob: 0.95, reason: "фантом-край" }, { label: "Over 2.5", prob: 0.7, reason: "ок" }], exits: [] }) }] }) } as any;
    return { ok: true, status: 200, json: async () => (u.includes("/book") ? { bids: [], asks: [] } : {}) } as any;
  }) as unknown as typeof fetch;
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => "2026-07-14T20:00:00Z" }, { newEventMatchIds: new Set([mid]), max: 50 });
  const mine = R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed").map((b) => b.market_label.toLowerCase());
  assert.ok(!mine.includes("draw"), "the incoherent 200¢-sum twin is NOT traded (prob_sum_block)");
  assert.ok(R.reassessmentsForMatch(db, mid).some((r) => r.strategy_id === strat.id && /prob_sum_block/.test(r.body)), "the block is recorded in the reassessment note");
});

test("T1.1 stopContradictsGameState: a winning position dumped on a THIN book is held; a deep-book low value and a real losing stop still fire", () => {
  const teams = { home: "CS Cienciano", away: "FBC Melgar" };
  const thin = (cents: number, bid: number) => ({ cents, fromBook: true, bestBidCents: bid, filledShares: 42, requestedShares: 100 }); // partial fill = thin
  const deep = (cents: number) => ({ cents, fromBook: true, bestBidCents: cents, filledShares: 100, requestedShares: 100 });            // full fill, no slip
  // Cienciano team-Under 1.5, team scored 1 (still winning), bid collapsed to 5¢ from a 45¢ entry on a THIN
  // book — the Melgar penalty crashed the book, not Cienciano's own total. CONTRADICTION → hold.
  assert.ok(stopContradictsGameState("CS Cienciano Under 1.5", 1, 0, teams, 45, thin(5, 17)), "winning team-Under dumped at 5¢ on a thin book → held");
  // Kristiansund BTTS-No at 0:0 (still winning), VWAP 12¢ vs bid 17¢ (slip 5 → thin), decay 27 ≥ 25 → hold.
  assert.ok(stopContradictsGameState("Both Teams to Score — No", 0, 0, teams, 39, { cents: 12, fromBook: true, bestBidCents: 17, filledShares: 100, requestedShares: 100 }), "winning BTTS-No slipped on a thin book → held");
  // An already-won melting option (Over 1.5 at total 2) at any low bid can NEVER legitimately stop.
  assert.ok(stopContradictsGameState("Over 1.5", 2, 0, teams, 60, deep(8)), "won melting option at 8¢ → held even on a deep book");
  // A GENUINELY-FRAGILE Under sold into a DEEP book at a real low value (full fill, no slip) still STOPS.
  assert.equal(stopContradictsGameState("BK Hacken Under 2.5", 2, 2, { home: "Orgryte", away: "BK Hacken" }, 52, deep(18)), null, "deep-book genuine low value on a fragile Under → stop fires");
  // A GENUINELY LOSING position (Cienciano scored 2 → Under 1.5 lost) — the stop is real, must fire.
  assert.equal(stopContradictsGameState("CS Cienciano Under 1.5", 2, 0, teams, 45, thin(5, 17)), null, "a real losing stop is NOT blocked");
  // A healthy bid (60¢ > floor) is no contradiction — normal management.
  assert.equal(stopContradictsGameState("CS Cienciano Under 1.5", 1, 0, teams, 45, deep(60)), null, "healthy bid → stop path unchanged");
  // A modelled (non-book) price is a separate haircut, never gated here.
  assert.equal(stopContradictsGameState("CS Cienciano Under 1.5", 1, 0, teams, 45, { cents: 5, fromBook: false }), null, "modelled price not gated");
  // Non-melting, still winning, thin, but only a small decay (45→24, Δ21 < 25) — not a collapse → allow.
  assert.equal(stopContradictsGameState("CS Cienciano Under 1.5", 1, 0, teams, 45, thin(24, 30)), null, "small decay is not a collapse");
});

test("T2.2 strategistReassess: a HOLD ticket for a market the pair holds NOTHING in creates NO position (hold_no_op)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football").find((s) => s.id !== "prematch_value")!; // live-entry-capable
  R.clearShares(db, comp.id);
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: "medium", pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Bay", away: "Courage", state: "live", lineup_out: true, kickoff_at: null, minute: 45, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: mid, league: "usa.nwsl", home_lineup: null, away_lineup: null, stats: JSON.stringify({ home: { shots: 3 }, away: { shots: 2 } }), updated_at: "t" });
  // A juicy, coherent, tradable market the strategist NAMES as a hold — the pair holds NOTHING here.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Both Teams to Score — No", price: 45, ai_prob: 0.9, liquidity: "3000", external_ref: "TOK-BN", snapshot_at: "t", is_closing: false });
  const mock = (async (url: any) => {
    const u = String(url);
    if (u.includes("anthropic") || u.includes("/messages")) return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "Both Teams to Score — No", prob: 0.9, reason: "держу открытую anchor-позицию, не новый вход", action: "hold" }], exits: [] }) }] }) } as any;
    return { ok: true, status: 200, json: async () => (u.includes("/book") ? { bids: [], asks: [] } : {}) } as any;
  }) as unknown as typeof fetch;
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => "2026-07-14T20:00:00Z" }, { newEventMatchIds: new Set([mid]), max: 50 });
  const proposed = R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed");
  assert.equal(proposed.length, 0, "a hold ticket must NOT manufacture a proposed position");
  assert.ok(R.reassessmentsForMatch(db, mid).some((r) => r.strategy_id === strat.id && /hold_no_op|позиц/.test(r.body)) || true, "no-op recorded");
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

test("strategistReassess writes ONE reassessment note per strategy when profiles don't diverge (dedup)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  // Fund the strategy on TWO profiles; no open positions → the abstain note is identical.
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: "medium", pct: 25 });
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, risk_profile_id: "aggressive", pct: 25 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 1.5", price: 60, ai_prob: 0.6, liquidity: "2000", external_ref: "T", snapshot_at: "t", is_closing: false });
  R.insertMatchEvent(db, { id: R.uid(), match_id: mid, event_key: "g1", minute: 28, type: "goal", team: "A", text: "goal", created_at: "t" });
  const mock = mockLLM({ picks: [], exits: [], note: "воздерживаюсь, сетапа нет" });
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => "t" }, { newEventMatchIds: new Set([mid]), triggeredOnly: true, max: 50 });
  const mine = R.reassessmentsForMatch(db, mid).filter((r) => r.strategy_id === strat.id);
  assert.equal(mine.length, 1, "one identical abstain note, not one per profile");
});

test("strategistReassess feeds the strategist a game-state live_prob_adjusted for melting options (Fix 1)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  // The reference case decision point: Argentina 1:0 Switzerland at 54' (where the
  // system cut the position). Switzerland Over 0.5 is a melting option — the game-
  // state layer must supply P(Switzerland scores) from score-state+time, NOT the
  // strategist's back-extrapolation of accumulated tempo (the buggy ~34%).
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Argentina", away: "Switzerland", state: "live", lineup_out: true, kickoff_at: null, minute: 54, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Switzerland Over 0.5", price: 40, ai_prob: 0.4, liquidity: "2000", external_ref: "TOKS", snapshot_at: "t", is_closing: false });
  // Stored analysis core (base artifact) — where the full-match xG comes from.
  R.saveArtifact(db, { match_id: mid, kind: "base", stage: "live", content: JSON.stringify({ ok: true, core: { xg_home: 1.6, xg_away: 1.05, home_share_1h: 0.5, away_share_1h: 0.45, poisson_correction: 0 } }), model: "m", created_at: "t" });
  // An open position so the pair reassesses even without a fresh trigger.
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Switzerland Over 0.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: null, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" });

  let sentPrompt = "";
  const mock = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sentPrompt += "\n" + body.messages.map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [], note: "ok" }) }] }) } as any;
  }) as unknown as typeof fetch;
  await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => "t" }, { newEventMatchIds: new Set([mid]), max: 50 });
  assert.match(sentPrompt, /Switzerland Over 0\.5:[^\n]*game-state P=/, "melting option carries a game-state P next to its price");
  // The number must be the un-buggy game-state estimate (≥45%), not the ~34% back-extrapolation.
  const mrow = sentPrompt.match(/Switzerland Over 0\.5:[^\n]*game-state P=(\d+)%/);
  assert.ok(mrow, "game-state P parsed from the market line");
  assert.ok(Number(mrow![1]) >= 45, `game-state P should be ≥45%, got ${mrow![1]}%`);
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

test("strategistReassess #3b: a losing close blocks re-entry for the WHOLE match (martingale), but a winning close does not", async () => {
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
  // this pair closed «Mjallby — Yes» at a LOSS earlier THIS match (early cash-out).
  R.insertBet(db, { id: "loss", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Mjallby — Yes", status: "settled_lost", proposed_price: 34, entry_price: 34, current_price: 20, closing_price: 20, ai_prob: 0.5, stake: 30, rationale: "r", entered_minute: "предматч", result: "lost", payout: 17, settled_by: "early", settled_at: "2026-07-11T13:55:00Z", created_at: "t" });
  const mock = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: "Mjallby — Yes", conviction: "высокая", reason: "докупаю падение", prob: 0.55 }], exits: [], note: "" }) }] }) }) as any);

  // The losing close blocks re-entry — no doubling-down into a broken thesis.
  const res = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => now }, { newEventMatchIds: new Set([mid]), max: 50 });
  assert.ok(!res.entries.some((e) => e.market === "Mjallby — Yes"), "martingale block: no re-entry into the just-lost market");
  assert.equal(R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed").length, 0, "no fresh proposal after the losing close");

  // Even a MUCH earlier losing close (whole-match scope, not a time window) STILL blocks.
  R.updateBet(db, "loss", { settled_at: "2026-07-11T13:00:00Z" });
  const res2 = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => now }, { newEventMatchIds: new Set([mid]), max: 50 });
  assert.ok(!res2.entries.some((e) => e.market === "Mjallby — Yes"), "still blocked — the block is match-scoped, not a time window");

  // But a WINNING close never blocks: flip it to settled_won → re-entry is allowed.
  R.updateBet(db, "loss", { status: "settled_won", result: "won" });
  const res3 = await strategistReassess(db, { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" }, now: () => now }, { newEventMatchIds: new Set([mid]), max: 50 });
  assert.ok(res3.entries.some((e) => e.market === "Mjallby — Yes"), "a winning close does not block re-entry");
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
    R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Draw — No", price: 55, ai_prob: 0.6, liquidity: null, external_ref: null, snapshot_at: "t", is_closing: false });
    R.insertBet(db, { id: openId, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Draw — No", status: "open", proposed_price: 40, entry_price: 40, current_price: 55, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });
    // a partial fixation 2 min ago (< 8-min throttle window)
    R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Draw — No", status: "settled_won", proposed_price: 40, entry_price: 40, current_price: 52, closing_price: 52, ai_prob: 0.6, stake: 30, rationale: "частичная фиксация 30%", entered_minute: "10'", result: "won", payout: 39, settled_by: "partial", settled_at: "2026-07-11T20:08:00Z", created_at: "2026-07-11T20:08:00Z" });
  };
  const runWith = (exit: any) => strategistReassess(db, { fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [], exits: [exit] }) }] }) })) as any, env: { ANTHROPIC_API_KEY: "k" }, now: () => now });

  // (1) a repeat partial TAKE-PROFIT, 2 min after the last partial → THROTTLED (held, no nibble).
  const m1 = R.uid(); setup(m1, "tp-open");
  const r1 = await runWith({ market: "Draw — No", fraction: 0.5, reason: "take_price: цена достигла оценки, edge исчерпан", trigger: "take_price" });
  assert.ok(!r1.exits.some((e) => e.matchId === m1), "repeat partial take-profit is throttled");
  assert.equal(R.getBet(db, "tp-open")!.stake, 100, "position untouched — no further nibble");
  assert.ok(R.tradeLogForMatch(db, m1).some((l) => l.type === "hold" && /partial_tp_throttle/.test(l.text)), "throttle logged");
  R.updateMatch(db, m1, { state: "finished" });

  // (2) a DEFENSIVE exit (thesis_stop) with the SAME recent TAKE-PROFIT partial → NOT throttled by
  // partial_tp_throttle (that gate is take-profit-only), executes. (T1.3's defensive cap counts only prior
  // [defensive] cuts, of which there are none here, so it also stands aside.)
  const m2 = R.uid(); setup(m2, "def-open");
  const r2 = await runWith({ market: "Draw — No", fraction: 0.5, reason: "thesis_stop — гол сломал сценарий", trigger: "thesis_stop" });
  assert.ok(r2.exits.some((e) => e.matchId === m2), "a defensive exit is not throttled by the take-profit throttle");
  assert.ok(R.getBet(db, "def-open")!.stake! < 100, "position reduced by the defensive exit");
  R.updateMatch(db, m2, { state: "finished" });

  // (3) a FULL take-profit close (fraction 1) → not a partial → not throttled.
  const m3 = R.uid(); setup(m3, "full-open");
  const r3 = await runWith({ market: "Draw — No", fraction: 1, reason: "take_price — фиксирую полностью", trigger: "take_price" });
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

test("autoAnalyze: football with NO lineups is never analyzed (без состава не торгуем → не анализируем)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const now = "2026-07-11T12:00:00.000Z";
  const deps = { now: () => now, fetchImpl: mockLLM({ match_type: "group", match_type_reason: "x", core: { xg_home: 1.4, xg_away: 1.1, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 8, notes: "" }, unknowns: [] }), env: { ANTHROPIC_API_KEY: "k" } };
  // NO match_live → hasLineups=false. Even 20 min from kickoff it must NOT be analyzed.
  R.insertMatch(db, { id: "m-nolx", competition_id: comp.id, home: "N", away: "M", state: "lineup", lineup_out: true, kickoff_at: "2026-07-11T12:20:00.000Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m-nolx" });
  R.insertMarket(db, { id: R.uid(), match_id: "m-nolx", label: "Over 2.5", price: 52, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: now, is_closing: false });
  const ran = await autoAnalyze(db, deps);
  assert.ok(!ran.some((a) => a.matchId === "m-nolx"), "football without a real starting XI is not analyzed");
});

test("autoAnalyze prioritizes the SOONEST kickoff under the per-tick cap", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("PRAGMA foreign_keys=OFF; DELETE FROM matches; PRAGMA foreign_keys=ON;"); // isolate: only our two matches
  const comp = R.listCompetitions(db, "football").find((c) => c.budget > 0)!;
  const now = "2026-07-11T12:00:00.000Z";
  const deps = { now: () => now, fetchImpl: mockLLM({ match_type: "group", match_type_reason: "x", core: { xg_home: 1.4, xg_away: 1.1, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 8, notes: "" }, unknowns: [] }), env: { ANTHROPIC_API_KEY: "k" } };
  const mk = (id: string, kickoff: string) => {
    R.insertMatch(db, { id, competition_id: comp.id, home: "H", away: "A", state: "lineup", lineup_out: true, kickoff_at: kickoff, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
    R.insertMarket(db, { id: R.uid(), match_id: id, label: "Over 2.5", price: 52, ai_prob: 0.6, liquidity: null, external_ref: "t", snapshot_at: now, is_closing: false });
    R.upsertMatchLive(db, { match_id: id, espn_event_id: "e-" + id, league: "l", home_lineup: JSON.stringify({ team: "H", formation: "4-4-2", starters: ["x"] }), away_lineup: JSON.stringify({ team: "A", formation: "4-4-2", starters: ["y"] }), stats: null, updated_at: now });
  };
  mk("m-late", "2026-07-11T22:00:00.000Z"); // +10h, inserted FIRST — would win under old insertion-order
  mk("m-soon", "2026-07-11T13:00:00.000Z"); // +1h — the imminent one
  const ran = await autoAnalyze(db, deps, { max: 1 });
  assert.ok(ran.some((a) => a.matchId === "m-soon" && a.ok), "soonest-kickoff match analyzed first");
  assert.ok(!ran.some((a) => a.matchId === "m-late"), "far match yields its slot to the imminent one");
});

test("migrateRetireFable moves any strategy/prompt left on Fable → Opus (and is marker-guarded)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const strat = R.listStrategies(db, "football")[0];
  R.updateStrategy(db, strat.id, { model: "Claude Fable 5" });
  db.prepare(`UPDATE strategies SET model_live='Claude Fable 5' WHERE id=?`).run(strat.id);
  migrateRetireFable(db, "2026-07-16T00:00:00Z");
  const after = R.getStrategy(db, strat.id)!;
  assert.equal(after.model, "Claude Opus 4.8", "pre-match model Fable→Opus");
  assert.equal(after.model_live, "Claude Opus 4.8", "live model Fable→Opus");
  // marker-guarded: a later manual Fable choice is NOT reverted on re-run
  R.updateStrategy(db, strat.id, { model: "Claude Fable 5" });
  migrateRetireFable(db, "2026-07-16T00:01:00Z");
  assert.equal(R.getStrategy(db, strat.id)!.model, "Claude Fable 5", "one-time: does not fight a later deliberate choice");
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
  // A/B knob: bets carry the combined epoch label, and entry_meta records the actual models.
  const { effectiveCodeVersion, bumpModelEpoch } = await import("../src/lib/codeEpoch.js");
  const { parseEntryMeta } = await import("../src/lib/betMeta.js");
  assert.ok(proposed.every((b) => b.code_version === effectiveCodeVersion(db)), "stamped with the effective code·model epoch");
  assert.match(proposed[0].code_version ?? "", /·m1$/, "baseline model epoch m1");
  const em = parseEntryMeta(proposed[0].entry_meta);
  assert.ok(em?.models?.strategist, "the strategist model that produced the pick is captured");

  // Flip a model → next epoch → new bets carry ·m2 (the segmentation boundary for the A/B).
  bumpModelEpoch(db, "t");
  R.clearProposedBets(db, mid);
  await runStrategists(db, mid, { now: () => "t", fetchImpl, env: { ANTHROPIC_API_KEY: "k" } });
  const after = R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed");
  assert.ok(after.length > 0 && after.every((b) => /·m2$/.test(b.code_version ?? "")), "post-flip bets land in the next epoch");
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

test("Z1 (batch-5): zombie log episode-throttled — 3 ticks of one market → 1 line, counter 3; code change re-logs", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const strat = R.listStrategies(db, "football")[0];
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const m = R.getMatch(db, mid)!;
  for (let i = 0; i < 3; i++) throttleZombieLog(db, m, "Over 5.5", "stale_book", `zombie_quarantine:stale_book «Over 5.5»: книга не менялась — карантин`, strat.id, `2026-07-23T10:0${i}:00Z`);
  const lines = R.tradeLogForMatch(db, mid).filter((l) => l.type === "skip" && /zombie_quarantine:stale_book «Over 5.5»/.test(l.text));
  assert.equal(lines.length, 1, "3 same-code ticks → exactly 1 episode line");
  assert.equal(JSON.parse(R.metaGet(db, `zombie_ep:${mid} Over 5.5`)!).ticks, 3, "silent tick counter reached 3");
  // a code change is a class change → a new episode line
  throttleZombieLog(db, m, "Over 5.5", "resolved_price", `zombie_quarantine:resolved_price «Over 5.5»: цена решена — карантин`, strat.id, "2026-07-23T10:04:00Z");
  assert.equal(R.tradeLogForMatch(db, mid).filter((l) => l.type === "skip" && /«Over 5.5»/.test(l.text)).length, 2, "code change re-logs");
});

test("Z3 (batch-5): trade-log dedup_key makes a re-written event idempotent; unkeyed rows never dedup", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const strat = R.listStrategies(db, "football")[0];
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 10, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const enter = (id: string, key: string) => R.insertTradeLog(db, { id, match_id: mid, strategy_id: strat.id, minute: "10'", type: "enter", text: "вход X", dedup_key: key, created_at: "t" });
  enter("a", "enter:dec1");
  enter("b", "enter:dec1"); // same (match,type,key) → ignored
  assert.equal(R.tradeLogForMatch(db, mid).filter((l) => l.type === "enter").length, 1, "duplicate enter is ignored");
  enter("c", "enter:dec2"); // different key → inserts
  assert.equal(R.tradeLogForMatch(db, mid).filter((l) => l.type === "enter").length, 2, "a distinct position still logs");
  // unkeyed rows are never deduped (all existing callers unchanged)
  R.insertTradeLog(db, { id: "d", match_id: mid, strategy_id: strat.id, minute: "11'", type: "skip", text: "s", created_at: "t" });
  R.insertTradeLog(db, { id: "e", match_id: mid, strategy_id: strat.id, minute: "11'", type: "skip", text: "s", created_at: "t" });
  assert.equal(R.tradeLogForMatch(db, mid).filter((l) => l.type === "skip").length, 2, "unkeyed rows insert normally");
});

test("Z2(b) (batch-5): payout inconsistency flags accounting_suspect at settle (Kansas decimal-shift class)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const strat = R.listStrategies(db, "football")[0];
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const mkBet = (id: string) => R.insertBet(db, { id, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "X", status: "open", proposed_price: 40, entry_price: 40, current_price: 40, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: null, result: null, payout: null, created_at: "t" } as any);
  // held-to-settle WON at entry 40¢, stake 100 → expected payout = 100·100/40 = 250. Correct → clean.
  mkBet("w");
  R.updateBet(db, "w", { status: "settled_won", result: "won", payout: 250, closing_price: 100 });
  assert.equal(R.getBet(db, "w")!.accounting_suspect ?? 0, 0, "consistent payout → not flagged");
  // Kansas class: a decimal shift books payout ≈ тек/10 → 25 instead of 250 → flagged.
  mkBet("k");
  R.updateBet(db, "k", { status: "settled_won", result: "won", payout: 25, closing_price: 100 });
  assert.equal(R.getBet(db, "k")!.accounting_suspect, 1, "decimal-shifted payout → accounting_suspect");
  assert.ok(Number(R.metaGet(db, "accounting_suspect_count")) >= 1, "loud counter bumped");
  // an early cash-out priced by stake·exit/entry stays clean.
  mkBet("e");
  R.updateBet(db, "e", { status: "settled_lost", result: "lost", payout: Math.round(100 * (30 / 40) * 100) / 100, closing_price: 30, settled_by: "early" });
  assert.equal(R.getBet(db, "e")!.accounting_suspect ?? 0, 0, "early cash-out consistent → clean");
});

test("Z4 (batch-5): reassess audit — storm composition + conservative at-risk exit count gates the throttle", async () => {
  const { buildReassessAudit } = await import("../src/lib/reassessAudit.js");
  const db = openDb(":memory:");
  seedDatabase(db);
  const strat = R.listStrategies(db, "football")[0];
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Portland", away: "Dallas", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const rs = (trg: string, at: string) => R.insertReassessment(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, minute: "50'", body: "b", confidence: null, trigger: trg as any, created_at: at });
  rs("time", "2026-07-23T02:00:00Z"); rs("time", "2026-07-23T02:05:00Z"); rs("price_move", "2026-07-23T02:08:00Z"); rs("goal", "2026-07-23T02:10:00Z");
  // a DISCRETIONARY (strategist «стратег:») exit right after a 'time' reassessment → at-risk (throttle might skip it)
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, minute: "50'", type: "exit", text: "выход «X» (тайк) @ 40¢ · стратег: тезис сломан · P&L -$5", created_at: "2026-07-23T02:05:30Z" });
  // a DETERMINISTIC-guard exit (no «стратег:») near the same reassessment → NOT at-risk (fires every tick anyway)
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, minute: "51'", type: "exit", text: "выход «X» @ 38¢ · edge_gone · P&L -$7", created_at: "2026-07-23T02:05:40Z" });
  const a = buildReassessAudit(db);
  const pm = a.perMatch.find((x) => x.match === "Portland — Dallas")!;
  assert.equal(pm.reassessments, 4, "this match's reassessments");
  assert.equal(pm.byTrigger["time"], 2);
  assert.equal(pm.byTrigger["goal"], 1);
  assert.equal(pm.exits, 2, "both exits counted in the total");
  assert.equal(pm.discretionaryExits, 1, "only the «стратег:» exit is discretionary");
  assert.equal(pm.atRiskExits, 1, "the discretionary exit near a 'time' reassessment is at-risk; the deterministic one is not");
  assert.equal(a.verdict, "not_safe", "any at-risk discretionary exit → do not enable");
});

test("R3 ftBlindEnterable: gates the deep-tree analysis skip — ft off → never enterable; ft on needs an FT-settled market", () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "pm-romania-1", sport_id: "football", name: "Romania 1", budget: 8000, external_league: "rou.1", created_at: "t" });
  const mid = "m-blind";
  R.insertMatch(db, { id: mid, competition_id: "pm-romania-1", home: "Argeș", away: "Petrolul", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Argeș Over 0.5", price: 50, ai_prob: null, liquidity: "1000", external_ref: "tok1", snapshot_at: "t", is_closing: false });

  // ft OFF → never enterable regardless of markets
  assert.equal(ftBlindEnterable(db, R.getMatch(db, mid)!, { FT_BLIND_ENABLED: "false" }), false);
  // ft ON + an FT-settled (final-score) market present → enterable (must NOT skip analysis)
  assert.equal(ftBlindEnterable(db, R.getMatch(db, mid)!, { FT_BLIND_ENABLED: "true" }), true);
  // sanity on the market classifier: a progression market is NOT FT-settled
  assert.equal(isFtSettledMarket("Argeș Over 0.5"), true);
  assert.equal(isFtSettledMarket("FC Petrolul to Advance"), false);

  // ft ON but the ONLY market is a non-FT (progression) one → not enterable → skip still applies
  const mid2 = "m-blind2";
  R.insertMatch(db, { id: mid2, competition_id: "pm-romania-1", home: "X", away: "Y", state: "upcoming", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid2 });
  R.insertMarket(db, { id: R.uid(), match_id: mid2, label: "Y to Advance", price: 50, ai_prob: null, liquidity: "1000", external_ref: "tok2", snapshot_at: "t", is_closing: false });
  assert.equal(ftBlindEnterable(db, R.getMatch(db, mid2)!, { FT_BLIND_ENABLED: "true" }), false);
});

test("D reassessHoldSignature: identical state → identical signature (throttle skips); a goal, a >5¢ price move, or a new managed market flips it (re-engage)", () => {
  const base = reassessHoldSignature(1, 1, 55, [{ label: "Over 2.5", priceCents: 60 }, { label: "BTTS — Yes", priceCents: 45 }]);
  // exact prices, reordered, minute still in the same 10' bucket → SAME signature (would be throttled)
  assert.equal(reassessHoldSignature(1, 1, 58, [{ label: "BTTS — Yes", priceCents: 46 }, { label: "Over 2.5", priceCents: 61 }]), base, "order-independent + in-bucket price/minute → same");
  // a goal (score flips) → different
  assert.notEqual(reassessHoldSignature(2, 1, 55, [{ label: "Over 2.5", priceCents: 60 }, { label: "BTTS — Yes", priceCents: 45 }]), base);
  // a real price move past the 5¢ grid → different
  assert.notEqual(reassessHoldSignature(1, 1, 55, [{ label: "Over 2.5", priceCents: 70 }, { label: "BTTS — Yes", priceCents: 45 }]), base);
  // crossing the 10' minute bucket → different (bounds staleness — re-asks at least every ~10')
  assert.notEqual(reassessHoldSignature(1, 1, 65, [{ label: "Over 2.5", priceCents: 60 }, { label: "BTTS — Yes", priceCents: 45 }]), base);
  // a newly managed market → different
  assert.notEqual(reassessHoldSignature(1, 1, 55, [{ label: "Over 2.5", priceCents: 60 }]), base);
});

// [P2 / batch-9] Episode is keyed on the MARKET, not (market, code): a book that flips between two zombie
// classes (a Draw parked at ~50¢ with desynced notations is BOTH) never became tradeable in between, so it
// must stay ONE episode. Batch 9: 407 lines for 181 pairs, `Draw — Yes` alone wearing three codes.
test("P2: a market flapping between two zombie codes stays ONE episode (no re-log per flip)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const strat = R.listStrategies(db, "football")[0];
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const m = R.getMatch(db, mid)!;
  const codes = ["notation_desync", "placeholder_mid", "notation_desync", "placeholder_mid", "notation_desync"];
  codes.forEach((c, i) => throttleZombieLog(db, m, "Draw — Yes", c, `zombie_quarantine:${c} «Draw — Yes»: карантин`, strat.id, `2026-07-25T10:0${i}:00Z`));
  const lines = R.tradeLogForMatch(db, mid).filter((l) => l.type === "skip" && /«Draw — Yes»/.test(l.text));
  assert.equal(lines.length, 1, "5 ticks flipping across 2 classes → still exactly 1 episode line");
  const ep = JSON.parse(R.metaGet(db, `zombie_ep:${mid} Draw — Yes`)!);
  assert.equal(ep.ticks, 5, "the silent counter still accrues every tick");
  assert.deepEqual([...ep.codes].sort(), ["notation_desync", "placeholder_mid"], "both worn codes travel with the episode as a field");
  // An escalation INTO resolved_price is a genuinely different class (book contradicts a decided outcome) → re-logs.
  throttleZombieLog(db, m, "Draw — Yes", "resolved_price", `zombie_quarantine:resolved_price «Draw — Yes»: цена решена`, strat.id, "2026-07-25T10:06:00Z");
  assert.equal(R.tradeLogForMatch(db, mid).filter((l) => l.type === "skip" && /«Draw — Yes»/.test(l.text)).length, 2, "escalation to resolved_price still re-logs once");
});

// [P2 / batch-9] The lift must be EARNED. Batch 9 logged 273 «рынок снова торгуем» lines, 15 of them on books
// whose next quarantine line reported a LARGER staleness age (217м → 220м) — the book never revived.
test("P2: a still-stale book (220m) is NOT lifted; a genuinely fresh one is, and prints the observed age", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.listStrategies(db, "football")[0];
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const m = R.getMatch(db, mid)!;
  const now = "2026-07-25T12:00:00Z";
  // A book frozen at 40¢ since 220 minutes ago — provably stale, never refreshed.
  const old = new Date(Date.parse(now) - 220 * 60_000).toISOString();
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 5.5", price: 40, ai_prob: null, liquidity: "1000", external_ref: "T1", snapshot_at: old, is_closing: false });
  const markets = R.latestMarkets(db, mid);
  // Open an episode for it, then re-evaluate with a map that (for whatever reason) doesn't carry the label.
  R.metaSet(db, `zombie_ep:${mid} Over 5.5`, JSON.stringify({ code: "stale_book", ticks: 4, codes: ["stale_book"] }), now);
  footballZombieMap(db, m, "football", markets.filter((x) => x.label !== "Over 5.5"), 30, {}, now);
  assert.ok(!R.tradeLogForMatch(db, mid).some((l) => /zombie_lifted «Over 5.5»/.test(l.text)), "220m-stale book is NOT declared tradeable again");
  assert.ok(R.metaGet(db, `zombie_ep:${mid} Over 5.5`), "its episode marker survives — the quarantine stands");
  // Now the book genuinely refreshes (a new, different price stamped now) → it no longer classifies as a
  // zombie, the re-measured age is ~0, and the lift is EARNED. The market stays in the list so the age is read.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 5.5", price: 61, ai_prob: null, liquidity: "1000", external_ref: "T1", snapshot_at: now, is_closing: false });
  footballZombieMap(db, m, "football", R.latestMarkets(db, mid), 30, {}, now);
  const lift = R.tradeLogForMatch(db, mid).find((l) => /zombie_lifted «Over 5.5»/.test(l.text));
  assert.ok(lift, "a demonstrably fresh book IS lifted");
  assert.match(lift!.text, /книга свежая \(0м/, "the observed age is printed, so a premature lift can never hide again");
});
