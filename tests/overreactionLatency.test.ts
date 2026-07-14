import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { settleMatch } from "../src/lib/engine.js";
import { serializeEntryMeta } from "../src/lib/betMeta.js";
import {
  polymarketSeries, findTriggerEvent, baseEpochNum, computeWindowMetrics,
  recordComebackLatency, buildOverreactionLatencyReport, latencyReportMarkdown, latencyCasesCsv,
} from "../src/lib/overreactionLatency.js";

const T0 = Date.parse("2026-07-13T18:00:00.000Z");
const iso = (msFromT0: number) => new Date(T0 + msFromT0).toISOString();
const snap = (label: string, bid: number | null, mid: number | null) => ({ markets: [{ label, token: "tok", bidCents: bid, midCents: mid, askCents: bid == null ? null : bid + 2 }] });

// Dense ~20s bid series: pre 70 → 45¢ FLOOR at +40s (plus a phantom 3¢) → recovery.
const SERIES: [number, number | null, number | null][] = [
  [-40_000, 70, 71], [-20_000, 70, 71], [0, 65, 66], [20_000, 55, 56], [40_000, 45, 46],
  [50_000, 3, 46], [60_000, 48, 49], [80_000, 49, 50], [100_000, 50, 51], [120_000, 52, 53],
  [140_000, 54, 55], [160_000, 55, 56], [180_000, 56, 57], [200_000, 56, 57], [220_000, 57, 58],
  [240_000, 58, 59], [260_000, 58, 59], [280_000, 59, 60], [300_000, 59, 60], [320_000, 60, 61], [340_000, 60, 61],
];

function seedMatch(db: ReturnType<typeof openDb>, opts: { withEntry?: boolean; withArmed?: boolean; entryCents?: number; entryAtSec?: number; thinnessUsd?: number; stake?: number } = {}) {
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "Overreaction", tag: "o", color: "#000", version: 1, prompt: "p", prompt_live: "pl", params: {}, model: "m", model_live: "m", created_at: iso(0) } as any);
  const mid = "m-ovr";
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Fav", away: "Dog", state: "finished", lineup_out: true, kickoff_at: iso(-30 * 60_000), minute: 90, score_home: 0, score_away: 1, final_score: "0:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Fav Win", price: 52, ai_prob: 0.6, liquidity: "3000", external_ref: "tok", snapshot_at: iso(0), is_closing: false });
  R.insertMatchEvent(db, { id: R.uid(), match_id: mid, event_key: "g1", minute: 20, type: "goal", team: "Dog", text: "Гол Dog 0:1", created_at: iso(0) });
  for (const [dt, bid, m2] of SERIES)
    R.insertProviderSnapshot(db, { match_id: mid, batch_at: iso(dt), provider: "polymarket", phase: "live", ok: true, http_status: null, provider_ref: null, minute: 20, latency_ms: null, extracted: snap("Fav Win", bid, m2), raw: null });
  if (opts.withArmed)
    R.saveArtifact(db, { match_id: mid, kind: "battle_sheet", label: "Overreaction · medium", stage: "prematch", content: JSON.stringify({ live_triggers_armed: [{ scenario_trigger: "гол Dog", buyback_target: 60, time_window: "до 30'" }] }), model: "m", created_at: iso(0) });
  if (opts.withEntry)
    R.insertBet(db, {
      id: "b-ovr", match_id: mid, strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Fav Win",
      status: "open", proposed_price: opts.entryCents ?? 52, entry_price: opts.entryCents ?? 52, current_price: opts.entryCents ?? 52, closing_price: null,
      ai_prob: 0.6, stake: opts.stake ?? 100, rationale: "переоценка (лайв)", entered_minute: "20'", result: null, payout: null,
      settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", marketThinnessUsd: opts.thinnessUsd ?? 3000 }),
      code_version: "e5·m1", created_at: iso((opts.entryAtSec ?? 90) * 1000),
    } as any);
  return R.getMatch(db, mid)!;
}

test("baseEpochNum + polymarketSeries + findTriggerEvent (pure helpers)", () => {
  assert.equal(baseEpochNum("e5·m1·opus48"), 5);
  assert.equal(baseEpochNum("weird"), null);
  const rows = [
    { provider: "sportmonks", batch_at: iso(0), extracted: JSON.stringify({ xg: {} }) },
    { provider: "polymarket", batch_at: iso(20_000), extracted: JSON.stringify(snap("Fav Win", 55, 56)) },
    { provider: "polymarket", batch_at: iso(0), extracted: JSON.stringify(snap("Fav Win", 65, 66)) },
  ];
  const s = polymarketSeries(rows, "Fav Win");
  assert.deepEqual(s.map((q) => q.bid), [65, 55]);
  const evs = [{ id: "1", match_id: "m", event_key: "a", minute: 10, type: "goal", team: null, text: "гол", created_at: iso(0) }];
  assert.equal(findTriggerEvent(evs as any, T0 + 120_000)?.event_key, "a");
});

test("computeWindowMetrics: floor/panic/recovery/missed (phantom bid ignored)", () => {
  const series = SERIES.map(([dt, bid, m2]) => ({ tMs: T0 + dt, bid, mid: m2, ask: bid == null ? null : bid + 2 }));
  const m = computeWindowMetrics(series, T0, { priceCents: 52, atMs: T0 + 90_000, thinnessUsd: 3000, stake: 100 }, "e5·m1");
  assert.equal(m.priceFloorCents, 45, "phantom 3¢ ignored → real floor 45");
  assert.equal(m.tFloorSec, 40);
  assert.equal(m.missedCents, 7);
  assert.equal(m.lagFloorToEntrySec, 50);
  assert.equal(m.panicAmplitudeCents, 25);
  assert.equal(m.recovery["1"], 5);
  assert.equal(m.recovery["2"], 10);
  assert.equal(m.paperFloor, false);
});

