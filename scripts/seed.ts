// Seed the local SQLite DB from the reference mockup data.
// Run: npm run db:seed
import { getDb, dbPath } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import { listCompetitions, listStrategies, getTreasury } from "../src/lib/repo.js";

const db = getDb();
seedDatabase(db);

const comps = listCompetitions(db);
const strats = listStrategies(db);
const tr = getTreasury(db);

console.log(`✓ Seeded ${dbPath()}`);
console.log(`  treasury: $${tr.total_balance}`);
console.log(`  competitions: ${comps.length} (${comps.map((c) => c.name).join(", ")})`);
console.log(`  strategies: ${strats.length} (${strats.map((s) => s.name).join(", ")})`);
