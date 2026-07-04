// ============================================================
// EDGE LAB — automated lifecycle tick for cron (ТЗ §3.3, §5.2).
// One pass of the whole loop: sync (import/categorize + live status + odds) →
// refresh odds (mark-to-market + rate-limited reassessments) → exits →
// auto-analyze eligible matches → paper-enter their proposals.
// Live Claude analysis needs a key (env ANTHROPIC_API_KEY or the Models
// screen); without one, analysis falls back / is skipped gracefully.
// Run periodically:  SPORTS_ENABLED=true POLYMARKET_ENABLED=true npm run tick:once
// ============================================================
import { getDb } from "../src/lib/db.js";
import { loadSportsProvider, loadSportsConfig } from "../src/lib/sports.js";
import { loadPolymarketConfig } from "../src/lib/polymarket.js";
import { runAutoCycle } from "../src/lib/lifecycle.js";

const db = getDb();
const provider = loadSportsProvider(loadSportsConfig());
if (!provider) console.log("· sync пропущен (SPORTS_ENABLED=false) — гоняю только котировки/анализ/цикл");

const r = await runAutoCycle(db, provider, {}, { linkOdds: loadPolymarketConfig().enabled });

console.log(`✓ sync: ${r.synced} матч(ей), новых ${r.imported}`);
console.log(`✓ Polymarket-дискавери: ${r.discovered} матч(ей) с рынками`);
console.log(`✓ odds: ${r.oddsMatches} с изменениями, ${r.oddsUpdated} снапшот(ов)`);
console.log(`✓ анализ: ${r.analyzed.filter((a) => a.ok).length}/${r.analyzed.length} матч(ей)`);
for (const a of r.analyzed) console.log(`    ${a.match.padEnd(34)} ${a.stage} ${a.ok ? `ok (${a.bets} ставок)` : "не удалось"}`);
console.log(`✓ входы: ${r.entered.length}`);
for (const e of r.entered) console.log(`    +${e.market} @ ${e.price}¢ ($${e.stake}) [${e.strategyId}]`);
console.log(`✓ выходы: ${r.exited.length}`);
for (const e of r.exited) console.log(`    −${e.market}: ${e.reason} · P&L ${e.pnl >= 0 ? "+" : ""}$${e.pnl.toFixed(2)} [${e.strategyId}]`);
