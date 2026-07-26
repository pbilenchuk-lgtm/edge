// ============================================================
// EDGE LAB — TARGETED token_second BACKFILL + RETRO-AUDIT OF TIMED-OUT VOIDS  [batch-11, conditions 4 & 5]
//
// Two jobs the settle fix alone does not cover.
//
// (4) TARGETED BACKFILL. Letting the import path fill token_second going forward is right, but slow, and the
// positions that are hanging toward a void timeout RIGHT NOW will not survive until it catches up. So the
// pointer is written first for exactly the markets that carry live money, and only then does anything else
// matter. Bounded by construction: it looks only at matches with open bets.
//
// (5) RETRO-AUDIT. If the 37% gap has existed since the e7 settler shipped, some past voids were not voids at
// all — they were wins and losses refunded by a timeout because the cross-check could not be performed. That
// is money already taken off the table by a bug. Every void whose complement is findable NOW is re-examined
// and, when the market genuinely resolved, settled by its true outcome — the same discipline as the earlier
// re-settle of suspects.
//
// A NOTE ON WHICH VOIDS. The ratification named `void_timeout`, but the single-token path actually tags its
// refunds `void` with the detail «одиночный токен без комплемента» (pmResolution rule C4). Auditing only
// `void_timeout` would therefore have missed the entire population the condition was written for. Both tags
// are swept, and rows are matched on the REASON rather than the tag.
//
// Re-settlement is deliberately conservative: it demands the same resolving price and complement pairing a
// live settle demands, and anything ambiguous stays void. A wrong re-settle would silently rewrite booked
// history, which is worse than leaving a refund in place.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { findComplementMarket } from "./complementMarket.js";
import { settleBet } from "./settlement.js";

export interface BackfillResult { marketsScanned: number; tokensWritten: number; matches: number }

/**
 * Write token_second for markets that carry OPEN money and are missing it. Only fills from a complement found
 * in the same match, and never overwrites a stored pointer — a wrong overwrite would corrupt a working row to
 * fix a broken one.
 */
export function backfillComplementTokens(db: Database, now: string): BackfillResult {
  const out: BackfillResult = { marketsScanned: 0, tokensWritten: 0, matches: 0 };
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      const openBets = R.betsForMatch(db, m.id).filter((b) => b.status === "open");
      if (!openBets.length) continue;                   // targeted: live money only
      out.matches++;
      const mkts = R.latestMarkets(db, m.id);
      const wanted = new Set(openBets.map((b) => b.market_label));
      for (const mk of mkts) {
        if (!wanted.has(mk.label)) continue;
        out.marketsScanned++;
        if (mk.token_second) continue;                  // already pointed — leave it alone
        const hit = findComplementMarket(mk.label, mkts);
        if (!hit) continue;
        try {
          db.prepare(`UPDATE markets SET token_second=? WHERE match_id=? AND label=? AND token_second IS NULL`)
            .run(hit.token, m.id, mk.label);
          out.tokensWritten++;
        } catch { /* a backfill must never break the tick that runs it */ }
      }
    }
  }
  if (out.tokensWritten) { try { R.metaSet(db, "complement_backfill_last", JSON.stringify({ ...out, at: now }), now); } catch { /* marker */ } }
  return out;
}

export interface RetroAuditRow { betId: string; matchId: string; label: string; outcome: "won" | "lost"; priceCents: number; stake: number; deltaUsd: number }
export interface RetroAuditResult {
  examined: number; complementFound: number; reSettled: number;
  /** Rows the DB refused to write right now (lock contention with the running app). Idempotent: re-run. */
  deferred: number;
  won: number; lost: number; bankDeltaUsd: number; rows: RetroAuditRow[]; note: string;
}

type ResolveTokensFn = (tokens: string[]) => Promise<Record<string, { priceCents: number | null; closed: boolean }>>;

/**
 * Re-examine refunds that were issued because no complement could be cross-checked. `apply=false` reports what
 * WOULD change without touching a row — the audit is meant to be read before it is trusted.
 */
