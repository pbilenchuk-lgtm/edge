// ============================================================
// EDGE LAB — «четвёрка»: четыре находки аудита, повышенные до немедленной починки
//
//   2. gap-wake закрывал ВЕСЬ стейк по частичному филлу — правило T3.3, ратифицированное для основного
//      цикла выходов, во втором исполнении того же правила отсутствовало;
//   3. теннисные выходы выводили сторону позиции заново по фамилии из свежего снапшота вместо закреплённой
//      при входе — тот самый token-flip, из-за которого пришлось карантинить когорту;
//   4. отменённый по VAR гол делал расхождение «фид против табло» постоянным и выключал подавление
//      под-тезисного стопа до конца матча.
//
// (п.1 — машинная причина возврата — живёт в batch11.test.ts рядом со своим сторожем.)
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { evaluateExits } from "../src/lib/lifecycle.js";
import { markGapWake } from "../src/lib/scheduleGap.js";
import { loadPolymarketConfig } from "../src/lib/polymarket.js";
import { pendingGoalSurplus, scoreConsistency } from "../src/lib/scoreRace.js";
import { pinnedFavSide } from "../src/lib/tennisTrading.js";

const iso = (ms: number) => new Date(ms).toISOString();
const poly = loadPolymarketConfig({ POLYMARKET_ENABLED: "true" });

// Живой матч с одной ОТКРЫТОЙ направленной позицией, цена которой рухнула (жёсткий стоп сработает).
// Направленный рынок → не melting-option, не Under → чистый защитный стоп.
function bed(bookSize: string) {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.setShare(db, { competition_id: comp.id, strategy_id: strat.id, pct: 50 });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Celje", away: "Maribor", state: "live", lineup_out: true, kickoff_at: null, minute: 70, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: "Celje", price: 20, ai_prob: 0.5, liquidity: "2000", external_ref: "TOK", snapshot_at: "t", is_closing: false });
  // вход 60¢, стейк $100 → продаём 166.7 акции; книга держит только часть
  R.insertBet(db, { id: "pos", match_id: mid, strategy_id: strat.id, risk_profile_id: "medium", market_label: "Celje", status: "open", proposed_price: 60, entry_price: 60, current_price: 20, closing_price: null, ai_prob: 0.5, stake: 100, rationale: "r", entered_minute: "10'", result: null, payout: null, created_at: "t" });
  const fetchImpl = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book")
    ? { bids: [{ price: "0.20", size: bookSize }], asks: [{ price: "0.22", size: "500" }] }
    : {}) })) as unknown as typeof fetch;
  return { db, mid, fetchImpl };
}

// ── п.2: частичный филл в gap-wake ──────────────────────────────────────────────────────────────
// T3.3 ратифицировала: стоп, который бид принял лишь частично, закрывает ТОЛЬКО исполненную долю. Основной
// цикл выходов так и делает. Этот же sweep — который идёт РАНЬШЕ и владеет ставкой единолично — списывал
// весь стейк по тонкому VWAP. Одно правило, две реализации.
test("четвёрка п.2: gap-wake закрывает только исполненную долю, остаток остаётся открытым", async () => {
  const { db, mid, fetchImpl } = bed("50");   // 50 из 166.7 акций ≈ 30%
  const T = Date.parse("2026-07-22T18:00:00Z");
  markGapWake(db, T, 3480, {});
  await evaluateExits(db, { now: () => iso(T), env: {}, polymarket: poly, fetchImpl });
  assert.ok(R.getOpenGapReprice(db, "pos"), "первый тик — отложка, ещё не исполнение");
  // Окно истекло → безусловное исполнение, но книга по-прежнему держит лишь треть.
  const T2 = T + 10 * 60_000;
  await evaluateExits(db, { now: () => iso(T2), env: {}, polymarket: poly, fetchImpl });
  const bets = R.betsForMatch(db, mid);
  const open = bets.find((b) => b.status === "open");
  const part = bets.filter((b) => b.status.startsWith("settled") && b.settled_by === "partial");
  assert.ok(open, "остаток НЕ списан целиком по тонкому VWAP");
  // Точную долю не пиним: после того как sweep снял отложку, основной цикл в ТОМ ЖЕ тике законно
  // дожимает стоп по остатку (книга в кэше та же — это отдельная, уже учтённая оптимистичность бумажного
  // исполнения). Инвариант здесь один: полного списания по тонкому VWAP больше не происходит.
  assert.ok((open!.stake ?? 0) > 0 && (open!.stake ?? 0) < 100, `часть стейка осталась открытой, получено $${open!.stake}`);
  assert.ok(part.length >= 1, "проведён частичный кусок, а не полное закрытие");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => l.type === "exit" && /частично/.test(l.text)), "выход помечен частичным");
});

