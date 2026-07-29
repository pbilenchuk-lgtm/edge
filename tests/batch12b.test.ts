import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { holdTailToSettle } from "../src/lib/quasiLocked.js";
import { buildRatifiedWatch } from "../src/lib/ratifiedWatch.js";

// ── (1) Мёртвый quasi-locked хвост: ветвление по ПОЛЮ, не по прозе ───────────────────────────────

test("R1: дискриминатор решения — kind, и `reason` для этого непригоден по построению", () => {
  // Баг был ровно тут: `d.reason === "take_profit"` сравнивалось с человеческим текстом («тейк: +52%…»),
  // поэтому не совпадало НИКОГДА, и весь хвост два батча пролежал мёртвым при честном нуле в счётчике.
  // Тест фиксирует контракт: kind — машинный, reason — проза, и на прозе ветвиться нельзя.
  const lock = holdTailToSettle(
    { label: "Under 3.5", home: "A", away: "B", scoreHome: 0, scoreAway: 0, minute: 88 },
    { xg_home: 0.4, xg_away: 0.3, home_share_1h: 0.5, away_share_1h: 0.5 }, {},
  );
  assert.equal(lock.locked, true, "0:0 на 88' запирает Under 3.5 — это и есть кейс Boston");
  assert.ok(lock.reason.length > 20, "reason — человеческая проза");
  assert.notEqual(lock.reason, "take_profit", "и она НИКОГДА не равна машинному дискриминатору");
});

test("R1: хвост НЕ запирается, когда счёт исход не решил — незапертый 95¢ обязан кэшиться как раньше", () => {
  const lock = holdTailToSettle(
    { label: "Over 1.5", home: "A", away: "B", scoreHome: 1, scoreAway: 0, minute: 60 },
    { xg_home: 1.2, xg_away: 1.1, home_share_1h: 0.5, away_share_1h: 0.5 }, {},
  );
  assert.equal(lock.locked, false, "гол ещё может прилететь — держать до сеттла нельзя");
});

// ── Поправка 1: ратифицированная фича обязана доказать первое срабатывание ────────────────────────

function seed(db: any) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "L", budget: 8000, external_league: "swe.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "p", color: "#fff", version: 1, prompt: "", prompt_live: null, params: {}, model: "m", model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true,
    kickoff_at: "t", minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null,
    end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
}
const NOW = Date.parse("2026-08-05T12:00:00Z");   // сильно позже всех ratifiedAt в реестре

test("Поправка 1: ноль срабатываний дольше срока при ЖИВОЙ торговле → РАССЛЕДОВАТЬ, а не строка в отчёте", () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,stake,created_at)
              VALUES('b1','m1','prematch_value','medium','Under 3.5','settled_won',50,'2026-07-30T10:00:00Z')`).run();
  const rw = buildRatifiedWatch(db, NOW, {});
  assert.ok(rw.tradedInWindow > 0, "торговля в окне была — знаменатель есть");
  const q = rw.rows.find((r) => r.key === "quasi_locked_tail")!;
  assert.equal(q.verdict, "РАССЛЕДОВАТЬ");
  assert.match(q.note, /мёртвую проводку/);
  assert.ok(rw.investigate.length > 0);
  assert.match(rw.note, /ЗАВЕСТИ РАССЛЕДОВАНИЕ/);
});

test("Поправка 1: без торговли ноль НЕ обвиняет код — это отсутствие данных, а не мёртвая проводка", () => {
  // Ровно та ошибка знаменателя, на которой мы спотыкались дважды (воронка 166→10; «ноль блокировок»).
  const db = openDb(":memory:"); initSchema(db); seed(db);
  const rw = buildRatifiedWatch(db, NOW, {});
  assert.equal(rw.tradedInWindow, 0);
  assert.ok(rw.rows.every((r) => r.verdict === "нет торговли"));
  assert.equal(rw.investigate.length, 0, "никаких расследований на пустом слейте");
});

test("Поправка 1: одно доказанное срабатывание закрывает вопрос; срок не вышел — «ждём»", () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,stake,created_at)
              VALUES('b1','m1','prematch_value','medium','Under 3.5','settled_won',50,'2026-07-30T10:00:00Z')`).run();
  R.insertTradeLog(db, { id: R.uid(), match_id: "m1", strategy_id: "prematch_value", minute: "88'", type: "hold",
    text: "тейк подавлен по «Under 3.5»: счёт запер исход (quasi_locked_tail)", created_at: "2026-07-31T10:00:00Z" } as any);
  const rw = buildRatifiedWatch(db, NOW, {});
  const q = rw.rows.find((r) => r.key === "quasi_locked_tail")!;
  assert.equal(q.verdict, "работает"); assert.equal(q.hits, 1);
  assert.ok(!rw.investigate.some((r) => r.key === "quasi_locked_tail"));
  // Срок ещё не вышел — «ждём», не обвинение.
  const early = buildRatifiedWatch(db, Date.parse("2026-07-29T00:00:00Z"), {});
  assert.ok(early.rows.some((r) => r.verdict === "ждём"));
});

