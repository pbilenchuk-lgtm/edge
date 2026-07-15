// Owner check — is the MODEL duel (ANALYSIS_DUEL: Opus 4.8 vs Fable 5) alive, and what does the
// head-to-head say?  npx tsx scripts/duel-status.ts
// Read-only. TWO questions in one:
//   1) LIVENESS — did the arm actually fire? Bets tagged e{code}·m{N}·{arm} in code_version. If only
//      one arm has bets (or fable ~0), the duel is a silent zero — check ANALYSIS_DUEL env + that the
//      Anthropic key can actually call claude-fable-5.
//   2) SLICE — per arm: n, settled, win%, mean CLV (closing−entry), calibration gap (mean ai_prob − win%).
// This reads EXISTING arm-tagged bets — it is the instrument, not a new capture.

import { getDb } from "../src/lib/db.js";
import { loadAnalysisDuel } from "../src/lib/analysisDuel.js";

const db = getDb();
const env = process.env;
const duel = loadAnalysisDuel(env);

console.log(`═══ MODEL DUEL STATUS ═══`);
console.log(`ANALYSIS_DUEL=${env.ANALYSIS_DUEL ?? "(unset → off)"} · loadAnalysisDuel → ${duel.enabled ? `ON [${duel.models.join(" vs ")}]` : `OFF [${duel.models.join(" / ")} — не резолвится/не пара]`}\n`);

// Every football bet, with its arm tag parsed from code_version (last ·-segment when present).
const rows = db.prepare(
  `SELECT b.code_version, b.status, b.result, b.ai_prob, b.entry_price, b.closing_price
   FROM bets b JOIN matches m ON m.id=b.match_id JOIN competitions c ON c.id=m.competition_id
   WHERE c.sport_id='football'`,
).all() as any[];

const arm = (cv: string | null): string => {
  if (!cv) return "(no code_version)";
  const parts = cv.split("·");
  return parts.length >= 3 ? parts[parts.length - 1] : "(no-arm)"; // e5·m2·opus48 → opus48; e5·m2 → no-arm
};

type Agg = { n: number; settled: number; won: number; lost: number; void: number; aiSum: number; aiN: number; clvSum: number; clvN: number };
const byArm = new Map<string, Agg>();
for (const r of rows) {
  const a = arm(r.code_version);
  const g = byArm.get(a) ?? { n: 0, settled: 0, won: 0, lost: 0, void: 0, aiSum: 0, aiN: 0, clvSum: 0, clvN: 0 };
  g.n++;
  if (r.status === "settled_won") { g.settled++; g.won++; }
  else if (r.status === "settled_lost") { g.settled++; g.lost++; }
  else if (r.status === "settled_void") { g.void++; }
  if (r.ai_prob != null) { g.aiSum += r.ai_prob; g.aiN++; }
  if (r.closing_price != null && r.entry_price != null) { g.clvSum += r.closing_price - r.entry_price; g.clvN++; }
  byArm.set(a, g);
}

const fmt = (g: Agg) => {
  const decided = g.won + g.lost;
  const winPct = decided ? (100 * g.won / decided) : null;
  const meanAi = g.aiN ? (100 * g.aiSum / g.aiN) : null;
  const clv = g.clvN ? (g.clvSum / g.clvN) : null;
  const calGap = winPct != null && meanAi != null ? (meanAi - winPct) : null;
  return `n=${g.n} · settled=${g.settled} (W${g.won}/L${g.lost}/void${g.void}) · win%=${winPct?.toFixed(0) ?? "—"}`
    + ` · CLV=${clv != null ? (clv >= 0 ? "+" : "") + clv.toFixed(1) + "¢" : "—"}(n${g.clvN})`
    + ` · calib gap=${calGap != null ? (calGap >= 0 ? "+" : "") + calGap.toFixed(0) + "pp" : "—"} (ai ${meanAi?.toFixed(0) ?? "—"}% vs win ${winPct?.toFixed(0) ?? "—"}%)`;
};

const arms = [...byArm.entries()].sort((a, b) => b[1].n - a[1].n);
console.log(`Ставки по армам (${rows.length} футбольных всего):`);
for (const [a, g] of arms) console.log(`  ${a.padEnd(14)} ${fmt(g)}`);

// Head-to-head + liveness verdict.
const opus = arms.find(([a]) => /opus/.test(a))?.[1];
const fable = arms.find(([a]) => /fable/.test(a))?.[1];
console.log(`\nВердикт:`);
if (!duel.enabled) console.log(`  duel OFF в env — арм не размечался. Все матчи одной моделью. Гейт НЕ копится: включи ANALYSIS_DUEL=on + проверь доступ ключа к claude-fable-5.`);
else if (!opus || !fable) console.log(`  duel ON, но один арм пуст (opus=${opus?.n ?? 0}, fable=${fable?.n ?? 0}) — ТИХИЙ НОЛЬ №2. Fable-анализы падают или не выбираются: смотри trade_log/лог ошибок LLM по claude-fable-5.`);
else {
  const bal = Math.min(opus.n, fable.n) / Math.max(opus.n, fable.n);
  console.log(`  duel ЖИВ: opus n=${opus.n}, fable n=${fable.n} (баланс ${(bal * 100).toFixed(0)}% — ждём ~50/50 по хэшу).`);
  console.log(`  Готовность гейта: нужно ≥~30 settled/арм. Сейчас settled: opus ${opus.settled} · fable ${fable.settled}.`);
  console.log(`  ${Math.min(opus.settled, fable.settled) >= 30 ? "→ ДОЗРЕЛО: сравнивай win%/CLV/calib выше." : "→ рано: копим до 30/арм, потом решаем какая модель точнее."}`);
}
