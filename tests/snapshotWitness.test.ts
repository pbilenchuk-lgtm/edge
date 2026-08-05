import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { snapshotWitness, witnessLine } from "../src/lib/snapshotWitness.js";
import { classifyScoutCoverage } from "../src/lib/scoutCoverage.js";
import { buildEntryFunnel } from "../src/lib/entryFunnel.js";

function tennisMatch(db: ReturnType<typeof openDb>, id: string, kickoffAt: string) {
  R.upsertCompetition(db, { id: "atp-t", sport_id: "tennis", name: "ATP", budget: 1000, external_league: null, created_at: "2026-08-01T00:00:00.000Z" });
  R.insertMatch(db, {
    id, competition_id: "atp-t", home: "A. One", away: "B. Two", state: "live", lineup_out: false,
    kickoff_at: kickoffAt, minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null,
  });
}

test("N7: счётчик-свидетель растёт на КАЖДОЙ записи снимка и не уменьшается при prune", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  tennisMatch(db, "t-1", "2026-08-05T10:00:00.000Z");
  for (let i = 0; i < 5; i++) {
    R.insertTennisSnapshot(db, {
      event_key: `e${i}`, provider: "api-tennis", batch_at: `2026-08-05T10:0${i}:00.000Z`,
      p1: "A. One", p2: "B. Two", tournament: "ATP", event_type: "single", live: 1, status: "Set 1",
      sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: i, games_p2: 0, game_points: null, server: null,
      pm_match_id: "t-1", pm_mid_cents: 50, pm_p1_cents: 50, pm_p2_cents: 50, raw: null,
    });
  }
  assert.equal(R.snapshotWitnessFor(db, "t-1").seenTotal, 5);
  assert.equal(snapshotWitness(db, "t-1", 5).verdict, "present");

  // Ретеншн стирает ВСЕ живые строки — счётчик обязан устоять.
  R.pruneTennisSnapshots(db, "2026-08-06T00:00:00.000Z");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM tennis_snapshots WHERE pm_match_id='t-1'").get() as { n: number }).n, 0);
  const w = snapshotWitness(db, "t-1", 0);
  assert.equal(w.verdict, "wiped");
  assert.equal(w.seenTotal, 5);
  assert.match(w.note, /стёрты ретеншном/);
  assert.match(w.note, /ложным обвинением/);
});

test("N7: 20k-кэп тоже не трогает счётчик — тот же ноль, тот же вердикт wiped", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  tennisMatch(db, "t-cap", "2026-08-05T10:00:00.000Z");
  R.insertTennisSnapshot(db, {
    event_key: "ec", provider: "api-tennis", batch_at: "2026-08-05T10:00:00.000Z",
    p1: "A. One", p2: "B. Two", tournament: "ATP", event_type: "single", live: 1, status: "Set 1",
    sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 1, games_p2: 0, game_points: null, server: null,
    pm_match_id: "t-cap", pm_mid_cents: 50, pm_p1_cents: 50, pm_p2_cents: 50, raw: null,
  });
  R.insertTennisSnapshot(db, {
    event_key: "ec2", provider: "api-tennis", batch_at: "2026-08-05T11:00:00.000Z",
    p1: "C", p2: "D", tournament: "ATP", event_type: "single", live: 1, status: "Set 1",
    sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 1, games_p2: 0, game_points: null, server: null,
    pm_match_id: null, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null, raw: null,
  });
  assert.equal(R.capTennisSnapshots(db, 1), 1);   // самая старая (наша) вылетела
  assert.equal(snapshotWitness(db, "t-cap", 0).verdict, "wiped");
});

test("N7: матч без единого снимка — never, и это ЕДИНСТВЕННЫЙ случай, где обвинение законно", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  tennisMatch(db, "t-never", "2026-08-05T10:00:00.000Z");
  // Свидетель уже «рождён» другим матчем, значит про этот он вправе утверждать.
  tennisMatch(db, "t-other", "2026-08-05T09:00:00.000Z");
  R.insertTennisSnapshot(db, {
    event_key: "eo", provider: "api-tennis", batch_at: "2026-08-05T09:10:00.000Z",
    p1: "X", p2: "Y", tournament: "ATP", event_type: "single", live: 1, status: "Set 1",
    sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 1, games_p2: 0, game_points: null, server: null,
    pm_match_id: "t-other", pm_mid_cents: 50, pm_p1_cents: 50, pm_p2_cents: 50, raw: null,
  });
  const w = snapshotWitness(db, "t-never", 0, "2026-08-05T10:00:00.000Z");
  assert.equal(w.verdict, "never");
  assert.match(w.note, /НИКОГДА/);
});

test("N7: матч СТАРШЕ счётчика получает unknown, а не повтор прежнего обвинения", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  tennisMatch(db, "t-old", "2020-01-01T00:00:00.000Z");
  tennisMatch(db, "t-new", "2026-08-05T09:00:00.000Z");
  R.insertTennisSnapshot(db, {
    event_key: "en", provider: "api-tennis", batch_at: "2026-08-05T09:10:00.000Z",
    p1: "X", p2: "Y", tournament: "ATP", event_type: "single", live: 1, status: "Set 1",
    sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 1, games_p2: 0, game_points: null, server: null,
    pm_match_id: "t-new", pm_mid_cents: 50, pm_p1_cents: 50, pm_p2_cents: 50, raw: null,
  });
  const w = snapshotWitness(db, "t-old", 0, "2020-01-01T00:00:00.000Z");
  assert.equal(w.verdict, "unknown");
  assert.match(w.note, /ответа нет/);
  assert.ok(!/НИКОГДА/.test(w.note), "незнание не выдаётся за факт");
  assert.match(witnessLine(w), /записано за жизнь 0/);
});

test("N7: scout_coverage больше не говорит «провайдер не видел вовсе» о стёртом матче", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const ko = new Date(Date.now() - 3 * 3_600_000).toISOString();
  tennisMatch(db, "t-cov", ko);
  R.insertTennisSnapshot(db, {
    event_key: "ecov", provider: "api-tennis", batch_at: ko,
    p1: "A. One", p2: "B. Two", tournament: "ATP", event_type: "single", live: 1, status: "Set 1",
    sets_p1: 0, sets_p2: 0, set_num: 1, games_p1: 1, games_p2: 0, game_points: null, server: null,
    pm_match_id: "t-cov", pm_mid_cents: 50, pm_p1_cents: 50, pm_p2_cents: 50, raw: null,
  });
  R.pruneTennisSnapshots(db, new Date().toISOString());
  const m = R.getMatch(db, "t-cov")!;
  const row = classifyScoutCoverage(db, m);
  assert.equal(row.verdict, "УСТАРЕЛ");
  assert.match(row.note, /стёр ретеншн, а не провал маппинга/);
});

test("N7: воронка входа — футбольная, теннисные отказы не падают в НЕВЯЗКУ", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  tennisMatch(db, "t-fun", new Date().toISOString());
  const now = new Date().toISOString();
  // Здоровый теннисный отказ своим словарём — воронка не знает такой причины и раньше звала расследование.
  R.insertTradeLog(db, { id: R.uid(), match_id: "t-fun", strategy_id: "edge", minute: null, type: "skip", text: "frozen_favourite: фаворит заморожен", created_at: now });
  const rep = buildEntryFunnel(db, { days: 3 });
  assert.equal(rep.sport, "football");
  assert.equal(rep.offSportSkips, 1);
  assert.match(rep.note, /воронка футбольная/);
  assert.ok(!rep.investigate.some((x) => /НЕВЯЗКА/.test(x)), "чужой спорт не поднимает предохранитель невязки");
});
