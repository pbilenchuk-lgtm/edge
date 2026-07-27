// ============================================================
// EDGE LAB — VOID-RATE WATCH  [ratified, batch-11 follow-up #1]
//
// This exists because of how the complement bug was found: by accident. 225 bets had been booked as REFUNDS
// while their markets had actually resolved — 78 wins and 147 losses hidden behind "the wager did not happen".
// The book was flattered by ~$896 for weeks, and nothing anywhere said a word.
//
// It stayed invisible for three compounding reasons, and only the third is worth building against:
//   1. the refusal LOOKED like discipline — «не сеттлю на один токен» reads as a guard working, not as a guard
//      that is blind;
//   2. a refund books P&L = 0, which is never an outlier in any report — it is just a boring row;
//   3. NOBODY WAS COUNTING VOIDS. There was no number that could have shouted.
//
// So this is deliberately NOT a detector for the complement bug — that one is fixed and cannot recur the same
// way. It is a detector for the CLASS: «the ledger has quietly drifted away from reality». Any future cause —
// a provider change, a new market type, a settle path nobody thought about — produces the same signature: the
// share of decided bets that end as refunds climbs. A void rate is the cheapest possible sensor for that, and
// its absence is what turned a one-day find into a month of blindness.
//
// Split BY REASON on purpose. «Market genuinely voided» and «we could not verify, so we gave up» are opposite
// facts wearing the same status: the first is the exchange's decision, the second is our own failure. Pooling
// them would have hidden this bug even with the counter in place.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

/** Share of decided bets that may end as refunds before the ledger is suspect. Refunds are normal but rare —
 *  a real market void is unusual. Anything above this is not noise, it is a signal to look. */
export const VOID_ALARM_PCT = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.VOID_ALARM_PCT);
  return Number.isFinite(n) && n > 0 ? n : 5;
};
export const VOID_WATCH_MIN_N = 20;   // below this a percentage is theatre, not measurement

export interface VoidWatchReport {
  windowHours: number;
  decided: number;              // settled bets in the window (won + lost + void) — the denominator
  voids: number;
  voidPct: number | null;
  byReason: Record<string, number>;
  alarm: boolean;
  verdict: "insufficient" | "ok" | "ALARM";
  note: string;
}

/**
 * Void rate over a window. The denominator is DECIDED bets, not all bets: an open position has not had the
 * chance to be refunded yet, and including it would dilute the rate exactly when a spike matters most.
 */
export function buildVoidWatch(db: Database, windowHours = 24, nowMs = Date.now(), env: Record<string, string | undefined> = process.env): VoidWatchReport {
  const since = new Date(nowMs - windowHours * 3600_000).toISOString();
  let decided = 0, voids = 0;
  const byReason: Record<string, number> = {};
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      for (const b of R.betsForMatch(db, m.id)) {
        if (!b.settled_at || b.settled_at < since) continue;
        if (!String(b.status).startsWith("settled")) continue;
        decided++;
        if (b.status !== "settled_void") continue;
        voids++;
        // The reason matters more than the count. 'void'/'void_timeout' with the single-token detail is OUR
        // failure to verify; a market void is the exchange's call. Same status, opposite meaning.
        const by = b.settled_by ?? "—";
        const noComp = /комплемент/i.test(b.rationale ?? "") || /одиночный токен/i.test(b.rationale ?? "");
        const key = noComp ? "нет_комплемента" : by === "void_timeout" ? "void_timeout" : by === "void" ? "market_void" : `иное:${by}`;
        byReason[key] = (byReason[key] ?? 0) + 1;
      }
    }
  }
  const pct = decided ? Math.round((1000 * voids) / decided) / 10 : null;
  const thr = VOID_ALARM_PCT(env);
  const enough = decided >= VOID_WATCH_MIN_N;
  const alarm = enough && pct != null && pct > thr;
  const reasons = Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(", ") || "—";
  return {
    windowHours, decided, voids, voidPct: pct, byReason, alarm,
    verdict: !enough ? "insufficient" : alarm ? "ALARM" : "ok",
    note: !enough
      ? `решённых ставок за ${windowHours}ч всего ${decided} (нужно ≥${VOID_WATCH_MIN_N}) — доля возвратов на такой выборке ничего не значит.`
      : alarm
        ? `ТРЕВОГА: ${voids} из ${decided} решённых ставок (${pct}%) закрыты ВОЗВРАТОМ при пороге ${thr}%. ` +
          `Причины: ${reasons}. Возврат означает «пари не состоялось» — если рынки на деле разрешились, книга ` +
          `тихо расходится с реальностью, как это уже было с несохранённым комплементом (225 ставок, $896). ` +
          `Начинать с причины «нет_комплемента»: это НАША неспособность сверить, а не решение биржи.`
        : `норма: ${voids} из ${decided} (${pct}%) при пороге ${thr}%. Причины: ${reasons}.`,
  };
}
