// ============================================================
// EDGE LAB — in-process scheduler (the cron). Runs the automated lifecycle on
// an interval inside the server process, so it shares the SQLite DB. Opt-in via
// AUTO_TICK=true. Three cadences (ТЗ §4.1 timing):
//   - LIVE every LIVE_TICK_SEC (default 90s): only while a match is in play —
//     re-price live matches, pull fresh ESPN events, deterministic exits, and
//     strategist reassessment on a goal / red card. This is the real-time loop.
//   - TICK every TICK_INTERVAL_MIN (default 30): odds refresh, clocks, exits,
//     analyze (12h/lineup gated), enter. No discovery.
//   - DISCOVER every DISCOVER_INTERVAL_HR (default 24): parse Polymarket for the
//     next 7 days of matches. Runs on the first tick, then daily.
// Live Claude analysis needs a key (env ANTHROPIC_API_KEY or the Настройки screen).
// ============================================================

import { getDb } from "./db.js";
import * as R from "./repo.js";
import { loadSportsProvider, loadSportsConfig } from "./sports.js";
import { loadPolymarketConfig } from "./polymarket.js";
import { runAutoCycle, runLiveCycle } from "./lifecycle.js";
import { tryAcquireEngine, releaseEngine } from "./engineLock.js";

let started = false;

export function startScheduler(env: Record<string, string | undefined> = process.env): void {
  if (started) return;
  if ((env.AUTO_TICK ?? "false").toLowerCase() !== "true") return;
  started = true;
  const tickMin = Math.max(1, Number(env.TICK_INTERVAL_MIN ?? 30));
  const discoverHr = Math.max(1, Number(env.DISCOVER_INTERVAL_HR ?? 24));
  const liveSec = Math.max(15, Number(env.LIVE_TICK_SEC ?? 20));
  const linkOdds = loadPolymarketConfig(env).enabled;
  let lastDiscover = 0;
  // One shared lock (engineLock): the slow full cycle, the fast live loop, AND
  // the manual HTTP triggers (discover/tick/refreshAllOdds) all touch
  // exits/reassessment/entries, so they must never run concurrently (a duplicate
  // entry could otherwise slip past the in-DB dedup across the LLM await, and the
  // resource doubling is a 502 contributor on a small instance).

  const run = async () => {
    const tok = tryAcquireEngine();
    if (!tok) return; // don't overlap with a live/manual/slow pass
    // Everything that can throw goes INSIDE the try so `finally` always clears
    // `busy` — a throw from getDb()/Date before the try would wedge the cron
    // (busy stuck true) for the whole process lifetime.
    const nowMs = Date.now();
    const discover = nowMs - lastDiscover >= discoverHr * 3_600_000;
    const at = new Date(nowMs).toISOString();
    let db: ReturnType<typeof getDb> | null = null;
    try {
      db = getDb();
      const provider = loadSportsProvider(loadSportsConfig(env));
      if (discover) lastDiscover = nowMs;
      const r = await runAutoCycle(db, provider, {}, { linkOdds, discover });
      const summary = `sync ${r.synced} · discover ${r.discovered} · составы ${r.enriched} · котировки ${r.oddsUpdated} · анализ ${r.analyzed.length} · входы ${r.entered.length} · выходы ${r.exited.length}`;
      console.log(`[scheduler] ${summary}`);
      try { R.insertCronLog(db, { id: R.uid(), at, kind: discover ? "discover" : "tick", ok: 1, summary, created_at: at }); } catch {}
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[scheduler] error:", msg);
      try { if (db) R.insertCronLog(db, { id: R.uid(), at, kind: discover ? "discover" : "tick", ok: 0, summary: `ошибка: ${msg}`, created_at: at }); } catch {}
    } finally {
      releaseEngine(tok);
    }
  };

  // Fast live loop — only does work while a match is in play; logs to the cron
  // journal only when something actually happened (so it doesn't flood it).
  const liveRun = async () => {
    const tok = tryAcquireEngine();
    if (!tok) return;    // yield to a running full/live/manual pass
    const at = new Date(Date.now()).toISOString();
    let db: ReturnType<typeof getDb> | null = null;
    try {
      db = getDb();
      const provider = loadSportsProvider(loadSportsConfig(env));
      const r = await runLiveCycle(db, provider, {});
      if (r.live > 0 && (r.triggers || r.exits || r.entries)) {
        const summary = `live ${r.live} · триггеры ${r.triggers} · котировки ${r.oddsUpdated} · выходы ${r.exits} · входы ${r.entries}`;
        console.log(`[scheduler:live] ${summary}`);
        try { R.insertCronLog(db, { id: R.uid(), at, kind: "live", ok: 1, summary, created_at: at }); } catch {}
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[scheduler:live] error:", msg);
      try { if (db) R.insertCronLog(db, { id: R.uid(), at, kind: "live", ok: 0, summary: `ошибка: ${msg}`, created_at: at }); } catch {}
    } finally {
      releaseEngine(tok);
    }
  };

  console.log(`[scheduler] on — live ${liveSec}s, tick ${tickMin}m, discover ${discoverHr}h`);
  setTimeout(run, 5_000);               // first full pass shortly after boot (discovers)
  setInterval(run, tickMin * 60_000);   // then every tickMin
  setInterval(liveRun, liveSec * 1000); // fast real-time loop for in-play matches
}
