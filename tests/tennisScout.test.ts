import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import {
  serverSide, parsePair, currentSet, normalizeLive, detectBreaks, detectTennisEvents,
  collectTennisSnapshots, buildTennisScoutReport, loadTennisConfig, tennisScoutMarkdown,
  recordTennisBreakMarks, buildTennisBreakReport, tennisMoneyline, tennisScoutSilence,
  buildTennisOverreactionCohort,
} from "../src/lib/tennisScout.js";

const T0 = Date.parse("2026-07-14T00:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

// The REAL 15-market set for Granby: Kaichi Uchida vs Alexis Galarneau (from prod). The ONLY
// non-prop label is the bare moneyline @ 6.4¢ (= P(Uchida, the first-named)); everything else is a prop.
const UCHIDA_MARKETS: [string, number][] = [
  ["Granby: Kaichi Uchida vs Alexis Galarneau Match Over 21.5", 70.5],
  ["Granby: Kaichi Uchida vs Alexis Galarneau Match Under 21.5", 29.5],
  ["Granby: Kaichi Uchida vs Alexis Galarneau Total Sets: Over 2.5", 13.5],
  ["Granby: Kaichi Uchida vs Alexis Galarneau Total Sets: Under 2.5", 86.5],
  ["Granby: Kaichi Uchida vs Alexis Galarneau Set Handicap +/-1.5", 50],
  ["Granby: Kaichi Uchida vs Alexis Galarneau", 6.4], // ← the moneyline
  ["Granby: Kaichi Uchida vs Alexis Galarneau Set 1 Over 10.5", 50],
  ["Granby: Kaichi Uchida vs Alexis Galarneau Set 1 Under 10.5", 50],
  ["Granby: Kaichi Uchida vs Alexis Galarneau Set 1 Winner", 37.5],
  ["Granby: Kaichi Uchida vs Alexis Galarneau Set 2 Winner", 12],
  ["Granby: Kaichi Uchida vs Alexis Galarneau Set 1 Over 9.5", 50],
  ["Granby: Kaichi Uchida vs Alexis Galarneau Match Over 23.5", 50],
];
function seedUchida(db: ReturnType<typeof openDb>, markets = UCHIDA_MARKETS) {
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-atp", home: "Kaichi Uchida", away: "Alexis Galarneau", state: "live", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  for (const [label, price] of markets) R.insertMarket(db, { id: R.uid(), match_id: mid, label, price, ai_prob: null, liquidity: "4000", external_ref: R.uid(), snapshot_at: "t", is_closing: false } as any);
  return mid;
}

test("tennisMoneyline: returns the bare moneyline (not a prop) with per-player prices, from the real 15-market set", () => {
  const db = openDb(":memory:");
  const mid = seedUchida(db);
  const ml = tennisMoneyline(db, mid, { p1: "Kaichi Uchida", p2: "Alexis Galarneau" })!;
  assert.ok(ml, "moneyline resolved");
  assert.equal(ml.label, "Granby: Kaichi Uchida vs Alexis Galarneau", "the bare label, NOT Match Over 21.5");
  assert.equal(ml.p1Cents, 6.4, "P(Uchida) = stored first-outcome price");
  assert.equal(ml.p2Cents, 93.6, "P(Galarneau) = 100 − first");
  // scout format names (K. Uchida) still align by surname
  assert.equal(tennisMoneyline(db, mid, { p1: "A. Galarneau", p2: "K. Uchida" })!.p1Cents, 93.6, "aligned to whichever player is p1");
});

test("tennisMoneyline: HONEST SKIP (null) when there is no moneyline, never the closest prop", () => {
  const db = openDb(":memory:");
  // Same set but WITHOUT the bare moneyline → only props remain → must return null, not Match Over 21.5.
  const mid = seedUchida(db, UCHIDA_MARKETS.filter(([l]) => l !== "Granby: Kaichi Uchida vs Alexis Galarneau"));
  assert.equal(tennisMoneyline(db, mid, { p1: "Kaichi Uchida", p2: "Alexis Galarneau" }), null, "no non-prop market → skip, not a prop");
});

test("tennisMoneyline: HONEST SKIP when two non-prop markets are ambiguous", () => {
  const db = openDb(":memory:");
  const mid = seedUchida(db, [["Granby: Kaichi Uchida vs Alexis Galarneau", 6.4], ["Granby: Kaichi Uchida vs Alexis Galarneau (alt)", 30]]);
  assert.equal(tennisMoneyline(db, mid, { p1: "Kaichi Uchida", p2: "Alexis Galarneau" }), null, "two candidates → ambiguous → skip");
});

// Travaglia–Navone (Båstad ATP, prod): the market set carried "Completed Match — Yes/No" alongside
// the moneyline. Those labels have no prop keyword but ARE non-prop → old filter counted 3 non-prop
// markets → nonProp.length !== 1 → null → dead PM price feed the whole match. The moneyline is the
// ONLY " vs " title AND "completed" is now a prop keyword, so it must resolve cleanly.
test("tennisMoneyline: resolves through 'Completed Match — Yes/No' side markets (Travaglia–Navone)", () => {
  const db = openDb(":memory:");
  const mid = seedUchida(db, [
    ["Båstad: Stefano Travaglia vs Mariano Navone", 43.5], // ← the moneyline
    ["Båstad: Stefano Travaglia vs Mariano Navone Total Sets: Under 2.5", 60],
    ["Completed Match — Yes", 88],
    ["Completed Match — No", 12],
  ]);
  const ml = tennisMoneyline(db, mid, { p1: "Stefano Travaglia", p2: "Mariano Navone" });
  assert.ok(ml, "resolved despite the two Completed-Match side markets");
  assert.equal(ml!.label, "Båstad: Stefano Travaglia vs Mariano Navone", "the bare moneyline, not a Completed-Match line");
  assert.equal(ml!.p1Cents, 43.5, "P(Travaglia) = stored first-outcome price");
});

// A real API-Tennis livescore row shape (from the live probe).
const apiRow = (over: any = {}) => ({
  event_key: "E1", event_first_player: "N. Arseneault", event_second_player: "A. Martin",
  event_final_result: "1 - 0", event_game_result: "40 - 40", event_serve: "Second Player",
  event_status: "Set 2", event_live: "1", tournament_name: "Granby", event_type_type: "ATP Singles",
  scores: [{ score_first: "6", score_second: "2", score_set: "1" }, { score_first: "2", score_second: "1", score_set: "2" }],
  ...over,
});

test("boot (initSchema) does NOT prune snapshots — retention is the background tick's job", () => {
  const db = openDb(":memory:");
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString(); // 40 days ago (> 5-day retention)
  const fresh = new Date().toISOString();
  R.insertTennisSnapshot(db, { event_key: "OLD", provider: "apitennis", batch_at: old, p1: "A", p2: "B", tournament: null, event_type: null, live: 0, status: null, sets_p1: null, sets_p2: null, set_num: null, games_p1: null, games_p2: null, game_points: null, server: null, pm_match_id: null, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: null });
  R.insertTennisSnapshot(db, { event_key: "NEW", provider: "apitennis", batch_at: fresh, p1: "A", p2: "B", tournament: null, event_type: null, live: 1, status: null, sets_p1: null, sets_p2: null, set_num: null, games_p1: null, games_p2: null, game_points: null, server: null, pm_match_id: null, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: null });
  // Boot must stay CHEAP: the old "emergency prune" here did a batch_at full-scan on the first
  // getDb() (the /api/health path) and stalled Render's port scan. initSchema now touches nothing —
  // both rows survive a re-boot; retention happens later, off the boot path.
  initSchema(db);
  assert.equal(R.tennisSnapshotsForEvent(db, "OLD").length, 1, "boot does NOT delete old rows");
  assert.equal(R.tennisSnapshotsForEvent(db, "NEW").length, 1, "recent snapshot kept");
  // The background tick's prune (lifecycle.ts) is what enforces retention.
  const cutoff = new Date(Date.now() - 5 * 86_400_000).toISOString();
  R.pruneTennisSnapshots(db, cutoff);
  assert.equal(R.tennisSnapshotsForEvent(db, "OLD").length, 0, "tick prune reclaims old");
  assert.equal(R.tennisSnapshotsForEvent(db, "NEW").length, 1, "tick prune keeps recent");
});

test("field parsers: server side, pair, current set", () => {
  assert.equal(serverSide("First Player"), "first");
  assert.equal(serverSide("Second Player"), "second");
  assert.equal(serverSide("—"), null);
  assert.deepEqual(parsePair("1 - 0"), [1, 0]);
  assert.deepEqual(parsePair("nope"), [null, null]);
  assert.deepEqual(currentSet([{ score_first: "6", score_second: "2", score_set: "1" }, { score_first: "2", score_second: "1", score_set: "2" }]), { setNum: 2, gamesP1: 2, gamesP2: 1 });
  // P1.4: a tiebreak encodes points as a decimal («6.3» = 6 games, 3 TB points) — games truncate to whole.
  assert.deepEqual(currentSet([{ score_first: "6.3", score_second: "7.7", score_set: "3" }]), { setNum: 3, gamesP1: 6, gamesP2: 7 }, "tiebreak decimals truncated to integer games");
});

test("normalizeLive maps the API-Tennis row to the internal shape", () => {
  const n = normalizeLive(apiRow())!;
  assert.equal(n.eventKey, "E1");
  assert.equal(n.server, "second");
  assert.equal(n.setsP1, 1); assert.equal(n.setsP2, 0);
  assert.equal(n.setNum, 2); assert.equal(n.gamesP1, 2); assert.equal(n.gamesP2, 1);
  assert.equal(n.live, 1);
  assert.equal(normalizeLive({}), null);
});

const snap = (o: Partial<R.TennisSnapshotRow>): R.TennisSnapshotRow => ({
  id: R.uid(), event_key: "E1", provider: "apitennis", batch_at: iso(0), p1: "Arseneault", p2: "Martin",
  tournament: "Granby", event_type: "ATP Singles", live: 1, status: "Set 1", sets_p1: 0, sets_p2: 0,
  set_num: 1, games_p1: 0, games_p2: 0, game_points: "0 - 0", server: "first", pm_match_id: null, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: null, created_at: iso(0), ...o,
});

test("detectBreaks: the SERVER losing a game is a break; a hold is not", () => {
  // t0: first serving, 0-0 → t1: second won that game (0-1) = BREAK of the first player.
  const rows = [
    snap({ batch_at: iso(0), set_num: 1, games_p1: 0, games_p2: 0, server: "first" }),
    snap({ batch_at: iso(20), set_num: 1, games_p1: 0, games_p2: 1, server: "second" }), // first was broken
    snap({ batch_at: iso(40), set_num: 1, games_p1: 0, games_p2: 2, server: "first" }),  // second held (winner==server) → NOT a break
  ];
  const br = detectBreaks(rows);
  assert.equal(br.length, 1, "exactly one break");
  assert.equal(br[0].server, "first");
  assert.equal(br[0].winner, "second");
  assert.equal(br[0].brokenPlayer, "Arseneault");
});

test("detectBreaks: rollback and >1-game jumps are skipped (not guessed)", () => {
  const rows = [
    snap({ batch_at: iso(0), set_num: 1, games_p1: 2, games_p2: 3, server: "first" }),
    snap({ batch_at: iso(20), set_num: 1, games_p1: 2, games_p2: 2, server: "first" }), // rollback → skip
    snap({ batch_at: iso(40), set_num: 1, games_p1: 2, games_p2: 4, server: "first" }), // +2 games (missed poll) → skip
    snap({ batch_at: iso(60), set_num: 2, games_p1: 0, games_p2: 1, server: "second" }), // set boundary → skip
  ];
  assert.equal(detectBreaks(rows).length, 0);
});

test("detectTennisEvents: tiebreak set (6-6 → 7-6) is a set, NOT a break", () => {
  const rows = [
    snap({ batch_at: iso(0), set_num: 1, games_p1: 6, games_p2: 6, server: "first" }),
    snap({ batch_at: iso(20), set_num: 1, games_p1: 7, games_p2: 6, server: "first" }),
    snap({ batch_at: iso(40), set_num: 1, games_p1: 7, games_p2: 6, server: "first" }),
  ];
  const ev = detectTennisEvents(rows);
  assert.equal(ev.filter((e) => e.type === "break").length, 0, "no break at 6-6");
  assert.ok(ev.some((e) => e.type === "tiebreak_set"), "a tiebreak_set is emitted");
});

test("detectTennisEvents: a score that reverts next snapshot is a correction, not a break", () => {
  const rows = [
    snap({ batch_at: iso(0), set_num: 1, games_p1: 3, games_p2: 3, server: "first" }),
    snap({ batch_at: iso(20), set_num: 1, games_p1: 3, games_p2: 4, server: "first" }), // apparent break…
    snap({ batch_at: iso(40), set_num: 1, games_p1: 3, games_p2: 3, server: "first" }), // …reverted → correction
  ];
  const ev = detectTennisEvents(rows);
  assert.equal(ev.filter((e) => e.type === "break").length, 0, "unstable score is not a break");
  assert.ok(ev.some((e) => e.type === "correction"));
});

test("detectTennisEvents: retirement mid-game is detected from status", () => {
  const rows = [
    snap({ batch_at: iso(0), set_num: 2, games_p1: 3, games_p2: 2, server: "first", status: "Set 2" }),
    snap({ batch_at: iso(20), set_num: 2, games_p1: 3, games_p2: 2, server: "first", status: "Retired", live: 0 }),
  ];
  assert.ok(detectTennisEvents(rows).some((e) => e.type === "retirement"), "retirement surfaced");
});

test("collectTennisSnapshots: no key → inert; with a mock feed → writes parsed live rows", async () => {
  const db = openDb(":memory:");
  assert.equal(loadTennisConfig({}).enabled, false);
  assert.equal(await collectTennisSnapshots(db, { env: {}, now: () => iso(0) }), 0, "no key → inert");

  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ success: 1, result: [apiRow(), apiRow({ event_key: "E2", event_live: "0" })] }) })) as any;
  const written = await collectTennisSnapshots(db, { env: { API_TENNIS_KEY: "k" }, now: () => iso(0), fetchImpl });
  assert.equal(written, 1, "only the LIVE match (E1) is stored, not the finished E2");
  const rows = R.tennisSnapshotsForEvent(db, "E1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].server, "second");
  assert.equal(rows[0].games_p1, 2);
});

