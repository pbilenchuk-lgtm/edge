import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { autoEnter, evaluateExits, ftBlindConfig, isFtSettledMarket } from "../src/lib/lifecycle.js";
import { isFtBlindBet } from "../src/lib/betMeta.js";

// A Polymarket-ONLY football fixture: clock-flipped to "live" but NO match_live row and no provider minute
// (the ESPN/StatPal-uncovered signature). A PRE-MATCH (origin=prematch) FT-settled thesis on it is the
// FT-blind candidate. `phase` drives the decision origin resolved at insert; the seeded strategies here are
// edge/flat/kelly (the demo seed), so FT-mode is gated on ORIGIN, not a strategy name.
function seedPmOnly(db: any, opts: { betId: string; label?: string; stake?: number; phase?: "prematch" | "live"; enteredMinute?: string }) {
  const comp = R.listCompetitions(db).find((c: any) => c.sport_id === "football")!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "2026-07-06T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: opts.label ?? "Under 2.5", price: 55, ai_prob: 0.6, liquidity: null, external_ref: "tok", token_second: null, snapshot_at: "t", is_closing: false } as any);
  R.insertBet(db, { id: opts.betId, match_id: mid, strategy_id: "edge", risk_profile_id: "medium", market_label: opts.label ?? "Under 2.5", status: "proposed", proposed_price: 55, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake: opts.stake ?? 80, rationale: null, entered_minute: opts.enteredMinute ?? null, result: null, payout: null, settled_by: null, entry_meta: JSON.stringify({ phase: opts.phase ?? "prematch" }), created_at: "t" } as any);
  return mid;
}

// [batch-12, п.5] Грейс слепого входа отсчитывается от ФИЛЛА, поэтому «сейчас» в этих тестах обязано быть
// настоящими часами внутри окна: раньше здесь стояло now:"t", и гейт филла его бы не распарсил.
const AT_KO2 = "2026-07-06T18:02:00Z";   // 2' после старта — внутри грейса (по умолчанию 5')

test("ftBlindConfig / isFtSettledMarket: defaults + the FT-settled cut", () => {
  assert.equal(ftBlindConfig({}).enabled, false, "OFF by default");
  assert.equal(ftBlindConfig({ FT_BLIND_ENABLED: "true" }).enabled, true);
  assert.equal(ftBlindConfig({}).capFrac, 0.5, "half size by default");
  for (const l of ["Under 2.5", "Over 3.5", "Both Teams to Score — Yes", "Draw — No", "Santos FC (-1.5)"]) assert.equal(isFtSettledMarket(l), true, l);
  for (const l of ["Team to Advance — Yes", "Match to go to Extra Time", "Will there be Penalties?"]) assert.equal(isFtSettledMarket(l), false, l);
});

test("FT-mode: a pre-match FT-settled bet on a PM-only fixture holds when OFF, fills blind (50%, tagged) when ON", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  seedPmOnly(db, { betId: "ft-1", stake: 80 });

  await autoEnter(db, { now: () => AT_KO2, env: {} });
  assert.equal(R.getBet(db, "ft-1")!.status, "proposed", "FT-mode OFF → held as preview, no blind entry (unchanged behaviour)");

  await autoEnter(db, { now: () => AT_KO2, env: { FT_BLIND_ENABLED: "true" } });
  const b = R.getBet(db, "ft-1")!;
  assert.equal(b.status, "open", "FT-mode ON → the coverage-casualty entry fills blind");
  assert.equal(b.stake, 40, "condition 5: 50% cap, 80 → 40");
  assert.ok(isFtBlindBet(b), "condition 2: tagged ft_blind (exits skip it, verdict cohort separate)");
});

test("FT-mode: a NON-final-score market (advancement) is NOT entered blind even when ON", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  seedPmOnly(db, { betId: "adv-1", label: "Team to Advance — Yes" });
  await autoEnter(db, { now: () => AT_KO2, env: { FT_BLIND_ENABLED: "true" } });
  assert.equal(R.getBet(db, "adv-1")!.status, "proposed", "advancement isn't hold-to-settle from the 90' score → not entered blind");
});

