import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { inAnchorWindow, buildPrematchTimeliness } from "../src/lib/prematchAnchor.js";
import { zombieClearWithMargin, loadZombieConfig } from "../src/lib/zombieMarket.js";
import { recordRefusalForMatch, resolveRefusalShadowSignals, buildRefusalShadow, REFUSAL_NEED_N } from "../src/lib/refusalShadow.js";

// ── R3: T-minus anchor ───────────────────────────────────────────────────────────────────────────
// Batch 10 proved the pre-match pass ran 3/7/9 minutes AFTER kickoff. The queue was already sorted by
// kickoff — but LIVE matches carry the smallest kickMs and take every slot, so an upcoming fixture waits
// behind them until its whistle passes.
test("R3: the anchor window opens 60m before kickoff and closes AT kickoff (never after)", () => {
  const now = Date.parse("2026-07-26T12:00:00Z");
  const at = (iso: string) => ({ kickoff_at: iso });
  assert.equal(inAnchorWindow(at("2026-07-26T12:30:00Z"), now, {}), true, "30m out → in the lane");
  assert.equal(inAnchorWindow(at("2026-07-26T13:00:00Z"), now, {}), true, "exactly 60m out → the far edge is inclusive");
  assert.equal(inAnchorWindow(at("2026-07-26T13:30:00Z"), now, {}), false, "90m out → too early, the general queue has time");
  assert.equal(inAnchorWindow(at("2026-07-26T12:00:00Z"), now, {}), false, "AT kickoff → too late to be a pre-match pass");
  assert.equal(inAnchorWindow(at("2026-07-26T11:55:00Z"), now, {}), false, "already live → the live path owns it");
  assert.equal(inAnchorWindow({ kickoff_at: null }, now, {}), false, "no kickoff → nothing to anchor to");
  assert.equal(inAnchorWindow(at("2026-07-26T12:30:00Z"), now, { PREMATCH_ANCHOR_OPEN_MIN: "15" }), false, "window is env-tunable");
});

test("R3: timeliness counts proposals that predate kickoff, and the ft_blind TAM ignores placeholder books", () => {
  const db = openDb(":memory:"); initSchema(db);
  const now = Date.parse("2026-07-26T12:00:00Z");
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "eng.2", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  const kick = "2026-07-26T10:00:00Z";
  const mkMatch = (id: string, prices: number[]) => {
    R.insertMatch(db, { id, competition_id: "c1", home: "H" + id, away: "A" + id, state: "finished", lineup_out: true, kickoff_at: kick, minute: null, score_home: 1, score_away: 1, final_score: "1-1", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: id } as any);
    prices.forEach((p, i) => R.insertMarket(db, { id: R.uid(), match_id: id, label: `L${i}`, price: p, ai_prob: null, liquidity: "900", external_ref: `t${id}${i}`, snapshot_at: kick, is_closing: false } as any));
  };
  mkMatch("m-real", [42, 58]);   // genuinely traded book → real ft_blind inventory
  mkMatch("m-dead", [50, 50]);   // a wall of placeholders → NOT inventory
  const bet = (id: string, matchId: string, createdAt: string) =>
    db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,proposed_price,entry_price,current_price,closing_price,ai_prob,stake,rationale,entered_minute,result,payout,settled_by,settled_at,entry_meta,code_version,decision_id,origin,origin_source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, matchId, "prematch_value", "medium", "L0", "proposed", 50, null, null, null, 0.6, 10, "r", "предматч", null, null, null, null, null, "e5", id, "prematch", "decision", createdAt);
  bet("b-early", "m-real", "2026-07-26T09:30:00Z"); // 30m BEFORE kickoff — what the anchor lane exists to produce
  bet("b-late", "m-real", "2026-07-26T10:09:00Z");  // 9m after — the batch-10 failure
  const t = buildPrematchTimeliness(db, 7, now);
  assert.equal(t.funded.proposals, 2);
  assert.equal(t.funded.beforeKickoff, 1);
  assert.equal(t.funded.pct, 50);
  assert.equal(t.funded.met, false, "50% is far below the 90% target");
  assert.equal(t.lateness.worst, 9, "the 9-minute slip is reported in minutes, not hidden");
  assert.equal(t.ftBlindTam.blindFundedFixtures, 2);
  assert.equal(t.ftBlindTam.withTradedFtBooks, 1, "only the genuinely priced book counts as inventory");
  assert.equal(t.ftBlindTam.placeholderOnly, 1, "a 50¢ wall is named, not counted as feeding ground");
});

