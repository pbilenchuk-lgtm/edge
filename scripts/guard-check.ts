// ============================================================
// EDGE LAB — ПРОВЕРКА ПОСЛЕ ДЕПЛОЯ: не режут ли новые гвардии живое  [READ-ONLY]
//
// Two things were just wired into the MONEY path, and both can only be trusted after they are looked at:
//   • sizing_insanity on football (a guard that BLOCKS entries — the one deploy in this batch that can cost
//     money by working too well);
//   • thesis_cap_clamp logging (a guard that only WRITES — it cannot block anything).
//
// The asymmetry is the point. A blocking guard deployed and never checked is a silent trading halt waiting to
// happen, so cut 1 is the reason this script exists; the rest is context for reading it. Cut 2 answers "could
// it even fire here?" BEFORE any trade has to prove it — and it deliberately reads the PAIR budget, not the
// competition budget: sizing works on floor(competition × pct/100), so a $8,000 category is eight $1,000 pairs,
// not one $8,000 position. Reading the category number would raise a false alarm on a healthy config.
//
//   npm run guard:check
// ============================================================
import { openDbReadOnly, dbPath } from "../src/lib/db.js";
import { buildRatifiedWatch, RATIFIED_ZERO_DAYS } from "../src/lib/ratifiedWatch.js";

const db = openDbReadOnly(dbPath());
const q = (s: string, ...a: any[]) => db.prepare(s).all(...a) as any[];
const bank = Number(process.env.THESIS_BANK_USD) || 0;
const SHARE = Number(process.env.SIZING_INSANITY_SHARE) || 0.5;
const MAX_POSITION_PCT = 0.08;   // widest profile (aggressive) — the only one that can approach a ceiling

console.log(`# ПРОВЕРКА ПОСЛЕ ДЕПЛОЯ · ${new Date().toISOString()}`);
console.log(`БД: ${dbPath()}`);
console.log(`банк объявлен: $${bank || "НЕ ЗАДАН"} · потолок одной позиции: ${bank ? "$" + Math.round(bank * SHARE) : "гвардия инертна"}\n`);

// ── 1. Ложные блокировки — единственный срез, требующий действия ────────────────────────────────
console.log(`## 1. sizing_insanity — блокировки входов`);
const live = q(`SELECT COUNT(*) n FROM reassessments WHERE body LIKE '%sizing_insanity%'`)[0].n;
const pre = q(`SELECT COUNT(*) n FROM analysis_artifacts WHERE kind='battle_sheet' AND content LIKE '%sizing_insanity%'`)[0].n;
console.log(`  живой путь (reassessments): ${live}`);
console.log(`  прематч (battle_sheet):     ${pre}`);
// A literal zero is the expected reading here, so it must NOT be printed as reassurance without saying what
// would change the verdict — the same fail-open trap that once printed an empty result as «заметно меньше».
console.log(live + pre === 0
  ? `  → НОЛЬ: гвардия стоит и ничего не блокирует. Читать как «ничего не сломано» можно только если торговля\n    в этом окне вообще шла — сверьтесь со срезом 3 ниже.`
  : `  → ⚠ ЕСТЬ БЛОКИРОВКИ. Решает РАЗМЕР в строках ниже: нормальные $30–170 = ложное срабатывание, порог\n    поднимается через SIZING_INSANITY_SHARE. Дикие $5k+ = гвардия только что остановила настоящий баг.`);
for (const r of q(`SELECT created_at, body FROM reassessments WHERE body LIKE '%sizing_insanity%' ORDER BY created_at DESC LIMIT 5`))
  console.log(`    ${r.created_at}  ${String(r.body).slice(0, 220)}`);

// ── 2. Может ли гвардия вообще сработать при текущем финансировании ─────────────────────────────
console.log(`\n## 2. Бюджеты ПАР против объявленного банка`);
const pairs = q(`SELECT c.name, s.strategy_id, s.risk_profile_id, CAST(c.budget * s.pct / 100 AS INT) AS pair_budget
                   FROM strategy_shares s JOIN competitions c ON c.id = s.competition_id
                  WHERE c.budget > 0 AND s.pct > 0 ORDER BY pair_budget DESC LIMIT 8`);
const danger = bank ? (bank * SHARE) / MAX_POSITION_PCT : Infinity;
for (const r of pairs)
  console.log(`  $${r.pair_budget}  ${r.name} · ${r.strategy_id}/${r.risk_profile_id}${r.pair_budget > danger ? "  ← МОЖЕТ упереться в потолок" : ""}`);
