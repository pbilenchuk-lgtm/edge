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
  assert.ok(d.some((x) => /strategist_empty/.test(x)), "zero proposals is stated outright — the Varnamo case (W4: стадия названа явно)");
});

// ── P4: Draw canon enforced at the fill choke ────────────────────────────────────────────────────
// B1 built the canon; the empirics ratified it (6/6 settled draw bets resolved as the 90' contract, zero
// disagreements → model_confirmed). A desynced draw group is ONE contract quoted twice, so exactly one
// notation is tradeable and the mirrors are a DIFFERENT condition that must be physically cut at entry.
import { canonicalizeDrawForMatch, drawCanonEnabled } from "../src/lib/drawCanon.js";

function seedDrawGroup(db: any, opts: { p1: number; p2: number; canonPx: number; mirrorPx: number }) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MK", budget: 1000, external_league: "mkd.1", created_at: "t" });
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "FK Vardar Skopje", away: "Rīga FC", state: "live", lineup_out: true, kickoff_at: null, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  const mk = (label: string, price: number, at: string) =>
    R.insertMarket(db, { id: R.uid(), match_id: "m1", label, price, ai_prob: null, liquidity: "2000", external_ref: label, snapshot_at: at, is_closing: false } as any);
  mk("FK Vardar Skopje", opts.p1, "t1");            // 1X2 anchor — home leg
  mk("Rīga FC", opts.p2, "t1");                     // 1X2 anchor — away leg
  mk("Draw — Yes", opts.canonPx, "t2");             // sum-consistent notation
  mk("Draw (FK Vardar Skopje vs. Rīga FC) — Yes", opts.mirrorPx, "t1"); // the desynced mirror
}

test("P4 (Vardar): the canon picks the sum-consistent draw book and names the mirror as a different condition", () => {
  const db = openDb(":memory:"); initSchema(db);
  // P1 40 + draw 28 + P2 33 = 101 ✓ within vig; the mirror at 50 would make the book sum 123 ✗.
  seedDrawGroup(db, { p1: 40, p2: 33, canonPx: 28, mirrorPx: 50 });
  const dc = canonicalizeDrawForMatch(db, "m1", {})!;
  assert.equal(dc.verdict, "canon");
  assert.equal(dc.canon!.label, "Draw — Yes", "the sum-consistent notation is the tradeable contract");
  assert.deepEqual(dc.mirrors, ["Draw (FK Vardar Skopje vs. Rīga FC) — Yes"], "the incoherent notation is a mirror");
  assert.equal(drawCanonEnabled({}), true, "enforcement is ON by default after the 25.07 ratification");
  assert.equal(drawCanonEnabled({ DRAW_CANON_ENFORCE: "false" }), false, "…and revertible to report-only without a deploy");
});

test("P4: an incoherent draw contour (no sum-consistent notation) quarantines the whole group", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedDrawGroup(db, { p1: 40, p2: 33, canonPx: 50, mirrorPx: 55 }); // 123 and 128 — neither coheres
  const dc = canonicalizeDrawForMatch(db, "m1", {})!;
  assert.equal(dc.verdict, "quarantine");
  assert.equal(dc.canon, null, "nothing is tradeable when the whole draw contour is incoherent");
  assert.equal(dc.mirrors.length, 2, "both notations are held out");
});

// ── Z2(а): one market is one contract ────────────────────────────────────────────────────────────
import { buildLegConsistency } from "../src/lib/legConsistency.js";

function seedLegs(db: any, legs: { profile: string; result: string; settledBy: string; closing: number | null; payout: number }[]) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "PE", budget: 1000, external_league: "per.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "Cusco FC", away: "Universitario", state: "finished", lineup_out: true, kickoff_at: "2026-07-25T00:00:00Z", minute: null, score_home: 2, score_away: 1, final_score: "2-1", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: "m1" } as any);
  legs.forEach((l, i) => db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,proposed_price,entry_price,current_price,closing_price,ai_prob,stake,rationale,entered_minute,result,payout,settled_by,settled_at,entry_meta,code_version,decision_id,origin,origin_source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`b${i}`, "m1", "prematch_value", l.profile, "Cusco FC Over 0.5", l.result === "won" ? "settled_won" : "settled_lost", 57, 57, 57, l.closing, 0.6, 100, "r", "предматч", l.result, l.payout, l.settledBy, "t", null, "e5", `d${i}`, "prematch", "decision", "2026-07-25T00:00:00Z"));
}

