import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { buildShadowLog } from "../src/lib/shadowLog.js";

test("buildShadowLog: rolls up all decisions across matches with breakdowns + full ledger", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const m1 = R.uid(), m2 = R.uid();
  R.insertMatch(db, { id: m1, competition_id: comp.id, home: "Malmo FF", away: "IFK Goteborg", state: "finished", lineup_out: true, kickoff_at: "2026-07-13T13:00:00Z", minute: 90, score_home: 2, score_away: 1, final_score: "2:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: m1 });
  R.insertMatch(db, { id: m2, competition_id: comp.id, home: "Rosenborg", away: "Kristiansund", state: "live", lineup_out: true, kickoff_at: "2026-07-13T14:00:00Z", minute: 55, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: m2 });

  // A denied bet that lost — the denial "saved" $80.
  const deniedBet = R.uid();
  R.insertBet(db, { id: deniedBet, match_id: m1, strategy_id: strat.id, risk_profile_id: "aggressive", market_label: "Over 2.5", status: "settled_lost", proposed_price: 55, entry_price: 55, current_price: 0, closing_price: 0, ai_prob: 0.5, stake: 80, rationale: "r", entered_minute: "10'", result: "lost", payout: 0, created_at: "t", settled_by: null, settled_at: "t" });

  R.insertShadowEvent(db, { id: R.uid(), bet_id: R.uid(), match_id: m1, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", size_requested: 50, size_reserved: 50, verdict: "allowed", reason: null, is_live: 1, edge: 0.08, contention: 0, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.02, created_at: "2026-07-13T13:34:00Z" });
  R.insertShadowEvent(db, { id: R.uid(), bet_id: deniedBet, match_id: m1, competition_id: comp.id, strategy_id: strat.id, profile_id: "aggressive", size_requested: 80, size_reserved: 0, verdict: "blocked", reason: "cap_category", is_live: 0, edge: 0.05, contention: 1, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.03, created_at: "2026-07-13T12:31:00Z" });
  R.insertShadowEvent(db, { id: R.uid(), bet_id: R.uid(), match_id: m2, competition_id: comp.id, strategy_id: strat.id, profile_id: "conservative", size_requested: 30, size_reserved: 20, verdict: "trimmed", reason: "cap_strategy", is_live: 1, edge: 0.06, contention: 0, free_at: null, pool_snapshot: null, config_snapshot: null, intensity: 0.01, created_at: "2026-07-13T15:11:00Z" });

  const log = buildShadowLog(db, { now: "2026-07-13T16:00:00Z" });
  assert.match(log, /Глобальный лог теневого бюджета/);
  assert.match(log, /Решений в реестре: \*\*3\*\*/, "counts all decisions across both matches");
  assert.match(log, /всего 3 · принято 1 · заблокировано 1.*урезано 1/, "roll-up counts");
  // Denied/trimmed P&L: blocked bet lost 80 (unfunded 100%) → −80; trimmed row has no settled bet → 0.
  assert.match(log, /P&L входов, которым пул отказал\/урезал: \*\*-\$80\*\*/, "denied P&L rolled up");
  assert.match(log, /По категориям/, "per-category breakdown present");
  assert.match(log, /По стратегиям/, "per-strategy breakdown present");
  assert.match(log, /По фазе входа/, "per-phase breakdown present");
  // Full ledger names both matches by label.
  assert.match(log, /Malmo FF — IFK Goteborg/);
  assert.match(log, /Rosenborg — Kristiansund/);
  assert.match(log, /потолок категории/, "reason labelled in the ledger");
  assert.match(log, /Полный реестр решений \(3/, "full ledger, not the UI cap");

  // Execution costs roll up globally with per-category / per-strategy breakdowns.
  R.insertFillCost(db, { id: R.uid(), bet_id: R.uid(), match_id: m1, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", side: "buy", shares: 100, notional_usd: 100, quote_cents: 47, vwap_cents: 47.3, fee_cents: 0.75, fee_usd: 1, slip_cents: 0.3, slip_usd: 0.5, from_book: 1, created_at: "2026-07-13T13:34:00Z" });
  R.insertFillCost(db, { id: R.uid(), bet_id: R.uid(), match_id: m2, competition_id: comp.id, strategy_id: strat.id, profile_id: "medium", side: "sell", shares: 50, notional_usd: 50, quote_cents: 30, vwap_cents: 29, fee_cents: 0.5, fee_usd: 0.4, slip_cents: 1, slip_usd: 0.5, from_book: 0, created_at: "2026-07-13T15:12:00Z" });
  const log2 = buildShadowLog(db, { now: "2026-07-13T16:00:00Z" });
  assert.match(log2, /Издержки исполнения/, "global execution-cost section present");
  assert.match(log2, /комиссии \*\*\$1\.4\*\*/, "fees rolled up globally");
  assert.match(log2, /слиппедж \*\*\$1\*\*/, "slippage rolled up globally");
  assert.match(log2, /ВСЕГО издержек \*\*\$2\.4\*\*/, "total execution cost");
});

test("buildShadowLog: empty DB says the ledger is empty, doesn't throw", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const log = buildShadowLog(db, { now: "2026-07-13T16:00:00Z" });
  assert.match(log, /Решений в реестре: \*\*0\*\*/);
  assert.match(log, /реестр пуст/);
});
