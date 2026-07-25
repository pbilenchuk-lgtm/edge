// ============================================================
// EDGE LAB — THESIS exposure + match-wide cap  [S5, strategic master spec R0.5]
//
// A correlated stack is ONE thesis, not many bets: «Over 0.5 + Over 1.5 одной команды», a team's moneyline
// + its −handicap + its Over-lines — all resolve on the SAME event, so sized independently they read as
// diversification when they are a single position at multiplied size (audit: 91% of P&L in 3 matches).
//
// correlationKey (strategist.ts) already collapses these into one key (dom:home / dom:away / total:over /
// total:under / ko:*). This module (a) REPORTS live per-match thesis exposure across ALL strategies/profiles
// and (b) gives the entry path a MATCH-WIDE room check so a thesis can't exceed the match cap — the real=on
// blocker (R0.5). Cap is env THESIS_MATCH_CAP_USD; 0 (default) = report-only, no clamp (paper unchanged).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { correlationKey } from "./strategist.js";

export function thesisCapUsd(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.THESIS_MATCH_CAP_USD);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = no enforcement (report only)
}

/** Live $ already staked on one match's thesis (open bets sharing the correlationKey), across EVERY
 *  strategy and profile — the correlated group, not the per-pair slice. */
export function matchThesisExposure(db: Database, matchId: string, cKey: string, home: string, away: string): number {
  let sum = 0;
  for (const b of R.betsForMatch(db, matchId)) {
    if (b.status !== "open") continue;
    if (correlationKey(b.market_label, home, away) === cKey) sum += b.stake ?? 0;
  }
  return Math.round(sum * 100) / 100;
}

/** Remaining room for a thesis before the match cap. Infinity when the cap is disabled (0). */
export function matchThesisRoom(db: Database, matchId: string, cKey: string, home: string, away: string, env: Record<string, string | undefined> = process.env): number {
  const cap = thesisCapUsd(env);
  if (cap <= 0) return Infinity;
  return Math.max(0, cap - matchThesisExposure(db, matchId, cKey, home, away));
}

export interface ThesisRow { matchId: string; match: string; category: string; thesis: string; stakeUsd: number; bets: number; markets: string[]; strategies: string[]; overCap: boolean }
export interface ThesisExposureReport { capUsd: number; theses: ThesisRow[]; breaches: number; note: string }

/** Per-match per-thesis live exposure across the whole open book — the «Отчёт экспозиции по тезисам».
 *  Read-only. `overCap` flags any thesis whose combined stake exceeds THESIS_MATCH_CAP_USD (when set). */
export function buildThesisExposure(db: Database, env: Record<string, string | undefined> = process.env): ThesisExposureReport {
  const cap = thesisCapUsd(env);
  const comps = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  const byKey = new Map<string, { matchId: string; match: string; category: string; thesis: string; stake: number; markets: Set<string>; strategies: Set<string> }>();
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      const open = R.betsForMatch(db, m.id).filter((b) => b.status === "open");
      if (!open.length) continue;
      for (const b of open) {
        const ck = correlationKey(b.market_label, m.home, m.away);
        if (!ck) continue; // uncorrelated single market — not a stacked thesis
        const key = `${m.id}::${ck}`;
        const g = byKey.get(key) ?? byKey.set(key, { matchId: m.id, match: `${m.home} — ${m.away}`, category: comps.get(m.competition_id)?.name ?? m.competition_id, thesis: ck, stake: 0, markets: new Set(), strategies: new Set() }).get(key)!;
        g.stake += b.stake ?? 0; g.markets.add(b.market_label); g.strategies.add(b.strategy_id);
      }
    }
  }
  const theses = [...byKey.values()]
    .filter((g) => g.markets.size >= 2) // a THESIS is ≥2 correlated legs stacked; a lone leg isn't a stack
    .map((g) => ({ matchId: g.matchId, match: g.match, category: g.category, thesis: g.thesis, stakeUsd: Math.round(g.stake * 100) / 100, bets: g.markets.size, markets: [...g.markets], strategies: [...g.strategies], overCap: cap > 0 && g.stake > cap }))
    .sort((a, b) => b.stakeUsd - a.stakeUsd);
  const breaches = theses.filter((t) => t.overCap).length;
  const note = cap <= 0
    ? `THESIS_MATCH_CAP_USD не задан — отчёт только показывает стеки (гейт выключен). Это R0.5-блокер реала: задай кэп до real=on.`
    : breaches ? `⚠ ${breaches} тезис(ов) превышают кэп $${cap} — коррелированный стек больше лимита матча.` : `все тезисы в пределах кэпа $${cap}.`;
  return { capUsd: cap, theses, breaches, note };
}
