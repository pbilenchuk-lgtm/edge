// Owner diagnostic — WHY did N football paper entries produce 0 dry orders?
//   npx tsx scripts/dry-diagnose.ts
// Read-only. Replays the mirror's short-circuit gates (whitelist.ts mirrorPaperEntryToReal) for every
// filled football paper entry and tallies the FIRST gate that skipped it — so a silent whitelist-miss
// or a size-0 becomes a number, not a guess. Names the exact categories the frozen whitelist misses.

import { getDb } from "../src/lib/db.js";
import * as RR from "../src/lib/realRepo.js";
import { matchWhitelist, realSizeFromFraction, dryVirtualFreeUsd } from "../src/lib/executor/whitelist.js";
import { getProfileConfig } from "../src/lib/riskConfig.js";

const db = getDb();
const env = process.env;
const wl = RR.listWhitelist(db, true); // enabled only — same as matchWhitelist
const wlStrategies = new Set(wl.map((r) => r.strategy_id));
const realFree = dryVirtualFreeUsd(db, env);

console.log(`═══ DRY-MIRROR DIAGNOSE ═══`);
console.log(`whitelist v${RR.currentWhitelistVersion(db)} · enabled строк ${wl.length} · стратегии: ${[...wlStrategies].join(", ") || "(нет)"}`);
console.log(`REAL_TRADING=${env.REAL_TRADING ?? "(off)"} · dry virtual free=$${realFree.toFixed(2)}\n`);

// Every filled football paper entry (same population dry-status counts under (а)).
const bets = db.prepare(
  `SELECT b.id, b.strategy_id, b.risk_profile_id, b.ai_prob, b.entry_price, b.decision_id, b.created_at,
          m.competition_id AS cat, c.name AS cat_name
   FROM bets b JOIN matches m ON m.id=b.match_id JOIN competitions c ON c.id=m.competition_id
   WHERE c.sport_id='football' AND b.status IN ('open','settled_won','settled_lost','settled_void')
     AND b.entry_price IS NOT NULL`,
).all() as any[];

// decision_id health — Phase A (16:04 UTC 2026-07-15) added the column with NO backfill, so bets born
// earlier are null forever. This split tells historical-artifact (self-heals on new entries) from a
// live bug (new bets STILL null → the deployed insert path isn't minting).
const withId = bets.filter((b) => b.decision_id);
const nullId = bets.filter((b) => !b.decision_id);
const range = (rows: any[]) => rows.length ? `${(rows.map((r) => r.created_at).sort()[0] || "").slice(0, 16)} … ${(rows.map((r) => r.created_at).sort().slice(-1)[0] || "").slice(0, 16)}` : "—";
console.log(`decision_id: есть у ${withId.length} · NULL у ${nullId.length}`);
console.log(`  NULL (до Phase A): ${range(nullId)}`);
console.log(`  есть (после):      ${range(withId)}`);
console.log(withId.length === 0 ? `  → все входы дозеркальной эпохи. Новый вход после 16:04 UTC 15.07 → появится decision_id → зеркалит.\n`
  : `  → есть входы с decision_id — happy-path должен работать; если ордеров 0, копаем place()/tokenId.\n`);

const tally: Record<string, number> = { strategy_miss: 0, category_miss: 0, size_zero: 0, no_decision: 0, would_mirror: 0 };
const missCats = new Map<string, { name: string; n: number }>();
let wouldSizeSum = 0;

for (const b of bets) {
  if (!wlStrategies.has(b.strategy_id)) { tally.strategy_miss++; continue; }
  const row = matchWhitelist(db, { strategyId: b.strategy_id, categoryId: b.cat });
  if (!row) {
    tally.category_miss++;
    const e = missCats.get(b.cat) ?? { name: b.cat_name ?? b.cat, n: 0 }; e.n++; missCats.set(b.cat, e);
    continue;
  }
  // Replay the size calc (sizeFraction path = shadow intensity, recomputed from ai_prob vs entry).
  const pp = (b.entry_price ?? 0) / 100, ourP = b.ai_prob ?? 0;
  const kEdge = pp > 0 && pp < 1 ? (ourP - pp) / (1 - pp) : 0;
  const pcfg = getProfileConfig(db, b.risk_profile_id ?? "medium");
  const kFrac = Math.min(Math.max(pcfg.sizing.kelly_fraction_base, pcfg.sizing.kelly_fraction_clamp[0]), pcfg.sizing.kelly_fraction_clamp[1]);
  const intensity = kEdge > 0 ? Math.min(kFrac * kEdge, pcfg.sizing.max_position_pct) : 0;
  const size = realSizeFromFraction(Math.round(intensity * 10000) / 10000, realFree, row.max_order_usd);
  if (size <= 0) { tally.size_zero++; continue; }
  if (!b.decision_id || !b.entry_price) { tally.no_decision++; continue; }
  tally.would_mirror++; wouldSizeSum += size;
}

console.log(`Всего футбольных входов: ${bets.length}\n`);
console.log(`  strategy_miss   ${tally.strategy_miss}\t(стратегия не в whitelist вообще)`);
console.log(`  category_miss   ${tally.category_miss}\t(стратегия есть, категория НЕ покрыта — замороженный список)`);
console.log(`  size_zero       ${tally.size_zero}\t(edge≤0 на входе → доля 0 → размер 0)`);
console.log(`  no_decision     ${tally.no_decision}\t(нет decision_id/цены)`);
console.log(`  would_mirror    ${tally.would_mirror}\t(ДОЛЖНЫ были дать ордер${tally.would_mirror ? `, ср. размер $${(wouldSizeSum / tally.would_mirror).toFixed(2)}` : ""})`);

if (missCats.size) {
  console.log(`\nКатегории, которые whitelist НЕ покрывает (${missCats.size}) — вот дыра:`);
  [...missCats.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([id, v]) => console.log(`  ${v.n}×  ${v.name}  [${id}]`));
}
console.log(`\nВывод: ${bets.length === 0 ? "футбольных входов нет — нечего диагностировать (тихий календарь)."
  : tally.would_mirror > 0
  ? "часть входов ДОЛЖНА была зеркалиться — если ордеров 0, копаем place() / tokenId (external_ref)."
  : tally.category_miss >= tally.strategy_miss && tally.category_miss >= tally.size_zero
    ? "доминирует category_miss — whitelist заморозил категории на момент сева; новые лиги мимо. Чиним матчинг (wildcard) или пере-сеем."
    : tally.size_zero > 0 ? "доминирует size_zero — доля входа 0 (edge≤0 на исполнении). Это про сайзинг, не про whitelist."
    : "доминирует strategy_miss — стратегии входов не в whitelist."}`);
