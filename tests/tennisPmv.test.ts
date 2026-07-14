import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { parseProp, theoForProp, resolveTennisProp, scanMatchProps, finalSetsFromRaw, pmvTour, corrCluster, propFirstIsP1, type FinalSets } from "../src/lib/tennisPmv.js";
import { tennisTheo, BASE_HOLD } from "../src/lib/tennisMarkov.js";
import { migrateTennisPmvStrategy } from "../src/lib/seed.js";

const Q = "Iasi Open: Kawa vs Waltert ";

test("parseProp: classifies each prop family + line/side/set", () => {
  assert.deepEqual(parseProp(Q + "Match Over 23.5"), { family: "total_games", scope: "match", setNum: null, line: 23.5, side: "over", handicapOnFirst: false });
  assert.deepEqual(parseProp(Q + "Set 1 Under 8.5"), { family: "total_games", scope: "set", setNum: 1, line: 8.5, side: "under", handicapOnFirst: false });
  assert.equal(parseProp(Q + "Total Sets: Under 2.5")!.family, "total_sets");
  assert.equal(parseProp("Set 1 Winner: Kawa vs Waltert")!.family, "set_winner");
  const h = parseProp("Set Handicap: Kawa (-1.5) vs Waltert (+1.5)")!;
  assert.equal(h.family, "set_handicap"); assert.equal(h.handicapOnFirst, true);
  assert.equal(parseProp("Iasi Open: Kawa vs Waltert"), null, "moneyline → null");
});

test("pmvTour: PMV is ATP/WTA singles only — ITF / Challenger / doubles are out of scope", () => {
  assert.equal(pmvTour({ id: "pm-atp", name: "ATP" }), "atp");
  assert.equal(pmvTour({ id: "pm-wta", name: "WTA" }), "wta");
  assert.equal(pmvTour({ id: "pm-itf", name: "ITF" }), null, "ITF out of scope");
  assert.equal(pmvTour({ id: "pm-wta-doubles", name: "WTA Doubles" }), null, "doubles out");
  assert.equal(pmvTour({ id: "pm-challenger", name: "Challenger" }), null, "challenger out");
});

// ── Consistency scan: gates (deviation ≥7 enter, ≥18 anti-Draw, price band, book gate) ──
function seedScan(db: ReturnType<typeof openDb>, mlCents: number, props: { label: string; mid: number; liq: number }[]) {
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-wta", sport_id: "tennis", name: "WTA", budget: 0, external_league: null, created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-wta", home: "Kawa", away: "Waltert", state: "upcoming", lineup_out: false, kickoff_at: "2026-07-14T20:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "WTA: Kawa vs Waltert", price: mlCents, ai_prob: null, liquidity: "50000", external_ref: "ml", snapshot_at: "t", is_closing: false });
  for (const p of props) R.insertMarket(db, { id: R.uid(), match_id: mid, label: p.label, price: p.mid, ai_prob: null, liquidity: String(p.liq), external_ref: R.uid(), snapshot_at: "t", is_closing: false });
  return mid;
}

test("scan: deviation ≥7¢ → enter; ≥18¢ → provenance_review (anti-Draw); thin/out-of-band → skip", () => {
  const db = openDb(":memory:");
  const theo = tennisTheo(0.65, BASE_HOLD.wta); // must match the scan's anchor (WTA, hard)
  const setGamesLabel = Q + "Set 1 Over 8.5";
  const t = Math.round(theoForProp(parseProp(setGamesLabel)!, theo)! * 100); // theoCents for this prop
  const mid = seedScan(db, 65, [
    { label: setGamesLabel, mid: t - 10, liq: 3000 },                 // dev +10 → ENTER
    { label: Q + "Set 2 Over 8.5", mid: t - 25, liq: 3000 },          // dev +25 → PROVENANCE (anti-Draw)
    { label: Q + "Set 3 Over 8.5", mid: t - 10, liq: 120 },           // same edge but thin book → SKIP
    { label: Q + "Match Over 5.5", mid: 4, liq: 3000 },               // mid 4¢ < band 8¢ → SKIP
  ]);
  const scan = scanMatchProps(db, mid, { p1: "Kawa", p2: "Waltert" }, "wta", "WTA");
  const by = (frag: string) => scan.candidates.find((c) => c.label.includes(frag))!;
  assert.equal(by("Set 1 Over").action, "enter");
  assert.equal(by("Set 2 Over").action, "provenance_review");
  assert.equal(by("Set 3 Over").action, "skip");
  assert.ok(/книга/.test(by("Set 3 Over").reason));
  assert.equal(by("Match Over 5.5").action, "skip");
  // invariants
  for (const c of scan.candidates) {
    if (c.action === "enter") { assert.ok(c.deviation >= 7 && Math.abs(c.deviation) < 18 && c.bookUsd >= 500 && c.midCents >= 8 && c.midCents <= 92); }
    if (c.action === "provenance_review") assert.ok(Math.abs(c.deviation) >= 18);
  }
});

