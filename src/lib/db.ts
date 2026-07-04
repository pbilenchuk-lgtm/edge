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
  // that would finish them does not survive a process restart. Only fail rows
  // older than the stale window (ISO timestamps, matching the rest of the
  // schema) so that under a shared DB we never kill another instance's genuinely
  // in-flight run; anything younger self-heals via analysisStatus/jobActive.
  try {
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    db.prepare(
      "UPDATE analysis_jobs SET status='failed', error='прервано рестартом сервера', finished_at=? WHERE status='running' AND started_at < ?",
    ).run(new Date().toISOString(), cutoff);
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
  ]) {
    try { db.exec(alter); } catch { /* column already exists */ }
  }
}

/** For tests: drop the memoized connection. */
export function resetDbSingleton(): void {
  _db?.close();
  _db = null;
}
