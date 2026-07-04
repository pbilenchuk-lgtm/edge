// Seed the local SQLite DB. Default: clean production start (treasury + sports
// + strategy templates). SEED_DEMO=true seeds the full demo dataset instead.
// Run: npm run db:seed   (or SEED_DEMO=true npm run db:seed)
import { getDb, dbPath } from "../src/lib/db.js";
import { seedDatabase, seedMinimal } from "../src/lib/seed.js";
import { listCompetitions, listStrategies, getTreasury } from "../src/lib/repo.js";

const db = getDb();
if ((process.env.SEED_DEMO ?? "").toLowerCase() === "true") seedDatabase(db);
else seedMinimal(db);

const comps = listCompetitions(db);
const strats = listStrategies(db);
const tr = getTreasury(db);

console.log(`✓ Seeded ${dbPath()}`);
console.log(`  treasury: $${tr.total_balance}`);
console.log(`  competitions: ${comps.length} (${comps.map((c) => c.name).join(", ")})`);
console.log(`  strategies: ${strats.length} (${strats.map((s) => s.name).join(", ")})`);
