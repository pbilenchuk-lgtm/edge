import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { overreactionGate } from "../src/lib/reassessGate.js";
import { buildStopCounterfactual, STOP_CF_MIN_N } from "../src/lib/stopCounterfactual.js";
import { entryBlockerDiag } from "../src/lib/matchLog.js";

// An armed, in-window, goal-matched buyback trigger — the shape overreactionGate parses.
const SHEET = JSON.stringify({
  live_triggers_armed: [{ price_trigger: "выкуп при overreaction на гол", window: "до 75'", depth_condition: "книга ≥ $500" }],
});

// ── P5: deterministic cost pre-filter ────────────────────────────────────────────────────────────
// Batch 9: overreaction armed ~80 triggers across 18 matches and entered ZERO times, waking the LLM on every
// armed tick. Freezing was rejected (a gate matures only through cycles) — so the call must also clear a real
// panic and a fillable book. Both readings are optional and fail OPEN.
test("P5: an armed in-window trigger with NO real panic no longer wakes the LLM", () => {
  const live = { totalGoals: 1, minute: 40 };
  assert.equal(overreactionGate(SHEET, live).call, true, "baseline: armed + in-window + goal on the board → call");
  const shallow = overreactionGate(SHEET, { ...live, panicDropCents: 2, bookUsd: 5000 });
  assert.equal(shallow.call, false, "a 2¢ 'panic' is nothing to buy back → deterministic skip");
  assert.match((shallow as { reason: string }).reason, /паника всего 2¢/, "the reason names the measured magnitude");
  const deep = overreactionGate(SHEET, { ...live, panicDropCents: 12, bookUsd: 5000 });
  assert.equal(deep.call, true, "a real 12¢ panic on a deep book still reaches the strategist");
});

test("P5: an unfillable book blocks the call; unreadable metrics fail OPEN (never cuts a real setup blind)", () => {
  const live = { totalGoals: 1, minute: 40, panicDropCents: 12 };
  const thin = overreactionGate(SHEET, { ...live, bookUsd: 120 });
  assert.equal(thin.call, false, "a $120 book can't fill a buyback");
  assert.match((thin as { reason: string }).reason, /книга \$120/, "the reason names the measured depth");
  assert.equal(overreactionGate(SHEET, { totalGoals: 1, minute: 40 }).call, true, "no readings at all → fail OPEN, unchanged behaviour");
  assert.equal(overreactionGate(SHEET, { totalGoals: 1, minute: 40, panicDropCents: null, bookUsd: null }).call, true, "explicit nulls also fail OPEN");
});

// The measurement itself must fail open too: a market with a SINGLE snapshot yields peak==current, i.e. a 0¢
// "drop" that is absence of evidence, not evidence of absence. Reading that as «паники нет» would silence the
// strategist on every freshly-quoted match (it broke the goal-event regression test until fixed).
test("P5: a 0¢ drop measured from a single snapshot must never be treated as 'no panic'", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "H", away: "A", state: "live", lineup_out: true, kickoff_at: null, minute: 20, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Over 2.5", price: 55, ai_prob: null, liquidity: null, external_ref: "t", snapshot_at: "t1", is_closing: false } as any);
  const one = db.prepare(`SELECT MAX(price) px, COUNT(*) n FROM markets WHERE match_id=? AND label=?`).get("m1", "Over 2.5") as { px: number; n: number };
  assert.equal(one.n, 1, "single snapshot");
  assert.equal(one.px - 55, 0, "…so the naive drop is 0¢ — which must NOT be read as 'no panic'");
  // With history, the same computation reports a real 20¢ collapse.
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Over 2.5", price: 35, ai_prob: null, liquidity: "900", external_ref: "t", snapshot_at: "t2", is_closing: false } as any);
  const two = db.prepare(`SELECT MAX(price) px, COUNT(*) n FROM markets WHERE match_id=? AND label=?`).get("m1", "Over 2.5") as { px: number; n: number };
  assert.equal(two.n, 2);
  assert.equal(two.px - 35, 20, "history present → a real 20¢ panic is measurable");
  assert.equal(overreactionGate(SHEET, { totalGoals: 1, minute: 40, panicDropCents: 20, bookUsd: 900 }).call, true, "and it reaches the strategist");
});

