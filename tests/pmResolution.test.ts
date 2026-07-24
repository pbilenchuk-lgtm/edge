import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { settlePmResolutionBets, type ResolveTokensFn } from "../src/lib/pmResolution.js";

// A Polymarket-ONLY finished football fixture: state finished, NO score (score_home/away null → the ESPN/
// StatPal-uncovered signature), an open bet, and a market carrying both outcome tokens.
function seedPmOnly(db: any, opts: { betId: string; label?: string; token: string; token2?: string; kickoffAt?: string; stake?: number }) {
  const comp = R.listCompetitions(db).find((c: any) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: opts.kickoffAt ?? "2026-07-23T16:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: `pm:football:${mid}` } as any);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: opts.label ?? "B Under 2.5", price: 55, ai_prob: 0.6, liquidity: "2000", external_ref: opts.token, token_second: opts.token2 ?? null, snapshot_at: "t", is_closing: false } as any);
  R.insertBet(db, { id: opts.betId, match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: opts.label ?? "B Under 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 55, closing_price: null, ai_prob: 0.6, stake: opts.stake ?? 50, rationale: "ft", entered_minute: "предматч", result: null, payout: null, created_at: "2026-07-23T15:30:00Z" } as any);
  return mid;
}
const resolver = (m: Record<string, { priceCents: number | null; closed: boolean }>): ResolveTokensFn => async () => m;

test("condition-1: a PM-only fixture (no match_live, no score) SETTLES from resolution — closed=true, token won", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  seedPmOnly(db, { betId: "w1", token: "TOKW", token2: "TOKL" });
  assert.ok(!R.getMatchLive(db, R.getBet(db, "w1")!.match_id), "no match_live row exists (PM-only)");
  const r = await settlePmResolutionBets(db, { now: () => "2026-07-24T10:00:00Z", resolveTokens: resolver({ TOKW: { priceCents: 100, closed: true }, TOKL: { priceCents: 0, closed: true } }) });
  assert.equal(r.settled, 1); assert.equal(r.won, 1);
  const b = R.getBet(db, "w1")!;
  assert.equal(b.status, "settled_won");
  assert.equal(b.settled_by, "pm_resolution", "provenance stamped");
  assert.equal(b.payout, R.getBet(db, "w1")!.payout); // sanity
  assert.equal(r.zombieBackfill, 1, "the hidden open tail is counted");
});

test("condition-1: closed=true + token at ~0 with complement ~100 → settled_lost", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  seedPmOnly(db, { betId: "l1", token: "TL", token2: "TW" });
  const r = await settlePmResolutionBets(db, { now: () => "2026-07-24T10:00:00Z", resolveTokens: resolver({ TL: { priceCents: 0.5, closed: true }, TW: { priceCents: 99.5, closed: true } }) });
  assert.equal(r.lost, 1);
  assert.equal(R.getBet(db, "l1")!.status, "settled_lost");
});

test("rule 2: complement mismatch → resolution_orientation_suspect, NOT settled", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  seedPmOnly(db, { betId: "s1", token: "TA", token2: "TB" });
  // token reads won (~100) but its complement is NOT ~0 (40) → the pair doesn't sum to ~100 → suspect
  const r = await settlePmResolutionBets(db, { now: () => "2026-07-24T10:00:00Z", resolveTokens: resolver({ TA: { priceCents: 100, closed: true }, TB: { priceCents: 40, closed: true } }) });
  assert.equal(r.suspect, 1); assert.equal(r.settled, 0);
  assert.equal(R.getBet(db, "s1")!.status, "open", "stays open for manual review");
});

test("rule 3: closed=true with a non-resolving price → market VOID (settled_by 'void')", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  seedPmOnly(db, { betId: "v1", token: "TV" });
  const r = await settlePmResolutionBets(db, { now: () => "2026-07-24T10:00:00Z", resolveTokens: resolver({ TV: { priceCents: 50, closed: true } }) });
  assert.equal(r.marketVoid, 1);
  const b = R.getBet(db, "v1")!;
  assert.equal(b.status, "settled_void"); assert.equal(b.settled_by, "void");
  assert.equal(b.payout, b.stake, "stake refunded, P&L 0");
});

