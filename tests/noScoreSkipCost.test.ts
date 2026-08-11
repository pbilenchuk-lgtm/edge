// ============================================================
// EDGE LAB — T7: ЦЕНА СЛЕПОТЫ СКАУТА. ТЕСТЫ НА ТО, ЧТО ЗАМЕР НЕ ЛЬСТИТ.
//
// Проверяется не «функция считает суммы», а три обещания, каждое из которых уже однажды нарушалось в
// соседних отчётах этого проекта:
//   • отказ `no_score_data_skip` — ПРИЗНАК МАТЧА, а не автор ставки: убыток режется по стратегии,
//     которая позицию открыла, а не по сторожу, который в сделке не участвовал;
//   • при малой выборке вердикт НЕ выносится (и это видно словом, а не пустотой);
//   • void не считается ни победой, ни поражением, но остаётся в обороте.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { seedRiskProfiles } from "../src/lib/riskConfig.js";
import { buildNoScoreSkipCost, noScoreSkipCostLine, skipReasonOf, COHORT_MIN_BETS } from "../src/lib/noScoreSkipCost.js";

const T = "2026-08-01T00:00:00Z";
const NOW = "2026-08-11T00:00:00Z";

function world() {
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, T);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "itf", sport_id: "tennis", name: "ITF", budget: 0, external_league: null, created_at: T });
  for (const id of ["tennis_set_value", "tennis_overreaction", "tennis_pmv"])
    R.insertStrategy(db, { id, sport_id: "tennis", name: id, tag: "t", color: null, version: 1, model: null, model_live: null, created_at: T, prompt: "p", prompt_live: null, params: {} } as never);
  return db;
}

function match(db: ReturnType<typeof world>, id: string) {
  R.insertMatch(db, {
    id, competition_id: "itf", home: `P${id}a`, away: `P${id}b`, state: "finished", lineup_out: false,
    kickoff_at: T, minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id,
  } as never);
}

function skipLine(db: ReturnType<typeof world>, mid: string, reason: string) {
  R.insertTradeLog(db, {
    id: R.uid(), match_id: mid, strategy_id: "tennis_set_value", minute: "сет 2", type: "skip",
    text: `no_score_data_skip[${reason}]: счёт не подтверждён, триггер НЕ армится (fail-closed).`, created_at: T,
  } as never);
}

let seq = 0;
function bet(db: ReturnType<typeof world>, mid: string, strategy: string, outcome: "won" | "lost" | "void", stake = 10, payout = 0) {
  const id = `b${++seq}`;
  R.insertBet(db, {
    id, match_id: mid, strategy_id: strategy, risk_profile_id: "medium", market_label: "ML",
    status: outcome === "void" ? "settled_void" : outcome === "won" ? "settled_won" : "settled_lost",
    proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.5,
    stake, rationale: "r", entered_minute: "предматч",
    result: outcome === "void" ? null : outcome, payout, created_at: T,
  } as never);
}

test("пустая база: отсутствие строк отказа названо ОТСУТСТВИЕМ ЗАМЕРА, а не нулевой ценой", () => {
  const r = buildNoScoreSkipCost(world(), NOW);
  assert.equal(r.skipMatchesTotal, 0);
  assert.equal(r.verdict, "insufficient");
  assert.ok(r.note.includes("ОТСУТСТВИЕ ЗАМЕРА"));
  assert.ok(noScoreSkipCostLine(r).includes("НЕ ИЗМЕРЯЕТСЯ"));
});

// ГЛАВНОЕ обещание модуля. Отказ выписывает `tennis_set_value` (fail-closed, он НЕ торгует), а позиции
// на этих матчах открыл `tennis_overreaction`. Приписать убыток сторожу — ровно та ошибка атрибуции,
// из-за которой хвост назывался «12 проигрышей no_score_data_skip».
test("убыток режется по стратегии-ОТКРЫВАТЕЛЮ, а не по сторожу, выписавшему отказ", () => {
  const db = world();
  match(db, "m1"); match(db, "m2");
  skipLine(db, "m1", "НЕ В ФИДЕ"); skipLine(db, "m2", "УСТАРЕЛ");
  bet(db, "m1", "tennis_overreaction", "lost", 10, 0);
  bet(db, "m2", "tennis_overreaction", "lost", 10, 0);
  const r = buildNoScoreSkipCost(db, NOW);

  assert.equal(r.skipMatchesTotal, 2);
  assert.equal(r.blind.bets, 2);
  assert.equal(r.blind.pnlUsd, -20);
  // Сторож в разрезе не появляется вовсе: у него нет ни одной ставки.
  assert.deepEqual(r.byStrategy.blind.map((x) => x.strategyId), ["tennis_overreaction"]);
  assert.ok(r.criterion.includes("ПРИЗНАК МАТЧА"));
});