test("Z2(а) Cusco regression: partial cuts + a held winner disagree LEGITIMATELY — labelled, not silently clean", () => {
  const db = openDb(":memory:"); initSchema(db);
  // The batch-9 shape: 4 legs cut early at 45.3¢ (money losses) + 4 legs held to a 95.5¢ winner.
  seedLegs(db, [
    ...["a", "b", "c", "d"].map((p) => ({ profile: p, result: "lost", settledBy: "partial", closing: 45.3, payout: 79 })),
    ...["e", "f", "g", "h"].map((p) => ({ profile: p, result: "won", settledBy: "settle", closing: 95.5, payout: 175 })),
  ]);
  const rep = buildLegConsistency(db);
  assert.equal(rep.disagreeing, 1, "the market is flagged as carrying both directions");
  assert.equal(rep.partialExplained, 1);
  assert.equal(rep.suspect, 0, "every minority leg was an early/partial cut → explained, not a defect");
  assert.match(rep.groups[0].note, /объяснимо частичными/);
  assert.match(rep.groups[0].note, /void/, "…and states WHY the signal collapses to void rather than a win [M6]");
});

test("Z2(а): two HELD legs of one contract disagreeing is a real defect (double settle / mislabel)", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedLegs(db, [
    { profile: "a", result: "lost", settledBy: "settle", closing: 0, payout: 0 },   // held, lost
    { profile: "b", result: "won", settledBy: "settle", closing: 100, payout: 175 }, // held, won — impossible
  ]);
  const rep = buildLegConsistency(db);
  assert.equal(rep.suspect, 1, "one contract cannot resolve two ways when both legs were held");
  assert.equal(rep.groups[0].classification, "suspect");
  assert.match(rep.groups[0].note, /ПОДОЗРИТЕЛЬНО/);
});

// ── V0.1 ROOT CAUSE: ft_blind refused a blind fixture's thesis because the analysis ran late ─────
// Samegrelo (the whole ft_blind=0 mystery): funded, blind, mode ON, FT-settled market, no match_live — and
// zero entries. The DB answered it: origin='live'. It was stamped live because the analysis ran at 09:01:33
// for a 09:00:00 kickoff. Refusing a live thesis on a blind fixture is CORRECT in general (we cannot see the
// score, so a totals thesis at minute 60 bets into goals that may already have happened) — but right after
// kickoff, «blind» and «pre-match» are the same information state.
import { ftBlindOriginOk } from "../src/lib/lifecycle.js";

test("V0.1 (Samegrelo): a thesis formed 2m after kickoff on a blind fixture is admissible; 60m later is not", () => {
  const m = { kickoff_at: "2026-07-25T09:00:00Z" };
  const bet = (createdAt: string, origin = "live") => ({ origin, created_at: createdAt });
  // The real case: analysis at 09:01:33, i.e. ~1.5 minutes late — the fixture must not be lost to that slip.
  assert.equal(ftBlindOriginOk(m, bet("2026-07-25T09:01:33Z"), {}), true, "≈1.5m after kickoff → still a pre-match state");
  assert.equal(ftBlindOriginOk(m, bet("2026-07-25T09:05:00Z"), {}), true, "exactly at the 5m grace edge → admitted");
  assert.equal(ftBlindOriginOk(m, bet("2026-07-25T10:00:00Z"), {}), false, "60m in, blind to the score → refused");
  assert.equal(ftBlindOriginOk(m, bet("2026-07-25T08:50:00Z"), {}), false, "a 'live' stamp BEFORE kickoff is incoherent → fail closed");
  // A genuine pre-match thesis is unconditionally fine; anything unmeasurable or unknown fails closed.
  assert.equal(ftBlindOriginOk(m, { origin: "prematch", created_at: null }, {}), true);
  assert.equal(ftBlindOriginOk({ kickoff_at: null }, bet("2026-07-25T09:01:00Z"), {}), false, "no kickoff → gap unmeasurable → refused");
  assert.equal(ftBlindOriginOk(m, { origin: null, created_at: "2026-07-25T09:01:00Z" }, {}), false, "unknown origin → refused");
  // The window is env-tunable, and 0 collapses it back to prematch-only.
  assert.equal(ftBlindOriginOk(m, bet("2026-07-25T09:01:33Z"), { FT_BLIND_LIVE_GRACE_MIN: "0" }), false, "grace 0 → strictly prematch-only, the old behaviour");
});