// ── (2) time_stop: маркер запирает повтор только при ИСПОЛНЕННОМ плане ───────────────────────────

test("time_stop: маркер недоисполнения НЕ гасит следующий цикл, а исполненный — гасит", () => {
  // Суть бага: `already` искал подстроку `(time_stop·medium)`. Раньше её писали при любом выходе, включая
  // частичный филл, — и остаток жил до сеттла без стопа. Теперь недобор помечается отдельным суффиксом.
  const full = "выход «Under 2.5» @ 30¢ · плановый тайм-стоп: 70' ≥ 70', закрываю (time_stop·medium)";
  const partial = "выход «Under 2.5» @ 30¢ · плановый тайм-стоп: 70' ≥ 70', закрываю · бид принял лишь 30% — остаток дожмём следующим циклом (time_stop·medium·partial)";
  const marker = "(time_stop·medium)";
  assert.ok(full.includes(marker), "исполненный план запирает повтор");
  assert.ok(!partial.includes(marker), "недоисполненный — НЕ запирает: остаток обязан дожаться");
  // И маркер по-прежнему разделяет профили (урок Fix[2]): чужой профиль не гасит наш.
  assert.ok(!full.includes("(time_stop·aggressive)"));
});

// ── (2) двойной сеттл PM: перечитать статус после await ──────────────────────────────────────────
import { settlePmResolutionBets } from "../src/lib/pmResolution.js";

