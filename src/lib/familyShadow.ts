// ============================================================
// EDGE LAB — prematch_value FAMILY SHADOW + kill-switch  [audit Phase 1.1 / 1.2]  (SERVER-ONLY)
//
// prematch_value now stakes REAL money ONLY in the totals family — its proven edge (~+59% ROI / +14.4 CLV).
// A non-totals ENTER (BTTS / 1X2 / handicap / draw) is DEMOTED to a would-be shadow signal (this table) with
// ZERO money movement, so the weak family keeps accruing a SIGNAL-level cohort for a data-driven verdict
// (R0.1). It is NOT killed on pre-signal record-level history — BTTS is only ~n=2 SIGNALS today, the "−30%"
// is record-level noise (owner ratification: shadow-demote, not kill).
//
// The kill-switch (1.2) reads the MATURED signal cohort per (strategy, family):
//   • traded family (totals for pmv, every family for other strategies) → cohort on REAL bets
//   • demoted family (pmv non-totals)                                   → cohort on SHADOW signals
// A matured NEGATIVE verdict (n≥25 decided, R0.1 symmetry) KILLS the family: money never flows to it AND it
// stops being shadowed. Symmetric with the positive side (a matured-positive shadow family becomes a
// promotion candidate — surfaced, not auto-traded).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { resolveFootballMarket } from "./settlement.js";
import { marketFamily, signalCohort, type SignalCohort } from "./signals.js";
import { betRecords, type BetRec } from "./profileAnalytics.js";

export const FAMILY_SHADOW_STRATEGY = "prematch_value";
export const TRADED_FAMILY = "totals";

/** Is this (strategy, family) a shadow-demote (would-be, no money) rather than a traded family? */
export function isDemotedFamily(strategyId: string, family: string): boolean {
  return strategyId === FAMILY_SHADOW_STRATEGY && family !== TRADED_FAMILY;
}

const sideOf = (label: string): string => {
  const l = label.toLowerCase();
  if (/\bover\b/.test(l)) return "over";
  if (/\bunder\b/.test(l)) return "under";
  if (/[—:]\s*no\s*$/.test(l)) return "no";
  if (/[—:]\s*yes\s*$/.test(l)) return "yes";
  if (/\bdraw\b|ничья/.test(l)) return "draw";
  return "other";
};

export interface FamilyShadowInput {
  matchId: string; strategyId: string; label: string; family: string;
  ourProb: number; implied: number; edge: number; wouldBeStake: number; entryCents: number;
  kickoffAt: string | null; codeVersion: string; at: string;
}

/** Freeze a would-be prematch_value entry on a demoted family. Dedup: one row per (match, market, strategy);
 *  a repeat while the edge holds only bumps `hits`. ZERO money movement. */
export function recordFamilyShadowSignal(db: Database, s: FamilyShadowInput): void {
  db.prepare(
    `INSERT INTO family_shadow_signals
       (id, match_id, strategy_id, market_label, family, side, our_prob, implied, edge, would_be_stake, entry_cents, kickoff_at, code_version, hits, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,'pending',?)
     ON CONFLICT(match_id, market_label, strategy_id) DO UPDATE SET hits = hits + 1`,
  ).run(R.uid(), s.matchId, s.strategyId, s.label, s.family, sideOf(s.label), s.ourProb, s.implied, s.edge, s.wouldBeStake, s.entryCents, s.kickoffAt, s.codeVersion, s.at);
}

/** Resolve pending shadow signals against FINISHED, scored matches — the SAME settlement code as real bets.
 *  Fail-closed: an unresolvable label becomes `unresolved` WITH a reason, never a silent skip. */
