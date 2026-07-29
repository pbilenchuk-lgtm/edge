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

// ── пункт 6: адрес выхода и развилка n/a ────────────────────────────────────────────────────────
import { betRecords } from "../src/lib/profileAnalytics.js";
import { signalCohort } from "../src/lib/signals.js";

// Выходы сопоставлялись со ставкой по (стратегия + подстрока ярлыка). Два профиля одной стратегии держат
// ОДИН И ТОТ ЖЕ рынок и пишут неразличимые строки — каждая из двух ставок забирала ОБА выхода: удвоенный
// triggerMix, чужая метка model_fill, а через неё обнулённый bookPnl у чистой ставки.
test("пункт 6: выход адресуется по СТАВКЕ, а не по (стратегия + ярлык)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.insertMatch(db, { id: "mx", competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-07-20T18:00:00Z", minute: 90, score_home: 2, score_away: 0, final_score: "2:0", kickoff_time: null, end_time: "2026-07-20T19:50:00Z", duration: null, end_note: null, external_ref: "mx" } as any);
  const mkBet = (id: string, profile: string) => R.insertBet(db, { id, match_id: "mx", strategy_id: strat.id, risk_profile_id: profile, market_label: "Over 1.5", status: "settled_won", proposed_price: 40, entry_price: 40, current_price: 70, closing_price: 70, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "предматч", result: "won", payout: 175, settled_by: "early", settled_at: "2026-07-20T19:00:00Z", entry_meta: JSON.stringify({ phase: "prematch" }), created_at: "t" } as any);
  mkBet("bm", "medium"); mkBet("ba", "aggressive");
  // Два выхода — по одному на ставку. Строки различимы ТОЛЬКО адресом: текст одинаковый.
  const exit = (id: string, betId: string, tail: string) => R.insertTradeLog(db, { id, match_id: "mx", strategy_id: strat.id, minute: "70'", type: "exit", text: `выход «Over 1.5» @ 70¢ · тейк${tail} · P&L +$75.00`, bet_id: betId, created_at: "2026-07-20T19:00:00Z" } as any);
  exit("e1", "bm", "");
  exit("e2", "ba", " [model_fill]");
  const recs = betRecords(db);
  const med = recs.find((r) => r.id === "bm")!, agg = recs.find((r) => r.id === "ba")!;
  assert.equal(med.exits.length, 1, "medium забирает ровно СВОЙ выход");
  assert.equal(agg.exits.length, 1, "aggressive — свой");
  assert.equal(med.exits[0].modelFill, false, "чужая метка model_fill не прилипает");
  assert.equal(agg.exits[0].modelFill, true);
  assert.equal(med.bookPnl, 75, "чистая ставка сохраняет свой P&L в вердикте");
  assert.equal(agg.bookPnl, null, "модельный филл по-прежнему выводит СВОЮ ставку из вердикта");
  assert.equal(med.exitsAmbiguous, false);
});