test("FT-mode: a LIVE-origin decision is NOT entered blind even when ON (pre-match theses only)", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  seedPmOnly(db, { betId: "live-1", phase: "live", enteredMinute: "30'" });
  await autoEnter(db, { now: () => AT_KO2, env: { FT_BLIND_ENABLED: "true" } });
  assert.equal(R.getBet(db, "live-1")!.status, "proposed", "a live-entry decision is not a hold-to-settle pre-match thesis");
});

test("FT-mode: a COVERED fixture (match_live row present) is not treated as blind — normal gate applies", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const mid = seedPmOnly(db, { betId: "cov-1" });
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  await autoEnter(db, { now: () => AT_KO2, env: { FT_BLIND_ENABLED: "true" } });
  assert.equal(R.getBet(db, "cov-1")!.status, "proposed", "a covered fixture is held by the normal gate, never blind-filled");
});

test("FT-mode: an open ft_blind position is SKIPPED by the deterministic exit machinery (hold-to-settle)", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const comp = R.listCompetitions(db).find((c: any) => c.sport_id === "football")!;
  const mid = R.uid();
  // a DELIVERING live match (minute + a real event) so evaluateExits runs — the skip must come from the tag
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "2026-07-06T18:00:00Z", minute: 80, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.upsertMatchLive(db, { match_id: mid, espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" });
  // minute 80 ⇒ liveDelivering true, so evaluateExits runs — the skip must come from the ft_blind tag.
  // a leg that collapsed to 5¢ — a normal position would be stop/edge-gone cut; the ft_blind one holds
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Over 2.5", price: 5, ai_prob: 0.1, liquidity: "2000", external_ref: "tok", token_second: null, snapshot_at: "t", is_closing: false } as any);
  R.insertBet(db, { id: "hb-1", match_id: mid, strategy_id: "edge", risk_profile_id: "medium", market_label: "Over 2.5", status: "open", proposed_price: 55, entry_price: 55, current_price: 5, closing_price: null, ai_prob: 0.1, stake: 40, rationale: "r", entered_minute: "предматч", result: null, payout: null, settled_by: null, entry_meta: JSON.stringify({ phase: "prematch", ftBlind: true }), created_at: "t" } as any);
  await evaluateExits(db, { now: () => "t" });
  assert.equal(R.getBet(db, "hb-1")!.status, "open", "ft_blind position is held to settle, never cut by the live-exit machinery");
});

// [batch-12, п.5] Прематч-тезис, пролежавший «предлагается» до 40-й минуты, уходил в слепой вход
// безусловно: гейт спрашивал, когда РОДИЛСЯ тезис, и ни разу — сколько матча прошло к моменту, когда
// уходят ДЕНЬГИ. Это ровно тот запрет, ради которого режим существует. Отказ обязан быть посчитан.
test("FT-mode: прематч-тезис, залитый на 40', НЕ входит вслепую — и отказ пишет машинную строку", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const mid = seedPmOnly(db, { betId: "late-1", stake: 80 });
  await autoEnter(db, { now: () => "2026-07-06T18:40:00Z", env: { FT_BLIND_ENABLED: "true" } });
  assert.equal(R.getBet(db, "late-1")!.status, "proposed", "вслепую в идущий матч не входим");
  const logs = R.tradeLogForMatch(db, mid).filter((l: any) => String(l.text).includes("ft_blind_late_fill"));
  assert.equal(logs.length, 1, "цена гейта посчитана строкой, а не невидима");
  assert.ok(/40'/.test(String(logs[0].text)), "в строке видно, НАСКОЛЬКО поздний филл");
  // Окно расширяется явным env — но это решение владельца, а не молчаливый дефолт.
  await autoEnter(db, { now: () => "2026-07-06T18:40:00Z", env: { FT_BLIND_ENABLED: "true", FT_BLIND_LIVE_GRACE_MIN: "60" } });
  assert.equal(R.getBet(db, "late-1")!.status, "open", "с явно расширенным грейсом тот же филл проходит");
});