test("tennisScoutSilence: alerts when the schedule says live but no snapshot lands; recovers on a fresh write", () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const now = "2026-07-14T12:00:00Z";
  const nowMs = Date.parse(now);
  const mid = "sched1";
  // Kickoff 90 min ago, not finished → per the EXTERNAL schedule this match should be live now.
  R.insertMatch(db, { id: mid, competition_id: "pm-atp", home: "A", away: "B", state: "upcoming", lineup_out: true, kickoff_at: new Date(nowMs - 90 * 60_000).toISOString(), minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  // No snapshots at all AND no scout-OK marker → silent, classified H1 (scout not being called).
  const s1 = tennisScoutSilence(db, { now: () => now });
  assert.equal(s1.silent, true, "due-live match + no scout data → silent");
  assert.match(s1.note, /H1|не вызывался/, "classified as loop/process not calling the scout");
  // A fresh snapshot within the window → recovered (not silent).
  R.insertTennisSnapshot(db, { event_key: "E", provider: "apitennis", batch_at: new Date(nowMs - 60_000).toISOString(), p1: "A", p2: "B", tournament: "ATP", event_type: "ATP Singles", live: 1, status: "live", sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 1, games_p2: 0, game_points: null, server: "first", pm_match_id: mid, pm_mid_cents: 60, pm_p1_cents: 60, pm_p2_cents: 40, raw: "{}" } as any);
  assert.equal(tennisScoutSilence(db, { now: () => now }).silent, false, "a fresh write clears the alert");
  // No due-live match at all → never silent (a genuinely quiet slate).
  R.updateMatch(db, mid, { state: "finished" });
  assert.equal(tennisScoutSilence(db, { now: () => now }).silent, false, "finished match → nothing due-live → quiet, not an alert");
});

test("P1.3 stop-poll: an identical terminal snapshot stops being re-written after 3 (scout hygiene)", async () => {
  const db = openDb(":memory:"); initSchema(db);
  const feed = (async () => ({ ok: true, status: 200, json: async () => ({ success: 1, result: [apiRow({ event_key: "FIN", event_status: "Finished", event_live: "0" })] }) })) as any;
  const run = () => collectTennisSnapshots(db, { env: { API_TENNIS_KEY: "k" }, now: () => new Date(Date.now() + Math.random()).toISOString(), fetchImpl: feed });
  for (let i = 0; i < 3; i++) await run();
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM tennis_snapshots WHERE event_key='FIN'`).get() as any).n, 3, "first 3 terminal snapshots written");
  await run(); // 4th identical terminal → skipped
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM tennis_snapshots WHERE event_key='FIN'`).get() as any).n, 3, "4th identical terminal snapshot NOT re-written");
  const savings = JSON.parse(R.metaGet(db, "tennis_scout_savings") as string);
  assert.ok(savings.finishedSkipped >= 1, "the skip is tallied for the savings estimate");
});

