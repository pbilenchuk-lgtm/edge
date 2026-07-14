// ============================================================
// EDGE LAB — TENNIS PMV: the consistency-scan strategy (paper, pre-match, NO LLM in v1).
//
// Deterministic end-to-end (the deliberate end point of the football PMV lesson — market+code were
// the better pre-match judges; the LLM only added phantom value): anchor on the liquid MONEYLINE,
// solve δ (tennisMarkov), price every listed prop theoretically, and trade only the INTERNAL
// inconsistency of a thin inattentive prop vs the moneyline. Our own strength estimate is nowhere in
// the loop, so the France-Morocco phantom-value class is excluded by construction.
//
// Anti-Draw safety (the two-Draw lesson, verbatim): a deviation ≥18% is almost always "we
// misread the CONTRACT" (retire resolution, other line semantics), not free money — so it is NOT a
// bet but a `provenance_review` FLAG that blocks the prop until the clause is hand-checked.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { loadShadowConfig, shadowOnEntries, shadowOnExit } from "./shadow.js";
import { tennisFinalResult } from "./tennisTrading.js";
import { effectiveCodeVersion } from "./codeEpoch.js";
import { serializeEntryMeta, parseEntryMeta, type BetEntryMeta } from "./betMeta.js";
import { sizePrematch } from "./strategist.js";
import { getProfileConfig, RISK_PROFILE_DEFS } from "./riskConfig.js";
import { tennisMoneyline, propFamily, detectTennisEvents, tennisTourOf, type PropFamily } from "./tennisScout.js";
import { tennisTheo, baseHoldFor, matchDistribution, BASE_HOLD, type TennisTheo } from "./tennisMarkov.js";

export const STRAT_PMV_DESC = `# ТЕННИС — PMV (консистентность пропов, v1, БЕЗ LLM)

Детерминированная стратегия: НЕ оцениваем силу игроков. Берём ликвидный МАНИЛАЙН как якорь
(рынок сам сказал P(победы)), марковской цепью считаем теоретические цены всех пропов, торгуем
ВНУТРЕННЮЮ несогласованность тонких невнимательных пропов с манилайном. Рынок против рынка.

- Вход: deviation = theo − mid ≥ 7¢ → покупаем недооценённую сторону. Полоса 8-92¢, книга ≥$500.
- Анти-Draw предохранитель: deviation ≥ 18¢ → НЕ ставка, а флаг provenance_review (почти наверняка
  неверно понят контракт: резолюция при ретайре / другая семантика линии) — блок до ручного разбора.
- Корреляция: ≤2 пропа на матч, разных семей (все пропы матча коррелированы через исход).
- Выход: держим до сеттла (тонкая книга; ранний выход съедается спредом). Void при ретайре по клаузам.
- LLM в v1 ОТСУТСТВУЕТ осознанно (конец футбольного опыта: рынок+код — лучшие судьи предматча).
  Фильтр добавится ТОЛЬКО если paper покажет системный класс ложных входов — data-gated.`;

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export const PMV_STRATEGY = "tennis_pmv";
// Epoch tag stamped on bets for Brier segmentation. "interim-m1" = the recalibrated model (set-
// dependence momentum + base_hold under review); the first (broken, i.i.d., ITF-polluted) batch was
// plain "interim" and is flag-only/voided, so re-enabled bets never mix with it.
export const PMV_EPOCH = process.env.TENNIS_PMV_EPOCH || "interim-m1";

