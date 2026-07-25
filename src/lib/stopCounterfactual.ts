// ============================================================
// EDGE LAB — STOP-EXIT COUNTERFACTUAL  [P3, batch-9 ТЗ]
//
// The Universitario question, made measurable: when a defensive cut fires, are we selling a real thesis death
// or a price-noise bottom? The batch-9 case cut one position five times across 66' at 16.9 / 12.6 / 15.3¢ while
// the SAME market printed 30.8¢ twenty-five minutes later — but the thesis genuinely died (settled ~0), so the
// anecdote alone can't answer it. Only a cohort can.
//
// METHOD (honest, no hindsight beyond the stated window): for every protective exit (hard stop / thesis stop /
// counter-scenario / capitulation), find the BEST price the same market printed in the next
// STOP_CF_WINDOW_MIN minutes of snapshot history. `shortfall` = that best price − the price we actually took.
// Positive shortfall = money the cut left on the table. Reported per strategy / reason / book depth.
//
// CRITERION — fixed BEFORE the data (batch-9 ТЗ, ratified):
//   median shortfall ≥ 5¢ AND ≥ 20% of the cut price, on n ≥ 30 stop exits
//     → the cuts are noise-driven; the rudder moves onto thesis state (extend the T1.1 anchor to the
//       hard-stop path). Below that → Universitario stays an expensive anecdote and the design is untouched.
// Reported separately (its own trigger, independent of the median): the share of cuts where a hard price stop
// OVERRODE a thesis suppression that had held earlier in the same match (the 6'→24' pattern). ≥10% makes it a
// priority bug on its own.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { betRecords, type BetRec, type ProfileFilter } from "./profileAnalytics.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : r2((s[i - 1] + s[i]) / 2);
};

/** Protective (money-defending) exit triggers — the cohort under test. A `take_price` is NOT protective. */
const PROTECTIVE = new Set(["hard_stop", "thesis_stop", "counter_scenario", "capitulation", "time_stop", "time_decay_floor"]);

export const STOP_CF_WINDOW_MIN = (() => { const n = Number(process.env.STOP_CF_WINDOW_MIN); return Number.isFinite(n) && n > 0 ? n : 30; })();
export const STOP_CF_MIN_N = 30;          // sample floor for the ratified verdict
export const STOP_CF_MEDIAN_CENTS = 5;    // ¢ median shortfall
export const STOP_CF_MEDIAN_PCT = 20;     // % of the cut price
export const STOP_CF_OVERRIDE_PCT = 10;   // hard-stop-over-thesis-suppression share that is a bug on its own

export interface StopCfRow {
  matchId: string; matchLabel: string; strategyId: string; profileId: string; market: string;
  reason: string; exitAtIso: string | null; cutCents: number;
  bestNextCents: number | null; shortfallCents: number | null; shortfallPct: number | null;
  bookUsd: number | null; overrodeThesisHold: boolean;
}
export interface StopCfGroup { key: string; n: number; medianShortfallCents: number | null; medianShortfallPct: number | null; worstCents: number | null }
export interface StopCounterfactual {
  windowMin: number; criterion: { needN: number; medianCents: number; medianPct: number; overridePct: number };
  n: number; nWithWindow: number;
  medianShortfallCents: number | null; medianShortfallPct: number | null;
  byStrategy: StopCfGroup[]; byReason: StopCfGroup[]; byBookDepth: StopCfGroup[];
  overrode: { count: number; pct: number | null; flagged: boolean };
  verdict: "insufficient" | "noise_driven" | "justified";
  rows: StopCfRow[];
  note: string;
}

/** Best (highest) price this market printed in the (exit, exit+window] snapshot history — the price the cut
 *  could have waited for. Pure read over the markets table; null when no snapshot lands in the window. */
function bestNextCents(db: Database, matchId: string, label: string, fromIso: string, windowMin: number): number | null {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return null;
  const to = new Date(from + windowMin * 60_000).toISOString();
  const row = db.prepare(
    `SELECT MAX(price) px FROM markets WHERE match_id=? AND label=? AND snapshot_at > ? AND snapshot_at <= ?`,
  ).get(matchId, label, fromIso, to) as { px: number | null } | undefined;
  return row?.px ?? null;
}

/** Did a hard PRICE stop override a thesis suppression that had held earlier in this match, on this market?
 *  The 6'→24' Universitario pattern: «ценовой стоп подавлен … тезис в запасе» first, a −58% price stop later. */
function overrodeThesisHold(db: Database, matchId: string, label: string, exitAtIso: string | null, reason: string): boolean {
  if (reason !== "hard_stop") return false;
  const logs = R.tradeLogForMatch(db, matchId).filter((l) => l.type === "hold" && l.text.includes(label) && /подавл/i.test(l.text));
  if (!logs.length) return false;
  if (!exitAtIso) return true;
  const t = Date.parse(exitAtIso);
  return logs.some((l) => (Date.parse(l.created_at) || 0) <= (Number.isFinite(t) ? t : Infinity));
}