test("collectTennisSnapshots: stamps the OWN liveness marker on a completed run (independent of match.state)", async () => {
  const db = openDb(":memory:");
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ success: 1, result: [] }) })) as any; // provider returns EMPTY
  const n = await collectTennisSnapshots(db, { env: { API_TENNIS_KEY: "k" }, now: () => "2026-07-14T12:00:00Z", fetchImpl });
  assert.equal(n, 0, "empty provider response → 0 written");
  const ok = R.metaGet(db, "tennis_scout_last_ok");
  assert.ok(ok && ok.endsWith("|0"), "OK marker stamped with written=0 — the loop ran (blind), it did not die silently");
});

test("buildTennisScoutReport aggregates coverage + breaks from stored snapshots", () => {
  const db = openDb(":memory:");
  R.insertTennisSnapshot(db, { ...snap({ batch_at: iso(0), games_p1: 0, games_p2: 0, server: "first" }), id: undefined as any, created_at: undefined as any });
  R.insertTennisSnapshot(db, { ...snap({ batch_at: iso(20), games_p1: 0, games_p2: 1, server: "second" }), id: undefined as any, created_at: undefined as any });
  const rep = buildTennisScoutReport(db);
  assert.equal(rep.events, 1);
  assert.equal(rep.totalSnapshots, 2);
  assert.equal(rep.breaks.length, 1, "the break is surfaced in the report");
  assert.equal(rep.coverageByType[0].type, "ATP Singles");
  assert.match(tennisScoutMarkdown(rep), /разведка провайдера/i);
});

