import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildCapacityCurve } from "../src/lib/capacityCurve.js";
import { CODE_VERSION } from "../src/lib/betMeta.js";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  for (const id of ["overreaction", "prematch_value"]) R.insertStrategy(db, { id, sport_id: "football", name: id, tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}
const bet = (db: any, o: { strat: string; cv: string; status: string; entry: number; stake: number; result: string | null }) => {
  const id = R.uid();
  R.insertBet(db, { id, match_id: "m1", strategy_id: o.strat, risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: o.entry, entry_price: o.entry, current_price: o.entry, closing_price: null, ai_prob: 0.6, stake: o.stake, rationale: "r", entered_minute: "10'", result: null, payout: null, code_version: o.cv, created_at: "t" } as any);
  db.prepare(`UPDATE bets SET status=?, result=?, payout=? WHERE id=?`).run(o.status, o.result, o.result === "won" ? o.stake * 100 / o.entry : 0, id);
  return id;
};
const fill = (db: any, betId: string, slipCents: number, notional: number) =>
  R.insertFillCost(db, { id: R.uid(), bet_id: betId, match_id: "m1", competition_id: "epl", strategy_id: "overreaction", profile_id: "medium", side: "buy", shares: notional * 2, notional_usd: notional, quote_cents: 50, vwap_cents: 50 + slipCents, fee_cents: 0, fee_usd: 0, slip_cents: slipCents, slip_usd: 0, from_book: 1, created_at: "t" } as any);

test("capacity: verdict = Overreaction on the current epoch; c from its OWN fills; PMV is diagnostic-only", () => {
  const db = seed();
  const E = CODE_VERSION; // current epoch
  // Overreaction on the current epoch — the verdict segment.
  const a = bet(db, { strat: "overreaction", cv: `${E}·m1`, status: "settled_won", entry: 50, stake: 100, result: "won" }); fill(db, a, 2, 100);
  const b = bet(db, { strat: "overreaction", cv: `${E}·m1`, status: "settled_lost", entry: 50, stake: 100, result: "lost" }); fill(db, b, 2, 100);
  // PMV-prematch dust fills — DIFFERENT slippage class, must NOT leak into the Overreaction c.
  const p = bet(db, { strat: "prematch_value", cv: "e4·m1", status: "settled_lost", entry: 50, stake: 100, result: "lost" }); fill(db, p, 40, 22); // huge slip on a $22 book

  const cap = buildCapacityCurve(db, {});
  assert.ok(cap.verdict, "verdict segment exists");
  assert.equal(cap.verdict!.strategyId, "overreaction");
  assert.equal(cap.verdict!.epoch, E);
  assert.equal(cap.verdict!.betsModeled, 2);
  assert.equal(cap.verdict!.cN, 2, "c from the 2 Overreaction fills only — the dust PMV fill excluded");
  // c must reflect Overreaction's own ~0.02¢/$ = 20¢/$1k, NOT the poison PMV 40/22≈1.8¢/$
  assert.ok(cap.verdict!.cMedPer1k! < 100, `Overreaction c ~20¢/$1k, got ${cap.verdict!.cMedPer1k}`);
  // PMV lives in the diagnostic segments, never the verdict
  assert.ok(cap.segments.some((s) => s.strategyId === "prematch_value"));
  assert.ok(!cap.segments.some((s) => s.key === cap.verdict!.key));
});

test("capacity: verdict rows decay with size; far rows flagged beyondObserved (extrapolation)", () => {
  const db = seed();
  const E = CODE_VERSION;
  for (let i = 0; i < 3; i++) { const w = bet(db, { strat: "overreaction", cv: `${E}·m1`, status: "settled_won", entry: 50, stake: 100, result: "won" }); fill(db, w, 2, 100); }
  const l = bet(db, { strat: "overreaction", cv: `${E}·m1`, status: "settled_lost", entry: 50, stake: 100, result: "lost" }); fill(db, l, 2, 100);
  const v = buildCapacityCurve(db, {}).verdict!;
  const r = v.rows;
  assert.ok(r[0].returnPct! > 0, "base ×1 positive (3 win / 1 loss)");
  for (let i = 1; i < r.length; i++) assert.ok(r[i].returnPct! < r[i - 1].returnPct!, `row ${i} return% must drop`);
  // observed max fill = $100; at large banks the scaled size blows past it → flagged
  assert.equal(r[0].beyondObserved, false, "×1 within observed");
  assert.equal(r.at(-1)!.beyondObserved, true, "$200k is far beyond any observed fill → extrapolation");
});

test("capacity: a thin-n segment is labelled own_thin with the range, not silently smoothed", () => {
  const db = seed();
  const E = CODE_VERSION;
  const a = bet(db, { strat: "overreaction", cv: `${E}·m1`, status: "settled_won", entry: 50, stake: 100, result: "won" }); fill(db, a, 2, 100);
  bet(db, { strat: "overreaction", cv: `${E}·m1`, status: "settled_lost", entry: 50, stake: 100, result: "lost" }); // no fill → uses segment c
  const v = buildCapacityCurve(db, {}).verdict!;
  assert.equal(v.cN, 1);
  assert.equal(v.cSource, "own_thin", "1 measurement → thin, flagged");
  assert.ok(v.note.includes("тонк") || v.note.includes("замер"), "note flags the thin measurement");
});
