import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { benjaminiHochberg } from "../src/lib/signals.js";
import { pearson, clvRealizedCorr, buildPortfolio } from "../src/lib/portfolio.js";

// [Phase 5.4] Benjamini-Hochberg FDR control across a grid of p-values.
test("BH: controls the false-discovery rate; nulls drop out of m; monotone q-values", () => {
  // p = [.01,.02,.03,.04,.05], m=5, q=.05: thresholds (k/5)·.05 = .01,.02,.03,.04,.05 — every p(k) ≤ its
  // threshold, so the largest passing rank is k=5 and the step-up rejects ALL five.
  const bh = benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05], 0.05);
  assert.equal(bh.m, 5);
  assert.equal(bh.rejected.filter(Boolean).length, 5, "all reject (each p ≤ its BH threshold)");
  // a grid where only one p is tiny: BH rejects just that one, not the near-1 p-values.
  const bh2 = benjaminiHochberg([0.001, 0.9, 0.8, 0.7, 0.6], 0.05);
  assert.equal(bh2.rejected[0], true, "a lone tiny p survives FDR");
  assert.equal(bh2.rejected.filter(Boolean).length, 1, "the big p-values don't");
  // a null p never rejects and doesn't count toward m
  const bh3 = benjaminiHochberg([0.001, null, null], 0.05);
  assert.equal(bh3.m, 1);
  assert.equal(bh3.qValues[1], null);
  assert.equal(bh3.rejected[0], true);
});

// [Phase 5.3] CLV→realized correlation — the decisive validation.
test("pearson / clvRealizedCorr: positive when beating close predicts P&L; null on <3 or degenerate", () => {
  assert.equal(pearson([{ x: 1, y: 1 }, { x: 2, y: 2 }]).r, null, "<3 pairs → null");
  const up = pearson([{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }]);
  assert.equal(up.r, 1, "perfect positive");
  const flat = pearson([{ x: 1, y: 5 }, { x: 2, y: 5 }, { x: 3, y: 5 }]);
  assert.equal(flat.r, null, "zero variance on y → null");
});

function seedPortfolio(db: any) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "EPL", budget: 0, external_league: "eng.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  // clean-epoch (e5) totals bets: mix of wins/losses with CLV that tracks P&L (positive corr).
  const mk = (i: number, won: boolean, clvC: number, createdAt: string) => {
    // end_time = "t" не парсится, поэтому отсечка берётся от кикоффа; линия — снимок котировки внутри окна.
    R.insertMatch(db, { id: "m" + i, competition_id: "c1", home: "H" + i, away: "A" + i, state: "finished", lineup_out: true, kickoff_at: createdAt, minute: null, score_home: null, score_away: null, final_score: "2-1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m" + i } as any);
    const stake = 100, entry = 50, close = 50 + clvC;
    // [пункт 6] Линия закрытия живёт в снимках котировок, а не в поле ставки — сеем то, что и есть линия.
    R.insertMarket(db, { id: R.uid(), match_id: "m" + i, label: "Over 2.5", price: close, ai_prob: null, liquidity: null, external_ref: null, token_second: null, snapshot_at: new Date(Date.parse(createdAt) + 110 * 60_000).toISOString(), is_closing: false } as any);
    db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,proposed_price,entry_price,current_price,closing_price,ai_prob,stake,rationale,entered_minute,result,payout,settled_by,settled_at,entry_meta,code_version,decision_id,origin,origin_source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("b" + i, "m" + i, "prematch_value", "medium", "Over 2.5", won ? "settled_won" : "settled_lost", entry, entry, entry, close, 0.6, stake, "r", "предматч", won ? "won" : "lost", won ? stake * 2 : 0, "settle", createdAt, JSON.stringify({ phase: "prematch" }), "e5", "d" + i, "prematch", "decision", createdAt);
  };
  return mk;
}

// [Phase 5.2/5.3] Portfolio: strategy×family cells on the clean epoch + CLV↔P&L + WoW + FDR.
test("portfolio: builds a strategy×family cell, computes CLV↔realized corr, WoW split, and an FDR pass", () => {
  const db = openDb(":memory:"); initSchema(db);
  const mk = seedPortfolio(db);
  const now = Date.parse("2026-07-25T00:00:00Z");
  const thisW = "2026-07-22T00:00:00Z";   // within 7d
  const priorW = "2026-07-14T00:00:00Z";  // 7–14d ago
  // winners had positive CLV, losers negative → CLV predicts P&L (positive corr).
  mk(1, true, 8, thisW); mk(2, true, 6, thisW); mk(3, false, -5, thisW);
  mk(4, true, 7, priorW); mk(5, false, -4, priorW); mk(6, false, -6, priorW);
  const pf = buildPortfolio(db, { nowMs: now });
  assert.equal(pf.cleanEpochFloor, 5, "clean-epoch floor is the default scope");
  const cell = pf.cells.find((c) => c.strategyId === "prematch_value" && c.family === "totals");
  assert.ok(cell, "a prematch_value×totals cell exists");
  assert.ok(cell!.nSignals >= 6, "six distinct signals collapsed");
  assert.ok((cell!.clvRealizedCorr.r ?? 0) > 0, "CLV tracks realized P&L → positive correlation");
  assert.ok((pf.clvRealizedCorrOverall.r ?? 0) > 0, "overall correlation positive");
  // WoW: this-week vs prior-week P&L delta is present and numeric.
  assert.equal(typeof cell!.wow.pnlDeltaUsd, "number");
  assert.equal(cell!.wow.thisPnlUsd, 100, "this week net: +100 +100 −100 = +100");
  assert.equal(cell!.wow.priorPnlUsd, -100, "prior week net: +100 −100 −100 = −100");
  // FDR machinery ran across the grid.
  assert.ok(pf.fdr.m >= 1);
  assert.ok(pf.multipleTestingNote.includes("Benjamini-Hochberg"));
});

// [Phase 5.5 / M10] includeAllEpochs override keeps dirty rows; default drops them.
test("portfolio: pre-clean-epoch rows are dropped by default, kept under includeAllEpochs", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "EPL", budget: 0, external_league: "eng.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "md", competition_id: "c1", home: "H", away: "A", state: "finished", lineup_out: true, kickoff_at: "2026-07-01T00:00:00Z", minute: null, score_home: null, score_away: null, final_score: "1-0", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: "md" } as any);
  // an e3 (pre-clean) bet — below the e5 floor.
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,proposed_price,entry_price,current_price,closing_price,ai_prob,stake,rationale,entered_minute,result,payout,settled_by,settled_at,entry_meta,code_version,decision_id,origin,origin_source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("bd", "md", "prematch_value", "medium", "Over 2.5", "settled_won", 50, 50, 50, 55, 0.6, 100, "r", "предматч", "won", 200, "settle", "2026-07-01T00:00:00Z", JSON.stringify({ phase: "prematch" }), "e3", "dd", "prematch", "decision", "2026-07-01T00:00:00Z");
  const now = Parse("2026-07-25T00:00:00Z");
  const clean = buildPortfolio(db, { nowMs: now });
  assert.equal(clean.cells.length, 0, "the e3 bet is below the clean floor → no cell");
  const dirty = buildPortfolio(db, { nowMs: now, filter: { includeAllEpochs: true } });
  assert.equal(dirty.cleanEpochFloor, null, "override → no floor reported");
  assert.ok(dirty.cells.length >= 1, "includeAllEpochs keeps the e3 bet");
});

function Parse(s: string) { return Date.parse(s); }
