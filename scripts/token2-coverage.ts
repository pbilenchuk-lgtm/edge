// ============================================================
// EDGE LAB — WHICH MARKETS HAVE NO COMPLEMENT POINTER  [ratified #2, MEASUREMENT ONLY]
//
// 44,255 of 119,839 market rows (37%) carry no token_second, which is what made the settle guard blind and
// cost 225 mis-booked bets. The fallback now covers it, but the fallback is a crutch: the supplier should be
// storing the pointer in the first place.
//
// The ratified order is measure, then fix — so this script deliberately changes NOTHING. Twice already in this
// project a plausible mechanism was acted on before measurement and the data disagreed (the batch-9 code-flip
// hypothesis; the batch-10 "slate congestion" that evaporated once the anchor lane existed). The suspicion
// here is ungrouped notations / derivatives, and the point of the script is to let that suspicion be wrong.
//
// Reading the supplier first narrows what to look for: polymarket.ts sets token2 = m.tokenIds[1], the
// complement WITHIN one Polymarket market (the No leg of «Under 3.5»), not the sibling market «Over 3.5».
// So a null means that market arrived with fewer than two token ids. Whether that is a market TYPE, a
// particular league, or a period of time is exactly what is unknown — hence the three cuts below.
//
// The last column is the one that decides the work: a market with no stored pointer BUT a findable in-match
// complement is already covered by the fallback, so it is a tidiness problem. A market with neither is a real
// hole — those bets can still only ever void.
//
//   npm run token2:coverage
// ============================================================
import { openDb, dbPath } from "../src/lib/db.js";
import { findComplementMarket } from "../src/lib/complementMarket.js";

const db = openDb(dbPath());

