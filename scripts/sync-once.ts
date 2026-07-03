// ============================================================
// EDGE LAB — one-shot sync for a scheduler/cron (ТЗ §5.2, Этап 5).
// Imports + categorizes matches from linked competitions (ЧМ-2026 = fifa.world),
// refreshes live status, and attaches Polymarket odds to new matches.
// Run periodically:  SPORTS_ENABLED=true npm run sync:once
// ============================================================
import { getDb } from "../src/lib/db.js";
import { loadSportsProvider, loadSportsConfig } from "../src/lib/sports.js";
import { loadPolymarketConfig } from "../src/lib/polymarket.js";
import { syncCompetitions } from "../src/lib/engine.js";

const provider = loadSportsProvider(loadSportsConfig());
if (!provider) {
  console.log("SPORTS_ENABLED=false — включи спортивный провайдер, чтобы синхронизировать.");
  process.exit(0);
}

const db = getDb();
const linkOdds = loadPolymarketConfig().enabled;
const results = await syncCompetitions(db, provider, {}, { linkOdds });

console.log(`✓ sync: ${results.length} матч(ей), новых ${results.filter((r) => r.created).length}`);
for (const r of results) {
  console.log(`  ${r.competition.padEnd(8)} ${r.match.padEnd(34)} ${r.state}${r.created ? "  [новый]" : ""}${r.oddsLinked ? `  +${r.oddsLinked} рынков` : ""}`);
}
