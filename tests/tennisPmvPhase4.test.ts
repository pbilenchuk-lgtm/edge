import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { pmvNetEvCents, PMV_STRATEGY, PMV_PAPER_EPOCH } from "../src/lib/tennisPmv.js";
import { buildPmvShadowCalibration, pmvSideBiasHaircut, pmvMeasuredCalibration, buildPmvPromotion, recordPmvShadowSignal, resolvePmvShadowSignals } from "../src/lib/tennisPmvShadow.js";

const NOW = "2026-07-14T15:00:00.000Z";

// [Phase 4.1 / M20] Net-EV gate — test #11: a 7¢ GROSS deviation on a thin book is cut once fees + the
// adverse-fill drift are subtracted; a fatter 10¢ gross clears the same gate.
test("net-EV: a 7¢ gross on a thin book is CUT after fees + drift; a 10¢ gross survives", () => {
  const thin = { POLYMARKET_TAKER_FEE_RATE: "0.02", TENNIS_PMV_EV_FILL_DRIFT_CENTS: "4", TENNIS_PMV_EV_MARGIN_CENTS: "2" };
  const cut = pmvNetEvCents(57, 50, thin); // gross 7, fee 2*0.02*50=2, net 7−2−4=1 < margin 2
  assert.equal(cut.grossCents, 7);
  assert.equal(cut.feeCents, 2);
  assert.equal(cut.fillDriftCents, 4);
  assert.equal(cut.netCents, 1);
  assert.equal(cut.pass, false, "7¢ gross does not clear fees+drift+margin on a thin book");
  const ok = pmvNetEvCents(60, 50, thin); // gross 10, fee 2, net 10−2−4=4 ≥ 2
  assert.equal(ok.netCents, 4);
  assert.equal(ok.pass, true, "10¢ gross clears the same gate");
});

test("net-EV: default (no fill-drift) lets the marginal 7¢ trade; the fee still bites the raw gross", () => {
  const def = pmvNetEvCents(57, 50, {}); // fee 2*0.02*50=2, drift 0, margin 2 → net 5 ≥ 2
  assert.equal(def.feeCents, 2);
  assert.equal(def.netCents, 5);
  assert.equal(def.pass, true);
});

// [Phase 4.2 / M21] The side-bias haircut is data-driven: whichever family·side the shadow cohort proves
// the model over-prices (n≥10, optimismPp≥8) gets a measured haircut — the sign is discovered, not hardcoded.
test("side-bias haircut: a proven over-lean produces a measured cents haircut; a clean side produces none", () => {
  const db = openDb(":memory:"); initSchema(db);
  const finished = (id: string) => {
    R.upsertSport(db, "tennis", "Теннис");
    R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
    R.insertMatch(db, { id, competition_id: "pm-atp", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: id } as any);
    R.insertTennisSnapshot(db, { event_key: "W", provider: "apitennis", batch_at: "2026-07-14T14:00:00Z", p1: "A", p2: "B", tournament: "ATP", event_type: "ATP Singles", live: 0, status: "Finished", sets_p1: 0, sets_p2: 2, set_num: 2, games_p1: 3, games_p2: 6, game_points: null, server: null, pm_match_id: id, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: JSON.stringify({ event_winner: "Second Player", scores: [{ score_set: 1, score_first: 4, score_second: 6 }, { score_set: 2, score_first: 3, score_second: 6 }] }) } as any);
  };
  // 12 two-set matches → Over 2.5 (theo 60¢) LOSES every time — a systematic over-lean.
  for (let i = 0; i < 12; i++) {
    const id = `mo${i}`; finished(id);
    recordPmvShadowSignal(db, { matchId: id, label: `ATP: A vs B Total Sets: Over 2.5`, family: "total_sets", side: "over", firstIsP1: true, theoCents: 60, midCents: 55, deviation: 5, delta: 3, bookUsd: 4000, tour: "atp", surface: "hard", epoch: "e5·shadow-s1", at: NOW } as any);
  }
  resolvePmvShadowSignals(db, { now: () => NOW });
  const cal = buildPmvShadowCalibration(db);
  const hc = pmvSideBiasHaircut(cal);
  assert.equal(hc.get("total_sets·over"), 60, "haircut = measured optimismPp (theo 60 − actual 0)");
  assert.equal(hc.has("total_sets·under"), false, "an un-proven side gets no haircut");
});

