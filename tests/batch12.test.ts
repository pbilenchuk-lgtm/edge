import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { relabelPiecesByMarket } from "../src/lib/pieceRelabel.js";

// ── W1/Z2: метка куска = исход РЫНКА, судьба куска = piece_pnl ───────────────────────────────────

function seedFb(db: any) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "L", budget: 8000, external_league: "swe.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "OVR", tag: "o", color: "#fff", version: 1, prompt: "", prompt_live: null, params: {}, model: "m", model_live: null, created_at: "t" } as any);
}
function fbMatch(db: any, id: string, sh: number, sa: number) {
  R.insertMatch(db, { id, competition_id: "c1", home: "H", away: "A", state: "finished", lineup_out: true,
    kickoff_at: "2026-07-27T17:00:00Z", minute: 90, score_home: sh, score_away: sa, final_score: `${sh}:${sa}`,
    kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: id } as any);
}
function piece(db: any, id: string, mid: string, label: string, status: string, stake: number, payout: number, by = "partial") {
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,payout,result,settled_by,settled_at,created_at)
              VALUES(?,?,'overreaction','medium',?,?,45,?,?,?,?,'t','t')`)
    .run(id, mid, label, status, stake, payout, status === "settled_won" ? "won" : status === "settled_lost" ? "lost" : null, by);
}

test("W1: рынок не может разрешиться в обе стороны — куски Over 1.5 получают метку РЫНКА, судьба куска уходит в piece_pnl", () => {
  // Точный кейс пачки: одна позиция Over 1.5, куски закрыты по 11.7¢ (lost) и 54.8¢ (won). Матч кончился 2:1
  // → рынок Over 1.5 РАЗРЕШИЛСЯ ДА. Оба куска обязаны стать settled_won; кто из них заработал, а кто потерял —
  // отдельный факт, и он сохраняется в piece_pnl со своими знаками.
  const db = openDb(":memory:"); initSchema(db); seedFb(db); fbMatch(db, "m1", 2, 1);
  piece(db, "p1", "m1", "Over 1.5", "settled_lost", 9, 1.55);    // срез на дне: piece_pnl −7.45
  piece(db, "p2", "m1", "Over 1.5", "settled_won", 9, 10.91);    // срез в плюс: piece_pnl +1.91

  const r = relabelPiecesByMarket(db, { now: () => "t2" });
  assert.equal(r.relabeled, 2);
  assert.equal(r.flipped, 1, "перевёрнут ровно проигрышный кусок — рынок-то выиграл");
  const p1 = R.getBet(db, "p1")!, p2 = R.getBet(db, "p2")!;
  assert.equal(p1.status, "settled_won"); assert.equal(p2.status, "settled_won");
  assert.equal(p1.result, "won"); assert.equal(p2.result, "won");
  assert.equal((p1 as any).piece_pnl, -7.45, "судьба куска: потерял $7.45 — и это осталось правдой");
  assert.equal((p2 as any).piece_pnl, 1.91);
  assert.equal(p1.payout, 1.55, "ДЕНЬГИ НЕ ТРОНУТЫ: payout как был");
  assert.equal(p2.payout, 10.91);
});

test("W1 (Cusco-класс): кусок, проданный В ПЛЮС на рынке, который ПРОИГРАЛ, становится settled_lost с piece_pnl>0", () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db); fbMatch(db, "m2", 0, 0);   // 0:0 → Over 1.5 проиграл
  piece(db, "p3", "m2", "Over 1.5", "settled_won", 20, 24.5);    // продали по дороге вверх, рынок потом умер
  const r = relabelPiecesByMarket(db, {});
  assert.equal(r.flipped, 1);
  const p = R.getBet(db, "p3")!;
  assert.equal(p.status, "settled_lost", "метка — исход рынка");
  assert.equal((p as any).piece_pnl, 4.5, "но кусок честно заработал $4.50, и это видно");
  assert.equal(p.payout, 24.5);
});

test("W1: идемпотентность + незавершённый матч откладывается, а не гадается", () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db);
  R.insertMatch(db, { id: "m3", competition_id: "c1", home: "H", away: "A", state: "live", lineup_out: true,
    kickoff_at: "t", minute: 60, score_home: 1, score_away: 0, final_score: null, kickoff_time: null,
    end_time: null, duration: null, end_note: null, external_ref: "m3" } as any);
  piece(db, "p4", "m3", "Over 1.5", "settled_won", 10, 12);
  const r1 = relabelPiecesByMarket(db, {});
  assert.equal(r1.deferred, 1); assert.equal(r1.relabeled, 0);
  assert.equal(r1.pnlBackfilled, 1, "судьба куска штампуется сразу — она от рынка не зависит");
  // Матч кончился — второй проход дорисовывает метку; третий не делает ничего.
  db.prepare(`UPDATE matches SET state='finished', score_home=1, score_away=1 WHERE id='m3'`).run();
  assert.equal(relabelPiecesByMarket(db, {}).relabeled, 1);
  const r3 = relabelPiecesByMarket(db, {});
  assert.equal(r3.scanned, 0, "размеченное больше не сканируется");
});

test("W1/Z2(б): нерешаемый ярлык — accounting_unverifiable (market_labeled=2), а не молчание и не ложный void", () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db); fbMatch(db, "m4", 1, 0);
  piece(db, "p5", "m4", "Какой-то экзотический рынок", "settled_won", 10, 15);
  const r = relabelPiecesByMarket(db, {});
  assert.equal(r.unverifiable, 1);
  const p = R.getBet(db, "p5")!;
  assert.equal(p.status, "settled_won", "старая метка осталась — но строка ПОМЕЧЕНА непроверяемой");
  assert.equal((p as any).market_labeled, 2);
  assert.equal(relabelPiecesByMarket(db, {}).scanned, 0, "и не пересканируется вечно");
});

test("W1 (Juan-Pablo-класс, теннис): манилайн-кусок метится по прошедшему дальше, неоднозначное имя — непроверяемо", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Tennis");
  R.upsertCompetition(db, { id: "tc", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" } as any);
  R.insertStrategy(db, { id: "overreaction_t", sport_id: "tennis", name: "OVRT", tag: "t", color: "#fff", version: 1, prompt: "", prompt_live: null, params: {}, model: "m", model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "tm1", competition_id: "tc", home: "Juan Pablo Ficovich", away: "Marco Trungelliti", state: "finished",
    lineup_out: false, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "tm1" } as any);
  db.prepare(`INSERT INTO tennis_snapshots(id, event_key, provider, pm_match_id, batch_at, created_at, p1, p2, sets_p1, sets_p2, live, status, raw)
              VALUES('s1','ek1','apitennis','tm1','t','t','Juan Pablo Ficovich','Marco Trungelliti',2,0,0,'Finished','{"event_winner":"First Player"}')`).run();
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,payout,result,settled_by,settled_at,created_at)
              VALUES('tp1','tm1','overreaction_t','medium','Juan Pablo Ficovich','settled_lost',40,50,20,'lost','early','t','t')`).run();
  const r = relabelPiecesByMarket(db, {});
  assert.equal(r.relabeled, 1);
  const p = R.getBet(db, "tp1")!;
  assert.equal(p.status, "settled_won", "Ficovich прошёл дальше — манилайн на него ВЫИГРАЛ, что бы ни говорил P&L куска");
  assert.equal((p as any).piece_pnl, -30);
});