// ── R4: quarantine hysteresis ────────────────────────────────────────────────────────────────────
// 260 lift→re-quarantine cycles in 28 matches, and only 15 of 417 markets ever wore a second code — so the
// driver is markets sitting ON a threshold and crossing it back and forth, not code churn.
test("R4: leaving quarantine needs MARGIN over the threshold, entering does not", () => {
  const cfg = loadZombieConfig({});
  const base = { label: "Draw — Yes", priceCents: 55, askCents: null, gsProb: null, bookAgeMin: 1, live: true };
  // A notation spread just under the desync threshold: clean by the plain rule, but still ON the boundary.
  assert.equal(zombieClearWithMargin({ ...base, groupSpreadCents: cfg.notationSpreadCents - 1 }, cfg), false, "1¢ under the threshold is chatter, not health");
  assert.equal(zombieClearWithMargin({ ...base, groupSpreadCents: cfg.notationSpreadCents - cfg.hysteresisCents - 1 }, cfg), true, "clearly under → genuinely healthy");
  // A price hovering at the edge of the mid-placeholder band must not be declared healthy either.
  assert.equal(zombieClearWithMargin({ ...base, priceCents: 51, groupSpreadCents: 0 }, cfg), false, "51¢ still hugs the 50¢ placeholder band");
  assert.equal(zombieClearWithMargin({ ...base, priceCents: 60, groupSpreadCents: 0 }, cfg), true, "60¢ is clearly off the mid");
  // Entering is unchanged: a market over the plain threshold is quarantined at once, no margin required.
  assert.equal(zombieClearWithMargin({ ...base, groupSpreadCents: cfg.notationSpreadCents }, cfg), false, "at the threshold → still a zombie by the plain rule");
});

// ── R5: refusal shadow ───────────────────────────────────────────────────────────────────────────
// The strategist refused 22 of 28 matches. Rather than argue, freeze what it walked away from and score it.
function seedRefusal(db: any, aiProb: number, price: number, score: [number, number]) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "eng.2", created_at: "t" });
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "H", away: "A", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: score[0], score_away: score[1], final_score: `${score[0]}-${score[1]}`, kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: "m1" } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Over 2.5", price, ai_prob: aiProb, liquidity: "900", external_ref: "t1", snapshot_at: "t", is_closing: false } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Draw — Yes", price: 30, ai_prob: 0.9, liquidity: "900", external_ref: "t2", snapshot_at: "t", is_closing: false } as any);
}

test("R5: only totals with a committed edge over the floor are frozen — other families and thin edges are not", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedRefusal(db, 0.70, 50, [2, 1]);            // Over 2.5: our 70% vs implied 50% → 20% edge
  const n = recordRefusalForMatch(db, "m1", "prematch_value", "полный пропуск", "2026-07-26T12:00:00Z", {});
  assert.equal(n, 1, "the Draw market is out of scope even at a 60% edge — the question is scoped to totals");
  const rows = db.prepare(`SELECT market_label, edge, status FROM refusal_shadow_signals`).all() as any[];
  assert.equal(rows[0].market_label, "Over 2.5");
  assert.equal(rows[0].status, "pending");
  // A thin edge is not a refusal anyone would argue with.
  const db2 = openDb(":memory:"); initSchema(db2);
  seedRefusal(db2, 0.52, 50, [2, 1]);
  assert.equal(recordRefusalForMatch(db2, "m1", "prematch_value", null, "t", {}), 0, "2% edge → nothing to answer for");
});

