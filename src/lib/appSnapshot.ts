// ============================================================
// EDGE LAB — shared AppData snapshot cache (STALE-WHILE-REVALIDATE)  [SERVER-ONLY]
//
// buildAppData() is a SYNCHRONOUS node:sqlite pass over EVERY match — it blocks the event loop for seconds
// and grows with the DB. BOTH the `/` SSR and the `/api/app` poll used to call it INLINE on every hit, so
// Render's port scan + the client's periodic reloads drove back-to-back blocking builds: the port never
// opened ("No open HTTP ports" → deploy timeout) and memory ballooned.
//
// One shared cache fixes it: a COLD start builds ONCE; after that every caller gets the LAST snapshot
// immediately and, only when it's stale, a SINGLE guarded background rebuild is kicked. buildAppData then runs
// at most once per TTL for the WHOLE worker, no matter how many requests arrive. Keep WEB_CONCURRENCY=1 so
// there's one cache, not one-per-worker.
// ============================================================

const SNAPSHOT_TTL_MS = Math.max(0, Number(process.env.APP_SNAPSHOT_TTL_MS ?? 30_000));
let _snap: { at: number; data: unknown } | null = null;
let _building = false;

async function rebuild(): Promise<void> {
  if (_building) return; // a rebuild is already in flight — never stack blocking sqlite passes
  _building = true;
  try {
    const { getDb } = await import("./db.js");
    const { buildAppData } = await import("./view.js");
    const data = buildAppData(getDb());
    _snap = { at: Date.now(), data };
  } catch { /* keep the previous snapshot — a transient DB error must not wipe a good render */ }
  finally { _building = false; }
}

/** The current AppData: the last snapshot served immediately; a stale one triggers a non-blocking background
 *  rebuild; a cold start builds once (blocking, unavoidable). Returns null only if the very first build failed. */
export async function getAppSnapshot(): Promise<unknown | null> {
  const fresh = _snap && Date.now() - _snap.at < SNAPSHOT_TTL_MS;
  if (!fresh) {
    if (_snap) void rebuild();   // stale → serve NOW, refresh in the background
    else await rebuild();        // cold start → must build once so the caller has data
  }
  return _snap?.data ?? null;
}