// ── W2: полные гейты в ft_blind (Östers) + W4: диагностика по стадиям (Hacken) ───────────────────
import { autoEnter } from "../src/lib/lifecycle.js";
import { entryBlockerDiag } from "../src/lib/matchLog.js";

function blindMatch(db: any, id: string, mkts: { label: string; price: number }[]) {
  R.insertMatch(db, { id, competition_id: "c1", home: "Osters IF", away: "Varbergs BoIS", state: "upcoming",
    lineup_out: true, kickoff_at: "2026-07-27T17:05:00Z", minute: null, score_home: null, score_away: null,
    final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
  for (const mk of mkts)
    R.insertMarket(db, { id: R.uid(), match_id: id, label: mk.label, price: mk.price, ai_prob: null, liquidity: "800", external_ref: mk.label, snapshot_at: "t", is_closing: false } as any);
}
function proposal(db: any, id: string, mid: string, label: string, stake: number) {
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,proposed_price,stake,origin,created_at)
              VALUES(?,?,'overreaction','medium',?,'proposed',NULL,?,'prematch','t')`).run(id, mid, label, stake);
}
const FTB_ENV = { FT_BLIND_ENABLED: "true" };

test("W2 (Östers): вход @50.2¢ в непроторгованный плейсхолдер на слепой фикстуре ЗАПРЕЩЁН", async () => {
  // Общий placeholder_mid требует, чтобы книга простояла на 50¢ stale-минут — у слепой фикстуры истории нет,
  // и Östers прошёл: $40+$85 в дефолтную котировку → void. Для режима без руля отказ безусловный.
  const db = openDb(":memory:"); initSchema(db); seedFb(db);
  blindMatch(db, "ob1", [{ label: "Varbergs BoIS Under 1.5", price: 50.2 }]);
  proposal(db, "obb1", "ob1", "Varbergs BoIS Under 1.5", 40);
  const opened = await autoEnter(db, { env: FTB_ENV, now: () => "2026-07-27T16:50:00Z" });
  assert.equal(opened.length, 0);
  const b = R.getBet(db, "obb1")!;
  assert.equal(b.status, "not_filled");
  assert.match(b.rationale ?? "", /ft_blind_placeholder/);
});

test("W2 (Östers, пыль): филл меньше $5 в ft_blind не открывается", async () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db);
  blindMatch(db, "ob2", [{ label: "Under 3.5", price: 62.2 }]);
  proposal(db, "obb2", "ob2", "Under 3.5", 6);        // halved by capFrac 0.5 → $3 < $5
  const opened = await autoEnter(db, { env: FTB_ENV, now: () => "2026-07-27T16:50:00Z" });
  assert.equal(opened.length, 0);
  assert.match(R.getBet(db, "obb2")!.rationale ?? "", /ft_blind_min_stake/);
});

test("W2 (контроль): нормальный ft_blind-вход по-прежнему проходит — гейты режут порчу, не режим", async () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db);
  blindMatch(db, "ob3", [{ label: "Under 3.5", price: 62.2 }]);
  proposal(db, "obb3", "ob3", "Under 3.5", 40);       // → $20 после cap, цена вне mid-полосы
  const opened = await autoEnter(db, { env: FTB_ENV, now: () => "2026-07-27T16:50:00Z" });
  assert.equal(opened.length, 1, "вход состоялся");
  assert.equal(R.getBet(db, "obb3")!.status, "open");
});

test("W4 (Hacken): отклонённые на филле picks называются fill_rejected:stale_proposal, а не «стратег не выдал»", () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db);
  blindMatch(db, "hk1", [{ label: "Under 2.5", price: 34.2 }]);
  for (let i = 0; i < 3; i++)
    db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,stake,rationale,origin,created_at)
                VALUES(?,'hk1','overreaction','medium','Under 2.5','not_filled',80,'…частичное … stale_proposal: филл 34.2¢ vs предложение 25.5¢ (Δ9¢)','prematch','t')`).run(`hb${i}`);
  const d = entryBlockerDiag(db, "hk1", {}).join("\n");
  assert.match(d, /fill_rejected:stale_proposal ×3/);
  assert.match(d, /чинить надо названную стадию, НЕ стратега/);
  assert.doesNotMatch(d, /стратег не выдал/);
});

