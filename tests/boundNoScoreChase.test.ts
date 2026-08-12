// ============================================================
// EDGE LAB — ДОЖАТИЕ `bound_no_score`: ТЕСТЫ НА ТРИ УСЛОВИЯ РАТИФИКАЦИИ
//
// Проверяется не «функция вернула объект», а ровно то, что было обещано:
//   (а) хранимая привязка НЕ пропуск — её перепроверяют сегодняшние гейты, и не прошедшая их привязка
//       счёта не даёт, каким бы правдоподобным он ни выглядел;
//   (б) счёт, спорящий с состоявшимся сеттлом, НЕ пишется вовсе, а группа целиком уходит в карантин;
//   (в) каждый отказ несёт КОД из закрытого списка, а не пустоту.
// Плюс главный денежный инвариант: проход не двигает книгу — измеренно, а не обещанием.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { seedRiskProfiles } from "../src/lib/riskConfig.js";
import { chaseBoundNoScore, verifyStoredBind, chaseLine, boundNoScoreCandidates } from "../src/lib/boundNoScoreChase.js";
import type { SportsProvider, SportsMatchStatus } from "../src/lib/sports.js";

const KICK = "2026-07-23T02:30:00Z";
const CREATED = "2026-07-22T00:00:00Z";
const GAP = 30 * 3_600_000;

function world() {
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, CREATED);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 1000, external_league: "usa.1", created_at: CREATED });
  R.insertStrategy(db, { id: "pv", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: CREATED, prompt: "p", prompt_live: null, params: {} } as never);
  return db;
}

/** Привязанный завершённый матч БЕЗ счёта — ровно население класса. */
function boundNoScoreMatch(db: ReturnType<typeof world>, id: string, home: string, away: string, eventId: string) {
  R.insertMatch(db, {
    id, competition_id: "c1", home, away, state: "finished", lineup_out: true, kickoff_at: KICK,
    minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id,
  } as never);
  R.upsertMatchLive(db, { match_id: id, espn_event_id: eventId, league: "usa.1", espn_event_date: KICK, home_lineup: null, away_lineup: null, stats: null, updated_at: CREATED });
}

function settledBet(db: ReturnType<typeof world>, id: string, mid: string, label: string, result: "won" | "lost", payout: number) {
  R.insertBet(db, {
    id, match_id: mid, strategy_id: "pv", risk_profile_id: "medium", market_label: label,
    status: result === "won" ? "settled_won" : "settled_lost",
    proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null,
    ai_prob: 0.6, stake: 10, rationale: "r", entered_minute: "предматч", result, payout, created_at: CREATED,
  } as never);
}

const ev = (o: Partial<SportsMatchStatus>): SportsMatchStatus => ({
  externalRef: "e1", home: "Inter Miami CF", away: "FC Cincinnati", state: "finished",
  minute: 90, scoreHome: 2, scoreAway: 1, final: true, date: KICK, ...o,
});

/** Провайдер, отдающий событие ТОЛЬКО по id — доска намеренно пуста: матчам десять дней, на ней их нет. */
function provider(byId: Record<string, SportsMatchStatus | null>): SportsProvider {
  return {
    name: "stub",
    async scoreboard() { return []; },
    async eventStatus(_sport: string, _league: string, eventId: string) { return byId[eventId] ?? null; },
  };
}

// ── НАСТОЯЩАЯ ПРИЧИНА КЛАССА, найденная первым прогоном на проде: счёт по сторонам В БАЗЕ ЕСТЬ, а строки
// `final_score` нет. Провайдер здесь не нужен вовсе, и спрашивать его о том, что уже лежит рядом, — лишний
// поход наружу. Плюс первая версия предиката кандидатов требовала `score_home IS NULL`, из-за чего проход
// видел НОЛЬ там, где архив видел ТРИ: отчёт и конвейер разошлись в том, кого они считают.
test("ПРИЧИНА КЛАССА: счёт уже в базе, нет только строки — чиним локально, наружу не ходим", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Portland Timbers", "FC Dallas", "e1");
  R.updateMatch(db, "m1", { score_home: 2, score_away: 1 });   // как на проде: стороны есть, final_score пуст
  assert.equal(boundNoScoreCandidates(db).length, 1, "предикат обязан совпадать с архивом, а не быть уже");

  let asked = 0;
  const p: SportsProvider = { name: "stub", async scoreboard() { return []; }, async eventStatus() { asked++; return ev({}); } };
  const r = await chaseBoundNoScore(db, p, {});
  assert.equal(asked, 0, "локальный ремонт не имеет права ходить к провайдеру");
  assert.equal(r.rows[0].verdict, "local_repair");
  assert.equal(R.getMatch(db, "m1")!.final_score, "2:1");
  assert.equal(r.filled, 1);
  assert.equal(boundNoScoreCandidates(db).length, 0);
});

