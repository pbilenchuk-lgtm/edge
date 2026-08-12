// ============================================================
// EDGE LAB — T8(а): ПОВОД ЕДЕТ ВМЕСТЕ С ТРИГГЕРОМ. T8(в): ФАКТ НЕСЁТ СВОЙ МОМЕНТ.
//
// (а) У `price_move` в payload не было НИ ОДНОГО числа: ни рынка, ни цен, ни порога. Нарратив был обязан
//     говорить о движении, ничего о нём не зная, и писал строку, верную при любых числах. Здесь
//     закрепляется и обратная сторона: если повод не передан, это печатается ИМЕНЕМ ДЕФЕКТА, а не
//     молчанием — иначе дыра в конвейере читалась бы как скупость рынка.
//
// (в) Классификатор покрытия говорит ОТНОСИТЕЛЬНЫМ временем («старт прошёл 1.5ч назад»). В живом отчёте
//     это правда; в строке торгового лога, лежащей месяцами, — правдоподобная ложь. Факт обязан нести
//     момент, на который он верен.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicReassess, triggerFactLine, priceMoveLine, type ReassessContext } from "../src/lib/llm.js";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { classifyScoutCoverage, buildScoutCoverage, scoutCoverageLine } from "../src/lib/scoutCoverage.js";

const base: ReassessContext = {
  match: "A–B", minute: 63, trigger: "price_move", scoreHome: 1, scoreAway: 0,
  strategyName: "Pre-match Value", strategyPrompt: "p",
};

test("[T8(а)] повод price_move печатается ЧИСЛАМИ: рынок, откуда куда, при каком пороге", () => {
  const ctx: ReassessContext = { ...base, move: { label: "Over 2.5", fromCents: 61, toCents: 74, thresholdCents: 8 } };
  const line = priceMoveLine(ctx.move!);
  assert.ok(line.includes("Over 2.5"));
  assert.ok(line.includes("61¢ → 74¢"));
  assert.ok(line.includes("+13¢"));
  assert.ok(line.includes("порог"));
  // Оба потребителя повода — эвристика и промпт LLM — берут ОДНУ функцию, а не две копии формата.
  assert.ok(heuristicReassess(ctx).includes(line));
  assert.ok(triggerFactLine(ctx).includes(line));
});

test("[T8(а)] знак движения не теряется: падение печатается минусом, а не модулем", () => {
  const ctx: ReassessContext = { ...base, move: { label: "BTTS", fromCents: 55, toCents: 41, thresholdCents: 8 } };
  assert.ok(priceMoveLine(ctx.move!).includes("−14¢") || priceMoveLine(ctx.move!).includes("-14¢"));
});

// Молчание здесь было бы худшим вариантом: читатель принял бы отсутствие повода за отсутствие деталей
// у рынка, а не за дыру в нашем конвейере. Тот же класс, что «немой ноль».
test("[T8(а)] повод НЕ передан — это названо дефектом пути, а не пропущено молча", () => {
  const ctx: ReassessContext = { ...base, move: undefined };
  assert.ok(triggerFactLine(ctx).includes("ПОВОД НЕ ПЕРЕДАН"));
  assert.ok(heuristicReassess(ctx).includes("ПОВОД НЕ ПЕРЕДАН"));
});

test("[T8(а)] у goal/red_card повод самоочевиден из счёта — лишней скобки не появляется", () => {
  assert.equal(triggerFactLine({ ...base, trigger: "goal" }), "");
  assert.equal(triggerFactLine({ ...base, trigger: "red_card" }), "");
});

// ── T8(в) ───────────────────────────────────────────────────────────────────────

function tennisWorld() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "itf", sport_id: "tennis", name: "ITF", budget: 0, external_league: null, created_at: "2026-08-01T00:00:00Z" });
  R.insertMatch(db, {
    id: "m1", competition_id: "itf", home: "P1", away: "P2", state: "lineup", lineup_out: false,
    kickoff_at: "2026-08-11T02:00:00Z", minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1",
  } as never);
  return db;
}

test("[T8(в)] у факта покрытия есть МОМЕНТ, на который он верен, и это тот же момент, что у отчёта", () => {
  const db = tennisWorld();
  const at = "2026-08-11T06:30:00Z";
  const row = classifyScoutCoverage(db, R.getMatch(db, "m1")!, at);
  assert.equal(row.asOf, at);
  // Нота говорит относительным временем — именно поэтому якорь обязателен.
  assert.ok(/назад|наступил/.test(row.note));

  const rep = buildScoutCoverage(db, at);
  assert.equal(rep.asOf, at);
  assert.ok(rep.note.startsWith(`[состояние на ${at}`));
  assert.ok(scoutCoverageLine(rep).includes(at));
  for (const r of rep.rows) assert.equal(r.asOf, at);
});

test("[T8(в)] два разных момента дают два разных якоря — поле не константа", () => {
  const db = tennisWorld();
  const a = classifyScoutCoverage(db, R.getMatch(db, "m1")!, "2026-08-11T06:00:00Z");
  const b = classifyScoutCoverage(db, R.getMatch(db, "m1")!, "2026-08-11T09:00:00Z");
  assert.notEqual(a.asOf, b.asOf);
});
