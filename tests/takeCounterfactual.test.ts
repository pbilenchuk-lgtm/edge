// ============================================================
// EDGE LAB — N5: ТЕЙК-СТОРОНА СУДИТСЯ БЕЗ HINDSIGHT-ОТБОРА
//
// Именной кейс — Celtic 03.08: контракт СЫГРАЛ, 12 кусков на $250, фактический payout $392.31, а
// удержание до сеттла дало бы $498.01. Недобор $105.70 = 42.3% вложенного, однонаправленно.
//
// Главное свойство здесь — НЕ считать только выигравшие рынки. На проигравшем рынке ранний тейк деньги
// СПАС, и эта выгода обязана входить в ту же сумму со своим знаком; иначе получится не оценка правила,
// а коллекция сожалений. Тест на это стоит вторым и специально делает вердикт противоположным.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildTakeCounterfactual, takeCfLine, TAKE_CF_MIN_N, TAKE_CF_SHORTFALL_PCT } from "../src/lib/takeCounterfactual.js";

function world() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "sco", sport_id: "football", name: "SPFL", budget: 8000, external_league: "sco.1", created_at: "2026-08-01" } as never);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: "2026-08-01", prompt: "p", prompt_live: null, params: {} } as never);
  return db;
}
/** Ставка с ОДНИМ тейк-выходом: вход `entry`¢, выход `exit`¢, размер куска `stake`, исход рынка `won`. */
function bet(db: ReturnType<typeof world>, i: number, o: { entry: number; exit: number; stake: number; won: boolean }) {
  const mid = `m${i}`;
  R.insertMatch(db, { id: mid, competition_id: "sco", home: `H${i}`, away: `A${i}`, state: "finished", lineup_out: true, kickoff_at: "2026-08-03T18:30:00Z", minute: null, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as never);
  const pnl = Math.round(o.stake * ((o.exit - o.entry) / o.entry) * 100) / 100;
  R.insertBet(db, {
    id: `b${i}`, match_id: mid, strategy_id: "prematch_value", risk_profile_id: "max", market_label: "Under 3.5",
    status: o.won ? "settled_won" : "settled_lost", proposed_price: o.entry, entry_price: o.entry, current_price: o.exit,
    closing_price: o.exit, ai_prob: 0.62, stake: o.stake, rationale: "r", entered_minute: "2'",
    result: o.won ? "won" : "lost", payout: o.won ? o.stake + pnl : 0, created_at: "2026-08-03T18:32:00Z",
  } as never);
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: "prematch_value", bet_id: `b${i}`, minute: "45'", type: "exit", text: `выход «Under 3.5» (частично 50%) (take_price) @ ${o.exit}¢ · P&L ${pnl >= 0 ? "+" : ""}$${pnl}`, created_at: "2026-08-03T19:15:00Z" } as never);
}

test("пороги ЗАФИКСИРОВАНЫ до данных (критерий F4)", () => {
  assert.equal(TAKE_CF_MIN_N, 30);
  assert.equal(TAKE_CF_SHORTFALL_PCT, 15);
});

test("недобор не набран по объёму — вердикта НЕТ, и копим названо числом", () => {
  const db = world();
  for (let i = 0; i < 5; i++) bet(db, i, { entry: 50, exit: 85, stake: 20, won: true });
  const r = buildTakeCounterfactual(db);
  assert.equal(r.verdict, "insufficient");
  assert.match(r.note, /5\/30 тейк-кусков/);
  assert.match(takeCfLine(r), /5\/30 кусков/);
});

test("ПРОИГРАВШИЕ рынки входят со своим знаком — иначе это коллекция сожалений", () => {
  const db = world();
  // 20 выигравших: тейк по 85¢ вместо 100¢ — недобор.
  for (let i = 0; i < 20; i++) bet(db, i, { entry: 50, exit: 85, stake: 20, won: true });
  // 20 проигравших: тейк по 60¢ вместо 0¢ — ранний выход СПАС деньги, отрицательный недобор.
  for (let i = 20; i < 40; i++) bet(db, i, { entry: 50, exit: 60, stake: 20, won: false });
  const r = buildTakeCounterfactual(db);
  assert.equal(r.n, 40);
  const won = r.byOutcome.find((g) => g.key === "рынок выиграл")!;
  const lost = r.byOutcome.find((g) => g.key === "рынок проиграл")!;
  assert.ok(won.shortfallUsd > 0, "на выигравших лесенка отдала деньги");
  assert.ok(lost.shortfallUsd < 0, "на проигравших — спасла, и это ОТРИЦАТЕЛЬНЫЙ недобор");
  assert.ok(r.shortfallUsd < won.shortfallUsd, "итог считает обе стороны, а не только сожаления");
});

test("лесенка дорога: недобор ≥15% оборота на n≥30 → ratified-следствие названо", () => {
  const db = world();
  for (let i = 0; i < 32; i++) bet(db, i, { entry: 50, exit: 85, stake: 20, won: true });
  const r = buildTakeCounterfactual(db);
  assert.equal(r.verdict, "ladder_costly");
  assert.ok((r.shortfallPct ?? 0) >= TAKE_CF_SHORTFALL_PCT);
  assert.match(r.note, /частичники только по тезис-событиям/);
});

test("лесенка оправдана: спасённое на проигравших перекрывает отданное", () => {
  const db = world();
  for (let i = 0; i < 8; i++) bet(db, i, { entry: 50, exit: 95, stake: 20, won: true });     // почти не отдали
  for (let i = 8; i < 40; i++) bet(db, i, { entry: 50, exit: 70, stake: 20, won: false });   // много спасли
  const r = buildTakeCounterfactual(db);
  assert.equal(r.verdict, "ladder_justified");
  assert.ok((r.shortfallPct ?? 0) < TAKE_CF_SHORTFALL_PCT);
  assert.match(r.note, /окупаются спасённым на проигравших/);
});

test("защитные срезы в тейк-когорту НЕ попадают — их судит своя машинерия", () => {
  const db = world();
  bet(db, 0, { entry: 50, exit: 85, stake: 20, won: true });
  R.insertTradeLog(db, { id: R.uid(), match_id: "m0", strategy_id: "prematch_value", bet_id: "b0", minute: "60'", type: "exit", text: "выход «Under 3.5» тезис сломан (thesis_stop) @ 30¢ · P&L -$12", created_at: "2026-08-03T19:30:00Z" } as never);
  const r = buildTakeCounterfactual(db);
  assert.equal(r.n, 1, "только тейк-кусок");
  assert.equal(r.byTrigger.length, 1);
});