// ── P3: stop counterfactual ──────────────────────────────────────────────────────────────────────
function seedStopCf(db: any) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  const t0 = "2026-07-25T12:00:00Z";
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "H", away: "A", state: "finished", lineup_out: true, kickoff_at: t0, minute: null, score_home: 2, score_away: 1, final_score: "2-1", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: "m1" } as any);
  // The cut happened at 12:20 @ 15¢; the same market printed 34¢ fifteen minutes later — a 19¢ shortfall.
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Under 1.5", price: 15, ai_prob: null, liquidity: "800", external_ref: "T", snapshot_at: "2026-07-25T12:20:00Z", is_closing: false } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Under 1.5", price: 34, ai_prob: null, liquidity: "800", external_ref: "T", snapshot_at: "2026-07-25T12:35:00Z", is_closing: false } as any);
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,proposed_price,entry_price,current_price,closing_price,ai_prob,stake,rationale,entered_minute,result,payout,settled_by,settled_at,entry_meta,code_version,decision_id,origin,origin_source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("b1", "m1", "prematch_value", "medium", "Under 1.5", "settled_lost", 40, 40, 15, null, 0.6, 100, "r", "предматч", "lost", 0, "early", t0, JSON.stringify({ phase: "prematch" }), "e5", "d1", "prematch", "decision", t0);
  // The thesis hold that a later hard stop overrode (the 6'→24' pattern), then the stop itself.
  R.insertTradeLog(db, { id: R.uid(), match_id: "m1", strategy_id: "prematch_value", minute: "6'", type: "hold", text: `ценовой стоп подавлен по «Under 1.5»: тезис в запасе`, created_at: "2026-07-25T12:06:00Z" } as any);
  R.insertTradeLog(db, { id: R.uid(), match_id: "m1", strategy_id: "prematch_value", minute: "20'", type: "exit", text: `выход «Under 1.5» @ 15¢ · хард-стоп -62% · P&L $-25`, created_at: "2026-07-25T12:20:00Z" } as any);
}

test("P3: shortfall = best price in the window − the price we cut at; hard-stop-over-thesis-hold is flagged", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedStopCf(db);
  const cf = buildStopCounterfactual(db, {}, 30);
  assert.equal(cf.n, 1, "one protective exit in scope");
  const row = cf.rows[0];
  assert.equal(row.cutCents, 15);
  assert.equal(row.bestNextCents, 34, "the market printed 34¢ inside the 30m window");
  assert.equal(row.shortfallCents, 19, "19¢ left on the table");
  assert.ok((row.shortfallPct ?? 0) > 100, "…which is >100% of the cut price");
  assert.equal(row.reason, "hard_stop");
  assert.equal(row.overrodeThesisHold, true, "the earlier thesis suppression on this market is detected");
  assert.equal(cf.overrode.count, 1);
  // The criterion is fixed BEFORE the data and must not fire on a single anecdote.
  assert.equal(cf.verdict, "insufficient", `n=1 < ${STOP_CF_MIN_N} → no verdict, however big the shortfall`);
  assert.match(cf.note, new RegExp(`${STOP_CF_MIN_N}`), "the note states the sample the verdict needs");
});

test("P3: a take_price exit is NOT in the protective cohort (only defensive cuts are judged)", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedStopCf(db);
  // Replace the stop with a genuine profit-take on the same market/time.
  db.prepare(`DELETE FROM trade_log WHERE type='exit'`).run();
  R.insertTradeLog(db, { id: R.uid(), match_id: "m1", strategy_id: "prematch_value", minute: "20'", type: "exit", text: `выход «Under 1.5» @ 15¢ · стратег: take_price — фиксирую · P&L +$5`, created_at: "2026-07-25T12:20:00Z" } as any);
  assert.equal(buildStopCounterfactual(db, {}, 30).n, 0, "a take is not a defensive cut — out of cohort");
});

// ── V0.1: honest entry-blocker diagnostic ────────────────────────────────────────────────────────
// The old log blamed the preview branch for EVERY hasLiveData=НЕТ match, which sent the Samegrelo/Varnamo
// ft_blind=0 hunt at the wrong gate: the true blocker was a book parked at 50¢ (and, for Varnamo, no
// proposals at all). The diagnostic now walks autoEnter's real gate order.
test("V0.1: the diagnostic names the parked 50¢ book and clears the preview branch when lineups are out", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "WCL", budget: 8000, external_league: "uefa.wchampions", created_at: "t" });
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "Samegrelo", away: "Dragon", state: "live", lineup_out: true, kickoff_at: "2026-07-25T09:00:00Z", minute: 20, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  for (const lbl of ["Under 3.5", "Over 3.5", "Draw — Yes"]) {
    R.insertMarket(db, { id: R.uid(), match_id: "m1", label: lbl, price: 50, ai_prob: null, liquidity: "1000", external_ref: lbl, snapshot_at: "t", is_closing: false } as any);
  }
  const d = entryBlockerDiag(db, "m1", {});
  assert.ok(d.some((x) => /КНИГА НЕ РАЗМЕЧЕНА: 3\/3/.test(x)), "the parked book is named as the real blocker");
  assert.ok(d.some((x) => /превью-ветка НЕ активна/.test(x)), "the preview branch is explicitly cleared (lineups are out)");
  assert.ok(d.some((x) => /НЕТ ПРЕДЛОЖЕНИЙ/.test(x)), "zero proposals is stated outright — the Varnamo case");
});
