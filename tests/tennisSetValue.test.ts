import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { serializeEntryMeta, parseEntryMeta } from "../src/lib/betMeta.js";
import { isStaleProposal } from "../src/lib/thresholds.js";
import { setValueGate, isBestOfFive, SET_VALUE_ARMED } from "../src/lib/tennisSetValue.js";
import { tennisSetValueTick, tennisExitTick, tennisSetValueEntryMeta } from "../src/lib/tennisTrading.js";
import { runLiveCycle } from "../src/lib/lifecycle.js";
import { migrateTennisStrategy, migrateTennisSetValueStrategy } from "../src/lib/seed.js";

// ── Fixtures ──────────────────────────────────────────────────────────────
function seedSV(db: ReturnType<typeof openDb>, o: { p1: string; p2: string; startPrice?: number; book?: number }) {
  migrateTennisStrategy(db);
  migrateTennisSetValueStrategy(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-atp", home: o.p1, away: o.p2, state: "live", lineup_out: true, kickoff_at: "2026-07-14T09:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: `ATP: ${o.p1} vs ${o.p2}`, price: o.startPrice ?? 80, ai_prob: null, liquidity: String(o.book ?? 6000), external_ref: "t1", snapshot_at: "t", is_closing: false });
  return mid;
}
function svSnap(db: ReturnType<typeof openDb>, mid: string, o: { at: string; p1: string; p2: string; s1: number; s2: number; setNum: number; g1: number; g2: number; server: "first" | "second" | null; p1c: number | null; eventType?: string; tournament?: string; status?: string; live?: number }) {
  R.insertTennisSnapshot(db, { event_key: "EX", provider: "apitennis", batch_at: o.at, p1: o.p1, p2: o.p2, tournament: o.tournament ?? "Granby", event_type: o.eventType ?? "ATP Singles", live: o.live ?? 1, status: o.status ?? "live", sets_p1: o.s1, sets_p2: o.s2, set_num: o.setNum, games_p1: o.g1, games_p2: o.g2, game_points: null, server: o.server, pm_match_id: mid, pm_mid_cents: o.p1c, pm_p1_cents: o.p1c, pm_p2_cents: o.p1c == null ? null : 100 - o.p1c, raw: "{}" } as any);
}
const okLLM = (label: string) => (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label, prob: 0.5, reason: "конкурентный сет 6-4" }] }) }] }) })) as unknown as typeof fetch;
const abstainLLM = () => (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [] }) }] }) })) as unknown as typeof fetch;

// ── Pure gate + format ────────────────────────────────────────────────────
test("isBestOfFive: Grand Slam men's singles = bo5; WTA / non-slam = bo3", async () => {
  assert.equal(isBestOfFive("ATP Singles", "Wimbledon"), true);
  assert.equal(isBestOfFive("Grand Slam", "US Open"), true);
  assert.equal(isBestOfFive("WTA Singles", "Wimbledon"), false, "women play bo3 even at slams");
  assert.equal(isBestOfFive("ATP Singles", "Granby"), false, "not a slam");
});

test("setValueGate: armed only when favourite lost set 1 AND price is in the band", async () => {
  const base = { favSide: "first" as const, tradeable: true, favSetsWon: 0, favSetsLost: 1, setNum: 2, eventType: "ATP Singles", tournament: "Granby" };
  assert.equal(setValueGate({ ...base, favPriceCents: 38 }).armed, true);
  assert.equal(setValueGate({ ...base, favPriceCents: 22 }).skip, "market_knows", "<25¢ → market knows more, never enter");
  assert.equal(setValueGate({ ...base, favPriceCents: 50 }).skip, "no_panic", ">45¢ → comeback already priced");
  assert.equal(setValueGate({ ...base, favPriceCents: 28 }).skip, "below_band", "25-30¢ below the interim band");
  assert.equal(setValueGate({ ...base, favSetsLost: 0, favPriceCents: 38 }).skip, "not_lost_set1", "hasn't lost a set → not our setup");
  assert.equal(setValueGate({ ...base, favSetsWon: 1, favPriceCents: 38 }).skip, "not_lost_set1", "levelled → not 0-1");
  assert.equal(setValueGate({ ...base, favPriceCents: 38, tournament: "Roland Garros" }).skip, "bo5", "GS men's singles = bo5, filtered");
  assert.equal(setValueGate({ ...base, favSide: null, favPriceCents: 38 }).skip, "no_favourite");
  // edge = comebackProb − price
  assert.ok(Math.abs((setValueGate({ ...base, favPriceCents: 40 }).edge ?? 0) - (SET_VALUE_ARMED.comebackProb - 0.4)) < 1e-9);
});

