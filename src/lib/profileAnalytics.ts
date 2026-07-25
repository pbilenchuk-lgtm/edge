// ============================================================
// EDGE LAB — risk-profile analytics (MEASUREMENT ONLY, zero LLM, zero money-path).
// Answers from the bet log, without parameter search: which of the 4 profiles is
// best and why; where edge actually pays (→ min_edge); how calibrated the model is
// (→ safe Kelly, read by a human, never auto-chosen); how stops/exits behave in the
// tails. Everything is computed on the fly from bets + trade log; nothing is stored.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { parseEntryMeta, type BetEntryMeta } from "./betMeta.js";
import { winsOnEventOccurrence } from "./thresholds.js";
import { canonicalProfileId } from "./riskProfiles.js";
import { isResolutionSettle } from "./settlement.js";
import { epochNum, crossEpoch } from "./codeEpoch.js";

export interface ProfileFilter {
  fromMs?: number; toMs?: number;      // created_at window
  competitionId?: string;              // category
  strategyId?: string;
  phase?: "prematch" | "live";
  codeVersion?: string;                // segregate pre/post-fix eras
  includeAllEpochs?: boolean;          // [Phase 5.5 / M10] explicit override to keep pre-clean-epoch rows
}

export type ExitTrigger =
  | "take_price" | "thesis_stop" | "counter_scenario" | "time_stop"
  | "hard_stop" | "time_decay_floor" | "settle" | "edge_closed" | "discretionary";

export interface ExitRec {
  trigger: ExitTrigger; minute: number | null; priceCents: number | null; pnl: number; partial: boolean;
  modelFill: boolean; // F3: exit executed at a MODELLED price (no live bid) — a real-money path would not have filled
  text: string;
}

