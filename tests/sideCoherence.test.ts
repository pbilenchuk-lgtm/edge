// ============================================================
// EDGE LAB — N1: ДВЕ СТОРОНЫ ОДНОГО КОНТРАКТА + СВИП НЕ ОБГОНЯЕТ РЕЗОЛЮЦИЮ
//
// Именной кейс обоих свойств — UMF Breiðablik — Aqtöbe FK, 04.08:
//   • стратег выдал «Under 3.5» 64% И «Over 3.5» 64% (сумма 128%), $125 ушло на сторону,
//     ПРОТИВОПОЛОЖНУЮ тезису собственного рационале;
//   • через 5 часов после кикоффа свип обнулил все пять ставок (settled_via ПУСТ), обогнав
//     72-часовую очередь PM-резолюции на 67 часов.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { findSideConflicts, blockedByCoherence, SIDE_COHERENCE_TOLERANCE } from "../src/lib/sideCoherence.js";
import { sweepAbandonedMatches } from "../src/lib/staleSweep.js";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";

test("РЕГРЕССИЯ Breiðablik: Under 64% + Over 64% = 128% → блокируются ОБЕ", () => {
  const picks = [{ label: "Under 3.5", prob: 0.64 }, { label: "Over 3.5", prob: 0.64 }];
  const c = findSideConflicts(picks);
  assert.equal(c.length, 1);
  assert.equal(Math.round(c[0].sum * 100), 128);
  const { blocked } = blockedByCoherence(picks);
  assert.deepEqual([...blocked].sort(), ["Over 3.5", "Under 3.5"], "обе, а не «более вероятная»");
  assert.match(c[0].note, /гарантированный минус при любом исходе/);
  assert.match(c[0].note, /блокируются ОБЕ/);
});

test("когерентные стороны проходят: 64% + 36% = 100%", () => {
  assert.equal(findSideConflicts([{ label: "Under 3.5", prob: 0.64 }, { label: "Over 3.5", prob: 0.36 }]).length, 0);
});

test("допуск на округления есть, но он УЗКИЙ", () => {
  const ok = findSideConflicts([{ label: "Under 3.5", prob: 0.51 }, { label: "Over 3.5", prob: 0.5 }]);
  assert.equal(ok.length, 0, `сумма 101% в пределах ${SIDE_COHERENCE_TOLERANCE * 100}пп допуска`);
  const bad = findSideConflicts([{ label: "Under 3.5", prob: 0.55 }, { label: "Over 3.5", prob: 0.5 }]);
  assert.equal(bad.length, 1, "105% — уже сломанная сторона, а не округление");
});

test("НЕ комплементы не путаются: разные линии и разные рынки", () => {
  assert.equal(findSideConflicts([{ label: "Under 3.5", prob: 0.64 }, { label: "Over 2.5", prob: 0.7 }]).length, 0);
  assert.equal(findSideConflicts([{ label: "Under 3.5", prob: 0.64 }, { label: "BTTS Yes", prob: 0.7 }]).length, 0);
});

test("пик без вероятности не участвует — гадать не на чем", () => {
  assert.equal(findSideConflicts([{ label: "Under 3.5", prob: null }, { label: "Over 3.5", prob: 0.9 }]).length, 0);
});

// ── СВИП ─────────────────────────────────────────────────────────────────────────────────────────
function world(kickoff: string) {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "wcl", sport_id: "football", name: "WCL", budget: 8000, external_league: null, created_at: "2026-08-01" } as never);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: "2026-08-01", prompt: "p", prompt_live: null, params: {} } as never);
  R.insertMatch(db, { id: "m1", competition_id: "wcl", home: "Breidablik", away: "Aqtobe", state: "upcoming", lineup_out: false, kickoff_at: kickoff, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as never);
  R.insertBet(db, { id: "b1", match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "max", market_label: "Over 3.5", status: "open", proposed_price: 43.5, entry_price: 46.1, current_price: 46, closing_price: null, ai_prob: 0.64, stake: 70, rationale: "ft_blind", entered_minute: "предматч", result: null, payout: null, created_at: kickoff } as never);
  return db;
}
const KICK = "2026-08-04T14:00:00Z";
const at = (h: number) => Date.parse(KICK) + h * 3_600_000;

test("РЕГРЕССИЯ Breiðablik: через 5ч свип НЕ трогает открытые деньги — очередь резолюции ещё жива", () => {
  const db = world(KICK);
  const r = sweepAbandonedMatches(db, at(5.5));
  assert.equal(r.voided, 0, "ни одной обнулённой ставки");
  assert.equal(r.deferredBets, 1, "и это НАЗВАНО числом, а не молчанием");
  assert.equal(R.getBet(db, "b1")!.status, "open", "ft_blind живёт до резолюции — это его нормальное состояние");
});

test("после 72ч терпение истекло — свип воидит, но ОБЯЗАН назвать провенанс", () => {
  const db = world(KICK);
  const r = sweepAbandonedMatches(db, at(73));
  assert.equal(r.voided, 1);
  assert.equal(r.deferredBets, 0);
  const b = R.getBet(db, "b1")!;
  assert.equal(b.status, "settled_void");
  assert.equal(b.settled_by, "void");
  assert.equal(b.settled_via, "abandoned_sweep", "пустой settled_via и был тем, что скрывало путь");
});

test("матч БЕЗ ставок свип убирает как раньше — это его работа, и она не тронута", () => {
  const db = world(KICK);
  R.updateBet(db, "b1", { status: "settled_void", result: null, payout: 70 });
  const r = sweepAbandonedMatches(db, at(5.5));
  assert.equal(r.voided, 0);
  assert.equal(r.deferredBets, 0);
  assert.equal(R.getMatch(db, "m1")!.state, "finished", "состояние починено в тот же тик");
});
