import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import {
  serverSide, parsePair, currentSet, normalizeLive, detectBreaks,
  collectTennisSnapshots, buildTennisScoutReport, loadTennisConfig, tennisScoutMarkdown,
} from "../src/lib/tennisScout.js";

const T0 = Date.parse("2026-07-14T00:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

// A real API-Tennis livescore row shape (from the live probe).
const apiRow = (over: any = {}) => ({
  event_key: "E1", event_first_player: "N. Arseneault", event_second_player: "A. Martin",
  event_final_result: "1 - 0", event_game_result: "40 - 40", event_serve: "Second Player",
  event_status: "Set 2", event_live: "1", tournament_name: "Granby", event_type_type: "ATP Singles",
  scores: [{ score_first: "6", score_second: "2", score_set: "1" }, { score_first: "2", score_second: "1", score_set: "2" }],
  ...over,
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
  set_num: 1, games_p1: 0, games_p2: 0, game_points: "0 - 0", server: "first", pm_match_id: null, pm_mid_cents: null, raw: null, created_at: iso(0), ...o,
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
