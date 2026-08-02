// ============================================================
// EDGE LAB — D1: ЗАЩИТНЫЙ СРЕЗ ПО СЛОМУ ТЕЗИСА, А НЕ ПО ЦЕНЕ
//
// Что здесь доказывается — четыре обещания ратификации, а не работоспособность функции:
//   1. counter_scenario НЕ ТРОНУТ. Единственный путь с отрицательным недобором (режет вовремя) обязан
//      пройти гейт без изменений — иначе «лечение» убьёт то единственное, что работало.
//   2. НЕ-ТАЮЩИЙ ПЕРИМЕТР СОХРАНЁН. У Under/No каждый гол — необратимый шаг вниз, стоп остаётся.
//   3. ДЕГРАДАЦИЯ ВОЗВРАЩАЕТ СТРАХОВКУ. Если стратег-слой лёг, позиция без присмотра хуже, чем срез
//      с недобором: правило обязано уступать, а не превращаться в догму.
//   4. ОТКАТ ЗАПИСАН ЧИСЛОМ. Две отрицательные недели подряд → порог достигнут. Проверяется на данных,
//      а не на обещании; формула симметрична и не умеет льстить правилу.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import {
  defensiveCutAllowed, meltingThesisDead, timeDecayFloorEnabled,
  buildNetHoldBenefit, recordHoldMark, holdBenefitLine, HOLD_BENEFIT_ROLLBACK_WEEKS,
} from "../src/lib/defensiveCutGate.js";

const base = { matchState: "live", minute: 70, maxMinutes: 90, degraded: false, env: {} as Record<string, string | undefined> };

test("counter_scenario не тронут — единственный путь с отрицательным недобором проходит гейт", () => {
  const v = defensiveCutAllowed({ ...base, kind: "counter_scenario", melting: true });
  assert.equal(v.allow, true);
  assert.equal(v.code, null);
  assert.match(v.reason, /не защитный срез/);
});

test("тающий опцион: защитный срез НЕ исполняется, пока game-state не подтвердил смерть тезиса", () => {
  for (const kind of ["hard_stop", "capitulation", "time_stop", "thesis_stop"]) {
    const v = defensiveCutAllowed({ ...base, kind, melting: true });
    assert.equal(v.allow, false, `${kind} обязан удерживаться`);
    assert.ok(v.code, `${kind}: удержание обязано нести машиночитаемый код`);
    assert.match(v.reason, /цена сама по себе — не основание/);
  }
});

test("тающий опцион: срез РАЗРЕШЁН, когда матч кончился — событие уже не наступит", () => {
  const v = defensiveCutAllowed({ ...base, kind: "hard_stop", melting: true, matchState: "finished" });
  assert.equal(v.allow, true);
  assert.match(v.reason, /слом тезиса подтверждён game-state/);
  assert.ok(meltingThesisDead("finished", 90, 90));
  assert.equal(meltingThesisDead("live", 70, 90), null, "на 70' тезис жив — гол может прийти на 90+6");
});

test("НЕ-тающий периметр сохранён: Under/No по-прежнему режется", () => {
  const v = defensiveCutAllowed({ ...base, kind: "hard_stop", melting: false });
  assert.equal(v.allow, true);
  assert.match(v.reason, /каждый гол необратимый шаг вниз/);
});

test("time_decay_floor приостановлен как класс, но возвращается ЯВНЫМ решением, а не умолчанием", () => {
  const off = defensiveCutAllowed({ ...base, kind: "time_decay_floor", melting: true });
  assert.equal(off.allow, false);
  assert.equal(off.code, "time_decay_floor_suspended");
  assert.match(off.reason, /27\.2¢/, "причина несёт ИЗМЕРЕНИЕ, а не мнение");
  assert.equal(timeDecayFloorEnabled({}), false);
  assert.equal(timeDecayFloorEnabled({ TIME_DECAY_FLOOR_ENABLED: "1" }), true);
  const on = defensiveCutAllowed({ ...base, kind: "time_decay_floor", melting: true, env: { TIME_DECAY_FLOOR_ENABLED: "1" } });
  assert.equal(on.allow, true, "включается обратно решением");
});

