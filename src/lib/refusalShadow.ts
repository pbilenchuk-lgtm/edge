// ============================================================
// EDGE LAB — REFUSAL SHADOW  [R5, batch-10 ТЗ]
//
// Batch 10 asked a question no opinion can settle: the strategist refused 22 of 28 football matches outright
// («крупный edge — классический флаг ошибки модели… правильный ответ полный пропуск»), and 68% of all its
// decisions produced no picks. Is that discipline earned from real traps (Ajax 50¢, the Kalmar class), or is
// the anti-phantom screw over-tightened to the point the strategy has stopped trading?
//
// The ТЗ's answer: don't choose — MEASURE. Every deliberate refusal that walked away from a totals market with
// a named edge ≥ threshold is frozen as a would-be signal and resolved like any other. After n≥25 the cohort
// speaks: if the refused signals systematically LOST, the discipline is right and the drought is the price of
// not being wrong; if they systematically WON, the threshold is mis-calibrated and can be moved BY DATA.
//
// The edge is computed deterministically (our stored ai_prob vs the market's own implied), never parsed out of
// the refusal prose — a number the analysis already committed to, not a phrase an LLM happened to write.
// Until the cohort matures, nothing about the screw is touched: that is the whole point of building the
// instrument instead of arguing about it.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { resolveFootballMarket } from "./settlement.js";
import { marketFamily } from "./signals.js";
import { collapseToSignals, signalTests } from "./signals.js";
import type { BetRec } from "./profileAnalytics.js";

/** Minimum |edge| (fraction) a walked-away market must carry to be worth scoring. Below this the refusal is
 *  uninteresting — nobody claims a 2% edge should have been taken. */
export const REFUSAL_EDGE_MIN = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.REFUSAL_SHADOW_EDGE_MIN);
  return Number.isFinite(n) && n > 0 ? n : 0.05;
};
export const REFUSAL_NEED_N = 25; // signals before the cohort may be read at all

export interface RefusalInput {
  matchId: string; strategyId: string; marketLabel: string; family: string;
  ourProb: number; implied: number; edge: number; entryCents: number;
  kickoffAt: string | null; codeVersion: string | null; note: string | null; at: string;
}

/** Freeze ONE walked-away market. Dedup by (match, market, strategy): a refusal repeated across profiles or
 *  ticks is one decision, not many — the same units discipline the signal layer uses (R0.1). */
export function recordRefusalShadow(db: Database, s: RefusalInput): void {
  db.prepare(
    `INSERT INTO refusal_shadow_signals
       (id, match_id, strategy_id, market_label, family, our_prob, implied, edge, entry_cents, kickoff_at, code_version, refusal_note, hits, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'pending',?)
     ON CONFLICT(match_id, market_label, strategy_id) DO UPDATE SET hits = hits + 1`,
  ).run(R.uid(), s.matchId, s.strategyId, s.marketLabel, s.family, s.ourProb, s.implied, s.edge, s.entryCents,
    s.kickoffAt, s.codeVersion, s.note, s.at);
}

/**
 * Scan a match's markets at the moment of a DELIBERATE full refusal and freeze every totals market whose
 * committed edge clears the floor. Called only when the strategist returned ok with zero picks — a failed or
 * gated call is not a judgement and must never enter this cohort.
 */
export function recordRefusalForMatch(
  db: Database, matchId: string, strategyId: string, note: string | null, now: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const m = R.getMatch(db, matchId);
  if (!m) return 0;
  const floor = REFUSAL_EDGE_MIN(env);
  let n = 0;
  for (const mk of R.latestMarkets(db, matchId)) {
    if (mk.ai_prob == null || !Number.isFinite(mk.price) || mk.price <= 0) continue;
    const family = marketFamily(mk.label);
    if (family !== "totals") continue;                    // the ТЗ scopes the question to totals
    const implied = mk.price / 100;
    const edge = mk.ai_prob - implied;
    if (edge < floor) continue;                           // only the edges someone could argue we walked away from
    recordRefusalShadow(db, {
      matchId, strategyId, marketLabel: mk.label, family,
      ourProb: mk.ai_prob, implied, edge: Math.round(edge * 10000) / 10000, entryCents: mk.price,
      kickoffAt: m.kickoff_at ?? null, codeVersion: null, note, at: now,
    });
    n++;
  }
  return n;
}