// [Phase 4.1] Measured calibration replaces the 0.6 hardcode: insufficient→0.6, matured-GO→0.65, matured-NO_GO→0.5.
test("measured calibration: 0.6 prior until matured, then verdict-driven", () => {
  const db = openDb(":memory:"); initSchema(db);
  const ins = (status: string, theo: number, mid: number) =>
    db.prepare(`INSERT INTO pmv_shadow_signals (id, match_id, market_label, family, side, theo_cents, mid_cents, epoch, hits, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(R.uid(), "m" + R.uid(), "L" + R.uid(), "total_sets", "over", theo, mid, "e5·shadow-s1", 1, status, NOW);
  // < 40 resolved → insufficient → 0.6 prior.
  ins("won", 70, 60);
  assert.equal(pmvMeasuredCalibration(buildPmvShadowCalibration(db)), 0.6, "insufficient → 0.6 prior");
  // 40 GO rows: theo 70 won → markov (.3)²=.09 < implied (.4)²=.16 → matured GO → 0.65.
  const go = openDb(":memory:"); initSchema(go);
  for (let i = 0; i < 40; i++) go.prepare(`INSERT INTO pmv_shadow_signals (id, match_id, market_label, family, side, theo_cents, mid_cents, epoch, hits, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(R.uid(), "m" + i, "L" + i, "total_sets", "over", 70, 60, "e5·shadow-s1", 1, "won", NOW);
  const goCal = buildPmvShadowCalibration(go);
  assert.equal(goCal.verdict, "go");
  assert.equal(pmvMeasuredCalibration(goCal), 0.65, "matured GO → 0.65");
  // 40 NO_GO rows: theo 30 won → markov (.7)²=.49 > implied (.4)²=.16 → matured NO_GO → 0.5.
  const ng = openDb(":memory:"); initSchema(ng);
  for (let i = 0; i < 40; i++) ng.prepare(`INSERT INTO pmv_shadow_signals (id, match_id, market_label, family, side, theo_cents, mid_cents, epoch, hits, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(R.uid(), "m" + i, "L" + i, "total_sets", "over", 30, 60, "e5·shadow-s1", 1, "won", NOW);
  const ngCal = buildPmvShadowCalibration(ng);
  assert.equal(ngCal.verdict, "no_go");
  assert.equal(pmvMeasuredCalibration(ngCal), 0.5, "matured NO_GO → 0.5");
});

// [Phase 4.4] Promotion ladder: shadow when flag-only, paper when money flows, real ALWAYS blocked for tennis.
test("promotion ladder: stage tracks flag-only; real is never eligible for tennis; triple agreement gates review", () => {
  const db = openDb(":memory:"); initSchema(db);
  // empty + default (flag-only) → shadow stage.
  const shadow = buildPmvPromotion(db, {});
  assert.equal(shadow.stage, "shadow");
  assert.equal(shadow.realEligible, false, "real is NEVER eligible for tennis (football-only whitelist)");
  assert.equal(shadow.tripleAgreement, false);
  // flip flag-only off → paper stage; still no data → no triple agreement.
  const paperEmpty = buildPmvPromotion(db, { TENNIS_PMV_FLAG_ONLY: "false" });
  assert.equal(paperEmpty.stage, "paper");
  assert.equal(paperEmpty.tripleAgreement, false);

  // Build a MATURED, agreeing cohort: 40 GO shadow rows (Brier beats implied, no biasFlags) + 25 winning
  // paper signals (positive book P&L). Then triple agreement holds — but real is STILL not eligible.
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  R.insertStrategy(db, { id: PMV_STRATEGY, sport_id: "tennis", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  const insBet = (i: number) => {
    R.insertMatch(db, { id: "pm" + i, competition_id: "pm-atp", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: "pm" + i } as any);
    db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,proposed_price,entry_price,current_price,closing_price,ai_prob,stake,rationale,entered_minute,result,payout,settled_by,settled_at,entry_meta,code_version,decision_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(R.uid(), "pm" + i, PMV_STRATEGY, "medium", "Total Sets Over 2.5 #" + i, "settled_won", 55, 55, 55, null, 0.6, 10, "r", "предматч", "won", 18, "settle", NOW, null, `e5·${PMV_PAPER_EPOCH}`, R.uid(), NOW);
  };
  for (let i = 0; i < 25; i++) insBet(i);
  // 40 GO shadow rows — a DIFFERENT family·side each 10-block so no single side reaches the n≥10 flag floor
  // (keeps biasFlags empty = sideBiasClear), while all 40 are markov-beats-implied for the GO verdict.
  const sides = [["total_sets", "over"], ["total_games", "over"], ["set_handicap", "fav"], ["total_sets", "under"]];
  for (let i = 0; i < 40; i++) { const [fam, side] = sides[Math.floor(i / 10)]; db.prepare(`INSERT INTO pmv_shadow_signals (id, match_id, market_label, family, side, theo_cents, mid_cents, epoch, hits, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(R.uid(), "sm" + i, "sl" + i, fam, side, i % 2 === 0 ? 70 : 30, 60, "e5·shadow-s1", 1, i % 2 === 0 ? "won" : "lost", NOW); }
  const ripe = buildPmvPromotion(db, { TENNIS_PMV_FLAG_ONLY: "false" });
  assert.equal(ripe.paperSignals, 25);
  assert.ok(ripe.paperPnlUsd > 0, "winning paper cohort → positive book P&L");
  assert.equal(ripe.agreements.brierGo, true);
  assert.equal(ripe.agreements.sideBiasClear, true, "no single side reached the flag floor → clear");
  assert.equal(ripe.agreements.paperPositive, true);
  assert.equal(ripe.tripleAgreement, true, "all three confirmations + n≥25 → eligible for review");
  assert.equal(ripe.realEligible, false, "even so, tennis real requires a separate owner ratification");
});
