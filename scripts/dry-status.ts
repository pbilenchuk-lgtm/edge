// Owner check — the 24-48h dry-run contour checklist, read straight from the DB (no UI needed).
//   npx tsx scripts/dry-status.ts
// Prints the five acceptance points. Read-only; touches nothing.

import { getDb } from "../src/lib/db.js";
import * as RR from "../src/lib/realRepo.js";

const db = getDb();
const one = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any) ?? {};
const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];

console.log("═══ DRY-RUN CONTOUR STATUS ═══\n");

// (а) dry-ордера рождаются на paper-входах
const ord = one(`SELECT COUNT(*) n, SUM(status='filled') filled, SUM(status='partial') part, SUM(status='expired') exp, SUM(status='rejected') rej FROM real_orders`);
console.log(`(а) dry-ордера: всего ${ord.n||0} · filled ${ord.filled||0} · partial ${ord.part||0} · expired ${ord.exp||0} · rejected ${ord.rej||0}`);
console.log(`    ${(ord.n||0) > 0 ? "✓ рождаются" : "✗ НОЛЬ — см. диагностику ниже"}`);
// Диагностика нуля: были ли футбольные paper-входы вообще, и не сыпал ли mirror ошибками.
const fbOpen = one(`SELECT COUNT(*) n FROM bets b JOIN matches m ON m.id=b.match_id JOIN competitions c ON c.id=m.competition_id
  WHERE c.sport_id='football' AND b.status IN ('open','settled_won','settled_lost','settled_void') AND b.entry_price IS NOT NULL`);
const mirrorErr = one(`SELECT COUNT(*) n FROM trade_log WHERE text LIKE 'real-mirror:%'`);
console.log(`    футбольных paper-входов (сыграли/открыты): ${fbOpen.n||0} · ошибок mirror в логе: ${mirrorErr.n||0}`);
if ((ord.n||0) === 0) {
  if ((fbOpen.n||0) === 0) console.log(`    → входов ещё не было — тихий календарь, просто ждём (норма сразу после включения)`);
  else if ((mirrorErr.n||0) > 0) console.log(`    → ВХОДЫ БЫЛИ, но mirror сыпал ошибками — смотри их: SELECT text FROM trade_log WHERE text LIKE 'real-mirror:%' LIMIT 5`);
  else console.log(`    → ВХОДЫ БЫЛИ, ошибок нет, а ордеров 0 — mirror не вызывается или size=0 (нулевой edge). Копаем маршрутизацию.`);
}
console.log("");

// (б) реальные книги пусты (dry-тег в бою)
const realBal = RR.realLedgerBalance(db, true), realPos = RR.listRealPositions(db, true).length;
console.log(`(б) РЕАЛЬНЫЕ книги: balance $${realBal.toFixed(2)} · позиций ${realPos}`);
console.log(`    ${realBal === 0 && realPos === 0 ? "✓ пусты (dry-тег держит)" : "✗ ЕСТЬ РЕАЛЬНЫЕ ДАННЫЕ — этого быть не должно в dry-run!"}\n`);

// (в) fill-rate по категориям — «где книга нас филлит»
console.log(`(в) fill-rate по категориям (leg=entry):`);
const byCat = all(`SELECT m.competition_id cat, COUNT(*) tot, SUM(o.status IN ('filled','partial')) fill, SUM(o.status='expired') exp, SUM(o.status='rejected') rej
  FROM real_orders o JOIN matches m ON m.id=o.match_id WHERE o.leg='entry' GROUP BY m.competition_id ORDER BY tot DESC`);
if (!byCat.length) console.log("    (пока нет входов)");
for (const c of byCat) console.log(`    ${String(c.cat).padEnd(22)} fill ${Math.round(100*(c.fill||0)/c.tot)}%  (${c.fill||0}/${c.tot}) · expired ${c.exp||0} · rejected ${c.rej||0}`);
console.log(`    ожидание: ЧМ/топ-лиги филлятся, dust сыплет expired/rejected. Наоборот → подозреваем маршрутизацию, не рынок.\n`);

// (г) sweep закрывает за paper-близнецами — вечно открытых нет
const openDry = all(`SELECT p.token_id, p.size_shares FROM real_positions p WHERE p.dry=1 AND p.size_shares>0.01`);
const orphanOpen = all(`SELECT p.token_id FROM real_positions p WHERE p.dry=1 AND p.size_shares>0.01
  AND EXISTS (SELECT 1 FROM real_orders o JOIN bets b ON b.decision_id=o.decision_id
             WHERE o.token_id=p.token_id AND o.leg='entry' AND b.status IN ('settled_won','settled_lost','settled_void'))`);
console.log(`(г) открытых dry-позиций: ${openDry.length} · из них с УЖЕ settled близнецом: ${orphanOpen.length}`);
console.log(`    ${orphanOpen.length === 0 ? "✓ sweep закрывает — вечно открытых нет" : "✗ есть позиции с settled близнецом — sweep не отработал, проверь книгу на продажу"}\n`);

// (д) orphan-сторож и sticky-pause молчат
const pause = RR.getRealAutoPause(db), orphan = RR.getRealOrphanAlert(db);
console.log(`(д) sticky-pause: ${pause ? "⚠ АКТИВЕН — " + pause.reason : "✓ тихо"}`);
console.log(`    orphan-сторож: ${orphan ? "⚠ АКТИВЕН — " + orphan.message : "✓ тихо"}`);
console.log(`\nwhitelist версия: ${RR.currentWhitelistVersion(db)} · строк: ${RR.listWhitelist(db).length} (enabled: ${RR.listWhitelist(db, true).length})`);