test("деградация стратег-слоя ВОЗВРАЩАЕТ страховку — правило уступает, а не догматствует", () => {
  const v = defensiveCutAllowed({ ...base, kind: "hard_stop", melting: true, degraded: true });
  assert.equal(v.allow, true);
  assert.match(v.reason, /degraded_mode/);
});

// ── самоизмерение с откат-порогом ───────────────────────────────────────────────────────────────

function world() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 1000, external_league: "usa.1", created_at: "2026-07-01" });
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "OVR", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: "2026-07-01", prompt: "p", prompt_live: null, params: {} } as never);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "H", away: "A", state: "finished", lineup_out: true, kickoff_at: "2026-07-20T18:00:00Z", minute: null, score_home: 3, score_away: 0, final_score: "3:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as never);
  return db;
}
const bet = (db: ReturnType<typeof world>, id: string, stake: number, entry: number, payout: number, status = "settled_won") =>
  R.insertBet(db, {
    id, match_id: "m1", strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Over 2.5",
    status, proposed_price: entry, entry_price: entry, current_price: entry, closing_price: null,
    ai_prob: 0.6, stake, rationale: "r", entered_minute: "60'", result: status === "settled_won" ? "won" : "lost", payout, created_at: "2026-07-20T18:00:00Z",
  } as never);

test("удержание, которое ВЗЯЛО: срез был бы по 4¢, сеттл дал 100 — вклад положителен и измерен", () => {
  const db = world();
  bet(db, "b1", 100, 50, 200);                                   // вход 50¢, сеттл выплатил $200
  recordHoldMark(db, "m1", "overreaction", "b1", "time_decay_floor_suspended", 4, "флор приостановлен", "2026-07-20T19:00:00Z");
  const r = buildNetHoldBenefit(db, Date.parse("2026-07-27T00:00:00Z"));
  const row = r.rows[0];
  assert.equal(row.holdCents, 4);
  assert.equal(row.wouldBeCutUsd, 8, "срез по 4¢ при входе 50¢ дал бы $8 из $100");
  assert.equal(row.realizedUsd, 200);
  assert.equal(row.benefitUsd, 192);
  assert.equal(r.weeks.length, 1);
  assert.equal(r.weeks[0].netHoldBenefitUsd, 192);
  assert.equal(r.rollback.triggered, false);
});

test("формула СИММЕТРИЧНА: удержание, которое отдало, входит с тем же знаком", () => {
  const db = world();
  bet(db, "b2", 100, 50, 0, "settled_lost");                     // держали — и получили ноль
  recordHoldMark(db, "m1", "overreaction", "b2", "melting_cut_no_thesis_break", 30, "держим", "2026-07-20T19:00:00Z");
  const r = buildNetHoldBenefit(db, Date.parse("2026-07-27T00:00:00Z"));
  assert.equal(r.rows[0].wouldBeCutUsd, 60, "срез по 30¢ дал бы $60");
  assert.equal(r.rows[0].benefitUsd, -60, "удержание ОТДАЛО $60 — правило не умеет себе льстить");
  assert.equal(r.weeks[0].netHoldBenefitUsd, -60);
});

test("ОТКАТ: две отрицательные недели подряд достигают порога, зафиксированного ДО деплоя", () => {
  const db = world();
  bet(db, "w1", 100, 50, 0, "settled_lost");
  bet(db, "w2", 100, 50, 0, "settled_lost");
  recordHoldMark(db, "m1", "overreaction", "w1", "melting_cut_no_thesis_break", 30, "h", "2026-07-13T12:00:00Z");
  recordHoldMark(db, "m1", "overreaction", "w2", "melting_cut_no_thesis_break", 30, "h", "2026-07-20T12:00:00Z");
  const r = buildNetHoldBenefit(db, Date.parse("2026-07-27T00:00:00Z"));
  assert.equal(r.weeks.length, 2);
  assert.ok(r.weeks.every((w) => w.netHoldBenefitUsd < 0));
  assert.equal(r.rollback.consecutiveNegative, 2);
  assert.equal(r.rollback.needConsecutive, HOLD_BENEFIT_ROLLBACK_WEEKS);
  assert.equal(r.rollback.triggered, true);
  assert.match(r.rollback.note, /ОТКАТ/);
  assert.match(holdBenefitLine(r), /ПОРОГ ОТКАТА ДОСТИГНУТ/);
});