// ── Entry + the DIVORCE (cross-strategy one-position rule) ──────────────────
test("tennisSetValueTick: favourite lost a competitive set 1, price in band → opens per free profile", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:00:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 0, setNum: 1, g1: 5, g2: 3, server: "first", p1c: 80 }); // start: favourite 80¢
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 }); // lost set 1, now 38¢
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: okLLM("Vitoria Zuccon") });
  assert.ok(opened >= 1, "opened at least one profile");
  const bets = R.betsForMatch(db, mid, "tennis_set_value").filter((b) => b.status === "open");
  assert.ok(bets.length >= 1 && bets.every((b) => b.market_label === "Vitoria Zuccon" && (b.stake ?? 0) > 0), "favourite name, sized");
  assert.ok(bets.every((b) => b.code_version?.includes("token-fix-m1")), "token-fix-m1 epoch (hard break: favourite's own token)");
});

// ── P0.3 / P0.4 / P0.5: entry-quality gates (clean the shadow cohort + block bad fills) ──
test("P0.4: a STALE scout snapshot fails closed → no arm, no shadow, no_score_data_skip", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:00:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 0, setNum: 1, g1: 5, g2: 3, server: "first", p1c: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 });
  // now is 30 min after the newest snapshot (> the 15-min stale window) → the score is unverified.
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:35:00Z", env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: okLLM("Vitoria Zuccon") });
  assert.equal(opened, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM sv_shadow_signals`).get() as any).c, 0, "stale → not even a shadow record");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /no_score_data_skip/.test(l.text ?? "")), "loud stale-data skip");
});

test("P0.3: the FROZEN favourite strength is the PRE-KICKOFF price, not the depressed first-live snapshot", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 66 });
  // a real PRE-KICKOFF snapshot (before the 09:00 kickoff) — favourite firm at 66¢
  svSnap(db, mid, { at: "2026-07-14T08:50:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 0, setNum: 0, g1: 0, g2: 0, server: "first", p1c: 66 });
  // first LIVE snapshots — already depressed to 62 mid-set-1, then 38 after losing it
  svSnap(db, mid, { at: "2026-07-14T10:00:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 0, setNum: 1, g1: 5, g2: 3, server: "first", p1c: 62 });
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 });
  await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: okLLM("Vitoria Zuccon") }); // flag-only default → shadow
  const shadow = db.prepare(`SELECT prematch_ml_cents, prematch_src FROM sv_shadow_signals WHERE match_id=?`).get(mid) as any;
  assert.ok(shadow, "recorded");
  assert.equal(shadow.prematch_ml_cents, 66, "frozen the 66¢ PRE-KICKOFF price, not the 62/38 live price");
  assert.equal(shadow.prematch_src, "prematch", "tagged as a true pre-kickoff source");
});

test("P0.5: a fill outside the band is blocked (band_violation_at_fill), money mode", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  lostSet1(db, mid, "Vitoria Zuccon", "Carolina Martins"); // arms at 38¢ (in band 30-45)
  // book ask at 48¢ → the fill lands at 48¢, ABOVE the 45¢ band ceiling.
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k", POLYMARKET_ENABLED: "true", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: bookAndLLM("Vitoria Zuccon", { bids: [{ price: "0.44", size: "1000" }], asks: [{ price: "0.48", size: "1000" }] }) });
  assert.equal(opened, 0, "fill above the band → blocked");
  assert.equal(R.betsForMatch(db, mid, "tennis_set_value").filter((b) => b.status === "open").length, 0);
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /band_violation_at_fill/.test(l.text ?? "")), "band violation logged");
});

test("T4 isStaleProposal: shared drift threshold (5¢ abs OR 25% rel), config-overridable", () => {
  assert.equal(isStaleProposal(40, 43, {}), false, "3¢ drift under both thresholds");
  assert.equal(isStaleProposal(40, 55, {}), true, "15¢ drift > max(5, 10)");
  assert.equal(isStaleProposal(10, 16, {}), true, "6¢ drift > max(5, 2.5) — abs binds at low prices");
  assert.equal(isStaleProposal(0, 44, {}), false, "no positive decision price → nothing to compare");
  assert.equal(isStaleProposal(40, 44, { STALE_PROPOSAL_ABS_CENTS: "2", STALE_PROPOSAL_REL_FRAC: "0.05" }), true, "tightened config catches a 4¢ drift");
});

test("T4 edge-recompute: a set_value bet records edge FROM THE FILL price, not the proposal", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  lostSet1(db, mid, "Vitoria Zuccon", "Carolina Martins"); // arms the DECISION at 38¢ → const edge 12%
  // book ask 0.44 → the fill lands IN-band at ~44¢ (drift 6¢ < the 9.5¢ threshold, so it opens) — but the
  // recorded edge must be comebackProb(0.5) − 0.44 ≈ 6%, NOT 0.5 − 0.38 = 12%.
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k", POLYMARKET_ENABLED: "true", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: bookAndLLM("Vitoria Zuccon", { bids: [{ price: "0.42", size: "1000" }], asks: [{ price: "0.44", size: "1000" }] }) });
  assert.ok(opened >= 1, "opens in-band");
  const b = R.betsForMatch(db, mid, "tennis_set_value").find((x) => x.status === "open")!;
  const edge = parseEntryMeta(b.entry_meta)?.edge ?? 0;
  assert.ok(edge <= 0.075 && edge >= 0.045, `edge recorded from the ~44¢ fill (~6%), not the 38¢ proposal (12%) — got ${edge}`);
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /от филла/.test(l.text ?? "")), "enter log states edge is from the fill");
  // T6: the bet froze its data provenance (feed + snapshot age at decision).
  const prov = parseEntryMeta(b.entry_meta)?.dataProvenance;
  assert.ok(prov && typeof prov.snapshotAgeSec === "number", "dataProvenance frozen on the bet");
  assert.equal(prov!.source, "apitennis", "provenance names the deciding feed");
});

// ── P0.2: boot-grace EXITS-ONLY protective pass ────────────────────────────
test("P0.2 runLiveCycle exitsOnly: a stopped position IS cut (protective stop lives during boot-grace)", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins" });
  seedOpenSV(db, mid, 38);
  // thesis_stop pattern (deterministic, game-based): favourite broken in set 2, no break-back over K=2 recv.
  const P = { p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2 } as const;
  svSnap(db, mid, { ...P, at: "2026-07-14T10:05:00Z", g1: 0, g2: 0, server: "first", p1c: 38 });
  svSnap(db, mid, { ...P, at: "2026-07-14T10:06:00Z", g1: 0, g2: 1, server: "second", p1c: 35 }); // broken
  svSnap(db, mid, { ...P, at: "2026-07-14T10:07:00Z", g1: 0, g2: 2, server: "first", p1c: 34 });  // recv #1
  svSnap(db, mid, { ...P, at: "2026-07-14T10:08:00Z", g1: 1, g2: 2, server: "second", p1c: 36 });
  svSnap(db, mid, { ...P, at: "2026-07-14T10:09:00Z", g1: 1, g2: 3, server: "first", p1c: 33 });  // recv #2, no break-back
  const r = await runLiveCycle(db, null, { now: () => "2026-07-14T10:09:05Z" }, { exitsOnly: true });
  assert.ok(r.exits >= 1, "protective exit fired in the exits-only pass");
  assert.notEqual(R.getBet(db, "sv1")!.status, "open", "position cut without waiting for the full cycle");
});

test("P0.2 runLiveCycle exitsOnly: ENTRIES stay silent (armed trigger → no bet AND no shadow)", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:00:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 0, setNum: 1, g1: 5, g2: 3, server: "first", p1c: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 });
  // Money on (flag-only off) AND an LLM that would confirm — yet exits-only must NOT run the entry tick.
  const r = await runLiveCycle(db, null, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: okLLM("Vitoria Zuccon") }, { exitsOnly: true });
  assert.equal(r.entries, 0, "no entries in exits-only");
  assert.equal(R.betsForMatch(db, mid, "tennis_set_value").length, 0, "the entry tick was skipped — no bet");
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM sv_shadow_signals`).get() as any).c, 0, "no shadow record either — the ENTRY path never ran");
});

