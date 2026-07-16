// ─────────────────────────────────────────────────────────────────────────────
// EDGE LAB — token-flip poisoning count. Prints how many pre-fix tennis bets held the
// WRONG outcome's token (the Mrva–Roncadelli class), straight from the DB — no need to
// hunt for the [migrate] line in the deploy log.
//
//   npm run poison:count
//   (or, if it prints "маркер отсутствует" but you expect data:)
//   EDGE_DB_PATH=/app/data/edge-compact.db npm run poison:count
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "../src/lib/db.js";

const db = getDb();
const marker = db.prepare("SELECT value FROM app_meta WHERE key='migrate:tennis_token_flip_quarantine'").get() as { value?: string } | undefined;

const tot = (db.prepare("SELECT COUNT(*) n FROM bets WHERE strategy_id IN ('tennis_overreaction','tennis_set_value')").get() as { n: number }).n;
const poisoned = (db.prepare(`SELECT COUNT(*) n FROM bets WHERE strategy_id IN ('tennis_overreaction','tennis_set_value') AND entry_meta LIKE '%"tokenFlipPoisoned":true%'`).get() as { n: number }).n;

if (!marker) {
  console.log("⚠ Маркер миграции отсутствует — token-fix-m1 ещё не загружался на этой БД (деплой не прошёл?).");
} else {
  console.log(`Маркер миграции: ${marker.value}`);
}
console.log(`Теннисных сделок всего: ${tot}`);
console.log(`Из них ОТРАВЛЕНО (держали чужой токен, favourite = второй исход): ${poisoned}`);
console.log(poisoned === 0
  ? "→ N=0: отравления нет. Накопленная теннисная разметка чистая по стороне токена — B6/B2 можно калибровать по ней."
  : `→ N=${poisoned}: столько прошлых теннисных выводов (амплитуды recovery, «первый чистый цикл») частично на чужой стороне рынка — пере-собрать §4-распределение на эпохе token-fix-m1 перед калибровкой B6/B2.`);
