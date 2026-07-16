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
import { migrateCanonicalPrompts, migrateStrategyRoster, migrateSharesToAggressive, migrateSharesAllPairs, migrateSharesGrid, migratePrematchValueV3, migrateOverreactionV2, migrateLiveXgV2, migrateTennisStrategy, migrateTennisSetValueStrategy, migrateTennisPmvStrategy, migrateVoidOutOfScopePmv, migrateVoidAllOpenPmv, migrateResettleExtraTimeVoids, migrateResetTennisMarks } from "./seed.js";
import { seedRiskProfiles, migrateRiskProfileExits } from "./riskConfig.js";
import { migrateCategoryModifiers } from "./categoryModifiers.js";

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
  // Bring stale default analysis prompts current (prod DBs seeded before the
  // two-layer rewrite still carry the old football base / WC modifier). Marker-
  // guarded + idempotent; best-effort so a prompt hiccup never wedges boot.
  try { migrateCanonicalPrompts(db); }
  catch { /* non-fatal: analysis still runs on whatever prompt is stored */ }
  // Seed the named risk presets (aggressive/medium/conservative) onto any DB that
  // doesn't have them yet — idempotent, so a live prod DB gets them without a wipe.
  try { seedRiskProfiles(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  // Add the exits group to presets seeded before it existed (profile-specific take/stop).
  try { migrateRiskProfileExits(db); }
  catch { /* non-fatal */ }
  // Ensure the three real strategists exist and, on the first boot after this
  // ships, retire the legacy "wc" strategy and assign the trio (medium profile)
  // to every competition. One-time (gated on wc existing); non-recurring.
  try { migrateStrategyRoster(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  // Bring the Pre-match Value strategist prompts to v3 (6-branch outcome tree) on
  // an existing DB. Marker-guarded, archives the prior version, respects user edits.
  try { migratePrematchValueV3(db); }
  catch { /* non-fatal: strategy runs on whatever prompt is stored */ }
  // Bring the Overreaction strategist prompts to v2 (armed buyback triggers +
  // false-signal shot-quality filter). Marker-guarded, respects user edits.
  try { migrateOverreactionV2(db); }
  catch { /* non-fatal */ }
  // Bring the Live xG Momentum prompts to v2 (match_shape-tuned entry threshold,
  // pressure-sustainability filter, counterattack stop). Marker-guarded.
  try { migrateLiveXgV2(db); }
  catch { /* non-fatal */ }
  // Seed the tennis Overreaction strategy (sport=tennis). Idempotent; the tennis paper loop
  // owns it, comps stay budget-0 so the football engine never touches tennis.
  try { migrateTennisStrategy(db); }
  catch { /* non-fatal */ }
  // Seed the SECOND tennis strategy, Set-Value (buy the favourite after a competitive lost set 1,
  // hold to resolution). Idempotent; same tennis paper loop, comps stay budget-0.
  try { migrateTennisSetValueStrategy(db); }
  catch { /* non-fatal */ }
  // Seed the THIRD tennis strategy, PMV (prop consistency vs the moneyline anchor; deterministic,
  // no LLM v1). Idempotent; same tennis paper loop, comps stay budget-0.
  try { migrateTennisPmvStrategy(db); }
  catch { /* non-fatal */ }
  // One-time: void open PMV bets that an early build placed on out-of-scope ITF/Challenger/doubles
  // matches (wrong base_hold) before PMV was restricted to ATP/WTA singles. Marker-guarded.
  try { migrateVoidOutOfScopePmv(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  // One-time: void EVERY open PMV bet — the broken first epoch drains the sim budget + pollutes Brier.
  // PMV stays live in flag-only (logs, no new bets) until the recalibrated epoch is re-enabled.
  try { migrateVoidAllOpenPmv(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  // One-time: re-settle historical Extra-Time/Penalties bets voided before the phase-aware resolver
  // (returns the ~$38 of France–Spain "ET — No" that was refunded instead of paid), and normalize
  // every remaining void's status to settled_void. Idempotent, auditable, ET/pens-only.
  try { migrateResettleExtraTimeVoids(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  // One-time: move every (category × strategy) allocation onto the AGGRESSIVE
  // profile (and retag live bets). Marker-guarded, so it runs once and respects
  // later manual profile changes.
  try { migrateSharesToAggressive(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  // One-time: lay down the full 3×3 pair grid (every strategist × every profile,
  // funds split evenly) on each football category — runs once, marker-guarded.
  try { migrateSharesAllPairs(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  // Re-lay the full strategist × ALL-profiles grid (even budget) whenever the set
  // of risk profiles changes — so a newly-added profile lands on every strategy in
  // every category automatically. No-ops while the profile set is stable.
  try { migrateSharesGrid(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  // Seed each football category's Layer-2 modifier onto its matching competition
  // (self-healing for newly-discovered leagues; never clobbers user/WC prompts).
  try { migrateCategoryModifiers(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  // One-time: wipe the 105 tennis calibration marks measured on PROP prices (the moneyline-resolver
  // fix invalidated them). Marker-guarded → runs once, then marks re-accumulate on the moneyline.
  try { migrateResetTennisMarks(db, new Date().toISOString()); }
  catch { /* non-fatal */ }
  _db = db;
  return db;
}

/** Run `fn` inside a single transaction (BEGIN → COMMIT, or ROLLBACK + rethrow on any throw). node:sqlite
 *  has no `.transaction()` wrapper, so this is the atomicity primitive for money accounting (B2). Not
 *  re-entrant — never nest. */
export function transact<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
}

/** Open a fresh, isolated connection (used by tests). Not memoized. */
export function openDb(path: string): Database {
  const { DatabaseSync } = require("node:sqlite") as SqliteModule;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  return db;
}

// Snapshot retention (days). 1 GB persistent disk can't hold years of raw payloads, so keep
// this modest; bump only alongside a bigger Render disk. Env-overridable.
const SNAPSHOT_RETENTION_DAYS = Math.max(1, Number(process.env.SNAPSHOT_RETENTION_DAYS ?? 5));

export function initSchema(db: Database): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // EMERGENCY DISK RECOVERY (runs BEFORE any DDL): reclaim pages from over-retained snapshots
  // so a FULL persistent disk can't block schema init or subsequent writes. DELETE succeeds
  // even when the disk is full (it frees pages for reuse within the file); it's time-based, so
  // live-match snapshots (recent) are never touched. Guarded — tables may not exist on a fresh DB.
  try {
    const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 86_400_000).toISOString();
    // BOUNDED (≤N rows/table/boot). getDb() runs initSchema on its FIRST call — and /api/health (the
    // Render health check) calls getDb() — so this MUST stay cheap. An UNBOUNDED delete over an
    // OOM-bloated snapshots table hung the health response for minutes and failed Render's port scan
    // (the whole "no open HTTP ports" saga). The tick's prune + row-caps do the full cleanup OFF the
    // boot critical path; this only relieves a full disk cheaply. rowid-subquery LIMIT avoids needing
    // SQLITE_ENABLE_UPDATE_DELETE_LIMIT.
    for (const t of ["provider_snapshots", "tennis_snapshots"]) {
      try { db.exec(`DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE batch_at < '${cutoff}' LIMIT 4000)`); } catch { /* table absent on a fresh DB */ }
    }
  } catch { /* best-effort recovery */ }
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(sql);
  // Additive migrations for pre-existing databases (CREATE TABLE IF NOT EXISTS
  // won't add new columns). Each guarded so re-runs are harmless.
  for (const alter of [
    "ALTER TABLE competitions ADD COLUMN external_league TEXT",
    "ALTER TABLE bets ADD COLUMN settled_by TEXT",
    "ALTER TABLE bets ADD COLUMN settled_at TEXT",
    "ALTER TABLE matches ADD COLUMN clock TEXT",
    "ALTER TABLE match_live ADD COLUMN stats TEXT",
    "ALTER TABLE strategies ADD COLUMN prompt_live TEXT",
    "ALTER TABLE strategies ADD COLUMN model_live TEXT",
    "ALTER TABLE strategy_versions ADD COLUMN prompt_live TEXT",
    "ALTER TABLE bets ADD COLUMN risk_profile_id TEXT",
    "ALTER TABLE shadow_events ADD COLUMN config_snapshot TEXT",
    "ALTER TABLE shadow_events ADD COLUMN intensity REAL",
    "ALTER TABLE bets ADD COLUMN entry_meta TEXT",
    "ALTER TABLE bets ADD COLUMN code_version TEXT",
    "ALTER TABLE bets ADD COLUMN decision_id TEXT",
    "ALTER TABLE tennis_snapshots ADD COLUMN pm_p1_cents REAL",
    "ALTER TABLE tennis_snapshots ADD COLUMN pm_p2_cents REAL",
    "ALTER TABLE tennis_break_marks ADD COLUMN post_entry_min_cents REAL",
    "ALTER TABLE tennis_break_marks ADD COLUMN post_entry_min_sec INTEGER",
    // real-trading columns added AFTER the real_* tables' first creation — self-heal a prod DB whose
    // real_orders/fills/positions/ledger were created at an earlier phase (CREATE IF NOT EXISTS won't
    // add columns to an existing table). Each is idempotent (duplicate-column throw is caught below).
    "ALTER TABLE real_orders ADD COLUMN salt TEXT",
    "ALTER TABLE real_orders ADD COLUMN order_hash TEXT",
    "ALTER TABLE real_orders ADD COLUMN expiry_mode TEXT",
    "ALTER TABLE real_orders ADD COLUMN client_cancel_deadline TEXT",
    "ALTER TABLE real_fills ADD COLUMN dry INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE real_positions ADD COLUMN dry INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE real_ledger ADD COLUMN dry INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE markets ADD COLUMN ask_cents REAL",
    "ALTER TABLE markets ADD COLUMN spread_cents REAL",
  ]) {
    try { db.exec(alter); } catch { /* column already exists */ }
  }
  // strategy_shares gained risk_profile_id + a 3-part PK. SQLite can't ALTER a
  // PK, so recreate the table when the old (2-part) one is detected, backfilling
  // every existing allocation onto the MEDIUM profile. Guarded + row-preserving.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='strategy_shares'").get() as { sql?: string } | undefined;
    if (row?.sql && !/risk_profile_id/i.test(row.sql)) {
      db.exec("BEGIN");
      db.exec(`CREATE TABLE strategy_shares_new (
        competition_id TEXT NOT NULL, strategy_id TEXT NOT NULL,
        risk_profile_id TEXT NOT NULL DEFAULT 'medium',
        pct REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (competition_id, strategy_id, risk_profile_id))`);
      db.exec("INSERT INTO strategy_shares_new(competition_id,strategy_id,risk_profile_id,pct) SELECT competition_id,strategy_id,'medium',pct FROM strategy_shares");
      db.exec("DROP TABLE strategy_shares");
      db.exec("ALTER TABLE strategy_shares_new RENAME TO strategy_shares");
      db.exec("COMMIT");
    }
  } catch { try { db.exec("ROLLBACK"); } catch { /* ignore */ } }
  // B1: rekey real_positions to (token_id, decision_id, dry) — one row per twin per book, so positions
  // don't merge across decisions/strategies or across dry/real. SQLite can't change a PK, so rebuild when
  // the old (token_id-PK, no decision_id) table is detected. Existing rows (≈none — no dry fills yet)
  // carry over as legacy (decision_id NULL, legacy=1) and are excluded from the sweep. Row-preserving.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='real_positions'").get() as { sql?: string } | undefined;
    if (row?.sql && !/decision_id/i.test(row.sql)) {
      db.exec("BEGIN");
      db.exec(`CREATE TABLE real_positions_new (
        id TEXT PRIMARY KEY, token_id TEXT NOT NULL, decision_id TEXT, profile_id TEXT,
        match_id TEXT, strategy_id TEXT, size_shares REAL NOT NULL DEFAULT 0, avg_price_cents REAL,
        realized_pnl_usd REAL NOT NULL DEFAULT 0, unrealized_pnl_usd REAL, dry INTEGER NOT NULL DEFAULT 0,
        legacy INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        UNIQUE(token_id, decision_id, dry))`);
      db.exec(`INSERT INTO real_positions_new(id,token_id,decision_id,profile_id,match_id,strategy_id,size_shares,avg_price_cents,realized_pnl_usd,unrealized_pnl_usd,dry,legacy,updated_at)
        SELECT lower(hex(randomblob(16))), token_id, NULL, NULL, match_id, strategy_id, size_shares, avg_price_cents, realized_pnl_usd, unrealized_pnl_usd, dry, 1, updated_at FROM real_positions`);
      db.exec("DROP TABLE real_positions");
      db.exec("ALTER TABLE real_positions_new RENAME TO real_positions");
      db.exec("CREATE INDEX IF NOT EXISTS idx_real_pos_token ON real_positions(token_id)");
      db.exec("COMMIT");
    }
  } catch { try { db.exec("ROLLBACK"); } catch { /* ignore */ } }
  // SQLite can't ALTER a CHECK constraint, so relax the old trade_log.type CHECK
  // (which excluded the later 'skip', then 'hold' types) by recreating the table.
  // Guarded: runs only when the existing CHECK is missing a currently-valid type;
  // preserves all rows.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='trade_log'").get() as { sql?: string } | undefined;
    if (row?.sql && /CHECK/i.test(row.sql) && (!/skip/i.test(row.sql) || !/hold/i.test(row.sql))) {
      db.exec("BEGIN");
      db.exec(`CREATE TABLE trade_log_new (
        id TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES matches(id),
        strategy_id TEXT NOT NULL REFERENCES strategies(id), minute TEXT,
        type TEXT NOT NULL CHECK (type IN ('enter','exit','settle','skip','hold')),
        text TEXT NOT NULL, created_at TEXT NOT NULL)`);
      db.exec("INSERT INTO trade_log_new SELECT id,match_id,strategy_id,minute,type,text,created_at FROM trade_log");
      db.exec("DROP TABLE trade_log");
      db.exec("ALTER TABLE trade_log_new RENAME TO trade_log");
      db.exec("COMMIT");
    }
  } catch { try { db.exec("ROLLBACK"); } catch { /* ignore */ } }
  // Same: add 'settled_void' to the bets.status CHECK (a VOID is settled-but-not-a-loss — single-source
  // truth in the field, so no consumer miscounts a refund as a loss). Rebuilt from the table's ACTUAL
  // DDL so every ALTER-added column is preserved; guarded to run only on the pre-void CHECK.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bets'").get() as { sql?: string } | undefined;
    if (row?.sql && /CHECK/i.test(row.sql) && !/settled_void/i.test(row.sql)) {
      const cols = (db.prepare("PRAGMA table_info(bets)").all() as { name: string }[]).map((c) => c.name).join(",");
      const newDdl = row.sql
        .replace(/CREATE TABLE (IF NOT EXISTS )?["'`]?bets["'`]?/i, "CREATE TABLE bets_new")
        .replace("'settled_won','settled_lost'", "'settled_won','settled_lost','settled_void'");
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec("BEGIN");
      db.exec(newDdl);
      db.exec(`INSERT INTO bets_new(${cols}) SELECT ${cols} FROM bets`);
      db.exec("DROP TABLE bets");
      db.exec("ALTER TABLE bets_new RENAME TO bets");
      db.exec("CREATE INDEX IF NOT EXISTS idx_bets_match_strat ON bets(match_id, strategy_id)");
      db.exec("COMMIT");
      db.exec("PRAGMA foreign_keys=ON");
    }
  } catch { try { db.exec("ROLLBACK"); db.exec("PRAGMA foreign_keys=ON"); } catch { /* ignore */ } }
  // Same: relax reassessments.trigger CHECK to admit the 'penalty' trigger (a
  // saved/missed penalty now fires a reassessment). Guarded: runs only on the old
  // penalty-less CHECK; preserves all rows.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reassessments'").get() as { sql?: string } | undefined;
    if (row?.sql && /CHECK/i.test(row.sql) && !/penalty/i.test(row.sql)) {
      db.exec("BEGIN");
      db.exec(`CREATE TABLE reassessments_new (
        id TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES matches(id),
        strategy_id TEXT NOT NULL REFERENCES strategies(id), minute TEXT,
        body TEXT NOT NULL, confidence TEXT,
        trigger TEXT CHECK (trigger IN ('goal','red_card','penalty','price_move','time','manual')),
        created_at TEXT NOT NULL)`);
      db.exec("INSERT INTO reassessments_new SELECT id,match_id,strategy_id,minute,body,confidence,trigger,created_at FROM reassessments");
      db.exec("DROP TABLE reassessments");
      db.exec("ALTER TABLE reassessments_new RENAME TO reassessments");
      db.exec("COMMIT");
    }
  } catch { try { db.exec("ROLLBACK"); } catch { /* ignore */ } }
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
