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
import { runAutoCycle, runLiveCycle, hasLiveMatchInPlay } from "./lifecycle.js";
import { tryAcquireEngine, releaseEngine } from "./engineLock.js";

let started = false;

// The fast live loop stamps this every run; the heartbeat reads it to tell a HEALTHY
// loop (fresh stamp → no-op) from a stalled one (stale stamp → drive a live cycle now).
// DB-backed so it survives the process restart that kills the in-process loop.
const LAST_LIVE_TICK_KEY = "last_live_tick_ms";

/**
 * Deploy-independent CATCH-UP heartbeat. The scheduler is in-process (setInterval),
 * so it dies whenever the web process restarts — a redeploy, a crash, or (what bit
 * us) a burst of rapid deploys that keeps restarting it. When that spans a kickoff,
 * the pre-match analysis/entry window is silently missed (the 2h cron gap in the
 * Orlando/EC-Juventude logs). This runs one full auto-cycle IFF none has been logged
 * within ~2× the tick interval — recovering a stalled cron promptly. It's called
 * from BOTH the in-process minute interval AND `/api/health` (which Render pings on
 * its own cadence), so even a wedged in-process scheduler gets driven as long as the
 * process is up. Behind the shared engine lock, so it never overlaps a real cycle;
 * a no-op when the cron is healthy (a recent full cycle exists). Returns whether it
 * actually ran a catch-up. */