test("tennisSetValueTick: FLAG-ONLY by default → NO bet, a shadow cohort row is frozen (P0.1)", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:00:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 0, setNum: 1, g1: 5, g2: 3, server: "first", p1c: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 });
  // No TENNIS_SV_FLAG_ONLY in env → flag-only ON (owner-ratified default).
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: okLLM("Vitoria Zuccon") });
  assert.equal(opened, 0, "flag-only: no money bet opened");
  assert.equal(R.betsForMatch(db, mid, "tennis_set_value").filter((b) => b.status === "open").length, 0, "zero open bets");
  const shadow = db.prepare(`SELECT trigger_cents, prematch_ml_cents, prematch_src, status FROM sv_shadow_signals WHERE match_id=?`).get(mid) as any;
  assert.ok(shadow, "a shadow cohort row was frozen");
  assert.equal(shadow.status, "pending");
  assert.equal(shadow.prematch_ml_cents, 80, "prematch favourite ML frozen from the pre-trigger snapshot");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /flag_only.*ставка НЕ размещена/.test(l.text ?? "")), "flag-only skip logged");
});

// Combined fetch: CLOB /book requests get an order book; everything else is the LLM strategist.
const bookAndLLM = (label: string, book: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] }) =>
  (async (url: any) => String(url).includes("/book")
    ? ({ ok: true, status: 200, json: async () => book } as any)
    : ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label, prob: 0.5, reason: "конкурентный сет 6-4" }] }) }] }) } as any)) as unknown as typeof fetch;
