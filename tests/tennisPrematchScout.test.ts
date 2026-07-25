import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { collectTennisPrematchSnapshots } from "../src/lib/tennisScout.js";

const NOW = "2026-07-24T12:00:00Z";
const iso = (ms: number) => new Date(ms).toISOString();
const deps = { now: () => NOW, polymarket: { enabled: false } as any };

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Tennis");
  R.upsertCompetition(db, { id: "pm-wta", sport_id: "tennis", name: "WTA", budget: 0, external_league: null, created_at: "t" });
  const nowMs = Date.parse(NOW);
  const mk = (id: string, state: string, koMs: number) => {
    R.insertMatch(db, { id, competition_id: "pm-wta", home: "Iga Swiatek", away: "Coco Gauff", state, lineup_out: false, kickoff_at: iso(koMs), minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
    R.insertMarket(db, { id: R.uid(), match_id: id, label: "WTA Palermo: Iga Swiatek vs Coco Gauff", price: 65, ai_prob: null, liquidity: "4000", external_ref: "tok"+id, token_second: "tok2"+id, snapshot_at: "t", is_closing: false } as any);
  };
  mk("up", "upcoming", nowMs + 6 * 3600_000);   // upcoming, kickoff +6h → prematch snapshot
  mk("live", "live", nowMs - 3600_000);          // live → skip
  mk("past", "upcoming", nowMs - 3600_000);      // kickoff already passed → skip (live scout owns it)
  return { db, nowMs };
}

test("S10: a prematch moneyline anchor (sets 0-0, live=0) is frozen for an upcoming in-scope match; live/past-kickoff skipped; throttled", async () => {
  const { db } = seed();
  const n1 = await collectTennisPrematchSnapshots(db, deps);
  assert.equal(n1, 1, "only the upcoming match gets a prematch snapshot");

  const snaps = db.prepare(`SELECT pm_match_id, live, sets_p1, sets_p2, pm_p1_cents, provider, status FROM tennis_snapshots`).all() as any[];
  assert.equal(snaps.length, 1);
  const s = snaps[0];
  assert.equal(s.pm_match_id, "up");
  assert.equal(s.live, 0);
  assert.equal(s.sets_p1, 0); assert.equal(s.sets_p2, 0);   // a TRUE prematch anchor (frozenSrc='prematch' in svRetroCohort)
  assert.equal(s.pm_p1_cents, 65);                          // the stored moneyline (Swiatek = first outcome, 65¢)
  assert.equal(s.provider, "polymarket");

  // throttle: a second pass within the window writes nothing
  assert.equal(await collectTennisPrematchSnapshots(db, deps), 0);
});
