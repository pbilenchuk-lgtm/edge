// ============================================================
// EDGE LAB — CLV ВЕРНУЛСЯ В КОД, И ТЕПЕРЬ ЕГО НЕЛЬЗЯ ПОКАЗАТЬ БЕЗ СОСТОЯНИЯ
//
// Мой откат прода 30.07 (24f1dc7) снёс `src/lib/clv.ts` вместе с тремя точками вызова. Это был не просто
// «удалённый модуль» — это был откат ИСПРАВЛЕНИЯ. До clv.ts CLV считался как `bets.closing_price −
// entry_price`, а `closing_price` линией закрытия не является:
//   • при досрочном выходе туда пишется НАША цена выхода → «CLV» = тот же P&L в центах. Всякая фиксация
//     прибыли даёт положительный «CLV» по построению, и две ноги вердикта перестают быть независимыми;
//   • при расчёте по резолюции туда пишется цена разрешения (≈100/≈0) → «CLV» = исход.
// То есть после моего отката гейт неделю показывал не «CLV −2.90¢», а переименованный P&L и исход.
//
// Владелец: «критерий, измеряемый скриптом мимо кода, — это не критерий, это цифра с видом измерения».
// Отсюда два требования, и они здесь оба:
//   (1) нога CLV в выводе гейта НЕСЁТ СОСТОЯНИЕ — measured / thin / unverified, назначенное ПОКРЫТИЕМ;
//   (2) скрипт и код обязаны давать одно число на одной выборке — иначе «восстановлено» проверить нечем.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { clvLeg, clvCoverage, closingLine, CLV_MAX_LAG_MIN } from "../src/lib/clv.js";
import { buildOverreactionGate, clvLegText, CLV_COVERAGE_FLOOR_PCT } from "../src/lib/overreactionGate.js";
import { betRecords } from "../src/lib/profileAnalytics.js";

const KO = "2026-07-20T18:00:00.000Z";
const END = "2026-07-20T19:55:00.000Z";
const LABEL = "Over 2.5";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 1000, external_league: "usa.1", created_at: KO });
  R.insertMatch(db, {
    id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true,
    kickoff_at: KO, minute: null, score_home: 3, score_away: 1, final_score: "3:1",
    kickoff_time: null, end_time: END, duration: null, end_note: null, external_ref: "m1",
  });
  return db;
}

/** Снимок котировки — то, из чего clv.ts и берёт линию закрытия. */
function snap(db: ReturnType<typeof seed>, at: string, price: number, label = LABEL) {
  db.prepare(`INSERT INTO markets(id,match_id,label,price,liquidity,snapshot_at) VALUES(?,?,?,?,?,?)`)
    .run(`${label}|${at}`, "m1", label, price, 5000, at);
}

test("линия закрытия — последний снимок ДО конца матча, а не после него", () => {
  const db = seed();
  snap(db, "2026-07-20T19:00:00.000Z", 61);
  snap(db, "2026-07-20T19:50:00.000Z", 74);          // ← это линия закрытия
  snap(db, "2026-07-20T20:30:00.000Z", 99);          // ← после свистка цена уехала к планке разрешения
  const line = closingLine(db, { id: "m1", kickoff_at: KO, end_time: END }, LABEL);
  assert.equal(line!.cents, 74, "снимок ПОСЛЕ конца матча вернул бы исход через чёрный ход");
});

test("CLV = линия закрытия − вход, а НЕ closing_price (там наша же цена выхода)", () => {
  const db = seed();
  snap(db, "2026-07-20T19:50:00.000Z", 74);
  const leg = clvLeg(db, { id: "m1", kickoff_at: KO, end_time: END }, { market_label: LABEL, entry_price: 60 });
  assert.equal(leg.source, "closing_line");
  assert.equal(leg.clvCents, 14);
  assert.equal(leg.closingLineCents, 74);
});

test("протухший снимок — это НЕ линия закрытия, и причина названа отдельно от «снимка нет»", () => {
  const db = seed();
  const lag = CLV_MAX_LAG_MIN() + 30;
  snap(db, new Date(Date.parse(END) - lag * 60_000).toISOString(), 55);
  const stale = clvLeg(db, { id: "m1", kickoff_at: KO, end_time: END }, { market_label: LABEL, entry_price: 60 });
  assert.equal(stale.source, "stale_snapshot");
  assert.equal(stale.clvCents, null, "n/a законен там, где линии физически нет — и он именно n/a, а не 0");

  const none = clvLeg(db, { id: "m1", kickoff_at: KO, end_time: END }, { market_label: "Under 2.5", entry_price: 60 });
  assert.equal(none.source, "no_snapshot", "«снимка нет вовсе» и «снимок протух» — разные дыры, чинятся разным");
});

// ── (1) НОГА ВЕРДИКТА НЕ ПОКАЗЫВАЕТСЯ БЕЗ СОСТОЯНИЯ ──────────────────────────────────────────────

test("нет ни одной линии в когорте → CLV помечен unverified, а не выдан числом", () => {
  const c = { n: 5, won: 3, lost: 2, winPct: 60, pnlUsd: 10, clvCents: null,
    clvState: "unverified" as const, clvCoverage: { total: 5, measured: 0, naNoSnapshot: 5, naStale: 0, naNoClock: 0, pctMeasured: 0 } };
  const t = clvLegText(c);
  assert.match(t, /не измерен/);
  assert.match(t, /ОТСУТСТВУЕТ, а не равна нулю/);
  assert.doesNotMatch(t, /\d¢/, "неизмеренная нога не имеет права выглядеть как число");
});

