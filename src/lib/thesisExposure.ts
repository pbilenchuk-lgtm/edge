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

/** The per-match thesis cap in $. [M12] Prefer a FRACTION of the authoritative bank (THESIS_MATCH_CAP_FRAC ×
 *  THESIS_BANK_USD) so the cap tracks drawdowns/growth instead of being a hand-set constant; falls back to the
 *  absolute THESIS_MATCH_CAP_USD. 0 = no enforcement (report only). */
export function thesisCapUsd(env: Record<string, string | undefined> = process.env): number {
  const frac = Number(env.THESIS_MATCH_CAP_FRAC), bank = Number(env.THESIS_BANK_USD);
  if (Number.isFinite(frac) && frac > 0 && Number.isFinite(bank) && bank > 0) return Math.round(frac * bank * 100) / 100;
  const n = Number(env.THESIS_MATCH_CAP_USD);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** [M11] The DAILY correlated-cluster cap: a ceiling ABOVE the per-match cap for the same directional thesis
 *  stacked across DIFFERENT matches in one competition on one day (e.g. five CL "favourite wins" at $250 each
 *  = $1,250 of one directional bet the per-match cap treats as independent). Default 2× the per-match cap
 *  (THESIS_DAILY_CLUSTER_MULT). 0 when the per-match cap is off. */
export function dailyClusterCapUsd(env: Record<string, string | undefined> = process.env): number {
  const cap = thesisCapUsd(env);
  if (cap <= 0) return 0;
  const mult = Number(env.THESIS_DAILY_CLUSTER_MULT);
  return Math.round(cap * (Number.isFinite(mult) && mult > 0 ? mult : 2) * 100) / 100;
}

const dayOfKick = (iso: string | null | undefined) => (iso && iso.length >= 10 ? iso.slice(0, 10) : "");

/** Live $ staked on ONE directional thesis (cKey) across EVERY match of a competition on ONE kickoff-day —
 *  the cross-match correlated cluster. Proposed+open by default (autoEnter passes ["open"] for the fill gate). */
export function dailyClusterExposure(db: Database, competitionId: string, day: string, cKey: string, statuses: readonly string[] = ["open", "proposed"]): number {
  let sum = 0;
  for (const m of R.listMatches(db, competitionId)) {
    if (dayOfKick(m.kickoff_at) !== day) continue;
    for (const b of R.betsForMatch(db, m.id)) {
      if (!statuses.includes(b.status)) continue;
      if (correlationKey(b.market_label, m.home, m.away) === cKey) sum += b.stake ?? 0;
    }
  }
  return Math.round(sum * 100) / 100;
}

/** Remaining room for a directional thesis before the DAILY cross-match cluster cap. Infinity when disabled. */
export function dailyClusterRoom(db: Database, competitionId: string, day: string, cKey: string, env: Record<string, string | undefined> = process.env, statuses: readonly string[] = ["open", "proposed"]): number {
  const cap = dailyClusterCapUsd(env);
  if (cap <= 0) return Infinity;
  return Math.max(0, cap - dailyClusterExposure(db, competitionId, day, cKey, statuses));
}

/** Live $ staked on one match's thesis (bets sharing the correlationKey), across EVERY strategy and profile —
 *  the correlated group, not the per-pair slice. [X1] Counts PROPOSED as well as OPEN by default so the
 *  proposal-time room check sees siblings already proposed this run (many pairs propose before any fill); the
 *  fill-time re-check in autoEnter passes `["open"]` to count only COMMITTED exposure. */
export function matchThesisExposure(db: Database, matchId: string, cKey: string, home: string, away: string, statuses: readonly string[] = ["open", "proposed"]): number {
  let sum = 0;
  for (const b of R.betsForMatch(db, matchId)) {
    if (!statuses.includes(b.status)) continue;
    if (correlationKey(b.market_label, home, away) === cKey) sum += b.stake ?? 0;
  }
  return Math.round(sum * 100) / 100;
}

/** Remaining room for a thesis before the match cap. Infinity when the cap is disabled (0). `statuses` picks
 *  which exposure counts (default proposed+open; autoEnter uses open-only for the authoritative fill gate). */
export function matchThesisRoom(db: Database, matchId: string, cKey: string, home: string, away: string, env: Record<string, string | undefined> = process.env, statuses: readonly string[] = ["open", "proposed"]): number {
  const cap = thesisCapUsd(env);
  if (cap <= 0) return Infinity;
  return Math.max(0, cap - matchThesisExposure(db, matchId, cKey, home, away, statuses));
}

export interface ThesisRow { matchId: string; match: string; category: string; thesis: string; stakeUsd: number; bets: number; markets: string[]; strategies: string[]; overCap: boolean }
export interface DailyClusterRow { category: string; day: string; direction: string; stakeUsd: number; matches: number; overCap: boolean }
export interface ThesisExposureReport { capUsd: number; dailyClusterCapUsd: number; theses: ThesisRow[]; dailyClusters: DailyClusterRow[]; breaches: number; note: string }

/** Per-match per-thesis live exposure across the whole open book — the «Отчёт экспозиции по тезисам».
 *  Read-only. `overCap` flags any thesis whose combined stake exceeds THESIS_MATCH_CAP_USD (when set). */
export function buildThesisExposure(db: Database, env: Record<string, string | undefined> = process.env): ThesisExposureReport {
  const cap = thesisCapUsd(env);
  const comps = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  const byKey = new Map<string, { matchId: string; match: string; category: string; thesis: string; stake: number; bets: number; markets: Set<string>; strategies: Set<string> }>();
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      const open = R.betsForMatch(db, m.id).filter((b) => b.status === "open");
      if (!open.length) continue;
      for (const b of open) {
        const ck = correlationKey(b.market_label, m.home, m.away);
        if (!ck) continue; // uncorrelated single market — not a stacked thesis
        const key = `${m.id}::${ck}`;
        const g = byKey.get(key) ?? byKey.set(key, { matchId: m.id, match: `${m.home} — ${m.away}`, category: comps.get(m.competition_id)?.name ?? m.competition_id, thesis: ck, stake: 0, bets: 0, markets: new Set(), strategies: new Set() }).get(key)!;
        g.stake += b.stake ?? 0; g.bets++; g.markets.add(b.market_label); g.strategies.add(b.strategy_id);
      }
    }
  }
  // [M9] A THESIS is ≥2 correlated BETS stacked — counted on BET COUNT, not distinct labels. The old
  // `markets.size >= 2` HID a same-label stack (three profiles each buying "Inter Over 0.5" = 1 label →
  // dropped, even over the cap), so enforcement (matchThesisExposure, which sums by key) and this human-
  // oversight report disagreed on what a thesis is. Also always surface an over-cap cluster, single-label or not.
  const theses = [...byKey.values()]
    .filter((g) => g.bets >= 2 || (cap > 0 && g.stake > cap))
    .map((g) => ({ matchId: g.matchId, match: g.match, category: g.category, thesis: g.thesis, stakeUsd: Math.round(g.stake * 100) / 100, bets: g.bets, markets: [...g.markets], strategies: [...g.strategies], overCap: cap > 0 && g.stake > cap }))
    .sort((a, b) => b.stakeUsd - a.stakeUsd);
  // [M11] daily cross-match clusters: same competition × kickoff-day × direction, summed across matches.
  const dailyCap = dailyClusterCapUsd(env);
  const byDaily = new Map<string, { category: string; day: string; direction: string; stake: number; matches: Set<string> }>();
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      const day = dayOfKick(m.kickoff_at); if (!day) continue;
      for (const b of R.betsForMatch(db, m.id).filter((x) => x.status === "open")) {
        const ck = correlationKey(b.market_label, m.home, m.away); if (!ck) continue;
        const key = `${c.id}|${day}|${ck}`;
        const g = byDaily.get(key) ?? byDaily.set(key, { category: comps.get(c.id)?.name ?? c.id, day, direction: ck, stake: 0, matches: new Set() }).get(key)!;
        g.stake += b.stake ?? 0; g.matches.add(m.id);
      }
    }
  }
  const dailyClusters = [...byDaily.values()]
    .filter((g) => g.matches.size >= 2 || (dailyCap > 0 && g.stake > dailyCap)) // a cross-match cluster is ≥2 matches
    .map((g) => ({ category: g.category, day: g.day, direction: g.direction, stakeUsd: Math.round(g.stake * 100) / 100, matches: g.matches.size, overCap: dailyCap > 0 && g.stake > dailyCap }))
    .sort((a, b) => b.stakeUsd - a.stakeUsd);
  const dailyBreaches = dailyClusters.filter((d) => d.overCap).length;

  const breaches = theses.filter((t) => t.overCap).length;
  const note = cap <= 0
    ? `THESIS_MATCH_CAP_USD/FRAC не задан — отчёт только показывает стеки (гейт выключен). Это R0.5-блокер реала: задай кэп до real=on.`
    : (breaches || dailyBreaches) ? `⚠ ${breaches} тезис(ов) > кэпа матча $${cap}${dailyBreaches ? `; ${dailyBreaches} дневных кластер(ов) > кэпа $${dailyCap} (same-day×лига×направление)` : ""} — коррелированный стек больше лимита.` : `все тезисы в пределах кэпа матча $${cap} и дневного кластера $${dailyCap}.`;
  return { capUsd: cap, dailyClusterCapUsd: dailyCap, theses, dailyClusters, breaches, note };
}