test("локальный ремонт ТОЖЕ проходит сверку с сеттлами — путь другой, условие (б) то же", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Portland Timbers", "FC Dallas", "e1");
  R.updateMatch(db, "m1", { score_home: 2, score_away: 1 });
  settledBet(db, "b1", "m1", "Portland Timbers", "lost", 0);   // 2:1 говорит обратное
  const r = await chaseBoundNoScore(db, null, {});
  assert.equal(r.rows[0].verdict, "contradicts_settled");
  assert.equal(r.filled, 0);
  assert.equal(R.getMatch(db, "m1")!.final_score, null);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM bets WHERE settle_suspect=1`).get() as any).n, 1);
});

test("пустая строка final_score считается отсутствием счёта — как её и читает архив", () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Portland Timbers", "FC Dallas", "e1");
  R.updateMatch(db, "m1", { final_score: "" });
  assert.equal(boundNoScoreCandidates(db).length, 1);
});

test("(а) счёт дожимается, когда хранимая привязка ПРОХОДИТ сегодняшние гейты", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  assert.equal(boundNoScoreCandidates(db).length, 1);
  const r = await chaseBoundNoScore(db, provider({ e1: ev({}) }), { now: () => "2026-08-02T18:00:00Z" });
  assert.equal(r.filled, 1);
  assert.equal(r.rows[0].verdict, "filled");
  const m = R.getMatch(db, "m1")!;
  assert.equal(m.final_score, "2:1");
  assert.equal(m.score_home, 2);
  // Класс закрыт: матч больше не в населении.
  assert.equal(boundNoScoreCandidates(db).length, 0);
});

test("(а) ориентация ЗЕРКАЛЬНАЯ — счёт кладётся на правильную сторону, не как у провайдера", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "FC Cincinnati", "Inter Miami CF", "e1"); // наш home — их away
  const r = await chaseBoundNoScore(db, provider({ e1: ev({}) }), {});
  assert.equal(r.filled, 1);
  assert.equal(R.getMatch(db, "m1")!.final_score, "1:2");
});

test("(а) привязка, НЕ проходящая date-гейт сегодня, счёта не даёт", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  // Событие на неделю в стороне — ровно тот «чужой круг», ради которого date-гейт и заводили.
  const r = await chaseBoundNoScore(db, provider({ e1: ev({ date: "2026-07-30T02:30:00Z" }) }), {});
  assert.equal(r.filled, 0);
  assert.equal(r.rows[0].verdict, "bind_date_gap");
  assert.equal(R.getMatch(db, "m1")!.final_score, null);   // счёт НЕ записан
});

test("(а) привязка без даты события НЕ подтверждаема — послаблений живого enrich здесь нет", () => {
  const v = verifyStoredBind(
    { home: "Inter Miami CF", away: "FC Cincinnati", kickoff_at: KICK },
    ev({ date: null }), GAP,
  );
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.verdict, "bind_no_date");
});

test("(а) имена, которые сегодня не сходятся, отвергают привязку", () => {
  const v = verifyStoredBind({ home: "Rakow Czestochowa", away: "Maccabi Haifa", kickoff_at: KICK }, ev({}), GAP);
  assert.equal(v.ok === false && v.verdict, "bind_team_mismatch");
});

test("(б) счёт, спорящий с состоявшимся сеттлом, НЕ пишется — группа целиком в карантин", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  // Ставка на победу Майами закрыта как ПРОИГРАВШАЯ. Добранный счёт 2:1 говорит обратное.
  settledBet(db, "b1", "m1", "Inter Miami CF", "lost", 0);
  settledBet(db, "b2", "m1", "Over 1.5", "won", 20);
  const before = db.prepare(`SELECT COALESCE(SUM(payout),0) p, COALESCE(SUM(stake),0) s FROM bets`).get() as any;

  const r = await chaseBoundNoScore(db, provider({ e1: ev({}) }), {});
  assert.equal(r.filled, 0);
  assert.equal(r.quarantined, 1);
  assert.equal(r.rows[0].verdict, "contradicts_settled");
  assert.ok(r.rows[0].contradictions.length >= 1);
  // Счёт НЕ записан: перезаписывать состоявшийся сеттл молча — запрещено.
  assert.equal(R.getMatch(db, "m1")!.final_score, null);
  // В карантин — ВСЯ группа, а не только спорная ставка.
  assert.equal(r.quarantinedBets, 2);
  const flagged = db.prepare(`SELECT COUNT(*) n FROM bets WHERE settle_suspect=1`).get() as any;
  assert.equal(flagged.n, 2);
  // Книга не сдвинулась ни на цент.
  const after = db.prepare(`SELECT COALESCE(SUM(payout),0) p, COALESCE(SUM(stake),0) s FROM bets`).get() as any;
  assert.equal(after.p, before.p);
  assert.equal(after.s, before.s);
  assert.equal(r.bookDeltaUsd, 0);
});

// ── [T8(б)] ИДЕМПОТЕНТНОСТЬ ПРОХОДА — ПРИБОРОМ, А НЕ РАССУЖДЕНИЕМ.
//
// «Повтор безопасен» держалось на аргументе «дожатый матч перестаёт быть кандидатом». Для дожатых —
// правда. Для КАРАНТИННЫХ — нет: счёт там не пишется НАМЕРЕННО, значит матч остаётся кандидатом всегда,
// и каждый следующий проход снова печатал «в карантин 1 матч / 2 ставки» — число, неотличимое от нового
// инцидента. Тест гоняет проход ДВАЖДЫ по одной базе и требует, чтобы второй прогон не записал НИЧЕГО.
test("[T8(б)] карантинный матч остаётся кандидатом навсегда — но повтор не пишет ничего и говорит это числом", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  settledBet(db, "b1", "m1", "Inter Miami CF", "lost", 0);
  settledBet(db, "b2", "m1", "Over 1.5", "won", 20);

  const first = await chaseBoundNoScore(db, provider({ e1: ev({}) }), {});
  assert.equal(first.quarantined, 1);
  assert.equal(first.newlyQuarantinedBets, 2);   // обе поставлены ЭТИМ проходом
  assert.equal(first.alreadyQuarantinedBets, 0);
  assert.equal(first.noWrites, false);

  const second = await chaseBoundNoScore(db, provider({ e1: ev({}) }), {});
  // Матч ОСТАЁТСЯ кандидатом и снова уходит в карантин — это не баг, а следствие правила «счёт не пишем».
  assert.equal(second.scanned, 1);
  assert.equal(second.quarantined, 1);
  assert.equal(second.quarantinedBets, 2);
  // Но записей нет ни одной, и отчёт это ГОВОРИТ, а не подразумевает.
  assert.equal(second.newlyQuarantinedBets, 0);
  assert.equal(second.alreadyQuarantinedBets, 2);
  assert.equal(second.scoreWrites, 0);
  assert.equal(second.noWrites, true);
  assert.ok(second.note.includes("ПОВТОР БЕЗОПАСЕН"));
  assert.ok(chaseLine(second).includes("ВСЁ СТАРОЕ"));
  assert.equal(second.bookDeltaUsd, 0);
});

// Обратная сторона того же прибора: там, где проход РЕАЛЬНО работает, `noWrites` обязан быть false —
// иначе «повтор безопасен» стал бы печататься всегда и перестал бы что-либо значить.
test("[T8(б)] удачное дожатие даёт запись — повтор после него уже пустой, и кандидат исчезает", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  settledBet(db, "b1", "m1", "Inter Miami CF", "won", 20);
  const first = await chaseBoundNoScore(db, provider({ e1: ev({}) }), {});
  assert.equal(first.scoreWrites, 1);
  assert.equal(first.noWrites, false);
  const second = await chaseBoundNoScore(db, provider({ e1: ev({}) }), {});
  assert.equal(second.scanned, 0);          // дожатый матч из кандидатов ушёл
  assert.equal(second.scoreWrites, 0);
  assert.equal(second.noWrites, true);
});

test("(б) согласный сеттл дожатию не мешает — счёт пишется, карантина нет", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  settledBet(db, "b1", "m1", "Inter Miami CF", "won", 20);   // 2:1 — Майами победили, метка верна
  const r = await chaseBoundNoScore(db, provider({ e1: ev({}) }), {});
  assert.equal(r.filled, 1);
  assert.equal(r.quarantined, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM bets WHERE settle_suspect=1`).get() as any).n, 0);
});

