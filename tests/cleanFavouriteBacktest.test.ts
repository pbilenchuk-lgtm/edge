import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildCleanFavouriteBacktest } from "../src/lib/cleanFavouriteBacktest.js";

const NOW = "2026-07-24T12:00:00.000Z";
function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "bra", sport_id: "football", name: "Brasileirão", budget: 1000, external_league: "bra.1", created_at: NOW });
  return db;
}
function finished(db: any, id: string, home: string, away: string, sh: number, sa: number) {
  R.insertMatch(db, { id, competition_id: "bra", home, away, state: "finished", lineup_out: true, kickoff_at: NOW, minute: 90, score_home: sh, score_away: sa, final_score: `${sh}:${sa}`, kickoff_time: null, end_time: NOW, duration: null, end_note: null, external_ref: id } as any);
}
// a clean-favourite market: derived prob %, price cents, liquid, non-closing.
function favMkt(db: any, matchId: string, label: string, probPct: number, priceCents: number, liq = 5000) {
  R.insertMarket(db, { id: R.uid(), match_id: matchId, label, price: priceCents, ai_prob: probPct / 100, liquidity: String(liq), external_ref: "TOK-" + R.uid().slice(0, 6), token_second: null, snapshot_at: NOW, is_closing: false } as any);
}

test("cleanFavourite: only ≥70% liquid consistent prematch markets enter the cohort; would-be P&L resolves", () => {
  const db = seed();
  finished(db, "m1", "Flamengo", "Cuiabá", 2, 0); // "Flamengo" moneyline (home win) resolves WON
  favMkt(db, "m1", "Flamengo", 78, 60);            // clean favourite, backed @60¢, won → +$0.667
  favMkt(db, "m1", "Cuiabá", 15, 15);              // 15% < 70% → not in cohort
  favMkt(db, "m1", "Over 2.5", 80, 55, 100);       // 80% but liquidity 100 < 500 floor → excluded
  const r = buildCleanFavouriteBacktest(db, { minProbPct: 70, minBookUsd: 500, feePct: 2 });
  assert.equal(r.all.n, 1, "exactly one clean-favourite candidate");
  assert.equal(r.all.wins, 1);
  assert.ok(Math.abs((r.all.meanReturnPct ?? 0) - 66.7) < 1, "won @60¢ → +66.7% per $1");
  assert.equal(r.abstained.n, 1, "no bet placed on it → abstained cohort");
});

test("cleanFavourite: verdict is 'insufficient' below n≥50 and names the Botafogo–Vitória control", () => {
  const db = seed();
  finished(db, "bv", "Botafogo", "Vitória", 0, 0); // the mandatory control: a 0:0
  favMkt(db, "bv", "Botafogo", 75, 55);            // model 75% favourite that did NOT win (0:0) → lost
  const r = buildCleanFavouriteBacktest(db, { minProbPct: 70, minBookUsd: 500 });
  assert.equal(r.verdict, "insufficient", "n < 50 → hypothesis premature");
  assert.equal(r.control.length, 1, "Botafogo–Vitória captured as the control");
  assert.equal(r.control[0].outcome, "lost", "the 75% favourite lost the 0:0 — the gate's point");
});

test("cleanFavourite: an entered clean favourite lands in the entered cohort, not abstained", () => {
  const db = seed();
  finished(db, "m2", "Palmeiras", "Goiás", 1, 0);
  favMkt(db, "m2", "Palmeiras", 82, 62);
  const strat = R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: NOW } as any);
  void strat;
  R.insertBet(db, { id: R.uid(), match_id: "m2", strategy_id: "prematch_value", risk_profile_id: "medium", market_label: "Palmeiras", status: "settled_won", proposed_price: 62, entry_price: 62, current_price: 100, closing_price: 62, ai_prob: 0.82, stake: 50, rationale: "r", entered_minute: "предматч", result: "won", payout: 80, decision_id: null, created_at: NOW } as any);
  const r = buildCleanFavouriteBacktest(db, { minProbPct: 70, minBookUsd: 500 });
  assert.equal(r.entered.n, 1, "the market we actually bet is in the entered cohort");
  assert.equal(r.abstained.n, 0);
});
