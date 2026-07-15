import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { serializeEntryMeta, CODE_VERSION, type BetEntryMeta } from "../src/lib/betMeta.js";
import { betRecords, profileComparison, edgeZones, calibration, EDGE_ZONES, classifyExitTrigger } from "../src/lib/profileAnalytics.js";
import { betsCsv, exitsCsv, BET_EXPORT_COLUMNS } from "../src/lib/profileExport.js";

function setup() {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  return { db, comp, strat };
}
const meta = (o: Partial<BetEntryMeta>): string => serializeEntryMeta({ phase: "prematch", minute: null, scoreHome: null, scoreAway: null, edge: 0.04, aiProb: 0.55, derivedProb: 0.55, marketPrice: 50, impliedProb: 0.5, liveProbAdjusted: null, kellyFraction: 0.2, sizeRequested: 100, sizeFilled: 100, entrySlipCents: 0.5, calibration: 0.6, branchWeightSum: 0.7, phantomCheck: null, marketThinnessUsd: 8000, winsOnEvent: false, exitPlan: null, ...o });
const bet = (o: any) => ({ risk_profile_id: "medium", proposed_price: 50, closing_price: null, rationale: "r", entered_minute: "предматч", result: null, payout: null, settled_by: null, settled_at: null, current_price: null, entry_meta: null, code_version: CODE_VERSION, created_at: "t", ...o });

test("classifyExitTrigger: honest trigger categories", () => {
  assert.equal(classifyExitTrigger("плановый тайм-стоп (time_stop·medium)", "early"), "time_stop");
  assert.equal(classifyExitTrigger("тайм-флор истёк (time_decay_floor)", "early"), "time_decay_floor");
  assert.equal(classifyExitTrigger("контр-ветка", "early"), "counter_scenario");
  assert.equal(classifyExitTrigger("гол сломал тезис", "early"), "thesis_stop");
  assert.equal(classifyExitTrigger("тейк на пике", "early"), "take_price");
  assert.equal(classifyExitTrigger("хард-стоп −44%", "early"), "hard_stop");
  assert.equal(classifyExitTrigger("выигрыш → сеттл", null), "settle");
  assert.equal(classifyExitTrigger("что-то", "early"), "discretionary");
});

test("CLV is close − entry for a Yes-side AND a No-side market (audit: both directions)", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 2, score_away: 0, final_score: "2:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // Yes side: bought "Over 1.5" at 40¢, closing (T-0) 55¢ → CLV +15¢ (market moved our way).
  R.insertBet(db, bet({ id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "Over 1.5", status: "settled_won", entry_price: 40, closing_price: 55, ai_prob: 0.6, stake: 100, result: "won", payout: 250, settled_at: "t", entry_meta: meta({ winsOnEvent: true }) }));
  // No side: bought "BTTS — No" at 60¢, closing 52¢ → CLV −8¢ (moved against us).
  R.insertBet(db, bet({ id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "BTTS — No", status: "settled_lost", entry_price: 60, closing_price: 52, ai_prob: 0.55, stake: 100, result: "lost", payout: 0, settled_at: "t", entry_meta: meta({}) }));
  const recs = betRecords(db);
  const yes = recs.find((r) => r.market === "Over 1.5")!;
  const no = recs.find((r) => r.market === "BTTS — No")!;
  assert.equal(yes.clvCents, 15, "Yes side: 55−40 = +15¢");
  assert.equal(no.clvCents, -8, "No side: 52−60 = −8¢ (same-side by construction)");
});

test("breakeven realize (settled_void + result null) classifies as void — never a win in hitRate", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 1, score_away: 1, final_score: "1:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // A real win, a real loss, and a BREAKEVEN early cash-out (payout == stake → settled_void/result null).
  R.insertBet(db, bet({ id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "W", status: "settled_won", entry_price: 40, closing_price: 55, ai_prob: 0.6, stake: 100, result: "won", payout: 250, settled_by: "early", settled_at: "t", entry_meta: meta({}) }));
  R.insertBet(db, bet({ id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "L", status: "settled_lost", entry_price: 60, closing_price: 52, ai_prob: 0.55, stake: 100, result: "lost", payout: 0, settled_by: "early", settled_at: "t", entry_meta: meta({}) }));
  R.insertBet(db, bet({ id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: "PUSH", status: "settled_void", entry_price: 44, closing_price: 44, ai_prob: 0.5, stake: 100, result: null, payout: 100, settled_by: "early", settled_at: "t", entry_meta: meta({}) }));
  const recs = betRecords(db);
  assert.equal(recs.find((r) => r.market === "PUSH")!.outcome, "void", "breakeven → void, not lost");
  // Every hit-rate consumer bins on outcome won/lost and drops "void" — so the push is out of both.
  const wl = recs.filter((r) => r.outcome === "won" || r.outcome === "lost");
  assert.equal(wl.length, 2, "only the real win + real loss enter the win/lost bins");
  assert.equal((wl.filter((r) => r.outcome === "won").length / wl.length) * 100, 50, "hitRate = 1/2 = 50%, push excluded");
});

