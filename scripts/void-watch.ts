// ============================================================
// EDGE LAB — VOID-RATE WATCH from the CLI.
// /api/health is the primary surface, but the worker container has no web server and no curl, so the sensor
// has to be readable where the operator actually is. Same builder, same numbers.
//   npm run void:watch [hours]
// ============================================================
import { openDbReadOnly, dbPath } from "../src/lib/db.js";
import { buildVoidWatch } from "../src/lib/voidWatch.js";

const hours = Number(process.argv[2]) || 24;
const r = buildVoidWatch(openDbReadOnly(dbPath()), hours);
console.log(`# ДОЛЯ ВОЗВРАТОВ · окно ${r.windowHours}ч · ${new Date().toISOString()}`);
console.log(`решённых ставок: ${r.decided} · возвратов: ${r.voids} · доля: ${r.voidPct ?? "—"}%`);
console.log(`причины: ${Object.entries(r.byReason).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
console.log(`вердикт: ${r.verdict}`);
console.log(r.note);
