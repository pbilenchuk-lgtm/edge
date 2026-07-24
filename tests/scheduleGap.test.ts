import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { recordScheduleGap, scheduleGapSummary, gapAlertSec } from "../src/lib/scheduleGap.js";

test("gapAlertSec: default 5 min, env override", () => {
  assert.equal(gapAlertSec({}), 300);
  assert.equal(gapAlertSec({ SCHEDULE_GAP_ALERT_SEC: "120" }), 120);
});

test("recordScheduleGap: a fresh marker or first-ever stamp is NOT a gap", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const now = Date.parse("2026-07-22T18:05:00Z");
  assert.equal(recordScheduleGap(db, 0, now, false, {}), null, "no previous stamp → no gap");
  assert.equal(recordScheduleGap(db, now - 20_000, now, true, {}), null, "20s since last tick → healthy, no gap");
  assert.equal(scheduleGapSummary(db).count, 0);
});

test("recordScheduleGap: a 58-min sleep with a live match in play is recorded as a harmful gap", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const start = Date.parse("2026-07-22T17:07:00Z");
  const end = Date.parse("2026-07-22T18:05:00Z"); // ~58 min later — the "дыра 17:05–18:05"
  const gap = recordScheduleGap(db, start, end, true, {});
  assert.ok(gap, "the sleep window is detected");
  assert.equal(gap!.sec, 58 * 60);
  assert.equal(gap!.liveInPlay, true);
  const sum = scheduleGapSummary(db);
  assert.equal(sum.count, 1);
  assert.equal(sum.longestSec, 58 * 60);
  assert.ok(sum.last && sum.last.sec === 58 * 60);
  // recorded in the cron journal, flagged harmful (ok=0) because a match was live
  const cron = R.recentCronLog(db, 10).filter((r) => r.kind === "gap");
  assert.equal(cron.length, 1);
  assert.equal(cron[0].ok, 0, "live-in-play gap is flagged as a failure in the journal");
  assert.match(cron[0].summary, /планировщик спал ~58м/);
  assert.equal(sum.recent[0].harmful, true);
});

test("recordScheduleGap: a sleep with NO live match is recorded but not flagged harmful; longest tracks the max", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const t0 = Date.parse("2026-07-22T03:00:00Z");
  const g1 = recordScheduleGap(db, t0, t0 + 10 * 60_000, false, {}); // 10 min, nothing live
  assert.ok(g1 && g1.liveInPlay === false);
  const g2 = recordScheduleGap(db, t0 + 20 * 60_000, t0 + 95 * 60_000, true, {}); // 75 min, live
  assert.ok(g2);
  const sum = scheduleGapSummary(db);
  assert.equal(sum.count, 2);
  assert.equal(sum.longestSec, 75 * 60, "longest tracks the larger window");
  const cron = R.recentCronLog(db, 10).filter((r) => r.kind === "gap");
  const okByHarm = cron.map((c) => c.ok).sort();
  assert.deepEqual(okByHarm, [0, 1], "the no-live gap ok=1, the live gap ok=0");
});

test("F7 recordScheduleGap: a live blackout since kickoff with no prior marker is recorded via the in-play floor", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const kickoff = Date.parse("2026-07-22T15:00:00Z");
  const firstTick = Date.parse("2026-07-22T16:53:00Z"); // 113 min later — first live tick after the loop sat idle
  // no prior live-tick marker (prevMs=0), but a match has been in play since kickoff → measured from kickoff
  const gap = recordScheduleGap(db, 0, firstTick, true, {}, kickoff);
  assert.ok(gap, "the pre-first-tick blackout is now surfaced, not swallowed");
  assert.equal(gap!.sec, 113 * 60);
  assert.equal(gap!.liveInPlay, true);
  // no in-play floor and no prior marker → nothing to measure (unchanged old behaviour)
  assert.equal(recordScheduleGap(db, 0, firstTick, true, {}, 0), null);
  // a healthy loop (recent prevMs) is unaffected even when a kickoff floor is supplied — prevMs wins
  assert.equal(recordScheduleGap(db, firstTick - 20_000, firstTick, true, {}, kickoff), null);
});

test("PETRO#1 recordScheduleGap: a harmful (live-in-play) gap fires the external webhook when configured", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const start = Date.parse("2026-07-22T17:07:00Z");
  const end = Date.parse("2026-07-22T18:05:00Z");
  const calls: { url: string; body: string }[] = [];
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => { calls.push({ url, body: String(init?.body ?? "") }); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    recordScheduleGap(db, start, end, true, { SCHEDULE_GAP_WEBHOOK_URL: "https://hooks.example/abc" });
    assert.equal(calls.length, 1, "one webhook POST for a harmful gap");
    assert.equal(calls[0].url, "https://hooks.example/abc");
    assert.match(calls[0].body, /планировщик спал ~58м во время ЛАЙВА/);
    assert.match(calls[0].body, /"content"/); assert.match(calls[0].body, /"text"/); // Discord + Slack shapes
  } finally { (globalThis as any).fetch = orig; }
});

test("PETRO#1 recordScheduleGap: NO webhook when the URL is unset, or when the gap is benign (no live match)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const start = Date.parse("2026-07-22T17:07:00Z"), end = Date.parse("2026-07-22T18:05:00Z");
  const calls: any[] = [];
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async (...a: any[]) => { calls.push(a); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    recordScheduleGap(db, start, end, true, {}); // harmful but no URL
    recordScheduleGap(db, start, end, false, { SCHEDULE_GAP_WEBHOOK_URL: "https://hooks.example/abc" }); // benign (no live)
    assert.equal(calls.length, 0, "no alert without a URL, and none for a non-live gap");
  } finally { (globalThis as any).fetch = orig; }
});
