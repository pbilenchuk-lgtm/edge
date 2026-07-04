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
    try {
      const db = getDb();
      const provider = loadSportsProvider(loadSportsConfig(env));
      const now = Date.now();
      const discover = now - lastDiscover >= discoverHr * 3_600_000;
      if (discover) lastDiscover = now;
      const r = await runAutoCycle(db, provider, {}, { linkOdds, discover });
      console.log(`[scheduler] sync ${r.synced} · discover ${r.discovered} · odds ${r.oddsUpdated} · analyze ${r.analyzed.length} · enter ${r.entered.length} · exit ${r.exited.length}`);
    } catch (e) {
      console.error("[scheduler] error:", e instanceof Error ? e.message : e);
    }
  };

  console.log(`[scheduler] on — tick ${tickMin}m, discover ${discoverHr}h`);
  setTimeout(run, 5_000);              // first pass shortly after boot (discovers)
  setInterval(run, tickMin * 60_000);  // then every tickMin
}