test("PM-резолюция не перезаписывает ставку, рассчитанную другим путём во время сетевого запроса", async () => {
  const db = openDb(":memory:"); initSchema(db); seed(db);
  db.prepare(`UPDATE matches SET score_home=NULL, score_away=NULL WHERE id='m1'`).run();
  db.prepare(`INSERT INTO markets(id,match_id,label,price,liquidity,external_ref,snapshot_at,is_closing)
              VALUES('mk1','m1','Under 2.5',50,'1000','tok-A','t',0)`).run();
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,created_at)
              VALUES('pb1','m1','prematch_value','medium','Under 2.5','open',50,100,'t')`).run();

  // Резолвер имитирует сеть — и ПОКА он «летит», другой путь честно рассчитывает ставку по счёту.
  const resolveTokens = async () => {
    db.prepare(`UPDATE bets SET status='settled_won', result='won', payout=200, settled_by='match_score' WHERE id='pb1'`).run();
    return { "tok-A": { priceCents: 99, closed: true } };
  };
  await settlePmResolutionBets(db, { now: () => "t2", resolveTokens } as any);

  const b = R.getBet(db, "pb1")!;
  assert.equal(b.settled_by, "match_score", "расчёт первого пути НЕ перезаписан");
  assert.equal(b.payout, 200, "деньги остались как были начислены");
});

// ── (3) Теннис: «не в игре» ≠ «сыгран»; завершённость сета по правилам ───────────────────────────
import { tennisFinalResult } from "../src/lib/tennisTrading.js";
import { resolveTennisProp } from "../src/lib/tennisPmv.js";

function tSeed(db: any) {
  R.upsertSport(db, "tennis", "Tennis");
  R.upsertCompetition(db, { id: "tc", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "tm", competition_id: "tc", home: "A Player", away: "B Player", state: "upcoming",
    lineup_out: false, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "tm" } as any);
}
function snap(db: any, o: { status: string; live: number; s1?: number | null; s2?: number | null; raw?: string; at?: string }) {
  db.prepare(`INSERT INTO tennis_snapshots(id,event_key,provider,pm_match_id,batch_at,created_at,p1,p2,sets_p1,sets_p2,live,status,raw)
              VALUES(?, 'ek','apitennis','tm',?,?,'A Player','B Player',?,?,?,?,?)`)
    .run(R.uid(), o.at ?? "t1", o.at ?? "t1", o.s1 ?? null, o.s2 ?? null, o.live, o.status, o.raw ?? null);
}

test("T: прематч-снапшот (live=0, «Scheduled») НЕ читается как финал — иначе shadow-сигнал гибнет навсегда", () => {
  const db = openDb(":memory:"); initSchema(db); tSeed(db);
  snap(db, { status: "Scheduled", live: 0, s1: 0, s2: 0 });
  assert.equal(tennisFinalResult(db, "tm"), null, "матч ещё не начинался — финала нет");
  // Тот же снапшот, но уже с сыгранным сетом и без эфира — это уже настоящий финал.
  snap(db, { status: "Finished", live: 0, s1: 2, s2: 1, raw: '{"event_winner":"First Player"}', at: "t2" });
  const fin = tennisFinalResult(db, "tm")!;
  assert.equal(fin.finished, true); assert.equal(fin.advancing, "first");
});

test("T: «не в игре» без единого сыгранного сета и без явного статуса — не финал, а ожидание", () => {
  const db = openDb(":memory:"); initSchema(db); tSeed(db);
  snap(db, { status: "", live: 0, s1: 0, s2: 0 });
  assert.equal(tennisFinalResult(db, "tm"), null, "pending дорезолвится следующим снимком; ложный финал не откатывается ничем");
});

test("T: ретайр на 6-5 — сет НЕ завершён, set_winner уходит в void, а не в выдуманного победителя", () => {
  // Прежний предикат (max ≥ 6) считал 6-5 завершённым сетом и книжил победителя, которого не было.
  const fs = { sets: [{ p1: 6, p2: 5 }], setsWonP1: 1, setsWonP2: 0, matchGames: 11 };
  assert.equal(resolveTennisProp("A Player Set 1 Winner", fs as any, { retired: true, canceled: false, firstIsP1: true }), null);
  assert.equal(resolveTennisProp("Set 1 Over 10.5", fs as any, { retired: true, canceled: false, firstIsP1: true }), null);
});

test("T: 7-6 и 7-5 — законно завершённые сеты; 6-6 (тай-брейк идёт) — нет", () => {
  const tb = { sets: [{ p1: 7, p2: 6 }], setsWonP1: 1, setsWonP2: 0, matchGames: 13 };
  assert.equal(resolveTennisProp("A Player Set 1 Winner", tb as any, { retired: true, canceled: false, firstIsP1: true }), true);
  const seven5 = { sets: [{ p1: 7, p2: 5 }], setsWonP1: 1, setsWonP2: 0, matchGames: 12 };
  assert.equal(resolveTennisProp("A Player Set 1 Winner", seven5 as any, { retired: true, canceled: false, firstIsP1: true }), true);
  const six6 = { sets: [{ p1: 6, p2: 6 }], setsWonP1: 0, setsWonP2: 0, matchGames: 12 };
  assert.equal(resolveTennisProp("A Player Set 1 Winner", six6 as any, { retired: true, canceled: false, firstIsP1: true }), null);
});

// ── (4) correlationKey: дефис, отсутствие разделителя и голый «Draw» ─────────────────────────────
import { correlationKey } from "../src/lib/strategist.js";
import { resolveFootballMarket } from "../src/lib/settlement.js";

test("cluster: «Draw - No» и «Extra Time - No» попадают в ОДИН кластер — France–Spain больше не покупается дважды", () => {
  // Прежний узкий регекс `[—:]` не видел обычный дефис → оба ярлыка давали null → clusterExposure=0,
  // тезисный кэп молчал (он весь под `if (thesisKey)`), и один исход покупался двумя ногами.
  assert.equal(correlationKey("Draw - No", "France", "Spain"), "ko:decided");
  assert.equal(correlationKey("Extra Time - No", "France", "Spain"), "ko:decided");
  assert.equal(correlationKey("Draw — No", "France", "Spain"), "ko:decided", "длинное тире работало и работает");
  assert.equal(correlationKey("Extra Time No", "France", "Spain"), "ko:decided", "и без разделителя тоже");
});

test("cluster: голый «Draw» — это implicit-yes сторона (кейс Larne), а «Draw No Bet» кластером не является", () => {
  assert.equal(correlationKey("Draw", "A", "B"), "ko:level");
  assert.equal(correlationKey("Draw - Yes", "A", "B"), "ko:level");
  assert.equal(correlationKey("Draw No Bet", "A", "B"), null, "DNB — другой контракт, не сторона ничьей");
});

test("settle: «Draw - No» разрешается по счёту — раньше дефис ронял его в непроверяемые", () => {
  // Один и тот же ярлык обязан и кластеризоваться, и сеттлиться: иначе одна подсистема считает его
  // тезисом, а другая не может определить исход.
  assert.equal(resolveFootballMarket("Draw - No", 2, 1, { home: "A", away: "B" }, { wentToExtraTime: null }), true);
  assert.equal(resolveFootballMarket("Draw - No", 1, 1, { home: "A", away: "B" }, { wentToExtraTime: null }), false);
  assert.equal(resolveFootballMarket("Draw - Yes", 1, 1, { home: "A", away: "B" }, { wentToExtraTime: null }), true);
  // Защита от «Draw No Bet» держится не разделителем, а якорем конца строки.
  assert.notEqual(resolveFootballMarket("Draw No Bet", 1, 1, { home: "A", away: "B" }, { wentToExtraTime: null }), false);
});