test("buildTennisOverreactionCohort: armed-cohort filter, from-floor recovery, breakeven verdict (Step 1)", () => {
  const db = openDb(":memory:");
  let seq = 0;
  const mk = (o: { pre: number; floor: number; panic: number; rec2: number; early?: number; type?: string }) =>
    R.insertTennisBreakMark(db, {
      event_key: `e${seq++}`, match_id: null, players: "A vs B", tournament: "T", event_type: o.type ?? "ATP Singles",
      set_num: 1, broken_side: "first", broke_early: o.early ?? 1, t_event: iso(0),
      pre_cents: o.pre, floor_cents: o.floor, t_floor_sec: 60, panic_cents: o.panic,
      recovery_1: null, recovery_2: o.rec2, recovery_3: null, recovery_5: null,
      post_entry_min_cents: o.floor, post_entry_min_sec: 60, window_quotes: 5, confidence_flags: null, code_version: "e", created_at: iso(0),
    });
  // 90 favourite-early ATP marks: 72 recover to the take level (pre−3), 18 slide deep with no recovery.
  //   recover: pre65 floor52 panic13, rec2=13 ≥ panic−3(10) → recovered.
  //   deep:    pre65 floor42 panic23, rec2=0  < 20            → not recovered.
  // → floor p60 = 52 (E), pre median 65 → take 62 (T), panic p90 = 23 → stop 42 (S).
  //   breakeven = (E−S)/(T−S) = 10/20 = 0.5 → threshold max(0.55, 0.55) = 0.55; recovery 0.8 ≥ 0.55 → GO.
  for (let i = 0; i < 72; i++) mk({ pre: 65, floor: 52, panic: 13, rec2: 13 });
  for (let i = 0; i < 18; i++) mk({ pre: 65, floor: 42, panic: 23, rec2: 0 });
  // NOISE that must be EXCLUDED from the primary cohort:
  mk({ pre: 45, floor: 30, panic: 15, rec2: 14 });                    // underdog (pre < 60) — excluded
  mk({ pre: 65, floor: 52, panic: 13, rec2: 13, early: 0 });          // late break — excluded
  mk({ pre: 65, floor: 52, panic: 13, rec2: 13, type: "Challenger" }); // out of tour scope — excluded
  mk({ pre: 57, floor: 45, panic: 12, rec2: 11 });                    // 55–60¢ band — sensitivity, NOT primary

  const rep = buildTennisOverreactionCohort(db);
  assert.equal(rep.primary.n, 90, "only favourite(≥60)-early ATP/WTA marks count in the primary cohort");
  assert.equal(rep.primary.floorP60, 52, "entry = floor p60");
  assert.equal(rep.primary.takeLevel, 62, "take = pre median − 3");
  assert.equal(rep.primary.stopLevel, 42, "stop = pre median − slide p90");
  assert.equal(rep.primary.breakevenPct, 0.5, "breakeven (E−S)/(T−S)");
  assert.equal(rep.primary.goThreshold, 0.55, "threshold = max(0.55, breakeven+0.05)");
  assert.equal(rep.primary.recoveryShare, 0.8, "72/90 reached the take level within ≤2 min of the floor");
  assert.equal(rep.primary.verdict, "go", "recovery 80% ≥ 55% → tradeable edge → Step 2 allowed");
  assert.equal(rep.sensitivity.n, 1, "the 55–60¢ mark is a separate sensitivity band, never merged into primary");
  assert.equal(rep.sensitivity.verdict, "sensitivity");

  // Sufficiency gate: a thin cohort (< 80) is INSUFFICIENT, not a verdict.
  const db2 = openDb(":memory:");
  seq = 0;
  const mk2 = (o: any) => R.insertTennisBreakMark(db2, { event_key: `e${seq++}`, match_id: null, players: "A vs B", tournament: "T", event_type: "WTA Singles", set_num: 1, broken_side: "first", broke_early: 1, t_event: iso(0), pre_cents: 65, floor_cents: 52, t_floor_sec: 60, panic_cents: 13, recovery_1: null, recovery_2: 13, recovery_3: null, recovery_5: null, post_entry_min_cents: 52, post_entry_min_sec: 60, window_quotes: 5, confidence_flags: null, code_version: "e", created_at: iso(0) });
  for (let i = 0; i < 40; i++) mk2({});
  assert.equal(buildTennisOverreactionCohort(db2).primary.verdict, "insufficient", "n=40 < 80 → insufficient, don't decide");
});