export interface BetRec {
  id: string; matchId: string; matchLabel: string; competitionId: string; category: string;
  strategyId: string; strategy: string; profileId: string; market: string;
  phase: "prematch" | "live"; minute: number | null; scoreHome: number | null; scoreAway: number | null;
  edge: number | null; aiProb: number | null; derivedProb: number | null; impliedProb: number | null;
  marketPrice: number | null; liveProbAdjusted: number | null;
  entryCents: number | null; closingCents: number | null; kelly: number | null;
  sizeRequested: number | null; sizeFilled: number | null; entrySlipCents: number | null;
  calibration: number | null; branchWeightSum: number | null; thinnessUsd: number | null;
  winsOnEvent: boolean; codeVersion: string | null;
  status: string; settledBy: string | null; outcome: "won" | "lost" | "void" | "open";
  stake: number; payout: number | null; pnl: number | null; clvCents: number | null; finalScore: string | null;
  // bookPnl [Phase-0 H2]: the record's P&L ONLY when it was realized on a real book fill; null when the exit
  // rode a stale/modelled price (no live bid would have paid) — so the signal P&L verdict/bootstrap/
  // concentration never lean on a price that couldn't have transacted. Distinct from `pnl` (gross, incl. those).
  bookPnl: number | null;
  decisionId: string | null; // S4: strategist decision id (per-bet-unique in this schema — NOT a signal group)
  createdAt: string | null;   // S4-fix: fallback episode key
  kickoffAt: string | null;   // [Phase-0 M7] the match kickoff — the authoritative episode key (UTC-stable per fixture)
  exitCodeVersion: string | null; // [Phase-0 X2] exit-time code epoch — a cross-epoch cycle is quarantined from clean cuts
  exits: ExitRec[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const minuteFrom = (label: string | null | undefined): number | null => { const m = String(label ?? "").match(/(\d{1,3})/); return m ? Number(m[1]) : null; };

/** Classify an exit trade-log entry into an honest trigger category. */
export function classifyExitTrigger(text: string, settledBy: string | null | undefined): ExitTrigger {
  const t = text.toLowerCase();
  if (/time_stop|тайм-стоп/.test(t)) return "time_stop";
  if (/time_decay|тайм-флор/.test(t)) return "time_decay_floor";
  if (/counter_scenario|контр-ветк|контр-сценар/.test(t)) return "counter_scenario";
  if (/thesis_stop|тезис|слома/.test(t)) return "thesis_stop";
  if (/take_price|тейк|на пике|цена (дош|дости|пришла)|фикс/.test(t)) return "take_price";
  if (/edge (исчерп|закры|gone|closed)|эдж/.test(t)) return "edge_closed";
  if (/хард-стоп|hard[_-]?stop|\bстоп\b|\bstop\b/.test(t)) return "hard_stop";
  if (isResolutionSettle(settledBy)) return "settle";
  return "discretionary";
}

/** All bets as normalized analytic records (filtered). Exits parsed from the trade log. */
export function betRecords(db: Database, filter: ProfileFilter = {}): BetRec[] {
  const comps = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  const strats = new Map(R.listStrategies(db).map((s) => [s.id, s.name]));
  const matchCache = new Map<string, ReturnType<typeof R.getMatch>>();
  const exitCache = new Map<string, ReturnType<typeof R.tradeLogForMatch>>();
  const getMatch = (id: string) => { if (!matchCache.has(id)) matchCache.set(id, R.getMatch(db, id)); return matchCache.get(id)!; };
  const exitsFor = (id: string) => { if (!exitCache.has(id)) exitCache.set(id, R.tradeLogForMatch(db, id).filter((e) => e.type === "exit")); return exitCache.get(id)!; };
  const out: BetRec[] = [];
  for (const b of R.allBets(db)) {
    if (b.status === "proposed" || b.status === "not_filled") continue; // only real predictions
    if (b.settle_suspect) continue; // P0.1: a possibly-leg-contaminated settle never enters a verdict cut
    if (b.football_epoch === "epoch_unknown") continue; // P0.5: pre-fix football era excluded from cuts
    const m = getMatch(b.match_id);
    if (!m) continue;
    const comp = comps.get(m.competition_id);
    if (filter.competitionId && m.competition_id !== filter.competitionId) continue;
    if (filter.strategyId && b.strategy_id !== filter.strategyId) continue;
    if (filter.fromMs && (Date.parse(b.created_at) || 0) < filter.fromMs) continue;
    if (filter.toMs && (Date.parse(b.created_at) || 0) > filter.toMs) continue;
    if (filter.codeVersion && (b.code_version ?? "") !== filter.codeVersion) continue;
    const em: BetEntryMeta | null = parseEntryMeta(b.entry_meta);
    // token-fix-m1: a POISONED bet (pre-fix, held the OPPONENT's token) is meaningless end-to-end — its
    // entry edge/prob AND its exit P&L are about the wrong outcome — so it is dropped from EVERY slice.
    if (em?.tokenFlipPoisoned === true) continue;
    // origin phase is now a stored FIELD (bets.origin, resolved once at entry + backfilled). Read the
    // column; fall back to entry_meta.phase only for a row the backfill hasn't reached yet (defensive).
    const phase: "prematch" | "live" = (b.origin === "prematch" || b.origin === "live") ? b.origin : (em?.phase ?? "prematch");
    if (filter.phase && phase !== filter.phase) continue;
    const settled = R.isSettled(b.status);
    // A settled bet with result null is a PUSH/void (a market void OR a breakeven cash-out) — it is
    // neither a win nor a loss, so it must stay OUT of the won/lost win-rate bins (single source of
    // truth = result; settled_void breakeven realizes carry result null just like market voids).
    // A STALE-priced exit (exitStalePrice: a §4.5 defensive cut executed at the modelled price, no live
    // bid) is likewise excluded — its P&L isn't a clean book fill, so it can't feed calibration/win-rate.
    const staleExit = settled && em?.exitStalePrice === true;
    const outcome: BetRec["outcome"] = !settled ? "open" : staleExit ? "void" : b.result === "won" ? "won" : b.result === "lost" ? "lost" : "void";
    const stake = b.stake ?? 0;
    const pnl = settled && b.payout != null ? Math.round((b.payout - stake) * 100) / 100 : null;
    const entryCents = num(b.entry_price), closingCents = num(b.closing_price);
    // CLV: how the closing (T-0) line moved vs our entry, in ¢, in the DIRECTION of the
    // bet. We always hold the token we bought, so entry/closing are already same-side →
    // clv = close − entry works for a Yes market and a No market alike.
    const clvCents = entryCents != null && closingCents != null ? Math.round((closingCents - entryCents) * 10) / 10 : null;
    // Exits for this position: same strategy + market label, matched loosely.
    const exits: ExitRec[] = exitsFor(b.match_id)
      .filter((e) => e.strategy_id === b.strategy_id && e.text.includes(`«${b.market_label}»`))
      .map((e) => {
        const pc = Number((e.text.match(/@ (\d+(?:\.\d+)?)¢/) ?? [])[1]);
        const pnlM = e.text.match(/P&L ([+-]?)\$?(-?\d+(?:\.\d+)?)/);
        const pnlV = pnlM ? (pnlM[1] === "-" ? -1 : 1) * Number(pnlM[2]) : 0;
        return { trigger: classifyExitTrigger(e.text, b.settled_by), minute: minuteFrom(e.minute), priceCents: Number.isFinite(pc) ? pc : null, pnl: pnlV, partial: /частичн/.test(e.text), modelFill: /\[model_fill\]/.test(e.text), text: e.text };
      });
    // [H2] book P&L = the realized pnl UNLESS the exit rode a stale/modelled price (no live bid). Such a leg's
    // money is barred from the win-rate already (staleExit→void); this bars it from the P&L verdict too.
    const modelFilled = exits.some((e) => e.modelFill);
    const bookPnl = pnl != null && !staleExit && !modelFilled ? pnl : null;
    out.push({
      id: b.id, matchId: b.match_id, matchLabel: `${m.home} — ${m.away}`, competitionId: m.competition_id, category: comp?.name ?? m.competition_id,
      // canonicalProfileId folds legacy `rp-lite*` → `max` so pre-rename history glues to the renamed
      // profile WITHOUT a DB rewrite (owner decision 23.07.2026 b).
      strategyId: b.strategy_id, strategy: strats.get(b.strategy_id) ?? b.strategy_id, profileId: canonicalProfileId(b.risk_profile_id ?? "medium"), market: b.market_label,
      phase, minute: em?.minute ?? null, scoreHome: em?.scoreHome ?? null, scoreAway: em?.scoreAway ?? null,
      edge: em?.edge ?? (b.ai_prob != null && entryCents != null ? Math.round((b.ai_prob - entryCents / 100) * 1000) / 1000 : null),
      aiProb: em?.aiProb ?? num(b.ai_prob), derivedProb: em?.derivedProb ?? null, impliedProb: em?.impliedProb ?? (entryCents != null ? Math.round(entryCents) / 100 : null),
      marketPrice: em?.marketPrice ?? num(b.proposed_price), liveProbAdjusted: em?.liveProbAdjusted ?? null,
      entryCents, closingCents, kelly: em?.kellyFraction ?? null,
      sizeRequested: em?.sizeRequested ?? null, sizeFilled: em?.sizeFilled ?? (settled || b.status === "open" ? stake : null), entrySlipCents: em?.entrySlipCents ?? null,
      calibration: em?.calibration ?? null, branchWeightSum: em?.branchWeightSum ?? null, thinnessUsd: em?.marketThinnessUsd ?? null,
      winsOnEvent: em?.winsOnEvent ?? winsOnEventOccurrence(b.market_label), codeVersion: b.code_version ?? null,
      status: b.status, settledBy: b.settled_by ?? null, outcome,
      stake, payout: num(b.payout), pnl, bookPnl, clvCents, finalScore: m.final_score ?? null,
      decisionId: b.decision_id ?? null, createdAt: b.created_at ?? null, kickoffAt: m.kickoff_at ?? null, exitCodeVersion: b.exit_code_version ?? null, exits,
    });
  }
  return out;
}

// ── BLOCK A — 4-profile comparison ─────────────────────────────────────────
export interface ProfileStats {
  profileId: string; bets: number; volume: number; pnl: number; roi: number;
  avgClvCents: number | null; pctBeatClose: number | null;
  maxDrawdown: number; longestLossStreak: number; sharpe: number | null;
  triggerMix: Record<string, number>; // trigger → % of closed positions
  earlyExits: number; modelFillPct: number | null; // F3: of positions closed EARLY, share whose fill rode a modelled (non-book) price
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]) => { if (xs.length < 2) return 0; const mu = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - mu) ** 2))); };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** F3 — «доля model-fill»: of positions closed by at least one EARLY exit (settle-only positions never
 *  transacted a book, so they're outside this denominator), what fraction had a modelled (non-book) exit
 *  fill. A high share means the realized P&L of that cut leans on prices no live bid would have paid. */
export function modelFillShare(recs: BetRec[]): { earlyExits: number; modelFillPct: number | null } {
  const withExit = recs.filter((r) => r.exits.length > 0);
  if (!withExit.length) return { earlyExits: 0, modelFillPct: null };
  const modelled = withExit.filter((r) => r.exits.some((e) => e.modelFill)).length;
  return { earlyExits: withExit.length, modelFillPct: r2((modelled / withExit.length) * 100) };
}

export function profileComparison(recs: BetRec[]): ProfileStats[] {
  const byProf = new Map<string, BetRec[]>();
  for (const r of recs) (byProf.get(r.profileId) ?? byProf.set(r.profileId, []).get(r.profileId)!).push(r);
  const order = ["aggressive", "medium", "conservative"];
  const profs = [...byProf.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return profs.map((p) => {
    const rs = byProf.get(p)!;
    const settled = rs.filter((r) => r.pnl != null);
    const pnls = settled.map((r) => r.pnl!);
    const volume = settled.reduce((s, r) => s + r.stake, 0);
    const pnl = pnls.reduce((a, b) => a + b, 0);
    const clvs = rs.map((r) => r.clvCents).filter((x): x is number => x != null);
    // Equity curve (chronological) → max drawdown; loss streak. [H2/H1] Order by createdAt — `id` is a v4
    // UUID with NO time component, so sorting by it built the curve over a RANDOM permutation, making every
    // maxDrawdown/longestLossStreak meaningless. Fall back to id only when two bets share a timestamp.
    const chron = settled.slice().sort((a, b) => ((Date.parse(a.createdAt ?? "") || 0) - (Date.parse(b.createdAt ?? "") || 0)) || a.id.localeCompare(b.id));
    let eq = 0, peak = 0, maxDd = 0, streak = 0, longest = 0;
    for (const r of chron) {
      eq += r.pnl!; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq);
      if (r.pnl! < 0) { streak++; longest = Math.max(longest, streak); } else streak = 0;
    }
    const trigCount: Record<string, number> = {};
    const closed = rs.filter((r) => r.outcome !== "open");
    for (const r of closed) { const trg = (r.exits[r.exits.length - 1]?.trigger) ?? (isResolutionSettle(r.settledBy) ? "settle" : "discretionary"); trigCount[trg] = (trigCount[trg] ?? 0) + 1; }
    const triggerMix: Record<string, number> = {};
    for (const [k, v] of Object.entries(trigCount)) triggerMix[k] = closed.length ? r2((v / closed.length) * 100) : 0;
    return {
      profileId: p, bets: rs.length, volume: r2(volume), pnl: r2(pnl), roi: volume > 0 ? r2((pnl / volume) * 100) : 0,
      avgClvCents: clvs.length ? r2(mean(clvs)) : null, pctBeatClose: clvs.length ? r2((clvs.filter((c) => c > 0).length / clvs.length) * 100) : null,
      maxDrawdown: r2(maxDd), longestLossStreak: longest, sharpe: pnls.length >= 2 && std(pnls) > 0 ? r2(mean(pnls) / std(pnls)) : null,
      triggerMix, ...modelFillShare(rs),
    };
  });
}

// ── BLOCK B — edge zones (→ min_edge) ──────────────────────────────────────
export const EDGE_ZONES: { key: string; lo: number; hi: number }[] = [
  { key: "2–3%", lo: 0.02, hi: 0.03 }, { key: "3–5%", lo: 0.03, hi: 0.05 },
  { key: "5–7%", lo: 0.05, hi: 0.07 }, { key: "7–10%", lo: 0.07, hi: 0.10 }, { key: "10%+", lo: 0.10, hi: Infinity },
];
export interface EdgeZoneStat { zone: string; n: number; roi: number | null; avgClvCents: number | null; hitRate: number | null; avgImplied: number | null; earlyExits: number; modelFillPct: number | null; }
function zoneStats(recs: BetRec[]): EdgeZoneStat[] {
  return EDGE_ZONES.map((z) => {
    const rs = recs.filter((r) => r.edge != null && r.edge >= z.lo && r.edge < z.hi);
    const settled = rs.filter((r) => r.pnl != null);
    const byResult = rs.filter((r) => r.outcome === "won" || r.outcome === "lost");
    const vol = settled.reduce((s, r) => s + r.stake, 0);
    const pnl = settled.reduce((s, r) => s + r.pnl!, 0);
    const clvs = rs.map((r) => r.clvCents).filter((x): x is number => x != null);
    const implieds = byResult.map((r) => r.impliedProb).filter((x): x is number => x != null);
    return {
      zone: z.key, n: rs.length, roi: vol > 0 ? r2((pnl / vol) * 100) : null,
      avgClvCents: clvs.length ? r2(mean(clvs)) : null,
      hitRate: byResult.length ? r2((byResult.filter((r) => r.outcome === "won").length / byResult.length) * 100) : null,
      avgImplied: implieds.length ? r2(mean(implieds) * 100) : null,
      ...modelFillShare(rs),
    };
  });
}
export interface EdgeZonesBlock { all: EdgeZoneStat[]; prematch: EdgeZoneStat[]; live: EdgeZoneStat[]; thin: EdgeZoneStat[]; liquid: EdgeZoneStat[]; thinThresholdUsd: number; }
export function edgeZones(recs: BetRec[], thinThresholdUsd = 5000): EdgeZonesBlock {
  return {
    all: zoneStats(recs),
    prematch: zoneStats(recs.filter((r) => r.phase === "prematch")),
    live: zoneStats(recs.filter((r) => r.phase === "live")),
    thin: zoneStats(recs.filter((r) => r.thinnessUsd != null && r.thinnessUsd < thinThresholdUsd)),
    liquid: zoneStats(recs.filter((r) => r.thinnessUsd != null && r.thinnessUsd >= thinThresholdUsd)),
    thinThresholdUsd,
  };
}

// ── BLOCK C — calibration (→ Kelly, read by a human) ───────────────────────
export interface CalibrationBin { lo: number; hi: number; predicted: number | null; actual: number | null; n: number; }
export interface CalibrationBlock {
  bins: CalibrationBin[]; brier: number | null; n: number;
  bySlice: Record<string, { brier: number | null; n: number }>; // category / fav-dog / phase / melting
}
/** Bins of PREDICTED prob (ai_prob, else derived) vs ACTUAL resolution frequency for
 *  result-settled bets (won ⇒ the token we hold resolved YES). Brier = mean (p − o)². */
export function calibration(recs: BetRec[], binCount = 10): CalibrationBlock {
  const graded = recs.filter((r) => (r.outcome === "won" || r.outcome === "lost") && (r.aiProb != null || r.derivedProb != null));
  const pairs = graded.map((r) => ({ p: (r.aiProb ?? r.derivedProb) as number, o: r.outcome === "won" ? 1 : 0, r }));
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = i / binCount, hi = (i + 1) / binCount;
    const inb = pairs.filter((x) => x.p >= lo && (i === binCount - 1 ? x.p <= hi : x.p < hi));
    bins.push({ lo, hi, predicted: inb.length ? r2(mean(inb.map((x) => x.p)) * 100) / 100 : null, actual: inb.length ? r2(mean(inb.map((x) => x.o)) * 100) / 100 : null, n: inb.length });
  }
  const brierOf = (xs: { p: number; o: number }[]) => (xs.length ? Math.round(mean(xs.map((x) => (x.p - x.o) ** 2)) * 1000) / 1000 : null);
  const slice = (pred: (r: BetRec) => boolean) => { const xs = pairs.filter((x) => pred(x.r)); return { brier: brierOf(xs), n: xs.length }; };
  const bySlice: CalibrationBlock["bySlice"] = {
    prematch: slice((r) => r.phase === "prematch"), live: slice((r) => r.phase === "live"),
    melting: slice((r) => r.winsOnEvent), directional: slice((r) => !r.winsOnEvent),
  };
  return { bins, brier: brierOf(pairs), n: pairs.length, bySlice };
}