/** Coarse market family from the label — the same vocabulary the rest of the system reasons in. */
function family(label: string): string {
  const l = label.toLowerCase();
  if (/\bdraw\b|ничья/.test(l)) return "draw";
  if (/both teams to score|обе забьют/.test(l)) return "btts";
  if (/\(-?\d/.test(l)) return "handicap";
  if (/\bover\b|\bunder\b|\bтб\b|\bтм\b/.test(l)) return /^[a-zа-я].*\b(over|under)\b/i.test(l) && !/^(over|under)\b/i.test(l) ? "team_total" : "total";
  if (/—\s*(yes|no)|\byes\b|\bno\b/.test(l)) return "yes_no";
  return "other";
}

const rows = db.prepare(
  `SELECT m.label, m.match_id, m.token_second IS NOT NULL AS has2, m.external_ref, c.name AS comp, m.snapshot_at
     FROM markets m
     JOIN matches mt ON mt.id = m.match_id
     JOIN competitions c ON c.id = mt.competition_id`,
).all() as any[];

console.log(`# ПОКРЫТИЕ token_second · ${new Date().toISOString()}`);
console.log(`БД: ${dbPath()} · строк рынков: ${rows.length}`);
console.log(`\nИЗМЕРЕНИЕ, ничего не меняет. Решение по фиксу поставщика — после чтения.\n`);

// ── Cut 1: by family ─────────────────────────────────────────────────────────────────────────────
const byFam = new Map<string, { n: number; with2: number }>();
for (const r of rows) {
  const f = family(r.label);
  const e = byFam.get(f) ?? { n: 0, with2: 0 };
  e.n++; if (r.has2) e.with2++;
  byFam.set(f, e);
}
console.log(`## По семьям рынков`);
console.log(`| семья | всего | с указателем | БЕЗ | доля без |`);
console.log(`|---|---|---|---|---|`);
for (const [f, e] of [...byFam.entries()].sort((a, b) => (b[1].n - b[1].with2) - (a[1].n - a[1].with2))) {
  const miss = e.n - e.with2;
  console.log(`| ${f} | ${e.n} | ${e.with2} | **${miss}** | ${Math.round((1000 * miss) / e.n) / 10}% |`);
}

// ── Cut 2: by competition (is it a league/provider thing?) ───────────────────────────────────────
const byComp = new Map<string, { n: number; miss: number }>();
for (const r of rows) {
  const e = byComp.get(r.comp ?? "—") ?? { n: 0, miss: 0 };
  e.n++; if (!r.has2) e.miss++;
  byComp.set(r.comp ?? "—", e);
}
console.log(`\n## По турнирам (топ-12 по числу пропусков)`);
for (const [c, e] of [...byComp.entries()].sort((a, b) => b[1].miss - a[1].miss).slice(0, 12)) {
  console.log(`  ${e.miss}/${e.n} (${Math.round((1000 * e.miss) / e.n) / 10}%)  ${c}`);
}

// ── Cut 3: by age (did something change at a point in time?) ─────────────────────────────────────
const byDay = new Map<string, { n: number; miss: number }>();
for (const r of rows) {
  const d = String(r.snapshot_at ?? "").slice(0, 10) || "—";
  const e = byDay.get(d) ?? { n: 0, miss: 0 };
  e.n++; if (!r.has2) e.miss++;
  byDay.set(d, e);
}
console.log(`\n## По дням снимка (перелом во времени = смена поставщика/кода, а не тип рынка)`);
for (const [d, e] of [...byDay.entries()].sort().slice(-14)) {
  console.log(`  ${d}  ${e.miss}/${e.n} (${Math.round((1000 * e.miss) / e.n) / 10}%)`);
}

// ── The cut that decides the WORK ────────────────────────────────────────────────────────────────
// Sampled, not exhaustive: findComplementMarket needs every market of a match, and doing that for 120k rows
// would be minutes of work for a number that a sample answers just as well. The sample is stated so nobody
// reads it as a census.
console.log(`\n## Сколько из пропусков закрывает фолбэк (выборка матчей)`);
const missMatches = [...new Set(rows.filter((r) => !r.has2).map((r) => r.match_id))];
const sample = missMatches.slice(0, 200);
let covered = 0, real = 0, scanned = 0;
for (const mid of sample) {
  // LATEST SNAPSHOT PER LABEL — the same view the settle path uses (R.latestMarkets). The first version of
  // this script read raw `markets` rows, i.e. every historical snapshot, so one match yielded ~183 "markets"
  // and every label appeared dozens of times. findComplementMarket demands exactly ONE candidate (ambiguity
  // must not settle money), so the duplicates made it return null almost always and the script reported
  // «99.6% have no complement» — a fact about my query, not about the data. A measurement that reads
  // differently from the code it is measuring is worse than no measurement: it looks like evidence.
  const mkts = db.prepare(
    `SELECT label, external_ref, token_second FROM markets m
      WHERE match_id = ?
        AND snapshot_at = (SELECT MAX(snapshot_at) FROM markets x WHERE x.match_id = m.match_id AND x.label = m.label)
      GROUP BY label`,
  ).all(mid) as any[];
  for (const mk of mkts.filter((x) => !x.token_second)) {
    scanned++;
    if (findComplementMarket(mk.label, mkts)) covered++; else real++;
  }
}
console.log(`  матчей в выборке: ${sample.length} из ${missMatches.length} затронутых`);
console.log(`  рынков без указателя просмотрено: ${scanned}`);
console.log(`  из них фолбэк находит комплемент: **${covered}** (${scanned ? Math.round((1000 * covered) / scanned) / 10 : 0}%) — это вопрос опрятности, деньги уже защищены`);
console.log(`  комплемента нет нигде: **${real}** (${scanned ? Math.round((1000 * real) / scanned) / 10 : 0}%) — вот это настоящая дыра: такие ставки по-прежнему могут только войти в возврат`);
console.log(`\nЧитать так: если «нет нигде» близко к нулю — чинить поставщика можно спокойно, в свою очередь.`);
console.log(`Если заметная доля — это приоритет выше, потому что фолбэк её не закрывает.`);