test("edge zones don't lose bets: Σ zone N = total with an edge", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const edges = [0.025, 0.04, 0.06, 0.085, 0.15, 0.03]; // one per zone + an extra 3–5
  edges.forEach((e, i) => R.insertBet(db, bet({ id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: `M${i}`, status: i % 2 ? "settled_won" : "settled_lost", entry_price: 50, closing_price: 50, ai_prob: 0.5 + e, stake: 100, result: i % 2 ? "won" : "lost", payout: i % 2 ? 200 : 0, settled_at: "t", entry_meta: meta({ edge: e }) })));
  const recs = betRecords(db);
  const z = edgeZones(recs).all;
  const sumN = z.reduce((s, x) => s + x.n, 0);
  const withEdge = recs.filter((r) => r.edge != null && r.edge >= EDGE_ZONES[0].lo).length;
  assert.equal(sumN, withEdge, "every bet with a valid edge lands in exactly one zone");
  assert.equal(sumN, edges.length);
});

test("calibration bins: predicted mean, actual frequency and N are correct on synthetic data", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // Four bets in the 0.6–0.7 bin: predicted 0.65, two win / two lose → actual 0.5.
  const setBets: [number, "won" | "lost"][] = [[0.62, "won"], [0.64, "won"], [0.66, "lost"], [0.68, "lost"]];
  setBets.forEach(([p, res], i) => R.insertBet(db, bet({ id: R.uid(), match_id: mid, strategy_id: strat.id, market_label: `C${i}`, status: res === "won" ? "settled_won" : "settled_lost", entry_price: 50, closing_price: 50, ai_prob: p, stake: 100, result: res, payout: res === "won" ? 200 : 0, settled_at: "t", entry_meta: meta({ aiProb: p }) })));
  const cal = calibration(betRecords(db), 10);
  const bin = cal.bins[6]; // 0.6–0.7
  assert.equal(bin.n, 4);
  assert.ok(Math.abs((bin.predicted ?? 0) - 0.65) < 0.02, "predicted mean ≈ 0.65");
  assert.equal(bin.actual, 0.5, "actual frequency = 2/4");
  // Brier = mean((p−o)^2): (0.62-1)²+(0.64-1)²+(0.66-0)²+(0.68-0)² /4
  const expected = ((0.62 - 1) ** 2 + (0.64 - 1) ** 2 + 0.66 ** 2 + 0.68 ** 2) / 4;
  assert.ok(Math.abs((cal.brier ?? 0) - expected) < 1e-3, "Brier matches the hand calc");
});

test("profileComparison: shared picks compared across profiles (ROI, drawdown, streak)", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertBet(db, bet({ id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "aggressive", market_label: "M", status: "settled_won", entry_price: 50, closing_price: 50, ai_prob: 0.6, stake: 100, result: "won", payout: 180, settled_at: "t", entry_meta: meta({}) }));
  R.insertBet(db, bet({ id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "conservative", market_label: "M", status: "settled_lost", entry_price: 50, closing_price: 50, ai_prob: 0.6, stake: 40, result: "lost", payout: 0, settled_at: "t", entry_meta: meta({}) }));
  const cmp = profileComparison(betRecords(db));
  const agg = cmp.find((p) => p.profileId === "aggressive")!;
  const con = cmp.find((p) => p.profileId === "conservative")!;
  assert.equal(agg.pnl, 80); assert.equal(agg.roi, 80);
  assert.equal(con.pnl, -40); assert.equal(con.maxDrawdown, 40); assert.equal(con.longestLossStreak, 1);
});

test("export: bets CSV carries every Part-1 column and one row per bet", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertBet(db, bet({ id: "b1", match_id: mid, strategy_id: strat.id, market_label: "Over 1.5", status: "settled_won", entry_price: 40, closing_price: 55, ai_prob: 0.6, stake: 100, result: "won", payout: 250, settled_at: "t", entry_meta: meta({ edge: 0.09, kellyFraction: 0.25 }) }));
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, minute: "финал", type: "exit", text: `выход «Over 1.5»: выигрыш → $250 (P&L +$150.00)`, created_at: "t" });
  const csv = betsCsv(db);
  const [header, ...rows] = csv.replace(/^﻿/, "").split("\n");
  for (const col of ["edge_at_entry", "ai_prob_at_entry", "derived_prob_at_entry", "market_price_at_entry", "clv_cents", "kelly_fraction", "size_filled", "code_version", "outcome", "pnl_net", "exit_triggers"])
    assert.ok(header.split(",").includes(col), `column ${col} present`);
  assert.equal(header.split(",").length, BET_EXPORT_COLUMNS.length);
  assert.equal(rows.filter(Boolean).length, 1, "one row per bet");
  assert.match(csv, /b1/); assert.match(csv, /settle/);
  const exitsCsvOut = exitsCsv(db);
  assert.match(exitsCsvOut, /Over 1\.5/);
});