// ── BLOCK D — tails & stops ────────────────────────────────────────────────
export interface TailsBlock {
  worst: { matchLabel: string; market: string; profileId: string; pnl: number; trigger: string; finalScore: string | null }[];
  hardStopVsFinal: { n: number; savedByStop: number; cutInError: number; avgFinalMinusStopCents: number | null };
  drawdownByProfile: Record<string, number>;
}
export function tails(recs: BetRec[], finalByMatchLabel?: Map<string, number>): TailsBlock {
  const closed = recs.filter((r) => r.pnl != null);
  const worst = closed.slice().sort((a, b) => a.pnl! - b.pnl!).slice(0, 10).map((r) => ({
    matchLabel: r.matchLabel, market: r.market, profileId: r.profileId, pnl: r.pnl!,
    trigger: r.exits[r.exits.length - 1]?.trigger ?? (isResolutionSettle(r.settledBy) ? "settle" : "discretionary"), finalScore: r.finalScore,
  }));
  // hard-stop exits: was the stop price better or worse than where the market ended?
  const hs = recs.flatMap((r) => r.exits.filter((e) => e.trigger === "hard_stop" && e.priceCents != null).map((e) => ({ r, e })));
  const deltas = hs.map(({ r, e }) => (r.closingCents != null && e.priceCents != null ? r.closingCents - e.priceCents : null)).filter((x): x is number => x != null);
  const drawdownByProfile: Record<string, number> = {};
  for (const p of profileComparison(recs)) drawdownByProfile[p.profileId] = p.maxDrawdown;
  return {
    worst,
    hardStopVsFinal: {
      n: hs.length,
      savedByStop: deltas.filter((d) => d < 0).length,   // market ended BELOW the stop → stop saved money
      cutInError: deltas.filter((d) => d > 0).length,    // market ended ABOVE the stop → cut too early
      avgFinalMinusStopCents: deltas.length ? r2(mean(deltas)) : null,
    },
    drawdownByProfile,
  };
}

