// ============================================================
// EDGE LAB — global shadow-budget log (CLI). Prints the whole capital-disposition
// history across all matches: config, pool, roll-up, projection, breakdowns, and
// the full decision ledger. Raw material for optimising caps/buffer before real money.
//   npm run shadow:report            # to stdout
//   npm run shadow:report > shadow-log.md
// ============================================================
import { openDb, dbPath } from "../src/lib/db.js";
import { buildShadowLog } from "../src/lib/shadowLog.js";

const db = openDb(dbPath());
console.log(buildShadowLog(db));
