// Owner operation — populate the real_whitelist for DRY-RUN with a BROAD football coverage:
// every football strategy × every football category (INCLUDING dust leagues), rowMax $50.
// Dry-run on thin books is the only safe place to MAP where fills are physically impossible with
// DATA, not belief — so we deliberately include the dust. Proportional sizing scales each order
// down regardless of the flat $50 cap. Versioned + journalled via addWhitelistRow (not raw SQL).
//
// Run in the Render Shell AFTER setting REAL_TRADING=dry_run:
//   npx tsx scripts/enable-dry-whitelist.ts
// Idempotent: re-running skips strategies already whitelisted (prints what it did).

import { getDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import * as RR from "../src/lib/realRepo.js";
import { addWhitelistRow } from "../src/lib/executor/whitelist.js";

const db = getDb();
const now = new Date().toISOString();

const strategies = R.listStrategies(db, "football");
const categories = R.listCompetitions(db).filter((c) => c.sport_id === "football").map((c) => c.id);

if (!strategies.length) { console.log("нет футбольных стратегий — нечего добавлять"); process.exit(0); }
if (!categories.length) { console.log("нет футбольных категорий (competitions) — нечего добавлять"); process.exit(0); }

const already = new Set(RR.listWhitelist(db).map((r) => r.strategy_id));
let added = 0;
for (const s of strategies) {
  if (already.has(s.id)) { console.log(`= пропуск ${s.id} (уже в whitelist)`); continue; }
  const res = addWhitelistRow(db, { strategyId: s.id, categories, maxOrderUsd: 50, enabled: true }, "owner", now);
  if (res.ok) { added++; console.log(`+ ${s.id} × ${categories.length} категорий @ $50 → whitelist v${res.version}`); }
  else console.log(`! ${s.id}: ${res.error}`);
}

console.log(`\nготово: добавлено ${added} стратегий; whitelist версия = ${RR.currentWhitelistVersion(db)}`);
console.log(`категории (${categories.length}): ${categories.join(", ")}`);
console.log(`\nПроверка: REAL_TRADING=${process.env.REAL_TRADING ?? "(не задано!)"} · REAL_BANK_USD=${process.env.REAL_BANK_USD ?? "400 (дефолт)"}`);