/** Resolve pending refusals against finished matches — the SAME settlement code the money path uses, so a
 *  would-be win is a win by exactly the rule a real bet would have been paid on. Fail-closed and counted. */
export function resolveRefusalShadowSignals(db: Database, deps: EngineDeps = {}): { resolved: number; unresolved: number } {
  const now = deps.now?.() ?? new Date().toISOString();
  let resolved = 0, unresolved = 0;
  const pend = db.prepare(`SELECT id, match_id, market_label FROM refusal_shadow_signals WHERE status='pending'`).all() as { id: string; match_id: string; market_label: string }[];
  for (const s of pend) {
    const m = R.getMatch(db, s.match_id);
    if (!m || m.state !== "finished" || m.score_home == null || m.score_away == null) continue; // not over → stay pending
    let status: string, note: string | null = null;
    let won: boolean | null | undefined;
    try { won = resolveFootballMarket(s.market_label, m.score_home, m.score_away, { home: m.home, away: m.away }); }
    catch { won = undefined; }
    if (won === undefined) { status = "unresolved"; note = "resolveFootballMarket не смог разрешить рынок"; }
    else if (won == null) { status = "void"; note = "void-клауза (advancement/пенальти/неизвестный рынок)"; }
    else status = won ? "won" : "lost";
    db.prepare(`UPDATE refusal_shadow_signals SET status=?, resolve_note=?, resolved_at=? WHERE id=?`).run(status, note, now, s.id);
    if (status === "unresolved") unresolved++; else resolved++;
  }
  return { resolved, unresolved };
}

export interface RefusalShadowReport {
  edgeFloor: number; needN: number;
  counts: { total: number; pending: number; won: number; lost: number; void: number; unresolved: number };
  scored: number; winPct: number | null; meanEdgePct: number | null; meanImpliedPct: number | null;
  wouldBePnlUsd: number;                   // flat $100 stakes — a unit-scale read, not a claim about sizing
  matured: boolean;
  verdict: "insufficient" | "discipline_right" | "screw_too_tight" | "mixed";
  note: string;
}

/** The cohort verdict. Deliberately conservative: nothing is concluded below n≥25, and «screw too tight»
 *  requires the refused set to have beaten its OWN implied — merely winning more than half proves nothing
 *  when the walked-away markets were odds-on to begin with. */
