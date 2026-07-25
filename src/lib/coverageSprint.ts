// ============================================================
// EDGE LAB — COVERAGE SPRINT synthesis  [S11, strategic master spec]  (read-only)
//
// The diagnosis pieces already exist (no_feed_coverage: link-rate × league + per-pair reason; blind_funded:
// funded fixtures that ran past kickoff unbound; the &probe: ESPN's actual spellings). What was missing is the
// ONE prioritized worksheet a sprint runs off: how far below the 85% euro target we are, HOW MANY binds close
// it, which leagues are worst (uefa.wchampions, bra.1…), and — the «поимённый unbound» — every currently-blind
// funded fixture NAMED with its class and the concrete fix (map a league / add a name alias / dark board).
//
// This is pure synthesis over buildNoFeedCoverage + listBlindFundedFootball; it computes no new coverage state,
// it RANKS the existing gap into an actionable order and does the binds-to-target arithmetic. The persisted
// alias overlay (teamAliases) is surfaced here too, so the sprint shows what's already been aliased.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { buildNoFeedCoverage, isEuroCupLeague, type LeagueCoverage } from "./noFeedCoverage.js";
import { listTeamAliases } from "./teamAliases.js";

/** Minimum binds (of the currently-blind fixtures) needed to lift covered/total to `targetPct`, at fixed
 *  total. 0 if already at/above target; capped at the number actually blind. */
export function bindsNeededForTarget(covered: number, total: number, targetPct: number): number {
  if (total <= 0) return 0;
  const need = Math.ceil((targetPct / 100) * total - covered);
  return Math.max(0, Math.min(total - covered, need));
}

export type UnboundClass = "no_league" | "name_or_dark";
export interface UnboundItem {
  match: string; league: string; euro: boolean; kickoff: string | null; state?: string;
  cls: UnboundClass; action: string; source: "blind_funded" | "near_kickoff";
}

export interface LeagueGap extends LeagueCoverage { gapToTargetPp: number | null; bindsNeeded: number }