// Легаси-строка без адреса при нескольких кандидатах — жребий. Привязываем по-старому и ПОМЕЧАЕМ, но денег
// это не портит: P&L ставки берётся из её собственного payout и от выбора строки не зависит. Привязка важна
// только для решения «был ли выход модельным», а оно уже считается консервативно по ВСЕМ кандидатам. Флаг
// нужен выходным срезам (triggerMix, тайминг), где привязка действительно решает.
test("пункт 6: легаси-выход без bet_id при двух кандидатах помечен неоднозначным", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.insertMatch(db, { id: "my", competition_id: comp.id, home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-07-20T18:00:00Z", minute: 90, score_home: 2, score_away: 0, final_score: "2:0", kickoff_time: null, end_time: "2026-07-20T19:50:00Z", duration: null, end_note: null, external_ref: "my" } as any);
  const mkBet = (id: string, profile: string) => R.insertBet(db, { id, match_id: "my", strategy_id: strat.id, risk_profile_id: profile, market_label: "Over 1.5", status: "settled_won", proposed_price: 40, entry_price: 40, current_price: 70, closing_price: 70, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "предматч", result: "won", payout: 175, settled_by: "early", settled_at: "2026-07-20T19:00:00Z", entry_meta: JSON.stringify({ phase: "prematch" }), created_at: "t" } as any);
  mkBet("cm", "medium"); mkBet("ca", "aggressive");
  R.insertTradeLog(db, { id: "eo", match_id: "my", strategy_id: strat.id, minute: "70'", type: "exit", text: `выход «Over 1.5» @ 70¢ · тейк · P&L +$75.00`, created_at: "2026-07-20T19:00:00Z" } as any);
  const recs = betRecords(db);
  assert.ok(recs.every((r) => r.exitsAmbiguous), "обе ставки честно помечены: чей это выход — неизвестно");
  assert.ok(recs.every((r) => r.bookPnl === 75), "но P&L ставки от выбора строки не зависит — деньги остаются в вердикте");
  // Стоит среди кандидатов появиться модельному филлу — и обе ставки выходят из вердикта: чья это была
  // строка, мы не знаем, поэтому консервативно выводим обе.
  R.insertTradeLog(db, { id: "eo2", match_id: "my", strategy_id: strat.id, minute: "72'", type: "exit", text: `выход «Over 1.5» @ 70¢ · тейк [model_fill] · P&L +$75.00`, created_at: "2026-07-20T19:02:00Z" } as any);
  assert.ok(betRecords(db).every((r) => r.bookPnl === null), "модельный филл среди кандидатов выводит обе ставки");
});

// Развилка n/a: ДВУНОГИЙ вердикт законен ровно тогда, когда линии закрытия нет в данных НИ У ОДНОЙ записи.
// Одна найденная линия — и нога снова третья: тонкая выборка делает её незначимой, а не отсутствующей.
test("пункт 6: нога CLV n/a только при НУЛЕВОМ покрытии; иначе она считается как есть", () => {
  const base = {
    matchLabel: "A — B", competitionId: "c", category: "EPL", strategy: "PMV", profileId: "medium",
    minute: null, scoreHome: null, scoreAway: null, edge: null, aiProb: null, derivedProb: null,
    marketPrice: null, liveProbAdjusted: null, entryCents: 50, closingCents: null, kelly: null,
    sizeRequested: null, sizeFilled: null, entrySlipCents: null, calibration: null, branchWeightSum: null,
    thinnessUsd: null, winsOnEvent: false, codeVersion: "e9", status: "settled_won", settledBy: "settle",
    payout: null, finalScore: null, decisionId: null, exitCodeVersion: null, exits: [],
    closingLineCents: null, exitsAmbiguous: false,
  };
  const rec = (i: number, clv: number | null) => ({
    ...base, id: `r${i}`, matchId: `m${i}`, strategyId: "prematch_value", market: "Over 2.5",
    phase: "prematch" as const, impliedProb: 0.5, outcome: (i % 3 ? "won" : "lost") as "won" | "lost",
    stake: 100, pnl: i % 3 ? 60 : -100, bookPnl: i % 3 ? 60 : -100,
    clvCents: clv, clvSource: (clv == null ? "no_snapshot" : "closing_line") as any,
    createdAt: `2026-07-${String(i % 27 + 1).padStart(2, "0")}T12:00:00Z`, kickoffAt: `2026-07-${String(i % 27 + 1).padStart(2, "0")}T18:00:00Z`,
  });
  const na = signalCohort(Array.from({ length: 30 }, (_, i) => rec(i, null)));
  assert.equal(na.clvLegNa, true, "линии нет ни у одной записи → нога n/a");
  assert.equal(na.clvCoverage.withLine, 0);
  assert.match(na.note, /ДВУНОГИЙ/, "и вердикт честно назван двуногим");
  assert.match(na.note, /не смягчение порога/, "с прямой оговоркой, что порог не смягчается");

  const some = signalCohort(Array.from({ length: 30 }, (_, i) => rec(i, i === 0 ? 4 : null)));
  assert.equal(some.clvLegNa, false, "одна линия есть → n/a незаконен, нога остаётся третьей");
  assert.equal(some.clvCoverage.withLine, 1);
  assert.equal(some.clv.significant, false, "на одной точке нога просто незначима — это НЕ отсутствие ноги");
  assert.ok(!some.tripleAgreement, "и тройного согласия нет");
});

// ── Поправки по факту первого прода ─────────────────────────────────────────────────────────────
import { buildRatifiedWatch } from "../src/lib/ratifiedWatch.js";
import { initSchema } from "../src/lib/db.js";

// Сторож ратифицированных фич искал улику ТОЛЬКО в trade_log — и на первом же проде выдал ложную тревогу
// «dust_floor мёртв» при двух реальных срабатываниях: dust_floor пишет причину в `bets.rationale`.
// Сторож, построенный против мёртвой проводки, сам оказался разведён мимо.
test("прод-поправка: улика ищется там, где её пишут — dust_floor живёт в rationale, а не в trade_log", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 100, external_league: "nor.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-07-27T18:00:00Z", minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: "2026-07-27T19:50:00Z", duration: null, end_note: null, external_ref: "m1" } as any);
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,payout,settled_at,rationale,created_at)
              VALUES ('b1','m1','prematch_value','medium','Over 1.5','settled_won',50,100,180,'2026-07-28T00:00:00Z','вход · dust_floor: остаток $2 < $5 — закрыто целиком','2026-07-27T00:00:00Z')`).run();
  const rw = buildRatifiedWatch(db, Date.parse("2026-07-30T00:00:00Z"), {});
  const dust = rw.rows.find((r) => r.key === "dust_floor")!;
  assert.equal(dust.hits, 1, "срабатывание найдено в rationale");
  assert.equal(dust.verdict, "работает", "и ложной тревоги больше нет");
  assert.ok(!rw.investigate.some((r) => r.key === "dust_floor"));
});

// ── Прод-разбор 29.07: мёртвые книги и молчаливый отказ на филле ─────────────────────────────────
import { refreshMatchOdds } from "../src/lib/engine.js";
import { autoEnter } from "../src/lib/lifecycle.js";

// Импорт отказывался заводить рынок с ценой у планки («effectively-resolved / dead line»), а рефреш писал
// такие цены снапшот за снапшотом: разрешившийся матч продолжал светиться «живой» котировкой 99.6¢ и кормил
// расчёт эджа мёртвой ценой. Зомби-карантин это не ловит: ≥98¢ у него в ИСКЛЮЧЕНИИ правила протухания.
test("прод-поправка: рефреш не записывает цену у планки — один порог с импортом", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football")!;
  R.insertMatch(db, { id: "mr", competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "2026-07-29T15:00:00Z", minute: 80, score_home: 2, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "mr" } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "mr", label: "Over 0.5", price: 70, ai_prob: 0.8, liquidity: "900", external_ref: "TOKA", token_second: null, snapshot_at: "t0", is_closing: false } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "mr", label: "Under 0.5", price: 30, ai_prob: 0.2, liquidity: "900", external_ref: "TOKB", token_second: null, snapshot_at: "t0", is_closing: false } as any);
  // Книга разрешилась: одна сторона 99.6¢, другая 0.4¢; третья двинулась нормально.
  const fetchImpl = (async (url: any) => {
    const u = String(url);
    const px = u.includes("TOKA") ? "0.996" : u.includes("TOKB") ? "0.004" : "0.5";
    return { ok: true, status: 200, json: async () => ({ mid: px }) };
  }) as unknown as typeof fetch;
  const r = await refreshMatchOdds(db, "mr", { fetchImpl, polymarket: loadPolymarketConfig({ POLYMARKET_ENABLED: "true" }), now: () => "2026-07-29T16:00:00Z" });
  assert.equal(r.updated, 0, "ни одна цена у планки не записана");
  assert.equal(r.railSkipped, 2, "и обе отклонённые ПОСЧИТАНЫ, а не проглочены");
  const last = R.latestMarkets(db, "mr");
  assert.equal(last.find((m) => m.label === "Over 0.5")!.price, 70, "в книге осталась последняя живая цена");
});

// Единственный гейт входа, не оставлявший следа: причина писалась только в `bets.rationale`, а когда
// исполнитель не дал текста — и там пусто. На проде это дало 80 ставок «not_filled: без_метки».
test("прод-поправка: отказ на филле пишет машинную строку, а не пустоту", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  db.exec("DELETE FROM bets");
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  const strat = R.listStrategies(db, "football")[0];
  R.insertMatch(db, { id: "mf", competition_id: comp.id, home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "2026-07-29T15:00:00Z", minute: 40, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "mf" } as any);
  R.upsertMatchLive(db, { match_id: "mf", espn_event_id: "e", league: "l", home_lineup: null, away_lineup: null, stats: null, updated_at: "t" } as any);
  // Книга уехала от цены решения дальше допуска (ENTRY_PHANTOM_DIVERGENCE=25¢): исполнитель откажет
  // терминально — и раньше об этом не узнавал никто. Цена НЕ у планки, иначе сработает карантин выше.
  R.insertMarket(db, { id: R.uid(), match_id: "mf", label: "Over 0.5", price: 80, ai_prob: 0.9, liquidity: "900", external_ref: "TOK", token_second: null, snapshot_at: "t", is_closing: false } as any);
  R.insertBet(db, { id: "bf", match_id: "mf", strategy_id: strat.id, risk_profile_id: "medium", market_label: "Over 0.5", status: "proposed", proposed_price: 40, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.9, stake: 40, rationale: null, entered_minute: null, result: null, payout: null, entry_meta: JSON.stringify({ phase: "live" }), created_at: "t" } as any);
  const fetchImpl = (async (url: any) => ({ ok: true, status: 200, json: async () => (String(url).includes("/book")
    ? { bids: [{ price: "0.79", size: "500" }], asks: [{ price: "0.80", size: "500" }] } : {}) })) as unknown as typeof fetch;
  await autoEnter(db, { now: () => "2026-07-29T15:40:00Z", env: {}, polymarket: loadPolymarketConfig({ POLYMARKET_ENABLED: "true" }), fetchImpl });
  const b = R.getBet(db, "bf")!;
  assert.equal(b.status, "not_filled");
  assert.match(String(b.rationale), /entry_fill_reject:/, "причина есть и она названа");
  const line = R.tradeLogForMatch(db, "mf").find((l) => /entry_fill_reject/.test(l.text));
  assert.ok(line, "и она попала в ЖУРНАЛ, где её ищут");
  assert.equal((line as any).bet_id, "bf", "адресована конкретной ставке");
});

// ── Планочная цена на несыгранном матче — не котировка ───────────────────────────────────────────
import { classifyZombie, loadZombieConfig, isRailPrice } from "../src/lib/zombieMarket.js";
import { runStrategists } from "../src/lib/analysis.js";

test("прод-поправка: планка на несыгранном матче — карантин; на завершённом — законная цена", () => {
  const cfg = loadZombieConfig({});
  const base = { label: "Over 2.5", gsProb: null, groupSpreadCents: null, bookAgeMin: 1, live: true, askCents: null };
  assert.equal(classifyZombie({ ...base, priceCents: 100, matchFinished: false }, cfg)?.code, "rail_price");
  assert.equal(classifyZombie({ ...base, priceCents: 0.1, matchFinished: false }, cfg)?.code, "rail_price");
  assert.equal(classifyZombie({ ...base, priceCents: 100, matchFinished: true }, cfg), null,
    "на завершённом матче планка — честная цена разрешения, прятать нечего");
  assert.equal(classifyZombie({ ...base, priceCents: 55, matchFinished: false }, cfg), null, "живая цена не трогается");
  // Раньше ИМЕННО эти цены освобождались от единственного правила, которое могло их поймать.
  assert.equal(isRailPrice(99.5, cfg), true);
  assert.equal(isRailPrice(97, cfg), false);
});

// Карантин зомби работает только для live-футбола, поэтому в ПРЕДМАТЧЕ отравленная книга доезжала до
// стратега целиком — и он отказывался торговать её всю («котировки нерепрезентативны», picks: []).
test("прод-поправка: планочные рынки не показываются стратегу в предматче, и это ПОСЧИТАНО", async () => {
  const db = openDb(":memory:"); seedDatabase(db);
  const comp = R.listCompetitions(db).find((c) => c.sport_id === "football" && c.budget > 0)!;
  R.insertMatch(db, { id: "mz", competition_id: comp.id, home: "A", away: "B", state: "upcoming", lineup_out: true, kickoff_at: "2026-07-30T18:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "mz" } as any);
  const mk = (label: string, price: number) => R.insertMarket(db, { id: R.uid(), match_id: "mz", label, price, ai_prob: 0.5, liquidity: "900", external_ref: label, token_second: null, snapshot_at: "t", is_closing: false } as any);
  mk("Over 2.5", 100); mk("Under 2.5", 0.1); mk("Draw — Yes", 0.5); mk("Both Teams to Score — Yes", 48);
  R.upsertAssessment(db, { id: R.uid(), match_id: "mz", stage: "post_lineup", status: "ok", short: "s", verdict: "v", confidence: "средняя", body: "{}", model: "m", created_at: "t" } as any);
  // Стратег не вызывается: без ИИ-ключа runStrategists выйдет раньше — нам важна САМА фильтрация и её улика.
  await runStrategists(db, "mz", { now: () => "2026-07-29T12:00:00Z", env: {} });
  const line = R.tradeLogForMatch(db, "mz").find((l) => /rail_price/.test(l.text));
  assert.ok(line, "скрытие рынков записано, а не сделано молча");
  assert.match(String(line!.text), /3 из 4/, "скрыты ровно планочные, живой рынок остался");
});
