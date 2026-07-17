import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { collectSnapshots } from "../src/lib/snapshots.js";

// Deterministic capture test: stub global fetch with canned Sportmonks responses
// and assert collectSnapshots stores a snapshot row with the extracted labels.
function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function seed() {
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "wc", sport_id: "football", name: "ЧМ", budget: 1500, external_league: "fifa.world", created_at: "2026-07-09T00:00:00Z" });
  R.insertMatch(db, { id: "m1", competition_id: "wc", home: "France", away: "Morocco", state: "live", lineup_out: true, kickoff_at: "2026-07-09T20:00:00Z", minute: 57, score_home: 1, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null, clock: null } as any);
  return db;
}

const SM_FIXTURE = {
  id: 999,
  participants: { data: [{ id: 1, name: "France", meta: { location: "home" } }, { id: 2, name: "Morocco", meta: { location: "away" } }] },
  periods: { data: [{ minutes: 57 }] },
  xgfixture: { data: [{ participant_id: 1, data: { value: 1.23 } }, { participant_id: 2, data: { value: 0.41 } }] },
  statistics: { data: [
    { type: { name: "Ball Possession %" }, participant_id: 1, data: { value: 60 } },
    { type: { name: "Shots On Target" }, participant_id: 1, data: { value: 4 } },
    { type: { name: "Corners" }, participant_id: 1, data: { value: 5 } },
    { type: { name: "Shots Total" }, participant_id: 1, data: { value: 11 } },
  ] },
  events: { data: [{ type_id: 14, addition: "Goal", participant_id: 1 }] },
  lineups: { data: [{ player_name: "Mbappé" }] },
  has_odds: true,
};

test("collectSnapshots: captures Sportmonks raw + extracted labels", async () => {
  const db = seed();
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("/fixtures/date/")) return jsonRes({ data: [SM_FIXTURE] });
    if (u.includes("/fixtures/999")) return jsonRes({ data: SM_FIXTURE });
    return jsonRes({ data: [] }, 404);
  }) as typeof fetch;
  try {
    const n = await collectSnapshots(db, { env: { SPORTMONKS_KEY: "x" }, now: () => "2026-07-09T20:57:00Z" });
    assert.equal(n, 1, "one snapshot row (sportmonks; polymarket disabled)");
    const meta = R.snapshotMetaForMatch(db, "m1");
    assert.equal(meta.length, 1);
    const s = meta[0];
    assert.equal(s.provider, "sportmonks");
    assert.equal(s.ok, 1);
    assert.equal(s.minute, 57);
    const e = JSON.parse(s.extracted!);
    assert.equal(e.xg.present, true);
    assert.equal(e.xg.home, 1.23);
    assert.equal(e.xg.away, 0.41);
    assert.equal(e.liveStats.possession, true);
    assert.equal(e.liveStats.shotsOnTarget, true);
    assert.equal(e.liveStats.corners, true);
    assert.equal(e.lineups.confirmed, true);
    assert.equal(e.events.count, 1);
    // full raw payload is preserved untrimmed
    const raw = R.snapshotRaw(db, s.id);
    assert.ok(raw && raw.raw && raw.raw.includes("xgfixture"));
    // resolution cached
    assert.equal(R.getProviderRef(db, "m1", "sportmonks")?.provider_ref, "999");
  } finally {
    globalThis.fetch = orig;
  }
});

test("polymarketSnapshot: the captured book is never crossed (bid ≤ ask), even on inverted /price sides", async () => {
  const db = seed();
  // A market with a CLOB token so the Polymarket leg captures a book.
  R.insertMarket(db, { id: "k1", match_id: "m1", label: "Under 3.5", price: 79, ai_prob: 0.8, liquidity: "500", external_ref: "tok-under", token_second: null, snapshot_at: "2026-07-09T20:00:00Z", is_closing: false, ask_cents: null, spread_cents: null } as any);
  const orig = globalThis.fetch;
  // Reproduce the prod inversion: /midpoint 79¢; side=sell → 0.79, side=buy → 0.21. The naive
  // `ask(buy) − bid(sell)` gave spread −58¢ (crossed). The fix must present bid=21, ask=79, spread≥0.
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("/midpoint")) return jsonRes({ mid: "0.79" });
    if (u.includes("/price") && u.includes("side=sell")) return jsonRes({ price: "0.79" });
    if (u.includes("/price") && u.includes("side=buy")) return jsonRes({ price: "0.21" });
    return jsonRes({ data: [] }, 404);
  }) as typeof fetch;
  try {
    const n = await collectSnapshots(db, { env: { POLYMARKET_ENABLED: "true" }, now: () => "2026-07-09T20:57:00Z" });
    assert.equal(n, 1, "one polymarket snapshot row");
    const meta = R.snapshotMetaForMatch(db, "m1").find((s) => s.provider === "polymarket");
    assert.ok(meta, "polymarket snapshot present");
    const pm = JSON.parse(meta!.extracted!);
    const row = pm.markets[0];
    assert.ok(row.bidCents <= row.askCents, `book must not be crossed: bid ${row.bidCents} ≤ ask ${row.askCents}`);
    assert.ok(row.spreadCents >= 0, `spread must be ≥ 0, got ${row.spreadCents}`);
    assert.equal(row.bidCents, 21, "bid = the lower side");
    assert.equal(row.askCents, 79, "ask = the higher side");
  } finally {
    globalThis.fetch = orig;
  }
});

test("collectSnapshots: no providers + polymarket off is a no-op", async () => {
  const db = seed();
  const n = await collectSnapshots(db, { env: {}, now: () => "2026-07-09T20:57:00Z" });
  assert.equal(n, 0);
});

test("pruneStaleMatches: a match with snapshots is kept, not FK-crashed", () => {
  const db = seed();
  // finished, no bets → normally a prune target
  R.insertMatch(db, { id: "old", competition_id: "wc", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-06-01T00:00:00Z", minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null, clock: null } as any);
  R.insertProviderSnapshot(db, { match_id: "old", batch_at: "2026-06-01T00:30:00Z", provider: "sportmonks", phase: "live", ok: true, http_status: 200, provider_ref: "1", minute: 45, latency_ms: 300, extracted: { xg: { present: true } }, raw: '{"x":1}' });
  R.setProviderRef(db, "old", "sportmonks", "1");
  // Must NOT throw (the FK regression) and must KEEP the snapshotted match.
  const removed = R.pruneStaleMatches(db, { staleBeforeMs: Date.parse("2030-01-01T00:00:00Z") });
  assert.ok(R.getMatch(db, "old"), "snapshotted match is retained for research");
  assert.equal(R.snapshotCount(db, "old"), 1, "its snapshots are preserved");
  assert.ok(removed >= 0);
});