test("flag-only mode (default): the scan logs would-be entries but places NO bets", async () => {
  const db = openDb(":memory:");
  migrateTennisPmvStrategy(db);
  const theo = tennisTheo(0.65, BASE_HOLD.wta);
  const l = Q + "Set 1 Over 8.5";
  const mid = seedScan(db, 65, [{ label: l, mid: Math.round(theoForProp(parseProp(l)!, theo)! * 100) - 12, liq: 4000 }]);
  delete process.env.TENNIS_PMV_FLAG_ONLY; // default → flag-only ON
  const opened = await tennisPmvTickImport(db);
  assert.equal(opened, 0, "no bets placed in flag-only mode");
  assert.equal(R.betsForMatch(db, mid, "tennis_pmv").length, 0);
  assert.ok(R.tradeLogForMatch(db, mid).some((x) => /flag_only/.test(x.text)), "the would-be entry is logged");
});

test("scan tick + correlation: ≤2 props/match of DIFFERENT families", async () => {
  const db = openDb(":memory:");
  process.env.TENNIS_PMV_FLAG_ONLY = "false"; // exercise the real betting path
  migrateTennisPmvStrategy(db);
  const theo = tennisTheo(0.65, BASE_HOLD.wta);
  const cents = (label: string) => Math.round(theoForProp(parseProp(label)!, theo)! * 100);
  const l1 = Q + "Set 1 Over 8.5", l2 = Q + "Set 2 Over 8.5", l3 = Q + "Total Sets: Over 2.5", l4 = Q + "Match Over 20.5";
  const mid = seedScan(db, 65, [
    { label: l1, mid: cents(l1) - 12, liq: 4000 },  // total_games (set)
    { label: l2, mid: cents(l2) - 12, liq: 4000 },  // total_games (set) — SAME family as l1
    { label: l3, mid: cents(l3) - 12, liq: 4000 },  // total_sets — different family
    { label: l4, mid: cents(l4) - 12, liq: 4000 },  // total_games (match) — same family again
  ]);
  const opened = await tennisPmvTickImport(db);
  const fams = new Set(R.betsForMatch(db, mid, "tennis_pmv").filter((b) => b.status === "open").map((b) => parseProp(b.market_label)!.family));
  assert.ok(fams.size <= 2, "at most 2 distinct families");
  assert.ok(opened > 0, "at least one prop entered");
  // never two of the same family
  const perFamPerProfile = R.betsForMatch(db, mid, "tennis_pmv").filter((b) => b.status === "open");
  const key = (b: any) => `${b.risk_profile_id}:${parseProp(b.market_label)!.family}`;
  assert.equal(new Set(perFamPerProfile.map(key)).size, perFamPerProfile.length, "no duplicate family per profile");
});
async function tennisPmvTickImport(db: any) { const { tennisPmvTick } = await import("../src/lib/tennisPmv.js"); return tennisPmvTick(db, { now: () => "2026-07-14T19:00:00Z" }); }

// ── P4 scan fixes + uniformity guard ──
test("P4.1 placeholder: a prop pinned at ~50¢ is skipped as an untraded default", () => {
  const db = openDb(":memory:");
  const mid = seedScan(db, 65, [{ label: Q + "Set 1 Over 8.5", mid: 50, liq: 4000 }, { label: Q + "Set 2 Over 8.5", mid: 50.4, liq: 4000 }]);
  const scan = scanMatchProps(db, mid, { p1: "Kawa", p2: "Waltert" }, "wta", "WTA");
  for (const c of scan.candidates) { assert.equal(c.action, "skip"); assert.ok(/плейсхолдер/.test(c.reason)); }
});