const lostSet1 = (db: ReturnType<typeof openDb>, mid: string, p1: string, p2: string) => {
  svSnap(db, mid, { at: "2026-07-14T10:00:00Z", p1, p2, s1: 0, s2: 0, setNum: 1, g1: 5, g2: 3, server: "first", p1c: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1, p2, s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 });
};

test("tennisSetValueTick (book-fill-m1): execution ON + EMPTY book → honest no_book_liquidity skip, never a 0¢ fill", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  lostSet1(db, mid, "Vitoria Zuccon", "Carolina Martins");
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k", POLYMARKET_ENABLED: "true", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: bookAndLLM("Vitoria Zuccon", { bids: [], asks: [] }) });
  assert.equal(opened, 0, "no book → no entry (the deliberate book-fill-m1 fix: no fabricated fill)");
  assert.equal(R.betsForMatch(db, mid, "tennis_set_value").filter((b) => b.status === "open").length, 0);
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /no_book_liquidity/.test(l.text ?? "")), "typed no_book_liquidity skip logged");
});

test("tennisSetValueTick (book-fill-m1): execution ON + real book → fills at the BOOK price, not the 38¢ quote", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  lostSet1(db, mid, "Vitoria Zuccon", "Carolina Martins");
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k", POLYMARKET_ENABLED: "true", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: bookAndLLM("Vitoria Zuccon", { bids: [{ price: "0.36", size: "1000" }], asks: [{ price: "0.40", size: "1000" }] }) });
  assert.ok(opened >= 1, "real book → fills");
  const b = R.betsForMatch(db, mid, "tennis_set_value").find((x) => x.status === "open")!;
  assert.ok((b.entry_price ?? 0) >= 40, `filled at the 40¢ ask (+fee), not the 38¢ quote — got ${b.entry_price}`);
  assert.ok(b.decision_id, "the fill carries a decision_id (twin link to a future real order)");
});

test("tennisSetValueTick: a blowout / retire-risk (strategist abstains) → no entry", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:00:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 0, setNum: 1, g1: 1, g2: 6, server: "first", p1c: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 });
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: abstainLLM() });
  assert.equal(opened, 0);
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /воздержался/.test(l.text)), "abstention logged");
});