test("(в) каждый отказ несёт КОД, а строка отчёта печатается и при нуле дожатых", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  boundNoScoreMatch(db, "m2", "LA Galaxy", "Austin FC", "e2");
  const r = await chaseBoundNoScore(db, provider({
    e1: ev({ final: false, state: "live" }),          // ещё не финал у источника
    e2: null,                                        // источник промолчал
  }), {});
  assert.equal(r.filled, 0);
  const verdicts = r.rows.map((x) => x.verdict).sort();
  assert.deepEqual(verdicts, ["no_provider_answer", "not_final"]);
  assert.ok(r.rows.every((x) => x.note.length > 0));
  // Ноль звучит так же громко, как не-ноль: строка есть и называет ПРИЧИНЫ.
  const line = chaseLine(r);
  assert.match(line, /0\/2 дожато/);
  assert.match(line, /not_final/);
  assert.match(line, /no_provider_answer/);
});

test("завершённое событие БЕЗ счёта — дыра у источника, и она названа так", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  const r = await chaseBoundNoScore(db, provider({ e1: ev({ scoreHome: null, scoreAway: null }) }), {});
  assert.equal(r.rows[0].verdict, "no_score_at_source");
  assert.equal(r.filled, 0);
});

test("матч СО счётом в население не входит — проход идемпотентен", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  const p = provider({ e1: ev({}) });
  await chaseBoundNoScore(db, p, {});
  const second = await chaseBoundNoScore(db, p, {});
  assert.equal(second.scanned, 0);
  assert.equal(second.filled, 0);
  assert.match(second.note, /просмотрено 0/);
});

test("провайдера нет вовсе — проход не падает и не выдумывает счёт", async () => {
  const db = world();
  boundNoScoreMatch(db, "m1", "Inter Miami CF", "FC Cincinnati", "e1");
  const r = await chaseBoundNoScore(db, null, {});
  assert.equal(r.filled, 0);
  assert.equal(r.rows[0].verdict, "no_provider_answer");
  assert.equal(R.getMatch(db, "m1")!.final_score, null);
});