export function resolveFamilyShadowSignals(db: Database, deps: EngineDeps = {}): { resolved: number; unresolved: number } {
  const now = deps.now?.() ?? new Date().toISOString();
  let resolved = 0, unresolved = 0;
  const pend = db.prepare(`SELECT id, match_id, market_label FROM family_shadow_signals WHERE status='pending'`).all() as { id: string; match_id: string; market_label: string }[];
  for (const s of pend) {
    const m = R.getMatch(db, s.match_id);
    if (!m || m.state !== "finished" || m.score_home == null || m.score_away == null) continue; // not over → stay pending
    let status: string, note: string | null = null;
    let won: boolean | null;
    try { won = resolveFootballMarket(s.market_label, m.score_home, m.score_away, { home: m.home, away: m.away }); }
    catch { won = undefined as unknown as boolean | null; }
    if (won === undefined) { status = "unresolved"; note = "resolveFootballMarket не смог разрешить рынок"; }
    else if (won == null) { status = "void"; note = "void-клауза (advancement/пенальти/неизвестный рынок)"; }
    else status = won ? "won" : "lost";
    db.prepare(`UPDATE family_shadow_signals SET status=?, resolve_note=?, resolved_at=? WHERE id=?`).run(status, note, now, s.id);
    if (status === "unresolved") unresolved++; else resolved++;
  }
  return { resolved, unresolved };
}

// ── verdict + kill-switch ─────────────────────────────────────────────────────
interface ShadowRow { match_id: string; market_label: string; family: string; our_prob: number | null; implied: number | null; entry_cents: number | null; closing_cents: number | null; would_be_stake: number | null; kickoff_at: string | null; created_at: string; code_version: string | null; status: string }

/** Map a resolved shadow row to a would-be BetRec so the STANDARD signal machinery scores it identically to a
 *  real bet: won → stake·(100/entry − 1), lost → −stake, void → 0; implied = entry/100; CLV from close if
 *  captured. Only the fields collapseToSignals/signalCohort read are meaningful; the rest are inert. */
function shadowToBetRec(r: ShadowRow): BetRec {
  const entry = r.entry_cents ?? null;
  const stake = r.would_be_stake ?? 0;
  const outcome: BetRec["outcome"] = r.status === "won" ? "won" : r.status === "lost" ? "lost" : r.status === "void" ? "void" : "open";
  const pnl = outcome === "won" && entry ? Math.round(stake * (100 / entry - 1) * 100) / 100 : outcome === "lost" ? -stake : outcome === "void" ? 0 : null;
  const clv = r.closing_cents != null && entry != null ? Math.round((r.closing_cents - entry) * 10) / 10 : null;
  return {
    id: `fsh:${r.match_id}:${r.market_label}`, matchId: r.match_id, matchLabel: r.match_id, competitionId: "", category: "",
    strategyId: FAMILY_SHADOW_STRATEGY, strategy: FAMILY_SHADOW_STRATEGY, profileId: "medium", market: r.market_label,
    phase: "prematch", minute: null, scoreHome: null, scoreAway: null, edge: null, aiProb: r.our_prob, derivedProb: null,
    impliedProb: entry != null ? entry / 100 : r.implied, marketPrice: null, liveProbAdjusted: null,
    entryCents: entry, closingCents: r.closing_cents, kelly: null, sizeRequested: null, sizeFilled: null, entrySlipCents: null,
    calibration: null, branchWeightSum: null, thinnessUsd: null, winsOnEvent: false, codeVersion: r.code_version,
    status: r.status, settledBy: null, outcome, stake, payout: null, pnl, bookPnl: pnl, clvCents: clv, finalScore: null,
    decisionId: null, createdAt: r.created_at, kickoffAt: r.kickoff_at, exitCodeVersion: null, exits: [],
  };
}

export interface FamilyVerdict { strategyId: string; family: string; source: "real" | "shadow"; cohort: SignalCohort; killed: boolean; promotable: boolean }

/** Per (strategy, family) governance: the matured signal cohort + kill/promote flags. Traded families are
 *  scored on REAL bets; demoted pmv families on SHADOW signals. `killed` = matured negative; `promotable` =
 *  matured positive on a demoted family (a candidate to trade for real, surfaced not auto-enabled). */
