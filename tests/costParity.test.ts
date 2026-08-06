// ============================================================
// T5 — ПАРИТЕТ ИЗДЕРЖЕК: одна модель списания на обе ноги портфеля
//
// Дефект был СТРУКТУРНЫМ: `OrderAck` не нёс разбивку издержек через границу исполнителя, поэтому
// теннисный леджер списывал $0 комиссий по построению — а net_ev-гейт той же ветки резал кандидатов,
// зная про 2.6¢. Вход считался в одних единицах, учёт вёлся в других, а P&L ног сравнивался как
// однородный. Здесь держатся два свойства: расхождение ВИДНО числом, и пустой леджер не выдаёт себя
// за отсутствие расхождения.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildCostParity, costParityLine, takerRate } from "../src/lib/costParity.js";

const NOW = "2026-08-07T00:00:00.000Z";

function world() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол"); R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: NOW } as never);
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 1000, external_league: null, created_at: NOW } as never);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: NOW, prompt: "p", prompt_live: null, params: {} } as never);
  R.insertStrategy(db, { id: "tennis_ovr", sport_id: "tennis", name: "TO", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: NOW, prompt: "p", prompt_live: null, params: {} } as never);
  for (const [id, comp] of [["mf", "epl"], ["mt", "atp"]] as const)
    R.insertMatch(db, { id, competition_id: comp, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: NOW, minute: null, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as never);
  return db;
}

const bet = (db: ReturnType<typeof world>, id: string, matchId: string, strat: string, stake: number, payout: number) =>
  R.insertBet(db, { id, match_id: matchId, strategy_id: strat, risk_profile_id: "medium", market_label: "Under 2.5",
    status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 100, closing_price: 100, ai_prob: 0.6,
    stake, rationale: "r", entered_minute: "предматч", result: "won", payout, created_at: NOW } as never);

const ledger = (db: ReturnType<typeof world>, betId: string, matchId: string, comp: string, strat: string, fee: number) =>
  R.insertFillCost(db, { id: R.uid(), bet_id: betId, match_id: matchId, competition_id: comp, strategy_id: strat,
    profile_id: "medium", side: "buy", shares: 100, notional_usd: 50, quote_cents: 50, vwap_cents: 50,
    fee_cents: 0.4, fee_usd: fee, slip_cents: 0, slip_usd: 0, from_book: 1, created_at: NOW } as never);

test("ставка комиссии берётся из той же env, что у исполнения", () => {
  assert.equal(takerRate({}), 0.0075);
  assert.equal(takerRate({ POLYMARKET_TAKER_FEE_RATE: "0.02" }), 0.02);
});

test("ИМЕННОЙ ДЕФЕКТ: у тенниса нет строк издержек — расхождение НАЗВАНО числом, а не спрятано", () => {
  const db = world();
  bet(db, "bf", "mf", "prematch_value", 100, 200);   // футбол: леджер есть
  ledger(db, "bf", "mf", "epl", "prematch_value", 2.25);
  bet(db, "bt", "mt", "tennis_ovr", 100, 200);       // теннис: леджера НЕТ (как было в проде)
  const r = buildCostParity(db, NOW, {});
  const t = r.legs.find((l) => l.leg === "tennis")!;
  const f = r.legs.find((l) => l.leg === "football")!;
  assert.equal(t.betsWithLedger, 0);
  assert.equal(t.notionalUsd, 300, "оборот считается ПО СТАВКАМ, а не по леджеру — иначе пустая нога показала бы ноль");
  assert.equal(t.expectedFeeUsd, 2.25);
  assert.equal(t.underchargedUsd, 2.25, "недосписанное названо суммой");
  assert.equal(f.underchargedUsd, 0, "нога с честным списанием расхождения не даёт");
  assert.equal(r.flagged, true);
  assert.match(r.note, /ПАРИТЕТА НЕТ/);
  assert.match(r.note, /История НЕ переписывается/);
});

test("сторож самообмана: пустой леджер НЕ читается как «расхождения нет»", () => {
  // Если бы оборот считался по строкам леджера, нога без строк дала бы оборот 0 → ожидание 0 →
  // «расхождения нет». Сторож, доказывающий своё отсутствие собственным отсутствием.
  const db = world();
  bet(db, "bt", "mt", "tennis_ovr", 500, 900);
  const t = buildCostParity(db, NOW, {}).legs.find((l) => l.leg === "tennis")!;
  assert.ok(t.notionalUsd > 0 && t.expectedFeeUsd > 0 && t.underchargedUsd > 0);
});

test("обе ноги списывают честно — паритет держится, флага нет", () => {
  const db = world();
  bet(db, "bf", "mf", "prematch_value", 100, 200);  ledger(db, "bf", "mf", "epl", "prematch_value", 2.25);
  bet(db, "bt", "mt", "tennis_ovr", 100, 200);      ledger(db, "bt", "mt", "atp", "tennis_ovr", 2.25);
  const r = buildCostParity(db, NOW, {});
  assert.equal(r.flagged, false);
  assert.match(r.note, /паритет держится/);
});

test("неисполненные и предложенные в оборот не идут — их не было", () => {
  const db = world();
  R.insertBet(db, { id: "bn", match_id: "mt", strategy_id: "tennis_ovr", risk_profile_id: "medium", market_label: "X",
    status: "not_filled", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6,
    stake: 999, rationale: "r", entered_minute: null, result: null, payout: null, created_at: NOW } as never);
  assert.deepEqual(buildCostParity(db, NOW, {}).legs, []);
});

test("строка еженедельника печатает ноль наравне с сотней", () => {
  const db = world();
  bet(db, "bt", "mt", "tennis_ovr", 100, 200);
  assert.match(costParityLine(buildCostParity(db, NOW, {})), /tennis 0\/1 строк, недосписано \$2\.25/);
});
