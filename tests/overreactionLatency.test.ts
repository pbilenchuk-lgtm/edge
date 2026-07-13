import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { serializeEntryMeta } from "../src/lib/betMeta.js";
import {
  polymarketSeries, findTriggerEvent, baseEpochNum,
  buildOverreactionLatencyReport, latencyReportMarkdown, latencyCasesCsv,
  MISSED_BUILD_CENTS,
} from "../src/lib/overreactionLatency.js";

const T0 = Date.parse("2026-07-13T18:00:00.000Z");
const iso = (msFromT0: number) => new Date(T0 + msFromT0).toISOString();
const snap = (label: string, bid: number | null, mid: number | null) => ({ markets: [{ label, token: "tok", bidCents: bid, midCents: mid, askCents: bid == null ? null : bid + 2 }] });

function seedCase(db: ReturnType<typeof openDb>, opts: { entryCents: number; entryAtSec: number; codeVersion?: string; thinnessUsd?: number; stake?: number }) {
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "Overreaction", tag: "o", color: "#000", version: 1, prompt: "p", prompt_live: "pl", params: {}, model: "m", model_live: "m", created_at: iso(0) } as any);
  const mid = "m-ovr";
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Fav", away: "Dog", state: "finished", lineup_out: true, kickoff_at: iso(-30 * 60_000), minute: 90, score_home: 0, score_away: 1, final_score: "0:1", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Fav Win", price: 52, ai_prob: 0.6, liquidity: "3000", external_ref: "tok", snapshot_at: iso(0), is_closing: false });
  // Trigger: the underdog scored (panic) at T_event = +0.
  R.insertMatchEvent(db, { id: R.uid(), match_id: mid, event_key: "g1", minute: 20, type: "goal", team: "Dog", text: "Гол Dog 0:1", created_at: iso(0) });
  // Polymarket bid series around the event at a dense ~20s cadence (no confidence-killing
  // gaps): pre 70 → dip to a 45¢ FLOOR at +40s → recovers. Plus one PHANTOM low bid.
  const series: [number, number | null, number | null][] = [
    [-40_000, 70, 71], [-20_000, 70, 71], [0, 65, 66], [20_000, 55, 56],
    [40_000, 45, 46],            // ← real floor
    [50_000, 3, 46],             // ← PHANTOM low bid (≤5¢, ≥8¢ under mid) — must be ignored
    [60_000, 48, 49], [80_000, 49, 50], [100_000, 50, 51], // recovery@1m (floor+60s=+100s) → 50 → +5
    [120_000, 52, 53], [140_000, 54, 55], [160_000, 55, 56], // recovery@2m (+160s) → 55 → +10
    [180_000, 56, 57], [200_000, 56, 57], [220_000, 57, 58], // recovery@3m (+220s) → 57 → +12
    [240_000, 58, 59], [260_000, 58, 59], [280_000, 59, 60],
    [300_000, 59, 60], [320_000, 60, 61], [340_000, 60, 61], // recovery@5m (+340s) → 60 → +15
  ];
  for (const [dt, bid, mid2] of series)
    R.insertProviderSnapshot(db, { match_id: mid, batch_at: iso(dt), provider: "polymarket", phase: "live", ok: true, http_status: null, provider_ref: null, minute: 20, latency_ms: null, extracted: snap("Fav Win", bid, mid2), raw: null });
  R.insertBet(db, {
    id: "b-ovr", match_id: mid, strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Fav Win",
    status: "open", proposed_price: opts.entryCents, entry_price: opts.entryCents, current_price: opts.entryCents, closing_price: null,
    ai_prob: 0.6, stake: opts.stake ?? 100, rationale: "переоценка (лайв)", entered_minute: "20'", result: null, payout: null,
    settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", marketThinnessUsd: opts.thinnessUsd ?? 3000 }),
    code_version: opts.codeVersion ?? "e5·m1", created_at: iso(opts.entryAtSec * 1000),
  } as any);
  return mid;
}

test("baseEpochNum: parses the leading epoch, tolerates tags/garbage", () => {
  assert.equal(baseEpochNum("e5·m1·opus48"), 5);
  assert.equal(baseEpochNum("e1"), 1);
  assert.equal(baseEpochNum(null), null);
  assert.equal(baseEpochNum("weird"), null);
});

