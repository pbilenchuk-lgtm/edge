import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { seedDatabase } from "../src/lib/seed.js";
import { meltingOptionCutReport, classifyCutReason } from "../src/lib/meltReport.js";

function setup() {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  return { db, comp, strat };
}

test("classifyCutReason: maps exit text to a coarse category", () => {
  assert.equal(classifyCutReason("плановый тайм-стоп (time_stop)"), "time_stop");
  assert.equal(classifyCutReason("матч ушёл в контр-ветку"), "counter_scenario");
  assert.equal(classifyCutReason("гол сломал тезис"), "thesis_stop");
  assert.equal(classifyCutReason("edge закрыт, цена пришла к оценке — фиксирую"), "take_price");
  assert.equal(classifyCutReason("хард-стоп −44%"), "stop");
  assert.equal(classifyCutReason("что-то иное"), "other");
});

test("meltingOptionCutReport: flags an event that occurred after an early cut, buckets by minute", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Argentina", away: "Switzerland", state: "finished", lineup_out: true, kickoff_at: "2026-07-06T18:00:00Z", minute: 90, score_home: 1, score_away: 1, final_score: "1:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // A melting option (Switzerland Over 0.5) cut early at 40¢ on 54'; market ended at 96¢.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Switzerland Over 0.5", price: 96, ai_prob: 0.5, liquidity: "2000", external_ref: "T", snapshot_at: "2026-07-06T19:40:00Z", is_closing: true });
  const bid = R.uid();
  R.insertBet(db, { id: bid, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Switzerland Over 0.5", status: "settled_lost", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: 40, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "предматч", result: "lost", payout: 72.73, created_at: "t", settled_by: "early", settled_at: "2026-07-06T18:54:00Z" });
  // The exit log carries the cut minute + reason.
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, minute: "54'", type: "exit", text: `выход «Switzerland Over 0.5» @ 40¢ · edge закрыт, цена пришла к оценке (take_price) · P&L -$27.27`, created_at: "t" });

  const rep = meltingOptionCutReport(db);
  assert.equal(rep.total, 1, "the early-closed melting option is counted");
  const cut = rep.cuts[0];
  assert.equal(cut.market, "Switzerland Over 0.5");
  assert.equal(cut.cutCents, 40);
  assert.equal(cut.cutMinute, 54, "minute read from the exit log");
  assert.equal(cut.reason, "take_price");
  assert.equal(cut.finalCents, 96);
  assert.equal(cut.eventOccurred, true, "final 96¢ ≥ threshold → event occurred after the cut");
  assert.equal(cut.missedDeltaCents, 56, "left 96−40 = 56¢ on the table");
  assert.equal(cut.bucket, "<60");
  assert.equal(rep.occurred, 1);
  assert.equal(rep.occurredFraction, 1);
  assert.equal(rep.avgMissedDeltaWhenOccurred, 56);
  assert.equal(rep.byBucket.find((b) => b.bucket === "<60")!.occurred, 1);
});

test("meltingOptionCutReport: a cut whose event did NOT occur is counted but not 'occurred'", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-07-06T18:00:00Z", minute: 90, score_home: 2, score_away: 0, final_score: "2:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  // Cut "B Over 0.5" at 70¢ on 78'; B never scored → market ended at 3¢.
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "B Over 0.5", price: 3, ai_prob: 0.4, liquidity: "1000", external_ref: "T", snapshot_at: "t2", is_closing: true });
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "B Over 0.5", status: "settled_won", proposed_price: 55, entry_price: 55, current_price: 70, closing_price: 70, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "предматч", result: "won", payout: 127, created_at: "t", settled_by: "partial", settled_at: "2026-07-06T19:18:00Z" });
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, minute: "78'", type: "exit", text: `выход «B Over 0.5» @ 70¢ · тейк на пике (take_price) · P&L +$15.00`, created_at: "t" });

  const rep = meltingOptionCutReport(db);
  assert.equal(rep.total, 1);
  assert.equal(rep.cuts[0].eventOccurred, false, "final 3¢ → event did not occur");
  assert.equal(rep.cuts[0].bucket, "75+");
  assert.equal(rep.occurred, 0);
  assert.equal(rep.occurredFraction, 0);
});

