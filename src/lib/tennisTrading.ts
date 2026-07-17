// ============================================================
// EDGE LAB — TENNIS paper trading loop (§6). PARALLEL to football; money-path isolated.
//
// Flow: charge armed triggers on mapped+tradeable ATP/WTA matches (deterministic) → on a
// fresh BREAK that a trigger's preconditions match (pre-LLM gate), ask the LLM only the
// real_shift question → if overreaction, open a CODE-sized paper bet on the favourite's
// winner market with a pre-written recovery exit → settle from the scout's final result
// (advances-wins / retirement / void). PAPER only; interim armed prices (calibrated later
// from tennis_break_marks). §9.6: LLM judges real_shift; code does side/price/size/exit.
// ============================================================

import "./http.js";
import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import type { Bet } from "./types.js";
import { settleBet, resolveTennisWinner } from "./settlement.js";
import { loadShadowConfig, shadowOnExit } from "./shadow.js";
import { chargeTennisTriggers, tennisReassessShouldCall, type TennisCharge } from "./tennisOverreaction.js";
import { SET_VALUE_STRATEGY, SET_VALUE_ARMED, SET_VALUE_EPOCH, setValueGate } from "./tennisSetValue.js";
import { detectBreaks, detectTennisEvents, tennisMoneyline, favTokenOf, tennisTourOf, fetchTennisFixtures, trimRaw, TENNIS_TERMINAL_RE, loadTennisConfig } from "./tennisScout.js";
import { loadPolymarketConfig, type OrderBookFetch, type PolymarketConfig } from "./polymarket.js";
import { classifyOrderBook, paperSellFill } from "./executor/paperFill.js";
import { bookDepthUsd } from "./execution.js";
import { PaperExecutor } from "./executor/paper.js";
import { clientOrderIdFor, type OrderAck } from "./executor/types.js";
import { effectiveCodeVersion } from "./codeEpoch.js";
import { serializeEntryMeta, parseEntryMeta, type BetEntryMeta } from "./betMeta.js";
import { strategistDecide, effectiveEnv } from "./llm.js";
import { sizePrematch, impliedProbs } from "./strategist.js";
import { getProfileConfig, RISK_PROFILE_DEFS } from "./riskConfig.js";
import { shadowOnEntries, type ShadowEntryRequest } from "./shadow.js";
import { getStrategy } from "./repo.js";

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const surnames = (name: string) => norm(name).replace(/[.,]/g, " ").split(/[\s-]+/).filter((t) => t.length > 1);

// Per-match tradeability: winner-book depth ≥ this ($) on BOTH sides at charge time. Env-tunable.
// NB: this gates on Gamma's SELF-DECLARED moneyline liquidity (`ml.liquidity`), a cheap pre-filter that
// can be stale/inflated — see TENNIS_MIN_REAL_BOOK_USD for the real-book backstop at the money path.
const TENNIS_MIN_BOOK_USD = (() => { const n = Number(process.env.TENNIS_MIN_BOOK_USD); return Number.isFinite(n) && n > 0 ? n : 2000; })();
// Real-book depth floor AT THE MONEY PATH (B3 — sibling of token-fix-m1, same call site). The
// tradeability gate above trusts Gamma's declared liquidity; the Mrva–Roncadelli winner book was $44 of
// ACTUAL executable depth yet declared healthy, so it passed the $2k gate and the fill engine merely
// clamped the stake small instead of cutting the trade. We already fetch the favourite token's book for
// the orientation invariant — verify its real executable ask notional here; below this floor → skip
// (thin_real_book), never a dust fill on a $44 book. Conservative default (real books are far thinner
// than declared); env-tunable, and the real-vs-declared gap is logged so it can be calibrated from data.
const TENNIS_MIN_REAL_BOOK_USD = (() => { const n = Number(process.env.TENNIS_MIN_REAL_BOOK_USD); return Number.isFinite(n) && n > 0 ? n : 250; })();
// Carle frozen-favourite guard (¢): the Overreaction snapback needs a GENUINE favourite to recover TO.
// The favourite is ID'd off the PRE-MATCH price (underdog ≤ favUnderdogMax → favourite ≥ ~60¢), but a
// match can TIGHTEN by the break — if the pre-break recovery reference has drifted to a coin-flip (the
// 49.5¢ Carle: a frozen/levelled "favourite"), there is no favoured level to snap back to and the edge
// is phantom. Require the pre-break favourite price ≥ this AT TRIGGER TIME. Env-tunable.
const TENNIS_MIN_PREBREAK_FAV_CENTS = (() => { const n = Number(process.env.TENNIS_MIN_PREBREAK_FAV_CENTS); return Number.isFinite(n) && n > 0 ? n : 52; })();
// B2 — absurd_edge ceiling for the Overreaction buyback (fraction). Raised from the shared 25% to 40%:
// the 25% net was catching legitimate DEEP moneyline snapbacks (the moneyline panic amplitude is larger
// than the old prop-priced era assumed), while the real phantom sources are now cut UPSTREAM by dedicated
// guards (token orientation invariant, thin_real_book, frozen_favourite). Every entry in the newly-opened
// 25–40% band is COHORT-LOGGED so the ceiling can be re-tuned from the accumulated clean distribution. Env-tunable.
const TENNIS_ABSURD_EDGE_BLOCK = (() => { const n = Number(process.env.TENNIS_ABSURD_EDGE_BLOCK); return Number.isFinite(n) && n > 0 ? n : 0.40; })();
// The prior shared ceiling — the lower edge of the cohort we now watch (entries that USED to be blocked).
const TENNIS_ABSURD_EDGE_COHORT_FROM = 0.25;

// B6 — per-profile MINIMUM panic depth to enter (the drop pre-break − entry, ¢), as QUANTILES of the
// in-scope early-break panic distribution: aggressive=p40 (thin frequent edge), medium=p60,
// conservative=p80. On a shallow distribution (early-break median ≈3.5¢) this means conservative enters
// RARELY and DEEP — accepted as design: the real edge lives in the tail, so a conservative profile trades
// only genuine deep panics, not 3.5¢ noise eaten by spread/vig (the football "conservative funnel of
// losses" paradox, avoided). Self-calibrating from tennis_break_marks; env-override per profile.
const TENNIS_PANIC_QUANTILE: Record<string, number> = { aggressive: 0.40, medium: 0.60, conservative: 0.80 };
// Minimum in-scope early marks before the quantiles are trusted; below it, hold the interim floors
// (so a thin sample can't make the thresholds jump around).
const TENNIS_PANIC_MIN_MARKS = (() => { const n = Number(process.env.TENNIS_PANIC_MIN_MARKS); return Number.isFinite(n) && n > 0 ? n : 200; })();
const TENNIS_PANIC_INTERIM: Record<string, number> = { aggressive: 2, medium: 3.5, conservative: 6 };

export interface TennisPanicThresholds { aggressive: number; medium: number; conservative: number; source: "env" | "quantile" | "interim"; n: number }
/**
 * B6 min-drop-at-entry per profile, resolved from the panic-amplitude distribution. POOL = ATP+WTA
 * EARLY marks ONLY — Challenger is not traded (mixing its marks calibrates thresholds on a population we
 * don't trade) and LATE breaks are Set-Value's domain. env-override per profile wins entirely; else
 * quantiles once ≥ TENNIS_PANIC_MIN_MARKS in-scope marks exist; else the interim floors. Pure read.
 */
export function tennisPanicThresholds(db: Database): TennisPanicThresholds {
  const envDrop = (p: string) => { const n = Number(process.env[`TENNIS_PANIC_MIN_DROP_${p.toUpperCase()}`]); return Number.isFinite(n) && n >= 0 ? n : null; };
  const eA = envDrop("aggressive"), eM = envDrop("medium"), eC = envDrop("conservative");
  if (eA != null && eM != null && eC != null) return { aggressive: eA, medium: eM, conservative: eC, source: "env", n: 0 };
  // In-scope early panic amplitudes: ATP or WTA, NOT Challenger, broke_early.
  const xs = R.listTennisBreakMarks(db)
    .filter((m) => m.panic_cents != null && m.broke_early && !/challenger/i.test(m.event_type ?? "") && /\b(atp|wta|men|women)\b/i.test(m.event_type ?? ""))
    .map((m) => m.panic_cents as number)
    .sort((a, b) => a - b);
  if (xs.length < TENNIS_PANIC_MIN_MARKS) return { ...(TENNIS_PANIC_INTERIM as { aggressive: number; medium: number; conservative: number }), source: "interim", n: xs.length };
  const q = (p: number) => { const i = Math.min(xs.length - 1, Math.max(0, Math.floor(p * (xs.length - 1)))); return Math.round(xs[i] * 10) / 10; };
  return { aggressive: q(TENNIS_PANIC_QUANTILE.aggressive), medium: q(TENNIS_PANIC_QUANTILE.medium), conservative: q(TENNIS_PANIC_QUANTILE.conservative), source: "quantile", n: xs.length };
}
const TENNIS_STRATEGY = "tennis_overreaction";
// Both tennis strategies share the settle / exit / one-position machinery (both buy the favourite's
// moneyline). Set-Value adds the "lost set 1" horizon-of-a-match entry with a partial-take exit.
const TENNIS_STRATEGIES = new Set([TENNIS_STRATEGY, SET_VALUE_STRATEGY]);

/** Latest scout state for a Polymarket-linked match: the final result if it's over.
 *  `manual` = finished but we cannot safely name the winner (no event_winner and the set score can't
 *  disambiguate — e.g. a retirement) → settle NOTHING, flag for a human. Honest "don't know". */
