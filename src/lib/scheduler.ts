// ============================================================
// EDGE LAB — in-process scheduler (the cron). Runs the automated lifecycle on
// an interval inside the server process, so it shares the SQLite DB. Opt-in via
// AUTO_TICK=true. Two cadences (ТЗ §4.1 timing):
//   - TICK every TICK_INTERVAL_MIN (default 30): odds refresh, clocks, exits,
//     analyze (12h/lineup gated), enter. No discovery.
//   - DISCOVER every DISCOVER_INTERVAL_HR (default 24): parse Polymarket for the
//     next 7 days of matches. Runs on the first tick, then daily.
// Live Claude analysis needs a key (env ANTHROPIC_API_KEY or the Models screen).
// ============================================================

import { getDb } from "./db.js";
import * as R from "./repo.js";
import { loadSportsProvider, loadSportsConfig } from "./sports.js";
import { loadPolymarketConfig } from "./polymarket.js";
import { runAutoCycle } from "./lifecycle.js";

let started = false;

export function startScheduler(env: Record<string, string | undefined> = process.env): void {
  if (started) return;
  if ((env.AUTO_TICK ?? "false").toLowerCase() !== "true") return;
  started = true;
  const tickMin = Math.max(1, Number(env.TICK_INTERVAL_MIN ?? 30));
  const discoverHr = Math.max(1, Number(env.DISCOVER_INTERVAL_HR ?? 24));
  const linkOdds = loadPolymarketConfig(env).enabled;
  let lastDiscover = 0;

  const run = async () => {
    const db = getDb();
    const nowMs = Date.now();
    const discover = nowMs - lastDiscover >= discoverHr * 3_600_000;
    const at = new Date(nowMs).toISOString();
    try {
      const provider = loadSportsProvider(loadSportsConfig(env));
      if (discover) lastDiscover = nowMs;
      const r = await runAutoCycle(db, provider, {}, { linkOdds, discover });
      const summary = `sync ${r.synced} · discover ${r.discovered} · составы ${r.enriched} · котировки ${r.oddsUpdated} · анализ ${r.analyzed.length} · входы ${r.entered.length} · выходы ${r.exited.length}`;
      console.log(`[scheduler] ${summary}`);
      try { R.insertCronLog(db, { id: R.uid(), at, kind: discover ? "discover" : "tick", ok: 1, summary, created_at: at }); } catch {}
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[scheduler] error:", msg);
      try { R.insertCronLog(db, { id: R.uid(), at, kind: discover ? "discover" : "tick", ok: 0, summary: `ошибка: ${msg}`, created_at: at }); } catch {}
    }
  };

  console.log(`[scheduler] on — tick ${tickMin}m, discover ${discoverHr}h`);
  setTimeout(run, 5_000);              // first pass shortly after boot (discovers)
  setInterval(run, tickMin * 60_000);  // then every tickMin
}