test("P4.3 handicap side: ambiguous +/-1.5 → provenance; explicit (-1.5) → priced", () => {
  const db = openDb(":memory:");
  const mid = seedScan(db, 65, [
    { label: Q + "Set Handicap +/-1.5", mid: 30, liq: 4000 },                     // ambiguous
    { label: "WTA: Kawa (-1.5) vs Waltert (+1.5) Set Handicap", mid: 30, liq: 4000 }, // explicit
  ]);
  const scan = scanMatchProps(db, mid, { p1: "Kawa", p2: "Waltert" }, "wta", "WTA");
  assert.equal(scan.candidates.find((c) => /\+\/-/.test(c.label))!.action, "provenance_review");
  assert.notEqual(scan.candidates.find((c) => /\(-1\.5\)/.test(c.label))!.theoCents, 0, "explicit side gets priced");
});

test("P4.3 set-winner orientation: propFirstIsP1 aligns the priced side to the moneyline", () => {
  assert.equal(propFirstIsP1("Set 1 Winner: Kawa vs Waltert", { p1: "Kawa", p2: "Waltert" }), true);
  assert.equal(propFirstIsP1("Set 1 Winner: Waltert vs Kawa", { p1: "Kawa", p2: "Waltert" }), false, "reversed → flip theo");
});

test("P4.2 correlation cluster: Total Games + Total Sets are ONE length cluster", () => {
  assert.equal(corrCluster("total_games"), corrCluster("total_sets"));
  assert.notEqual(corrCluster("total_games"), corrCluster("set_handicap"));
});

test("P4 UNIFORMITY GUARD: a family whose passing edges all lean one side is STOPPED (no bets)", async () => {
  const db = openDb(":memory:");
  process.env.TENNIS_PMV_FLAG_ONLY = "false"; // would bet, but the guard must block the biased family
  migrateTennisPmvStrategy(db);
  const theo = tennisTheo(0.65, BASE_HOLD.wta);
  const t = Math.round(theoForProp(parseProp(Q + "Set 1 Over 8.5")!, theo)! * 100);
  // 6 matches, each with one "Set 1 OVER" underpriced → all passing edges lean "over" → model bias.
  const mids: string[] = [];
  for (let i = 0; i < 6; i++) mids.push(seedScan(db, 65, [{ label: `WTA: P${i}a vs P${i}b Set 1 Over 8.5`, mid: t - 12, liq: 4000 }]));
  const { tennisPmvTick } = await import("../src/lib/tennisPmv.js");
  const opened = await tennisPmvTick(db, { now: () => "2026-07-14T19:00:00Z" });
  assert.equal(opened, 0, "the biased family is stopped — no bets placed");
  const anyStop = mids.some((mid) => R.tradeLogForMatch(db, mid).some((l) => /uniformity_stop/.test(l.text)));
  assert.ok(anyStop, "uniformity_stop logged");
  delete process.env.TENNIS_PMV_FLAG_ONLY;
});

// ── Prop settle by family (Gate 0.2 clauses) ──
const fsFull: FinalSets = { sets: [{ p1: 6, p2: 4 }, { p1: 6, p2: 3 }], setsWonP1: 2, setsWonP2: 0, matchGames: 19 }; // Kawa 2-0
const fsRetiredS1only: FinalSets = { sets: [{ p1: 6, p2: 4 }, { p1: 3, p2: 2 }], setsWonP1: 1, setsWonP2: 0, matchGames: 15 }; // retired mid set 2
const opt = { retired: false, canceled: false, firstIsP1: true };

test("prop settle: a completed match resolves every family", () => {
  assert.equal(resolveTennisProp(Q + "Total Sets: Under 2.5", fsFull, opt), true, "2 sets < 3 → under wins");
  assert.equal(resolveTennisProp("Set Handicap: Kawa (-1.5) vs Waltert (+1.5)", fsFull, opt), true, "Kawa won by 2 sets");
  assert.equal(resolveTennisProp(Q + "Match Under 23.5", fsFull, opt), true, "19 games < 24 → under");
  assert.equal(resolveTennisProp("Set 1 Winner: Kawa vs Waltert", fsFull, opt), true, "Kawa took set 1");
  assert.equal(resolveTennisProp(Q + "Set 1 Over 8.5", fsFull, opt), true, "set 1 had 10 games");
});