test("(a) settle WITH a comeback entry creates a persisted metric record", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const match = seedMatch(db, { withEntry: true, withArmed: true });
  const res = settleMatch(db, match, { now: () => iso(6 * 60 * 60_000) });
  assert.ok(res.settled >= 0, "settle returned");
  const rows = R.listComebackLatencyMetrics(db);
  const entry = rows.find((r) => r.case_type === "entry");
  assert.ok(entry, "an entry latency row was persisted at settle");
  assert.equal(entry!.price_floor_cents, 45);
  assert.equal(entry!.missed_cents, 7);
});

test("(b) settle WITHOUT any Overreaction involvement creates NO metric record", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // finished match, a goal, snapshots — but NO overreaction bet and NO armed battle sheet
  const match = seedMatch(db, { withEntry: false, withArmed: false });
  settleMatch(db, match, { now: () => iso(6 * 60 * 60_000) });
  assert.equal(R.listComebackLatencyMetrics(db).length, 0, "overreaction not involved → nothing recorded");
});

test("(c) a compute failure does NOT break settle", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const match = seedMatch(db, { withEntry: true, withArmed: true });
  // Force the persistence to throw mid-compute (table gone) — settle must still complete.
  db.exec("DROP TABLE comeback_latency_metrics");
  const res = settleMatch(db, match, { now: () => iso(6 * 60 * 60_000) });
  assert.ok(res && typeof res.settled === "number", "settle completed despite the compute error");
  const b = R.getBet(db, "b-ovr");
  assert.ok(b && b.status !== "open", "the bet was still settled by the money-path");
});

test("(d) rolling report aggregates ONLY confident cases", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const base = (o: Partial<R.ComebackLatencyRow>): R.ComebackLatencyRow => ({
    id: R.uid(), match_id: "mX", competition_id: "c", case_type: "entry", market_label: "Fav Win", token: null,
    event_type: "goal", event_text: "g", t_event: iso(0), event_minute: 20,
    panic_amplitude_cents: 25, price_floor_cents: 45, t_floor_sec: 40, entry_price_cents: 52, t_entry_sec: 90,
    missed_cents: 7, lag_floor_to_entry_sec: 50, recovery_1: 5, recovery_2: 10, recovery_3: 12, recovery_5: 15,
    floor_thinness_usd: 3000, paper_floor: 0, price_trigger_cents: null, floor_below_trigger_cents: null,
    window_quotes: 20, confidence_flags: null, code_version: "e5·m1", created_at: iso(0), ...o,
  });
  R.insertComebackLatencyMetric(db, base({ missed_cents: 7, confidence_flags: null }));                 // confident
  R.insertComebackLatencyMetric(db, base({ missed_cents: 3, confidence_flags: "snapshot_gap,low_confidence" })); // NOT confident
  const rep = buildOverreactionLatencyReport(db);
  assert.equal(rep.aggregates.n, 2, "two entry rows total");
  assert.equal(rep.aggregates.nConfident, 1, "only one is confident");
  assert.equal(rep.aggregates.medianMissed, 7, "low-confidence 3¢ excluded from the median");
  assert.match(rep.decision.verdict, /отложено|копим/i, "still accumulating (<10) → decision deferred");
  assert.match(rep.status, /ждём/);
  assert.match(latencyReportMarkdown(rep), /missed/i);
  assert.match(latencyCasesCsv(rep), /case_type/);
});

test("(e) a trigger_no_entry with floor below the armed target lands in invisible setups", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.insertComebackLatencyMetric(db, {
    id: R.uid(), match_id: "mX", competition_id: "c", case_type: "trigger_no_entry", market_label: "Fav Win", token: null,
    event_type: "goal", event_text: "g", t_event: iso(0), event_minute: 20,
    panic_amplitude_cents: 25, price_floor_cents: 48, t_floor_sec: 40, entry_price_cents: null, t_entry_sec: null,
    missed_cents: null, lag_floor_to_entry_sec: null, recovery_1: null, recovery_2: null, recovery_3: null, recovery_5: null,
    floor_thinness_usd: null, paper_floor: null, price_trigger_cents: 60, floor_below_trigger_cents: 12,
    window_quotes: 20, confidence_flags: null, code_version: "e5·m1", created_at: iso(0),
  });
  const rep = buildOverreactionLatencyReport(db);
  assert.equal(rep.invisibleSetups.length, 1, "the sub-target dip is an invisible setup");
  assert.equal(rep.invisibleSetups[0].floorBelowTriggerCents, 12);
  assert.equal(rep.aggregates.nConfident, 0, "no entry cases → no confident aggregates (null, not artifacts)");
  assert.equal(rep.aggregates.medianMissed, null);
});

test("recordComebackLatency is idempotent (marker) — a second settle does not duplicate", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const match = seedMatch(db, { withEntry: true, withArmed: true });
  recordComebackLatency(db, match, { now: () => iso(6 * 60 * 60_000) });
  const n1 = R.listComebackLatencyMetrics(db).length;
  recordComebackLatency(db, match, { now: () => iso(7 * 60 * 60_000) });
  assert.equal(R.listComebackLatencyMetrics(db).length, n1, "second run is a no-op");
});
