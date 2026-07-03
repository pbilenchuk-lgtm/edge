// ============================================================
// EDGE LAB — engine simulation (ТЗ §3.3 lifecycle)
// Drives one match through the trigger engine: goal → reassessment,
// rate-limited second goal → skipped, finish → settlement → metrics.
// Run: npm run simulate
// ============================================================
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { syncMatchStatus, recomputeMetrics } from "../src/lib/engine.js";
import type { SportsMatchStatus } from "../src/lib/sports.js";

const db = openDb(":memory:");
seedDatabase(db);
const line = (s = "") => console.log(s);

// Link m-live (Бразилия–Англия, live 1:0, open bets) to a provider ref.
R.updateMatch(db, "m-live", { external_ref: "SIM1" });
const ref = "SIM1", home = "Бразилия", away = "Англия";
const st = (state: any, sh: number, sa: number, minute: number, final = false): SportsMatchStatus =>
  ({ externalRef: ref, home, away, state, minute, scoreHome: sh, scoreAway: sa, final });

line("=== СИМУЛЯЦИЯ · Бразилия–Англия (§3.3) ===");
line(`старт: ${JSON.stringify(pick(R.getMatch(db, "m-live")!))}`);

async function step(label: string, s: SportsMatchStatus, overrides = {}) {
  line(`\n▶ ${label}  (${s.state} ${s.scoreHome}:${s.scoreAway} ${s.minute}')`);
  const res = await syncMatchStatus(db, s, { config: { reassessGapMinutes: 5, priceMoveThreshold: 5 } }, overrides);
  if (!res) return line("  (матч не найден)");
  line(`  переход: ${res.from} → ${res.to}  голов: ${res.goals}`);
  for (const r of res.reassessments) {
    const strat = R.getStrategy(db, r.strategyId)!;
    line(`  переоценка [${strat.name}]: ${r.created ? `создана (${r.source})` : `пропущена — ${r.reason}`}`);
  }
  if (res.settlement) line(`  settlement: рассчитано ${res.settlement.settled}, пропущено ${res.settlement.skipped}`);
}

// 75': goal 2:0 -> reassessments created
await step("Гол! 2:0", st("live", 2, 0, 75));
// 76': goal 3:0 one minute later -> rate-limited (§9.7)
await step("Гол! 3:0 (спустя минуту)", st("live", 3, 0, 76));
// 90': final -> settle (Advance resolved externally as true)
await step("Финал 3:0", st("finished", 3, 0, 90, true), { "Advance Бразилия": true });

line("\n=== РАСЧЁТ ПОЗИЦИЙ ===");
for (const b of R.betsForMatch(db, "m-live")) {
  line(`  ${R.getStrategy(db, b.strategy_id)!.name.padEnd(12)} ${b.market_label.padEnd(18)} ${b.status.padEnd(13)} result=${b.result ?? "—"} payout=${b.payout ?? "—"}`);
}

line("\n=== МЕТРИКИ (пересчитаны на settled) ===");
for (const s of R.listStrategies(db, "football")) {
  const q = R.getQuality(db, s.id);
  if (q) line(`  ${s.name.padEnd(12)} samples=${q.samples} brier=${q.brier ?? "—"} clv=${q.clv ?? "—"}`);
}

line("\n=== ПЕРЕОЦЕНКИ В ЛОГЕ ===");
for (const r of R.reassessmentsForMatch(db, "m-live"))
  line(`  ${r.minute} [${R.getStrategy(db, r.strategy_id)!.name}] (${r.trigger}) ${r.body.slice(0, 90)}…`);

line("\n✓ simulate OK");

function pick(m: any) { return { state: m.state, score: `${m.score_home}:${m.score_away}`, minute: m.minute }; }