export interface TennisFinal { finished: boolean; canceled: boolean; retired: boolean; advancing: "first" | "second" | null; manual: boolean; p1: string; p2: string }
export function tennisFinalResult(db: Database, matchId: string): TennisFinal | null {
  // Newest snapshot whose pm_match_id == this match.
  const rows = db.prepare(`SELECT p1,p2,sets_p1,sets_p2,live,status,raw FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).all(matchId) as any[];
  if (!rows.length) return null;
  const r = rows[0];
  const status = String(r.status ?? "");
  // Polymarket resolution (verified from the market description, uniform across ATP/WTA/ITF/doubles):
  //   • WALKOVER (withdraws BEFORE start) / canceled / tie / delayed>7d w/o winner → 50-50 → VOID.
  //   • RETIREMENT / DEFAULT / DISQUALIFICATION mid-match → resolves to the player who ADVANCES.
  // So walkover lives in the void family; retire/default/DQ live in the advancer family.
  const canceled = /cancel|abandon|walkover|w[\/.]o/i.test(status);
  const retired = /retir|\bret\.?\b|default|disqualif|\bdsq\b/i.test(status);
  const finished = retired || canceled || r.live === 0 || /finish/i.test(status);
  if (!finished) return null;
  // event_winner is the PRIMARY (authoritative) source of the advancer.
  let fromWinner: "first" | "second" | null = null;
  try { const raw = r.raw ? JSON.parse(r.raw) : null; const w = String(raw?.event_winner ?? "").toLowerCase(); if (w.includes("first")) fromWinner = "first"; else if (w.includes("second")) fromWinner = "second"; } catch { /* fall through */ }
  const bySets: "first" | "second" | null = (r.sets_p1 != null && r.sets_p2 != null && r.sets_p1 !== r.sets_p2) ? (r.sets_p1 > r.sets_p2 ? "first" : "second") : null;
  let advancing: "first" | "second" | null = null;
  let manual = false;
  if (canceled) {
    advancing = null; // void family — no advancer, settle refunds
  } else if (fromWinner != null) {
    advancing = fromWinner;
    // Cross-check ONLY a clean (non-retired) finish: a decisive set score that disagrees with
    // event_winner means we can't trust either → manual. A RETIREMENT's set score is mid-match and
    // naturally disagrees with the advancer (the leader often retires), so it must NOT cross-check.
    if (!retired && bySets != null && bySets !== fromWinner) { advancing = null; manual = true; }
  } else if (retired) {
    // Retirement WITHOUT event_winner: the set-count leader is OFTEN the one who retired (injury while
    // ahead), so the leader is NOT the advancer. We cannot know the advancer → manual, never guess (bug B).
    manual = true;
  } else if (bySets != null) {
    advancing = bySets; // a clean, decisive finish (2-0 / 2-1) with no event_winner → the set winner advanced
  } else {
    manual = true; // finished, no event_winner, no decisive score → honest don't-know
  }
  return { finished: true, canceled, retired, advancing, manual, p1: String(r.p1 ?? ""), p2: String(r.p2 ?? "") };
}

// Per-bet "finished but winner unknown" flag: leave the bet OPEN (capital honestly still committed),
// emit ONE loud log, and never guess. A later poll that returns event_winner resolves it; otherwise a
// human does. Idempotent via the marker so we don't spam every tick.
const MANUAL_MARK = "tennis_manual:";
export function flagTennisManual(db: Database, betId: string, matchId: string, strategyId: string, label: string, now: string): void {
  if (R.metaGet(db, MANUAL_MARK + betId)) return; // already flagged
  R.metaSet(db, MANUAL_MARK + betId, "pending", now);
  R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: strategyId, minute: "финал", type: "skip", text: `⚠ РУЧНОЙ РАЗБОР: «${label}» — матч завершён, но победитель не определён (нет event_winner / счёт неоднозначен, вероятно ретайр). Ставка ОСТАВЛЕНА открытой, НЕ угадываем — settlement_pending_manual`, created_at: now });
}

// Any open tennis position (all three strategies) is a reason to chase a final result. PMV lives in
// tennisPmv (importing it here would cycle), so its id is a string literal.
const TENNIS_ALL_STRATEGIES = new Set<string>([...TENNIS_STRATEGIES, "tennis_pmv"]);
// Stranded-match settlement: how long the newest scout snapshot may be stale before we chase the final
// result via get_fixtures. 15min absorbs normal live-feed gaps; below ~10 risks false-positives on a
// paused feed. Env-tunable. (The match usually just VANISHES from get_livescore when it ends, so the
// live path can never see the terminal row — this poller is the authoritative finish signal.)
const TENNIS_FINAL_POLL_STALE_MIN = (() => { const n = Number(process.env.TENNIS_FINAL_POLL_STALE_MIN); return Number.isFinite(n) && n > 0 ? n : 15; })();
// A match "live" longer than this (min from kickoff) is almost certainly a stuck feed, not a real
// match — poll get_fixtures for its true result even if the snapshot is fresh. 200min clears a normal
// bo3; a genuine bo5 marathon is protected because get_fixtures cross-checks (still-live → left alone). Env-tunable.
const TENNIS_LIVE_CEILING_MIN = (() => { const n = Number(process.env.TENNIS_LIVE_CEILING_MIN); return Number.isFinite(n) && n > 0 ? n : 200; })();

/**
 * A+B: chase the FINAL result of a tennis match that has an open position (or was live) but has
 * dropped out of the live feed for > TENNIS_FINAL_POLL_STALE_MIN. get_livescore only carries in-play
 * matches, so a normally-finished match never yields a terminal live row and would strand its
 * position forever. We fetch get_fixtures for the match's date window, find it by event_key, and —
 * if it's terminal — WRITE the terminal snapshot the existing settle path already consumes (newest
 * snapshot → tennisFinalResult). If fixtures still says LIVE (a schedule shift), we leave it in
 * observation. Async, guarded; never throws into the tick. Returns terminal snapshots written.
 */
export async function pollTennisFinals(db: Database, deps: EngineDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  if ((env.TENNIS_FINAL_POLL ?? "on") === "off") return 0; // kill-switch: disable the fixtures poll without a redeploy
  const cfg = loadTennisConfig(env);
  if (!cfg.enabled) return 0;
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  // 1. Collect stranded matches (scout-linked, not finished, stale, with a reason to settle).
  const byStart = new Map<string, { matchId: string; eventKey: string }[]>();
  const MAX_POLL = 40; // hard cap: never let one poll fan out to an unbounded number of fixtures fetches
  let collected = 0;
  outer: for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    for (const m of R.listMatches(db, c.id)) {
      if (collected >= MAX_POLL) break outer;
      if (m.state === "finished") continue;
      const last = db.prepare(`SELECT event_key, batch_at FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(m.id) as { event_key?: string; batch_at?: string } | undefined;
      if (!last?.event_key) continue; // never scout-linked → nothing to poll
      const ageMin = (nowMs - (Date.parse(last.batch_at ?? "") || 0)) / 60000;
      const liveMin = m.state === "live" ? (nowMs - (Date.parse(m.kickoff_at ?? "") || nowMs)) / 60000 : 0;
      // Chase the final when the feed went STALE (>15min), OR when a match has been "live" implausibly
      // long (past the ceiling) even with a FRESH snapshot — API-Tennis sometimes leaves a finished
      // match stuck at live=1 for hours (the "300'" phantom). get_fixtures is authoritative: if it too
      // says live (a genuine bo5 marathon), the terminal check below just leaves it in observation.
      const stale = ageMin > TENNIS_FINAL_POLL_STALE_MIN;
      const liveTooLong = liveMin > TENNIS_LIVE_CEILING_MIN;
      if (!stale && !liveTooLong) continue;
      const hasOpen = R.betsForMatch(db, m.id).some((b) => TENNIS_ALL_STRATEGIES.has(b.strategy_id) && b.status === "open");
      if (!hasOpen && m.state !== "live") continue; // no open position and not live → no reason to chase
      if (tennisFinalResult(db, m.id)?.finished) continue; // a terminal snapshot already exists → settle handles it
      const start = (m.kickoff_at ?? last.batch_at ?? now).slice(0, 10);
      (byStart.get(start) ?? byStart.set(start, []).get(start)!).push({ matchId: m.id, eventKey: last.event_key });
      collected++;
    }
  }
  if (!byStart.size) return 0;
  // 2. Per start-date, fetch fixtures for THAT SINGLE DAY (date_start=date_stop), filtered to just the
  //    event_keys we need (bounded memory — the response is the whole worldwide schedule), and write
  //    the terminal snapshot for each stranded match that has finished.
  let written = 0;
  for (const [start, cands] of byStart) {
    const wanted = new Set(cands.map((x) => x.eventKey));
    const fixtures = await fetchTennisFixtures(cfg, start, start, deps, wanted).catch(() => [] as Awaited<ReturnType<typeof fetchTennisFixtures>>);
    if (!fixtures.length) continue;
    const byKey = new Map(fixtures.map((f) => [f.eventKey, f]));
    for (const cand of cands) {
      const fx = byKey.get(cand.eventKey);
      if (!fx) continue; // not indexed for this window → leave stranded, retry next tick
      const terminal = fx.live !== 1 || TENNIS_TERMINAL_RE.test(fx.status ?? "");
      if (!terminal) continue; // schedule shift — still live → back to observation, do NOT settle
      R.insertTennisSnapshot(db, {
        event_key: fx.eventKey, provider: "apitennis-fixtures", batch_at: now, p1: fx.p1, p2: fx.p2,
        tournament: fx.tournament, event_type: fx.eventType, live: 0, status: fx.status ?? "Finished",
        sets_p1: fx.setsP1, sets_p2: fx.setsP2, set_num: fx.setNum, games_p1: fx.gamesP1, games_p2: fx.gamesP2,
        game_points: fx.gamePoints, server: fx.server, pm_match_id: cand.matchId, pm_mid_cents: null, pm_p1_cents: null, pm_p2_cents: null,
        raw: trimRaw(fx.raw),
      });
      R.insertTradeLog(db, { id: R.uid(), match_id: cand.matchId, strategy_id: TENNIS_STRATEGY, minute: "финал", type: "settle", text: `ре-сеттл: терминальный результат из fixtures (${fx.status ?? "Finished"}, сеты ${fx.setsP1 ?? "?"}-${fx.setsP2 ?? "?"}) — расчёт на след. шаге`, created_at: now });
      written++;
    }
  }
  return written;
}

/**
 * Settle open TENNIS bets from the scout's final result (NOT the app clock — tennis app
 * matches have no provider score). advances-wins / retirement / void. Observe-only guarded;
 * never throws into the tick. Returns bets settled.
 */
export function settleTennisBets(db: Database, deps: EngineDeps = {}): number {
  const now = nowFn(deps)();
  const shadowCfg = loadShadowConfig(db, deps.env);
  let settled = 0;
  const tennisMatchIds = new Set(R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id).map((m) => m.id)));
  for (const b of R.openBets(db)) {
    if (!TENNIS_STRATEGIES.has(b.strategy_id) || !tennisMatchIds.has(b.match_id)) continue;
    const fin = tennisFinalResult(db, b.match_id);
    if (!fin || !fin.finished) continue; // still live → leave open
    if (fin.manual) { flagTennisManual(db, b.id, b.match_id, b.strategy_id, b.market_label, now); continue; } // finished but winner unknown → flag, never guess
    const won = resolveTennisWinner(b.market_label, fin.p1, fin.p2, fin.advancing, fin.canceled);
    if (won == null) {
      // Void: canceled/ambiguous → refund the stake, zero P&L (excluded from accuracy).
      R.updateBet(db, b.id, { status: "settled_void", result: null, payout: b.stake ?? 0, closing_price: b.current_price ?? b.entry_price ?? null, settled_at: now, settled_by: "void" });
    } else {
      const patch = settleBet({ entry_price: b.entry_price, stake: b.stake }, won, b.entry_price ?? null);
      R.updateBet(db, b.id, { status: patch.status, result: patch.result, payout: patch.payout, closing_price: patch.closing_price, settled_at: now });
    }
    try { shadowOnExit(db, b.id, 1, shadowCfg, now); } catch { /* observe-only */ }
    R.insertTradeLog(db, { id: R.uid(), match_id: b.match_id, strategy_id: b.strategy_id, minute: "финал", type: "settle", text: `${b.market_label}: ${won == null ? "возврат (не сыграл/ретайр-неоднозначность)" : won ? "выигрыш" : "проигрыш"}${fin.retired ? " · ретайр" : ""}`, created_at: now });
    settled++;
  }
  return settled;
}

/**
 * Drive tennis app matches to `finished` once the scout reports the match over. Tennis app
 * matches have no provider score, so the clock drives them to `live` but nothing finishes
 * them — they'd pile up in `live` forever (starving the full cycle's prune) without this.
 * Returns matches finished. Observe-only guarded.
 */
/** Which side of the linked match this bet's winner-market label belongs to (by surname). */
function favSideForLabel(snap: R.TennisSnapshotRow, label: string): "first" | "second" | null {
  const toks = surnames(label);
  if (toks.some((t) => norm(snap.p1 ?? "").includes(t))) return "first";
  if (toks.some((t) => norm(snap.p2 ?? "").includes(t))) return "second";
  return null;
}

/**
 * token-fix-m1 QUARANTINE (one-time, marker-guarded). Flags every PRE-FIX tennis buyback bet
 * (Overreaction + Set-Value) that HELD THE WRONG OUTCOME's token — the favourite was the SECOND
 * moneyline outcome, but the old code always transacted outcomes[0]. Such a bet's take/exit P&L is
 * about the OPPONENT's token (the Mrva–Roncadelli "73¢ @ 25¢" class), so `tokenFlipPoisoned=true`
 * excludes it from every calibration/win-rate slice. Orientation is recomputed from the still-present
 * moneyline + last snapshot with the EXACT resolver the live path uses (favSideForLabel + firstIsP1)
 * — no drift. A bet whose orientation can't be reconstructed (moneyline/snapshots gone) is left to the
 * epoch break to exclude. Post-fix bets already store `favSide` and are skipped. Never throws into boot.
 */