test("prop settle: RETIREMENT voids match-scope props but resolves a COMPLETED set (Gate 0.2)", () => {
  const ret = { retired: true, canceled: false, firstIsP1: true };
  assert.equal(resolveTennisProp(Q + "Total Sets: Under 2.5", fsRetiredS1only, ret), null, "Total Sets → VOID on retire");
  assert.equal(resolveTennisProp("Set Handicap: Kawa (-1.5) vs Waltert (+1.5)", fsRetiredS1only, ret), null, "Set Handicap → VOID");
  assert.equal(resolveTennisProp(Q + "Match Over 23.5", fsRetiredS1only, ret), null, "match total games → VOID");
  assert.equal(resolveTennisProp("Set 1 Winner: Kawa vs Waltert", fsRetiredS1only, ret), true, "completed set 1 resolves even post-retire");
  assert.equal(resolveTennisProp(Q + "Set 1 Over 8.5", fsRetiredS1only, ret), true, "completed set 1 games resolve");
  assert.equal(resolveTennisProp(Q + "Set 2 Over 8.5", fsRetiredS1only, ret), null, "incomplete set 2 → VOID");
});

test("prop settle: a walkover/cancel voids everything", () => {
  const cx = { retired: false, canceled: true, firstIsP1: true };
  assert.equal(resolveTennisProp("Set 1 Winner: Kawa vs Waltert", fsFull, cx), null);
  assert.equal(resolveTennisProp(Q + "Match Under 23.5", fsFull, cx), null);
});

