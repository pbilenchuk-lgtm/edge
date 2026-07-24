import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { canonicalizeDrawForMatch, buildDrawNotationEmpirics, drawCanonConfig } from "../src/lib/drawCanon.js";

const NOW = "2026-07-20T12:00:00.000Z";
function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: NOW } as any);
  R.upsertCompetition(db, { id: "mkd", sport_id: "football", name: "Macedonia 1", budget: 1000, external_league: "mkd.1", created_at: NOW });
  return db;
}
function mkt(db: any, matchId: string, label: string, price: number, liquidity: string | null = null, at = "t1") {
  R.insertMarket(db, { id: R.uid(), match_id: matchId, label, price, ai_prob: price / 100, liquidity, external_ref: "TOK-" + R.uid().slice(0, 6), token_second: null, snapshot_at: at, is_closing: false, ask_cents: null, spread_cents: null } as any);
}
function match(db: any, id: string, home: string, away: string, sh: number | null = null, sa: number | null = null) {
  R.insertMatch(db, { id, competition_id: "mkd", home, away, state: sh == null ? "upcoming" : "finished", lineup_out: true, kickoff_at: NOW, minute: null, score_home: sh, score_away: sa, final_score: sh == null ? null : `${sh}:${sa}`, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
}

test("drawCanon: Vardar 20.5/38.5/50 — sum-anchor selects the coherent book, tags the rest 'different condition'", () => {
  const db = seed();
  match(db, "m-vardar", "Vardar", "Shkendija");
  // market 1X2 legs: home 45¢, away 30¢ → a consistent draw sits in [100-45-30 .. 115-45-30] = [25..40].
  mkt(db, "m-vardar", "Vardar", 45);
  mkt(db, "m-vardar", "Shkendija", 30);
  // three desynced draw notations — the Vardar case.
  mkt(db, "m-vardar", "Draw — Yes", 20.5);   // sum 95.5 → below 100 → inconsistent (HT-contract-like)
  mkt(db, "m-vardar", "Draw (Vardar vs. Shkendija) — Yes", 38.5); // sum 113.5 → in band → the canon
  mkt(db, "m-vardar", "Ничья Да", 50);       // sum 125 → above band → incoherent

  const res = canonicalizeDrawForMatch(db, "m-vardar")!;
  assert.equal(res.verdict, "canon");
  assert.equal(res.canon?.priceCents, 38.5, "the 38.5 book is the only 1X2-sum-consistent draw");
  assert.equal(res.anchorOk, true);
  assert.deepEqual(res.mirrors.sort(), ["Draw — Yes", "Ничья Да"].sort());
  assert.equal(res.candidates.find((c) => c.priceCents === 20.5)!.consistent, false);
  assert.equal(res.candidates.find((c) => c.priceCents === 50)!.consistent, false);
});

test("drawCanon: no sum-consistent candidate → quarantine (whole draw group incoherent)", () => {
  const db = seed();
  match(db, "m2", "Alfa", "Beta");
  mkt(db, "m2", "Alfa", 45); mkt(db, "m2", "Beta", 30);
  mkt(db, "m2", "Draw — Yes", 5);   // sum 80
  mkt(db, "m2", "Ничья Да", 60);    // sum 135 — both out of band
  const res = canonicalizeDrawForMatch(db, "m2")!;
  assert.equal(res.verdict, "quarantine");
  assert.equal(res.canon, null);
  assert.equal(res.mirrors.length, 2);
});

test("drawCanon: no 1X2 anchor (missing legs) → quarantine, never guesses from derived", () => {
  const db = seed();
  match(db, "m3", "A", "B");
  mkt(db, "m3", "Draw — Yes", 20.5); mkt(db, "m3", "Ничья Да", 38.5); // draws only, no home/away legs
  const res = canonicalizeDrawForMatch(db, "m3")!;
  assert.equal(res.verdict, "quarantine");
  assert.equal(res.anchorOk, false);
});

test("drawCanon: single draw notation → null (no desync to resolve)", () => {
  const db = seed();
  match(db, "m4", "A", "B");
  mkt(db, "m4", "A", 45); mkt(db, "m4", "B", 30); mkt(db, "m4", "Draw — Yes", 25);
  assert.equal(canonicalizeDrawForMatch(db, "m4"), null);
});

test("drawCanon: fresher snapshot wins among sum-consistent candidates", () => {
  const db = seed();
  match(db, "m5", "Alfa", "Beta");
  mkt(db, "m5", "Alfa", 45); mkt(db, "m5", "Beta", 30);
  mkt(db, "m5", "Draw — Yes", 30, "5000", "t1");             // consistent (sum 105), older
  mkt(db, "m5", "Draw (Alfa vs. Beta) — Yes", 32, "100", "t9");    // consistent (sum 107), newer → wins
  const res = canonicalizeDrawForMatch(db, "m5")!;
  assert.equal(res.verdict, "canon");
  assert.equal(res.canon?.priceCents, 32, "newer snapshot beats older even with less volume");
});

// ── empirical pass ────────────────────────────────────────────────────────────
function settledDrawBet(db: any, matchId: string, label: string, status: "settled_won" | "settled_lost", settledBy: string | null = null) {
  const id = R.uid();
  R.insertBet(db, { id, match_id: matchId, strategy_id: "prematch_value", risk_profile_id: "medium", market_label: label, status: "open", proposed_price: 30, entry_price: 30, current_price: 30, closing_price: null, ai_prob: 0.3, stake: 40, rationale: "r", entered_minute: null, result: null, payout: null, decision_id: id, created_at: NOW } as any);
  db.prepare(`UPDATE bets SET status=?, settled_by=? WHERE id=?`).run(status, settledBy, id);
}

test("drawEmpirics: all draw bets resolve as a 90'-draw contract must → model_confirmed", () => {
  const db = seed();
  drawCanonConfig({ FOOTBALL_DRAW_EMPIRICS_MIN: "3" });
  match(db, "e1", "A", "B", 1, 1); // a real 90' draw
  match(db, "e2", "C", "D", 2, 0); // not a draw
  settledDrawBet(db, "e1", "Draw — Yes", "settled_won");  // draw, yes → won ✓
  settledDrawBet(db, "e2", "Draw — Yes", "settled_lost"); // not draw, yes → lost ✓
  settledDrawBet(db, "e2", "Draw — No", "settled_won");   // not draw, no → won ✓
  const r = buildDrawNotationEmpirics(db, { FOOTBALL_DRAW_EMPIRICS_MIN: "3" });
  assert.equal(r.agree, 3);
  assert.equal(r.disagree, 0);
  assert.equal(r.verdict, "model_confirmed");
});

test("drawEmpirics: a draw bet that resolves AGAINST the 90'-draw truth → distinct_contracts", () => {
  const db = seed();
  match(db, "e3", "A", "B", 2, 1); // NOT a 90' draw
  // three clean agreements + one anomaly: a "Draw — Yes" that WON on a non-draw final → different contract.
  match(db, "e4", "C", "D", 1, 1);
  settledDrawBet(db, "e4", "Draw — Yes", "settled_won");
  settledDrawBet(db, "e3", "Draw — Yes", "settled_lost");
  settledDrawBet(db, "e3", "Draw — No", "settled_won");
  settledDrawBet(db, "e3", "Draw — Yes", "settled_won"); // anomaly: won though 2:1 is no draw
  const r = buildDrawNotationEmpirics(db, { FOOTBALL_DRAW_EMPIRICS_MIN: "3" });
  assert.equal(r.disagree, 1);
  assert.equal(r.verdict, "distinct_contracts");
  assert.equal(r.disagreements[0].label, "Draw — Yes");
});

test("drawEmpirics: cash-outs excluded; below threshold → insufficient", () => {
  const db = seed();
  match(db, "e5", "A", "B", 1, 1);
  settledDrawBet(db, "e5", "Draw — Yes", "settled_won", "early"); // cash-out — excluded
  const r = buildDrawNotationEmpirics(db, { FOOTBALL_DRAW_EMPIRICS_MIN: "5" });
  assert.equal(r.settledDrawBets, 0);
  assert.equal(r.verdict, "insufficient");
});
