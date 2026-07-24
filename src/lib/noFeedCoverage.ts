// ============================================================
// EDGE LAB — NO-FEED COVERAGE (link-rate × league)  [SERVER-ONLY, read-only]  (P3 / B2, batch-7)
//
// The biggest single lump of missed edge: euro-cup pairs that never bind to an ESPN/StatPal feed. A Polymarket
// match with markets but NO `match_live` row is BLIND — the entry gate treats it as uncovered, so it takes 0
// managed entries (the coverage casualty). This turns that gap into DATA (the «немой ноль» principle): the
// link-rate overall, per league, and — the priority — for the euro cups, against a numeric target (≥85%).
//
//   • covered = a match_live row exists for the fixture (enrichFromEspn bound a provider event to it).
//   • blind   = a Polymarket-listed football fixture (≥1 market) with NO match_live row.
//   • link-rate = covered / (covered + blind), per the same cohort.
//
// Extensions over the raw link-rate (spec P3):
//   (a) per blind euro pair, a DERIVED rejection reason (unlinked league / possible date-leg mismatch / name
//       didn't match the board) so a human fixes by specifics, not hypotheses. A LIVE provider-candidate probe
//       is the separate &probe path (needs the provider); this read-only core diagnoses from stored state.
//   (b) a "blind pairs × league × day" breakdown, persisted for the weekly digest.
//   (c) the euro link-rate against the ≥85% target with an explicit meets/miss verdict.
// Exposed at GET /api/profiles?report=no_feed_coverage[&days=N]. Read-only; the persist helper writes one meta key.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { UEFA_TWO_LEG } from "./footballIntegrity.js";

const qualBase = (lg: string | null | undefined) => String(lg ?? "").replace(/_qual$/i, "");
/** A euro/CONMEBOL two-leg cup — the priority coverage cohort. */
export function isEuroCupLeague(externalLeague: string | null | undefined): boolean {
  return UEFA_TWO_LEG.has(qualBase(externalLeague));
}

export interface LeagueCoverage { league: string; euro: boolean; total: number; covered: number; blind: number; linkRatePct: number | null }
export interface BlindPair { match: string; league: string; day: string; euro: boolean; reason: string }
export interface CoverageCut { total: number; covered: number; blind: number; linkRatePct: number | null }
export interface BindReject { home: string; away: string; recordKickoff: string | null; espnDate: string | null; gapHours: number | null; league: string; reason: string; possibleReschedule: boolean }
export interface NoFeedCoverage {
  windowDays: number;
  overall: { total: number; covered: number; blind: number; linkRatePct: number | null };
  euro: { total: number; covered: number; blind: number; linkRatePct: number | null; targetPct: number; meetsTarget: boolean };
  // P3(1): the HONEST miss %, over fixtures ESPN should already have boarded (kickoff past, or within
  // nearKickoffHours) — strips the future-fixture noise that deflates the full-window link-rate.
  nearKickoff: { withinHours: number; overall: CoverageCut; euro: CoverageCut & { targetPct: number; meetsTarget: boolean } };
  byLeague: LeagueCoverage[];
  byLeagueDay: { league: string; day: string; euro: boolean; total: number; blind: number }[]; // blind pairs × league × day
  blindEuroPairs: BlindPair[];   // the actionable list: which euro pairs are blind, and the derived reason
  blindPairsSample: BlindPair[]; // a small sample across ALL leagues (context beyond euro)
  legMismatchTally: unknown;     // the persisted enrich leg-mismatch marker (date_gap / orient) for context
  // P3-audit(2): the per-rejection detail behind the date_gap tally — a 1–3 day gap is a possible RESCHEDULE
  // (a real match the gate may be over-tightly cutting), a ~week gap is a genuine other leg.
  bindRejections: BindReject[];
  note: string;
}

const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const dayOf = (iso: string | null): string => (iso && iso.length >= 10 ? iso.slice(0, 10) : "—");

/**
 * Link-rate over the current football cohort (window around now). A fixture counts if it's football, carries at
 * least one Polymarket market, and its kickoff is inside the window (or unknown → included; a listed pair with
 * no kickoff is still a coverage question). Pure read; never writes.
 */
