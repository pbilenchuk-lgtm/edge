// ============================================================
// EDGE LAB — end-to-end smoke run (ТЗ §7 Stage 2)
// Drives ONE match from analysis -> strategy sizing, then settles the
// finished match, computes metrics, and checks invariants. Prints a
// readable report. Run: npm run smoke
// ============================================================
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { freeBalance, stratBudget, roi } from "../src/lib/money.js";
import { sizeBet } from "../src/lib/thresholds.js";
import { edgePct } from "../src/lib/edge.js";
import { payout } from "../src/lib/settlement.js";
import { computeMetrics, type MetricSample } from "../src/lib/metrics.js";
import { checkInvariants } from "../src/lib/invariants.js";
import type { Confidence } from "../src/lib/types.js";

const db = openDb(":memory:");
seedDatabase(db);
const line = (s = "") => console.log(s);

// ---------- money model (§3.1) ----------
const tr = R.getTreasury(db);
const comps = R.listCompetitions(db);
line("=== КАЗНА (§3.1) ===");
line(`общий баланс: $${tr.total_balance}`);
line(`распределено: $${comps.reduce((a, c) => a + c.budget, 0)}`);
line(`свободно:     $${freeBalance(tr.total_balance, comps)}  (инвариант §9.1: >= 0)`);

// ---------- analytics -> strategy decisions on m-lineup ----------
line("\n=== АНАЛИТИКА → РЕШЕНИЯ СТРАТЕГИЙ · Португалия–Хорватия (§3.3) ===");
const match = R.getMatch(db, "m-lineup")!;
const post = R.assessmentsForMatch(db, match.id).find((a) => a.stage === "post_lineup")!;
line(`оценка (post, приоритетная): «${post.short}» — уверенность ${post.confidence}`);
const wcBudget = comps.find((c) => c.id === "wc2026")!.budget;
const markets = R.latestMarkets(db, match.id);
const best = markets.reduce((a, m) => (edgePct(m.ai_prob!, m.price) > edgePct(a.ai_prob!, a.price) ? m : a));
line(`лучший край на рынке: «${best.label}» цена ${best.price}¢, ИИ ${(best.ai_prob! * 100).toFixed(0)}% => edge ${edgePct(best.ai_prob!, best.price).toFixed(1)}%`);
line("");

for (const strat of R.listStrategies(db, "football")) {
  const share = R.sharesForComp(db, "wc2026").find((s) => s.strategy_id === strat.id);
  if (!share) continue;
  const budget = stratBudget(wcBudget, share.pct);
  const d = sizeBet({
    params: strat.params,
    aiProb: best.ai_prob!,
    priceCents: best.price,
    budget,
    confidence: post.confidence as Confidence,
  });
  const verdict = d.enter ? `ВХОД $${d.stake} (${(d.fraction * 100).toFixed(1)}% из $${budget})` : `ПРОПУСК`;
  line(`  ${strat.name.padEnd(12)} [${share.pct}% · $${budget}]  ${verdict}`);
  line(`       └ ${d.reason}   (сайзинг посчитан КОДОМ — инвариант §9.6)`);
}

// ---------- settlement of the finished match (§3.4) ----------
line("\n=== SETTLEMENT · Франция–Португалия 2:1 (§3.4) ===");
const finished = R.getMatch(db, "m-finished")!;
const samples: MetricSample[] = [];
for (const strat of R.listStrategies(db, "football")) {
  const bets = R.betsForMatch(db, finished.id, strat.id);
  if (!bets.length) continue;
  let pnl = 0;
  const share = R.sharesForComp(db, "wc2026").find((s) => s.strategy_id === strat.id);
  const budget = stratBudget(wcBudget, share?.pct ?? 0);
  for (const b of bets) {
    const won = b.result === "won";
    const pay = payout(b.entry_price!, b.stake!, won);
    pnl += pay - b.stake!;
    samples.push({
      aiProb: b.ai_prob!,
      outcome: won ? 1 : 0,
      entryPrice: b.entry_price!,
      closingPrice: b.closing_price,
    });
    line(`  ${strat.name.padEnd(12)} ${b.market_label.padEnd(18)} $${b.stake} @${b.entry_price}¢ -> ${won ? "✓" : "✕"} payout $${pay.toFixed(1)}`);
  }
  line(`       └ P&L $${pnl.toFixed(1)}  ROI ${roi(pnl, budget).toFixed(1)}%  (сравнение по ROI — §9.10)`);
}

// ---------- metrics (§2.14) ----------
line("\n=== МЕТРИКИ КАЧЕСТВА (§2.14) ===");
const m = computeMetrics(samples);
line(`samples: ${m.samples}  Brier: ${m.brier}  CLV: ${m.clv}¢  вердикт: «${m.verdict}»`);
line(`калибровка: ${m.calibration.map((c) => `${c.bucket}:${c.predicted}→${c.actual}`).join("  ")}`);
if (m.lowData) line(`⚠ мало данных (<20) — метрики шумны (§9.8)`);

// ---------- invariants (§9) ----------
line("\n=== ИНВАРИАНТЫ (§9) ===");
const inv = checkInvariants({
  totalBalance: tr.total_balance,
  competitions: comps,
  sharesByComp: Object.fromEntries(comps.map((c) => [c.id, R.sharesForComp(db, c.id)])),
  stakeGroups: comps.flatMap((c) =>
    R.listStrategies(db).flatMap((s) => {
      const share = R.sharesForComp(db, c.id).find((x) => x.strategy_id === s.id);
      if (!share) return [];
      return R.listMatches(db, c.id).map((mt) => ({
        competitionId: c.id, strategyId: s.id, matchId: mt.id,
        strategyBudget: stratBudget(c.budget, share.pct),
        bets: R.betsForMatch(db, mt.id, s.id),
      }));
    }),
  ),
  assessmentsByMatch: Object.fromEntries(
    comps.flatMap((c) => R.listMatches(db, c.id)).map((mt) => [mt.id, R.assessmentsForMatch(db, mt.id)]),
  ),
});
line(inv.ok ? "✓ все проверяемые инварианты соблюдены" : "✗ нарушения:");
for (const v of inv.violations) line(`   §${v.code}: ${v.message}`);

line("\n✓ smoke OK");
