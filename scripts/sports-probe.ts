// Live ESPN sports probe. Run: npm run sports:probe -- soccer eng.1
import { loadSportsConfig, EspnSportsProvider } from "../src/lib/sports.js";

const [, , sport = "football", league] = process.argv;
const cfg = { ...loadSportsConfig(), enabled: true };
const lg = league ?? cfg.leagues[sport] ?? "eng.1";
const provider = new EspnSportsProvider(cfg);

const matches = await provider.scoreboard(sport, lg);
console.log(`ESPN ${sport}/${lg}: ${matches.length} матч(ей)`);
for (const m of matches.slice(0, 12)) {
  console.log(`  [${m.state}] ${m.home} ${m.scoreHome ?? "-"}:${m.scoreAway ?? "-"} ${m.away}  ${m.minute != null ? m.minute + "'" : ""}  ${m.final ? "(final)" : ""}  ref=${m.externalRef}`);
}
console.log("\n✓ sports-probe OK");
