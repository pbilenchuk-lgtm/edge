// ============================================================
// EDGE LAB — АУДИТ stale_book: врёт ли карантин про торгуемость  [W5 / batch-12, READ-ONLY]
//
// stale_book — крупнейший едок каталога (119 рынков в пачке; в худших матчах карантин закрывал 87% книг
// ДО выбора стратега). Правило метит книгу протухшей по возрасту без движения. Проверка обратной стороной:
// если цена рынка МЕНЯЛАСЬ в снапшотах внутри окна карантина — книга жила, метка ложная. Критерий объявлен
// в ТЗ до данных: mislabel-доля > 20% → рекалибровка freshness-порогов (гистерезис уже стоит и не трогается).
//
//   npm run stalebook:audit
// ============================================================
import { openDbReadOnly, dbPath } from "../src/lib/db.js";

const db = openDbReadOnly(dbPath());
const q = (s: string, ...a: any[]) => db.prepare(s).all(...a) as any[];

const eps = q(`SELECT match_id, text, created_at FROM trade_log WHERE text LIKE '%stale_book%' AND text LIKE '%карантин%' ORDER BY created_at DESC LIMIT 400`);
console.log(`# АУДИТ stale_book · ${new Date().toISOString()}`);
console.log(`БД: ${dbPath()} · эпизодов в выборке: ${eps.length} (последние 400)\n`);
console.log(`Критерий (объявлен до данных): цена двигалась в снапшотах ВНУТРИ окна карантина → метка ложная; доля ложных > 20% → рекалибровать freshness-пороги.\n`);

let checked = 0, mislabeled = 0; const examples: string[] = [];
for (const e of eps) {
  const lbl = /«([^»]+)»/.exec(e.text)?.[1]; if (!lbl) continue;
  const lift = q(`SELECT created_at FROM trade_log WHERE match_id=? AND text LIKE ? AND created_at > ? ORDER BY created_at LIMIT 1`, e.match_id, `zombie_lifted «${lbl}»%`, e.created_at)[0];
  const t1 = lift?.created_at ?? new Date(Date.parse(e.created_at) + 60 * 60_000).toISOString();
  const px = q(`SELECT DISTINCT price FROM markets WHERE match_id=? AND label=? AND snapshot_at > ? AND snapshot_at < ?`, e.match_id, lbl, e.created_at, t1);
  if (px.length === 0) continue;                 // нет снапшотов в окне — проверить нечем, в знаменатель не идёт
  checked++;
  if (px.length > 1) { mislabeled++; if (examples.length < 8) examples.push(`  ${e.created_at} «${lbl}»: ${px.length} разных цен внутри карантина (${px.map((x: any) => x.price).slice(0, 4).join("→")}…)`); }
}
const share = checked ? Math.round((1000 * mislabeled) / checked) / 10 : null;
console.log(`проверяемых эпизодов: ${checked} · с движением цены внутри карантина: **${mislabeled}** (${share ?? "—"}%)`);
for (const x of examples) console.log(x);
console.log();
if (checked < 20) console.log(`выборка мала (<20 проверяемых) — вердикт не читается, копим.`);
else if ((share ?? 0) > 20) console.log(`⚠ MISLABEL > 20%: карантин закрывает живые книги — рекалибровка freshness-порогов обоснована (решение о новых значениях — за владельцем, гистерезис не трогать).`);
else console.log(`метка честная: ложных ${share}% ≤ 20% — каталог ест не карантин, а сами книги. Пороги не трогаем.`);