// Entry thresholds (interim — props are noisier than football, so the entry bar is higher).
const PMV_DEV_ENTER = num(process.env.TENNIS_PMV_DEV_ENTER, 7);        // deviation ≥ this (¢) → enter the convergence side
const PMV_DEV_PROVENANCE = num(process.env.TENNIS_PMV_DEV_PROVENANCE, 18); // ≥ this → provenance_review FLAG, never a bet
const PMV_PRICE_MIN = num(process.env.TENNIS_PMV_PRICE_MIN, 8);        // price band: tails eaten by spread → skip
const PMV_PRICE_MAX = num(process.env.TENNIS_PMV_PRICE_MAX, 92);
const PMV_BOOK_MIN = num(process.env.TENNIS_PMV_BOOK_MIN, 500);        // prop book gate ($) — same as Gate 0.1
const PMV_MAX_PROPS = Math.max(1, Math.round(num(process.env.TENNIS_PMV_MAX_PROPS, 2))); // correlation: ≤ N props/match, diff families
// Void-on-incompletion (Gate 0.2): Total Sets & Set Handicap VOID on any mid-match retire, so their
// fair value is conditional on the match COMPLETING. Fold the interim completion rate into the theo so
// we don't read a phantom deviation against a mid that already prices the void option. Others resolve
// on their completed unit → no haircut.
const PMV_COMPLETE_PROB = Math.min(1, Math.max(0.5, num(process.env.TENNIS_PMV_COMPLETE_PROB, 0.93)));
const PMV_BUDGET = (() => { const n = Number(process.env.TENNIS_PAPER_BUDGET_USD); return Number.isFinite(n) && n > 0 ? n : 1000; })();
// FLAG-ONLY until the core is re-calibrated (momentum + base_hold from our own frequencies). The
// scanner still logs every would-be entry so data accumulates, but places NO bets — the first-day
// systematic one-sided edge was phantom value from the model's own math. Set env "false" to re-enable.
// Evaluated at call time so it can be flipped without a restart (and set per-test).
export const pmvFlagOnly = (): boolean => process.env.TENNIS_PMV_FLAG_ONLY !== "false";
const VOID_FAMILIES = new Set<PropFamily>(["total_sets", "set_handicap"]);
const PMV_ACTED = "tennis_pmv_acted:"; // per-match idempotency (pre-match scan runs once)
// P4 scan fixes. (1) Placeholder: a prop sitting at exactly ~50¢ is almost always an untraded default,
// not a real market price — deviation against it is noise. (2) Uniformity guard: if >this share of a
// family's PASSING deviations lean the SAME side (all "over", etc.), that's a model bias not an edge —
// stop the family (the signature that caught the LLM phantoms; would fire on the 5th bet, not the 108th).
const PMV_PLACEHOLDER_BAND = num(process.env.TENNIS_PMV_PLACEHOLDER_BAND, 0.5); // ¢ around 50
const PMV_UNIFORM_SHARE = num(process.env.TENNIS_PMV_UNIFORM_SHARE, 0.65);
const PMV_UNIFORM_MIN = Math.max(3, Math.round(num(process.env.TENNIS_PMV_UNIFORM_MIN, 5))); // need ≥N passing to judge
// (2b) Correlation CLUSTER: Total Games and Total Sets are both driven by match LENGTH → one cluster,
// so the ≤2-props/match cap can't double up on the same underlying (games+sets = one bet, not two).
export function corrCluster(f: PropFamily): string {
  if (f === "total_games" || f === "total_sets") return "length";
  if (f === "set_handicap") return "handicap";
  if (f === "set_winner") return "set_winner";
  return f;
}
// The market-outcome SIDE a prop's price refers to, for the uniformity guard ("over"/"under"/"first").
export function propSide(label: string): string { const p = parseProp(label); return p ? p.side : "?"; }
// Does a collapsed prop's FIRST-named player = the match's player 1 (so its price aligns with the
// moneyline's first-named)? Compares surnames of the "A vs B" in the label to players.p1/p2. null =
// can't resolve (don't trade it — provenance).
const surnTok = (s: string) => s.toLowerCase().replace(/[.,()+\-/]/g, " ").split(/\s+/).filter((t) => t.length > 2);
export function propFirstIsP1(label: string, players: { p1: string; p2: string }): boolean | null {
  const vs = /([^:]+?)\s+vs\.?\s+([^:]+?)(?:\s+(?:set|match|total|game|winner|handicap|over|under)\b.*)?$/i.exec(label);
  if (!vs) return null;
  const a = surnTok(vs[1]), p1 = new Set(surnTok(players.p1)), p2 = new Set(surnTok(players.p2));
  const aIsP1 = a.some((t) => p1.has(t)), aIsP2 = a.some((t) => p2.has(t));
  if (aIsP1 && !aIsP2) return true;
  if (aIsP2 && !aIsP1) return false;
  return null;
}

export type PropSide = "over" | "under" | "first";
export interface ParsedProp { family: PropFamily; scope: "match" | "set"; setNum: number | null; line: number | null; side: PropSide; handicapOnFirst: boolean }

/** Parse a stored prop market label into a pricing query. Over/Under props are stored per-side
 *  (price = P(that side)); Set-N-Winner and Set-Handicap are collapsed (price = P(first-named side)). */
export function parseProp(label: string): ParsedProp | null {
  const fam = propFamily(label);
  if (fam == null || fam === "other") return null;
  const low = label.toLowerCase();
  const side: PropSide = /\bover\b/.test(low) ? "over" : /\bunder\b/.test(low) ? "under" : "first";
  const lineM = low.match(/(\d+\.\d+|\d+\.5|\d+)(?!.*\d)/); // the O/U or handicap number (last number in the label)
  const setM = low.match(/set\s*(\d+)/);
  const setNum = setM ? Number(setM[1]) : null;
  if (fam === "total_sets") return { family: fam, scope: "match", setNum: null, line: lineM ? Number(lineM[1]) : 2.5, side, handicapOnFirst: false };
  if (fam === "set_winner") return { family: fam, scope: "set", setNum, line: null, side: "first", handicapOnFirst: false };
  if (fam === "set_handicap") {
    // "A (-1.5) vs B (+1.5)": the minus sits in the first half (before "vs") ⇒ first-named carries −1.5.
    const vsAt = low.indexOf(" vs");
    const minusAt = low.search(/[-−]\s*1\.5/);
    return { family: fam, scope: "match", setNum: null, line: 1.5, side: "first", handicapOnFirst: minusAt >= 0 && (vsAt < 0 || minusAt < vsAt) };
  }
  // total_games: match scope ("Match O/U") vs per-set ("Set N O/U")
  return { family: "total_games", scope: setNum ? "set" : "match", setNum, line: lineM ? Number(lineM[1]) : null, side, handicapOnFirst: false };
}

/** Theoretical probability of the STORED market's outcome (the side its price refers to), 0..1,
 *  with the Gate-0.2 void haircut applied to the completion-conditional families. */
export function theoForProp(p: ParsedProp, theo: TennisTheo): number | null {
  const voidAdj = (x: number) => VOID_FAMILIES.has(p.family) ? PMV_COMPLETE_PROB * x + (1 - PMV_COMPLETE_PROB) * 0.5 : x;
  let base: number | null = null;
  if (p.family === "total_sets") base = p.side === "under" ? theo.dist.pTwoSets : theo.totalSetsOver25;
  else if (p.family === "set_winner") base = theo.set1WinnerA; // price = P(first-named wins the set)
  else if (p.family === "set_handicap") base = p.handicapOnFirst ? theo.setHandicapA15 : (1 - theo.dist.sets.b20);
  else if (p.family === "total_games" && p.line != null) {
    const over = p.scope === "match" ? theo.matchGamesOver(p.line) : theo.setGamesOver(p.line);
    base = p.side === "under" ? 1 - over : over;
  }
  return base == null ? null : voidAdj(base);
}