export function migrateQuarantinePoisonedTennis(db: Database, now: string): number {
  if (R.metaGet(db, "migrate:tennis_token_flip_quarantine")) return 0;
  let flagged = 0;
  const bets = db.prepare(`SELECT * FROM bets WHERE strategy_id IN (?,?)`).all(TENNIS_STRATEGY, SET_VALUE_STRATEGY) as Bet[];
  for (const b of bets) {
    const em = parseEntryMeta(b.entry_meta);
    if (em?.favSide) continue;                    // post-fix bet: orientation already pinned & trusted
    if (em?.tokenFlipPoisoned != null) continue;  // already processed on a prior run
    const last = db.prepare(`SELECT * FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(b.match_id) as R.TennisSnapshotRow | undefined;
    if (!last?.p1 || !last?.p2) continue;          // players unrecoverable → leave to epoch segmentation
    const favSide = favSideForLabel(last, b.market_label);
    if (!favSide) continue;
    const ml = tennisMoneyline(db, b.match_id, { p1: last.p1, p2: last.p2 });
    if (!ml) continue;                             // moneyline gone → can't confirm; epoch already excludes it
    const favIsFirstOutcome = (favSide === "first") === ml.firstIsP1;
    if (favIsFirstOutcome) continue;               // held the RIGHT token (outcomes[0] == favourite) — clean
    // CONFIRMED: favourite was the SECOND outcome, but the old code held outcomes[0] → wrong token.
    R.updateBet(db, b.id, { entry_meta: serializeEntryMeta({ ...(em ?? {}), favSide, firstIsP1: ml.firstIsP1, tokenFlipPoisoned: true } as Partial<BetEntryMeta>) });
    flagged++;
  }
  R.metaSet(db, "migrate:tennis_token_flip_quarantine", `flagged=${flagged}`, now);
  return flagged;
}

/** Cash out an open tennis paper bet at the current price (mirrors football's closeBetEarly:
 *  payout = stake·current/entry, booked settled_by="early" so it's excluded from Brier/CLV —
 *  a trading realize, not a prediction outcome). §9.6: pure arithmetic, no LLM. A5: the log
 *  carries trigger, game score, receiving games played, decision-vs-execution slippage (0 on
 *  paper — decision price IS the fill), and the armed-threshold epoch. */
function closeTennisBetEarly(db: Database, betId: string, currentCents: number, trigger: string, reason: string, deps: EngineDeps, now: string, extra: { gameScore?: string; recvGames?: number } = {}, opts: { stale?: boolean } = {}): number | null {
  const fresh = R.getBet(db, betId);
  if (!fresh || fresh.status !== "open") return null; // already closed/settled → no double-close
  const stake = fresh.stake ?? 0, entry = fresh.entry_price ?? 0;
  const payout = entry > 0 ? Math.round(stake * (currentCents / entry) * 100) / 100 : 0;
  const pnl = Math.round((payout - stake) * 100) / 100;
  // A breakeven (pnl==0) is a PUSH — settled_void/result null — never a "win" (mirrors football's
  // closeBetEarly): booking it as won would inflate the strategy's win-rate on flat defensive cuts.
  const patch: any = { status: pnl > 0 ? "settled_won" : pnl < 0 ? "settled_lost" : "settled_void", result: pnl > 0 ? "won" : pnl < 0 ? "lost" : null, payout, closing_price: currentCents, settled_by: "early", settled_at: now };
  // §4.5 stale exit: executed at a MODELLED price (no live bid) → flag it ON the bet so analytics can
  // exclude this realization from calibration/win-rate slices (a stale defensive cut isn't a clean fill).
  if (opts.stale) patch.entry_meta = serializeEntryMeta({ ...(parseEntryMeta(fresh.entry_meta) ?? {}), exitStalePrice: true } as Partial<BetEntryMeta>);
  R.updateBet(db, betId, patch);
  try { shadowOnExit(db, betId, 1, loadShadowConfig(db, deps.env), now); } catch { /* observe-only */ }
  const epoch = fresh.strategy_id === SET_VALUE_STRATEGY ? SET_VALUE_EPOCH : TENNIS_ARMED_EPOCH;
  const tail = `геймы ${extra.gameScore ?? "?"}, приёмных ${extra.recvGames ?? 0}${opts.stale ? " · ⚠ по несвежей цене (stale)" : ""} · пороги:${epoch}`;
  R.insertTradeLog(db, { id: R.uid(), match_id: fresh.match_id, strategy_id: fresh.strategy_id, minute: fresh.entered_minute ?? "лайв", type: "exit", text: `${reason} @ ${currentCents}¢ · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} · ${tail} (${trigger})`, created_at: now });
  return pnl;
}

/** Partial fixation: close a FRACTION of an open tennis position (mirrors football's closeBetPortion).
 *  The closed slice is booked as a settled child (settled_by="partial", rationale carries the %),
 *  the open bet's stake shrinks by that slice, and the remainder rides to settle. §9.6: pure arithmetic.
 *  Returns the realized P&L on the slice, or null if the position is gone / already fully closed. */
function closeTennisBetPortion(db: Database, betId: string, fraction: number, currentCents: number, reason: string, deps: EngineDeps, now: string, opts: { attentionRemainder?: boolean } = {}): number | null {
  if (fraction >= 1) return closeTennisBetEarly(db, betId, currentCents, "take_price", reason, deps, now);
  const fresh = R.getBet(db, betId);
  if (!fresh || fresh.status !== "open") return null;
  const stake = fresh.stake ?? 0, entry = fresh.entry_price ?? 0;
  const closed = Math.round(stake * fraction * 100) / 100;
  if (closed <= 0 || entry <= 0) return closeTennisBetEarly(db, betId, currentCents, "take_price", reason, deps, now);
  const payout = Math.round(closed * (currentCents / entry) * 100) / 100;
  const pnl = Math.round((payout - closed) * 100) / 100;
  R.insertBet(db, {
    id: R.uid(), match_id: fresh.match_id, strategy_id: fresh.strategy_id, risk_profile_id: fresh.risk_profile_id ?? "medium",
    market_label: fresh.market_label, status: pnl > 0 ? "settled_won" : pnl < 0 ? "settled_lost" : "settled_void", proposed_price: fresh.proposed_price,
    entry_price: entry, current_price: currentCents, closing_price: currentCents, ai_prob: fresh.ai_prob, stake: closed,
    rationale: `частичная фиксация ${Math.round(fraction * 100)}%`, entered_minute: fresh.entered_minute,
    result: pnl > 0 ? "won" : pnl < 0 ? "lost" : null, payout, settled_by: "partial", settled_at: now, created_at: now,
  });
  // Shrink the parent to the remainder. On a PROTECTIVE partial (thin bid), flag the remainder
  // exitAttention so it's visible that a defensive exit only partially left and the rest awaits the
  // next tick's retry (never dumped below floor to force a full exit into a dry book).
  const remPatch: any = { stake: Math.round((stake - closed) * 100) / 100 };
  if (opts.attentionRemainder) remPatch.entry_meta = serializeEntryMeta({ ...(parseEntryMeta(fresh.entry_meta) ?? {}), exitAttention: true } as Partial<BetEntryMeta>);
  R.updateBet(db, betId, remPatch);
  try { shadowOnExit(db, betId, fraction, loadShadowConfig(db, deps.env), now); } catch { /* observe-only */ }
  const epoch = fresh.strategy_id === SET_VALUE_STRATEGY ? SET_VALUE_EPOCH : TENNIS_ARMED_EPOCH;
  const tailNote = opts.attentionRemainder ? `остаток под ⚠attention (retry след. тик)` : `остаток до финала`;
  R.insertTradeLog(db, { id: R.uid(), match_id: fresh.match_id, strategy_id: fresh.strategy_id, minute: fresh.entered_minute ?? "лайв", type: "exit", text: `${reason} @ ${currentCents}¢ · фиксация ${Math.round(fraction * 100)}% · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} · ${tailNote} · пороги:${epoch} (${opts.attentionRemainder ? "protective_partial" : "take_partial"})`, created_at: now });
  return pnl;
}

interface TennisSellCtx { poly: PolymarketConfig; bookCache: Map<string, OrderBookFetch> }
interface TennisSellQuote { exitCents: number; fromBook: boolean; filledFrac: number; note: string; stale: boolean; blocked?: "token_side_unavailable" | "token_orientation_mismatch" }

// ── token-fix-m1 RUNTIME INVARIANT — the belt behind the token fix (kept FOREVER) ───────────────
// Every consumer that re-derives orientation instead of reading it once is how the four orientation
// bugs happened; the token fix closes the last KNOWN consumer, and THIS check backstops the next
// unknown one. The CLOB token we are about to BUY/SELL must be the SIDE we reasoned & sized on:
// compare the token's live top-of-book to the expected side price. A flipped side sits at ~100−price
// (≈50¢ off, except near 50/50 where the two sides are genuinely indistinguishable and the damage is
// nil anyway); a coherent book is a few cents off (bid/ask + lag). Beyond tolerance → block + alert.
// This single check would have caught Mrva–Roncadelli on day one. Env-tunable, ~28¢ default.
const TOKEN_ORIENTATION_TOLERANCE_C = (() => { const n = Number(process.env.TOKEN_ORIENTATION_TOLERANCE_C); return Number.isFinite(n) && n > 0 ? n : 28; })();

// B8 exit slippage cap for a TAKE (Örgryte / dust-bid guard — a DIFFERENT mechanism from orientation).
// A take is OPTIONAL: never realize it into a bid that has slipped more than this below the (scout) price
// that triggered it — a dust/thin bid fills at a false-low price and books a phantom "profit" that never
// existed. Skip + retry; the recovery window is minutes and the take re-fires once a real bid returns.
// PROTECTIVE exits are NOT capped — a broken thesis must leave (thin bid → partial + attention). A normal
// bid/ask spread is a few cents (well under the cap); only a dust bid trips it. Env-tunable.
const TENNIS_EXIT_MAX_SLIP_C = (() => { const n = Number(process.env.TENNIS_EXIT_MAX_SLIP_CENTS); return Number.isFinite(n) && n > 0 ? n : 10; })();

/** The mismatch (token's top-of-book cents + gap) when the book is PRESENT and diverges beyond
 *  tolerance from the side we intend to transact — i.e. we're about to trade the wrong outcome.
 *  null when coherent, or when there's no live top-of-book to compare (left to the fill engine's own
 *  honest-skip, never force-blocked on a missing book). `side` picks ask (buy) vs bid (sell). */
function orientationMismatch(book: OrderBookFetch, side: "buy" | "sell", expectedSideCents: number | null): { tokenCents: number; gap: number } | null {
  const b = book.status === "ok" ? book.book : null;
  const px = side === "buy" ? b?.asks?.[0]?.priceCents : b?.bids?.[0]?.priceCents;
  if (px == null || expectedSideCents == null || !Number.isFinite(expectedSideCents)) return null;
  const gap = Math.abs(px - expectedSideCents);
  return gap > TOKEN_ORIENTATION_TOLERANCE_C ? { tokenCents: px, gap } : null;
}

/** Resolve a tennis EXIT price against the live moneyline BID book (sell-VWAP): sell the position's
 *  shares into bids, never asks. Execution model off → the midpoint (legacy paper, not "stale"). No
 *  live bid → the modelled/parametric price with stale=true (a defensive exit may use it flagged; a
 *  take must not). filledFrac<1 → the bid book is thin (partial exit → attention + retry). */
async function resolveTennisSell(db: Database, ctx: TennisSellCtx, b: Bet, players: { p1: string; p2: string }, favSide: "first" | "second", midCents: number, deps: EngineDeps): Promise<TennisSellQuote> {
  if (!ctx.poly.enabled) return { exitCents: midCents, fromBook: false, filledFrac: 1, note: "", stale: false }; // exec model off → midpoint (legacy)
  const ml = tennisMoneyline(db, b.match_id, players);
  // token-fix-m1: SELL the FAVOURITE's OWN winner token (what the position actually holds), resolved
  // via favSide — not blindly outcomes[0]. Unresolvable side token → BLOCK the exit (hold to settle),
  // never dump the wrong outcome. That mis-oriented sell was the Mrva–Roncadelli "73¢ @ 25¢" loss.
  const favToken = ml ? favTokenOf(ml, favSide) : null;
  if (!favToken) return { exitCents: midCents, fromBook: false, filledFrac: 0, note: "нет токена фаворита (token_second не сохранён) — держим до финала/бэкфилла", stale: true, blocked: "token_side_unavailable" };
  const entry = b.entry_price ?? 0, stake = b.stake ?? 0;
  const shares = entry > 0 ? stake / (entry / 100) : 0;
  const bookRes = await classifyOrderBook(favToken, ctx.poly, deps, ctx.bookCache);
  // RUNTIME INVARIANT (belt): the token's live BID must sit near the favourite price we're exiting at.
  // A flipped side bids at ~100−price → blocked before we can realize a loss on the opponent's token.
  const mm = orientationMismatch(bookRes, "sell", midCents);
  if (mm) return { exitCents: midCents, fromBook: false, filledFrac: 0, note: `бид токена ${mm.tokenCents}¢ vs ожидаемая сторона ${Math.round(midCents)}¢ (Δ${Math.round(mm.gap)}¢) — держим НЕ ТОТ исход`, stale: true, blocked: "token_orientation_mismatch" };
  const r = paperSellFill(bookRes, shares, stake, midCents, ml?.liquidity ?? 0, ctx.poly.exec);
  const filledFrac = r.requestedShares > 0 ? r.filledShares / r.requestedShares : 1;
  return { exitCents: r.cents, fromBook: r.fromBook, filledFrac, note: r.note ?? "", stale: !r.fromBook };
}

/** Route ONE tennis exit through the book (book-fill-m1). kind="take": a take that can't execute on a
 *  live bid is NOT fabricated — skip + retry next tick (a missed take is harmless; a fake one draws
 *  profit that never was). kind="protective": defensive exits MUST leave — full book fill; thin bid →
 *  sell what filled + remainder attention (retry, never dumped below floor); no bid → last-model price
 *  flagged stale + alert (§4.5). Returns 1 if it closed (fully or partially) this tick, else 0. */
async function execTennisExit(
  db: Database, ctx: TennisSellCtx, b: Bet, midCents: number, players: { p1: string; p2: string }, favSide: "first" | "second",
  trigger: string, reason: string, extra: { gameScore?: string; recvGames?: number }, deps: EngineDeps, now: string,
  o: { kind: "take" | "protective"; fraction?: number },
): Promise<number> {
  const sell = await resolveTennisSell(db, ctx, b, players, favSide, midCents, deps);
  const logSkip = (text: string) => R.insertTradeLog(db, { id: R.uid(), match_id: b.match_id, strategy_id: b.strategy_id, minute: b.entered_minute ?? "лайв", type: "skip", text, created_at: now });
  if (sell.blocked) {
    // token-fix-m1 FAIL-CLOSED: we cannot confirm the token is the side we hold → HOLD (never dump the
    // wrong outcome), and make it LOUD once per match+strategy. A take and a protective exit alike defer
    // to settle-by-label; that is strictly safer than realizing on the opponent's token. Backfill (or
    // the token fix on a fresh entry) clears it. One alert, then silent holds until state changes.
    const warned = R.tradeLogForMatch(db, b.match_id).some((l) => l.strategy_id === b.strategy_id && l.type === "skip" && (l.text ?? "").includes(sell.blocked!));
    if (!warned) logSkip(`⚠ ВЫХОД ЗАБЛОКИРОВАН (${sell.blocked}): ${sell.note} — ${b.market_label} · триггер ${trigger} отложен, позиция держится до финала`);
    return 0;
  }
  if (o.kind === "take") {
    if (sell.stale) { logSkip(`тейк отложен: нет живого бида (${sell.note || "стакан на продажу пуст"}) — позиция держится, повтор на след. тике (${trigger})`); return 0; }
    // B8 dust-bid guard: the take fired on the SCOUT price (midCents). If the live bid VWAP has slipped
    // far below it, the bid is dust — realizing here books a false-low take. Hold + retry (a take is
    // optional; the recovery window is minutes). Distinct from stale (no bid) and orientation (wrong token).
    const slipC = midCents - sell.exitCents;
    if (slipC > TENNIS_EXIT_MAX_SLIP_C) { logSkip(`тейк отложен: бид даёт ${sell.exitCents}¢, на ${Math.round(slipC)}¢ ниже цены триггера ${Math.round(midCents)}¢ (dust-бид > ${TENNIS_EXIT_MAX_SLIP_C}¢) — держим, повтор на след. тике (${trigger})`); return 0; }
    const eff = Math.min(o.fraction ?? 1, sell.filledFrac);
    if (eff >= 0.999) return closeTennisBetEarly(db, b.id, sell.exitCents, "take_price", reason, deps, now, extra) != null ? 1 : 0;
    return closeTennisBetPortion(db, b.id, eff, sell.exitCents, reason, deps, now) != null ? 1 : 0;
  }
  // protective
  if (sell.stale) { // §4.5: no live bid → last-model (stale) price, flagged + alert; the exit MUST leave
    logSkip(`⚠ ЗАЩИТНЫЙ ВЫХОД по несвежей цене: нет живого бида, ${trigger} исполнен по модели @ ${sell.exitCents}¢ (stale) — ${b.market_label}`);
    return closeTennisBetEarly(db, b.id, sell.exitCents, trigger, `${reason} · нет бида → по модели`, deps, now, extra, { stale: true }) != null ? 1 : 0;
  }
  if (sell.filledFrac >= 0.999) return closeTennisBetEarly(db, b.id, sell.exitCents, trigger, reason, deps, now, extra) != null ? 1 : 0;
  // thin bid → sell what filled, hold the remainder (attention + retry next tick), never dump below floor
  return closeTennisBetPortion(db, b.id, sell.filledFrac, sell.exitCents, `${reason} · бид тонкий (${Math.round(sell.filledFrac * 100)}%)`, deps, now, { attentionRemainder: true }) != null ? 1 : 0;
}

/**
 * §6 EXIT: deterministic close of open tennis buyback positions from the PRE-WRITTEN plan.
 * Runs every live tick. §9.6 — both the arithmetic AND the trigger detection are CODE, never
 * the LLM. Fixed priority (A4): a broken thesis / a collapse outranks profit-taking, so on a
 * simultaneous hit the DEFENSIVE exit wins:
 *   #1 retirement / match-finish → deferred to settleTennisBets (advancer/void, not a price exit).
 *   #2 thesis_stop        — a SECOND break of the favourite after entry: the recovery thesis broke.
 *   #3 catastrophic_floor — real (debounced) price ≤ entry−floor: a collapse, wide backstop.
 *   #4 game_count_stop    — ≥K receiving games since entry with NO break-back: edge lifetime spent.
 *   #5 take_price         — recovered to ≥ (pre-break − buffer): the buyback worked → realize.
 * Isolated + guarded; never throws into the tick. Returns positions closed.
 */
export async function tennisExitTick(db: Database, deps: EngineDeps = {}): Promise<number> {
  const now = nowFn(deps)();
  let closed = 0;
  // book-fill-m1: exits sell into the live BID book (VWAP), symmetric to entries. One book fetch per
  // token per tick (cached). Exec model off → midpoint (legacy paper, tests). §9.6 all deterministic.
  const sellCtx: TennisSellCtx = { poly: deps.polymarket ?? loadPolymarketConfig(deps.env ?? process.env), bookCache: new Map<string, OrderBookFetch>() };
  const tennisMatchIds = new Set(R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id).map((m) => m.id)));
  for (const b of R.openBets(db)) {
    if (!TENNIS_STRATEGIES.has(b.strategy_id) || !tennisMatchIds.has(b.match_id)) continue;
    // A4 #1: a finished/retired match is settleTennisBets' job (advancer wins / void) — never a price exit.
    if (tennisFinalResult(db, b.match_id)?.finished) continue;
    const snaps = db.prepare(`SELECT * FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at`).all(b.match_id) as R.TennisSnapshotRow[];
    if (!snaps.length) continue;
    const favSide = favSideForLabel(snaps[snaps.length - 1], b.market_label);
    if (!favSide) continue;
    const oppSide = favSide === "first" ? "second" : "first";
    const plan = parseEntryMeta(b.entry_meta)?.exitPlan as any;
    const entryMs = Date.parse(b.created_at) || 0;
    // Freshest AND previous favourite price (previous drives the floor debounce / phantom guard).
    const priceOn = (r: R.TennisSnapshotRow) => (favSide === "first" ? r.pm_p1_cents : r.pm_p2_cents);
    const priced = snaps.filter((s) => priceOn(s) != null);
    const curRow = priced[priced.length - 1] ?? null;
    // Current favourite price: freshest scout moneyline, else the stored moneyline (never a prop).
    const last = snaps[snaps.length - 1];
    const mlNow = (curRow ? priceOn(curRow) : null) == null ? tennisMoneyline(db, b.match_id, { p1: last.p1 ?? "", p2: last.p2 ?? "" }) : null;
    const cur = (curRow ? priceOn(curRow) : null) ?? (mlNow ? (favSide === "first" ? mlNow.p1Cents : mlNow.p2Cents) : null);
    if (cur == null) {
      // FAIL-CLOSED: a live stop with NO price must NOT execute at a phantom (entry) price — that
      // fabricates a "$0 breakeven" for what is really an in-the-red position. Skip the exit and make
      // the price-starvation LOUD (once per match+strategy) instead of closing silently in the dark.
      const warned = R.tradeLogForMatch(db, b.match_id).some((l) => l.strategy_id === b.strategy_id && l.type === "skip" && /цена недоступна/.test(l.text ?? ""));
      if (!warned) R.insertTradeLog(db, { id: R.uid(), match_id: b.match_id, strategy_id: b.strategy_id, minute: b.entered_minute ?? "лайв", type: "skip", text: `цена недоступна: живой манилайн не резолвится — стоп заморожен, выход отложен (позиция держится до появления цены/финала) — ${b.market_label}`, created_at: now });
      continue;
    }
    const prev = priced.length >= 2 ? priceOn(priced[priced.length - 2]) : null;
    // Post-entry events: receiving-game count (server = opponent) + break-back + a new favourite break.
    const evs = detectTennisEvents(snaps).filter((e) => (Date.parse(e.batchAt) || 0) > entryMs);
    const recvGames = evs.filter((e) => (e.type === "hold" || e.type === "break") && e.server === oppSide).length;
    const counterBreak = evs.some((e) => e.type === "break" && e.server === oppSide); // favourite broke opponent back
    // Game score for the exit log = the FRESHEST snapshot (current set/games), not the freshest
    // PRICED one — else a stale priced row prints the wrong set (e.g. "6-4" from set 1 while the
    // stop actually fires at 0-4 in set 2). `last` is always defined (snaps.length checked above).
    const gs = `${last.games_p1}-${last.games_p2}`;
    const ext = { gameScore: gs, recvGames };
    const players = { p1: last.p1 ?? "", p2: last.p2 ?? "" }; // for the book/token resolution on exit

    // ── SET-VALUE ladder (horizon = the match): retire → thesis_stop → floor → partial take ──
    // (retire/finish already handled above by the finished-continue.) Defensive exits outrank the
    // profit fixation; the partial take realizes HALF and holds the rest to resolution.
    if (b.strategy_id === SET_VALUE_STRATEGY) {
      // thesis_stop: the favourite was broken IN SET 2 after entry and did NOT break back within K
      // receiving games — not "any break", a break WITH NO RETURN (the comeback thesis is dead).
      const set2FavBreaks = evs.filter((e) => e.type === "break" && e.server === favSide && e.setNum === 2);
      const lastBk = set2FavBreaks[set2FavBreaks.length - 1];
      if (lastBk) {
        const bkMs = Date.parse(lastBk.batchAt) || 0;
        const after = evs.filter((e) => (Date.parse(e.batchAt) || 0) > bkMs);
        const recvAfter = after.filter((e) => (e.type === "hold" || e.type === "break") && e.server === oppSide).length;
        const brokeBack = after.some((e) => e.type === "break" && e.server === oppSide); // favourite broke opponent back
        const K = Number.isFinite(plan?.thesis_stop?.receiver_games) ? Number(plan.thesis_stop.receiver_games) : SET_VALUE_ARMED.thesisStopReceiverGames;
        if (!brokeBack && recvAfter >= K) {
          closed += await execTennisExit(db, sellCtx, b, cur, players, favSide, "thesis_stop", `стоп тезиса: брейк во 2-м сете без возврата за ${recvAfter} приёмных`, ext, deps, now, { kind: "protective" });
          continue;
        }
      }
      // catastrophic_floor — real collapse to ≤ floor, phantom-guarded by persistence (cur AND prev ≤ floor).
      const svFloor = Number.isFinite(plan?.catastrophic_floor?.at_cents) ? Number(plan.catastrophic_floor.at_cents) : null;
      if (svFloor != null && cur <= svFloor && prev != null && prev <= svFloor) {
        closed += await execTennisExit(db, sellCtx, b, cur, players, favSide, "catastrophic_floor", `катастрофический floor: коллапс к ${cur}¢ (≤${svFloor}¢, подтверждён)`, ext, deps, now, { kind: "protective" });
        continue;
      }
      // take_price — favourite recovered into the take band → fix HALF once, hold the rest to settle.
      const svTake = Number.isFinite(plan?.take_price?.at_cents) ? Number(plan.take_price.at_cents) : SET_VALUE_ARMED.takeLowCents;
      const frac = Number.isFinite(plan?.take_price?.fraction) ? Number(plan.take_price.fraction) : SET_VALUE_ARMED.takeFraction;
      const alreadyPartial = R.betsForMatch(db, b.match_id, SET_VALUE_STRATEGY).some((x) => x.settled_by === "partial" && (x.risk_profile_id ?? "medium") === (b.risk_profile_id ?? "medium") && x.market_label === b.market_label);
      if (cur >= svTake && !alreadyPartial) {
        closed += await execTennisExit(db, sellCtx, b, cur, players, favSide, "take_price", `тейк камбэка: фаворит вернулся к ${cur}¢ (цель ≥${svTake}¢)`, ext, deps, now, { kind: "take", fraction: frac });
        continue;
      }
      continue; // Set-Value handled — never fall through to the Overreaction ladder
    }

    // #2 thesis_stop — a NEW break of the FAVOURITE's serve after entry.
    if (evs.some((e) => e.type === "break" && e.server === favSide)) {
      closed += await execTennisExit(db, sellCtx, b, cur, players, favSide, "thesis_stop", `стоп тезиса: второй брейк фаворита — выход`, ext, deps, now, { kind: "protective" });
      continue;
    }
    // #3 catastrophic_floor — a real collapse to ≤ floor, phantom-guarded by PERSISTENCE: cur AND the
    // prior priced snapshot both ≤ floor, so a single artifact print can't dump the position (tennis
    // has a midpoint, not a raw bid — Örgryte lesson via debounce). Deliberately wide: game jitter
    // (±5-8¢) never reaches entry−15¢, only an injury/cascade does.
    const floorAt = Number.isFinite(plan?.catastrophic_floor?.at_cents) ? Number(plan.catastrophic_floor.at_cents) : null;
    if (floorAt != null && cur <= floorAt && prev != null && prev <= floorAt) {
      closed += await execTennisExit(db, sellCtx, b, cur, players, favSide, "catastrophic_floor", `катастрофический floor: коллапс к ${cur}¢ (≤${floorAt}¢, подтверждён)`, ext, deps, now, { kind: "protective" });
      continue;
    }
    // #4 game_count_stop — the favourite has played ≥K receiving games since entry with NO break-back.
    const K = Number.isFinite(plan?.game_count_stop?.receiver_games) ? Number(plan.game_count_stop.receiver_games) : TENNIS_GAME_COUNT_STOP;
    if (recvGames >= K && !counterBreak) {
      closed += await execTennisExit(db, sellCtx, b, cur, players, favSide, "game_count_stop", `стоп по геймам: ${recvGames} приёмных без брейка назад`, ext, deps, now, { kind: "protective" });
      continue;
    }
    // #5 take_price — recovered to the pre-written take level (pre-break − buffer).
    const takeAt = Number.isFinite(plan?.take_price?.at_cents) ? Number(plan.take_price.at_cents) : null;
    if (takeAt != null && cur >= takeAt) {
      closed += await execTennisExit(db, sellCtx, b, cur, players, favSide, "take_price", `тейк выкупа: фаворит вернулся к ${cur}¢ (цель ≥${takeAt}¢)`, ext, deps, now, { kind: "take", fraction: 1 });
      continue;
    }
  }
  return closed;
}

// Tennis has NO provider clock, so the SCOUT is authoritative for liveness: a match is in-play
// iff its newest LINKED snapshot says live=1 and is fresh. A generous stale window absorbs normal
// scheduler gaps without churning state; a real outage (scout silent) correctly reads not-live.
const TENNIS_SCOUT_STALE_MIN = (() => { const n = Number(process.env.TENNIS_SCOUT_STALE_MIN); return Number.isFinite(n) && n > 0 ? n : 15; })();
export function tennisScoutInPlay(db: Database, matchId: string, nowMs: number, staleMin = TENNIS_SCOUT_STALE_MIN): boolean {
  const r = db.prepare(`SELECT live, batch_at FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(matchId) as { live?: number; batch_at?: string } | undefined;
  if (!r || r.live !== 1) return false;
  const age = nowMs - (Date.parse(r.batch_at ?? "") || 0);
  return age <= staleMin * 60_000;
}

