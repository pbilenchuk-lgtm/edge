// ============================================================
// EDGE LAB — database connection (node:sqlite, built-in)  [SERVER-ONLY]
//
// Zero external dependencies: uses Node's built-in SQLite (Node >= 22.5,
// run with --experimental-sqlite). Prisma/native drivers are intentionally
// avoided — their engine binaries are not always fetchable in locked-down
// environments. Swap this module for a Postgres adapter in production;
// nothing above it depends on SQLite specifics.
// ============================================================

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

// node:sqlite is experimental and not in @types/node, so require it
// dynamically and give it a minimal local type.
const require = createRequire(import.meta.url);

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => Database;
}

let _db: Database | null = null;

export function dbPath(env = process.env): string {
  return env.EDGE_DB_PATH ?? "./data/edge.db";
}

/** Open (or reuse) the singleton connection and ensure the schema exists. */
export function getDb(path = dbPath()): Database {
  if (_db) return _db;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as SqliteModule;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  initSchema(db);
  // Reconcile analyze jobs orphaned by a crash/restart: the background promise
  // that would finish them dies with the process. The deploy runs a SINGLE
  // instance (disk-pinned), so ANY 'running' row at boot is orphaned — fail them
  // all immediately, otherwise a job that started <10 min before the restart
  // shows a stuck "ИИ работает…" (jobActive's window) and can't be re-kicked.
  try {
    db.prepare(
      "UPDATE analysis_jobs SET status='failed', error='прервано рестартом сервера', finished_at=? WHERE status='running'",
    ).run(new Date().toISOString());
  } catch { /* table may not exist on a very old DB; schema just created it */ }
  _db = db;
  return db;
}

/** Open a fresh, isolated connection (used by tests). Not memoized. */
export function openDb(path: string): Database {
  const { DatabaseSync } = require("node:sqlite") as SqliteModule;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  return db;
}

export function initSchema(db: Database): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(sql);
  // Additive migrations for pre-existing databases (CREATE TABLE IF NOT EXISTS
  // won't add new columns). Each guarded so re-runs are harmless.
  for (const alter of [
    "ALTER TABLE competitions ADD COLUMN external_league TEXT",
    "ALTER TABLE bets ADD COLUMN settled_by TEXT",
    "ALTER TABLE matches ADD COLUMN clock TEXT",
    "ALTER TABLE match_live ADD COLUMN stats TEXT",
    "ALTER TABLE quality_metrics ADD COLUMN phases TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE quality_metrics ADD COLUMN mgmt TEXT",
    "ALTER TABLE quality_metrics ADD COLUMN equity TEXT NOT NULL DEFAULT '[]'",
  ]) {
    try { db.exec(alter); } catch { /* column already exists */ }
  }
}

/** For tests: drop the memoized connection. */
export function resetDbSingleton(): void {
  _db?.close();
  _db = null;
}

/** Close the connection cleanly — in WAL mode `close()` checkpoints the -wal
 *  back into the main db file, so the last writes aren't stranded when Render
 *  sends SIGTERM on a redeploy (now that the file lives on a persistent disk). */
export function closeDb(): void {
  try { _db?.close(); } catch { /* already closed */ }
  _db = null;
}
let shutdownHooked = false;
/** Register SIGTERM/SIGINT handlers once so a graceful stop checkpoints WAL. */
export function installShutdownHandler(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  // Just checkpoint + close; DON'T process.exit() — let Next own termination so
  // in-flight requests still drain. (close() is synchronous, so the WAL is
  // flushed before the process actually exits.)
  const onStop = () => closeDb();
  process.once("SIGTERM", onStop);
  process.once("SIGINT", onStop);
}
