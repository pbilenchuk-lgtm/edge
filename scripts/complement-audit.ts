// ============================================================
// EDGE LAB — RETRO-AUDIT OF COMPLEMENT-STARVED VOIDS  [batch-11, condition 5]
//
// Re-examines refunds that were issued only because the cross-check complement was never stored. DRY BY
// DEFAULT: it prints what would change and touches nothing. Pass --apply to rewrite, which is deliberately a
// separate, explicit act — re-settling rewrites booked history, and that must never happen as a side effect
// of looking.
//
//   npm run complement:audit             # report only
//   npm run complement:audit -- --apply  # actually re-settle
// ============================================================
import { openDb, dbPath } from "../src/lib/db.js";
import { auditComplementVoids } from "../src/lib/complementBackfill.js";
import { defaultResolveTokens } from "../src/lib/pmResolution.js";

const apply = process.argv.includes("--apply");
const db = openDb(dbPath());
const r = await auditComplementVoids(db, { resolveTokens: defaultResolveTokens({}) }, { apply });

console.log(`# РЕТРО-АУДИТ ВОЗВРАТОВ · ${apply ? "ПРИМЕНЕНИЕ" : "сухой прогон"} · ${new Date().toISOString()}`);
console.log(`БД: ${dbPath()}`);
console.log(`возвратов проверено: ${r.examined} · комплемент найден: ${r.complementFound} · пере-сеттлено: ${r.reSettled}`);
console.log(`  выигрышей ${r.won} / проигрышей ${r.lost} · Δ банка $${r.bankDeltaUsd.toFixed(2)}`);
console.log(r.note);
if (r.rows.length) {
  console.log(`\n| матч | рынок | исход | цена | ставка | Δ |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const x of r.rows) console.log(`| ${x.matchId.slice(0, 8)} | ${x.label} | ${x.outcome} | ${x.priceCents}¢ | $${x.stake} | $${x.deltaUsd.toFixed(2)} |`);
}
if (!apply && r.reSettled) console.log(`\nНичего не изменено. Применить: npm run complement:audit -- --apply`);