export function buildNoFeedCoverage(db: Database, opts: { nowMs?: number; windowDays?: number; env?: Record<string, string | undefined> } = {}): NoFeedCoverage {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();
  const windowDays = opts.windowDays ?? 14;
  const targetPct = Math.max(1, Number(env.EURO_LINK_RATE_TARGET_PCT ?? 85));
  const nearHours = Math.max(1, Number(env.COVERAGE_NEAR_KICKOFF_HOURS ?? 48));
  const loMs = nowMs - windowDays * 86_400_000, hiMs = nowMs + windowDays * 86_400_000;
  const nearHiMs = nowMs + nearHours * 3_600_000; // kickoff already past, or within nearHours → ESPN should have boarded it

  const byLeague = new Map<string, LeagueCoverage>();
  const byLeagueDay = new Map<string, { league: string; day: string; euro: boolean; total: number; blind: number }>();
  const blindEuroPairs: BlindPair[] = [];
  const blindPairsAll: BlindPair[] = [];
  const overall = { total: 0, covered: 0, blind: 0 };
  const euro = { total: 0, covered: 0, blind: 0 };
  const nearOverall = { total: 0, covered: 0, blind: 0 };
  const nearEuro = { total: 0, covered: 0, blind: 0 };

  for (const comp of R.listCompetitions(db).filter((c) => c.sport_id === "football")) {
    const league = String(comp.external_league || comp.name || "—");
    const isEuro = isEuroCupLeague(comp.external_league);
    const linked = !!(comp.external_league && String(comp.external_league).trim());
    for (const m of R.listMatches(db, comp.id)) {
      // In-window fixture with a Polymarket market = a coverage question. (A kickoff we don't have is included.)
      const koMs = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
      if (Number.isFinite(koMs) && (koMs < loMs || koMs > hiMs)) continue;
      if (R.latestMarkets(db, m.id).length === 0) continue; // never Polymarket-listed → not a link candidate
      const covered = !!R.getMatchLive(db, m.id);

      overall.total++; if (covered) overall.covered++; else overall.blind++;
      if (isEuro) { euro.total++; if (covered) euro.covered++; else euro.blind++; }

      // P3(1): near-kickoff cut — kickoff past OR ≤ nearHours ahead (a known kickoff ESPN should already carry).
      // A fixture with no kickoff we can't place on the timeline → excluded from this honest slice.
      if (Number.isFinite(koMs) && koMs <= nearHiMs) {
        nearOverall.total++; if (covered) nearOverall.covered++; else nearOverall.blind++;
        if (isEuro) { nearEuro.total++; if (covered) nearEuro.covered++; else nearEuro.blind++; }
      }

      const lc = byLeague.get(league) ?? { league, euro: isEuro, total: 0, covered: 0, blind: 0, linkRatePct: null };
      lc.total++; if (covered) lc.covered++; else lc.blind++;
      byLeague.set(league, lc);

      const day = dayOf(m.kickoff_at);
      const ldKey = `${league}|${day}`;
      const ld = byLeagueDay.get(ldKey) ?? { league, day, euro: isEuro, total: 0, blind: 0 };
      ld.total++; if (!covered) ld.blind++;
      byLeagueDay.set(ldKey, ld);

      if (!covered) {
        // Derive WHY this pair is blind from stored state (a live provider probe is the separate &probe path).
        const reason = !linked
          ? "лига не привязана к провайдеру (пустой external_league)"
          : isEuro
            ? "нет match_live: имя не сматчилось на доске / возможен date-leg mismatch (канонизация имён/дата)"
            : "нет match_live: провайдер не покрывает лигу или имя не сматчилось";
        const bp: BlindPair = { match: `${m.home}—${m.away}`, league, day, euro: isEuro, reason };
        blindPairsAll.push(bp);
        if (isEuro) blindEuroPairs.push(bp);
      }
    }
  }

  for (const lc of byLeague.values()) lc.linkRatePct = pct(lc.covered, lc.total);
  const leagues = [...byLeague.values()].sort((a, b) => (Number(b.euro) - Number(a.euro)) || b.blind - a.blind || b.total - a.total);
  const euroLink = pct(euro.covered, euro.total);
  const meetsTarget = euroLink != null && euroLink >= targetPct;

  let legMismatchTally: unknown = null;
  try { legMismatchTally = JSON.parse(R.metaGet(db, "fixture_leg_mismatch") ?? "null"); } catch { legMismatchTally = null; }

  // P3-audit(2): pull the per-rejection detail; flag a 1–3 day gap as a possible reschedule (over-tight cut).
  const bindRejections: BindReject[] = [];
  try {
    const raw = JSON.parse(R.metaGet(db, "fixture_bind_rejections") ?? "null");
    for (const r of (raw?.rejects ?? []) as Omit<BindReject, "possibleReschedule">[]) {
      bindRejections.push({ ...r, possibleReschedule: r.gapHours != null && r.gapHours >= 24 && r.gapHours <= 72 });
    }
  } catch { /* best-effort */ }

  const nearEuroLink = pct(nearEuro.covered, nearEuro.total);
  const note = euro.total === 0
    ? `нет еврокубковых пар в окне ±${windowDays}д — link-rate еврокубков не считается`
    : meetsTarget
      ? `✅ ЦЕЛЬ ДОСТИГНУТА: link-rate еврокубков ${euroLink}% ≥ ${targetPct}% (${euro.covered}/${euro.total}); слепых ${euro.blind}`
      : `⚠️ НИЖЕ ЦЕЛИ: link-rate еврокубков ${euroLink ?? "—"}% < ${targetPct}% (${euro.covered}/${euro.total}); ${euro.blind} слепых пар — разобрать по blindEuroPairs (имя/дата/лига)`;

  return {
    windowDays,
    overall: { ...overall, linkRatePct: pct(overall.covered, overall.total) },
    euro: { ...euro, linkRatePct: euroLink, targetPct, meetsTarget },
    nearKickoff: {
      withinHours: nearHours,
      overall: { ...nearOverall, linkRatePct: pct(nearOverall.covered, nearOverall.total) },
      euro: { ...nearEuro, linkRatePct: nearEuroLink, targetPct, meetsTarget: nearEuroLink != null && nearEuroLink >= targetPct },
    },
    byLeague: leagues,
    byLeagueDay: [...byLeagueDay.values()].filter((x) => x.blind > 0).sort((a, b) => (Number(b.euro) - Number(a.euro)) || b.blind - a.blind),
    blindEuroPairs: blindEuroPairs.slice(0, 40),
    blindPairsSample: blindPairsAll.slice(0, 20),
    legMismatchTally,
    bindRejections,
    note,
  };
}

/** Persist the "blind pairs × league × day" digest for the weekly report. One meta key; best-effort. */
export function persistNoFeedCoverage(db: Database, now: string, opts: { nowMs?: number; windowDays?: number; env?: Record<string, string | undefined> } = {}): void {
  try {
    const r = buildNoFeedCoverage(db, opts);
    const digest = { at: now, overall: r.overall, euro: r.euro, byLeagueDay: r.byLeagueDay, blindEuroPairs: r.blindEuroPairs.length };
    R.metaSet(db, "blind_pairs_daily", JSON.stringify(digest), now);
  } catch { /* never block the cycle on a digest write */ }
}
