// ============================================================
// EDGE LAB — profile × clean-epoch × strategy SIGNAL-LEVEL cut  [S6, strategic master spec]
//
// The units-fix (R0.1) said a verdict is per SIGNAL, not per record. This cut asks the next question:
// how does each RISK PROFILE fare, per strategy, on the CLEAN epoch — measured on signals, not records.
//
// A signal collapses the 4-profile fan-out of ONE decision (win/CLV are shared). So why cut by profile at
// all? Because the profiles do NOT enter the same set of decisions: a higher entry bar (conservative) skips
// signals the others take, and each profile SIZES its own record — so P&L / ROI / the entered signal-SET
// genuinely differ. Within one profile, collapseToSignals is ~1:1 (that profile has one record per decision,
// plus partials), so the per-profile signal count IS its decision count.
//
// «Clean epoch» here is the code-epoch floor e5 (same floor the football-epoch backfill uses) applied to
// EVERY strategy — football already drops epoch_unknown in betRecords; the e5 floor extends the same honesty
// to tennis, which has no football_epoch column. There is NO «restored history» (owner: она не существует) —
// the cut is computed on forward clean-epoch data, and small n stay small n WITH A LABEL.
//
// The headline output is the CONSERVATIVE ANOMALY: conservative carried the worst CLV of any profile
// (cross-strategy ≈ −2.5¢, beats-close ~15%). This module localizes WHY: the signals conservative SKIPPED
// that its peers took (the structural entry-bar gap), and its CLV/beat-close deficit vs those peers.
// ============================================================

import type { Database } from "./db.js";
import { betRecords, betRecordsExcluded, type BetRec, type ProfileFilter } from "./profileAnalytics.js";
import { collapseToSignals, signalCohort, signalKey, SIGNAL_N_PRELIM, SIGNAL_N_STABLE, type SignalCohort } from "./signals.js";
import { epochNum } from "./codeEpoch.js";

/** e5 clean floor — bets whose ENTRY code-epoch is below this are pre-clean and excluded from the cut. Kept
 *  identical to footballIntegrity's backfill floor so the two agree by construction. */
export const CLEAN_EPOCH_FLOOR = 5;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Keep only clean-epoch records: entry code-epoch ≥ e5. (Football epoch_unknown is already gone in
 *  betRecords; this adds the same code-epoch honesty for tennis and re-affirms it for football.) */
export function cleanEpochRecords(recs: BetRec[], floor = CLEAN_EPOCH_FLOOR): BetRec[] {
  return recs.filter((r) => epochNum(r.codeVersion) >= floor);
}

export interface ProfileStratCell {
  strategyId: string; profileId: string;
  nSignals: number; nRecords: number; nDecided: number;
  winPct: number | null; meanImpliedPct: number | null; binomP: number | null; beatsMarket: boolean;
  clvMeanCents: number | null; clvT: number | null; clvSignificant: boolean;
  beatClosePct: number | null;          // share of THIS profile's signals whose CLV closed > entry (>0)
  pnlUsd: number; volumeUsd: number; roiPct: number | null;
  matured: SignalCohort["matured"]; verdict: SignalCohort["verdict"];
  concentrationTop3Pct: number | null; robust: boolean;
  note: string;
}

/** One (strategy × profile) cell: that profile's clean-epoch records collapsed to signals, with the full
 *  signal-level tests plus the profile-specific money view (volume/ROI) and beat-close rate. */
export function profileStratCell(recs: BetRec[], strategyId: string, profileId: string): ProfileStratCell {
  const mine = recs.filter((r) => r.strategyId === strategyId && r.profileId === profileId);
  const cohort = signalCohort(mine, { strategyId });
  const signals = collapseToSignals(mine);
  const withClv = signals.filter((s) => s.clvCents != null);
  const beatClose = withClv.length ? r2((withClv.filter((s) => s.clvCents! > 0).length / withClv.length) * 100) : null;
  const settled = signals.filter((s) => s.settled);
  const volume = settled.reduce((a, s) => a + s.stake, 0);
  const pnl = settled.reduce((a, s) => a + s.pnl, 0);
  return {
    strategyId, profileId,
    nSignals: cohort.nSignals, nRecords: cohort.nRecords, nDecided: cohort.nDecided,
    winPct: cohort.winVsImplied.winPct, meanImpliedPct: cohort.winVsImplied.meanImpliedPct,
    binomP: cohort.winVsImplied.binomP, beatsMarket: cohort.winVsImplied.beatsMarket,
    clvMeanCents: cohort.clv.meanCents, clvT: cohort.clv.t, clvSignificant: cohort.clv.significant,
    beatClosePct: beatClose,
    pnlUsd: r2(pnl), volumeUsd: r2(volume), roiPct: volume > 0 ? r2((pnl / volume) * 100) : null,
    matured: cohort.matured, verdict: cohort.verdict,
    concentrationTop3Pct: cohort.concentration.top3ShareOfGrossPct, robust: cohort.concentration.robust,
    note: cohort.note,
  };
}

