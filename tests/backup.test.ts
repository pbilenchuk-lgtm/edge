// ============================================================
// EDGE LAB — АРХИВ БАЗЫ: ТЕСТЫ НА ТО, ЧТО СНИМОК ПОЛНЫЙ И СВЕРЯЕМЫЙ
//
// Проверяется ровно то, ради чего архив делается:
//   • имена таблиц берутся ИЗ БАЗЫ — таблица, добавленная миграцией и не вписанная ни в какой список,
//     всё равно попадает в сверку (забытая таблица — это немой ноль в архиве);
//   • VACUUM INTO даёт ОТКРЫВАЕМУЮ копию с ТЕМИ ЖЕ числами строк — иначе «архив есть» ничего не значит;
//   • построчная сверка исходника и копии совпадает по КАЖДОЙ таблице, а не по сумме.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { listTables, buildBackupCounts, vacuumInto, dumpTable } from "../src/lib/backup.js";

const T = "2026-08-12T00:00:00Z";

function world(file: string) {
  const db = openDb(file); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 8000, external_league: "usa.1", created_at: T });
  R.insertStrategy(db, { id: "pv", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: null, model_live: null, created_at: T, prompt: "p", prompt_live: null, params: {} } as never);
  R.insertMatch(db, {
    id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: T,
    minute: null, score_home: 1, score_away: 0, final_score: "1:0",
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1",
  } as never);
  for (let i = 0; i < 5; i++) {
    R.insertBet(db, {
      id: `b${i}`, match_id: "m1", strategy_id: "pv", risk_profile_id: "medium", market_label: "Over 2.5",
      status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: 60,
      ai_prob: 0.6, stake: 10, rationale: "r", entered_minute: "предматч", result: "won", payout: 20, created_at: T,
    } as never);
  }
  return db;
}

function tmp(name: string) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "edge-bk-")), name); }

test("имена таблиц читаются ИЗ БАЗЫ — таблица вне всякого списка в коде всё равно попадает в сверку", () => {
  const src = tmp("a.db"); const db = world(src);
  db.exec(`CREATE TABLE zzz_added_by_migration (id TEXT PRIMARY KEY, v TEXT)`);
  db.prepare(`INSERT INTO zzz_added_by_migration VALUES (?,?)`).run("1", "x");
  const names = listTables(db);
  assert.ok(names.includes("zzz_added_by_migration"), "новая таблица видна");
  assert.ok(names.includes("bets") && names.includes("markets"));
  assert.ok(!names.some((n) => n.startsWith("sqlite_")), "служебные таблицы SQLite в сверку не идут");
  const c = buildBackupCounts(db, src, T);
  assert.equal(c.tables.find((t) => t.table === "zzz_added_by_migration")?.rows, 1);
  assert.equal(c.tables.find((t) => t.table === "bets")?.rows, 5);
  assert.ok((c.fileBytes ?? 0) > 0, "размер файла посчитан из page_count × page_size");
});

// ГЛАВНЫЙ ТЕСТ АРХИВА. «Дамп снят» ничего не значит, пока копия не открылась и не дала ТЕ ЖЕ числа.
test("VACUUM INTO даёт открываемую копию, и построчная сверка совпадает по КАЖДОЙ таблице", () => {
  const src = tmp("src.db"); const db = world(src);
  const dst = tmp("dump.db");
  vacuumInto(db, dst);
  assert.ok(fs.existsSync(dst) && fs.statSync(dst).size > 0);

  const before = buildBackupCounts(db, src, T);
  const copy = openDb(dst);
  const after = buildBackupCounts(copy, dst, T);

  assert.deepEqual(after.tables.map((t) => t.table), before.tables.map((t) => t.table), "набор таблиц тот же");
  const diffs = before.tables
    .map((t) => ({ table: t.table, src: t.rows, dst: after.tables.find((x) => x.table === t.table)?.rows }))
    .filter((d) => d.src !== d.dst);
  assert.deepEqual(diffs, [], `расхождения по строкам: ${JSON.stringify(diffs)}`);
  assert.equal(after.totalRows, before.totalRows);
  // Копия читается как БАЗА, а не как байты: запрос к ней обязан работать.
  assert.equal((copy.prepare(`SELECT COUNT(*) n FROM bets`).get() as { n: number }).n, 5);
});

test("VACUUM INTO отказывается писать поверх существующего файла — снимок не смешивается со старым", () => {
  const src = tmp("s2.db"); const db = world(src);
  const dst = tmp("d2.db");
  vacuumInto(db, dst);
  assert.throws(() => vacuumInto(db, dst), /exists|error/i);
});

test("выгрузка таблицы: известная отдаёт строки, неизвестная — ошибку с именем, а не пустой массив", () => {
  const src = tmp("s3.db"); const db = world(src);
  assert.equal(dumpTable(db, "bets", 100, 0).length, 5);
  assert.equal(dumpTable(db, "bets", 2, 0).length, 2);
  assert.equal(dumpTable(db, "bets", 100, 4).length, 1);
  assert.throws(() => dumpTable(db, "bets; DROP TABLE bets", 10, 0), /unknown table/);
  assert.throws(() => dumpTable(db, "no_such_table", 10, 0), /unknown table/);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM bets`).get() as { n: number }).n, 5, "инъекция не сработала");
});