test("покрытие ниже пола → «намёк», а не нога вердикта; покрытие названо в самой строке", () => {
  const thin = { n: 10, won: 5, lost: 5, winPct: 50, pnlUsd: 0, clvCents: -2.9,
    clvState: "thin" as const, clvCoverage: { total: 10, measured: 3, naNoSnapshot: 7, naStale: 0, naNoClock: 0, pctMeasured: 30 } };
  const t = clvLegText(thin);
  assert.match(t, /ТОНКОМ ПОКРЫТИИ/);
  assert.match(t, /покрытие 30% \(3\/10\)/);
  assert.match(t, new RegExp(`< ${CLV_COVERAGE_FLOOR_PCT}%`));

  const ok = { ...thin, clvState: "measured" as const, clvCoverage: { ...thin.clvCoverage, measured: 9, pctMeasured: 90 } };
  assert.match(clvLegText(ok), /по линии закрытия, покрытие 90%/);
});

test("гейт отдаёт состояние и покрытие ноги CLV, а не голое число", () => {
  const db = seed();
  const g = buildOverreactionGate(db);
  for (const c of [g.settleCohort, g.cashOutCohort]) {
    assert.ok(["measured", "thin", "unverified"].includes(c.clvState));
    assert.ok(c.clvCoverage && typeof c.clvCoverage.total === "number");
  }
  assert.equal(g.settleCohort.clvState, "unverified", "пустая когорта — нога отсутствует, а не нулевая");
});

// ── (2) СКРИПТ И КОД ДАЮТ ОДНО ЧИСЛО НА ОДНОЙ ВЫБОРКЕ ────────────────────────────────────────────

test("покрытие по когорте: сумма причин n/a сходится с total, а доля — с измеренными", () => {
  const legs = [
    clvLeg({} as never, { id: "x" }, { market_label: "L", entry_price: null }),          // no_snapshot (нет входа)
  ];
  const cov = clvCoverage(legs);
  assert.equal(cov.total, 1);
  assert.equal(cov.measured + cov.naNoSnapshot + cov.naStale + cov.naNoClock, cov.total);
});

test("(2) РЕГРЕССИЯ: betRecords (путь кода) и прямой clvLeg (путь скрипта) дают одно число", () => {
  const db = seed();
  snap(db, "2026-07-20T19:50:00.000Z", 74);
  snap(db, "2026-07-20T19:50:00.000Z", 41, "Under 2.5");
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: KO, prompt: "p", prompt_live: null, params: {} });
  for (const [i, [label, entry]] of ([["Over 2.5", 60], ["Under 2.5", 45]] as const).entries()) {
    R.insertBet(db, {
      id: `b${i}`, match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "medium",
      market_label: label, status: "settled_won", proposed_price: entry, entry_price: entry,
      current_price: 100, closing_price: 97, ai_prob: 0.6, stake: 50, rationale: "r",
      entered_minute: "предматч", result: "won", payout: 80, created_at: KO,
    } as never);
  }

  // Путь КОДА: то, что читает гейт и все профильные срезы.
  const recs = betRecords(db, { strategyId: "prematch_value" });
  const byCode = new Map(recs.map((r) => [r.market, r.clvCents]));

  // Путь СКРИПТА: та же линия, снятая напрямую из clv.ts, как это делает clv-coverage.
  const m = { id: "m1", kickoff_at: KO, end_time: END };
  const byScript = new Map([
    ["Over 2.5", clvLeg(db, m, { market_label: "Over 2.5", entry_price: 60 }).clvCents],
    ["Under 2.5", clvLeg(db, m, { market_label: "Under 2.5", entry_price: 45 }).clvCents],
  ]);

  assert.deepEqual([...byCode.entries()].sort(), [...byScript.entries()].sort(),
    "скрипт и код обязаны сходиться — иначе «восстановлено» проверить нечем");
  assert.equal(byCode.get("Over 2.5"), 14);
  assert.equal(byCode.get("Under 2.5"), -4);
  // И оба — НЕ то, что дал бы старый суррогат `closing_price − entry` (97−60=37 и 97−45=52).
  assert.notEqual(byCode.get("Over 2.5"), 37);
  assert.notEqual(byCode.get("Under 2.5"), 52);
});

test("источник ноги доезжает до записи среза — покрытие считается по нему, а не угадывается", () => {
  const db = seed();
  snap(db, "2026-07-20T19:50:00.000Z", 74);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: KO, prompt: "p", prompt_live: null, params: {} });
  R.insertBet(db, {
    id: "b1", match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "medium",
    market_label: LABEL, status: "settled_won", proposed_price: 60, entry_price: 60,
    current_price: 100, closing_price: 97, ai_prob: 0.6, stake: 50, rationale: "r",
    entered_minute: "предматч", result: "won", payout: 80, created_at: KO,
  } as never);
  R.insertBet(db, {
    id: "b2", match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "medium",
    market_label: "BTTS Yes", status: "settled_lost", proposed_price: 55, entry_price: 55,
    current_price: 0, closing_price: 0, ai_prob: 0.6, stake: 50, rationale: "r",
    entered_minute: "предматч", result: "lost", payout: 0, created_at: KO,
  } as never);

  const by = new Map(betRecords(db, { strategyId: "prematch_value" }).map((r) => [r.market, r]));
  assert.equal(by.get(LABEL)!.clvSource, "closing_line");
  assert.equal(by.get(LABEL)!.closingLineCents, 74);
  assert.equal(by.get("BTTS Yes")!.clvSource, "no_snapshot");
  assert.equal(by.get("BTTS Yes")!.clvCents, null, "рынок без снимков не получает суррогат из closing_price");
});