const PROFILE_ORDER = ["aggressive", "medium", "conservative"];
const sortProfiles = (ps: string[]) => ps.sort((a, b) => (PROFILE_ORDER.indexOf(a) + 1 || 99) - (PROFILE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));

export interface ConservativeAnomaly {
  strategyId: string;
  conservative: { nSignals: number; clvMeanCents: number | null; beatClosePct: number | null; pnlUsd: number; roiPct: number | null } | null;
  peers: { profiles: string[]; nSignals: number; clvMeanCents: number | null; beatClosePct: number | null } | null;
  clvDeficitCents: number | null;       // conservative meanCLV − peer meanCLV (negative = conservative worse)
  beatCloseDeficitPct: number | null;
  // The structural gap: signals a PEER (medium/aggressive) took on this strategy that conservative did NOT.
  skippedByConservative: { count: number; peerWins: number; peerLosses: number; peerPnlUsd: number; peerClvMeanCents: number | null; examples: { key: string; market: string; profile: string; outcome: string; clvCents: number | null; pnl: number }[] };
  note: string;
}

/** The conservative-profile anomaly, per strategy: its CLV/beat-close deficit vs its own peers, and the
 *  concrete set of signals its higher entry bar SKIPPED that a peer took (with the peers' realized outcome on
 *  exactly those signals — did the bar dodge losers or forgo winners?). This is measurement, not a knob. */
export function conservativeAnomaly(recs: BetRec[], strategyId: string): ConservativeAnomaly {
  const strat = recs.filter((r) => r.strategyId === strategyId);
  const consRecs = strat.filter((r) => r.profileId === "conservative");
  const peerRecs = strat.filter((r) => r.profileId === "medium" || r.profileId === "aggressive");
  const consSignals = collapseToSignals(consRecs);
  const peerSignals = collapseToSignals(peerRecs);

  const meanClv = (ss: typeof consSignals) => { const xs = ss.map((s) => s.clvCents).filter((x): x is number => x != null); return xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null; };
  const beatClose = (ss: typeof consSignals) => { const xs = ss.filter((s) => s.clvCents != null); return xs.length ? r2((xs.filter((s) => s.clvCents! > 0).length / xs.length) * 100) : null; };
  const consClv = meanClv(consSignals), peerClv = meanClv(peerSignals);
  const consBeat = beatClose(consSignals), peerBeat = beatClose(peerSignals);
  const consSettled = consSignals.filter((s) => s.settled);
  const consPnl = r2(consSettled.reduce((a, s) => a + s.pnl, 0));
  const consVol = consSettled.reduce((a, s) => a + s.stake, 0);

  // The structural entry-bar gap: peer decisions (by signal key) that conservative never entered.
  const consKeys = new Set(consRecs.map((r) => signalKey(r)));
  const skipped = peerSignals.filter((s) => !consKeys.has(s.key));
  const skDecided = skipped.filter((s) => s.outcome === "won" || s.outcome === "lost");
  const skClvs = skipped.map((s) => s.clvCents).filter((x): x is number => x != null);
  const skipped_examples = skipped
    .slice()
    .sort((a, b) => (b.clvCents ?? 0) - (a.clvCents ?? 0))
    .slice(0, 8)
    .map((s) => { const rep = peerRecs.find((r) => signalKey(r) === s.key); return { key: s.key, market: s.market, profile: rep?.profileId ?? "?", outcome: s.outcome, clvCents: s.clvCents, pnl: s.pnl }; });

  const clvDeficit = consClv != null && peerClv != null ? r2(consClv - peerClv) : null;
  const beatDeficit = consBeat != null && peerBeat != null ? r2(consBeat - peerBeat) : null;

  const parts: string[] = [];
  if (consSignals.length === 0) parts.push("conservative не имеет сигналов в чистой эпохе по этой стратегии.");
  else {
    parts.push(`conservative: ${consSignals.length} сигн., CLV ${consClv}¢, beat-close ${consBeat}%.`);
    if (clvDeficit != null) parts.push(`дефицит CLV к peers = ${clvDeficit}¢ (${clvDeficit < 0 ? "хуже" : "лучше"}).`);
    if (skipped.length) parts.push(`порог входа пропустил ${skipped.length} peer-сигналов (решённых ${skDecided.length}: ${skDecided.filter((s) => s.outcome === "won").length}W/${skDecided.filter((s) => s.outcome === "lost").length}L, peer-P&L $${r2(skipped.filter((s) => s.settled).reduce((a, s) => a + s.pnl, 0))}) — это структурный разрыв, не проигрыш на входе.`);
  }

  return {
    strategyId,
    conservative: consSignals.length ? { nSignals: consSignals.length, clvMeanCents: consClv, beatClosePct: consBeat, pnlUsd: consPnl, roiPct: consVol > 0 ? r2((consPnl / consVol) * 100) : null } : null,
    peers: peerSignals.length ? { profiles: sortProfiles([...new Set(peerRecs.map((r) => r.profileId))]), nSignals: peerSignals.length, clvMeanCents: peerClv, beatClosePct: peerBeat } : null,
    clvDeficitCents: clvDeficit,
    beatCloseDeficitPct: beatDeficit,
    skippedByConservative: {
      count: skipped.length, peerWins: skDecided.filter((s) => s.outcome === "won").length, peerLosses: skDecided.filter((s) => s.outcome === "lost").length,
      peerPnlUsd: r2(skipped.filter((s) => s.settled).reduce((a, s) => a + s.pnl, 0)),
      peerClvMeanCents: skClvs.length ? r2(skClvs.reduce((a, b) => a + b, 0) / skClvs.length) : null,
      examples: skipped_examples,
    },
    note: parts.join(" "),
  };
}

