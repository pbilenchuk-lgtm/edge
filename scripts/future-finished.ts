// ============================================================
// EDGE LAB — ПОЧИНКА: матч помечен сыгранным до собственного кикоффа  [dry по умолчанию]
//
// Разовая чистка данных, испорченных ДО появления двухматчевого гейта. Сухой прогон печатает, что будет
// сделано, и ничего не меняет; --apply чинит. Каждая такая запись — это слейт, который система не торговала
// вовсе, поэтому цена ошибки здесь не «неточный отчёт», а простой.
//
//   npm run future:finished           # посмотреть
//   npm run future:finished -- --apply
// ============================================================
import { openDb, dbPath } from "../src/lib/db.js";
import { repairFutureFinished } from "../src/lib/futureFinished.js";

const apply = process.argv.includes("--apply");
const db = openDb(dbPath());
const r = repairFutureFinished(db, { apply });

console.log(`# МАТЧИ, «СЫГРАННЫЕ» ДО КИКОФФА · ${new Date().toISOString()}`);
console.log(`БД: ${dbPath()} · режим: ${apply ? "**ПРИМЕНЕНИЕ**" : "сухой прогон"}\n`);
console.log(`просмотрено матчей: ${r.scanned} · испорчено: **${r.broken}** · сброшено: ${r.reset} · пропущено с деньгами: ${r.skippedWithMoney}\n`);

if (r.rows.length) {
  console.log(`| кикофф | состояние | мин | счёт | привязка ESPN | разрыв | ставок реш./откр. | действие | матч |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  for (const x of r.rows)
    console.log(`| ${x.kickoffAt} | ${x.state} | ${x.minute ?? "—"} | ${x.scoreHome ?? "—"}:${x.scoreAway ?? "—"} | ${x.boundEventDate ?? "—"} (записано ${x.boundAt ?? "—"}) | ${x.legGapDays ?? "—"}д | ${x.settledBets}/${x.openBets} | ${x.action} | ${x.home}—${x.away} (${x.competition}) |`);
}
console.log(`\n${r.note}`);
if (!apply && r.broken > r.skippedWithMoney) console.log(`\nПрименить: npm run future:finished -- --apply`);
