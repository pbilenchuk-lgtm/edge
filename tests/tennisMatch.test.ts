import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { normName, nameSimilarity, mapTennisMatch, logMapDecision } from "../src/lib/tennisMatch.js";

test("normName: diacritics, cyrillic translit, punctuation", () => {
  assert.equal(normName("Đere"), "djere"); // Serbian Đ → "Dj" (Djere)
  assert.equal(normName("N. Djokovïc"), "n. djokovic");
  assert.equal(normName("Медведев"), "medvedev");
  assert.equal(normName("Bautista Agut"), "bautista agut");
});

test("nameSimilarity: initials, order swap, two-word surname, transliteration", () => {
  assert.ok(nameSimilarity("N. Arseneault", "Nicolas Arseneault") >= 0.8, "initial vs full first name");
  assert.equal(nameSimilarity("Roberto Bautista Agut", "Bautista Agut") > 0.9, true, "two-word surname");
  assert.ok(nameSimilarity("Djere", "Đere") >= 0.9, "translit surname");
  assert.equal(nameSimilarity("Alcaraz", "Sinner"), 0, "different players → 0");
  // order independence is handled at the match level (both pairings tried); the name fn is symmetric
  assert.equal(nameSimilarity("Carlos Alcaraz", "Alcaraz Carlos") > 0.9, true);
});

function seedPmTennis(db: ReturnType<typeof openDb>, home: string, away: string, kickoff: string | null) {
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const id = R.uid();
  R.insertMatch(db, { id, competition_id: "pm-atp", home, away, state: "upcoming", lineup_out: false, kickoff_at: kickoff, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });
  return id;
}

test("mapTennisMatch: confident name+date match → auto; both players required", () => {
  const db = openDb(":memory:");
  const t = "2026-07-14T09:00:00Z";
  const mid = seedPmTennis(db, "Nicolas Arseneault", "Andres Martin", t);
  const res = mapTennisMatch(db, { p1: "N. Arseneault", p2: "A. Martin", startMs: Date.parse(t) });
  assert.equal(res.verdict, "auto");
  assert.equal(res.matchId, mid);
  assert.ok(res.score >= 0.82);
});

test("mapTennisMatch: only ONE player matches → not auto (both required)", () => {
  const db = openDb(":memory:");
  seedPmTennis(db, "Nicolas Arseneault", "Someone Else", "2026-07-14T09:00:00Z");
  const res = mapTennisMatch(db, { p1: "N. Arseneault", p2: "A. Martin", startMs: Date.parse("2026-07-14T09:00:00Z") });
  assert.notEqual(res.verdict, "auto", "a single-player match must never auto-map");
  assert.equal(res.matchId, null);
});

test("mapTennisMatch: no candidate → skip; nothing trades on a guess", () => {
  const db = openDb(":memory:");
  const res = mapTennisMatch(db, { p1: "X. Player", p2: "Y. Player", startMs: Date.now() });
  assert.equal(res.verdict, "skip");
  assert.equal(res.matchId, null);
});

test("logMapDecision persists the evidence trail", () => {
  const db = openDb(":memory:");
  const t = "2026-07-14T09:00:00Z";
  seedPmTennis(db, "Nicolas Arseneault", "Andres Martin", t);
  const res = mapTennisMatch(db, { p1: "N. Arseneault", p2: "A. Martin", startMs: Date.parse(t) });
  logMapDecision(db, "E1", { p1: "N. Arseneault", p2: "A. Martin" }, res, t);
  const log = R.tennisMapLog(db);
  assert.equal(log.length, 1);
  assert.equal(log[0].verdict, "auto");
  assert.ok(JSON.parse(log[0].candidates!).length >= 1, "candidate scores stored");
});
