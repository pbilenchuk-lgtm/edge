// ============================================================
// EDGE LAB — export the full log of one match to a markdown file.
//   npm run export:log -- "Shandong"            → ./match-log-<id>.md
//   npm run export:log -- "<matchId>" out.md    → custom path
// `match` may be a match id OR a case-insensitive team-name substring.
// Reads the SAME SQLite DB the app uses (EDGE_DB / default path), so run it
// against the live deployment's data.
// ============================================================
import { writeFileSync } from "node:fs";
import { getDb } from "../src/lib/db.js";
import { buildMatchLog, findMatch } from "../src/lib/matchLog.js";

const query = process.argv[2];
if (!query) { console.error("usage: npm run export:log -- \"<team name or matchId>\" [outfile.md]"); process.exit(1); }

const db = getDb();
const hit = findMatch(db, query);
if (!hit) { console.error(`✗ матч не найден по запросу: ${query}`); process.exit(2); }

const md = buildMatchLog(db, hit.id);
const out = process.argv[3] ?? `match-log-${hit.id}.md`;
writeFileSync(out, md, "utf8");
console.log(`✓ лог матча ${hit.id} → ${out} (${(md.length / 1024).toFixed(1)} KB)`);
