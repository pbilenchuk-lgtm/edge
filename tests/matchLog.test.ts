import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { buildMatchLog } from "../src/lib/matchLog.js";

test("buildMatchLog: includes the shadow-budget section with verdicts, reasons, and denied P&L", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Malmo FF", away: "IFK Goteborg", state: "finished", lineup_out: true, kickoff_at: "2026-07-13T13:00:00Z", minute: 90, score_home: 2, score_away: 1, final_score: "2:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });

  // A real bet the shadow layer denied — it settled as a loss, so the denial "saved" money.
  const deniedBet = R.uid();
  R.insertBet(db, { id: deniedBet, match_id: mid, strategy_id: strat.id, risk_profile_id: "aggressive", market_label: "Over 2.5", status: "settled_lost", proposed_price: 55, entry_price: 55, current_price: 0, closing_price: 0, ai_prob: 0.5, stake: 80, rationale: "r", entered_minute: "10'", result: "lost", payout: 0, created_at: "t", settled_by: null, settled_at: "t" });

  // Shadow events: one accepted (live), one blocked by the category ceiling (the denied bet).
  R.insertShadowEvent(db, { id: R.uid(), bet_id: R.uid(), match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size_requested: 50, size_reserved: 50, verdict: "allowed", reason: null, is_live: 1, edge: 0.08, contention: 0, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.02, created_at: "2026-07-13T13:34:00Z" });
  R.insertShadowEvent(db, { id: R.uid(), bet_id: deniedBet, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "aggressive", size_requested: 80, size_reserved: 0, verdict: "blocked", reason: "cap_category", is_live: 0, edge: 0.05, contention: 1, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.03, created_at: "2026-07-13T12:31:00Z" });
  // A currently-held reserve for the match.
  R.insertShadowReserve(db, { id: R.uid(), bet_id: R.uid(), match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size: 50, is_live: 1, edge: 0.08, state: "reserved", settle_at: null, created_at: "t" });

  const log = buildMatchLog(db, mid);
  assert.match(log, /Теневой бюджет/, "shadow-budget section present");
  assert.match(log, /2 решений · запрошено \$130 → зарезервировано \$50/, "aggregate: requested vs reserved");
  assert.match(log, /заблокировано 1/, "blocked count");
  // The denied bet lost $80 → a real gate would have AVOIDED −$80: denied P&L = −80.
  assert.match(log, /ОТКАЗАЛ\/УРЕЗАЛ: -\$80/, "denied-entries real P&L reported");
  assert.match(log, /Держится сейчас по матчу: \$50/, "currently-held reserve reported");
  assert.match(log, /потолок категории=1/, "denial reason labelled");
  assert.match(log, /\*\*принят\*\*/, "per-decision verdict rendered");
  assert.match(log, /\*\*отказ\*\* · потолок категории/, "blocked decision shows its reason inline");

  // Execution-cost section: fees + slippage from the fill ledger.
  R.insertFillCost(db, { id: R.uid(), bet_id: R.uid(), match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", side: "buy", shares: 100, notional_usd: 50, quote_cents: 47, vwap_cents: 47.3, fee_cents: 0.75, fee_usd: 0.75, slip_cents: 0.3, slip_usd: 0.3, from_book: 1, created_at: "2026-07-13T13:34:00Z" });
  const log2 = buildMatchLog(db, mid);
  assert.match(log2, /Издержки исполнения/, "execution-cost section present");
  assert.match(log2, /Комиссии: \*\*\$0\.75\*\*/, "fees totalled");
  assert.match(log2, /Слиппедж: \*\*\$0\.3\*\*/, "slippage totalled");
});

test("buildMatchLog: a TRIMMED decision counts only the un-funded fraction of its P&L (audit [9])", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-07-13T13:00:00Z", minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // Requested $100, pool TRIMMED to $60 (unfunded 40%); the sim bet won +$50.
  const tb = R.uid();
  R.insertBet(db, { id: tb, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Over 1.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 100, closing_price: 100, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "10'", result: "won", payout: 150, created_at: "t", settled_by: null, settled_at: "t" });
  R.insertShadowEvent(db, { id: R.uid(), bet_id: tb, match_id: mid, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size_requested: 100, size_reserved: 60, verdict: "trimmed", reason: "cap_match", is_live: 0, edge: 0.05, contention: 0, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.02, created_at: "t" });
  const log = buildMatchLog(db, mid);
  // Un-funded fraction 0.4 × (+$50) = +$20, NOT the full +$50.
  assert.match(log, /ОТКАЗАЛ\/УРЕЗАЛ: \+\$20\b/, "trimmed denied-P&L weighted by the un-funded fraction");
});

test("buildMatchLog: says so when there are no shadow decisions for the match", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: false, kickoff_at: "2026-07-13T13:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const log = buildMatchLog(db, mid);
  assert.match(log, /Теневой бюджет/);
  // Allocator is ON by default → the empty case says "no fills yet", not the old ambiguous line.
  assert.match(log, /аллокатор включён/);
  // Turning the allocator OFF changes the empty-case message to the disabled wording.
  R.metaSet(db, "shadow_config", JSON.stringify({ enabled: false }), "2026-07-13T13:00:00Z");
  assert.match(buildMatchLog(db, mid), /аллокатор ВЫКЛЮЧЕН/);
});