test("meltingOptionCutReport: unknown-minute cut goes to its own bucket, not '<60' (audit [11])", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  // No kickoff_at → can't estimate the minute; exit log has no parseable minute either.
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: null, minute: 90, score_home: 0, score_away: 0, final_score: "0:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "A Over 0.5", price: 5, ai_prob: 0.4, liquidity: "1000", external_ref: "T", snapshot_at: "t", is_closing: true });
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "A Over 0.5", status: "settled_lost", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: 40, ai_prob: 0.4, stake: 100, rationale: "r", entered_minute: "предматч", result: "lost", payout: 60, created_at: "t", settled_by: "early", settled_at: null });
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, minute: null, type: "exit", text: `выход «A Over 0.5» @ 40¢ · edge закрыт (take_price)`, created_at: "t" });

  const rep = meltingOptionCutReport(db);
  assert.equal(rep.total, 1);
  assert.equal(rep.cuts[0].cutMinute, null, "minute could not be determined");
  assert.equal(rep.cuts[0].bucket, "unknown", "unknown-minute cut is NOT lumped into <60");
  assert.equal(rep.byBucket.find((b) => b.bucket === "<60")!.cuts, 0, "the <60 bucket stays clean");
});

test("meltingOptionCutReport: exit matched by strategy_id, not label alone (audit [12])", () => {
  const { db, comp, strat } = setup();
  const strat2 = R.listStrategies(db, "football")[1] ?? strat;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-07-06T18:00:00Z", minute: 90, score_home: 1, score_away: 1, final_score: "1:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "B Over 0.5", price: 96, ai_prob: 0.5, liquidity: "2000", external_ref: "T", snapshot_at: "t", is_closing: true });
  // Strategy 1 cut at 40¢ on 50'; strategy 2 cut at 41¢ on 80' — both on the SAME label.
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "B Over 0.5", status: "settled_lost", proposed_price: 55, entry_price: 55, current_price: 40, closing_price: 40, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "предматч", result: "lost", payout: 72, created_at: "t", settled_by: "early", settled_at: "t" });
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, minute: "50'", type: "exit", text: `выход «B Over 0.5» @ 40¢ · edge закрыт (take_price)`, created_at: "t" });
  if (strat2.id !== strat.id) {
    R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat2.id, risk_profile_id: "medium", market_label: "B Over 0.5", status: "settled_lost", proposed_price: 55, entry_price: 55, current_price: 41, closing_price: 41, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "предматч", result: "lost", payout: 74, created_at: "t", settled_by: "early", settled_at: "t" });
    R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: strat2.id, minute: "80'", type: "exit", text: `выход «B Over 0.5» @ 41¢ · тайм-флор (stop)`, created_at: "t" });
    const rep = meltingOptionCutReport(db);
    const s1 = rep.cuts.find((c) => c.cutCents === 40)!;
    const s2 = rep.cuts.find((c) => c.cutCents === 41)!;
    assert.equal(s1.cutMinute, 50, "strategy 1 keeps its own 50' cut");
    assert.equal(s2.cutMinute, 80, "strategy 2 keeps its own 80' cut (not cross-attributed)");
  }
});

test("meltingOptionCutReport: only EARLY/partial melting options are included (not settled-by-result, not directional)", () => {
  const { db, comp, strat } = setup();
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-07-06T18:00:00Z", minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Under 2.5", price: 90, ai_prob: 0.5, liquidity: "1000", external_ref: "T1", snapshot_at: "t", is_closing: true });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "A Over 0.5", price: 99, ai_prob: 0.6, liquidity: "1000", external_ref: "T2", snapshot_at: "t", is_closing: true });
  // (1) Under 2.5 — a melting option? No: winsOnEventOccurrence=false (loses on the event). Excluded.
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Under 2.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 60, closing_price: 60, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: "won", payout: 120, created_at: "t", settled_by: "early", settled_at: "t" });
  // (2) A Over 0.5 melting option but settled BY RESULT (settled_by null) — not an early cut. Excluded.
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "A Over 0.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 100, closing_price: 100, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "10'", result: "won", payout: 200, created_at: "t", settled_by: null, settled_at: "t" });

  const rep = meltingOptionCutReport(db);
  assert.equal(rep.total, 0, "neither a non-melting market nor a result-settled position is a cut");
});