// ── п.4: призрак VAR не отключает подавление навсегда ───────────────────────────────────────────
test("четвёрка п.4: излишек гол-событий над табло считается по худшему, а не отключает защиту", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: comp.id, home: "Brann", away: "Vaalerenga", state: "live", lineup_out: true, kickoff_at: null, minute: 40, score_home: 0, score_away: 1, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
  const m = R.getMatch(db, mid)!;
  const T = Date.parse("2026-07-22T18:00:00Z");
  assert.equal(pendingGoalSurplus(scoreConsistency(db, m, T, {})), 0, "фид и табло согласны — излишка нет");
  // Гол в фиде, которого табло ещё (или уже — VAR) не знает.
  R.insertMatchEvent(db, { id: R.uid(), match_id: mid, event_key: "g1", minute: 20, type: "goal", team: "Vaalerenga", text: "гол", created_at: "t" });
  R.insertMatchEvent(db, { id: R.uid(), match_id: mid, event_key: "g2", minute: 41, type: "goal", team: "Vaalerenga", text: "гол", created_at: "t" });
  const c = scoreConsistency(db, m, T, {});
  assert.equal(c.ok, false, "снимок отстаёт от собственного фида — это по-прежнему видно");
  assert.equal(pendingGoalSurplus(c), 1, "один гол, о котором табло не знает, считается как забитый");
  // Спустя дедлайн расхождение становится «forced» и НАВСЕГДА — на этом и ломалось подавление.
  const cLate = scoreConsistency(db, m, T + 4 * 60_000, {});
  assert.equal(cLate.forced, true, "после дедлайна расхождение постоянное (подпись отменённого по VAR гола)");
  assert.equal(pendingGoalSurplus(cLate), 1, "но излишек по-прежнему ИЗМЕРИМ — защиту выключать не требуется");
});

// ── п.3: сторона теннисной позиции берётся из закреплённой при входе ────────────────────────────
// Выходы каждый тик выводили сторону заново — сопоставлением фамилии из ярлыка с p1/p2 ПОСЛЕДНЕГО
// снапшота. Если стороны в снапшоте поменялись местами, стоп читал цену оппонента и исполнялся по чужому
// токену (класс token-flip, из-за которого карантинилась целая когорта). Если сопоставление не удавалось —
// позиция молча оставалась без ведения вообще.
test("четвёрка п.3: сторона позиции — из entry_meta, расхождение с фамилией громкое", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // Улика пишется в trade_log, а у него внешние ключи на матч и стратегию — без реальных строк вставка
  // молча провалилась бы, и тест «доказал» бы отсутствие улики её собственным отсутствием.
  const tcomp = R.listCompetitions(db).find((c) => c.sport_id === "tennis")
    ?? (R.upsertCompetition(db, { id: "tc1", sport_id: "tennis", name: "T", budget: 0, external_league: null, created_at: "t" } as any), R.listCompetitions(db).find((c) => c.sport_id === "tennis")!);
  R.insertMatch(db, { id: "tm1", competition_id: tcomp.id, home: "Mrva", away: "Roncadelli", state: "live", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "tm1" } as any);
  const tstrat = R.listStrategies(db, "tennis").find((x) => x.id === "tennis_overreaction")?.id
    ?? (R.insertStrategy(db, { id: "tennis_overreaction", sport_id: "tennis", name: "Overreaction", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any), "tennis_overreaction");
  const bet = (id: string, meta: any) => ({
    id, match_id: "tm1", strategy_id: tstrat, market_label: "Mrva",
    entry_meta: meta == null ? null : JSON.stringify(meta),
  }) as any;
  const snapStraight = { p1: "Mrva", p2: "Roncadelli" } as any;
  const snapSwapped = { p1: "Roncadelli", p2: "Mrva" } as any;

  assert.equal(pinnedFavSide(db, bet("b1", { favSide: "first" }), snapStraight, "t"), "first");
  // Стороны в снапшоте поменялись местами: вывод по фамилии сказал бы "second" — и стоп ушёл бы
  // по токену оппонента. Ведём по закреплённому.
  assert.equal(pinnedFavSide(db, bet("b2", { favSide: "first" }), snapSwapped, "t"), "first",
    "закреплённое при входе побеждает свежий снапшот");
  assert.ok(R.tradeLogForMatch(db, "tm1").some((l) => /tennis_fav_side_drift/.test(l.text)),
    "расхождение — само по себе улика, оно записано");
  // Ярлык не сопоставился ни с одной стороной: раньше это давало null → continue → позиция без ведения.
  assert.equal(pinnedFavSide(db, bet("b3", { favSide: "second" }), { p1: "Alcaraz", p2: "Sinner" } as any, "t"), "second",
    "закреплённая сторона не зависит от того, узнаём ли мы фамилию в снапшоте");
  // Легаси-ставка без метки — по-прежнему по фамилии, иначе она лишится ведения совсем.
  assert.equal(pinnedFavSide(db, bet("b4", null), snapStraight, "t"), "first");
  assert.equal(pinnedFavSide(db, bet("b5", null), undefined, "t"), null, "ни метки, ни снапшота — стороны нет");
});