test("DIVORCE: an OPEN Overreaction position on the match BLOCKS Set-Value (waits, no acted marker)", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:00:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 0, setNum: 1, g1: 5, g2: 3, server: "first", p1c: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 });
  // Overreaction holds an open buyback on EVERY default profile → all blocked.
  for (const profile of ["aggressive", "medium", "conservative"])
    R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: profile, market_label: "Vitoria Zuccon", status: "open", proposed_price: 45, entry_price: 45, current_price: 45, closing_price: null, ai_prob: 0.6, stake: 50, rationale: "выкуп", entered_minute: "сет 1", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e·interim", created_at: "2026-07-14T10:02:00Z" } as any);
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: okLLM("Vitoria Zuccon") });
  assert.equal(opened, 0, "cross-strategy block: one buyback per match across BOTH strategies");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /blocked_cross_strategy/.test(l.text)), "the block is logged");
  assert.equal(R.metaGet(db, "tennis_sv_acted:" + mid), null, "NOT marked acted — it waits for the block to clear");
});

test("DIVORCE: Overreaction CLOSED → Set-Value enters on the same match", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins", startPrice: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:00:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 0, setNum: 1, g1: 5, g2: 3, server: "first", p1c: 80 });
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 });
  // A CLOSED (K-stop) Overreaction bet leaves the profiles free.
  R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Vitoria Zuccon", status: "settled_won", proposed_price: 45, entry_price: 45, current_price: 55, closing_price: 55, ai_prob: 0.6, stake: 50, rationale: "стоп по геймам", entered_minute: "сет 1", result: "won", payout: 61, settled_by: "early", settled_at: "2026-07-14T10:04:00Z", entry_meta: null, code_version: "e·interim", created_at: "2026-07-14T10:02:00Z" } as any);
  const opened = await tennisSetValueTick(db, { now: () => "2026-07-14T10:05:05Z", env: { ANTHROPIC_API_KEY: "k", TENNIS_SV_FLAG_ONLY: "false" }, fetchImpl: okLLM("Vitoria Zuccon") });
  assert.ok(opened >= 1, "the closed Overreaction position no longer blocks Set-Value");
});

// ── Exit ladder (partial take · thesis_stop break-no-return · order) ────────
function seedOpenSV(db: ReturnType<typeof openDb>, mid: string, entryCents: number, profile = "medium") {
  const meta = tennisSetValueEntryMeta({ favPrice: entryCents, edge: 0.12, kelly: 0.2, stake: 100, thinnessUsd: 6000, setNum: 2 });
  R.insertBet(db, { id: "sv1", match_id: mid, strategy_id: "tennis_set_value", risk_profile_id: profile, market_label: "Vitoria Zuccon", status: "open", proposed_price: entryCents, entry_price: entryCents, current_price: entryCents, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "set-value", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta(meta), code_version: "e·interim", created_at: "2026-07-14T10:05:00Z" } as any);
}

test("Set-Value exit: partial 50% take on the comeback, remainder held to settle", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins" });
  seedOpenSV(db, mid, 38);
  svSnap(db, mid, { at: "2026-07-14T10:05:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 0, g2: 0, server: "first", p1c: 38 });
  svSnap(db, mid, { at: "2026-07-14T10:08:00Z", p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2, g1: 1, g2: 0, server: "second", p1c: 58 }); // recovered ≥55 (favourite held)
  const closed = await tennisExitTick(db, { now: () => "2026-07-14T10:08:05Z" });
  assert.equal(closed, 1);
  const open = R.getBet(db, "sv1")!;
  assert.equal(open.status, "open", "the remainder stays open to settle");
  assert.equal(open.stake, 50, "half the stake left running");
  const partial = R.betsForMatch(db, mid, "tennis_set_value").find((b) => b.settled_by === "partial");
  assert.ok(partial && partial.stake === 50, "a 50% slice was booked as a partial fixation");
});

test("Set-Value exit: thesis_stop on a set-2 break with NO break-back (K=2 receiving games)", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins" });
  seedOpenSV(db, mid, 38);
  const P = { p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2 } as const;
  svSnap(db, mid, { ...P, at: "2026-07-14T10:05:00Z", g1: 0, g2: 0, server: "first", p1c: 38 }); // entry ref
  svSnap(db, mid, { ...P, at: "2026-07-14T10:06:00Z", g1: 0, g2: 1, server: "second", p1c: 35 }); // favourite BROKEN in set 2
  svSnap(db, mid, { ...P, at: "2026-07-14T10:07:00Z", g1: 0, g2: 2, server: "first", p1c: 34 }); // opponent holds → recv #1
  svSnap(db, mid, { ...P, at: "2026-07-14T10:08:00Z", g1: 1, g2: 2, server: "second", p1c: 36 }); // favourite holds own serve
  svSnap(db, mid, { ...P, at: "2026-07-14T10:09:00Z", g1: 1, g2: 3, server: "first", p1c: 33 }); // opponent holds → recv #2, no break-back
  const closed = await tennisExitTick(db, { now: () => "2026-07-14T10:09:05Z" });
  assert.equal(closed, 1);
  assert.equal(R.getBet(db, "sv1")!.status !== "open", true, "position cut");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /thesis_stop/.test(l.text)), "thesis_stop logged");
});