test("polymarketSeries: parses + sorts a market's bid series, only polymarket rows", () => {
  const rows = [
    { provider: "sportmonks", batch_at: iso(0), extracted: JSON.stringify({ xg: {} }) },
    { provider: "polymarket", batch_at: iso(20_000), extracted: JSON.stringify(snap("Fav Win", 55, 56)) },
    { provider: "polymarket", batch_at: iso(0), extracted: JSON.stringify(snap("Fav Win", 65, 66)) },
    { provider: "polymarket", batch_at: iso(0), extracted: JSON.stringify(snap("Other", 10, 11)) },
  ];
  const s = polymarketSeries(rows, "Fav Win");
  assert.equal(s.length, 2, "two Fav-Win polymarket quotes");
  assert.equal(s[0].bid, 65); assert.equal(s[1].bid, 55); // ascending by time
});

test("findTriggerEvent: latest goal/red at/just-before entry", () => {
  const evs = [
    { id: "1", match_id: "m", event_key: "a", minute: 10, type: "goal", team: null, text: "гол", created_at: iso(0) },
    { id: "2", match_id: "m", event_key: "b", minute: 70, type: "goal", team: null, text: "гол2", created_at: iso(600_000) },
    { id: "3", match_id: "m", event_key: "c", minute: 15, type: "stats", team: null, text: "x", created_at: iso(30_000) },
  ];
  assert.equal(findTriggerEvent(evs as any, T0 + 120_000)?.event_key, "a", "picks the goal before entry, not the later one");
  assert.equal(findTriggerEvent(evs as any, T0 - 600_000), null, "no goal before this entry");
});

test("buildOverreactionLatencyReport: measures the missed floor, recovery curve, and decides", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // Entry at +90s, price 52; real floor is 45 → missed 7¢ (≥ build threshold).
  seedCase(db, { entryCents: 52, entryAtSec: 90 });
  const rep = buildOverreactionLatencyReport(db);
  assert.equal(rep.generatedForBets, 1);
  const c = rep.cases[0];
  assert.equal(c.priceFloorCents, 45, "phantom 3¢ bid ignored → real floor 45¢");
  assert.equal(c.tFloorSec, 40, "floor at +40s");
  assert.equal(c.entryPriceCents, 52);
  assert.equal(c.tEntrySec, 90, "fill at +90s");
  assert.equal(c.missedCents, 7, "52 − 45 = 7¢ left on the table");
  assert.equal(c.lagFloorToEntrySec, 50, "entered 50s after the floor");
  assert.equal(c.panicAmplitudeCents, 25, "70 (pre-event) − 45 (floor)");
  assert.equal(c.recovery["1"], 5, "+1m from floor: 50 − 45");
  assert.equal(c.recovery["2"], 10, "+2m from floor: 55 − 45");
  assert.equal(rep.aggregates.medianMissed, 7);
  assert.ok(rep.decision.medianForDecision! >= MISSED_BUILD_CENTS);
  assert.match(rep.decision.verdict, /carve-out/i);
  // renderers don't throw and carry the headline
  assert.match(latencyReportMarkdown(rep), /missed/i);
  assert.match(latencyCasesCsv(rep), /price_floor_cents/);
});

test("buildOverreactionLatencyReport: entry AT the floor → 0¢ missed → closes the question", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  seedCase(db, { entryCents: 45, entryAtSec: 40 }); // filled exactly at the floor
  const rep = buildOverreactionLatencyReport(db);
  assert.equal(rep.cases[0].missedCents, 0);
  assert.match(rep.decision.verdict, /не стоит|закрыт/i);
});

test("buildOverreactionLatencyReport: a paper floor (thinness < half stake) is flagged, excluded from hard-floor median", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  seedCase(db, { entryCents: 52, entryAtSec: 90, thinnessUsd: 20, stake: 100 }); // 20 < 50 → paper
  const rep = buildOverreactionLatencyReport(db);
  assert.equal(rep.cases[0].paperFloor, true);
  assert.equal(rep.aggregates.nHardFloor, 0, "paper floor excluded from the hard-floor subset");
  assert.equal(rep.aggregates.medianMissed, 7, "still present in the all-cases median");
});
