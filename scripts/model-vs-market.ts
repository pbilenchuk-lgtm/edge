// Owner instrument — is the edge REAL or phantom? Decomposes CLV (closing − entry, ¢, same convention
// as the «Профили» tab) across every axis where we suspect structure, isolates the CLEAN post-fix epoch
// (e5) from the buggy history, and splits Over vs Under. Built ON betRecords() — no new CLV engine.
//   npx tsx scripts/model-vs-market.ts
// Read-only. CLV>0 = we bought below the closing line (beat the market); CLV<0 = market moved against us.

import { getDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { betRecords, type BetRec } from "../src/lib/profileAnalytics.js";
import { CODE_VERSION } from "../src/lib/betMeta.js";

const db = getDb();
const footballComps = new Set(R.listCompetitions(db, "football").map((c) => c.id));
const recs = betRecords(db).filter((r) => footballComps.has(r.competitionId));

// ── config sanity: is any strategy still routed to Fable? (should be none after ANALYSIS_DUEL=off) ──
const stratModels = R.listStrategies(db, "football").flatMap((s) => [s.model, s.model_live]).filter(Boolean) as string[];
const fableCfg = stratModels.filter((m) => /fable/i.test(m));
console.log(`═══ MODEL vs MARKET — CLV decomposition ═══`);
console.log(`config: модели стратегий = ${[...new Set(stratModels)].join(", ")}`);
console.log(fableCfg.length ? `  ⚠ Fable ЖЁСТКО в конфиге стратегии — ANALYSIS_DUEL=off его НЕ уберёт, правь модель стратегии!` : `  ✓ ни одна стратегия не на Fable — off убирает его полностью.`);
console.log(`футбольных ставок (не proposed): ${recs.length} · пост-фикс эпоха = ${CODE_VERSION}·*\n`);

// ── aggregation over a rec slice ──────────────────────────────────────────────
type Agg = { n: number; nClv: number; clv: number | null; win: number | null; decided: number; pnl: number };
function agg(rs: BetRec[]): Agg {
  const clv = rs.filter((r) => r.clvCents != null);
  const decided = rs.filter((r) => r.outcome === "won" || r.outcome === "lost");
  const won = decided.filter((r) => r.outcome === "won").length;
  const pnl = rs.reduce((s, r) => s + (r.pnl ?? 0), 0);
  return {
    n: rs.length, nClv: clv.length,
    clv: clv.length ? Math.round((clv.reduce((s, r) => s + (r.clvCents ?? 0), 0) / clv.length) * 10) / 10 : null,
    win: decided.length ? Math.round((100 * won) / decided.length) : null, decided: decided.length,
    pnl: Math.round(pnl),
  };
}
const line = (label: string, a: Agg) =>
  `  ${label.padEnd(22)} n=${String(a.n).padStart(4)} · CLV ${a.clv == null ? "  —  " : (a.clv >= 0 ? "+" : "") + a.clv.toFixed(1) + "¢"} (n${a.nClv}) · win ${a.win == null ? "—" : a.win + "%"} (${a.decided}) · P&L ${a.pnl >= 0 ? "+" : ""}$${a.pnl}`;
const groupBy = (rs: BetRec[], key: (r: BetRec) => string | null) => {
  const m = new Map<string, BetRec[]>();
  for (const r of rs) { const k = key(r); if (k == null) continue; (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return m;
};
const dumpGroups = (rs: BetRec[], key: (r: BetRec) => string | null, sortByN = true) => {
  const g = [...groupBy(rs, key).entries()].map(([k, v]) => [k, agg(v)] as const);
  g.sort((a, b) => sortByN ? b[1].n - a[1].n : (b[1].clv ?? -99) - (a[1].clv ?? -99));
  for (const [k, a] of g) console.log(line(k, a));
};

const epoch = (r: BetRec) => (r.codeVersion ?? "").split("·")[0] || "(none)";
const zone = (r: BetRec) => r.edge == null ? null : r.edge < 0 ? "edge <0" : r.edge < 0.05 ? "edge 0–5%" : r.edge < 0.10 ? "edge 5–10%" : "edge 10%+";
const ou = (r: BetRec) => /\bover\b/i.test(r.market) ? "Over" : /\bunder\b/i.test(r.market) ? "Under" : null;
const postFix = recs.filter((r) => (r.codeVersion ?? "").startsWith(CODE_VERSION));

// ── 0. baseline (all history) + THE headline (post-fix only) ───────────────────
console.log(`ALL-HISTORY:`); console.log(line("вся история", agg(recs)));
console.log(`\n★ ПОСТ-ФИКС (${CODE_VERSION}) — «есть ли edge СЕЙЧАС, на коде для реала»:`);
console.log(line(`${CODE_VERSION} overall`, agg(postFix)));
console.log(`  по стратегии:`); dumpGroups(postFix, (r) => r.strategyId);
console.log(`  по фазе:`); dumpGroups(postFix, (r) => r.phase);
console.log(`  Over/Under:`); dumpGroups(postFix, ou);

// ── 1. by epoch (does the fix show up?) ────────────────────────────────────────
console.log(`\nПо эпохам codeVersion (видно ли улучшение до/после фиксов):`); dumpGroups(recs, epoch);
// ── 2–5. structural axes (all history — for shape; compare against post-fix above) ─
console.log(`\nПо стратегии:`); dumpGroups(recs, (r) => r.strategyId);
console.log(`\nПо фазе:`); dumpGroups(recs, (r) => r.phase);
console.log(`\nПо зонам edge:`); dumpGroups(recs, zone);
console.log(`\nПо категориям (топ/дно по CLV):`); dumpGroups(recs, (r) => r.category, false);

// ── 6. Over vs Under bias — all + post-fix (the 4-point Under-suspicion) ────────
console.log(`\n── Over vs Under (проверка Under-bias) ──`);
console.log(` вся история:`); dumpGroups(recs, ou);
console.log(` пост-фикс ${CODE_VERSION}:`); dumpGroups(postFix, ou);
console.log(`\nЧтение: CLV>0 = бьём закрытие. Смотри ПОСТ-ФИКС строки — они про реал. Отрицательный CLV в срезе = фантом там, не edge.`);