export interface PmvCandidate { label: string; family: PropFamily; side: string; cluster: string; midCents: number; theoCents: number; deviation: number; bookUsd: number; action: "enter" | "provenance_review" | "skip"; reason: string }
export interface PmvMatchScan { matchId: string; players: { p1: string; p2: string }; moneylineCents: number | null; delta: number | null; tradeable: boolean; candidates: PmvCandidate[] }

// PMV scope: ATP/WTA SINGLES only (the Gate-0.1 build verdict was measured on pm-atp+pm-wta; base_hold
// constants exist only for ATP/WTA; ITF/Challenger have different hold rates + thinner books). Returns
// the tour for an in-scope comp, or null to skip. Doubles are excluded (a different chain entirely).
// Single source of truth is tennisScout.tennisTourOf (shared with Overreaction + Set-Value); kept
// as pmvTour here so PMV's callers/tests read unchanged.
export const pmvTour = tennisTourOf;

const surfaceOf = (tournament: string | null): "hard" | "clay" | "grass" | null => {
  const t = (tournament ?? "").toLowerCase();
  if (/roland garros|french open|clay|monte|madrid|rome|hamburg|kitzb|umag|bastad|gstaad/.test(t)) return "clay";
  if (/wimbledon|grass|halle|queen|eastbourne|newport|s-hertogenbosch|mallorca/.test(t)) return "grass";
  return "hard";
};

/** Deterministic pre-match scan of ONE match's props against the moneyline anchor. Pure read. */
export function scanMatchProps(db: Database, matchId: string, players: { p1: string; p2: string }, tour: "atp" | "wta", tournament: string | null): PmvMatchScan {
  const ml = tennisMoneyline(db, matchId, players);
  const out: PmvMatchScan = { matchId, players, moneylineCents: ml?.p1Cents ?? null, delta: null, tradeable: !!ml && (ml.liquidity ?? 0) >= PMV_BOOK_MIN, candidates: [] };
  if (!ml) return out;
  const base = baseHoldFor(tour, surfaceOf(tournament));
  const theo = tennisTheo(ml.p1Cents / 100, base); // anchor: P(first-named wins) from the moneyline
  out.delta = Math.round(theo.delta * 1000) / 1000;
  for (const mk of R.latestMarkets(db, matchId)) {
    const parsed = parseProp(mk.label);
    if (!parsed) continue; // moneyline or unknown
    const book = Number(mk.liquidity ?? 0) || 0;
    const mid = mk.price;
    const push = (action: PmvCandidate["action"], reason: string, theoCents = 0, dev = 0) =>
      out.candidates.push({ label: mk.label, family: parsed.family, side: parsed.side, cluster: corrCluster(parsed.family), midCents: mid, theoCents, deviation: dev, bookUsd: Math.round(book), action, reason });
    // (P4.1) Placeholder: a prop pinned at ~50¢ is an untraded default, not a real price → skip.
    if (Math.abs(mid - 50) <= PMV_PLACEHOLDER_BAND) { push("skip", `плейсхолдер ~50¢ (нет реальной цены)`); continue; }
    // (P4.3) Contract-side provenance for the collapsed families:
    //  • Set Handicap with an ambiguous "+/-1.5" (no explicit "(-1.5)" side) → we can't tell which
    //    player the line favours → block (provenance), don't guess.
    //  • Set Winner priced on the SECOND-named player → flip the theo to that side.
    let theoProb = theoForProp(parsed, theo);
    if (parsed.family === "set_handicap" && !/\(\s*[-−]\s*1\.5\s*\)/.test(mk.label)) { push("provenance_review", `сторона гандикапа неоднозначна (нет явного «(-1.5)») — провенанс, не торгуем`); continue; }
    if (parsed.family === "set_winner" && theoProb != null) { const first = propFirstIsP1(mk.label, players); if (first === false) theoProb = 1 - theoProb; else if (first == null) { push("skip", `не удалось сопоставить стороны Set Winner — провенанс`); continue; } }
    if (theoProb == null) continue;
    const theoCents = Math.round(theoProb * 1000) / 10;
    const dev = Math.round((theoCents - mid) * 10) / 10;
    if (book < PMV_BOOK_MIN) push("skip", `книга $${Math.round(book)} < $${PMV_BOOK_MIN}`, theoCents, dev);
    else if (mid < PMV_PRICE_MIN || mid > PMV_PRICE_MAX) push("skip", `цена ${mid}¢ вне полосы ${PMV_PRICE_MIN}-${PMV_PRICE_MAX}¢`, theoCents, dev);
    else if (Math.abs(dev) >= PMV_DEV_PROVENANCE) push("provenance_review", `|dev| ${Math.abs(dev)}¢ ≥ ${PMV_DEV_PROVENANCE}¢ — анти-Draw: почти наверняка неверно понят контракт, блок до ручного разбора`, theoCents, dev);
    else if (dev >= PMV_DEV_ENTER) push("enter", `theo ${theoCents}¢ vs mid ${mid}¢ (dev +${dev}¢) — рынок недооценил, покупаем`, theoCents, dev);
    else push("skip", `dev ${dev}¢ < порога ${PMV_DEV_ENTER}¢`, theoCents, dev);
  }
  out.candidates.sort((a, b) => b.deviation - a.deviation);
  return out;
}