export async function heartbeat(
  env: Record<string, string | undefined> = process.env,
  opts: { db?: ReturnType<typeof getDb>; nowMs?: number } = {},
): Promise<{ ran: boolean; reason?: string; live?: boolean }> {
  if ((env.AUTO_TICK ?? "false").toLowerCase() !== "true") return { ran: false, reason: "AUTO_TICK off" };
  const tickMin = Math.max(1, Number(env.TICK_INTERVAL_MIN ?? 30));
  const staleMs = Math.max(10, tickMin * 2) * 60_000; // overdue = no full cycle within ~2× the tick
  let db: ReturnType<typeof getDb>;
  try { db = opts.db ?? getDb(); } catch { return { ran: false, reason: "no db" }; }
  const nowMs = opts.nowMs ?? Date.now();

  // (1) LIVE catch-up — the money-critical path. While a match is IN PLAY, the fast loop
  // (LIVE_TICK_SEC) is what manages open positions; its silent death (a process restart,
  // a wedged setInterval, or an instance that was down and just came back) leaves stops /
  // take-profits / reassessment unrun. The loop stamps LAST_LIVE_TICK_KEY every run, so a
  // stale stamp means the loop isn't running: drive ONE live cycle right here. Because the
  // heartbeat is also called from /api/health, ANY ping (Render's own health check or an
  // external uptime monitor) then resumes live management within ~a stamp-interval — not
  // the 60-min full-cycle threshold below. The stamp is in the DB, so it survives the very
  // restart that kills the loop. Gated on the shared engine lock; a healthy loop keeps the
  // stamp fresh, so this no-ops (fresh) and never double-runs a real cycle.
  if (hasLiveMatchInPlay(db)) {
    const liveSec = Math.max(15, Number(env.LIVE_TICK_SEC ?? 20));
    const liveStaleMs = Math.max(90_000, liveSec * 1000 * 3); // overdue ≈ 3 missed live ticks (≥90s)
    const lastLiveMs = Number(R.metaGet(db, LAST_LIVE_TICK_KEY) ?? 0);
    if (!lastLiveMs || nowMs - lastLiveMs >= liveStaleMs) {
      const tok = tryAcquireEngine();
      if (tok) {
        const at = new Date(nowMs).toISOString();
        try {
          const provider = loadSportsProvider(loadSportsConfig(env));
          const r = await runLiveCycle(db, provider, {});
          R.metaSet(db, LAST_LIVE_TICK_KEY, String(nowMs), at);
          // Log only when the outage catch-up actually managed something (mirrors the live
          // loop's no-flood policy), tagged as a heartbeat-driven recovery.
          if (r.live > 0 && (r.triggers || r.exits || r.entries || r.llmFail)) {
            const llmNote = r.llmFail > 0 ? ` · ИИ-сбои ${r.llmFail}/${r.llmCalls}` : "";
            const summary = `[heartbeat] live catch-up (live-петля простаивала) · live ${r.live} · выходы ${r.exits} · входы ${r.entries}${llmNote}`;
            console.log(`[scheduler:heartbeat] ${summary}`);
            try { R.insertCronLog(db, { id: R.uid(), at, kind: "live", ok: r.llmFail > 0 ? 0 : 1, summary, created_at: at }); } catch {}
          }
          return { ran: true, live: true };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[scheduler:heartbeat:live] error:", msg);
          return { ran: false, reason: "error" };
        } finally { releaseEngine(tok); }
      }
      // busy → a real cycle already holds the lock; fall through to the full-cycle check.
    }
  }

  // (2) FULL-cycle catch-up — pre-match analysis/entries cadence for ALL matches.
  // Most recent FULL-cycle marker (tick/discover/heartbeat/manual) — the fast "live"
  // loop doesn't count, it doesn't do analysis/entries.
  const last = R.recentCronLog(db, 30).find((r) => r.kind !== "live");
  const lastMs = last ? Date.parse(last.created_at) : 0;
  if (lastMs && nowMs - lastMs < staleMs) return { ran: false, reason: "fresh" };
  const tok = tryAcquireEngine();
  if (!tok) return { ran: false, reason: "busy" }; // a real cycle is running → not stalled
  const at = new Date(nowMs).toISOString();
  try {
    const provider = loadSportsProvider(loadSportsConfig(env));
    const r = await runAutoCycle(db, provider, {}, { linkOdds: loadPolymarketConfig(env).enabled, discover: false });
    const summary = `[heartbeat] catch-up (крон простаивал с ${last?.created_at ?? "never"}) · sync ${r.synced} · анализ ${r.analyzed.length} · входы ${r.entered.length} · выходы ${r.exited.length}`;
    console.log(`[scheduler:heartbeat] ${summary}`);
    try { R.insertCronLog(db, { id: R.uid(), at, kind: "heartbeat", ok: r.llmFail > 0 ? 0 : 1, summary, created_at: at }); } catch {}
    return { ran: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[scheduler:heartbeat] error:", msg);
    try { R.insertCronLog(db, { id: R.uid(), at, kind: "heartbeat", ok: 0, summary: `ошибка: ${msg}`, created_at: at }); } catch {}
    return { ran: false, reason: "error" };
  } finally { releaseEngine(tok); }
}

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
      const llmNote = r.llmFail > 0 ? ` · ИИ-сбои ${r.llmFail}/${r.llmCalls}` : "";
      const summary = `sync ${r.synced} · discover ${r.discovered} · составы ${r.enriched} · котировки ${r.oddsUpdated} · анализ ${r.analyzed.length} · входы ${r.entered.length} · выходы ${r.exited.length}${llmNote}`;
      console.log(`[scheduler] ${summary}`);
      // Flag a pass with strategist outages as not-ok so the outage window is
      // visible at a glance in the cron journal (the France–Morocco 15-min budget
      // gap otherwise read as a normal quiet period).
      try { R.insertCronLog(db, { id: R.uid(), at, kind: discover ? "discover" : "tick", ok: r.llmFail > 0 ? 0 : 1, summary, created_at: at }); } catch {}
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
      // Prove the live loop is alive (DB-backed, survives restart) so the heartbeat can
      // tell a healthy loop from a stalled one and only drives a catch-up when this goes stale.
      try { R.metaSet(db, LAST_LIVE_TICK_KEY, String(Date.now()), new Date().toISOString()); } catch {}
      const provider = loadSportsProvider(loadSportsConfig(env));
      const r = await runLiveCycle(db, provider, {});
      // Log when something happened OR when the strategist was unreachable — an
      // outage during a live match is exactly what we need in the journal, even
      // though nothing was entered/exited that tick.
      if (r.live > 0 && (r.triggers || r.exits || r.entries || r.llmFail)) {
        const llmNote = r.llmFail > 0 ? ` · ИИ-сбои ${r.llmFail}/${r.llmCalls}` : "";
        const summary = `live ${r.live} · триггеры ${r.triggers} · котировки ${r.oddsUpdated} · выходы ${r.exits} · входы ${r.entries}${llmNote}`;
        console.log(`[scheduler:live] ${summary}`);
        try { R.insertCronLog(db, { id: R.uid(), at, kind: "live", ok: r.llmFail > 0 ? 0 : 1, summary, created_at: at }); } catch {}
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
  setInterval(() => void heartbeat(env), 60_000); // catch-up watchdog — recover a stalled cron within a minute of the process being alive
}