test("rule 1 fallback: no closed flag → a resolving price must be STABLE across two polls ≥30 min apart", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  seedPmOnly(db, { betId: "f1", token: "TF" });
  const res100 = resolver({ TF: { priceCents: 100, closed: false } });
  // first poll: resolving price but not closed → pending, stability clock starts
  let r = await settlePmResolutionBets(db, { now: () => "2026-07-24T10:00:00Z", resolveTokens: res100 });
  assert.equal(r.pendingStable, 1); assert.equal(r.settled, 0);
  assert.equal(R.getBet(db, "f1")!.status, "open");
  // second poll only 10 min later → still pending (not yet stable)
  r = await settlePmResolutionBets(db, { now: () => "2026-07-24T10:10:00Z", resolveTokens: res100 });
  assert.equal(r.settled, 0);
  // 31 min after the first observation, same side → CONFIRMED, settles
  r = await settlePmResolutionBets(db, { now: () => "2026-07-24T10:31:00Z", resolveTokens: res100 });
  assert.equal(r.won, 1);
  assert.equal(R.getBet(db, "f1")!.status, "settled_won");
});

test("rule 3: unresolved past the timeout (finished ≥72h, no closed flag, non-resolving price) → void_timeout", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  // kickoff 4 days before 'now' → finished well past the 72h window
  seedPmOnly(db, { betId: "to1", token: "TT", kickoffAt: "2026-07-20T16:00:00Z" });
  const r = await settlePmResolutionBets(db, { now: () => "2026-07-24T20:00:00Z", resolveTokens: resolver({ TT: { priceCents: 62, closed: false } }) });
  assert.equal(r.voidTimeout, 1);
  const b = R.getBet(db, "to1")!;
  assert.equal(b.status, "settled_void"); assert.equal(b.settled_by, "void_timeout", "DISTINCT from a market void");
});

test("still pending: no closed flag, non-resolving price, inside the timeout → left open", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  seedPmOnly(db, { betId: "p1", token: "TP", kickoffAt: "2026-07-24T08:00:00Z" });
  const r = await settlePmResolutionBets(db, { now: () => "2026-07-24T11:00:00Z", resolveTokens: resolver({ TP: { priceCents: 62, closed: false } }) });
  assert.equal(r.pendingUnresolved, 1); assert.equal(r.settled, 0);
  assert.equal(R.getBet(db, "p1")!.status, "open");
});

test("a finished fixture WITH our score is NOT touched (the normal settleMatch path owns it)", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const comp = R.listCompetitions(db).find((c: any) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-07-23T16:00:00Z", minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 30, ai_prob: 0.4, liquidity: "2000", external_ref: "TOKZ", token_second: null, snapshot_at: "t", is_closing: false } as any);
  R.insertBet(db, { id: "sc1", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 30, entry_price: 30, current_price: 30, closing_price: null, ai_prob: 0.4, stake: 50, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: "t" } as any);
  const r = await settlePmResolutionBets(db, { now: () => "2026-07-24T10:00:00Z", resolveTokens: resolver({ TOKZ: { priceCents: 0, closed: true } }) });
  assert.equal(r.candidates, 0, "a scored fixture is not a PM-only candidate");
  assert.equal(R.getBet(db, "sc1")!.status, "open", "left for settleMatch");
});

import { fetchTokenResolution, loadPolymarketConfig } from "../src/lib/polymarket.js";

test("fetchTokenResolution: parses Gamma closed flag + resolved outcomePrices per token; failure → absent", async () => {
  const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true" });
  const rows = [{ clobTokenIds: JSON.stringify(["TA", "TB"]), outcomePrices: JSON.stringify(["1", "0"]), closed: true }];
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => rows })) as any;
  const r = await fetchTokenResolution(poly, ["TA", "TB"], { fetchImpl });
  assert.deepEqual(r.TA, { priceCents: 100, closed: true }, "outcome[0] token → its resolved price");
  assert.deepEqual(r.TB, { priceCents: 0, closed: true }, "outcome[1] token → the complement price");
  const r2 = await fetchTokenResolution(poly, ["TZ"], { fetchImpl: (async () => ({ ok: false, status: 500, json: async () => [] })) as any });
  assert.equal(r2.TZ, undefined, "a failed fetch leaves the token absent (unresolved)");
});