// ── Provider plan-scope: escalating backoff + a verdict instead of a raw counter ──────────────────
// Prod evidence: Sportmonks on a World-Cup plan resolved `fifa.world` cleanly (consec_fail 0) while every club
// league sat at 16-235 consecutive not-resolved. Those never resolve — the subscription doesn't cover them —
// yet the flat 20-minute retry treated a 5-failure league and a 235-failure league identically, re-probed both
// forever, and the system had no way to SAY «plan scope, not an outage». Five days went unnoticed.
import { coverageRetryMin, coverageScope, coverageVerdictNote, nextCoverage, COVERAGE_OUT_OF_PLAN_AT } from "../src/lib/providerCoverage.js";

test("provider scope: the re-probe interval escalates with the failure history and is capped at a daily probe", () => {
  assert.equal(coverageRetryMin(0), 20, "a healthy league keeps the base interval");
  assert.equal(coverageRetryMin(5), 20, "at the mute threshold → the plain slow retry");
  assert.equal(coverageRetryMin(15), 80, "three thresholds of failures → 4× the interval");
  assert.equal(coverageRetryMin(235), 1440, "the Sportmonks club-league case → a DAILY probe, not every 20m");
  assert.ok(coverageRetryMin(100000) <= 1440, "capped — muting stays soft, a plan upgrade is still picked up");
});

test("provider scope: a verdict, not a counter — healthy / degraded / out_of_plan", () => {
  const row = (consec: number) => ({ provider: "sportmonks", league: "bra.1", consec_fail: consec, muted_until: null, last_probe_at: null, updated_at: "t" } as any);
  assert.equal(coverageScope(row(0)), "healthy", "fifa.world on the WC plan");
  assert.equal(coverageScope(row(7)), "degraded");
  assert.equal(coverageScope(row(235)), "out_of_plan", "the club leagues");
  assert.ok(COVERAGE_OUT_OF_PLAN_AT > 5, "out-of-plan is a much higher bar than the mute threshold");
  const note = coverageVerdictNote("sportmonks", "bra.1", row(235));
  assert.match(note, /ВНЕ ПЛАНА/);
  assert.match(note, /экономическое/, "…and says plainly that there is nothing to fix in code");
});

test("provider scope: a resolved probe clears the history instantly (a late mapping is never punished)", () => {
  const muted = nextCoverage("sportmonks", "bra.1", { provider: "sportmonks", league: "bra.1", consec_fail: 234, muted_until: "2026-07-25T00:00:00Z", last_probe_at: null, updated_at: "t" } as any, "not_resolved", "2026-07-25T12:00:00Z");
  assert.equal(muted.consec_fail, 235);
  assert.equal(muted.muted_until, "2026-07-26T12:00:00.000Z", "escalated to a daily probe");
  const healed = nextCoverage("sportmonks", "bra.1", muted, "resolved", "2026-07-26T12:00:00Z");
  assert.equal(healed.consec_fail, 0, "one success wipes the whole history");
  assert.equal(healed.muted_until, null, "…and unmutes immediately");
});
