// ============================================================
// EDGE LAB — РЕТРО-ПОМЕТКА: привязка к чужому кругу  [dry по умолчанию]
//
// Ставит `settle_suspect` по ФАКТУ разрыва между замороженной датой события ESPN и кикоффом матча — для
// любого турнира и любого способа закрытия позиции. Догоняет то, что прежние две проверки пропускали: одна
// метила по перечню двухматчевых турниров (и не видела MLS), вторая жила в сеттл-пути (и не видела досрочно
// закрытых). Деньги не трогает вовсе — только флаг, по которому вердиктные срезы выбрасывают строку.
//
//   npm run leg:gap
//   npm run leg:gap -- --apply
// ============================================================
import { openDb, dbPath } from "../src/lib/db.js";
import { markLegGapSuspect, settleSuspectCount } from "../src/lib/footballIntegrity.js";

const apply = process.argv.includes("--apply");
const db = openDb(dbPath());
const r = markLegGapSuspect(db, process.env, { apply });

console.log(`# ПРИВЯЗКА К ЧУЖОМУ КРУГУ · ${new Date().toISOString()}`);
console.log(`БД: ${dbPath()} · режим: ${apply ? "**ПРИМЕНЕНИЕ**" : "сухой прогон"}\n`);
console.log(`привязанных матчей просмотрено: ${r.scanned} · с разрывом: **${r.mismatched}** · ставок ${apply ? "помечено" : "будет помечено"}: **${r.betsTagged}**\n`);
if (r.rows.length) {
  console.log(`| разрыв | кикофф | событие ESPN | ставок | матч |`);
  console.log(`|---|---|---|---|---|`);
  for (const x of r.rows) console.log(`| ${x.gapDays}д | ${x.kickoffAt ?? "—"} | ${x.eventDate ?? "—"} | ${x.betsTagged} | ${x.match} (${x.competition}) |`);
}
console.log(`\nвсего под карантином сейчас: ${settleSuspectCount(db)} решённых ставок`);
console.log(`Деньги не меняются: флаг лишь исключает строку из вердиктных срезов, чтобы решение по стратегии`);
console.log(`не опиралось на сделки, принятые по чужому матчу.`);
if (!apply && r.betsTagged) console.log(`\nПрименить: npm run leg:gap -- --apply`);
