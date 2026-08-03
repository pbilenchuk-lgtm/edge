// ============================================================
// EDGE LAB — «НЕТ СЧЁТА» ОБЯЗАНО НАЗЫВАТЬ ПРИЧИНУ
//
// Здесь держатся свойства, которых не хватило именно мне. Я прочитал `no_score_data_skip (15м > 15м)`
// в 64% логов и объявил структурный дедлок каденции — а пятнадцать там стоит ПО КОНСТРУКЦИИ: строка
// пишется на первом же пересечении порога и больше никогда. Тест на это стоит первым.
//
// Второе свойство важнее: у «нет данных» шесть разных причин, и три из них — НЕ дефект. Слепив их в
// одну долю покрытия, я получил бы красивую дробь, которая ничего не измеряет. Знаменатель здесь
// назван, и в него входят только те матчи, где данные ДОЛЖНЫ быть.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildScoutCoverage, classifyScoutCoverage, scoutCoverageLine, SV_SNAP_STALE_MIN, OVERDUE_H } from "../src/lib/scoutCoverage.js";

const NOW = "2026-08-03T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const iso = (minAgo: number) => new Date(NOW_MS - minAgo * 60_000).toISOString();

function world() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 1000, external_league: null, created_at: "2026-08-01" } as never);
  return db;
}
function match(db: ReturnType<typeof world>, id: string, home: string, away: string, koMinAgo: number, state = "live") {
  R.insertMatch(db, { id, competition_id: "atp", home, away, state, lineup_out: false, kickoff_at: iso(koMinAgo), minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as never);
  return R.listMatches(db, "atp").find((m) => m.id === id)!;
}
function snap(db: ReturnType<typeof world>, matchId: string | null, minAgo: number, status: string) {
  R.insertTennisSnapshot(db, {
    event_key: `ek-${matchId ?? "x"}-${minAgo}`, provider: "apitennis", batch_at: iso(minAgo), p1: "A", p2: "B",
    tournament: "ATP", event_type: "ATP Singles", live: 1, status, sets_p1: 1, sets_p2: 0, set_num: 2,
    games_p1: 0, games_p2: 0, game_points: null, server: null, pm_match_id: matchId, pm_mid_cents: null,
    pm_p1_cents: null, pm_p2_cents: null, raw: null,
  });
}

test("возраст в прежней диагностике был ТАВТОЛОГИЕЙ — причина не выводится из числа", () => {
  const db = world();
  const m = match(db, "m1", "Иванов", "Петров", 60);
  snap(db, "m1", SV_SNAP_STALE_MIN + 1, "Set 2");
  const a = classifyScoutCoverage(db, m, NOW);
  // Тот же матч часом позже: возраст другой, ПРИЧИНА та же. Значит по возрасту причину и не узнать —
  // а прежняя строка печатала только возраст, и только один раз, всегда «15м > 15м».
  const later = classifyScoutCoverage(db, m, new Date(NOW_MS + 60 * 60_000).toISOString());
  assert.equal(a.verdict, "УСТАРЕЛ");
  assert.equal(later.verdict, "УСТАРЕЛ");
  assert.notEqual(a.ageMin, later.ageMin, "возраст растёт");
  assert.match(a.note, /провайдер перестал отдавать матч/);
});

test("НЕ СВЯЗАН отделён от НЕ В ФИДЕ: одно чинится алиасом, другое — вообще не нами", () => {
  const db = world();
  const seen = match(db, "m1", "Н. Джокович", "К. Алькарас", 30);
  const unseen = match(db, "m2", "Иванов", "Сидоров", 30);
  R.insertTennisMapLog(db, {
    event_key: "ek1", players: "Djokovic N. vs Alcaraz C.", verdict: "review", match_id: null, score: 0.71,
    candidates: JSON.stringify([{ matchId: "m1", home: "Н. Джокович", away: "К. Алькарас", nameScore: 0.71, dateOk: false, score: 0.71 }]),
    created_at: iso(5),
  });
  const a = classifyScoutCoverage(db, seen, NOW);
  const b = classifyScoutCoverage(db, unseen, NOW);
  assert.equal(a.verdict, "НЕ СВЯЗАН");
  assert.equal(a.mapScore, 0.71);
  assert.match(a.note, /чинится алиасом имён, а не порогом свежести/);
  assert.match(a.note, /зазор 0\.11/, "зазор до порога назван числом — иначе непонятно, насколько близко");
  assert.equal(b.verdict, "НЕ В ФИДЕ");
  assert.match(b.note, /не видел вовсе/);
});

test("до начала матча отсутствие снимков НЕ утверждает ничего — и в знаменатель не входит", () => {
  const db = world();
  match(db, "m1", "Иванов", "Петров", -120, "upcoming");     // старт через два часа
  const r = buildScoutCoverage(db, NOW);
  assert.equal(r.rows[0].verdict, "ДО НАЧАЛА");
  assert.equal(r.measured, 0);
  assert.equal(r.actionable.length, 0, "сторож не воет там, где ничего не измеряет");
  assert.match(r.note, /ОТСУТСТВИЕ ЗАМЕРА, а не 100% покрытие/);
  assert.match(scoutCoverageLine(r), /НЕ ИЗМЕРЯЕТСЯ/);
});

test("терминальный статус у провайдера — законное отсутствие данных, а не пробел покрытия", () => {
  const db = world();
  const m = match(db, "m1", "Иванов", "Петров", 200);
  snap(db, "m1", 120, "Finished");
  const r = classifyScoutCoverage(db, m, NOW);
  assert.equal(r.verdict, "ЗАВЕРШЁН У ПРОВАЙДЕРА");
  assert.match(r.note, /вопрос к финишеру, а не к скауту/);
});

test("просроченная запись названа отдельно — иначе она вечно портит долю покрытия", () => {
  const db = world();
  const m = match(db, "m1", "Иванов", "Петров", (OVERDUE_H + 2) * 60);
  const r = classifyScoutCoverage(db, m, NOW);
  assert.equal(r.verdict, "ПРОСРОЧЕН");
  assert.match(r.note, /мусор в записях, а не пробел покрытия/);
});

test("свежий связанный снимок — покрыт; порог тот же, что у отказа Set-Value", () => {
  const db = world();
  const m = match(db, "m1", "Иванов", "Петров", 40);
  snap(db, "m1", SV_SNAP_STALE_MIN - 1, "Set 2");
  const r = classifyScoutCoverage(db, m, NOW);
  assert.equal(r.verdict, "покрыт");
  assert.equal(r.snapshots, 1);
});

test("доля покрытия считается по НАЗВАННОМУ знаменателю, а не по всем матчам подряд", () => {
  const db = world();
  match(db, "cov", "A", "B", 40); snap(db, "cov", 2, "Set 1");
  match(db, "stale", "C", "D", 40); snap(db, "stale", SV_SNAP_STALE_MIN + 30, "Set 2");
  match(db, "pre", "E", "F", -60, "upcoming");
  match(db, "done", "G", "H", 200); snap(db, "done", 100, "Finished");
  const r = buildScoutCoverage(db, NOW);
  assert.equal(r.rows.length, 4);
  assert.equal(r.covered, 1);
  assert.equal(r.measured, 2, "до начала и завершённые у провайдера в знаменатель НЕ входят");
  assert.deepEqual(r.actionable.map((x) => x.verdict), ["УСТАРЕЛ"]);
  assert.match(r.note, /покрытие 1\/2/);
});

test("модуль read-only: ни одного пути к записи", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/scoutCoverage.ts", import.meta.url), "utf8");
  for (const forbidden of ["insertTradeLog", "updateBet", "metaSet", "UPDATE ", "INSERT ", "DELETE "]) {
    assert.ok(!src.includes(forbidden), `отчёт о покрытии обязан быть read-only, найдено «${forbidden}»`);
  }
});
