import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import {
  serverSide, parsePair, currentSet, normalizeLive, detectBreaks, detectTennisEvents,
  collectTennisSnapshots, buildTennisScoutReport, loadTennisConfig, tennisScoutMarkdown,
  recordTennisBreakMarks, buildTennisBreakReport, tennisMoneyline,
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

// A real API-Tennis livescore row shape (from the live probe).
const apiRow = (over: any = {}) => ({
  event_key: "E1", event_first_player: "N. Arseneault", event_second_player: "A. Martin",
  event_final_result: "1 - 0", event_game_result: "40 - 40", event_serve: "Second Player",
  event_status: "Set 2", event_live: "1", tournament_name: "Granby", event_type_type: "ATP Singles",
  scores: [{ score_first: "6", score_second: "2", score_set: "1" }, { score_first: "2", score_second: "1", score_set: "2" }],
  ...over,
});

test("boot-time emergency prune deletes OLD snapshots (disk recovery), keeps recent", () => {
  const db = openDb(":memory:");
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString(); // 40 days ago (> 5-day retention)
  const fresh = new Date().toISOString();
  R.insertTennisSnapshot(db, { event_key: "OLD", provider: "apitennis", batch_at: old, p1: "A", p2: "B", tournament: null, event_type: null, live: 0, status: null, sets_p1: null, sets_p2: null, set_num: null, games_p1: null, games_p2: null, game_points: null, server: null, pm_match_id: null, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: null });
  R.insertTennisSnapshot(db, { event_key: "NEW", provider: "apitennis", batch_at: fresh, p1: "A", p2: "B", tournament: null, event_type: null, live: 1, status: null, sets_p1: null, sets_p2: null, set_num: null, games_p1: null, games_p2: null, game_points: null, server: null, pm_match_id: null, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: null });
  initSchema(db); // re-run boot: the emergency prune runs before DDL
  assert.equal(R.tennisSnapshotsForEvent(db, "OLD").length, 0, "old snapshot reclaimed");
  assert.equal(R.tennisSnapshotsForEvent(db, "NEW").length, 1, "recent (live) snapshot kept");
});

test("field parsers: server side, pair, current set", () => {
  assert.equal(serverSide("First Player"), "first");
  assert.equal(serverSide("Second Player"), "second");
  assert.equal(serverSide("—"), null);
  assert.deepEqual(parsePair("1 - 0"), [1, 0]);
  assert.deepEqual(parsePair("nope"), [null, null]);
  assert.deepEqual(currentSet([{ score_first: "6", score_second: "2", score_set: "1" }, { score_first: "2", score_second: "1", score_set: "2" }]), { setNum: 2, gamesP1: 2, gamesP2: 1 });
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
