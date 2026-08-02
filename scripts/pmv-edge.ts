// ============================================================
// EDGE LAB — ИССЛЕДОВАНИЕ: ЕСТЬ ЛИ У PMV КРАЙ  [READ-ONLY]
//
// Печатает гипотезу и критерий ПЕРВЫМИ, до единой цифры — чтобы отчёт нельзя было прочитать задом наперёд,
// подобрав вывод под понравившееся число. Рядом выводится уже существующий Brier-критерий: он отвечает на
// соседний вопрос (калибрована ли модель в среднем), и два ответа полезно видеть вместе — расхождение между
// ними само по себе информация.
//
//   npm run pmv:edge
// ============================================================
import { openDbReadOnly, dbPath } from "../src/lib/db.js";
import { buildPmvEdgeReport, PMV_EDGE_NEED_N } from "../src/lib/pmvEdge.js";
import { buildPmvShadowCalibration } from "../src/lib/tennisPmvShadow.js";

const db = openDbReadOnly(dbPath());
const rep = buildPmvEdgeReport(db);

console.log(`# ЕСТЬ ЛИ У PMV КРАЙ · ${new Date().toISOString()}`);
console.log(`БД: ${dbPath()} · комиссия тейкера: ${(rep.feeRate * 100).toFixed(1)}%\n`);

console.log(`## Гипотеза и критерий (объявлены в коде до чтения данных)`);
console.log(`  ${rep.hypothesis.h0}`);
console.log(`  ${rep.hypothesis.h1}`);
console.log(`  КРИТЕРИЙ: ${rep.hypothesis.criterion}`);
console.log(`  ОГОВОРКА: ${rep.hypothesis.antiPeek}\n`);

console.log(`## Сколько накоплено`);
console.log(`  всего сигналов: ${rep.counts.total} · разрешено: **${rep.counts.resolved}** · ждут матча: ${rep.counts.pending} · возврат: ${rep.counts.void} · не разрешились: ${rep.counts.unresolved}`);
console.log(`  в расчёт вошло: ${rep.n} (вырожденные цены 0¢/100¢ исключены явно)`);
console.log(`  зрелость: ${rep.matured ? `ДА (${rep.n} ≥ ${PMV_EDGE_NEED_N})` : `НЕТ — ${rep.n}/${PMV_EDGE_NEED_N}`}\n`);

console.log(`## Главный ответ: контрфактический P&L на $1 ставки по замороженному mid`);
if (rep.n === 0) {
  console.log(`  считать не на чем — ни одного разрешённого сигнала.`);
} else {
  console.log(`  до комиссии:    $${rep.grossPerDollar}  ← есть ли сигнал вообще`);
  console.log(`  ПОСЛЕ комиссии: $${rep.netPerDollar}  ← единственное число, по которому решается «торговать или нет»`);
  if (rep.ci) console.log(`  95% бутстрап-интервал нетто: [${rep.ci.lo}; ${rep.ci.hi}]${rep.ci.lo > 0 ? "  — целиком выше нуля" : rep.ci.hi < 0 ? "  — целиком НИЖЕ нуля" : "  — накрывает ноль"}`);
  const cost = rep.grossPerDollar != null && rep.netPerDollar != null ? Math.round((rep.grossPerDollar - rep.netPerDollar) * 10000) / 10000 : null;
  if (cost != null) console.log(`  цена исполнения: $${cost} на доллар — ровно та величина, ради которой писался net-EV гейт.`);
}

console.log(`\n## По величине отклонения (ОПИСАТЕЛЬНО — не основание выбирать порог)`);
if (!rep.buckets.length) console.log(`  пусто.`);
else {
  console.log(`| бакет | n | факт. win% | средний mid | до комиссии | после |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const b of rep.buckets)
    console.log(`| ${b.label} | ${b.n} | ${b.winPct}% | ${b.midMeanPct}¢ | $${b.grossPerDollar} | $${b.netPerDollar} |`);
  console.log(`\n  Читать так: если край реален, он должен РАСТИ с отклонением — большое расхождение theo и mid`);
  console.log(`  обязано означать больше информации. Плоская или падающая картина означает, что отбор по`);
  console.log(`  отклонению не работает, и тогда никакой порог net-EV не спасёт: он отбирает по той же оси.`);
}

console.log(`\n## Вердикт`);
console.log(`  ${rep.verdict.toUpperCase()}`);
console.log(`  ${rep.note}`);

// ── Соседний критерий: калибровка (Brier), уже существовавший ────────────────────────────────────
const cal = buildPmvShadowCalibration(db);
console.log(`\n## Для сверки: Brier-критерий (калибровка в среднем, НЕ край на хвосте)`);
console.log(`  разрешено ${cal.scored}/${cal.criterion.needN} · Brier модели ${cal.brierMarkov ?? "—"} vs рынка ${cal.brierImplied ?? "—"} · вердикт: ${cal.verdict}`);
console.log(`  ${cal.note}`);
if (cal.biasFlags.length) { console.log(`  измеренные крены сторон:`); for (const f of cal.biasFlags) console.log(`    - ${f}`); }
console.log(`\n  Два критерия отвечают на РАЗНЫЕ вопросы и могут разойтись. «Калибрована, но края нет» —`);
console.log(`  нормальный и частый исход: модель верно оценивает средний случай, а торгуем мы хвост.`);
console.log(`  «Край есть, но калибровка хуже рынка» — повод искать ошибку в измерении, а не радоваться.`);
