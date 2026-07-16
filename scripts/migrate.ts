// ─────────────────────────────────────────────────────────────────────────────
// EDGE LAB — standalone schema migration. Runs ONCE in start.sh BEFORE `next start`.
//
// WHY a separate process instead of the lazy first-getDb():
//   initSchema is SYNCHRONOUS (node:sqlite) and can be heavy on a prod DB — table
//   rebuilds (real_positions rekey, CHECK-constraint relaxations), ALTERs, prompt/
//   roster seeds. It used to run lazily on the FIRST getDb() call — and /api/health
//   (Render's post-deploy health check + port scan) is what makes that first call.
//   So a heavy migration blocked the event loop / spiked RSS on the 512Mi box exactly
//   when Render scanned for the open port → "No open HTTP ports" → port-scan timeout →
//   the instance is killed before the rebuild can COMMIT → next boot re-attempts the
//   same migration → crash loop (this whole saga; see the note in src/lib/db.ts).
//
//   Running it here, before the server binds, does the work in a short-lived process
//   with the full box to itself and NO port-scan pressure. After it, `next start`'s
//   first getDb() finds an already-migrated DB, so initSchema is just cheap no-op
//   IF-NOT-EXISTS / duplicate-column checks → health responds in ms → port scan passes.
//
// Best-effort: on failure we log and exit 0 so start.sh still launches the server
// (which will surface the same error via /api/health) — never wedge boot on a hiccup,
// matching the guarded, non-fatal migration philosophy throughout src/lib/db.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, closeDb } from "../src/lib/db.js";

const t0 = Date.now();
try {
  getDb();          // open the DB + run the full initSchema (rebuilds, ALTERs, seeds)
  closeDb();        // checkpoint WAL + close so `next start` opens a clean, migrated file
  console.log(`→ migrations applied in ${Date.now() - t0}ms`);
} catch (e) {
  // Don't abort the container: let the server start and re-attempt (and report) itself.
  console.error("✗ migration step failed (non-fatal, server will retry):", e instanceof Error ? e.message : e);
}
process.exit(0);