test("причины разделены, и у каждой ДВА знаменателя: все матчи и матчи со ставками", () => {
  const db = world();
  match(db, "m1"); match(db, "m2"); match(db, "m3");
  skipLine(db, "m1", "НЕ В ФИДЕ"); skipLine(db, "m2", "НЕ В ФИДЕ"); skipLine(db, "m3", "НЕ СВЯЗАН");
  bet(db, "m1", "tennis_pmv", "lost", 25, 0);      // торговали только на m1
  const r = buildNoScoreSkipCost(db, NOW);

  const feed = r.byReason.find((x) => x.reason === "НЕ В ФИДЕ");
  assert.ok(feed);
  assert.equal(feed.matches, 2);            // слепота была на двух
  assert.equal(feed.matchesWithBets, 1);    // а торговали на одном — числа разные и НЕ слиты
  assert.equal(feed.pnlUsd, -25);
  const unbound = r.byReason.find((x) => x.reason === "НЕ СВЯЗАН");
  assert.equal(unbound?.matchesWithBets, 0);
});

test("void остаётся в обороте, но из доли побед исключён — знаменатель назван честно", () => {
  const db = world();
  match(db, "m1"); skipLine(db, "m1", "УСТАРЕЛ");
  bet(db, "m1", "tennis_pmv", "won", 10, 20);
  bet(db, "m1", "tennis_pmv", "lost", 10, 0);
  bet(db, "m1", "tennis_pmv", "void", 10, 10);
  const r = buildNoScoreSkipCost(db, NOW);
  assert.equal(r.blind.bets, 3);
  assert.equal(r.blind.voided, 1);
  assert.equal(r.blind.winRate, 50);        // 1 из 2 РЕШЁННЫХ, а не 1 из 3
  assert.equal(r.blind.stakeUsd, 30);       // но оборот считает все три
  assert.equal(r.blind.pnlUsd, 0);
});

test("малая выборка: вердикт НЕ выносится, и порог назван числом", () => {
  const db = world();
  match(db, "m1"); skipLine(db, "m1", "НЕ В ФИДЕ");
  bet(db, "m1", "tennis_pmv", "lost");
  match(db, "m2");
  bet(db, "m2", "tennis_pmv", "won", 10, 20);
  const r = buildNoScoreSkipCost(db, NOW);
  assert.equal(r.verdict, "insufficient");
  assert.ok(r.criterion.includes(String(COHORT_MIN_BETS)));
  assert.ok(r.note.includes("вердикт НЕ выносится"));
});

test("созревшие когорты: вердикт есть, но назван НАБЛЮДАТЕЛЬНЫМ, а не эффектом слепоты", () => {
  const db = world();
  for (let i = 0; i < COHORT_MIN_BETS; i++) {
    const mid = `blind${i}`; match(db, mid); skipLine(db, mid, "НЕ В ФИДЕ");
    bet(db, mid, "tennis_overreaction", "lost", 10, 0);
    const cid = `ctl${i}`; match(db, cid);
    bet(db, cid, "tennis_overreaction", "won", 10, 20);
  }
  const r = buildNoScoreSkipCost(db, NOW);
  assert.equal(r.verdict, "measured");
  assert.equal(r.blind.winRate, 0);
  assert.equal(r.control.winRate, 100);
  assert.ok(r.note.includes("НАБЛЮДАТЕЛЬНОЕ"));
  assert.ok(noScoreSkipCostLine(r).includes("худший открыватель"));
});

// Старые строки писались без квадратных скобок («no_score_data_skip (15м > 15м)»). Свалить их в общую
// кучу значило бы смешать две эпохи диагностики; имя у них своё и явное.
test("строки дономенклатурной эпохи получают ЯВНОЕ имя, а не растворяются в общей причине", () => {
  assert.equal(skipReasonOf("no_score_data_skip[НЕ В ФИДЕ]: …"), "НЕ В ФИДЕ");
  assert.equal(skipReasonOf("no_score_data_skip (15м > 15м): …"), "(до именования причин)");
});
