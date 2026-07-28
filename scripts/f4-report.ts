// ============================================================
// EDGE LAB — F4: ФАКТ ПРОТИВ HOLD-TO-SETTLE, вердикт механический  [W3 / batch-12, READ-ONLY]
//
// Политика выхода меняется только зарегистрированным инструментом. Критерий стоит с батча-2 и зашит в
// модуль (CF_MIN_N=30, CF_EDGE_MARGIN=15% оборота): hold-to-settle превосходит факт на ≥15% оборота при
// n≥30 → exit-дизайн признаётся уничтожающим ценность, и ТОЛЬКО тогда включается TAKE_LADDER_SUSPEND=true.
// Вердикт читается механически — этот скрипт не даёт руками решить то, что должен решить порог.
//
//   npm run f4:report
// ============================================================
import { openDbReadOnly, dbPath } from "../src/lib/db.js";
import { buildPmvExitCounterfactual } from "../src/lib/pmvExitCounterfactual.js";

const db = openDbReadOnly(dbPath());
const r = buildPmvExitCounterfactual(db);

console.log(`# F4: ФАКТ vs HOLD-TO-SETTLE · ${new Date().toISOString()}`);
console.log(`БД: ${dbPath()} · критерий: n≥${r.criterion.minN} И delta/turnover ≥ ${r.criterion.edgeMarginPct}%\n`);
console.log(`n=${r.n} · оборот $${r.turnover} · факт $${r.totalActualPnl} · hold $${r.totalHoldPnl} · Δ $${r.totalDelta} (${r.deltaPctTurnover ?? "—"}% оборота)`);
console.log(`исключено: нерешаемых ${r.excluded.unresolvable} · без раннего выхода ${r.excluded.noEarlyExit} · незавершённых ${r.excluded.unfinished}`);
console.log(`max-профиль отдельной строкой: n=${r.maxLine.n} Δ $${r.maxLine.delta} (${r.maxLine.deltaPctTurnover ?? "—"}%)\n`);

const fired = r.n >= r.criterion.minN && (r.deltaPctTurnover ?? -Infinity) >= r.criterion.edgeMarginPct;
console.log(`## ВЕРДИКТ (механический)`);
if (r.n < r.criterion.minN)
  console.log(`  КОПИМ: n=${r.n} < ${r.criterion.minN} — руками не трогаем, лесенка остаётся как есть.`);
else if (fired)
  console.log(`  СРАБОТАЛ: hold превосходит факт на ${r.deltaPctTurnover}% оборота при n=${r.n} ≥ ${r.criterion.minN}.\n` +
    `  Действие по ратификации: TAKE_LADDER_SUSPEND=true в env + рестарт. Ревью через 2 недели по разделу ниже;\n` +
    `  откат-порог: отдано > взято → флаг выключить, лесенку вернуть.`);
else
  console.log(`  НЕ сработал: Δ ${r.deltaPctTurnover}% < ${r.criterion.edgeMarginPct}% при n=${r.n} — exit-дизайн ценность не уничтожает, лесенку не трогаем.`);

if (r.flaggedCells.length) {
  console.log(`\n## Ячейки над порогом (reason×family)`);
  for (const c of r.flaggedCells) console.log(`  ${c.reason} × ${c.family}: n=${c.n} Δ $${c.delta} (${c.deltaPctTurnover}%)`);
}

// ── Самоизмерение приостановленной лесенки (читается ПОСЛЕ включения флага) ──────────────────────
// Каждый melt_hold — момент, где раньше был бы срез. «Взято»: рынок дошёл до сеттла выше цены холда —
// удержание принесло (100−P)¢ на долю. «Отдано»: рынок умер — реверс стоил P¢ на долю. На $1 доли, без
// клейма о стейках: направление решает откат, не абсолют.
const holds = db.prepare(`SELECT t.match_id, t.text, t.created_at FROM trade_log t WHERE t.text LIKE '%melt_hold%' AND t.type='hold' ORDER BY t.created_at`).all() as any[];
console.log(`\n## Самоизмерение TAKE_LADDER_SUSPEND: melt_hold-строк ${holds.length}`);
if (!holds.length) console.log(`  пока пусто — флаг не включён или холдов не было. До включения флага этот раздел и должен быть пуст.`);
else {
  let taken = 0, given = 0, open = 0;
  for (const h of holds) {
    const mLbl = /«([^»]+)» melt_hold/.exec(h.text)?.[1]; const p = Number(/тек ([\d.]+)¢/.exec(h.text)?.[1]);
    if (!mLbl || !Number.isFinite(p)) continue;
    const bet = db.prepare(`SELECT status FROM bets WHERE match_id=? AND market_label=? AND status LIKE 'settled%' ORDER BY settled_at DESC LIMIT 1`).get(h.match_id, mLbl) as any;
    if (!bet) { open++; continue; }
    if (bet.status === "settled_won") taken += (100 - p) / 100; else if (bet.status === "settled_lost") given += p / 100;
  }
  console.log(`  взято при холде: $${taken.toFixed(2)}/долю · отдано на реверсах: $${given.toFixed(2)}/долю · ещё открыто: ${open}`);
  console.log(given > taken
    ? `  ⚠ ОТКАТ-ПОРОГ СРАБОТАЛ: отдано > взято — выключить TAKE_LADDER_SUSPEND, лесенку вернуть.`
    : `  порог отката не задет (взято ≥ отдано). Ревью — 2 недели с включения флага.`);
}
