// ============================================================
// EDGE LAB — ПОКРЫТИЕ НОГИ CLV  [READ-ONLY, пункт 6 batch-12]
//
// Число, которое обязано быть прочитано ДО любого вердикта: на какой доле выборки CLV вообще ИЗМЕРИМ.
// Раньше CLV считался по `bets.closing_price`, а это не линия закрытия: при досрочном выходе там наша
// собственная цена выхода (тогда «CLV» = тот же P&L в центах, и всякая фиксация прибыли давала
// положительный CLV по построению), при расчёте по резолюции — цена разрешения (тогда «CLV» = исход).
// Покрытие было формально 100% и означало ничего.
//
// Теперь линия берётся из снимков котировок до конца матча, и там, где снимка нет, ответ — n/a. Этот отчёт
// показывает, сколько таких, и ПОЧЕМУ. Двуногий вердикт законен только при НУЛЕВОМ покрытии когорты.
//
//   npm run clv:coverage
// ============================================================
import { openDbReadOnly, dbPath } from "../src/lib/db.js";
import { betRecords } from "../src/lib/profileAnalytics.js";
import { CLV_MAX_LAG_MIN } from "../src/lib/clv.js";

const db = openDbReadOnly(dbPath());
const recs = betRecords(db).filter((r) => r.outcome !== "open");

console.log(`# ПОКРЫТИЕ CLV · ${new Date().toISOString()}`);
console.log(`БД: ${dbPath()} · окно линии: последний снимок не старше ${CLV_MAX_LAG_MIN()} мин до конца матча\n`);

if (!recs.length) {
  console.log("решённых записей нет — считать нечего.");
} else {
  const by = new Map<string, { n: number; line: number; noSnap: number; stale: number; noClock: number; amb: number }>();
  for (const r of recs) {
    const k = `${r.strategyId}/${r.phase}`;
    if (!by.has(k)) by.set(k, { n: 0, line: 0, noSnap: 0, stale: 0, noClock: 0, amb: 0 });
    const a = by.get(k)!;
    a.n++;
    if (r.clvSource === "closing_line") a.line++;
    else if (r.clvSource === "stale_snapshot") a.stale++;
    else if (r.clvSource === "no_match_clock") a.noClock++;
    else a.noSnap++;
  }
  console.log(`${"стратегия/фаза".padEnd(34)} ${"реш.".padStart(5)} ${"линия".padStart(6)} ${"%".padStart(6)}  нет снимка / протух / нет часов  неодн.выходы`);
  for (const [k, a] of [...by.entries()].sort((x, y) => y[1].n - x[1].n)) {
    const pct = Math.round((1000 * a.line) / a.n) / 10;
    console.log(`${k.padEnd(34)} ${String(a.n).padStart(5)} ${String(a.line).padStart(6)} ${String(pct).padStart(6)}  ${String(a.noSnap).padStart(10)} / ${String(a.stale).padStart(6)} / ${String(a.noClock).padStart(9)}  ${String(a.amb).padStart(11)}`);
  }
  const tot = recs.length, line = recs.filter((r) => r.clvSource === "closing_line").length;
  console.log(`\nвсего: ${line}/${tot} (${Math.round((1000 * line) / tot) / 10}%) записей с ИЗМЕРИМОЙ линией закрытия.`);
  console.log(line === 0
    ? `→ линии нет НИГДЕ: нога CLV = n/a, вердикты временно ДВУНОГИЕ (win-vs-рынок + P&L). Это не смягчение\n  порога — как только линия появится, нога вернётся третьей.`
    : line < tot
      ? `→ линия есть частично: нога CLV считается ПО НЕЙ на своей доле выборки. n/a для когорты незаконен —\n  «двух ног достаточно» основанием не является.`
      : `→ линия есть везде: вердикт полноценно трёхногий.`);
}