export function familyVerdicts(db: Database): FamilyVerdict[] {
  const out: FamilyVerdict[] = [];
  // demoted pmv families — from the shadow table
  const shadowRows = db.prepare(`SELECT match_id, market_label, family, our_prob, implied, entry_cents, closing_cents, would_be_stake, kickoff_at, created_at, code_version, status FROM family_shadow_signals`).all() as ShadowRow[];
  const byFam = new Map<string, ShadowRow[]>();
  for (const r of shadowRows) (byFam.get(r.family) ?? byFam.set(r.family, []).get(r.family)!).push(r);
  for (const [family, rows] of byFam) {
    const cohort = signalCohort(rows.map(shadowToBetRec), { strategyId: FAMILY_SHADOW_STRATEGY, family });
    out.push({ strategyId: FAMILY_SHADOW_STRATEGY, family, source: "shadow", cohort, killed: cohort.matured !== "none" && cohort.verdict === "negative", promotable: cohort.matured !== "none" && cohort.verdict === "positive" });
  }
  // traded families — from real bets, per strategy × family
  const recs = betRecords(db, {});
  const byStratFam = new Map<string, BetRec[]>();
  for (const r of recs) {
    const fam = marketFamily(r.market);
    if (isDemotedFamily(r.strategyId, fam)) continue; // its verdict lives in the shadow table, not here
    const key = `${r.strategyId}|${fam}`;
    (byStratFam.get(key) ?? byStratFam.set(key, []).get(key)!).push(r);
  }
  for (const [key, rows] of byStratFam) {
    const [strategyId, family] = key.split("|");
    const cohort = signalCohort(rows, { strategyId, family });
    out.push({ strategyId, family, source: "real", cohort, killed: cohort.matured !== "none" && cohort.verdict === "negative", promotable: false });
  }
  return out;
}

/** The set of "strategyId|family" that are KILLED (matured-negative). The money path skips these entirely —
 *  no bet, and (for a demoted family) no further shadow record. Computed once per analyzeMatch pass. */
export function killedFamilies(db: Database): Set<string> {
  const killed = new Set<string>();
  for (const v of familyVerdicts(db)) if (v.killed) killed.add(`${v.strategyId}|${v.family}`);
  return killed;
}

export interface FamilyShadowReport {
  strategy: string; tradedFamily: string;
  verdicts: { strategyId: string; family: string; source: string; nSignals: number; nDecided: number; verdict: string; matured: string; killed: boolean; promotable: boolean; note: string }[];
  killed: string[]; promotable: string[];
  note: string;
}

/** GET-facing report: every family's shadow/real signal verdict + the kill/promote list. Read-only. */
export function buildFamilyShadow(db: Database): FamilyShadowReport {
  const vs = familyVerdicts(db);
  const verdicts = vs
    .sort((a, b) => (Number(b.source === "shadow") - Number(a.source === "shadow")) || a.strategyId.localeCompare(b.strategyId) || a.family.localeCompare(b.family))
    .map((v) => ({ strategyId: v.strategyId, family: v.family, source: v.source, nSignals: v.cohort.nSignals, nDecided: v.cohort.nDecided, verdict: v.cohort.verdict, matured: v.cohort.matured, killed: v.killed, promotable: v.promotable, note: v.cohort.note }));
  const killed = vs.filter((v) => v.killed).map((v) => `${v.strategyId}|${v.family}`);
  const promotable = vs.filter((v) => v.promotable).map((v) => `${v.strategyId}|${v.family}`);
  return {
    strategy: FAMILY_SHADOW_STRATEGY, tradedFamily: TRADED_FAMILY, verdicts, killed, promotable,
    note: `prematch_value ставит РЕАЛЬНЫЕ деньги только в «${TRADED_FAMILY}». BTTS/1X2/форы/draw демоутнуты в shadow (would-be, без денег) и зреют до сигнального вердикта. killed — семьи с созревшим ОТРИЦАТЕЛЬНЫМ вердиктом (сняты и с денег, и с shadow). promotable — демоут-семьи с созревшим ПОЛОЖИТЕЛЬНЫМ (кандидаты на возврат в деньги, отдельная ратификация). Единица — СИГНАЛ (R0.1), не запись.`,
  };
}
