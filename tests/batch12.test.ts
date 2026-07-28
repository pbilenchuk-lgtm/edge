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