// ── Prop settlement (Gate 0.2 clauses) ─────────────────────────────────────
export interface FinalSets { sets: { p1: number; p2: number }[]; setsWonP1: number; setsWonP2: number; matchGames: number }
/** Per-set final games from a finished match's snapshot raw (API-Tennis `scores`). null if unparseable. */
export function finalSetsFromRaw(raw: string | null): FinalSets | null {
  if (!raw) return null;
  let obj: any; try { obj = JSON.parse(raw); } catch { return null; }
  const scores = Array.isArray(obj?.scores) ? obj.scores : null;
  if (!scores || !scores.length) return null;
  const sets = [...scores].sort((a, b) => Number(a.score_set) - Number(b.score_set)).map((s) => ({ p1: Number(s.score_first), p2: Number(s.score_second) })).filter((s) => Number.isFinite(s.p1) && Number.isFinite(s.p2));
  if (!sets.length) return null;
  let setsWonP1 = 0, setsWonP2 = 0, matchGames = 0;
  for (const s of sets) { if (s.p1 > s.p2) setsWonP1++; else if (s.p2 > s.p1) setsWonP2++; matchGames += s.p1 + s.p2; }
  return { sets, setsWonP1, setsWonP2, matchGames };
}
const setCompleted = (s: { p1: number; p2: number } | undefined): boolean => !!s && Math.max(s.p1, s.p2) >= 6;

// A completed set N resolves its own props even after a later retire (Gate 0.2). These families need
// only their UNIT to complete; Total Sets / Set Handicap / match-total-games need the whole MATCH.
const MATCH_SCOPE_VOID = (p: ParsedProp) => p.family === "total_sets" || p.family === "set_handicap" || (p.family === "total_games" && p.scope === "match");

/**
 * Resolve a PMV prop bet from the final match detail per the Gate-0.2 clauses. Returns true (won),
 * false (lost), or null (VOID → refund, excluded from Brier). `firstIsP1` aligns the market's
 * first-named outcome to the scout's player 1.
 */
export function resolveTennisProp(label: string, fs: FinalSets, opts: { retired: boolean; canceled: boolean; firstIsP1: boolean }): boolean | null {
  const p = parseProp(label);
  if (!p) return null;
  if (opts.canceled) return null; // walkover / cancel → void for every prop
  if (opts.retired && MATCH_SCOPE_VOID(p)) return null; // match not completed → void the whole-match props
  const first = opts.firstIsP1 ? { won: fs.setsWonP1, lost: fs.setsWonP2 } : { won: fs.setsWonP2, lost: fs.setsWonP1 };
  const setIdx = (p.setNum ?? 1) - 1;
  const setN = fs.sets[setIdx];
  if ((p.family === "set_winner" || (p.family === "total_games" && p.scope === "set"))) {
    if (!setCompleted(setN)) return null; // the unit didn't complete → void (even if the match finished otherwise)
  }
  if (p.family === "set_winner") { const firstGames = opts.firstIsP1 ? setN!.p1 : setN!.p2, oppGames = opts.firstIsP1 ? setN!.p2 : setN!.p1; return firstGames > oppGames; }
  if (p.family === "set_handicap") { const by2 = first.won - first.lost >= 2; return p.handicapOnFirst ? by2 : (first.lost - first.won < 2); }
  if (p.family === "total_sets") { const total = fs.setsWonP1 + fs.setsWonP2; return p.side === "over" ? total >= 3 : total < 3; }
  if (p.family === "total_games") {
    const games = p.scope === "match" ? fs.matchGames : (setN!.p1 + setN!.p2);
    if (p.line == null) return null;
    return p.side === "over" ? games >= Math.ceil(p.line + 0.5) : games < Math.ceil(p.line + 0.5);
  }
  return null;
}

/**
 * Settle open PMV prop bets from the scout's final match detail (Gate-0.2 clauses via
 * resolveTennisProp): won → payout = stake·(100/entry), lost → 0, VOID → refund (excluded from
 * Brier). Guarded; never throws. Leaves a bet open if the final per-set detail can't be read yet.
 */