// ── Observability: the entry funnel (read-only; reconstructs the tick's own gates) ──
// The tick's skips are mostly SILENT (no_favourite / thin_book / no_break / underdog_broken /
// out_of_window / price_far go to app_meta, not the trade log), so from the UI a running-but-
// selective loop looks identical to a dead one. This recomputes each live tennis match's funnel
// stage from current state so you can SEE it's alive and WHY it's holding fire. Pure read.
export interface TennisFunnelRow { match: string; comp: string; stage: string; note: string }
export interface TennisFunnel {
  liveApp: number; linked: number; withFavourite: number; tradeable: number; withBreak: number; favBreak: number; gatePass: number;
  openPositions: number; entriesAllTime: number;
  actionMarkers: Record<string, number>;
  perMatch: TennisFunnelRow[];
  recentLog: { at: string; type: string; text: string }[];
  note: string;
}
export function buildTennisFunnel(db: Database): TennisFunnel {
  const f: TennisFunnel = { liveApp: 0, linked: 0, withFavourite: 0, tradeable: 0, withBreak: 0, favBreak: 0, gatePass: 0, openPositions: 0, entriesAllTime: 0, actionMarkers: {}, perMatch: [], recentLog: [], note: "" };
  const tennisMatches = R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id).map((m) => ({ comp: c.id, m })));
  for (const { comp, m } of tennisMatches) {
    for (const b of R.betsForMatch(db, m.id, TENNIS_STRATEGY)) { f.entriesAllTime++; if (b.status === "open") f.openPositions++; }
    if (m.state !== "live") continue;
    f.liveApp++;
    const label = `${m.home} — ${m.away}`;
    const snaps = db.prepare(`SELECT * FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at`).all(m.id) as R.TennisSnapshotRow[];
    // The tick joins scout snapshots by pm_match_id; a live app match the scout hasn't LINKED
    // (fuzzy map didn't reach "auto", or the scout isn't seeing it in-play) is invisible to the
    // tick — surface it here instead of dropping it silently. This is the true coverage blocker.
    if (snaps.length < 2) { f.perMatch.push({ match: label, comp, stage: "no_scout_link", note: "нет привязанных снапшотов скаута — маппинг не сошёлся или скаут не видит матч live" }); continue; }
    f.linked++;
    const row = (stage: string, note = ""): void => { f.perMatch.push({ match: label, comp, stage, note }); };
    const last = snaps[snaps.length - 1];
    const brF = detectBreaks(snaps).slice(-1)[0];
    // Same as the tick: identify the favourite off the MATCH-START (pre-match) price, so neither a
    // live panic nor a completed set flips who reads as favourite.
    const charge = chargeTennisMatch(db, m.id, { p1: last.p1 ?? "", p2: last.p2 ?? "" }, startPrices(db, m.id));
    if (charge.outOfScope) { row("out_of_scope", charge.bookNote); continue; } // ITF/Challenger/doubles — named, not silently mislabelled thin_book
    if (!charge.favSide) { row("no_favourite", "обе стороны > порога андердога"); continue; }
    f.withFavourite++;
    if (!charge.tradeable) { row("thin_book", charge.bookNote); continue; }
    f.tradeable++;
    const br = brF;
    if (!br) { row("no_break_yet", `фаворит ${charge.favSide} @ ${charge.favPriceCents}¢`); continue; }
    f.withBreak++;
    if (br.server !== charge.favSide) { row("underdog_broken", `сломан андердог в сете ${br.setNum} — не наш сетап`); continue; }
    f.favBreak++;
    const brSnap = snaps.find((s) => s.batch_at === br.batchAt) ?? last;
    const favSetsLost = (charge.favSide === "first" ? brSnap.sets_p2 : brSnap.sets_p1) ?? 0;
    const favPrice = favPriceFromScout(db, m.id, charge.favSide);
    if (!tennisReassessShouldCall(charge, { brokenSide: br.server, setNum: br.setNum, favSetsLost, favPriceCents: favPrice })) {
      const earlyWindow = br.setNum <= 1 || (br.setNum === 2 && favSetsLost === 0);
      row(!earlyWindow && favSetsLost < 1 ? "out_of_window" : "price_far", `фаворит @ ${favPrice}¢, сет ${br.setNum}, проиграно сетов ${favSetsLost}`);
      continue;
    }
    f.gatePass++;
    const acted = R.metaGet(db, ACTED + m.id + ":" + br.batchAt);
    const hasOpen = R.betsForMatch(db, m.id, TENNIS_STRATEGY).some((b) => b.status === "open");
    row(hasOpen ? "has_open_position" : acted ? `acted:${acted}` : "armed→LLM", `фаворит @ ${favPrice}¢, сет ${br.setNum}`);
  }
  // Cumulative per-break action markers (decided / gate_skip / no_market / blocked_second_buyback).
  for (const r of R.metaByPrefix(db, ACTED)) f.actionMarkers[r.value] = (f.actionMarkers[r.value] ?? 0) + 1;
  f.recentLog = R.recentTradeLog(db, 300).filter((l) => l.strategy_id === TENNIS_STRATEGY).slice(0, 15).map((l) => ({ at: l.created_at, type: l.type, text: l.text }));
  const unlinked = f.liveApp - f.linked;
  f.note = f.entriesAllTime > 0
    ? `${f.entriesAllTime} входов всего (${f.openPositions} открыто); live ${f.liveApp} (привязано ${f.linked}), на взводе ${f.gatePass}`
    : unlinked > 0 && f.linked === 0
      ? `live ${f.liveApp}, но НИ ОДИН не привязан к скауту (${unlinked} no_scout_link) — маппинг/скаут не покрывает текущие live-матчи, поэтому тик их не видит`
      : f.gatePass > 0
        ? `${f.gatePass}/${f.linked} привязанных live-матчей на взводе — вход на следующем тике (или уже acted)`
        : `live ${f.liveApp} (привязано ${f.linked}), 0 на взводе — воронка жива, сетап ещё не совпал (см. perMatch)`;
  return f;
}