test("W4: настоящая пустота стратега называется strategist_empty — стадии не смешиваются", () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db);
  blindMatch(db, "em1", [{ label: "Under 2.5", price: 34.2 }]);
  const d = entryBlockerDiag(db, "em1", {}).join("\n");
  assert.match(d, /strategist_empty/);
});

// ── W5: shadow отклонённых по дрейфу + W3: приостановка лесенки за флагом ────────────────────────
import { recordStaleProposalShadow, resolveStaleProposalShadow, buildStaleShadowReport, STALE_SHADOW_NEED_N } from "../src/lib/staleProposalShadow.js";

test("W5: отказ по дрейфу замораживается would-be записью, резолвится по рынку, дубль не раздувает выборку", () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db); fbMatch(db, "sp1", 2, 1);   // Over 1.5 → won
  const s = { matchId: "sp1", strategyId: "overreaction", label: "Over 1.5", proposedCents: 25.5, fillCents: 34.2, at: "t" };
  recordStaleProposalShadow(db, s); recordStaleProposalShadow(db, s);                     // ре-цикл повторил отказ
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM stale_proposal_shadow`).get() as any).n, 1, "дедуп: одна запись");
  const r = resolveStaleProposalShadow(db, {});
  assert.equal(r.resolved, 1);
  const row = db.prepare(`SELECT status, drift_cents FROM stale_proposal_shadow`).get() as any;
  assert.equal(row.status, "won"); assert.equal(row.drift_cents, 8.7);
});

test("W5: критерий зрелости сильнее результата — до n=20 вердикт insufficient, дальше решает EV по цене филла", () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db);
  // 19 выигрышных отказов — роскошный EV, но вердикт обязан быть «копим».
  for (let i = 0; i < 19; i++) {
    fbMatch(db, `w${i}`, 2, 1);
    recordStaleProposalShadow(db, { matchId: `w${i}`, strategyId: "overreaction", label: "Over 1.5", proposedCents: 30, fillCents: 40, at: "t" });
  }
  resolveStaleProposalShadow(db, {});
  assert.equal(buildStaleShadowReport(db, {}).verdict, "insufficient");
  // Двадцатый — и критерий читается механически.
  fbMatch(db, "w19", 2, 1);
  recordStaleProposalShadow(db, { matchId: "w19", strategyId: "overreaction", label: "Over 1.5", proposedCents: 30, fillCents: 40, at: "t" });
  resolveStaleProposalShadow(db, {});
  const rep = buildStaleShadowReport(db, {});
  assert.equal(rep.resolvedN, STALE_SHADOW_NEED_N);
  assert.equal(rep.verdict, "порог_режет_деньги", "все 20 выиграли бы по цене филла → порог режет деньги");
  assert.equal(rep.winnersDriftQuantileC, 10, "кандидат в порог — p75 дрейфа выигрышных");
});

test("W5: непроверяемый ярлык уходит в unverifiable, а не в знаменатель", () => {
  const db = openDb(":memory:"); initSchema(db); seedFb(db); fbMatch(db, "sp2", 1, 0);
  recordStaleProposalShadow(db, { matchId: "sp2", strategyId: "overreaction", label: "Экзотика", proposedCents: 30, fillCents: 40, at: "t" });
  const r = resolveStaleProposalShadow(db, {});
  assert.equal(r.unverifiable, 1);
  assert.equal(buildStaleShadowReport(db, {}).resolvedN, 0);
});