test("R5: refusals resolve by the SAME settlement code as money, and the verdict waits for n≥25", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedRefusal(db, 0.70, 50, [2, 1]);            // 2-1 = 3 goals → Over 2.5 WON: this refusal cost us
  recordRefusalForMatch(db, "m1", "prematch_value", null, "t", {});
  const r = resolveRefusalShadowSignals(db, { now: () => "2026-07-26T14:00:00Z" });
  assert.equal(r.resolved, 1);
  assert.equal((db.prepare(`SELECT status FROM refusal_shadow_signals`).get() as any).status, "won", "the walked-away market did win");
  const rep = buildRefusalShadow(db, {});
  assert.equal(rep.scored, 1);
  assert.equal(rep.winPct, 100);
  assert.ok(rep.wouldBePnlUsd > 0, "flat-$100 accounting shows what the refusal forwent");
  assert.equal(rep.matured, false);
  assert.equal(rep.verdict, "insufficient", `one anecdote proves nothing — the verdict needs ${REFUSAL_NEED_N}`);
  assert.match(rep.note, /жёсткость НЕ трогаем/, "…and the note says the screw stays untouched meanwhile");
});

// ── R1: repaired gate + quasi-locked tail ────────────────────────────────────────────────────────
// The old gate counted only RESOLUTION settles — unmeasurable by construction for a strategy that cashes out
// ~100% of its positions by design (the same blindness the PMV Brier gate had before shadow scoring).
import { quasiLocked, holdTailToSettle } from "../src/lib/quasiLocked.js";
import { buildOverreactionGate } from "../src/lib/overreactionGate.js";

test("R1: the gate reports the SIGNAL cycle count and keeps the old resolution-only numerator visible", () => {
  const db = openDb(":memory:"); initSchema(db);
  const g = buildOverreactionGate(db);
  assert.equal(typeof g.signalGate.nSignals, "number");
  assert.equal(g.signalGate.legacyResolutionOnly, g.cleanCycles, "the old numerator travels alongside, so the change of ruler is auditable");
  assert.match(g.signalGate.note, /ЕДИНИЦА ИЗМЕРЕНИЯ ИСПРАВЛЕНА/);
  assert.match(g.signalGate.note, /кэш-ауты входят/, "cash-outs are counted — that is the whole repair");
  assert.match(g.signalGate.note, /ремонт ЛИНЕЙКИ/, "…and the caveat is stated in the report, not just the commit");
});

test("R1: a tail is held to settle only when the SCORE locks it — never merely because it is winning", () => {
  const late = { label: "Draw — No", home: "Boston", away: "KC", scoreHome: 3, scoreAway: 0, minute: 88 };
  const lock = quasiLocked(late, null, {});
  assert.equal(lock.locked, true, "3:0 at 88' clears the ratified Draw-No threshold");
  // NOT «arithmetically impossible» — three goals in stoppage time is possible, merely absurd. The reason text
  // has to say so, or the next reader will treat a ratified threshold as a proof and widen it on a hunch.
  assert.match(lock.reason, /ратифицированный порог — не арифметика/);
  assert.equal(lock.against ?? false, false, "the lock runs FOR the position");
  assert.equal(holdTailToSettle(late, null, {}).locked, true, "so the tail rides to resolution instead of paying the spread");
  // Winning but NOT locked: the same market earlier in the match, where a comeback is still possible.
  const early = { ...late, minute: 55 };
  assert.equal(quasiLocked(early, null, {}).locked, false, "55' is before the clock floor — too much match left to call it decided");
  assert.match(quasiLocked(early, null, {}).reason, /слишком много матча/);
  // A one-goal lead late is NOT locked — this is exactly the 94th-minute-goal case the cash-out policy exists for.
  assert.equal(quasiLocked({ ...late, scoreHome: 1, scoreAway: 0 }, null, {}).locked, false, "1:0 at 88' is not decided");
  // Missing inputs never lock.
  assert.equal(quasiLocked({ ...late, scoreHome: null }, null, {}).locked, false, "no score → not provable");
  assert.equal(quasiLocked({ ...late, minute: null }, null, {}).locked, false, "no minute → not provable");
});

test("R1: a market locked AGAINST us is reported honestly but never read as «hold»", () => {
  // Draw — Yes at 3:0 on 88': the score locks the market against the position; there is nothing to ride.
  const against = { label: "Draw — Yes", home: "Boston", away: "KC", scoreHome: 3, scoreAway: 0, minute: 88 };
  const v = quasiLocked(against, null, {});
  assert.equal(v.locked, true, "the state IS locked — reported truthfully");
  assert.equal(holdTailToSettle(against, null, {}).locked, false, "…but holding a worthless tail is not a strategy");
});