test("recordTennisBreakMarks: marks the panic window on the broken player's winner price (§4)", () => {
  const db = openDb(":memory:");
  // First serving; second breaks at +20s. Broken side = 'first' → uses pm_p1_cents.
  // P1 win price: 70 (pre) → dips to 55 (floor) → recovers 62. Break window: [T-1m, T+6m].
  const S = (o: Partial<R.TennisSnapshotRow>) => R.insertTennisSnapshot(db, { ...snap(o), id: undefined as any, created_at: undefined as any });
  S({ batch_at: iso(0), set_num: 1, games_p1: 3, games_p2: 3, server: "first", pm_match_id: "m1", pm_p1_cents: 70 });
  S({ batch_at: iso(20), set_num: 1, games_p1: 3, games_p2: 4, server: "second", pm_match_id: "m1", pm_p1_cents: 66 }); // BREAK of first
  S({ batch_at: iso(40), set_num: 1, games_p1: 3, games_p2: 4, server: "first", pm_match_id: "m1", pm_p1_cents: 60 });
  S({ batch_at: iso(80), set_num: 1, games_p1: 3, games_p2: 4, server: "first", pm_match_id: "m1", pm_p1_cents: 55 }); // floor
  S({ batch_at: iso(140), set_num: 1, games_p1: 3, games_p2: 4, server: "first", pm_match_id: "m1", pm_p1_cents: 62 }); // recovery ~1m from floor
  // "now" is well past the +6min window so the break is markable.
  const n = recordTennisBreakMarks(db, { now: () => iso(60 * 60) });
  assert.equal(n, 1, "one break marked");
  const marks = R.listTennisBreakMarks(db);
  assert.equal(marks[0].broken_side, "first");
  assert.equal(marks[0].broke_early, 1, "1st-set break tagged early");
  assert.equal(marks[0].floor_cents, 55, "floor = lowest P1 win price in the window");
  // further-collapse metric: deepest post-break price + time, over the FULL forward series.
  assert.equal(marks[0].post_entry_min_cents, 55, "deepest favourite price from the break forward");
  assert.equal(marks[0].post_entry_min_sec, 60, "reached 60s after the break (t=80s − break 20s)");
  // idempotent: a second run does not duplicate
  assert.equal(recordTennisBreakMarks(db, { now: () => iso(60 * 60) }), 0);
  const brep = buildTennisBreakReport(db);
  assert.equal(brep.totalMarks, 1);
  assert.ok(!brep.ready, "1 of 100 → not calibration-ready");
});