export interface CoverageSprint {
  at: string;
  target: { euroTargetPct: number; nearKickoffHours: number };
  headline: {
    euroNearKickoff: { covered: number; total: number; linkRatePct: number | null; meetsTarget: boolean; bindsNeeded: number };
    euroWindow: { covered: number; total: number; linkRatePct: number | null; meetsTarget: boolean };
    overallNearKickoff: { covered: number; total: number; linkRatePct: number | null };
  };
  worstLeagues: LeagueGap[];              // link-rate ascending, gap-to-target + binds-needed per league
  unbound: UnboundItem[];                  // the NAMED worklist — funded-blind + near-kickoff-blind, deduped
  unboundByClass: { no_league: number; name_or_dark: number };
  // [M17] the DOLLAR-weighted blind view: a count-based 85% can pass while the biggest BUDGETS sit blind. This
  // reconciles the target against the budget of funded comps that currently have ≥1 blind funded match.
  moneyBlind: { fundedComps: number; fundedBudgetUsd: number; blindComps: { league: string; budgetUsd: number; blindMatches: number }[]; blindBudgetUsd: number; blindBudgetPct: number | null };
  aliasOverlay: { count: number; recent: { from: string; to: string }[] }; // what's already been aliased
  note: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** S11 sprint sheet. `minLeagueSample` hides tiny leagues from the worst-list noise (default 3). Deterministic
 *  given the DB + nowMs; no network (the live probe is the separate no_feed_coverage&probe=1 path). */
export function buildCoverageSprint(db: Database, opts: { nowMs?: number; windowDays?: number; minLeagueSample?: number; env?: Record<string, string | undefined> } = {}): CoverageSprint {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const targetPct = Math.max(1, Number(env.EURO_LINK_RATE_TARGET_PCT ?? 85));
  const minSample = Math.max(1, opts.minLeagueSample ?? 3);

  const cov = buildNoFeedCoverage(db, { nowMs, windowDays: opts.windowDays, env });
  const nearHours = cov.nearKickoff.withinHours;

  // Headline: the near-kickoff euro cut is the honest number (strips future-fixture noise).
  const euroNK = cov.nearKickoff.euro;
  const euroNKbinds = bindsNeededForTarget(euroNK.covered, euroNK.total, targetPct);

  // Worst leagues: link-rate ascending, over leagues with enough sample; each with gap + binds-to-target.
  const worstLeagues: LeagueGap[] = cov.byLeague
    .filter((l) => l.total >= minSample && l.linkRatePct != null)
    .map((l) => ({ ...l, gapToTargetPp: l.linkRatePct != null ? r1(targetPct - l.linkRatePct) : null, bindsNeeded: bindsNeededForTarget(l.covered, l.total, targetPct) }))
    .sort((a, b) => (a.linkRatePct ?? 999) - (b.linkRatePct ?? 999) || b.blind - a.blind)
    .slice(0, 20);

  // The NAMED worklist. Two sources, deduped by match+day:
  //   • blind_funded — funded fixtures that already ran past kickoff unbound (the costliest: real money on the
  //     table, blind). reason no_league (comp unmapped) vs unbound (league set, bind failed → name/dark).
  //   • near-kickoff blind euro pairs — about to kick off, still blind (pre-emptive fix window).
  const seen = new Set<string>();
  const unbound: UnboundItem[] = [];
  const pushItem = (it: UnboundItem, day: string) => {
    const key = `${it.match}|${day}`;
    if (seen.has(key)) return; seen.add(key);
    unbound.push(it);
  };
  const actionFor = (cls: UnboundClass, euro: boolean): string =>
    cls === "no_league"
      ? "привязать лигу: добавить external_league (SERIES_ESPN_LEAGUE / LEAGUE_NAME_ESPN в engine.ts) — без неё матч тёмный"
      : `имя не сматчилось ИЛИ доска пустая: прогнать ?report=no_feed_coverage&probe=1${euro ? "" : ""}, взять ESPN-написание из candidates и добавить псевдоним (addAlias) — если кандидатов нет, доска провайдера тёмная (upstream)`;

  for (const b of R.listBlindFundedFootball(db, { nowMs })) {
    const cls: UnboundClass = b.reason === "no_league" ? "no_league" : "name_or_dark";
    const euro = isEuroCupLeague(b.league);
    pushItem({ match: b.match, league: String(b.league || b.comp || "—"), euro, kickoff: b.kickoff, state: b.state, cls, action: actionFor(cls, euro), source: "blind_funded" }, (b.kickoff ?? "").slice(0, 10));
  }
  for (const p of cov.blindEuroPairs) {
    const cls: UnboundClass = /не привязана/.test(p.reason) ? "no_league" : "name_or_dark";
    pushItem({ match: p.match, league: p.league, euro: true, kickoff: null, cls, action: actionFor(cls, true), source: "near_kickoff" }, p.day);
  }
  // euro-first, then funded (already-past) before upcoming, then most-recent kickoff.
  unbound.sort((a, b) =>
    (Number(b.euro) - Number(a.euro)) ||
    (Number(a.source === "blind_funded") - Number(b.source === "blind_funded")) * -1 ||
    (b.kickoff ?? "").localeCompare(a.kickoff ?? ""));

  const aliases = listTeamAliases(db);
  const unboundByClass = { no_league: unbound.filter((u) => u.cls === "no_league").length, name_or_dark: unbound.filter((u) => u.cls === "name_or_dark").length };

  // [M17] dollar-weighted blind view: which funded-comp BUDGETS have blind matches, vs total funded budget.
  const fundedComps = R.listCompetitions(db).filter((c) => c.sport_id === "football" && (c.budget ?? 0) > 0);
  const fundedBudgetUsd = Math.round(fundedComps.reduce((s, c) => s + (c.budget ?? 0), 0) * 100) / 100;
  const blindByComp = new Map<string, number>();
  for (const b of R.listBlindFundedFootball(db, { nowMs })) blindByComp.set(String(b.league || b.comp), (blindByComp.get(String(b.league || b.comp)) ?? 0) + 1);
  const compByLeague = new Map(fundedComps.map((c) => [String(c.external_league || c.name), c]));
  const blindComps = [...blindByComp.entries()]
    .map(([league, blindMatches]) => ({ league, budgetUsd: Math.round((compByLeague.get(league)?.budget ?? 0) * 100) / 100, blindMatches }))
    .filter((x) => x.budgetUsd > 0)
    .sort((a, b) => b.budgetUsd - a.budgetUsd);
  const blindBudgetUsd = Math.round(blindComps.reduce((s, c) => s + c.budgetUsd, 0) * 100) / 100;
  const moneyBlind = { fundedComps: fundedComps.length, fundedBudgetUsd, blindComps, blindBudgetUsd, blindBudgetPct: fundedBudgetUsd > 0 ? r1((blindBudgetUsd / fundedBudgetUsd) * 100) : null };

  const note = euroNK.total === 0
    ? `нет еврокубковых пар у kickoff в окне ${nearHours}ч — цель не считается сейчас; следи по window-срезу`
    : euroNK.meetsTarget
      ? `✅ ЦЕЛЬ: euro near-kickoff ${euroNK.linkRatePct}% ≥ ${targetPct}% (${euroNK.covered}/${euroNK.total}). Держим: разбирай unbound, чтобы не проседать.`
      : `⚠️ ${euroNK.linkRatePct ?? "—"}% < ${targetPct}%: нужно ПРИВЯЗАТЬ ещё ${euroNKbinds} из ${euroNK.total - euroNK.covered} слепых euro-пар у kickoff. Приоритет — unbound (name_or_dark: ${unboundByClass.name_or_dark} чинятся псевдонимом, no_league: ${unboundByClass.no_league} — маппингом лиги).`;

  return {
    at,
    target: { euroTargetPct: targetPct, nearKickoffHours: nearHours },
    headline: {
      euroNearKickoff: { covered: euroNK.covered, total: euroNK.total, linkRatePct: euroNK.linkRatePct, meetsTarget: euroNK.meetsTarget, bindsNeeded: euroNKbinds },
      euroWindow: { covered: cov.euro.covered, total: cov.euro.total, linkRatePct: cov.euro.linkRatePct, meetsTarget: cov.euro.meetsTarget },
      overallNearKickoff: { covered: cov.nearKickoff.overall.covered, total: cov.nearKickoff.overall.total, linkRatePct: cov.nearKickoff.overall.linkRatePct },
    },
    worstLeagues,
    unbound: unbound.slice(0, 60),
    unboundByClass,
    moneyBlind,
    aliasOverlay: { count: aliases.length, recent: aliases.slice(-10).reverse().map((a) => ({ from: a.from, to: a.to })) },
    note,
  };
}