test("ещё открытая позиция во вклад НЕ входит — это отсутствие замера, а не ноль пользы", () => {
  const db = world();
  bet(db, "b3", 100, 50, 0, "open");
  recordHoldMark(db, "m1", "overreaction", "b3", "melting_cut_no_thesis_break", 20, "h", "2026-07-20T19:00:00Z");
  const r = buildNetHoldBenefit(db, Date.parse("2026-07-27T00:00:00Z"));
  assert.equal(r.rows[0].benefitUsd, null);
  assert.equal(r.weeks.length, 0);
  assert.match(r.note, /ОТСУТСТВИЕ ЗАМЕРА/);
});

// ── D2: ЗНАЧИМОСТЬ СЧИТАЕТСЯ ПО СИГНАЛАМ, А НЕ ПО СТРОКАМ ───────────────────────────────────────
// 02.08 я посчитал «24 из 24» по СТРОКАМ и получил p=0.00004. За ними стояло ТРИ различных сигнала
// (матч×рынок); строки — это профили и куски ОДНОГО события. По сигналам p=0.28, то есть обычная
// тройка подряд. Ложная значимость едва не стала основанием для механизма D3.

import { groupSignificance, GROUP_BASE_WIN, type ForensicRow } from "../src/lib/anomalyForensic.js";

const row = (match: string, market: string, outcome: string): ForensicRow => ({
  betId: `${match}-${market}-${outcome}-${Math.round(Math.random() * 1e9)}`, matchLabel: match, competitionId: "c",
  group: "g", market, status: "settled_won", outcome, settledBy: "early", finalScore: "1:0",
  impliedByScore: true, flags: ["clean"], note: "",
});

test("D2: восемь строк одного матч×рынка — это ОДИН сигнал, а не восемь испытаний", () => {
  const rows = Array.from({ length: 8 }, () => row("A — B", "Under 3.5", "won"));
  const s = groupSignificance(rows, GROUP_BASE_WIN, "ge");
  assert.equal(s.rows, 8);
  assert.equal(s.signals, 1, "профили и куски одного рынка схлопываются в одно событие");
  assert.equal(s.signalsWon, 1);
});

test("D2: ложная значимость по строкам исчезает при честном схлопывании", () => {
  // 24 строки, все выигравшие, но за ними ТРИ матч×рынка — ровно прод-случай 02.08.
  const rows = [
    ...Array.from({ length: 12 }, () => row("Nordsjælland — Randers", "Under 3.5", "won")),
    ...Array.from({ length: 10 }, () => row("CS Cristal — ADC Juan", "Under 3.5", "won")),
    ...Array.from({ length: 2 }, () => row("Cajamarca — Huancayo", "Under 2.5", "won")),
  ];
  const s = groupSignificance(rows, GROUP_BASE_WIN, "ge");
  assert.equal(s.signals, 3);
  assert.equal(s.signalsWon, 3);
  assert.ok(s.p != null && s.p > 0.05, `p по сигналам обязан быть НЕзначим, получено ${s.p}`);
  assert.equal(s.significant, false);
  assert.match(s.note, /дисперсия НЕ отвергнута/);
  // Для сравнения: по строкам это дало бы 0.657^24 ≈ 0.00004 — та самая ложная значимость.
  assert.ok(Math.pow(GROUP_BASE_WIN, 24) < 0.0001, "именно так и выглядела ошибка");
});

test("D2: значимость НЕ исчезает там, где сигналов действительно много", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => row(`M${i}`, "Under 2.5", "lost")),
    ...Array.from({ length: 5 }, (_, i) => row(`W${i}`, "Under 2.5", "won")),
  ];
  const s = groupSignificance(rows, GROUP_BASE_WIN, "le");
  assert.equal(s.signals, 25);
  assert.ok(s.p != null && s.p < 0.05, "25 независимых сигналов при 5 победах — это значимо, и схлопывание этого не прячет");
  assert.equal(s.significant, true);
});