test("core Brier criterion: markov ≤ implied → core_beats_market; <40 settles → accumulating", async () => {
  const { buildPmvBrierReport } = await import("../src/lib/tennisPmv.js");
  const db = openDb(":memory:");
  migrateTennisPmvStrategy(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-wta", sport_id: "tennis", name: "WTA", budget: 0, external_league: null, created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-wta", home: "Kawa", away: "Waltert", state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  // 2 settled props: markov prob closer to the outcome than the implied mid → markov Brier lower.
  const mk = (i: number, aiProb: number, entry: number, result: "won" | "lost") => R.insertBet(db, { id: `b${i}`, match_id: mid, strategy_id: "tennis_pmv", risk_profile_id: "medium", market_label: "Iasi: Kawa vs Waltert Match Over 20.5", status: result === "won" ? "settled_won" : "settled_lost", proposed_price: entry, entry_price: entry, current_price: 100, closing_price: 100, ai_prob: aiProb, stake: 50, rationale: "pmv", entered_minute: "предматч", result, payout: result === "won" ? 90 : 0, settled_by: null, settled_at: "t", entry_meta: null, code_version: "e·interim", created_at: "t" } as any);
  mk(1, 0.75, 0.60, "won");  // markov said 0.75 (right), market 0.60
  mk(2, 0.20, 0.40, "lost"); // markov said 0.20 (right), market 0.40
  const acc = buildPmvBrierReport(db);
  assert.equal(acc.settled, 2);
  assert.equal(acc.verdict, "accumulating", "2 < 40 → not judged yet");
  const ready = buildPmvBrierReport(db, 2); // lower the gate to judge
  assert.equal(ready.ready, true);
  assert.ok(ready.brierMarkov < ready.brierImplied, "markov beats implied on these");
  assert.equal(ready.verdict, "core_beats_market");
});

test("migrateVoidAllOpenPmv: voids every open PMV bet (frees the sim budget), marker-guarded", async () => {
  const { migrateVoidAllOpenPmv } = await import("../src/lib/seed.js");
  const db = openDb(":memory:");
  migrateTennisPmvStrategy(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-atp", home: "A", away: "B", state: "upcoming", lineup_out: false, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  for (const p of ["aggressive", "medium"]) R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: "tennis_pmv", risk_profile_id: p, market_label: "ATP: A vs B Total Sets: Over 2.5", status: "open", proposed_price: 35, entry_price: 35, current_price: 35, closing_price: null, ai_prob: 0.5, stake: 80, rationale: "pmv", entered_minute: "предматч", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e·interim", created_at: "t" } as any);
  migrateVoidAllOpenPmv(db, "2026-07-14T21:00:00Z");
  const bets = R.betsForMatch(db, mid, "tennis_pmv");
  assert.ok(bets.every((b) => b.status !== "open" && b.settled_by === "void" && b.payout === b.stake), "all voided + refunded");
  // marker-guarded: a fresh open bet after the run is NOT touched again
  R.insertBet(db, { id: "keep", match_id: mid, strategy_id: "tennis_pmv", risk_profile_id: "medium", market_label: "ATP: A vs B Match Over 21.5", status: "open", proposed_price: 40, entry_price: 40, current_price: 40, closing_price: null, ai_prob: 0.5, stake: 50, rationale: "r", entered_minute: "предматч", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e·interim-m1", created_at: "t" } as any);
  migrateVoidAllOpenPmv(db, "2026-07-14T22:00:00Z");
  assert.equal(R.getBet(db, "keep")!.status, "open", "runs once — later bets survive");
});

test("P2 frequency report: actual 3-set + hold rates from snapshots vs the model", async () => {
  const { buildTennisFrequencyReport } = await import("../src/lib/tennisPmv.js");
  const db = openDb(":memory:");
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const finish = (i: number, sets1: number, sets2: number, holdBreaks: { g1: number; g2: number; server: "first" | "second" }[]) => {
    const mid = R.uid();
    R.insertMatch(db, { id: mid, competition_id: "pm-atp", home: `A${i}`, away: `B${i}`, state: "finished", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: mid } as any);
    let n = 0;
    const put = (g1: number, g2: number, server: "first" | "second" | null, s1: number, s2: number) => R.insertTennisSnapshot(db, { event_key: "E" + i, provider: "apitennis", batch_at: `2026-07-14T10:${String(n++).padStart(2, "0")}:00Z`, p1: `A${i}`, p2: `B${i}`, tournament: "ATP", event_type: "ATP Singles", live: 1, status: "live", sets_p1: s1, sets_p2: s2, set_num: 1, games_p1: g1, games_p2: g2, game_points: null, server, pm_match_id: mid, pm_mid_cents: 50, pm_p1_cents: 50, pm_p2_cents: 50, raw: "{}" } as any);
    put(0, 0, holdBreaks[0]?.server ?? "first", 0, 0);
    for (const hb of holdBreaks) put(hb.g1, hb.g2, hb.server, 0, 0);
    R.insertTennisSnapshot(db, { event_key: "E" + i, provider: "apitennis", batch_at: `2026-07-14T11:00:00Z`, p1: `A${i}`, p2: `B${i}`, tournament: "ATP", event_type: "ATP Singles", live: 0, status: "Finished", sets_p1: sets1, sets_p2: sets2, set_num: 3, games_p1: 6, games_p2: 4, game_points: null, server: null, pm_match_id: mid, pm_mid_cents: 50, pm_p1_cents: 50, pm_p2_cents: 50, raw: "{}" } as any);
  };
  finish(1, 2, 0, [{ g1: 1, g2: 0, server: "first" }]);  // 2-set match, 1 hold (first held)
  finish(2, 2, 1, [{ g1: 0, g2: 1, server: "first" }]);  // 3-set match, 1 break (first broken)
  const rep = buildTennisFrequencyReport(db);
  const atp = rep.tours.find((t) => t.tour === "atp")!;
  assert.equal(atp.allDecided, 2);
  assert.equal(atp.allThreeSetRate, 0.5, "1 of 2 decided went to 3 sets");
  assert.ok(atp.modelThreeSetRateAtBase > 0 && atp.modelThreeSetRateAtBase < 1, "i.i.d. model rate at base present");
  assert.ok(atp.actualHoldRate != null, "hold rate computed (suspect a)");
  // the discriminator field exists: i.i.d. model fed the ACTUAL hold rate (isolates suspect b)
  assert.ok(atp.modelThreeSetRateAtActualHold != null);
  assert.ok(["insufficient", "iid_sets", "base_hold_high", "both", "model_ok"].includes(atp.verdict));
});

test("finalSetsFromRaw: parses API-Tennis scores into per-set games", () => {
  const raw = JSON.stringify({ scores: [{ score_set: 2, score_first: 6, score_second: 3 }, { score_set: 1, score_first: 4, score_second: 6 }] });
  const fs = finalSetsFromRaw(raw)!;
  assert.deepEqual(fs.sets, [{ p1: 4, p2: 6 }, { p1: 6, p2: 3 }], "sorted by set number");
  assert.equal(fs.matchGames, 19);
  assert.equal(fs.setsWonP1, 1); assert.equal(fs.setsWonP2, 1);
});
