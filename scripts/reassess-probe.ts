// Live end-to-end probe: ESPN enrich → matchContext → strategist reassess.
// Run: npm run reassess:probe -- fifa.world "Colombia" "Ghana"
import { readFileSync } from "node:fs";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { loadSportsConfig, EspnSportsProvider } from "../src/lib/sports.js";
import { enrichFromEspn } from "../src/lib/engine.js";
import { matchContext } from "../src/lib/analysis.js";
import { strategistReassess } from "../src/lib/lifecycle.js";

const [, , league = "fifa.world", home = "Colombia", away = "Ghana"] = process.argv;
const now = () => new Date().toISOString();

// Load the temp key from .env.local (gitignored) — not committed anywhere.
const envLocal = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const env = { ANTHROPIC_API_KEY: envLocal.ANTHROPIC_API_KEY };

const db = openDb(":memory:");
seedDatabase(db); // gives us seeded football strategies
const cfg = { ...loadSportsConfig(), enabled: true };
const provider = new EspnSportsProvider(cfg);

// A funded WC competition linked to the ESPN league, one strategy with a share.
const compId = R.uid();
R.upsertCompetition(db, { id: compId, sport_id: "football", name: "Мундиаль", budget: 1000, external_league: league, created_at: now() });
const strat = R.listStrategies(db, "football")[0];
if (!strat) throw new Error("no seeded football strategy — run against a seeded schema");
R.setShare(db, { competition_id: compId, strategy_id: strat.id, pct: 100 });

// The match, priced with a couple of live markets carrying a model probability.
const mid = R.uid();
R.insertMatch(db, { id: mid, competition_id: compId, home, away, state: "live", lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid });
for (const [label, price, prob] of [[`${home} победа`, 45, 0.62], ["Тотал больше 2.5", 55, 0.5], [`${away} победа`, 30, 0.2]] as const) {
  R.insertMarket(db, { id: R.uid(), match_id: mid, label, price, ai_prob: prob, liquidity: null, external_ref: "probe", snapshot_at: now(), is_closing: false });
}

console.log(`\n=== 1) enrichFromEspn (${league}) ===`);
const enrich = await enrichFromEspn(db, provider, { now });
console.log(`enriched=${enrich.enriched}  newEvents=${enrich.newEvents.length}`);
for (const e of enrich.newEvents.slice(0, 8)) console.log(`  • ${e.minute ?? "?"}' ${e.type} — ${e.text}`);
const m = R.getMatch(db, mid)!;
console.log(`match: state=${m.state} score=${m.score_home}:${m.score_away} lineup_out=${m.lineup_out}`);

console.log(`\n=== 2) matchContext (fed to the prompts) ===`);
console.log(matchContext(db, mid) ?? "(нет контекста)");

console.log(`\n=== 3) strategistReassess (real LLM, trigger=${mid}) ===`);
const res = await strategistReassess(db, { now, env }, { newEventMatchIds: new Set([mid]), max: 4 });
console.log(`exits=${res.exits.length}  entries=${res.entries.length}`);
for (const en of res.entries) console.log(`  ENTER «${en.market}» $${en.stake}`);
for (const ex of res.exits) console.log(`  EXIT  «${ex.market}» ${ex.reason} P&L ${ex.pnl}`);
const proposed = R.betsForMatch(db, mid, strat.id).filter((b) => b.status === "proposed");
for (const b of proposed) console.log(`  proposed: «${b.market_label}» $${b.stake} — ${b.rationale}`);

console.log("\n✓ reassess-probe OK");