const worst = pairs[0]?.pair_budget ?? 0;
console.log(!bank
  ? `  банк не объявлен (THESIS_BANK_USD) — гвардия инертна, этот срез ничего не решает.`
  : `  гвардия способна сработать только при бюджете пары выше $${Math.round(danger)}; максимум сейчас — $${worst}.\n  ${worst > danger ? "⚠ есть пары выше порога — срез 1 читать особенно внимательно." : "→ запас есть, ложных блокировок быть не должно."}`);

// ── 3. Шла ли торговля вообще — иначе ноль в срезе 1 ничего не значит ───────────────────────────
console.log(`\n## 3. Торговля за последние 24ч (контекст для нуля выше)`);
const since = new Date(Date.now() - 24 * 3600_000).toISOString();
const opened = q(`SELECT COUNT(*) n FROM bets WHERE created_at >= ?`, since)[0].n;
console.log(`  новых ставок: ${opened}`);
console.log(opened === 0
  ? `  → торговли НЕ БЫЛО: ноль блокировок в срезе 1 — это отсутствие данных, а не доказательство. Повторить завтра.`
  : `  → торговля шла: ноль блокировок в срезе 1 действительно означает, что гвардия никому не помешала.`);

// ── 4. Кэп-клампы: ответ на вопрос Brann, копится вперёд ────────────────────────────────────────
console.log(`\n## 4. thesis_cap_clamp — подрезки тезисным кэпом`);
const clamps = q(`SELECT created_at, text FROM trade_log WHERE text LIKE '%thesis_cap_clamp%' ORDER BY created_at DESC LIMIT 10`);
console.log(`  строк всего: ${q(`SELECT COUNT(*) n FROM trade_log WHERE text LIKE '%thesis_cap_clamp%'`)[0].n}`);
for (const r of clamps) console.log(`    ${r.created_at}  ${String(r.text).slice(0, 220)}`);
if (!clamps.length)
  console.log(`  пусто. Сразу после деплоя это норма: строка пишется только при РЕАЛЬНОЙ подрезке заливки.\n` +
    `  Смысл появится через сутки-двое торговли. Пустота при живых стеках будет означать, что кэп не доезжает\n  до заливки — но отличить одно от другого раньше суток нельзя, и делать вид, что можно, не надо.`);

// ── 5. Превышения потолка в открытой книге ──────────────────────────────────────────────────────
console.log(`\n## 5. Открытые позиции больше половины банка`);
const big = q(`SELECT b.stake, b.market_label, b.risk_profile_id, b.strategy_id, b.created_at, m.home, m.away
                 FROM bets b JOIN matches m ON m.id=b.match_id
                WHERE b.status='open' AND b.stake > ? ORDER BY b.stake DESC LIMIT 10`, bank ? bank * SHARE : 1e9);
if (!big.length) console.log(bank ? `  ни одной — открытая книга в пределах банка.` : `  банк не объявлен — сравнивать не с чем.`);
for (const r of big) console.log(`    $${r.stake}  ${r.market_label}  [${r.risk_profile_id}/${r.strategy_id}]  ${r.home}—${r.away}  ${r.created_at}`);

// ── 6. Ратифицированные фичи: доказали ли ПЕРВОЕ срабатывание ───────────────────────────────────
// [Поправка 1, batch-12] Второй случай «ратифицировано и не работает»: Z2 не доезжал трижды, R1-хвост
// доехал мёртвым (сравнение с прозой вместо поля). Оба раза счётчик честно печатал ноль, и оба раза
// строка в отчёте никого не заставила копнуть — потому что строка не является действием. Теперь ноль
// дольше срока при ЖИВОЙ торговле — это задача-расследование, а не наблюдение.
const rw = buildRatifiedWatch(db);
console.log(`\n## 6. Ратифицированные фичи (срок доказательства ${RATIFIED_ZERO_DAYS()}д)`);
console.log(`  ставок с самой ранней ратификации: ${rw.tradedInWindow}`);
for (const r of rw.rows) {
  const mark = r.verdict === "РАССЛЕДОВАТЬ" ? "⚠ " : r.verdict === "работает" ? "✓ " : "  ";
  console.log(`  ${mark}${r.key.padEnd(22)} ${r.verdict.padEnd(14)} ${r.note}`);
}
console.log(`  ${rw.note}`);
if (rw.investigate.length) {
  console.log(`\n  ЗАВЕСТИ РАССЛЕДОВАНИЕ (каждая строка = отдельная задача, не наблюдение):`);
  for (const r of rw.investigate) console.log(`    - ${r.key}: ${r.what}`);
}