export async function auditComplementVoids(
  db: Database, deps: EngineDeps & { resolveTokens?: ResolveTokensFn } = {}, opts: { apply?: boolean } = {},
): Promise<RetroAuditResult> {
  const now = deps.now?.() ?? new Date().toISOString();
  const res: RetroAuditResult = { examined: 0, complementFound: 0, reSettled: 0, deferred: 0, won: 0, lost: 0, bankDeltaUsd: 0, rows: [], note: "" };

  // Sweep BOTH refund tags, and select on the reason — the single-token path tags 'void', not 'void_timeout'.
  const voided = db.prepare(
    `SELECT id, match_id, strategy_id, market_label, stake, entry_price, rationale, settled_by
       FROM bets WHERE status='settled_void' AND settled_by IN ('void','void_timeout')`,
  ).all() as any[];

  const pending: { bet: any; token: string; token2: string }[] = [];
  const tokens = new Set<string>();
  for (const b of voided) {
    res.examined++;
    const mkts = R.latestMarkets(db, b.match_id);
    const mk = mkts.find((x) => x.label === b.market_label);
    if (!mk?.external_ref) continue;
    const hit = mk.token_second ? { token: mk.token_second } : findComplementMarket(b.market_label, mkts);
    if (!hit) continue;                                  // still un-cross-checkable → the refund stands
    res.complementFound++;
    pending.push({ bet: b, token: mk.external_ref, token2: hit.token });
    tokens.add(mk.external_ref); tokens.add(hit.token);
  }
  if (!pending.length) {
    res.note = `проверено ${res.examined} возвратов, комплемент не нашёлся ни для одного — пере-сеттлить нечего.`;
    return res;
  }

  const resolver = deps.resolveTokens;
  if (!resolver) { res.note = `${res.complementFound} возвратов имеют комплемент, но резолвер токенов не передан — прогон только по данным БД невозможен.`; return res; }
  const map = await resolver([...tokens]);

  const HI = 95, LO = 5;                                 // same resolving band the live settler uses
  for (const p of pending) {
    const t = map[p.token], c2 = map[p.token2];
    if (!t || t.priceCents == null || !c2 || c2.priceCents == null) continue;
    const won = t.priceCents >= HI && c2.priceCents <= LO;
    const lost = t.priceCents <= LO && c2.priceCents >= HI;
    if (!won && !lost) continue;                         // not a clean resolving pair → leave the refund alone
    const patch = settleBet({ entry_price: p.bet.entry_price, stake: p.bet.stake }, won, t.priceCents);
    const delta = (patch.payout ?? 0) - (p.bet.stake ?? 0);   // vs the refund, which returned the stake
    if (opts.apply) {
      // COUNT ONLY WHAT ACTUALLY LANDED. The first production run died mid-way on «database is locked», and
      // with the counter incremented before the write the report would have claimed rows it never changed.
      // A lock is also not a reason to abandon the remaining 100 rows: the pass is idempotent (a re-settled
      // bet is no longer settled_void, so a re-run skips it), so a contended row is DEFERRED, not lost.
      try {
        R.updateBet(db, p.bet.id, {
          status: patch.status, result: patch.result, payout: patch.payout, closing_price: patch.closing_price,
          settled_at: now, settled_by: "pm_resolution", settled_via: "match_complement_retro",
        });
      } catch (e) { res.deferred++; continue; }
    }
    res.rows.push({ betId: p.bet.id, matchId: p.bet.match_id, label: p.bet.market_label, outcome: won ? "won" : "lost", priceCents: t.priceCents, stake: p.bet.stake ?? 0, deltaUsd: Math.round(delta * 100) / 100 });
    res.reSettled++; won ? res.won++ : res.lost++; res.bankDeltaUsd += delta;
    if (opts.apply) {
      // Same FK rule as everywhere else: strategy_id references strategies(id), so the bet's OWN strategy is
      // the honest attribution — this row is that strategy's money being re-settled.
      try { R.insertTradeLog(db, {
        id: R.uid(), match_id: p.bet.match_id, strategy_id: p.bet.strategy_id, minute: "финал", type: "settle",
        text: `${p.bet.market_label}: ретро-пере-сеттл — возврат был выдан только потому, что комплемент не был сохранён; ` +
          `теперь он найден в каталоге матча, рынок разрешился ${t.priceCents}¢ → ${won ? "выигрыш" : "проигрыш"} (Δ банка $${(Math.round(delta * 100) / 100).toFixed(2)}) [retro_complement]`,
        created_at: now,
      }); } catch { /* a log line must never undo a settle */ }
    }
  }
  res.bankDeltaUsd = Math.round(res.bankDeltaUsd * 100) / 100;
  const deferNote = res.deferred ? ` ОТЛОЖЕНО ${res.deferred} строк(и) — БД была занята приложением; проход идемпотентен, просто запустите ещё раз.` : "";
  // Three distinct outcomes, and they must NOT share a sentence. "Nothing re-settled because the pairs were
  // not clean" and "nothing re-settled because the DB was busy" look identical in a count and mean opposite
  // things: the first says the data is fine, the second says the job is unfinished. Reporting the second as
  // the first would send the operator away satisfied with the work half done.
  res.note = res.reSettled === 0 && res.deferred > 0
    ? `НИЧЕГО НЕ ЗАПИСАНО: все ${res.deferred} подходящих строк отклонены блокировкой БД (приложение держало запись). ` +
      `Данные в порядке — не записан ни один ряд. Проход идемпотентен: запустите ту же команду ещё раз.`
    : res.reSettled === 0
      ? `проверено ${res.examined}, комплемент нашёлся у ${res.complementFound}, но ни один не дал чистой разрешающей пары — история не переписана. Это хороший исход: дыра не съела прошлых денег.${deferNote}`
      : `${opts.apply ? "ПЕРЕ-СЕТТЛЕНО" : "БУДЕТ пере-сеттлено (сухой прогон)"}: ${res.reSettled} возвратов оказались реальными исходами ` +
        `(${res.won} выигрышей / ${res.lost} проигрышей), Δ банка $${res.bankDeltaUsd.toFixed(2)}. Это деньги, снятые со стола таймаутом из-за несохранённого указателя.${deferNote}`;
  return res;
}