export function tennisFunnelMarkdown(f: TennisFunnel): string {
  const L: string[] = [];
  L.push(`# Теннис — воронка входа (live)`);
  L.push(f.note);
  L.push(`\n## Ступени сейчас`);
  L.push(`live ${f.liveApp} → привязано к скауту ${f.linked} → с фаворитом ${f.withFavourite} → торгуемых ${f.tradeable} → с брейком ${f.withBreak} → брейк фаворита ${f.favBreak} → прошло гейт ${f.gatePass}`);
  L.push(`открытых позиций ${f.openPositions} · входов всего ${f.entriesAllTime}`);
  const am = Object.entries(f.actionMarkers);
  if (am.length) L.push(`\n## Маркеры решений (накоплено): ${am.map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  if (f.perMatch.length) {
    L.push(`\n## По матчам (где отваливается)`);
    L.push(`| матч | ступень | детали |`);
    L.push(`|---|---|---|`);
    for (const r of f.perMatch) L.push(`| ${r.match} | ${r.stage} | ${r.note} |`);
  }
  if (f.recentLog.length) {
    L.push(`\n## Последние действия`);
    for (const l of f.recentLog) L.push(`- ${l.at.slice(11, 19)} · ${l.type} · ${l.text}`);
  }
  return L.join("\n");
}

export function finishTennisMatches(db: Database, deps: EngineDeps = {}): number {
  const now = nowFn(deps)();
  let n = 0;
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    for (const m of R.listMatches(db, c.id)) {
      if (m.state === "finished") continue;
      const fin = tennisFinalResult(db, m.id);
      if (fin?.finished && !fin.manual) { try { R.updateMatch(db, m.id, { state: "finished", end_time: now }); n++; } catch { /* best-effort */ } } // a manual (winner-unknown) match stays live + visible until resolved
    }
  }
  return n;
}