export function buildRefusalShadow(db: Database, env: Record<string, string | undefined> = process.env): RefusalShadowReport {
  const rows = db.prepare(`SELECT market_label, our_prob, implied, edge, entry_cents, status, match_id, created_at, kickoff_at FROM refusal_shadow_signals`).all() as any[];
  const c = { total: rows.length, pending: 0, won: 0, lost: 0, void: 0, unresolved: 0 };
  for (const r of rows) (c as any)[r.status]++;
  const scored = rows.filter((r) => r.status === "won" || r.status === "lost");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const winPct = scored.length ? Math.round((1000 * scored.filter((r) => r.status === "won").length) / scored.length) / 10 : null;
  const meanEdge = mean(scored.map((r) => r.edge));
  const meanImplied = mean(scored.map((r) => r.implied));
  // Flat $100 per signal: a won market pays 100/entry, a lost one pays 0.
  const pnl = scored.reduce((s, r) => s + (r.status === "won" ? 100 * (100 / r.entry_cents) - 100 : -100), 0);

  // Statistical read on SIGNALS, reusing the same machinery as the money cohorts so the two are comparable.
  const recs: BetRec[] = scored.map((r, i) => ({
    id: `rs${i}`, matchId: r.match_id, matchLabel: "", competitionId: "", category: "", strategyId: "refusal", strategy: "refusal",
    profileId: "medium", market: r.market_label, phase: "prematch", minute: null, scoreHome: null, scoreAway: null,
    edge: r.edge, aiProb: r.our_prob, derivedProb: null, impliedProb: r.implied, marketPrice: r.entry_cents,
    liveProbAdjusted: null, entryCents: r.entry_cents, closingCents: null, kelly: null, sizeRequested: null,
    sizeFilled: 100, entrySlipCents: null, calibration: null, branchWeightSum: null, thinnessUsd: null,
    winsOnEvent: false, codeVersion: null, status: r.status === "won" ? "settled_won" : "settled_lost",
    settledBy: "settle", outcome: r.status, stake: 100, payout: r.status === "won" ? 100 * (100 / r.entry_cents) : 0,
    pnl: r.status === "won" ? 100 * (100 / r.entry_cents) - 100 : -100,
    bookPnl: r.status === "won" ? 100 * (100 / r.entry_cents) - 100 : -100,
    clvCents: null, finalScore: null, decisionId: null, createdAt: r.created_at, kickoffAt: r.kickoff_at,
    exitCodeVersion: null, exits: [],
  } as unknown as BetRec));
  const t = signalTests(collapseToSignals(recs));
  const matured = t.nDecided >= REFUSAL_NEED_N;
  // Beating their own implied is the bar — a set of 80¢ favourites winning 75% has beaten nothing.
  const beatsMarket = t.winVsImplied.beatsMarket;
  const lostMoney = t.pnl.totalUsd < 0;
  const verdict: RefusalShadowReport["verdict"] = !matured ? "insufficient"
    : beatsMarket && t.pnl.totalUsd > 0 ? "screw_too_tight"
    : lostMoney ? "discipline_right" : "mixed";
  return {
    edgeFloor: REFUSAL_EDGE_MIN(env), needN: REFUSAL_NEED_N, counts: c, scored: scored.length,
    winPct, meanEdgePct: meanEdge == null ? null : Math.round(meanEdge * 1000) / 10,
    meanImpliedPct: meanImplied == null ? null : Math.round(meanImplied * 1000) / 10,
    wouldBePnlUsd: Math.round(pnl * 100) / 100, matured,
    verdict,
    note: !matured
      ? `копим: ${t.nDecided}/${REFUSAL_NEED_N} решённых отказных сигналов (порог edge ≥${Math.round(REFUSAL_EDGE_MIN(env) * 100)}%). До созревания жёсткость НЕ трогаем — она выведена из реальных ловушек, а не из вкуса.`
      : verdict === "screw_too_tight"
        ? `ГАЙКА ПЕРЕКРУЧЕНА: отказные сигналы бьют собственный implied (win ${t.winVsImplied.winPct}% vs рынок ${t.winVsImplied.meanImpliedPct}%, Poisson-бином p=${t.winVsImplied.binomP}) и заработали бы $${Math.round(pnl)} на плоских ставках $100 при n=${t.nDecided}. Анти-фантомный порог калибруется ПО ДАННЫМ.`
        : verdict === "discipline_right"
          ? `ДИСЦИПЛИНА ПРАВА: отказные сигналы потеряли бы $${Math.round(pnl)} на плоских ставках $100 при n=${t.nDecided} (win ${t.winVsImplied.winPct}% vs implied ${t.winVsImplied.meanImpliedPct}%). Засуха входов — цена того, чтобы не быть неправым.`
          : `СМЕШАННО при n=${t.nDecided}: отказники не бьют свой implied убедительно и не теряют явно (win ${t.winVsImplied.winPct}% vs ${t.winVsImplied.meanImpliedPct}%, P&L $${Math.round(pnl)}). Порог не трогаем, копим дальше.`,
  };
}
