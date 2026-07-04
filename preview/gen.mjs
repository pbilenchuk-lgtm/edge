// Build a REAL dataset for the self-contained preview: real ESPN football
// (live World Cup) with real lineups/events, real Polymarket tennis odds, a
// full auto-cycle (Claude analysis → entries → strategist reassessment on live
// triggers → a take-profit exit), then serialize buildAppData to preview/data.json.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
process.env.SPORTS_ENABLED = "true";
process.env.POLYMARKET_ENABLED = "true";
process.env.EDGE_DB_PATH = join(mkdtempSync(join(tmpdir(), "edge-prev-")), "p.db");

const { getDb } = await import("../src/lib/db.js");
const { seedDatabase } = await import("../src/lib/seed.js");
const { loadSportsProvider, loadSportsConfig } = await import("../src/lib/sports.js");
const { loadPolymarketConfig } = await import("../src/lib/polymarket.js");
const { syncCompetitions, linkMatchOdds } = await import("../src/lib/engine.js");
const { runAutoCycle, evaluateExits } = await import("../src/lib/lifecycle.js");
const { buildAppData } = await import("../src/lib/view.js");
const R = await import("../src/lib/repo.js");

const db = getDb();
seedDatabase(db);
for (const t of ["trade_log", "reassessments", "bets", "markets", "assessments", "analysis_jobs", "match_events", "match_live", "matches"]) db.exec(`DELETE FROM ${t}`);
R.setAnalyticsModel(db, "football", "Claude Opus 4.8");
R.setAnalyticsModel(db, "tennis", "Claude Opus 4.8");

const provider = loadSportsProvider(loadSportsConfig());

// 1) real football from ESPN (live World Cup), with odds where Polymarket has them
await syncCompetitions(db, provider, {}, { linkOdds: loadPolymarketConfig().enabled });

// 2) real tennis with Polymarket odds
const tn = R.listCompetitions(db).find((c) => c.sport_id === "tennis");
for (const [h, a] of [["Vladyslav Orlov", "Stefan Popovic"], ["Anja Stankovic", "Nina Radovanovic"], ["Carl Emil Overbeck", "Sebastian Dominko"]]) {
  const id = R.uid();
  R.insertMatch(db, { id, competition_id: tn.id, home: h, away: a, state: "lineup", lineup_out: true, kickoff_at: "через 40 мин", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "pm-" + id });
  await linkMatchOdds(db, R.getMatch(db, id), "tennis", {});
}

// 3) full auto-cycle WITH the real provider: enrich from ESPN (real lineups +
//    live events), analyze (Claude), enter, strategist-reassess on real triggers.
const r = await runAutoCycle(db, provider, {}, { discover: false });
console.log(`enriched: ${r.enriched} | triggers: ${r.triggers} | analyzed: ${r.analyzed.filter((a) => a.ok).length} | entered: ${r.entered.length} | reassessEntries: ${r.reassessEntries.length} | exited: ${r.exited.length}`);

// 4) simulate a favorable move on one open position → take-profit exit (a closed trade + feed entry)
const open = R.listCompetitions(db).flatMap((c) => R.listMatches(db, c.id)).flatMap((m) => R.betsForMatch(db, m.id)).filter((b) => b.status === "open");
if (open.length) {
  const b = open[0];
  R.insertMarket(db, { id: R.uid(), match_id: b.match_id, label: b.market_label, price: Math.min(97, Math.round((b.ai_prob ?? 0.6) * 100 + 8)), ai_prob: b.ai_prob, liquidity: null, external_ref: "t", snapshot_at: "t2", is_closing: false });
  const ex = evaluateExits(db, {});
  console.log("take-profit exits:", ex.length);
}

const data = buildAppData(db, {});
writeFileSync("preview/data.json", JSON.stringify(data));
const allM = R.listCompetitions(db).flatMap((c) => R.listMatches(db, c.id));
console.log(`\ndataset: ${allM.length} matches, ${allM.filter((m) => R.latestMarkets(db, m.id).length).length} with odds, ${allM.filter((m) => R.assessmentsForMatch(db, m.id).some((a) => a.status === "ok")).length} analyzed, open positions: ${R.openBets(db).length}`);
const withLineups = allM.filter((m) => R.getMatchLive(db, m.id)?.home_lineup).length;
const withEvents = allM.filter((m) => R.eventsForMatch(db, m.id).length).length;
console.log(`real lineups on: ${withLineups} matches, real events on: ${withEvents} matches`);