/** The favourite's current winner price (cents) for the linked match, using the last scout snapshot. */
function favPriceFromScout(db: Database, matchId: string, favSide: "first" | "second"): number | null {
  const r = (db.prepare(`SELECT pm_p1_cents,pm_p2_cents FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(matchId) as any) ?? null;
  if (!r) return null;
  return favSide === "first" ? r.pm_p1_cents : r.pm_p2_cents;
}

export interface TennisChargeInfo extends TennisCharge { matchId: string; tradeable: boolean; outOfScope: boolean; bookNote: string }

/**
 * DETERMINISTIC charge for one mapped tennis match: identify the favourite by the winner
 * prices, arm the interim triggers, and gate tradeability on winner-book depth ≥ threshold
 * on BOTH sides. Pure enough to unit-test with an injected market list.
 *
 * SINGLE-SOURCE SCOPE GATE: this is the one chokepoint EVERY tennis money path funnels through
 * (both entry ticks + the funnel), so the "ATP/WTA singles only" rule lives HERE, once. A comp
 * out of scope (ITF / Challenger / doubles — budget-0 dust class, thesis invalid, thin jumpy
 * books) is marked outOfScope and forced NOT tradeable — no strategy can trade it, whoever asks.
 */
export function chargeTennisMatch(db: Database, matchId: string, players: { p1: string; p2: string }, idPrices?: { p1: number | null; p2: number | null }): TennisChargeInfo {
  const ml = tennisMoneyline(db, matchId, players); // the WINNER market, resolved by structure (never a prop)
  // Favourite ID prefers the PRE-BREAK moneyline price: a live break panics the favourite toward the
  // underdog threshold, which would erase the favourite exactly when the buyback should fire. Fall
  // back to the stored moneyline. No moneyline at all → no favourite (honest skip; caller logs).
  let charge = chargeTennisTriggers({ p1Cents: idPrices?.p1 ?? null, p2Cents: idPrices?.p2 ?? null });
  if (!charge.favSide) charge = chargeTennisTriggers({ p1Cents: ml?.p1Cents ?? null, p2Cents: ml?.p2Cents ?? null });
  const match = R.getMatch(db, matchId);
  const comp = match ? R.listCompetitions(db).find((c) => c.id === match.competition_id) : null;
  const outOfScope = !comp || tennisTourOf(comp) == null; // ATP/WTA singles only — the ONE scope decision
  const liq = ml?.liquidity ?? 0; // ONE moneyline book (not per-prop)
  const tradeable = !outOfScope && !!ml && liq >= TENNIS_MIN_BOOK_USD;
  const bookNote = outOfScope
    ? `вне скоупа: «${comp?.name ?? comp?.id ?? "?"}» — не ATP/WTA сингл (ITF/Challenger/пары не торгуем)`
    : `манилайн ${ml ? `«${ml.label}»` : "НЕ НАЙДЕН"} · книга $${Math.round(liq)} (порог $${TENNIS_MIN_BOOK_USD})`;
  return { ...charge, matchId, tradeable, outOfScope, bookNote };
}

/** Build the decision-time entry_meta for a tennis paper bet. */
export function tennisEntryMeta(o: { favPrice: number; prePrice: number; edge: number; kelly: number; stake: number; thinnessUsd: number | null; setNum: number; favSide?: "first" | "second" | null; firstIsP1?: boolean | null; panicDropCents?: number | null; panicThresholdCents?: number | null }): BetEntryMeta {
  return {
    phase: "live", minute: null, scoreHome: null, scoreAway: null,
    favSide: o.favSide ?? null, firstIsP1: o.firstIsP1 ?? null, // token-fix-m1: pin the held outcome so the exit sells the SAME token it bought
    panicDropCents: o.panicDropCents ?? null, panicThresholdCents: o.panicThresholdCents ?? null, // B6: freeze the depth gate that admitted this bet
    edge: Math.round(o.edge * 1000) / 1000, aiProb: Math.round((o.prePrice / 100) * 1000) / 1000, derivedProb: null,
    marketPrice: o.favPrice, impliedProb: Math.round((o.favPrice / 100) * 1000) / 1000, liveProbAdjusted: null,
    kellyFraction: Math.round(o.kelly * 1000) / 1000, sizeRequested: Math.round(o.stake * 100) / 100, sizeFilled: null, entrySlipCents: null,
    calibration: null, branchWeightSum: null, phantomCheck: null, marketThinnessUsd: o.thinnessUsd,
    winsOnEvent: false, exitPlan: {
      take_price: { at_cents: o.prePrice - TENNIS_TAKE_BUFFER, note: "возврат к предбрейковой минус запас" },
      thesis_stop: "второй брейк подряд / признаки ретайра",
      game_count_stop: { receiver_games: TENNIS_GAME_COUNT_STOP }, // A1: main stop — K receiving games, no break-back
      catastrophic_floor: { at_cents: o.favPrice - TENNIS_CATASTROPHIC_FLOOR }, // A2: wide backstop for a collapse
      armed_epoch: TENNIS_ARMED_EPOCH,
    },
    models: { analysis: null, strategist: null },
  };
}

// PER-PROFILE paper budget for a tennis Overreaction position: each risk profile trades the
// same setup side-by-side against its OWN budget (comps stay budget-0 so the football engine
// never touches tennis; this loop owns tennis sizing). $1k each. Env-tunable.
const TENNIS_PAPER_BUDGET = (() => { const n = Number(process.env.TENNIS_PAPER_BUDGET_USD); return Number.isFinite(n) && n > 0 ? n : 1000; })();

const ACTED = "tennis_acted:"; // per (match, break) idempotency marker

// Recovery-take buffer (¢): the take fires when the favourite climbs back to within this many
// cents of its pre-break price — the buyback has paid off, realize it. STRUCTURAL/interim; the
// only numbers that swap in from the §4 distribution are the ENTRY armed prices, not this. Env-tunable.
const TENNIS_TAKE_BUFFER = (() => { const n = Number(process.env.TENNIS_TAKE_BUFFER_CENTS); return Number.isFinite(n) && n >= 0 ? n : 3; })();
// A1 game-count stop (the strategy's MAIN stop): exit after the favourite has played this many
// RECEIVING games since entry without a break-back. Back to the INTERIM 3: the 105 marks that once
// set this to 2 were measured on PROP prices, not the moneyline (see BACKLOG "price layer = the
// MONEYLINE"), so they're discarded — the moneyline panic/recovery amplitude is almost certainly
// different and must re-accumulate before this tightens again. Env-tunable.
const TENNIS_GAME_COUNT_STOP = (() => { const n = Number(process.env.TENNIS_GAME_COUNT_STOP); return Number.isFinite(n) && n > 0 ? Math.round(n) : 3; })();
// A2 catastrophic floor (¢ below entry): a BACKSTOP, not a working stop. Deliberately WIDE so it
// never catches game jitter (±5-8¢ on a deuce), only a collapse (injury/cascade) before the second
// break. Held at 15¢: the §4 marks measure pre-break→floor (the panic amplitude), NOT
// further-collapse-below-ENTRY (we enter near the floor already), so they don't cleanly set this
// backstop — 15¢ of further collapse stays a sound structural cut, price-layer-independent. Env-tunable.
const TENNIS_CATASTROPHIC_FLOOR = (() => { const n = Number(process.env.TENNIS_CATASTROPHIC_FLOOR_CENTS); return Number.isFinite(n) && n > 0 ? n : 15; })();
// Armed-threshold epoch. Reset to "interim": the 105 calibration marks were measured on PROP prices
// (winnerMarketFor grabbed the closest prop, not the moneyline) and are discarded. Thresholds return
// to interim until ~100 marks re-accumulate on the MONEYLINE. Exits carry this so bets stay
// segmentable by which era's thresholds fired. Env-tunable.
// EPOCH BREAK — book-fill-m1: from here tennis entries fill against the LIVE order book
// (VWAP / honest skip), not the old 0¢/quote shortcut. Pre-book-fill-m1 tennis marks were
// priced in a different world (fabricated 0¢ fills, exits at entry price — the Travaglia bug)
// and are INCOMPARABLE: no cross-epoch aggregates. Old tennis stats are diagnostic, not
// calibration (build notes). Env-tunable if a later recalibration needs a fresh tag.
// EPOCH BREAK — token-fix-m1: entries/exits now transact the FAVOURITE's OWN winner token (favTokenOf),
// backed by the runtime orientation invariant. Pre-token-fix tennis bets where the favourite was the
// SECOND moneyline outcome HELD THE WRONG TOKEN — their take/exit P&L is about the opponent's token and
// is INCOMPARABLE (quarantined by migrateQuarantinePoisonedTennis). Fresh tag → no cross-epoch aggregates.
const TENNIS_ARMED_EPOCH = process.env.TENNIS_ARMED_EPOCH || "token-fix-m1";

// ⛔ PARKED — tennis Overreaction (early-break favourite buyback) has NO tradeable edge (verdict
// no_go, 2026-07). The Step-1 armed-cohort diagnostic (GET /api/tennis-scout?report=ovr_cohort,
// buildTennisOverreactionCohort) measured the favourite-broken-early moneyline cohort and found the
// TRADE DOESN'T EXIST: a clear favourite (pre ~77¢) barely dips on an early break — floor p60 = 73.5¢,
// take (pre−3) = 74.5¢ → upside 1¢, while the tail stop (pre − slide p90) sits at 59.5¢ → downside 14¢.
// Breakeven 93.3% (honest, from that 1:14 geometry); actual recovery only 40.8% (ATP 35.2% / WTA 43.5%
// / band 55-60¢ 24.3% — all agree, n=265). The moneyline prices an early favourite break EFFICIENTLY;
// there is no overreaction to buy back. So entries are OFF. Break-mark collection STAYS (it feeds
// Set-Value's late-break amplitudes and would re-power any FUTURE hypothesis). DO NOT re-enable on a
// hunch — a return to this idea requires a NEW hypothesis + a NEW go/no-go criterion fixed BEFORE the
// data + a FRESH sample (re-parametrising p60/take on THIS dataset would be curve-fitting).
//
// SCOPE — this verdict is ONLY the early-break favourite BUYBACK. It is NOT a verdict on tennis:
//   • Set-Value (tennisSetValue.ts) — deeper/later panic (favourite LOST set 1), amplitudes 7-11¢ vs
//     the ~3.5¢ early dip — is a SEPARATE, still-ACTIVE tennis hypothesis. No verdict yet: its
//     criterion (n≥30 clean cycles on token-fix-m1, verdict by CLV+win+P&L agreement) isn't reached.
//     Today's "a deep dip is more often a real shift than an overreaction" is a legitimate PRIOR/
//     headwind for it too — but a prior is NOT a verdict; verdict-transfer between strategies is
//     forbidden in BOTH directions. Its data decides it.
//   • Football Overreaction is UNAFFECTED — different sport, different market, edge proven on its own
//     data (n=36, metric agreement). Different market ≠ transferable verdict.
// Default PARKED. Read per-call from the tick's env so it's testable (entry-mechanics tests opt in
// with TENNIS_OVR_PARKED="false"); prod leaves it unset → parked.
export const tennisOvrParked = (env: Record<string, string | undefined>): boolean => (env.TENNIS_OVR_PARKED ?? "true").toLowerCase() !== "false";

// Entry-order lifetime (spec §2.2: the live-panic window). Paper fills/skips immediately, so TIF is
// carried only so the field is real for dry-run/real later.
const TENNIS_ENTRY_TIF_SEC = 45;

// Skip-reason → eyeball gloss for the tennis entry log. The MACHINE tag (ack.reason) is what the
// coverage-map / thin-map counters read; this text is only for a human scanning the log.
const TENNIS_SKIP_KIND: Record<string, string> = {
  untradeable_market: "пусто/плейсхолдер — торговать нечем (никогда)",
  orderbook_unavailable: "нет предложений в стакане (транзиентно)",
  no_edge: "глубина есть, но слиппедж съел эдж",
  phantom: "фантом/устаревшая книга",
};

/** Route a tennis entry through the shared book-fill engine (epoch book-fill-m1): no fabricated 0¢
 *  fills. Returns the executor ack — caller inserts the bet on a fill (at the REAL price/size) or
 *  logs the TYPED no_book_liquidity skip. One decisionId per profile bet = its twin-link to a future
 *  real order (so two profiles never share a clientOrderId). */
async function fillTennisEntry(executor: PaperExecutor, decisionId: string, o: { token: string | null; entryCents: number; sizeUsd: number; fairProbPct: number; strategyId: string; profileId: string; matchId: string }): Promise<OrderAck> {
  return executor.place({
    clientOrderId: clientOrderIdFor(decisionId, "entry"), leg: "entry", tokenId: o.token ?? "", side: "BUY",
    limitPriceCents: o.entryCents, sizeUsd: o.sizeUsd, timeInForceSec: TENNIS_ENTRY_TIF_SEC,
    decisionId, strategyId: o.strategyId, profileId: o.profileId, matchId: o.matchId, fairValueCents: o.fairProbPct,
  });
}

/** The favourite's winner price just BEFORE a break (the recovery target reference). */
function prePriceBefore(db: Database, matchId: string, favSide: "first" | "second", breakBatch: string): number | null {
  const r = db.prepare(`SELECT pm_p1_cents,pm_p2_cents FROM tennis_snapshots WHERE pm_match_id=? AND batch_at < ? AND ${favSide === "first" ? "pm_p1_cents" : "pm_p2_cents"} IS NOT NULL ORDER BY batch_at DESC LIMIT 1`).get(matchId, breakBatch) as any;
  return r ? (favSide === "first" ? r.pm_p1_cents : r.pm_p2_cents) : null;
}

/**
 * §6 PAPER entry: on a fresh BREAK of the favourite that the pre-LLM gate passes, ask the
 * strategist ONLY the real_shift question; if it's an overreaction, open a CODE-sized paper
 * bet on the favourite's winner market with the pre-written recovery exit. Isolated + guarded;
 * never throws into the tick. Returns entries opened.
 */
export async function tennisTradingTick(db: Database, deps: EngineDeps = {}): Promise<number> {
  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  const strat = getStrategy(db, TENNIS_STRATEGY);
  if (!strat) return 0; // strategy not seeded → tennis trading off
  // PARKED (no_go, ovr_cohort — see TENNIS_OVR_PARKED): place NO entries. Break-mark collection
  // (recordTennisBreakMarks) runs on a SEPARATE tick and is untouched, so Set-Value still gets its
  // amplitudes and a future re-test keeps its data. Exits/settlement of any already-open positions
  // also run on their own ticks (tennisExitTick / settleTennisBets), so parked positions wind down.
  if (tennisOvrParked(env)) return 0;
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  // Stamp the armed-threshold epoch INTO the bet's code_version so the showcase (which segments
  // by code_version) hard-separates interim from calibrated tennis bets — the same epoch discipline
  // that let the 247-football-bet analysis drop a broken era. Every bet from here reads «…·interim»
  // (the prop-priced calibration was discarded); it becomes «…·calibrated» once the moneyline marks land.
  const codeVer = `${effectiveCodeVersion(db)}·${TENNIS_ARMED_EPOCH}`;
  const shadowCfg = loadShadowConfig(db, deps.env);
  // book-fill-m1: entries fill against the LIVE book via the shared engine (one book fetch per token
  // per tick, cached). No book / no edge / phantom → honest skip, never a fabricated 0¢ fill.
  // Shared poly + book cache: the orientation invariant fetches the favourite token's book once and
  // the executor reuses that same cached fetch when it fills — no double network hit per entry.
  const poly = deps.polymarket ?? loadPolymarketConfig(env);
  const bookCache = new Map<string, OrderBookFetch>();
  const executor = new PaperExecutor({ poly, deps, bookCache, nowMs: () => nowMs });
  // B6: per-profile minimum panic depth (quantiles of the in-scope early-break distribution), resolved
  // ONCE per tick — the same thresholds gate every match this tick and are frozen on each bet.
  const panicTh = tennisPanicThresholds(db);
  let opened = 0;

  const tennisMatches = R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id).map((m) => ({ comp: c.id, m })));
  for (const { comp, m } of tennisMatches) {
    if (m.state === "finished") continue;
    // (ITF/Challenger/doubles scope is enforced ONCE inside chargeTennisMatch via charge.tradeable=false.)
    // Latest scout snapshots for this mapped match.
    const snaps = db.prepare(`SELECT * FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at`).all(m.id) as R.TennisSnapshotRow[];
    if (snaps.length < 2) continue;
    const players = { p1: snaps[snaps.length - 1].p1 ?? "", p2: snaps[snaps.length - 1].p2 ?? "" };
    const breaks = detectBreaks(snaps);
    if (!breaks.length) continue;
    // Favourite / moneyline / token are per-MATCH (break-independent), so resolve them ONCE before
    // choosing which break to act on. Favourite ID is off the MATCH-START (pre-match) price — NOT a
    // per-break price: a per-break reference re-identifies the favourite every break, so after the
    // pre-match favourite loses a set the current set-leader (the pre-match underdog) gets mislabelled
    // "the favourite" and bought back against its inflated set-lead price (the −$93 Barrera flip).
    const charge = chargeTennisMatch(db, m.id, players, startPrices(db, m.id));
    if (!charge.favSide || !charge.tradeable) continue; // no favourite / thin book → skip
    const favName = charge.favSide === "first" ? players.p1 : players.p2;
    // Trade the MONEYLINE (winner market). The bet's market_label is the FAVOURITE'S NAME so settle's
    // resolveTennisWinner matches it to the advancing player. No moneyline → HONEST skip (never a prop).
    const ml = tennisMoneyline(db, m.id, players);
    if (!ml) {
      const warned = R.tradeLogForMatch(db, m.id).some((l) => l.strategy_id === TENNIS_STRATEGY && l.type === "skip" && (l.text ?? "").includes("no_moneyline"));
      if (!warned) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: "лайв", type: "skip", text: `манилайн не найден (только пропы / неоднозначно) — вход пропущен (no_moneyline)`, created_at: now });
      continue;
    }
    // token-fix-m1: the buyback trades the FAVOURITE's OWN winner token (resolved via favSide), NOT
    // blindly outcomes[0]. Side token not persisted yet (market imported before token_second) → HONEST
    // skip; re-discovery backfills token_second, next tick retries.
    const favToken = favTokenOf(ml, charge.favSide);
    if (!favToken) {
      const warned = R.tradeLogForMatch(db, m.id).some((l) => l.strategy_id === TENNIS_STRATEGY && l.type === "skip" && (l.text ?? "").includes("token_side_unavailable"));
      if (!warned) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: "лайв", type: "skip", text: `token_side_unavailable: токен стороны фаворита ещё не сохранён (token_second) — вход отложен до ре-дискавери`, created_at: now });
      continue;
    }
    const favMlPrice = charge.favSide === "first" ? ml.p1Cents : ml.p2Cents;
    const favPrice = favPriceFromScout(db, m.id, charge.favSide);

    // B1: examine EVERY not-yet-acted break, FRESHEST first — a later underdog break or an out-of-window
    // break must NOT bury an earlier qualifying favourite EARLY break (the setup). Act on the freshest
    // qualifying one (the live panic); an older break whose price already recovered self-rejects at
    // sizing. One decision per match per tick; non-qualifying breaks are marked so we don't re-scan them.
    let br: (typeof breaks)[number] | null = null;
    let favSetsLost = 0;
    for (const cand of [...breaks].reverse()) {
      if (R.metaGet(db, ACTED + m.id + ":" + cand.batchAt)) continue; // already decided this break
      const cSnap = snaps.find((s) => s.batch_at === cand.batchAt) ?? snaps[snaps.length - 1];
      const cLost = charge.favSide === "first" ? (cSnap.sets_p2 ?? 0) : (cSnap.sets_p1 ?? 0);
      if (!tennisReassessShouldCall(charge, { brokenSide: cand.server, setNum: cand.setNum, favSetsLost: cLost, favPriceCents: favPrice })) {
        R.metaSet(db, ACTED + m.id + ":" + cand.batchAt, "gate_skip", now); continue; // underdog / out-of-window / priced-out
      }
      br = cand; favSetsLost = cLost; break; // freshest qualifying favourite early break
    }
    if (!br) continue; // no qualifying unacted break this tick
    const prePrice = prePriceBefore(db, m.id, charge.favSide, br.batchAt) ?? favMlPrice;
    // Carle guard: re-check at TRIGGER time that the favourite is STILL a favourite. The pre-break
    // reference is the recovery target; if it has drifted to a coin-flip (frozen/levelled favourite),
    // there's nothing favoured to snap back to → skip (not an overreaction setup). The pre-break price
    // is historical/fixed, so mark the break decided — it won't retroactively become favoured.
    if (prePrice < TENNIS_MIN_PREBREAK_FAV_CENTS) {
      R.metaSet(db, ACTED + m.id + ":" + br.batchAt, "frozen_favourite", now);
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `фаворит не был фаворитом на момент брейка: предбрейк ${prePrice}¢ < порога ${TENNIS_MIN_PREBREAK_FAV_CENTS}¢ (замороженный/сравнявшийся фаворит) — не сетап переоценки (frozen_favourite)`, created_at: now });
      continue;
    }

    // A3 (per profile): each risk profile holds at most ONE buyback per match — no "докупка в
    // падающую" WITHIN a profile — but the profiles run SIDE-BY-SIDE, each on its OWN $1k budget,
    // so they're compared like the football grid. Pre-LLM: only skip the whole break if EVERY
    // profile already holds a buyback here (saves the call); otherwise ask ONCE, size per profile.
    const profiles = (() => { const ps = R.listRiskProfiles(db).map((p) => p.id); return ps.length ? ps : RISK_PROFILE_DEFS.map((d) => d.id); })();
    // Cross-strategy one-position rule (symmetric with Set-Value): a profile holding ANY open tennis
    // buyback on this match — Overreaction OR Set-Value — is not free. (Was TENNIS_STRATEGY-only, so
    // Overreaction ignored a Set-Value hold and could take the OPPOSITE side of the same 2-outcome
    // market = long both players, guaranteed vig bleed.)
    const heldProfiles = new Set(R.betsForMatch(db, m.id).filter((b) => TENNIS_STRATEGIES.has(b.strategy_id) && b.status === "open").map((b) => b.risk_profile_id));
    const freeProfiles = profiles.filter((p) => !heldProfiles.has(p));
    if (!freeProfiles.length) {
      R.metaSet(db, ACTED + m.id + ":" + br.batchAt, "blocked_second_buyback", now);
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `второй выкуп заблокирован — все профили уже держат теннисную позицию по матчу (blocked_second_buyback)`, created_at: now });
      continue;
    }

    // LLM judges ONLY real_shift (overreaction vs collapse) — ONCE, shared across profiles (Model-A
    // dedup: the real_shift question is risk-appetite-independent; only the SIZE differs per profile).
    const dec = await strategistDecide({
      strategyName: strat.name, strategyPrompt: strat.prompt_live ?? strat.prompt,
      match: { home: players.p1, away: players.p2, sport: "tennis", state: "live", minute: null, scoreHome: null, scoreAway: null },
      assessment: { confidence: "средняя", short: "", verdict: "" },
      markets: [{ label: favName, priceCents: favMlPrice, aiProb: prePrice / 100, liquidity: ml.liquidity || null }],
      openPositions: [],
      context: `БРЕЙК: сломали ${br.server === charge.favSide ? "ФАВОРИТА" : "андердога"} в сете ${br.setNum}, фаворит проиграл сетов: ${favSetsLost}. Цена фаворита ${favPrice}¢ (до брейка ~${prePrice}¢). Заряжен триггер early_break (ранний брейк, снапбек за минуты — «проигранный сет 1» это уже Set-Value, не сюда). Реши: overreaction (выкупаем) или real_shift (воздерживаемся).`,
    }, strat.model_live ?? strat.model ?? "Claude Opus 4.8", { fetchImpl: deps.fetchImpl, env });
    // A transient strategist failure ({ok:false} — timeout / 429 / repair-exhausted) is the ABSENCE of a
    // decision, NOT a decision. Do NOT burn the break's one shot on it — leave the marker unset so the next
    // tick retries (the snapback horizon is minutes). Only a real verdict below marks the break decided.
    if (!dec.ok) { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `стратег недоступен (${dec.error || "нет ответа"}) — входа нет (маркер не ставим, повтор на след. тике)`, created_at: now }); continue; }
    R.metaSet(db, ACTED + m.id + ":" + br.batchAt, "decided", now); // real decision obtained → one shot per break burned
    const pick = dec.picks.find((p) => norm(p.label) === norm(favName) || surnames(favName).some((t) => norm(p.label).includes(t)));
    if (!pick) { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `real_shift: стратег воздержался (не overreaction) — ${dec.note?.slice(0, 120) ?? ""}`, created_at: now }); continue; }

    // Entry prices off the LIVE scout price (the panicked favourite), NOT the market ROW — that row
    // can lag the import (~pre-break level), which is right for IDENTIFYING the favourite but wrong
    // for sizing: sizing the buyback against a stale high price zeroes the edge and every entry is
    // rejected. The gate already uses the scout price; the entry must match it. Fall back to the row.
    const entryCents = favPrice ?? favMlPrice; // live scout moneyline price, else stored moneyline
    // CODE sizes PER free profile within its OWN $1k budget (§9.6). One LLM call → up to N side-by-side bets.
    // §9.6 PROB CLAMP: the LLM judges real_shift (enter vs abstain) — it does NOT set the probability
    // that drives money sizing. Its pick.prob is CLAMPED to the armed reference (the pre-break price):
    // it may only lower conviction, never inflate the edge above the true panic amplitude
    // (prePrice − entry). Without this the LLM manufactures its own edge ("истинная вероятность выше
    // предматчевой" → 72% on a 38.5¢ side = a self-attributed 33.5% edge, the France–Morocco class bug).
    const ourProb = Math.min(pick.prob != null ? pick.prob * 100 : prePrice, prePrice) / 100;
    const implied = entryCents / 100; // moneyline price IS the de-vigged implied for a 2-outcome winner market
    // RUNTIME INVARIANT (belt behind the token fix): the favourite token's live ASK must sit near the
    // price we sized on. A flipped side asks at ~100−price → block + LOUD alert before a cent is spent.
    // Book is cached, so the fill below reuses this exact fetch. Inert when exec model is off (no book).
    if (poly.enabled) {
      const favBook = await classifyOrderBook(favToken, poly, deps, bookCache);
      const mm = orientationMismatch(favBook, "buy", entryCents);
      if (mm) {
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `⚠ token_orientation_mismatch: аск токена «${favName}» ${mm.tokenCents}¢ vs ожидаемая цена фаворита ${Math.round(entryCents)}¢ (Δ${Math.round(mm.gap)}¢) — покупаем НЕ ТОТ исход, ВХОД ЗАБЛОКИРОВАН`, created_at: now });
        continue;
      }
      // B3: the declared-liquidity gate lied for Mrva ($44 real book). Cut a dust book HERE (real ask
      // notional < floor) rather than clamp a dust bet. Only when the book is present — an empty/absent
      // book is the fill engine's honest-skip, not "thin".
      if (favBook.status === "ok") {
        const depthUsd = bookDepthUsd(favBook.book.asks);
        if (depthUsd < TENNIS_MIN_REAL_BOOK_USD) {
          R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `thin_real_book: реальная книга «${favName}» $${Math.round(depthUsd)} < порог $${TENNIS_MIN_REAL_BOOK_USD} (Gamma заявила $${Math.round(ml.liquidity || 0)}) — дустовая книга, вход отклонён`, created_at: now });
          continue;
        }
      }
    }
    // B6: the realized panic depth at entry (drop pre-break − entry) — profile-independent, so compute once.
    const panicDropCents = Math.round(Math.max(0, prePrice - entryCents) * 10) / 10;
    for (const profile of freeProfiles) {
      // Race guard: freeProfiles was computed BEFORE the awaited LLM call — an overlapping tick
      // (live + catch-up firing together) could have opened a buyback on this profile during the
      // await. Re-check right before the insert so two overlapping ticks can't double-enter the same
      // profile (the 22:00:22 + 22:00:42 double-batch that only the shadow cap caught).
      if (R.betsForMatch(db, m.id).some((b) => TENNIS_STRATEGIES.has(b.strategy_id) && b.status === "open" && b.risk_profile_id === profile)) continue;
      // B6 panic-depth gate: this profile buys only a panic at least as deep as its quantile threshold.
      // On a shallow distribution conservative enters rarely and deep BY DESIGN — thin 3.5¢ noise (eaten
      // by spread/vig on dust books) isn't traded; the real edge is in the tail. Threshold frozen on the bet.
      const minDrop = profile === "aggressive" ? panicTh.aggressive : profile === "conservative" ? panicTh.conservative : panicTh.medium;
      if (panicDropCents < minDrop) { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `[${profile}] паника ${panicDropCents}¢ < порога ${minDrop}¢ (${panicTh.source}, n=${panicTh.n}) — мелко для риск-профиля`, created_at: now }); continue; }
      const cfg = getProfileConfig(db, profile);
      const held = R.betsForMatch(db, m.id, TENNIS_STRATEGY).filter((b) => b.status === "open" && b.risk_profile_id === profile).reduce((s, b) => s + (b.stake ?? 0), 0);
      // allowLargeEdge OFF: a huge tennis moneyline edge is still the phantom signature. B2: the ceiling
      // is TENNIS_ABSURD_EDGE_BLOCK (40%, was the shared 25%) — the real phantom sources are cut upstream
      // (token invariant / thin_real_book / frozen_favourite), so the net widens to admit deep-but-real snapbacks.
      const r = sizePrematch({ ourProb, priceCents: entryCents, implied, calibration: 0.6, liquidity: ml.liquidity || null, budget: TENNIS_PAPER_BUDGET, matchExposure: held, compExposure: held, cfg, absurdEdgeBlock: TENNIS_ABSURD_EDGE_BLOCK });
      if (r.status !== "enter") { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `[${profile}] overreaction подтверждён, но сайзинг отклонил: ${r.reason}`, created_at: now }); continue; }
      // B2 cohort tag: an entry whose edge sits in the newly-opened 25–40% band USED to be auto-blocked.
      // Tag it (appended to the enter log below) so the raised ceiling can be validated from the clean distribution.
      const cohortTag = r.edge > TENNIS_ABSURD_EDGE_COHORT_FROM ? ` · [cohort ${Math.round(TENNIS_ABSURD_EDGE_COHORT_FROM * 100)}–${Math.round(TENNIS_ABSURD_EDGE_BLOCK * 100)}%: edge ${(r.edge * 100).toFixed(1)}% ранее блокировался]` : "";
      // book-fill-m1: fill against the LIVE moneyline book (VWAP / honest skip) — no more 0¢ fills.
      const decisionId = R.uid();
      const ack = await fillTennisEntry(executor, decisionId, { token: favToken, entryCents, sizeUsd: r.stake, fairProbPct: ourProb * 100, strategyId: TENNIS_STRATEGY, profileId: profile, matchId: m.id });
      if (ack.status !== "filled") {
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `[${profile}] ВЫКУП «${favName}» не исполнен: no_book_liquidity:${ack.reason} (${TENNIS_SKIP_KIND[ack.reason ?? ""] ?? ack.reason}) — манилайн ${entryCents}¢, заявл. ликв. $${Math.round(ml.liquidity || 0)}`, created_at: now });
        continue;
      }
      const fillCents = ack.avgFillPriceCents ?? entryCents; // REAL book fill price
      const fillStake = ack.filledSizeUsd;                    // depth-aware size (thin book → smaller)
      const meta = tennisEntryMeta({ favPrice: fillCents, prePrice, edge: r.edge, kelly: r.kellyFraction, stake: fillStake, thinnessUsd: ml.liquidity || null, setNum: br.setNum, favSide: charge.favSide, firstIsP1: ml.firstIsP1, panicDropCents, panicThresholdCents: minDrop });
      const betId = R.uid();
      R.insertBet(db, {
        id: betId, match_id: m.id, strategy_id: TENNIS_STRATEGY, risk_profile_id: profile, market_label: favName,
        status: "open", proposed_price: entryCents, entry_price: fillCents, current_price: fillCents, closing_price: null,
        ai_prob: ourProb, stake: fillStake, rationale: `выкуп переоценки (теннис): фаворит «${favName}» сломан в сете ${br.setNum}, манилайн ${entryCents}¢ vs предбрейк ${prePrice}¢. ${pick.reason || dec.note || ""}`,
        entered_minute: `сет ${br.setNum}`, result: null, payout: null, settled_by: null, settled_at: null,
        entry_meta: serializeEntryMeta(meta), code_version: codeVer, decision_id: decisionId, created_at: now,
      });
      try { shadowOnEntries(db, [{ betId, matchId: m.id, competitionId: comp, strategyId: TENNIS_STRATEGY, profileId: profile, size: fillStake, edge: r.edge, isLive: true }], shadowCfg, now); } catch { /* observe-only */ }
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "enter", text: `[${profile}] ВЫКУП «${favName}» @ ${fillCents}¢ · $${Math.round(fillStake)}${ack.clamped ? " (урезан по глубине)" : ""} · ${ack.note ?? ""} (edge ${(r.edge * 100).toFixed(1)}%, тейк ~${prePrice - TENNIS_TAKE_BUFFER}¢, стоп ${TENNIS_GAME_COUNT_STOP} приёмных / floor ${fillCents - TENNIS_CATASTROPHIC_FLOOR}¢, пороги:${TENNIS_ARMED_EPOCH})${cohortTag}`, created_at: now });
      opened++;
    }
  }
  return opened;
}

const SV_ACTED = "tennis_sv_acted:"; // per-match idempotency (the lost-set-1 event is singular)
const SV_WAIT = "tennis_sv_wait:";   // one-shot "waiting for the cross-strategy block to clear" log guard

/** Both sides' winner price at the START of the match (first priced snapshot) — the CLEAN pre-match
 *  favourite reference. After the favourite loses set 1 its price drops into 30-45¢, which would
 *  flip the favourite to the opponent if we identified off the CURRENT price. */
function startPrices(db: Database, matchId: string): { p1: number | null; p2: number | null } {
  const r = db.prepare(`SELECT pm_p1_cents,pm_p2_cents FROM tennis_snapshots WHERE pm_match_id=? AND pm_p1_cents IS NOT NULL ORDER BY batch_at ASC LIMIT 1`).get(matchId) as { pm_p1_cents?: number; pm_p2_cents?: number } | undefined;
  return { p1: r?.pm_p1_cents ?? null, p2: r?.pm_p2_cents ?? null };
}

/** Decision-time entry_meta for a Set-Value paper bet — a PARTIAL-take, hold-to-settle exit plan. */
export function tennisSetValueEntryMeta(o: { favPrice: number; edge: number; kelly: number; stake: number; thinnessUsd: number | null; setNum: number; favSide?: "first" | "second" | null; firstIsP1?: boolean | null }): BetEntryMeta {
  return {
    phase: "live", minute: null, scoreHome: null, scoreAway: null,
    favSide: o.favSide ?? null, firstIsP1: o.firstIsP1 ?? null, // token-fix-m1: pin the held outcome so the exit sells the SAME token it bought
    edge: Math.round(o.edge * 1000) / 1000, aiProb: Math.round(SET_VALUE_ARMED.comebackProb * 1000) / 1000, derivedProb: null,
    marketPrice: o.favPrice, impliedProb: Math.round((o.favPrice / 100) * 1000) / 1000, liveProbAdjusted: null,
    kellyFraction: Math.round(o.kelly * 1000) / 1000, sizeRequested: Math.round(o.stake * 100) / 100, sizeFilled: null, entrySlipCents: null,
    calibration: null, branchWeightSum: null, phantomCheck: null, marketThinnessUsd: o.thinnessUsd,
    winsOnEvent: false, exitPlan: {
      take_price: { at_cents: SET_VALUE_ARMED.takeLowCents, fraction: SET_VALUE_ARMED.takeFraction, note: "частичная фиксация камбэка, остаток до финала" },
      thesis_stop: { receiver_games: SET_VALUE_ARMED.thesisStopReceiverGames, note: "брейк во 2-м сете без возврата за K приёмных" },
      catastrophic_floor: { at_cents: o.favPrice - SET_VALUE_ARMED.floorBelowEntryCents },
      armed_epoch: SET_VALUE_EPOCH,
    },
    models: { analysis: null, strategist: null },
  };
}

/**
 * §6 PAPER entry for SET-VALUE: on a match where the FAVOURITE lost set 1 (bo3) and its moneyline
 * price sits in the armed band, ask the strategist ONLY the competitive-set / retire-risk question;
 * if the set was competitive, open a CODE-sized paper bet on the favourite's winner market with the
 * partial-take/hold-to-settle exit. Cross-strategy one-position rule: a profile already holding ANY
 * open tennis buyback (Overreaction OR Set-Value) on the match is not free — Set-Value waits for it
 * to close. Isolated + guarded; never throws into the tick. Returns entries opened.
 */
export async function tennisSetValueTick(db: Database, deps: EngineDeps = {}): Promise<number> {
  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  const strat = getStrategy(db, SET_VALUE_STRATEGY);
  if (!strat) return 0; // strategy not seeded → Set-Value off
  const now = nowFn(deps)();
  const codeVer = `${effectiveCodeVersion(db)}·${SET_VALUE_EPOCH}`;
  const shadowCfg = loadShadowConfig(db, deps.env);
  const svNowMs = Date.parse(now) || Date.now();
  const poly = deps.polymarket ?? loadPolymarketConfig(env);
  const bookCache = new Map<string, OrderBookFetch>();
  const executor = new PaperExecutor({ poly, deps, bookCache, nowMs: () => svNowMs });
  let opened = 0;

  const tennisMatches = R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id).map((m) => ({ comp: c.id, m })));
  for (const { comp, m } of tennisMatches) {
    if (m.state === "finished") continue;
    if (R.metaGet(db, SV_ACTED + m.id)) continue; // one Set-Value decision per match
    // (ITF/Challenger/doubles scope is enforced ONCE inside chargeTennisMatch → charge.tradeable=false → gate skip.)
    const snaps = db.prepare(`SELECT * FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at`).all(m.id) as R.TennisSnapshotRow[];
    if (snaps.length < 2) continue;
    const last = snaps[snaps.length - 1];
    const players = { p1: last.p1 ?? "", p2: last.p2 ?? "" };
    // Favourite ID from the MATCH-START price (the post-set price is depressed into the band, which
    // would flip the favourite to the opponent). Book gate reuses the moneyline depth.
    const charge = chargeTennisMatch(db, m.id, players, startPrices(db, m.id));
    const favSetsWon = charge.favSide === "first" ? (last.sets_p1 ?? 0) : (last.sets_p2 ?? 0);
    const favSetsLost = charge.favSide === "first" ? (last.sets_p2 ?? 0) : (last.sets_p1 ?? 0);
    const favPrice = charge.favSide ? favPriceFromScout(db, m.id, charge.favSide) : null;
    const gate = setValueGate({ favSide: charge.favSide, tradeable: charge.tradeable, favPriceCents: favPrice, favSetsWon, favSetsLost, setNum: last.set_num, eventType: last.event_type, tournament: last.tournament });
    if (!gate.armed) continue; // transient (price not in band / set not yet lost) OR terminal — re-checked cheaply each tick; never mark acted until we actually decide
    const favSide = charge.favSide; if (!favSide) continue; // gate.armed already implies a favourite; narrow for the token resolver

    const favName = favSide === "first" ? players.p1 : players.p2;
    const ml = tennisMoneyline(db, m.id, players);
    if (!ml) { R.metaSet(db, SV_ACTED + m.id, "no_moneyline", now); R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `манилайн не найден — вход пропущен (no_moneyline)`, created_at: now }); continue; }
    // token-fix-m1: trade the FAVOURITE's OWN winner token (resolved via favSide). Not persisted yet →
    // honest skip WITHOUT marking acted (re-discovery backfills token_second, next tick retries).
    const favToken = favTokenOf(ml, favSide);
    if (!favToken) {
      const warned = R.tradeLogForMatch(db, m.id).some((l) => l.strategy_id === SET_VALUE_STRATEGY && l.type === "skip" && (l.text ?? "").includes("token_side_unavailable"));
      if (!warned) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `token_side_unavailable: токен стороны фаворита ещё не сохранён (token_second) — вход отложен до ре-дискавери`, created_at: now });
      continue;
    }

    // Cross-strategy one-position rule (tennis): a profile holding ANY open tennis buyback on this
    // match is not free. If ALL profiles are blocked, WAIT (don't mark acted) — Set-Value enters
    // once the block clears (e.g. the Overreaction position closed by its K-stop).
    const profiles = (() => { const ps = R.listRiskProfiles(db).map((p) => p.id); return ps.length ? ps : RISK_PROFILE_DEFS.map((d) => d.id); })();
    const heldProfiles = new Set(R.betsForMatch(db, m.id).filter((b) => TENNIS_STRATEGIES.has(b.strategy_id) && b.status === "open").map((b) => b.risk_profile_id));
    const freeProfiles = profiles.filter((p) => !heldProfiles.has(p));
    if (!freeProfiles.length) {
      if (!R.metaGet(db, SV_WAIT + m.id)) { R.metaSet(db, SV_WAIT + m.id, "waiting", now); R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `Set-Value ждёт: по матчу открыта выкупная позиция (Overreaction/Set-Value) — вход после её закрытия (blocked_cross_strategy)`, created_at: now }); }
      continue; // do NOT mark acted — retry after the block clears
    }

    // LLM judges ONLY competitive-set vs blowout (+ retire-risk) — ONCE, shared across profiles.
    const dec = await strategistDecide({
      strategyName: strat.name, strategyPrompt: strat.prompt_live ?? strat.prompt,
      match: { home: players.p1, away: players.p2, sport: "tennis", state: "live", minute: null, scoreHome: null, scoreAway: null },
      assessment: { confidence: "средняя", short: "", verdict: "" },
      markets: [{ label: favName, priceCents: favPrice ?? 0, aiProb: SET_VALUE_ARMED.comebackProb, liquidity: ml.liquidity || null }],
      openPositions: [],
      context: `ФАВОРИТ ПРОИГРАЛ 1-Й СЕТ (bo3). Счёт по сетам фаворита: выиграно ${favSetsWon}, проиграно ${favSetsLost}; сейчас сет ${last.set_num}, геймы ${last.games_p1}-${last.games_p2}. Цена фаворита ${favPrice}¢ (полоса входа 30-45¢). Реши: конкурентный сет (покупаем камбэк) или разгром / ретайр-риск (воздерживаемся).`,
    }, strat.model_live ?? strat.model ?? "Claude Opus 4.8", { fetchImpl: deps.fetchImpl, env });
    // A transient {ok:false} (timeout / 429 / repair-exhausted) is the ABSENCE of a decision, not a
    // decision. Do NOT burn this match's single Set-Value shot on infra failure — leave SV_ACTED unset so
    // the next tick retries (the gate stays armed all through set 2). Only a real verdict below marks acted.
    if (!dec.ok) { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `стратег недоступен (${dec.error || "нет ответа"}) — входа нет (маркер не ставим, повтор на след. тике)`, created_at: now }); continue; }
    R.metaSet(db, SV_ACTED + m.id, "decided", now); // real decision obtained → one shot per match burned
    const pick = dec.picks.find((p) => norm(p.label) === norm(favName) || surnames(favName).some((t) => norm(p.label).includes(t)));
    if (!pick) { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `не конкурентный сет / ретайр-риск: стратег воздержался — ${dec.note?.slice(0, 120) ?? ""}`, created_at: now }); continue; }

    const entryCents = favPrice ?? (favSide === "first" ? ml.p1Cents : ml.p2Cents);
    const ourProb = SET_VALUE_ARMED.comebackProb; // interim constant for a competitive lost set (calibrated later)
    const implied = entryCents / 100;
    // RUNTIME INVARIANT (belt): the favourite token's live ASK must sit near the price we sized on —
    // block + LOUD alert on a flipped side before spending. Cached; the fill reuses this fetch.
    if (poly.enabled) {
      const favBook = await classifyOrderBook(favToken, poly, deps, bookCache);
      const mm = orientationMismatch(favBook, "buy", entryCents);
      if (mm) {
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `⚠ token_orientation_mismatch: аск токена «${favName}» ${mm.tokenCents}¢ vs ожидаемая цена фаворита ${Math.round(entryCents)}¢ (Δ${Math.round(mm.gap)}¢) — покупаем НЕ ТОТ исход, ВХОД ЗАБЛОКИРОВАН`, created_at: now });
        continue;
      }
      // B3: cut a dust real book here (declared-liquidity gate can't see it), same as Overreaction.
      if (favBook.status === "ok") {
        const depthUsd = bookDepthUsd(favBook.book.asks);
        if (depthUsd < TENNIS_MIN_REAL_BOOK_USD) {
          R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `thin_real_book: реальная книга «${favName}» $${Math.round(depthUsd)} < порог $${TENNIS_MIN_REAL_BOOK_USD} (Gamma заявила $${Math.round(ml.liquidity || 0)}) — дустовая книга, вход отклонён`, created_at: now });
          continue;
        }
      }
    }
    for (const profile of freeProfiles) {
      // Race guard (see Overreaction): freeProfiles predates the awaited LLM call — re-check the
      // CROSS-strategy hold right before the insert so an overlapping tick can't double-enter.
      if (R.betsForMatch(db, m.id).some((b) => TENNIS_STRATEGIES.has(b.strategy_id) && b.status === "open" && b.risk_profile_id === profile)) continue;
      const cfg = getProfileConfig(db, profile);
      const held = R.betsForMatch(db, m.id, SET_VALUE_STRATEGY).filter((b) => b.status === "open" && b.risk_profile_id === profile).reduce((s, b) => s + (b.stake ?? 0), 0);
      // allowLargeEdge OFF (same phantom-guard reasoning as Overreaction): a Set-Value edge is
      // comebackProb(0.5) − price, ≤20% inside the 30-45¢ band, so the 25% absurd_edge_block never
      // catches a legitimate entry — it only backstops a bad-quote / mislabelled-favourite artifact.
      const r = sizePrematch({ ourProb, priceCents: entryCents, implied, calibration: 0.6, liquidity: ml.liquidity || null, budget: TENNIS_PAPER_BUDGET, matchExposure: held, compExposure: held, cfg });
      if (r.status !== "enter") { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `[${profile}] конкурентный сет подтверждён, но сайзинг отклонил: ${r.reason}`, created_at: now }); continue; }
      // book-fill-m1: fill against the LIVE moneyline book. On ≥$10k-declared moneylines the skip rate
      // should be LOW — a high no_book_liquidity rate here points at OUR book mapping first (tokenId /
      // side / limit vs spread), then the market (build notes: Set-Value routing criterion).
      const decisionId = R.uid();
      const ack = await fillTennisEntry(executor, decisionId, { token: favToken, entryCents, sizeUsd: r.stake, fairProbPct: ourProb * 100, strategyId: SET_VALUE_STRATEGY, profileId: profile, matchId: m.id });
      if (ack.status !== "filled") {
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `[${profile}] SET-VALUE «${favName}» не исполнен: no_book_liquidity:${ack.reason} (${TENNIS_SKIP_KIND[ack.reason ?? ""] ?? ack.reason}) — манилайн ${entryCents}¢, заявл. ликв. $${Math.round(ml.liquidity || 0)}`, created_at: now });
        continue;
      }
      const fillCents = ack.avgFillPriceCents ?? entryCents;
      const fillStake = ack.filledSizeUsd;
      const meta = tennisSetValueEntryMeta({ favPrice: fillCents, edge: r.edge, kelly: r.kellyFraction, stake: fillStake, thinnessUsd: ml.liquidity || null, setNum: last.set_num ?? 2, favSide, firstIsP1: ml.firstIsP1 });
      const betId = R.uid();
      R.insertBet(db, {
        id: betId, match_id: m.id, strategy_id: SET_VALUE_STRATEGY, risk_profile_id: profile, market_label: favName,
        status: "open", proposed_price: entryCents, entry_price: fillCents, current_price: fillCents, closing_price: null,
        ai_prob: ourProb, stake: fillStake, rationale: `set-value (теннис): фаворит «${favName}» проиграл 1-й сет, манилайн ${entryCents}¢, P(камбэк)≈${Math.round(ourProb * 100)}%. ${pick.reason || dec.note || ""}`,
        entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null,
        entry_meta: serializeEntryMeta(meta), code_version: codeVer, decision_id: decisionId, created_at: now,
      });
      try { shadowOnEntries(db, [{ betId, matchId: m.id, competitionId: comp, strategyId: SET_VALUE_STRATEGY, profileId: profile, size: fillStake, edge: r.edge, isLive: true }], shadowCfg, now); } catch { /* observe-only */ }
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "enter", text: `[${profile}] SET-VALUE «${favName}» @ ${fillCents}¢ · $${Math.round(fillStake)}${ack.clamped ? " (урезан по глубине)" : ""} · ${ack.note ?? ""} (edge ${(r.edge * 100).toFixed(1)}%, тейк 50% @ ${SET_VALUE_ARMED.takeLowCents}¢ / стоп брейк-невозврат K${SET_VALUE_ARMED.thesisStopReceiverGames} / floor ${fillCents - SET_VALUE_ARMED.floorBelowEntryCents}¢, пороги:${SET_VALUE_EPOCH})`, created_at: now });
      opened++;
    }
  }
  return opened;
}