function group(rows: StopCfRow[], keyOf: (r: StopCfRow) => string): StopCfGroup[] {
  const by = new Map<string, StopCfRow[]>();
  for (const r of rows) { const k = keyOf(r); (by.get(k) ?? by.set(k, []).get(k)!).push(r); }
  return [...by.entries()].map(([key, rs]) => {
    const sh = rs.map((r) => r.shortfallCents).filter((x): x is number => x != null);
    const pct = rs.map((r) => r.shortfallPct).filter((x): x is number => x != null);
    return { key, n: rs.length, medianShortfallCents: median(sh), medianShortfallPct: median(pct), worstCents: sh.length ? Math.max(...sh) : null };
  }).sort((a, b) => b.n - a.n);
}

/** Build the counterfactual over every protective exit in scope. Read-only, deterministic. */
export function buildStopCounterfactual(db: Database, filter: ProfileFilter = {}, windowMin = STOP_CF_WINDOW_MIN): StopCounterfactual {
  const recs: BetRec[] = betRecords(db, filter);
  const rows: StopCfRow[] = [];
  for (const b of recs) {
    for (const e of b.exits) {
      if (!PROTECTIVE.has(e.trigger)) continue;
      if (e.priceCents == null || !(e.priceCents > 0)) continue;
      // The exit's timestamp comes from the trade-log line that produced it (matched on the same text).
      const log = R.tradeLogForMatch(db, b.matchId).find((l) => l.type === "exit" && l.text === e.text);
      const at = log?.created_at ?? null;
      const best = at ? bestNextCents(db, b.matchId, b.market, at, windowMin) : null;
      const shortfall = best != null ? r2(best - e.priceCents) : null;
      rows.push({
        matchId: b.matchId, matchLabel: b.matchLabel, strategyId: b.strategyId, profileId: b.profileId, market: b.market,
        reason: e.trigger, exitAtIso: at, cutCents: e.priceCents,
        bestNextCents: best, shortfallCents: shortfall,
        shortfallPct: shortfall != null && e.priceCents > 0 ? r2((shortfall / e.priceCents) * 100) : null,
        bookUsd: b.thinnessUsd ?? null,
        overrodeThesisHold: overrodeThesisHold(db, b.matchId, b.market, at, e.trigger),
      });
    }
  }
  const withWindow = rows.filter((r) => r.shortfallCents != null);
  const medC = median(withWindow.map((r) => r.shortfallCents as number));
  const medP = median(withWindow.map((r) => r.shortfallPct as number).filter((x) => x != null));
  const overrodeCount = rows.filter((r) => r.overrodeThesisHold).length;
  const overridePct = rows.length ? r2((overrodeCount / rows.length) * 100) : null;
  const matured = withWindow.length >= STOP_CF_MIN_N;
  const noise = matured && medC != null && medP != null && medC >= STOP_CF_MEDIAN_CENTS && medP >= STOP_CF_MEDIAN_PCT;
  const verdict: StopCounterfactual["verdict"] = !matured ? "insufficient" : noise ? "noise_driven" : "justified";
  const depth = (r: StopCfRow) => (r.bookUsd == null ? "книга неизвестна" : r.bookUsd < 1000 ? "<$1k" : r.bookUsd < 5000 ? "$1k–5k" : "≥$5k");
  return {
    windowMin,
    criterion: { needN: STOP_CF_MIN_N, medianCents: STOP_CF_MEDIAN_CENTS, medianPct: STOP_CF_MEDIAN_PCT, overridePct: STOP_CF_OVERRIDE_PCT },
    n: rows.length, nWithWindow: withWindow.length,
    medianShortfallCents: medC, medianShortfallPct: medP,
    byStrategy: group(withWindow, (r) => r.strategyId),
    byReason: group(withWindow, (r) => r.reason),
    byBookDepth: group(withWindow, depth),
    overrode: { count: overrodeCount, pct: overridePct, flagged: overridePct != null && overridePct >= STOP_CF_OVERRIDE_PCT },
    verdict,
    rows: rows.sort((a, b) => (b.shortfallCents ?? -Infinity) - (a.shortfallCents ?? -Infinity)).slice(0, 60),
    note: !matured
      ? `копим: ${withWindow.length}/${STOP_CF_MIN_N} защитных выходов с окном ${windowMin}м. Критерий зафиксирован ДО данных: медианный недобор ≥${STOP_CF_MEDIAN_CENTS}¢ И ≥${STOP_CF_MEDIAN_PCT}% цены среза → срезы шумовые, руль пересаживается на состояние тезиса; иначе дизайн не трогаем.`
      : noise
        ? `ШУМОВЫЕ СРЕЗЫ: медиана недобора ${medC}¢ (${medP}% цены среза) на n=${withWindow.length} ≥ порогов (${STOP_CF_MEDIAN_CENTS}¢ / ${STOP_CF_MEDIAN_PCT}%) — режем на шуме, а не на смерти тезиса. Ратифицированное следствие: расширить T1.1-якорь на hard-stop путь.`
        : `СРЕЗЫ ОПРАВДАНЫ: медиана недобора ${medC}¢ (${medP}%) на n=${withWindow.length} ниже порогов — рынок в среднем НЕ возвращал цену в окне ${windowMin}м. Universitario остаётся дорогим анекдотом, дизайн не трогаем.`
      + (overridePct != null && overridePct >= STOP_CF_OVERRIDE_PCT ? ` ⚠ ОТДЕЛЬНО: в ${overridePct}% случаев hard-stop переехал тезисную подавку (≥${STOP_CF_OVERRIDE_PCT}%) — приоритетный баг независимо от медианы.` : ""),
  };
}