export interface ProfileEpochCut {
  floor: number;
  scope: { totalRecordsAllEpochs: number; cleanRecords: number; droppedPreClean: number };
  strategies: string[]; profiles: string[];
  grid: ProfileStratCell[];                    // one cell per (strategy × profile) that has ≥1 clean signal
  conservativeAnomalies: ConservativeAnomaly[]; // one per strategy where conservative OR a peer has signals
  excluded: { matchedScope: number; kept: number; excluded: Record<string, number> } | null; // when the whole cut is thin
  note: string;
}

/** S6 — the full profile × clean-epoch × strategy signal-level cut plus the conservative anomaly per
 *  strategy. Read-only, deterministic (seeded bootstrap inside signalTests). `filter` narrows the base
 *  (competitionId / phase / date window); the e5 floor is always applied on top. */
export function buildProfileEpochCut(db: Database, filter: ProfileFilter = {}, floor = CLEAN_EPOCH_FLOOR): ProfileEpochCut {
  const all = betRecords(db, filter);
  const clean = cleanEpochRecords(all, floor);
  const strategies = [...new Set(clean.map((r) => r.strategyId))].sort();
  const profiles = sortProfiles([...new Set(clean.map((r) => r.profileId))]);

  const grid: ProfileStratCell[] = [];
  for (const s of strategies) for (const p of profiles) {
    const cell = profileStratCell(clean, s, p);
    if (cell.nSignals > 0) grid.push(cell);
  }
  const conservativeAnomalies = strategies
    .map((s) => conservativeAnomaly(clean, s))
    .filter((a) => a.conservative || a.peers); // only strategies with SOMETHING to compare

  const excluded = clean.length < 5 ? betRecordsExcluded(db, filter) : null;
  return {
    floor,
    scope: { totalRecordsAllEpochs: all.length, cleanRecords: clean.length, droppedPreClean: all.length - clean.length },
    strategies, profiles, grid, conservativeAnomalies, excluded,
    note: `Единица — СИГНАЛ (R0.1), не запись. Разрез считается на чистой эпохе (entry code-epoch ≥ e${floor}); «восстановленной истории» не существует, малые n — это честные малые n. Порог созревания: предв. ${SIGNAL_N_PRELIM} / устойчиво ${SIGNAL_N_STABLE} РЕШЁННЫХ сигналов. conservativeAnomalies — CLV/beat-close дефицит conservative к своим peers и сигналы, которые его порог входа ПРОПУСТИЛ (структурный разрыв).`,
  };
}