test("Set-Value exit: a set-2 break that IS broken back does NOT thesis_stop (break with return)", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins" });
  seedOpenSV(db, mid, 38);
  const P = { p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2 } as const;
  svSnap(db, mid, { ...P, at: "2026-07-14T10:05:00Z", g1: 0, g2: 0, server: "first", p1c: 38 });
  svSnap(db, mid, { ...P, at: "2026-07-14T10:06:00Z", g1: 0, g2: 1, server: "second", p1c: 35 }); // favourite broken
  svSnap(db, mid, { ...P, at: "2026-07-14T10:07:00Z", g1: 1, g2: 1, server: "first", p1c: 44 }); // favourite BREAKS BACK
  const closed = await tennisExitTick(db, { now: () => "2026-07-14T10:07:05Z" });
  assert.equal(closed, 0, "break-back → thesis intact, position rides on");
  assert.equal(R.getBet(db, "sv1")!.status, "open");
});

test("Set-Value exit ORDER: thesis_stop outranks the take even when price ≥ take", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins" });
  seedOpenSV(db, mid, 38);
  const P = { p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2 } as const;
  svSnap(db, mid, { ...P, at: "2026-07-14T10:05:00Z", g1: 0, g2: 0, server: "first", p1c: 38 });
  svSnap(db, mid, { ...P, at: "2026-07-14T10:06:00Z", g1: 0, g2: 1, server: "second", p1c: 35 }); // break
  svSnap(db, mid, { ...P, at: "2026-07-14T10:07:00Z", g1: 0, g2: 2, server: "first", p1c: 34 }); // recv #1
  svSnap(db, mid, { ...P, at: "2026-07-14T10:08:00Z", g1: 1, g2: 2, server: "second", p1c: 50 }); // fav holds
  svSnap(db, mid, { ...P, at: "2026-07-14T10:09:00Z", g1: 1, g2: 3, server: "first", p1c: 60 }); // recv #2 + price ≥ take(55)
  await tennisExitTick(db, { now: () => "2026-07-14T10:09:05Z" });
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /thesis_stop/.test(l.text)), "defensive thesis_stop wins over the take");
  assert.ok(!R.betsForMatch(db, mid, "tennis_set_value").some((b) => b.settled_by === "partial"), "no partial fixation happened");
});

test("Set-Value MTM: an open position is marked to the live price each tick, not frozen at entry", async () => {
  const db = openDb(":memory:");
  const mid = seedSV(db, { p1: "Vitoria Zuccon", p2: "Carolina Martins" });
  seedOpenSV(db, mid, 38); // entry 38¢ → current_price seeded at 38
  const P = { p1: "Vitoria Zuccon", p2: "Carolina Martins", s1: 0, s2: 1, setNum: 2 } as const;
  svSnap(db, mid, { ...P, at: "2026-07-14T10:05:00Z", g1: 0, g2: 0, server: "first", p1c: 38 });
  svSnap(db, mid, { ...P, at: "2026-07-14T10:08:00Z", g1: 1, g2: 0, server: "second", p1c: 48 }); // recovered to 48¢ (< take 55, favourite HELD — no break, no exit)
  const closed = await tennisExitTick(db, { now: () => "2026-07-14T10:08:05Z" });
  assert.equal(closed, 0, "no exit fired at 48¢ (below take, no break)");
  const bet = R.getBet(db, "sv1")!;
  assert.equal(bet.status, "open", "position still open");
  assert.equal(bet.current_price, 48, "current_price marked to the live 48¢, not frozen at entry 38¢ (exec model off → raw mid)");
});