export function settleTennisPmvBets(db: Database, deps: EngineDeps = {}): number {
  const now = nowFn(deps)();
  const shadowCfg = loadShadowConfig(db, deps.env);
  let settled = 0;
  const tennisMatchIds = new Set(R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id).map((m) => m.id)));
  for (const b of R.openBets(db)) {
    if (b.strategy_id !== PMV_STRATEGY || !tennisMatchIds.has(b.match_id)) continue;
    const fin = tennisFinalResult(db, b.match_id);
    if (!fin || !fin.finished) continue;
    const row = db.prepare(`SELECT raw FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(b.match_id) as { raw?: string } | undefined;
    const fs = finalSetsFromRaw(row?.raw ?? null);
    if (!fs) continue; // final per-set detail not readable → leave open, retry next tick
    const ml = tennisMoneyline(db, b.match_id, { p1: fin.p1, p2: fin.p2 });
    const won = resolveTennisProp(b.market_label, fs, { retired: fin.retired, canceled: fin.canceled, firstIsP1: ml ? ml.firstIsP1 : true });
    const entry = b.entry_price ?? 0;
    if (won == null) {
      R.updateBet(db, b.id, { status: "settled_void", result: null, payout: b.stake ?? 0, closing_price: b.current_price ?? entry ?? null, settled_at: now, settled_by: "void" });
    } else {
      const payout = won && entry > 0 ? Math.round((b.stake ?? 0) * (100 / entry) * 100) / 100 : 0;
      R.updateBet(db, b.id, { status: won ? "settled_won" : "settled_lost", result: won ? "won" : "lost", payout, closing_price: won ? 100 : 0, settled_at: now });
    }
    try { shadowOnExit(db, b.id, 1, shadowCfg, now); } catch { /* observe-only */ }
    R.insertTradeLog(db, { id: R.uid(), match_id: b.match_id, strategy_id: PMV_STRATEGY, minute: "финал", type: "settle", text: `${b.market_label}: ${won == null ? "возврат (void — недоигран/ретайр по клаузе)" : won ? "выигрыш" : "проигрыш"}`, created_at: now });
    settled++;
  }
  return settled;
}

/** Build the decision-time entry_meta for a PMV prop bet — held to settle, no price stop (thin book). */
export function pmvEntryMeta(o: { theoCents: number; midCents: number; deviation: number; delta: number; edge: number; kelly: number; stake: number; bookUsd: number; family: PropFamily }): BetEntryMeta {
  return {
    phase: "prematch", minute: null, scoreHome: null, scoreAway: null,
    edge: Math.round(o.edge * 1000) / 1000, aiProb: Math.round((o.theoCents / 100) * 1000) / 1000, derivedProb: Math.round((o.theoCents / 100) * 1000) / 1000,
    marketPrice: o.midCents, impliedProb: Math.round((o.midCents / 100) * 1000) / 1000, liveProbAdjusted: null,
    kellyFraction: Math.round(o.kelly * 1000) / 1000, sizeRequested: Math.round(o.stake * 100) / 100, sizeFilled: null, entrySlipCents: null,
    calibration: null, branchWeightSum: null, phantomCheck: null, marketThinnessUsd: o.bookUsd,
    winsOnEvent: false, exitPlan: {
      hold_to_settle: true, deviation_cents: o.deviation, markov_delta: o.delta, prop_family: o.family,
      note: "тонкая книга: держим до сеттла, ценовых стопов нет (главная защита — размер и порог входа)",
      armed_epoch: PMV_EPOCH,
    },
    models: { analysis: null, strategist: null },
  };
}

// ── P2 diagnosis: ACTUAL frequencies from our own snapshots vs the model's assumptions ──────────
// The first-day lean (theo says 3-setters / long matches more likely than the market) has two possible
// causes. This closes the diagnosis empirically: our finished-match snapshots give the REAL 3-set rate
// and the REAL service-hold rate per tour; the model's are the i.i.d. base_hold chain at δ=0. If the
// actual 3-set rate is far below the model's ~50%, the i.i.d.-sets assumption over-prices Total Sets
// Over (fix = set-dependence momentum); if the actual hold rate is below base_hold, base_hold is too
// high (→ fewer, longer... calibrate the constant). Pure read.
// The two suspects are diagnosed SEPARATELY and must NOT be merged into one base_hold tweak:
//   (a) base_hold too high → the ACTUAL service-hold rate (serve is in every snapshot; huge sample).
//   (b) i.i.d. sets       → the 3-set rate among EVEN matches (|moneyline−50|≤band, a proxy for |δ|<0.05).
// The discriminator is `modelThreeSetRateAtActualHold`: the i.i.d. model fed the REAL hold rate. If it
// still says ~50% while the actual even-match 3-set rate is ~38%, base_hold is innocent — the set
// independence is the culprit and only the momentum (P3) fixes it; re-tuning base_hold would be a new error.
const EVEN_MONEYLINE_BAND = num(process.env.TENNIS_PMV_EVEN_BAND, 3); // ¢ around 50 ≈ |δ|<0.05
export interface TennisFreqTour {
  tour: "atp" | "wta";
  holdGames: number; actualHoldRate: number | null; modelHoldRate: number;                 // suspect (a)
  evenMatches: number; evenThreeSetRate: number | null;                                     // suspect (b)
  modelThreeSetRateAtBase: number; modelThreeSetRateAtActualHold: number | null;            // the discriminator
  allDecided: number; allThreeSetRate: number | null;
  verdict: "base_hold_high" | "iid_sets" | "both" | "model_ok" | "insufficient";
}
export interface TennisFrequencyReport { generatedNote: string; tours: TennisFreqTour[] }
export function buildTennisFrequencyReport(db: Database): TennisFrequencyReport {
  const acc: Record<"atp" | "wta", { two: number; three: number; evenTwo: number; evenThree: number; holds: number; breaks: number }> = {
    atp: { two: 0, three: 0, evenTwo: 0, evenThree: 0, holds: 0, breaks: 0 }, wta: { two: 0, three: 0, evenTwo: 0, evenThree: 0, holds: 0, breaks: 0 },
  };
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    const tour = pmvTour(c); if (!tour) continue;
    for (const m of R.listMatches(db, c.id)) {
      if (m.state !== "finished") continue;
      const snaps = db.prepare(`SELECT * FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at`).all(m.id) as R.TennisSnapshotRow[];
      if (snaps.length < 2) continue;
      const last = snaps[snaps.length - 1];
      const totalSets = (last.sets_p1 ?? 0) + (last.sets_p2 ?? 0);
      const decided3 = totalSets === 3, decided2 = totalSets === 2;
      if (decided2) acc[tour].two++; else if (decided3) acc[tour].three++;
      // EVEN filter: the START moneyline within EVEN_MONEYLINE_BAND of 50¢ (a proxy for |δ|<0.05).
      const startRow = snaps.find((s) => s.pm_p1_cents != null);
      const startP = startRow?.pm_p1_cents;
      if (startP != null && Math.abs(startP - 50) <= EVEN_MONEYLINE_BAND && (decided2 || decided3)) {
        if (decided2) acc[tour].evenTwo++; else acc[tour].evenThree++;
      }
      for (const e of detectTennisEvents(snaps)) { if (e.type === "hold") acc[tour].holds++; else if (e.type === "break") acc[tour].breaks++; }
    }
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const tours: TennisFreqTour[] = (["atp", "wta"] as const).map((tour) => {
    const a = acc[tour]; const games = a.holds + a.breaks; const allDecided = a.two + a.three; const evenDecided = a.evenTwo + a.evenThree;
    const base = tour === "wta" ? BASE_HOLD.wta : BASE_HOLD.atp_hard;
    const actualHold = games ? a.holds / games : null;
    const modelAtBase = r3(1 - matchDistribution(base, base, 0).pTwoSets);
    const modelAtActual = actualHold != null ? r3(1 - matchDistribution(actualHold, actualHold, 0).pTwoSets) : null;
    const evenRate = evenDecided ? a.evenThree / evenDecided : null;
    // Verdict: hold gap vs 3-set gap AGAINST THE ACTUAL-HOLD model (isolates i.i.d.).
    let verdict: TennisFreqTour["verdict"] = "insufficient";
    if (games >= 200 && evenDecided >= 10 && actualHold != null && modelAtActual != null && evenRate != null) {
      const holdOff = Math.abs(actualHold - base) >= 0.03;                       // base_hold materially wrong
      const iidOff = modelAtActual - evenRate >= 0.08;                           // even with real holds, model over-prices 3-sets
      verdict = holdOff && iidOff ? "both" : iidOff ? "iid_sets" : holdOff ? "base_hold_high" : "model_ok";
    }
    return {
      tour, holdGames: games, actualHoldRate: actualHold != null ? r3(actualHold) : null, modelHoldRate: base,
      evenMatches: evenDecided, evenThreeSetRate: evenRate != null ? r3(evenRate) : null,
      modelThreeSetRateAtBase: modelAtBase, modelThreeSetRateAtActualHold: modelAtActual,
      allDecided, allThreeSetRate: allDecided ? r3(a.three / allDecided) : null, verdict,
    };
  });
  const note = tours.map((t) => `${t.tour} [${t.verdict}]: hold факт ${t.actualHoldRate ?? "—"} vs base ${t.modelHoldRate} (${t.holdGames} геймов) | 3-сетовиков на равных ${t.evenThreeSetRate ?? "—"} vs модель@факт-hold ${t.modelThreeSetRateAtActualHold ?? "—"} (${t.evenMatches} равных матчей)`).join(" · ");
  return { generatedNote: note, tours };
}

// ── Entries export (audit): every PMV bet with its full decision provenance + the anti-Draw flags ──
export interface PmvBetRow {
  createdAt: string; match: string; comp: string; profile: string; prop: string; family: PropFamily | null;
  side: string; line: number | null; midCents: number | null; theoCents: number | null; deviationCents: number | null;
  delta: number | null; bookUsd: number | null; edgePct: number | null; stake: number | null;
  status: string; result: string | null; payout: number | null; voided: boolean; epoch: string | null; rationale: string;
}
export interface PmvBetsReport { generatedNote: string; entries: PmvBetRow[]; provenanceFlags: { at: string; match: string; text: string }[]; skips: { at: string; match: string; text: string }[] }

export function buildPmvBetsReport(db: Database): PmvBetsReport {
  const comps = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  const matchMeta = (mid: string) => { const m = R.getMatch(db, mid); const c = m ? comps.get(m.competition_id) : null; return { name: m ? `${m.home} — ${m.away}` : mid, comp: c?.name ?? m?.competition_id ?? "?" }; };
  const entries: PmvBetRow[] = [];
  for (const b of R.allBets(db)) {
    if (b.strategy_id !== PMV_STRATEGY) continue;
    const mm = matchMeta(b.match_id);
    const meta = parseEntryMeta(b.entry_meta) as any;
    const plan = meta?.exitPlan ?? {};
    const parsed = parseProp(b.market_label);
    entries.push({
      createdAt: b.created_at, match: mm.name, comp: mm.comp, profile: b.risk_profile_id ?? "medium",
      prop: b.market_label, family: parsed?.family ?? null, side: parsed?.side ?? "?", line: parsed?.line ?? null,
      midCents: b.entry_price ?? null, theoCents: b.ai_prob != null ? Math.round(b.ai_prob * 1000) / 10 : null,
      deviationCents: plan.deviation_cents ?? null, delta: plan.markov_delta ?? null, bookUsd: meta?.marketThinnessUsd ?? null,
      edgePct: meta?.edge != null ? Math.round(meta.edge * 1000) / 10 : null, stake: b.stake ?? null,
      status: b.status, result: b.result ?? null, payout: b.payout ?? null, voided: b.settled_by === "void",
      epoch: (b.code_version ?? "").split("·").pop() ?? null, rationale: b.rationale ?? "",
    });
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
  const log = R.recentTradeLog(db, 2000).filter((l) => l.strategy_id === PMV_STRATEGY);
  const provenanceFlags = log.filter((l) => /provenance_review/.test(l.text)).map((l) => ({ at: l.created_at, match: matchMeta(l.match_id).name, text: l.text }));
  const skips = log.filter((l) => l.type === "skip" && !/provenance_review/.test(l.text)).map((l) => ({ at: l.created_at, match: matchMeta(l.match_id).name, text: l.text })).slice(0, 200);
  return { generatedNote: `${entries.length} PMV-ставок · ${provenanceFlags.length} provenance-флагов · ${skips.length} прочих скипов`, entries, provenanceFlags, skips };
}

export function pmvBetsCsv(r: PmvBetsReport): string {
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["created_at", "match", "comp", "profile", "prop", "family", "side", "line", "mid_cents", "theo_cents", "deviation_cents", "delta", "book_usd", "edge_pct", "stake", "status", "result", "payout", "voided", "epoch", "rationale"];
  const rows = r.entries.map((e) => [e.createdAt, e.match, e.comp, e.profile, e.prop, e.family, e.side, e.line, e.midCents, e.theoCents, e.deviationCents, e.delta, e.bookUsd, e.edgePct, e.stake, e.status, e.result, e.payout, e.voided, e.epoch, e.rationale].map(esc).join(","));
  return [head.join(","), ...rows].join("\n");
}

// ── Core success criterion (written before data): Brier of the Markov prob vs the implied mid ──
// The core lives IFF its probabilities beat the thin market's own (Brier_markov ≤ Brier_implied) over
// ~40-60 settles — i.e. it prices props more accurately than the inattentive market. PnL on this
// sample is noisy and secondary; CLV on thin props is unreliable. Void settles are excluded.
export interface PmvBrierFamily { family: PropFamily; n: number; brierMarkov: number; brierImplied: number; edge: number }
export interface PmvBrierReport { settled: number; ready: boolean; readyAt: number; brierMarkov: number; brierImplied: number; verdict: "core_beats_market" | "core_worse" | "accumulating"; families: PmvBrierFamily[]; note: string }
export function buildPmvBrierReport(db: Database, readyAt = 40): PmvBrierReport {
  const rows = R.allBets(db).filter((b) => b.strategy_id === PMV_STRATEGY && (b.status === "settled_won" || b.status === "settled_lost") && b.settled_by !== "void" && b.result != null);
  const byFam = new Map<PropFamily, { n: number; sm: number; si: number }>();
  let n = 0, sm = 0, si = 0;
  for (const b of rows) {
    const fam = parseProp(b.market_label)?.family; if (!fam) continue;
    const outcome = b.result === "won" ? 1 : 0;
    const pm = b.ai_prob ?? 0.5, pi = (b.entry_price ?? 50) / 100;
    const em = (pm - outcome) ** 2, ei = (pi - outcome) ** 2;
    n++; sm += em; si += ei;
    const f = byFam.get(fam) ?? byFam.set(fam, { n: 0, sm: 0, si: 0 }).get(fam)!; f.n++; f.sm += em; f.si += ei;
  }
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const brierMarkov = n ? r4(sm / n) : 0, brierImplied = n ? r4(si / n) : 0;
  const ready = n >= readyAt;
  const verdict: PmvBrierReport["verdict"] = !ready ? "accumulating" : brierMarkov <= brierImplied ? "core_beats_market" : "core_worse";
  const families = [...byFam.entries()].map(([family, f]) => ({ family, n: f.n, brierMarkov: r4(f.sm / f.n), brierImplied: r4(f.si / f.n), edge: r4((f.si - f.sm) / f.n) })).sort((a, b) => b.n - a.n);
  const note = !ready ? `${n}/${readyAt} сеттлов — копим (критерий ядра ещё не судим)`
    : verdict === "core_beats_market" ? `Brier ядра ${brierMarkov} ≤ implied ${brierImplied} — ядро прайсит точнее рынка, стратегия ЖИВЁТ`
      : `Brier ядра ${brierMarkov} > implied ${brierImplied} — ядро ХУЖЕ рынка, паркуем и разбираем (base_hold / тай-брейк-аппрокс)`;
  return { settled: n, ready, readyAt, brierMarkov, brierImplied, verdict, families, note };
}

/**
 * §PMV PRE-MATCH entry: deterministic consistency scan. For each not-yet-live tennis match with a
 * resolvable moneyline, price the props off δ and open a CODE-sized paper bet on each prop whose
 * theo beats its mid by ≥ the deviation threshold — capped at MAX_PROPS/match of DIFFERENT families
 * (all props on a match are correlated through the outcome). ≥18% deviations are FLAGGED, not bet.
 * NO LLM. Isolated + guarded; never throws into the tick. Returns entries opened.
 */
export async function tennisPmvTick(db: Database, deps: EngineDeps = {}): Promise<number> {
  const strat = R.getStrategy(db, PMV_STRATEGY);
  if (!strat) return 0; // not seeded → PMV off
  const now = nowFn(deps)();
  const codeVer = `${effectiveCodeVersion(db)}·${PMV_EPOCH}`;
  const shadowCfg = loadShadowConfig(db, deps.env);
  let opened = 0;
  const profilesAll = (() => { const ps = R.listRiskProfiles(db).map((p) => p.id); return ps.length ? ps : RISK_PROFILE_DEFS.map((d) => d.id); })();

  // PASS 1: scan every pending in-scope match; collect the scans + accumulate per-FAMILY side counts
  // across the WHOLE slate for the uniformity guard (a lean is a property of the family, not one match).
  const pending: { comp: string; matchId: string; players: { p1: string; p2: string }; scan: PmvMatchScan }[] = [];
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    const tour = pmvTour(c);
    if (!tour) continue; // ATP/WTA singles only
    for (const m of R.listMatches(db, c.id)) {
      if (m.state === "finished" || m.state === "live") continue; // PMV is PRE-MATCH only (v1)
      if (R.metaGet(db, PMV_ACTED + m.id)) continue;              // scan once per match
      const scan = scanMatchProps(db, m.id, { p1: m.home, p2: m.away }, tour, c.name);
      if (!scan.tradeable) continue;
      pending.push({ comp: c.id, matchId: m.id, players: { p1: m.home, p2: m.away }, scan });
    }
  }
  // UNIFORMITY GUARD: per family, if > PMV_UNIFORM_SHARE of the PASSING deviations lean the same SIDE
  // (all "over", etc.) over ≥ PMV_UNIFORM_MIN samples, that's a model bias not an edge → STOP the family.
  const famSide = new Map<PropFamily, Map<string, number>>();
  for (const p of pending) for (const cand of p.scan.candidates) if (cand.action === "enter") {
    const s = famSide.get(cand.family) ?? famSide.set(cand.family, new Map()).get(cand.family)!;
    s.set(cand.side, (s.get(cand.side) ?? 0) + 1);
  }
  const stoppedFamilies = new Map<PropFamily, string>();
  for (const [fam, sides] of famSide) {
    const total = [...sides.values()].reduce((a, b) => a + b, 0);
    const top = Math.max(...sides.values());
    if (total >= PMV_UNIFORM_MIN && top / total > PMV_UNIFORM_SHARE) {
      const domSide = [...sides.entries()].find(([, v]) => v === top)![0];
      stoppedFamilies.set(fam, `однородный крен: ${top}/${total} проходящих расхождений на «${domSide}» (>${Math.round(PMV_UNIFORM_SHARE * 100)}%) — модельный биас, стоп семьи`);
    }
  }

  // PASS 2: act per match.
  for (const { comp, matchId, players, scan } of pending) {
    const c = { id: comp };
    const m = { id: matchId, home: players.p1, away: players.p2 };
    {
      // Provenance flags (anti-Draw + contract-side) — logged regardless of trading.
      for (const cand of scan.candidates.filter((x) => x.action === "provenance_review"))
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: PMV_STRATEGY, minute: "предматч", type: "skip", text: `provenance_review «${cand.label}»: ${cand.reason}`, created_at: now });
      // A stopped family's would-be entries are logged as uniformity_stop, never taken.
      const enters = scan.candidates.filter((x) => x.action === "enter" && !stoppedFamilies.has(x.family));
      for (const cand of scan.candidates.filter((x) => x.action === "enter" && stoppedFamilies.has(x.family)))
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: PMV_STRATEGY, minute: "предматч", type: "skip", text: `uniformity_stop «${cand.label}»: ${stoppedFamilies.get(cand.family)}`, created_at: now });
      if (!enters.length) { R.metaSet(db, PMV_ACTED + m.id, "no_edge", now); continue; }
      // FLAG-ONLY (default until re-calibrated): log the would-be entries, place NO bets.
      if (pmvFlagOnly()) {
        for (const cand of enters)
          R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: PMV_STRATEGY, minute: "предматч", type: "skip", text: `flag_only «${cand.label}»: theo ${cand.theoCents}¢ vs mid ${cand.midCents}¢ (dev +${cand.deviation}¢, δ=${scan.delta}, книга $${cand.bookUsd}) — ставка НЕ размещена (калибровка ядра)`, created_at: now });
        R.metaSet(db, PMV_ACTED + m.id, `flag_only:${enters.length}`, now);
        continue;
      }
      // Correlation cap: ≤ MAX_PROPS of different CLUSTERS (games+sets = one length cluster).
      const chosen: PmvCandidate[] = []; const clusters = new Set<string>();
      for (const cand of enters) { if (chosen.length >= PMV_MAX_PROPS) break; if (clusters.has(cand.cluster)) continue; clusters.add(cand.cluster); chosen.push(cand); }
      R.metaSet(db, PMV_ACTED + m.id, `entered:${chosen.length}`, now); // one shot per match
      const heldByProfile = (profile: string) => R.betsForMatch(db, m.id, PMV_STRATEGY).filter((b) => b.status === "open" && b.risk_profile_id === profile);
      for (const cand of chosen) {
        const ourProb = cand.theoCents / 100, implied = cand.midCents / 100;
        for (const profile of profilesAll) {
          const cfg = getProfileConfig(db, profile);
          const held = heldByProfile(profile).reduce((s, b) => s + (b.stake ?? 0), 0);
          const r = sizePrematch({ ourProb, priceCents: cand.midCents, implied, calibration: 0.6, liquidity: cand.bookUsd, budget: PMV_BUDGET, matchExposure: held, compExposure: held, cfg, allowLargeEdge: false });
          if (r.status !== "enter") { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: PMV_STRATEGY, minute: "предматч", type: "skip", text: `[${profile}] «${cand.label}» dev +${cand.deviation}¢, но сайзинг отклонил: ${r.reason}`, created_at: now }); continue; }
          // Thin-book cap: never stake more than 25% of the prop's book depth.
          const stake = Math.min(r.stake, 0.25 * cand.bookUsd);
          if (stake < 1) continue;
          const meta = pmvEntryMeta({ theoCents: cand.theoCents, midCents: cand.midCents, deviation: cand.deviation, delta: scan.delta ?? 0, edge: r.edge, kelly: r.kellyFraction, stake, bookUsd: cand.bookUsd, family: cand.family });
          const betId = R.uid();
          R.insertBet(db, {
            id: betId, match_id: m.id, strategy_id: PMV_STRATEGY, risk_profile_id: profile, market_label: cand.label,
            status: "open", proposed_price: cand.midCents, entry_price: cand.midCents, current_price: cand.midCents, closing_price: null,
            ai_prob: ourProb, stake, rationale: `PMV: манилайн δ=${scan.delta} → theo ${cand.theoCents}¢ vs mid ${cand.midCents}¢ (dev +${cand.deviation}¢), семья ${cand.family}, книга $${cand.bookUsd}`,
            entered_minute: "предматч", result: null, payout: null, settled_by: null, settled_at: null,
            entry_meta: serializeEntryMeta(meta), code_version: codeVer, created_at: now,
          });
          try { shadowOnEntries(db, [{ betId, matchId: m.id, competitionId: c.id, strategyId: PMV_STRATEGY, profileId: profile, size: stake, edge: r.edge, isLive: false }], shadowCfg, now); } catch { /* observe-only */ }
          R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: PMV_STRATEGY, minute: "предматч", type: "enter", text: `[${profile}] PMV «${cand.label}» @ ${cand.midCents}¢ · $${Math.round(stake)} (theo ${cand.theoCents}¢, dev +${cand.deviation}¢, δ=${scan.delta}, пороги:${PMV_EPOCH})`, created_at: now });
          opened++;
        }
      }
    }
  }
  return opened;
}
