// ============================================================
// EDGE LAB — melting-option cut report (measurement slice).
//   Are we systematically cutting event-bets (team Over 0.5/1.5, BTTS-Yes) on the
//   bottom, right before the event lands? Reads the live DB, prints per-cut rows +
//   aggregates (occurred-after-cut fraction, missed delta) bucketed by cut minute.
//   npm run melt:report
// ============================================================
import { openDb, dbPath } from "../src/lib/db.js";
import { meltingOptionCutReport } from "../src/lib/meltReport.js";

const db = openDb(dbPath());
const rep = meltingOptionCutReport(db);

const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const c = (x: number | null) => (x == null ? "—" : `${x}¢`);

console.log(`\nMELTING-OPTION CUT REPORT  (resolved-YES threshold ${rep.occurredCents}¢)`);
console.log("=".repeat(72));
if (!rep.total) { console.log("Нет закрытых досрочно позиций тающих опционов — данных пока нет."); process.exit(0); }

console.log(`Всего срезов: ${rep.total} · с финальной ценой: ${rep.withFinal} · событие наступило после среза: ${rep.occurred} (${pct(rep.occurredFraction)})`);
console.log(`Средняя упущенная дельта (final − срез) там, где событие наступило: ${c(rep.avgMissedDeltaWhenOccurred)}`);

console.log("\nПо минуте среза:");
for (const b of rep.byBucket) {
  console.log(`  ${b.bucket.padEnd(6)} срезов ${String(b.cuts).padStart(3)} · наступило ${String(b.occurred).padStart(3)} (${pct(b.occurredFraction)}) · упущено в среднем ${c(b.avgMissedDeltaWhenOccurred)}`);
}
console.log("\nПо причине среза:");
for (const r of rep.byReason) console.log(`  ${r.reason.padEnd(18)} ${String(r.cuts).padStart(3)} · из них событие наступило ${r.occurred}`);

console.log("\nСрезы (по одной строке):");
for (const cut of rep.cuts.sort((a, b) => (a.cutMinute ?? 0) - (b.cutMinute ?? 0))) {
  const mark = cut.eventOccurred == null ? "?" : cut.eventOccurred ? "✔ событие" : "✘ не наступило";
  console.log(`  ${cut.home}–${cut.away} «${cut.market}» вход ${c(cut.entryCents)} → срез ${c(cut.cutCents)} на ${cut.cutMinute ?? "?"}' [${cut.reason}] · финал ${c(cut.finalCents)} ${mark} · упущено ${c(cut.missedDeltaCents)}`);
}
console.log("");
