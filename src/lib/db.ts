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
}

/** For tests: drop the memoized connection. */
export function resetDbSingleton(): void {
  _db?.close();
  _db = null;
}
