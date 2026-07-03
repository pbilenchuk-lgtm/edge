// ============================================================
// EDGE LAB — one-shot scheduler tick for cron (ТЗ §5.2).
// The LLM-free background loop: (1) sync — import/categorize matches from
// linked competitions + refresh live status, (2) refreshOdds — re-quote every
// active match from Polymarket (mark-to-market; live engine may fire its own
// rate-limited price_move reassessments, §9.7). The expensive match ANALYSIS
// stays POINTWISE (per click) and is never triggered here.
// Run periodically:  SPORTS_ENABLED=true POLYMARKET_ENABLED=true npm run tick:once
// ============================================================
import { getDb } from "../src/lib/db.js";
import { loadSportsProvider, loadSportsConfig } from "../src/lib/sports.js";
import { loadPolymarketConfig } from "../src/lib/polymarket.js";
import { syncCompetitions, refreshActiveOdds } from "../src/lib/engine.js";

const db = getDb();

// (1) sync — only if a sports provider is enabled
const provider = loadSportsProvider(loadSportsConfig());
if (provider) {
  const linkOdds = loadPolymarketConfig().enabled;
  const synced = await syncCompetitions(db, provider, {}, { linkOdds });
  console.log(`✓ sync: ${synced.length} матч(ей), новых ${synced.filter((r) => r.created).length}`);
} else {
  console.log("· sync пропущен (SPORTS_ENABLED=false)");
}

// (2) refreshOdds — re-quote all active matches
const refreshed = await refreshActiveOdds(db, {});
const updated = refreshed.reduce((n, r) => n + r.updated, 0);
const reassess = refreshed.reduce((n, r) => n + r.reassessments, 0);
console.log(`✓ odds: ${refreshed.length} матч(ей) с изменениями, ${updated} снапшот(ов)${reassess ? `, ${reassess} переоценок` : ""}`);
for (const r of refreshed) {
  console.log(`  ${r.match.padEnd(34)} +${r.updated} цен${r.reassessments ? `  ${r.reassessments} переоценок` : ""}`);
}
