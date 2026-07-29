import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { evaluateExits } from "../src/lib/lifecycle.js";
import { markGapWake } from "../src/lib/scheduleGap.js";

// A live football match with one OPEN directional position whose executable price has crashed far below entry
// (a hard stop fires). Directional (moneyline) → NOT melting-option-exempt, NOT an Under → a clean protective
// stop. poly OFF → sell price == the market quote, deterministic and no book fetch.
function setup(priceCents: number, score: [number, number] = [0, 0], minute = 70) {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Celje", away: "Maribor", state: "live", lineup_out: true, kickoff_at: null, minute, score_home: score[0], score_away: score[1], final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const setPrice = (p: number, at: string) => R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Celje", price: p, ai_prob: 0.5, liquidity: "2000", external_ref: "TOK", snapshot_at: at, is_closing: false });
  setPrice(priceCents, "t0");
  R.insertBet(db, { id: "pos", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Celje", status: "open", proposed_price: 60, entry_price: 60, current_price: priceCents, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });
  return { db, mid, strat, comp, setPrice };
}
const iso = (ms: number) => new Date(ms).toISOString();

test("P0.6 gate: a NORMAL-time protective stop (no gap wake) fires immediately, no deferral", async () => {
  const { db } = setup(20); // 60 → 20 = −67% → hard stop
  const T = Date.parse("2026-07-22T18:00:00Z");
  await evaluateExits(db, { now: () => iso(T), env: {} });
  assert.ok(R.getBet(db, "pos")!.status.startsWith("settled"), "the stop fires at once when there was no gap");
  assert.equal(R.openGapReprices(db).length, 0, "no reprice deferral is armed in normal time");
});

test("P0.6 (b) defer: a stop on the FIRST tick after a gap is delayed (watch armed), position not closed", async () => {
  const { db } = setup(20);
  const T = Date.parse("2026-07-22T18:00:00Z");
  markGapWake(db, T, 3480, {}); // ~58-min sleep just woke
  await evaluateExits(db, { now: () => iso(T), env: {} });
  assert.equal(R.getBet(db, "pos")!.status, "open", "the stop is deferred, not executed, on the wake tick");
  const w = R.getOpenGapReprice(db, "pos");
  assert.ok(w, "a reprice watch is armed");
  assert.equal(w!.gap_sec, 3480);
  assert.ok(R.tradeLogForMatch(db, w!.match_id).some((l) => /gap_wake_reprice/.test(l.text)), "deferral logged — стоп НЕ отменён");
});

test("P0.6 (a) invalidator: a declared counter_scenario met on fresh state → immediate exit, no window", async () => {
  const { db, mid, strat } = setup(20, [0, 2], 35); // Maribor scored twice during the sleep
  // The pair's plan registered the adverse condition "0:2 к 30'" for this market.
  R.saveArtifact(db, { match_id: mid, kind: "battle_sheet", label: `${strat.name} · medium`, stage: "prematch", content: JSON.stringify({ positions: [{ market: "Celje", exit: { counter_scenario_stop: "0:2 к 30'" } }] }), model: "m", created_at: "t" });
  const T = Date.parse("2026-07-22T18:00:00Z");
  markGapWake(db, T, 3480, {});
  await evaluateExits(db, { now: () => iso(T), env: {} });
  assert.ok(R.getBet(db, "pos")!.status.startsWith("settled"), "invalidator → immediate exit, no reprice wait");
  assert.equal(R.openGapReprices(db).length, 0, "no lingering deferral");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /gap_wake_invalidator/.test(l.text)));
});

test("P0.6 (c) expired: the window runs out with price still below floor → stop executes unconditionally", async () => {
  const { db } = setup(20);
  const T = Date.parse("2026-07-22T18:00:00Z");
  markGapWake(db, T, 3480, {});
  await evaluateExits(db, { now: () => iso(T), env: {} });               // wake: defer
  assert.equal(R.getBet(db, "pos")!.status, "open");
  await evaluateExits(db, { now: () => iso(T + 120_000), env: {} });     // +120s > 90s deadline → execute
  assert.ok(R.getBet(db, "pos")!.status.startsWith("settled"), "expired window → unconditional stop");
  const m = R.gapRepriceMeasurements(db).find((r) => r.bet_id === "pos");
  assert.equal(m!.outcome, "expired");
  assert.equal(m!.delta_cents, 0, "price unchanged over the wait → delta 0");
});

test("P0.6 recovered: price comes back above the stop level within the window → deferral cleared, position kept", async () => {
  const { db, setPrice } = setup(20);
  const T = Date.parse("2026-07-22T18:00:00Z");
  markGapWake(db, T, 3480, {});
  await evaluateExits(db, { now: () => iso(T), env: {} });               // wake: defer (floor at 20¢)
  assert.ok(R.getOpenGapReprice(db, "pos"), "deferred");
  setPrice(65, "t1");                                                    // book unclenched: 65¢ > entry 60 → no stop
  await evaluateExits(db, { now: () => iso(T + 30_000), env: {} });
  assert.equal(R.getBet(db, "pos")!.status, "open", "recovered → the position keeps running, stop not forced");
  const m = R.gapRepriceMeasurements(db).find((r) => r.bet_id === "pos");
  assert.equal(m!.outcome, "recovered");
  assert.equal(m!.delta_cents, 45, "saved 65−20 = 45¢ vs dumping at the gap bottom");
});

// [поправка по факту прода] Дробилка повторов ключевалась на ОДНОМ рынке: любая hold-строка по нему среди
// последних восьми глушила следующую причину целиком. Так чужой hold молча съедал улику `quasi_locked_tail`,
// и её счётчик не мог отличить «не сработало» от «сработало, но строку проглотили». Ключ — (рынок + причина).
test("hold-строки: разные причины по одному рынку пишутся обе, повтор одной — нет", async () => {
  const { db, mid } = setup(20, [0, 0], 70);
  const T = Date.parse("2026-07-22T18:00:00Z");
  const strat = R.listStrategies(db, "football")[0];
  // Чужая причина уже записана по этому же рынку.
  R.insertTradeLog(db, { id: "h0", match_id: mid, strategy_id: strat.id, minute: "70'", type: "hold", text: `ценовой стоп подавлен по «Celje»: ... (under_thesis_safe)`, created_at: "2026-07-22T17:59:00Z" } as any);
  markGapWake(db, T, 3480, {});
  await evaluateExits(db, { now: () => iso(T), env: {} });
  const logs = R.tradeLogForMatch(db, mid).filter((l) => l.type === "hold");
  assert.ok(logs.some((l) => /gap_wake_reprice/.test(l.text)), "своя причина не проглочена чужой");
  // Повтор той же причины на следующем тике — по-прежнему одна строка (анти-шторм сохранён).
  const before = logs.filter((l) => /gap_wake_reprice/.test(l.text)).length;
  await evaluateExits(db, { now: () => iso(T + 30_000), env: {} });
  const after = R.tradeLogForMatch(db, mid).filter((l) => /gap_wake_reprice/.test(l.text)).length;
  assert.equal(after, before, "одна строка на причину на рынок — шторма нет");
});