export interface ProfileAnalytics {
  filter: ProfileFilter; totalBets: number; codeVersions: string[];
  comparison: ProfileStats[]; edge: EdgeZonesBlock; calibration: CalibrationBlock; tails: TailsBlock;
  excluded: { matchedScope: number; kept: number; excluded: Record<string, number> } | null; // S3a: why an empty/thin slice is empty
}
/**
 * S3a: WHY a filter is empty. betRecords silently drops several bet classes (proposed/not_filled,
 * settle_suspect, epoch_unknown football, token-flip-poisoned) — so a strategyId with real bets that are
 * ALL pre-clean-epoch (overreaction: every bet epoch_unknown) returns 0 with no explanation, reading like a
 * broken filter. This counts the drops for the SAME strategy/comp scope so the report can say "0 в срезе —
 * но N ставок исключено: все epoch_unknown" instead of a bare empty.
 */
export function betRecordsExcluded(db: Database, filter: ProfileFilter = {}, cleanFloor?: number): { matchedScope: number; kept: number; excluded: Record<string, number> } {
  const ex: Record<string, number> = { proposed_or_not_filled: 0, settle_suspect: 0, epoch_unknown: 0, token_flip_poisoned: 0 };
  // [Phase 5.5 / M19] When a clean-epoch floor is in force, the excluded breakdown must ALSO account for the
  // rows the floor removes (pre-e5 entry, cross-epoch settle) — otherwise an empty clean slice reads as a
  // broken filter when it is really "all N rows are pre-clean-epoch". Honest scope = every drop is named.
  if (cleanFloor != null) { ex.pre_clean_epoch = 0; ex.cross_epoch = 0; }
  let matched = 0, kept = 0;
  for (const b of R.allBets(db)) {
    if (filter.strategyId && b.strategy_id !== filter.strategyId) continue;
    // competition scope needs the match; only resolve when a comp filter is set (keeps this cheap otherwise)
    if (filter.competitionId) { const m = R.getMatch(db, b.match_id); if (!m || m.competition_id !== filter.competitionId) continue; }
    matched++;
    if (b.status === "proposed" || b.status === "not_filled") { ex.proposed_or_not_filled++; continue; }
    if (b.settle_suspect) { ex.settle_suspect++; continue; }
    if (b.football_epoch === "epoch_unknown") { ex.epoch_unknown++; continue; }
    try { if (parseEntryMeta(b.entry_meta)?.tokenFlipPoisoned === true) { ex.token_flip_poisoned++; continue; } } catch { /* keep */ }
    if (cleanFloor != null) {
      if (epochNum(b.code_version) < cleanFloor) { ex.pre_clean_epoch++; continue; }
      if (crossEpoch({ code_version: b.code_version, exit_code_version: b.exit_code_version })) { ex.cross_epoch++; continue; }
    }
    kept++;
  }
  return { matchedScope: matched, kept, excluded: ex };
}

export function profileAnalytics(db: Database, filter: ProfileFilter = {}): ProfileAnalytics {
  const recs = betRecords(db, filter);
  // Only compute the (slightly heavier) exclusion diagnostic when the slice is empty/thin — that's the only
  // time the «почему пусто?» question is asked. Turns a silent 0 into a self-validating breakdown.
  const excluded = recs.length < 5 ? betRecordsExcluded(db, filter) : null;
  return {
    filter, totalBets: recs.length,
    codeVersions: [...new Set(recs.map((r) => r.codeVersion).filter((x): x is string => !!x))].sort(),
    comparison: profileComparison(recs), edge: edgeZones(recs), calibration: calibration(recs), tails: tails(recs),
    excluded,
  };
}
