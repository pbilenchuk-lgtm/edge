// ============================================================
// EDGE LAB — automated match lifecycle (analyze → enter → reassess → exit)
// [SERVER-ONLY]
//
// The cron/tick drives the whole loop without a human:
//   1) autoAnalyze — analyze matches that have tradeable odds and haven't been
//      analyzed for their current stage yet (once pre-lineup, once after
//      lineups; §9.5 keeps it economical — one LLM pass per stage per match).
//   2) autoEnter   — paper-fill the strategy's proposed bets at the current
//      price (proposed → open).
//   3) evaluateExits — close open positions deterministically (§9.6) on
//      take-profit / per-position stop / edge-gone. In-match reassessment on
//      goals & price moves is already fired by the engine.
//   4) runAutoCycle — orchestrates sync + odds + the three steps above.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { syncCompetitions, refreshActiveOdds, recomputeMetrics, importPolymarketMatches, enrichFromEspn, settleStaleOpenBets, seriesAllowFor, dedupeMatches, espnLeagueForSeries } from "./engine.js";
import { reconcileFootballCategories } from "./seed.js";
import { SPORT_TAG_IDS, SPORT_LABELS, loadPolymarketConfig, type OrderBookFetch, type PolymarketConfig } from "./polymarket.js";
import { classifyOrderBook, paperBuyFill, paperSellFill, scaleCost, ENTRY_PHANTOM_DIVERGENCE, type FillCost, type EntryFillResult, type SellFillResult } from "./executor/paperFill.js";
import { mirrorPaperEntryToReal, dryVirtualFreeUsd, sweepDryExits } from "./executor/whitelist.js";
import { readTradingMode } from "./executor/safety.js";
import type { Bet, Market, Strategy } from "./types.js";
import { analyzeMatch, runStrategists, jobActive, strategistContext, footballCore, strategyCompExposure, strategyCompRealized, sameMarketLabel } from "./analysis.js";
import { loadLiveProbConfig, liveAdjustedProb } from "./liveProb.js";
import { classifyZombie, notationSpreads, loadZombieConfig, type ZombieReason } from "./zombieMarket.js";
import { gapWakeActive, gapWakeGapSec, gapRepriceConfig } from "./scheduleGap.js";
import { exitDecision, winsOnEventOccurrence, isStaleProposal, proposalDrift } from "./thresholds.js";
import { underThesisMarginGoals, resolveFootballMarket } from "./settlement.js";
import { serializeEntryMeta, parseEntryMeta, type BetEntryMeta } from "./betMeta.js";
import { effectiveCodeVersion } from "./codeEpoch.js";
import { impliedProbs, sizePrematch, correlationKey } from "./strategist.js";
import { getProfileConfig } from "./riskConfig.js";
import { stratBudget } from "./money.js";
import { strategistDecide, effectiveEnv } from "./llm.js";
import { hoursUntil, finishStamp } from "./time.js";
import { loadShadowConfig, shadowOnEntries, shadowOnExit, type ShadowEntryRequest } from "./shadow.js";
import { collectSnapshots } from "./snapshots.js";
import { collectTennisSnapshots, recordTennisBreakMarks, tennisScoutSilence } from "./tennisScout.js";
import { tennisTradingTick, tennisSetValueTick, tennisExitTick, settleTennisBets, finishTennisMatches, tennisScoutInPlay, tennisFinalResult, pollTennisFinals } from "./tennisTrading.js";
import { sweepAbandonedMatches } from "./staleSweep.js";
import { tennisPmvTick, settleTennisPmvBets } from "./tennisPmv.js";
import { resolvePmvShadowSignals } from "./tennisPmvShadow.js";
import { resolveSvShadowSignals } from "./tennisSetValueShadow.js";
import { backfillEspnEventDates } from "./footballIntegrity.js";
import { captureBookDepth } from "./bookDepthCapture.js";
import { overreactionGate } from "./reassessGate.js";
import { loadAnalysisDuel, analysisModelTag } from "./analysisDuel.js";
import type { Confidence, ReassessTrigger } from "./types.js";

// Timing gates (hours before kickoff). Pre-match assessment opens ~12h out;
// lineups are treated as out ~1h before (WC teamsheets), triggering the final
// (post-lineup) reassessment.
export const ANALYZE_PRE_HOURS = 12;
export const LINEUP_HOURS = 1;
// When a match's FIRST analysis lands just after kickoff (a scheduler gap spanned
// the whistle), the pre-match strategist is normally skipped in live. But within
// this grace of kickoff — score still 0:0, prices essentially unmoved — the
// pre-match theses are still valid, so the strategist gets its one shot rather
// than forfeiting the whole match (Pre-match Value only defends existing positions
// in live; Overreaction needs an armed trigger; live-xG needs an xG stream — so a
// forfeited pre-match pass leaves the match completely un-traded). Env-tunable.
export const EARLY_LIVE_STRATEGIST_GRACE_MIN = (() => {
  const n = Number(process.env.EARLY_LIVE_STRATEGIST_GRACE_MIN);
  return Number.isFinite(n) && n >= 0 ? n : 10;
})();
// A live stop must be able to fill NEAR the price that triggered it. When the
// executable bid collapses to a phantom — a thin book prints a 1¢ bid while the mark
// is ~19¢ — a mechanical stop would DUMP the position at that phantom and realize a
// fake near-total loss. That is the −$35 «NJ/NY Gotham FC» cut that fired the instant
// Utah went 1:0, three minutes before Gotham equalized and won 3:1 (the Lite sibling,
// wider stop, held and won $231). HOLD instead: a bid at/below FLOOR¢ that sits ≥ GAP¢
// under the mark is not real liquidity, so the position rides to its true settlement
// rather than paying a phantom. Distinct from liveDelivering (there the provider is
// silent; here it's delivering but the ORDER BOOK momentarily lies). Env-tunable.
export const EXIT_PHANTOM_FLOOR = (() => { const n = Number(process.env.EXIT_PHANTOM_FLOOR); return Number.isFinite(n) && n >= 0 ? n : 5; })();
export const EXIT_PHANTOM_GAP = (() => { const n = Number(process.env.EXIT_PHANTOM_GAP); return Number.isFinite(n) && n >= 0 ? n : 8; })();
// A live stop must also not DUMP the whole position through a thin/broken book: when
// selling the FULL stake slips the executable VWAP this many cents BELOW the best bid,
// the top of book can't absorb the size — the realized price (and the stop it
// self-triggers) is a depth artifact, not the real value. On a broken book (best bid
// 42¢ but full-stake VWAP 15.9¢, −26¢ slip) that fake −70% stop-out was pure slippage.
// HOLD instead: let the position ride to a deeper book / real settlement. Only on a REAL
// book and only on a LARGE full-stake slip (normal exits slip 0–1¢). Env-tunable.
export const EXIT_SLIPPAGE_BLOCK = (() => { const n = Number(process.env.EXIT_SLIPPAGE_BLOCK); return Number.isFinite(n) && n > 0 ? n : 15; })();
// UNDER-thesis stop suppression (audit: Sarpsborg Under 3.5 @1:0 dumped @21-26¢; Inter FK Sarajevo
// Under 1.5 stopped @7-8¢ then SETTLED 100¢). An Under LOSES only when goals climb to the line — so
// while the score sits this many goals (or more) BELOW the line, a price crash is a book artifact,
// not a broken thesis, and the deterministic price stop is a category error (mirror of the Over
// melting-option exemption). GAP-based, not time-based: management defers to strategist / settlement
// only while the thesis is MATHEMATICALLY safe; the moment a goal narrows the margin below this, the
// stop is restored (self-correcting — re-checked against the live score every cycle, so a credit
// blackout can't leave it suppressed past the point of real danger). Env-tunable.
export const UNDER_STOP_SUPPRESS_MARGIN = (() => { const n = Number(process.env.UNDER_STOP_SUPPRESS_MARGIN); return Number.isFinite(n) && n >= 0 ? n : 1; })();
// ILLIQUID-BOOK stop guard, generalised from the absolute-dust phantom floor to a mark↔bid GAP
// (audit: 20-26¢ bids slipped between the ≤5¢ phantom floor and the 15¢ slippage gap). On a real
// book, when the mark is rich (≥ MIN¢) but the best bid sits ≥ GAP¢ below it, the executable bid has
// decoupled from the value — that's illiquidity/broken depth, not a thesis break — so a stop dumps
// at a price the market doesn't really bear. HOLD. Deliberately CONSERVATIVE (rich mark + large gap)
// and logged distinctly (exit_illiquid_mark_gap) so a week of firings can be calibrated. Env-tunable.
export const EXIT_ILLIQUID_MARK_GAP = (() => { const n = Number(process.env.EXIT_ILLIQUID_MARK_GAP); return Number.isFinite(n) && n > 0 ? n : 20; })();
export const EXIT_ILLIQUID_MARK_MIN = (() => { const n = Number(process.env.EXIT_ILLIQUID_MARK_MIN); return Number.isFinite(n) && n > 0 ? n : 60; })();
// T1.1 STATE↔PRICE CONTRADICTION guard (batch-3). The three guards above key off the CURRENT mark/bid,
// so they DEGRADE as the book decays — exactly when a phantom is worst (Cienciano: 32' slip 27¢ → blocked;
// 35' bid fell to 17¢ → slip 12¢ → the −89% dump of a WINNING team-Under went through, −$141 on a bet that
// paid +$212). The fix anchors on GAME STATE, not price: a protective STOP on a position that is CURRENTLY
// WINNING by the score (resolveFootballMarket = true) yet would execute at a low bid FAR below its frozen
// reference (entry price) is the market lying, not the thesis breaking — HOLD to settle. Melting options
// that already resolved yes (winsOnEventOccurrence) can NEVER be legitimately stopped once won. Env-tunable.
export const STATE_STOP_FLOOR = (() => { const n = Number(process.env.STATE_STOP_FLOOR); return Number.isFinite(n) && n > 0 ? n : 25; })();      // executable bid at/below this (¢)
export const STATE_STOP_DECAY_GAP = (() => { const n = Number(process.env.STATE_STOP_DECAY_GAP); return Number.isFinite(n) && n > 0 ? n : 25; })(); // drop from the frozen reference (¢)
export const STATE_STOP_THIN_SLIP = (() => { const n = Number(process.env.STATE_STOP_THIN_SLIP); return Number.isFinite(n) && n > 0 ? n : 3; })();  // bid↔VWAP gap that marks a thin book (¢)
export interface StateStopSell { cents: number; fromBook: boolean; bestBidCents?: number | null; filledShares?: number; requestedShares?: number }
/** T1.1: does a protective STOP contradict the game state? Returns a reason string to HOLD, or null to let
 *  the stop fire. Fires ONLY on a currently-WINNING position (by score) dumped at a phantom-low bid on a THIN
 *  book (partial fill / slippage) far below its frozen entry reference — or an already-won melting option at
 *  any low bid (a won option can't trade low on a real book). A genuinely-fragile Under sold into a DEEP book
 *  at a real low value still stops. Purely deterministic; never touches a genuinely LOSING position's stop. */
export function stopContradictsGameState(
  label: string, scoreHome: number | null, scoreAway: number | null, teams: { home: string; away: string },
  entryCents: number | null, sell: StateStopSell,
): string | null {
  if (!sell.fromBook || entryCents == null) return null;               // modelled prices are a separate haircut
  if (sell.cents > STATE_STOP_FLOOR) return null;                      // a healthy bid — no contradiction
  const winsNow = resolveFootballMarket(label, scoreHome ?? 0, scoreAway ?? 0, teams);
  if (winsNow !== true) return null;                                   // not currently winning → a real stop
  const melting = winsOnEventOccurrence(label);                        // Over / BTTS-Yes: a win is PERMANENT
  const decay = entryCents - sell.cents;
  // A THIN book = the low price is not a genuine deep-book value: the stake didn't fully fill, or the top bid
  // sits above the realized VWAP (the price decoupled). A DEEP book at a real low (fragile Under) is NOT thin.
  const partial = (sell.requestedShares ?? 0) > 0 && (sell.filledShares ?? 0) < (sell.requestedShares as number) - 1e-6;
  const slip = sell.bestBidCents != null ? sell.bestBidCents - sell.cents : 0;
  const thin = partial || slip >= STATE_STOP_THIN_SLIP;
  if (melting) {
    // A won melting option trading ≤floor¢ is a phantom by definition (real book would be ~100¢) — always hold.
    return `мелтинг-опцион уже выигран game-state, но бид ${sell.cents}¢ (вход ${entryCents}¢) — цена противоречит факту, книга-зомби; держим до сеттла (state_price_contradiction)`;
  }
  if (decay < STATE_STOP_DECAY_GAP) return null;                       // not a collapse from the frozen ref → allow
  if (!thin) return null;                                              // deep-book genuine low value on a fragile Under → let the stop fire
  return `позиция выигрывает по счёту ${scoreHome ?? 0}:${scoreAway ?? 0}, но бид ${sell.cents}¢ на тонкой книге (вход ${entryCents}¢) — цена противоречит факту, книга-зомби; держим до сеттла (state_price_contradiction)`;
}

// T1.2 TERMINAL-PHASE melting-option protection. Racing/Fluminense/Göteborg: a long Over / BTTS-Yes was
// liquidated DEFENSIVELY in the closing phase — its whole value is a future event and its downside is already
// ~0 (settles 0 if the event never lands), so a defensive sale can only forfeit upside. Two deterministic
// blocks; a TAKE-PROFIT (high real bid) is never touched, so a genuine peak-fix still fires.
export const TERMINAL_MIN = (() => { const n = Number(process.env.TERMINAL_MIN); return Number.isFinite(n) && n > 0 ? n : 85; })();          // minute at/after which a winner holds to settle
export const TERMINAL_FLOOR_MARGIN = (() => { const n = Number(process.env.TERMINAL_FLOOR_MARGIN); return Number.isFinite(n) && n >= 0 ? n : 5; })(); // ¢ a terminal defensive sale may sit below the game-state floor
/** T1.2: should a DEFENSIVE exit be BLOCKED to hold-to-settle in the terminal phase? Reason, or null.
 *  (A) a MELTING option (Over/BTTS-Yes) sold via a MODEL fill (no live bid) — the sale is fictional and the
 *      downside is already ~0; hold (resolution pays 100 if the event lands, 0 otherwise — never worse).
 *  (B) terminal minute + already WINNING by the current score → hold to settle (resolution-close pays 100).
 *  gsFloorProb (liveAdjustedProb) adds (C) at the call site: a terminal melting sale below its game-state floor. */
export function terminalProtectiveHold(
  label: string, scoreHome: number | null, scoreAway: number | null, minute: number | null,
  teams: { home: string; away: string }, sellFromBook: boolean, isDefensive: boolean,
): string | null {
  if (!isDefensive) return null;                                       // a take-profit at a high price is fine
  const melting = winsOnEventOccurrence(label);
  if (melting && !sellFromBook) return `мелтинг-опцион защитно продаётся по МОДЕЛИ (нет живого бида) — продажа фиктивна, даунсайд уже ≈0; держим до сеттла (terminal_model_fill)`;
  const winning = resolveFootballMarket(label, scoreHome ?? 0, scoreAway ?? 0, teams) === true;
  if (winning && minute != null && minute >= TERMINAL_MIN) return `${minute}' ≥ ${TERMINAL_MIN}' и позиция выигрывает по счёту — защитная продажа отклонена, resolution-close закроет по 100 (terminal_winning_hold)`;
  return null;
}
// TIME-DECAY FLOOR for "wins on event occurrence" markets (Over, BTTS Yes, team-to-score),
// which are EXEMPT from the price stop (their price is a melting option — see
// winsOnEventOccurrence). Exempt ≠ hold the corpse to the whistle: an option that is BOTH
// deep-dust (≤ FLOOR¢) AND late (≥ MIN') is a spent lottery ticket — close it deterministically
// to salvage the pennies instead of riding to a 0¢ settle. The DUST price is also the ET
// safety: in a live knockout with extra time still to come, «team scores ≥1» is not ≤ a few ¢
// unless genuinely dead — so this never cuts a live ET option. Env-tunable.
export const EXIT_TIME_FLOOR_CENTS = (() => { const n = Number(process.env.EXIT_TIME_FLOOR_CENTS); return Number.isFinite(n) && n > 0 ? n : 4; })();
export const EXIT_TIME_FLOOR_MIN = (() => { const n = Number(process.env.EXIT_TIME_FLOOR_MIN); return Number.isFinite(n) && n > 0 ? n : 80; })();
// A melting option whose mark has reached this ¢ is treated as RESOLVED (event
// effectively happened / market at ~YES) — a planned time_stop must NOT fire on it
// (spec: fire only when "событие не наступило"). Env-tunable.
export const EXIT_TIME_STOP_RESOLVED_CENTS = (() => { const n = Number(process.env.EXIT_TIME_STOP_RESOLVED_CENTS); return Number.isFinite(n) && n > 0 ? n : 90; })();
// DEGRADED-MODE fallback for the price-stop exemption. The exemption above trades away the
// deterministic stop on the assumption that the STRATEGIST layer (thesis / counter_scenario
// exits) is watching those melting-option positions instead. When that layer is DOWN (credit
// outage → HTTP 400, network) the exempt positions have no live managing exit at all — the
// exact window the exemption opens if the LLM is blind. So: track the strategist's last OK vs
// last FAIL, and if the most recent strategist outcome was a failure AND it's recent (an active
// outage, not just an idle quiet period), RESTORE the price stop to exempt markets until the
// strategist recovers. The insurance auto-returns exactly when the thing it was traded for is gone.
const LAST_STRATEGIST_OK_KEY = "last_strategist_ok_ms";
const LAST_STRATEGIST_FAIL_KEY = "last_strategist_fail_ms";
export const STRATEGIST_STALE_MIN = (() => { const n = Number(process.env.STRATEGIST_STALE_MIN); return Number.isFinite(n) && n > 0 ? n : 45; })();
// CIRCUIT-BREAKER for a HARD, non-transient strategist outage (audit: Rosenborg 45'+ printed 248
// straight `HTTP 400 "credit balance too low"`). A credit-exhausted / auth / permission failure is
// GLOBAL and won't clear this cycle — yet every (match,strategy) pair kept re-issuing the same dead
// call, a 248-request storm, and left every live position with no reassessment for the whole 2nd
// half. When such a failure is seen, OPEN the breaker for a cooldown: subsequent reassess calls
// short-circuit (one log per match, no storm) and the deterministic exit net takes over. The FIRST
// strategist SUCCESS closes the breaker immediately. Env-tunable.
const STRATEGIST_HARD_BLOCK_KEY = "strategist_hard_block_until_ms";
export const STRATEGIST_HARD_COOLDOWN_MIN = (() => { const n = Number(process.env.STRATEGIST_HARD_COOLDOWN_MIN); return Number.isFinite(n) && n > 0 ? n : 15; })();
/** A strategist failure that retrying THIS cycle cannot fix — credit exhausted, auth, permission,
 *  a hard 401/403. Detected from the error text so a GLOBAL outage trips the breaker while a one-off
 *  malformed request (a single 400 on one market's prompt) does NOT block every other pair. */
export function isHardStrategistFailure(err: string | null | undefined): boolean {
  const e = String(err ?? "");
  return /HTTP\s*40[13]\b/.test(e) || /credit balance|balance is too low|too low to access|authentication|invalid.{0,12}api.?key|permission|insufficient|quota/i.test(e);
}
/** True while the hard-outage breaker is OPEN (a hard failure was seen within the cooldown and no
 *  success has since closed it). Skip strategist calls; keep the deterministic net in charge. */
export function strategistHardBlocked(db: Database, nowMs: number): boolean {
  return nowMs < Number(R.metaGet(db, STRATEGIST_HARD_BLOCK_KEY) ?? 0);
}
/** True when the strategist layer is in an ACTIVE outage: the breaker is open (hard outage), OR its
 *  most recent outcome was a failure and that failure is recent (within STRATEGIST_STALE_MIN). A
 *  quiet period with no reassessments is NOT degraded — only a live, currently-failing layer. The
 *  breaker is folded in so the price-stop restore stays active across a SKIPPED (not re-issued)
 *  cooldown, not just on the tick that recorded the failure. */
export function strategistDegraded(db: Database, nowMs: number): boolean {
  if (strategistHardBlocked(db, nowMs)) return true;
  const lastOk = Number(R.metaGet(db, LAST_STRATEGIST_OK_KEY) ?? 0);
  const lastFail = Number(R.metaGet(db, LAST_STRATEGIST_FAIL_KEY) ?? 0);
  return lastFail > lastOk && nowMs - lastFail <= STRATEGIST_STALE_MIN * 60_000;
}

// EXECUTION STALENESS (audit: Argentina–Switzerland 64'). The strategist DECIDES on the stored
// price snapshot (mk.price) but its exits FILL on a fresh order book. If a match event repriced
// the market in the seconds between (the 64' race: decision reasoned on 35¢, book was already
// 95¢ after the goal), the fill executes a decision from a DIFFERENT reality. When the fresh top
// bid diverges from the decision snapshot by ≥ this many cents, don't execute — reassess on fresh
// data next cycle. Normal drift is 0–5¢; only an event moves it this far. Env-tunable.
export const EXIT_STALE_GAP = (() => { const n = Number(process.env.EXIT_STALE_GAP); return Number.isFinite(n) && n > 0 ? n : 20; })();
// F1: cumulative count of strategist DEFENSIVE exits blocked because their registered condition wasn't met
// (was executed-then-relabelled «discretionary»). Read by ops / the F4 counterfactual report.
export const F1_UNVERIFIED_EXIT_KEY = "unverified_exit_blocked_total";
// F3: greppable marker on an exit executed at a MODELLED price (no live bid on the book). On the real-money
// path this fill would NOT have happened — no bid means not filled — so the sim tags it, letting the P&L cuts
// report what share of realized exits rode a modelled (non-book) fill instead of a real bid.
export const modelFillTag = (fromBook: boolean): string => (fromBook ? "" : " [model_fill]");

/** Parse the OBJECTIVE part (score + minute) of a counter_scenario condition string like
 *  "0:0 к 60' и Аргентина полностью контролирует" → {home:0, away:0, minute:60}. The
 *  qualitative tail ("полностью контролирует") isn't code-checkable and is ignored — but if
 *  the objective part isn't met, the scenario definitionally didn't fire regardless. Returns
 *  null when a clean score+minute can't be extracted (→ caller falls back to the echo check). */
export function parseScoreMinuteCondition(text: string): { home: number; away: number; minute: number } | null {
  const s = text.match(/\b(\d)\s*[:\-]\s*(\d)\b/);
  const mm = text.match(/(\d{1,3})\s*['′]/) ?? text.match(/(?:к|by|до|to|after|через|мин|минут[аеы]?)\s*(\d{1,3})/i);
  if (!s || !mm) return null;
  const home = Number(s[1]), away = Number(s[2]), minute = Number(mm[1]);
  if (![home, away, minute].every(Number.isFinite) || minute < 1 || minute > 130) return null;
  return { home, away, minute };
}

/** A DEFENSIVE trigger tag (counter_scenario / thesis_stop) claims a pre-registered adverse
 *  condition materialised. Audit (Argentina–Switzerland): the strategist tagged exits
 *  `counter_scenario` whose condition ("0:0 к 60'") had NOT occurred (score 1:0, 45'). Two
 *  deterministic checks, strongest first:
 *   (A) STRUCTURED: if the exit plan's counter_scenario_stop yields a parseable score+minute,
 *       verify it against the live facts. Objective part not met → the scenario didn't fire →
 *       demote to `discretionary`, flagged with the concrete mismatch.
 *   (B) ECHO fallback: no parseable condition — a defensive tag whose reason carries no
 *       substance beyond the trigger word is unverified → demote, flagged.
 *  Substantive-reason / objectively-verified defensive exits are kept. Keeps trigger stats
 *  honest (a real firing stays distinguishable from "exited by feel, called it that"). */
export function verifyExitTrigger(
  trigger: string | undefined | null,
  reason: string,
  facts?: { scoreHome?: number | null; scoreAway?: number | null; minute?: number | null; conditionText?: string | null },
): { trigger: string | undefined; flagged: boolean; note?: string } {
  const t = trigger ?? undefined;
  if (!t || !/counter_scenario|thesis_stop/i.test(t)) return { trigger: t, flagged: false };
  // (A) Structured score/minute verification for counter_scenario against the plan's condition.
  if (/counter_scenario/i.test(t) && facts?.conditionText && facts.scoreHome != null && facts.scoreAway != null && facts.minute != null) {
    const cond = parseScoreMinuteCondition(facts.conditionText);
    if (cond) {
      const met = facts.scoreHome === cond.home && facts.scoreAway === cond.away && facts.minute >= cond.minute;
      if (!met) return { trigger: "discretionary", flagged: true, note: `условие «${facts.conditionText.trim()}» не выполнено (счёт ${facts.scoreHome}:${facts.scoreAway}, ${facts.minute}')` };
      return { trigger: t, flagged: false }; // objectively verified
    }
  }
  // (B) Echo fallback: strip the trigger token(s); nothing substantive left → unverified.
  const residue = (reason ?? "").toLowerCase().replace(/counter[_\s]?scenario|thesis[_\s]?stop/gi, "").replace(/[^a-zа-яё0-9]+/gi, " ").trim();
  return residue.length === 0 ? { trigger: "discretionary", flagged: true } : { trigger: t, flagged: false };
}
// A partial TAKE-PROFIT fixation must not repeat on the same position more often than
// this many minutes. The periodic reassessment heartbeat, on a slowly-drifting price,
// otherwise nibbles a position to death — ten partial fixations in 20 min (Norway–England
// BTTS-No, 38¢→55¢). ONLY throttles take-profit: a DEFENSIVE exit (stop / thesis_stop /
// counter_scenario) and a FULL close are NEVER delayed. 0 disables. Env-tunable.
export const PARTIAL_TP_THROTTLE_MIN = (() => { const n = Number(process.env.PARTIAL_TP_THROTTLE_MIN); return Number.isFinite(n) && n >= 0 ? n : 8; })();
// T1.3: a DEFENSIVE partial cut (thesis_stop / counter_scenario) was never throttled — only take-profit was.
// A cascade of them grinds a winner to a loss (León–Atlas: FOUR counter_scenario cuts in 46', a +$59
// settle-winner realized as −$17). Cap defensive partials the same way: a minimum interval between cuts AND
// a hard COUNT cap of defensive cuts between relevant game-state events (a new goal/red resets the window,
// since that IS new information). ≤2 cuts leaves ≤75% of the original closed before the position must ride
// to the next real event / settlement. Env-tunable.
export const DEFENSIVE_CUT_THROTTLE_MIN = (() => { const n = Number(process.env.DEFENSIVE_CUT_THROTTLE_MIN); return Number.isFinite(n) && n >= 0 ? n : 8; })();
export const DEFENSIVE_CUT_MAX = (() => { const n = Number(process.env.DEFENSIVE_CUT_MAX); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2; })();
// An entry's edge was sized against the price the strategist EVALUATED. If the book
// has since moved so the executable fill lands at a rail (≤2¢/≥98¢, effectively
// resolved) or this far from the evaluated price, the market we sized is gone — the
// fill is a phantom/stale book (BTTS-No evaluated at 74.5¢, filled at 1.2¢), not the
// bet the strategist decided. Don't open it. Env-tunable.
// ENTRY_PHANTOM_DIVERGENCE moved to the shared fill engine (./executor/paperFill.js).
// Re-entry cooldown (ms): after a pair CLOSES a market at a LOSS, don't let the live
// reassessment re-enter that same market for this long. Stops the falling-knife churn
// — exit −$5, re-enter lower, exit −$8, repeat — on a noisy/thin book (the Mjallby-Yes
// series). A WINNING close (take-profit) does not cool down: re-buying a dip after
// banking profit is legitimate. Env-tunable.
export const REENTRY_COOLDOWN_MS = (() => { const n = Number(process.env.REENTRY_COOLDOWN_MS); return Number.isFinite(n) && n >= 0 ? n : 600_000; })();

/** A live match that only JUST kicked off — still ~pre-match. True iff the score is
 *  0:0 and kickoff was within the grace window. Uses wall-clock-since-kickoff (from
 *  the reliable kickoff_at), NOT the ESPN clock minute, which can freeze at 0 on a
 *  stuck fixture and would wrongly qualify a match that's really 30' in. */
function justKickedOff(m: Match, nowMs: number): boolean {
  if ((m.score_home ?? 0) !== 0 || (m.score_away ?? 0) !== 0) return false;
  const h = hoursUntil(m.kickoff_at, nowMs);       // null if kickoff unknown → not eligible (conservative)
  if (h == null) return false;
  const minsSinceKickoff = -h * 60;                // kickoff in the past → positive
  return minsSinceKickoff >= 0 && minsSinceKickoff <= EARLY_LIVE_STRATEGIST_GRACE_MIN;
}
// Hours past kickoff after which a clock-only match (ESPN never finished it) is
// auto-finished — generous enough to cover a long match + stoppage/extra time.
export const FINISH_HOURS = 4;
// Hours a clock-only "live" match may run with NO provider live-data coverage
// before it's finished as uncoverable. Well above the enrich cadence (seconds on
// the live loop) so a genuinely covered match is never caught mid-gap — only
// fixtures our provider simply doesn't carry (e.g. tennis Challengers).
export const NO_COVERAGE_GRACE_H = 0.5;
// Per-sport wall-clock ceiling (minutes) for a CLOCK-ONLY live match — one with
// no provider minute at all (we have zero live coverage on it). Past this the
// elapsed-since-kickoff display stops climbing (so an uncovered match never reads
// a nonsense "179'"), and a match carrying no open bets is clock-finished instead
// of hanging "live" for hours. Sports absent here fall back to FINISH_HOURS.
export const SPORT_MAX_LIVE_MIN: Record<string, number> = {
  football: 130, basketball: 160, hockey: 200, tabletennis: 120, esports: 240, tennis: 300,
};
export const maxLiveMinutes = (sport: string): number => SPORT_MAX_LIVE_MIN[sport] ?? FINISH_HOURS * 60;
import type { SportsProvider } from "./sports.js";
import type { Match, MatchState } from "./types.js";

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());
// Prefer the raw ESPN clock ("45'+2'") so logs/reassessments carry stoppage
// time; fall back to the whole-minute figure, then "предматч".
// Match-time label used to STAMP entries/exits/reassessments. For a clock-driven
// live match (no ESPN minute) it computes elapsed minutes from kickoff, so an
// in-match entry reads "63'" not a wrong "предматч".
const minuteLabel = (m: Match, nowMs: number = Date.now()): string => {
  if (m.state !== "live") return "предматч";
  if (m.clock) return m.clock;
  if (m.minute != null) return `${m.minute}'`;
  if (isIsoTs(m.kickoff_at)) return `${Math.max(0, Math.floor((nowMs - Date.parse(m.kickoff_at as string)) / 60000))}'`;
  return "LIVE";
};
const round2 = (n: number) => Math.round(n * 100) / 100;

function activeMatches(db: Database): { comp: string; sport: string; match: Match }[] {
  const out: { comp: string; sport: string; match: Match }[] = [];
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) if (m.state !== "finished") out.push({ comp: c.id, sport: c.sport_id, match: m });
  }
  return out;
}

/** Is any match IN PLAY right now (state "live")? The fast live loop's domain — the
 *  heartbeat uses this to decide whether live position management is the critical
 *  cadence (a stalled live loop during a live match is what actually costs money). */
export function hasLiveMatchInPlay(db: Database): boolean {
  return activeMatches(db).some(({ match: m }) => m.state === "live");
}

// ------------------------------------------------------------
// 0) Advance clocks — flip lineup_out / state from the kickoff time
// ------------------------------------------------------------

/**
 * Drive match state from the kickoff CLOCK for time-scheduled matches (found via
 * Polymarket, no ESPN live feed): upcoming → lineup (~1h before) → LIVE (at
 * kickoff) → finished (well after, if ESPN never finished it and nothing's at
 * risk). Without this a match ESPN can't drive (obscure leagues, most tennis)
 * would sit in "lineup" forever — showing «состав» instead of LIVE, never
 * lighting the live-dot, never capturing the kickoff price baseline, and starving
 * the live-only machinery (reassessment / stats / exits). ESPN stays
 * authoritative when it IS driving a match: those carry a real `minute`, so we
 * never clock-finish them and never regress their state.
 */
export function advanceClocks(db: Database, deps: EngineDeps = {}): void {
  const nowIso = nowFn(deps)();
  const nowMs = Date.parse(nowIso) || Date.now();
  for (const { sport, match: m } of activeMatches(db)) {
    // TENNIS: no provider clock — the SCOUT owns liveness (else the clock flips a match to "live"
    // at its scheduled time even when API-Tennis never sees it in-play, and hasLiveData=false for
    // tennis would then FINISH real in-play matches on the no-coverage grace). Fully scout-driven,
    // then skip the football clock below.
    if (sport === "tennis") {
      const inPlay = tennisScoutInPlay(db, m.id, nowMs);
      if (inPlay) {
        // Backstop: a tennis match "live" past the sport ceiling is a STUCK feed (API-Tennis leaves a
        // finished match at live=1 for hours → the phantom "300'"), not a real match. With NO open
        // position, finish it so it can't sit live forever. A match WITH money on it is left to the
        // get_fixtures poller (authoritative — never mis-finish a real position on a feed glitch).
        const elapsedMin = m.kickoff_at ? (nowMs - (Date.parse(m.kickoff_at) || nowMs)) / 60000 : null;
        if (elapsedMin != null && elapsedMin > maxLiveMinutes("tennis") && !R.betsForMatch(db, m.id).some((b) => b.status === "open")) {
          R.updateMatch(db, m.id, { state: "finished", ...(!m.end_time ? { end_time: nowIso } : {}) });
        } else if (m.state !== "live") {
          R.updateMatch(db, m.id, { state: "live", lineup_out: true });
        }
      } else if (m.state === "live") {
        // Not in-play per the scout. Keep following an OPEN position (settle/exit own it); otherwise
        // a scout FINAL → finished, else a clock-phantom (never started / ended-and-missed) → un-live
        // back to the schedule bucket so the scout can re-drive it if it actually starts.
        if (!R.betsForMatch(db, m.id).some((b) => b.status === "open")) {
          const fin = tennisFinalResult(db, m.id);
          if (fin?.finished) R.updateMatch(db, m.id, { state: "finished", ...(!m.end_time ? { end_time: nowIso } : {}) });
          else { const hh = hoursUntil(m.kickoff_at, nowMs); const back: MatchState = hh != null && hh > 0 && hh <= LINEUP_HOURS ? "lineup" : "upcoming"; R.updateMatch(db, m.id, { state: back, lineup_out: back === "lineup" }); }
        }
      } else if (m.state === "upcoming" || m.state === "lineup") {
        // Pre-live scheduling for display only — NEVER clock-flip tennis to live (only the scout does).
        const hh = hoursUntil(m.kickoff_at, nowMs);
        if (hh != null && hh > 0 && hh <= LINEUP_HOURS && m.state !== "lineup") R.updateMatch(db, m.id, { state: "lineup", lineup_out: true });
      }
      continue;
    }

    const h = hoursUntil(m.kickoff_at, nowMs);
    if (h == null) continue;

    // Uncovered-finish: a clock-only "live" match (no provider minute) that, after
    // a grace window, still has NO live-data coverage — our provider doesn't carry
    // this fixture (e.g. a tennis Challenger StatPal only lists main-tour). We can
    // neither follow nor trade it, so finish it instead of letting it run a phantom
    // clock forever. Grace ≫ enrich cadence, so a covered match (which gets a
    // match_live marker within a tick or two of going live) is never caught here.
    if (m.state === "live" && m.minute == null && h <= -NO_COVERAGE_GRACE_H
        && !hasLiveData(db, m)
        && !R.betsForMatch(db, m.id).some((b) => b.status === "open")) {
      R.updateMatch(db, m.id, { state: "finished", final_score: m.final_score ?? null, ...(!m.end_time ? finishStamp(m.kickoff_at, nowIso) : {}) });
      continue;
    }

    // Clock-finish: a clock-only match (no ESPN minute) past its sport's live
    // ceiling that ESPN never finished. Only when it holds NO open bets (unfunded
    // discovered matches) — never strand a position; the prune then cleans it up.
    // ESPN matches (minute set) are finished by ESPN, never by the clock.
    if (m.state === "live" && m.minute == null && h <= -(maxLiveMinutes(sport) / 60)
        && !R.betsForMatch(db, m.id).some((b) => b.status === "open")) {
      R.updateMatch(db, m.id, { state: "finished", final_score: m.final_score ?? null, ...(!m.end_time ? finishStamp(m.kickoff_at, nowIso) : {}) });
      continue;
    }

    // Postponed / rescheduled: a CLOCK-driven "live" match (no real provider
    // minute) whose kickoff is now in the FUTURE was moved — it isn't live.
    // Revert so the clock re-drives it from the new time (discovery refreshes
    // kickoff_at from Polymarket). Provider-confirmed live (minute set) is never
    // touched here. Bets stay; only the state/label changes.
    if (m.state === "live" && m.minute == null && h > 0) {
      const back: MatchState = h <= LINEUP_HOURS ? "lineup" : "upcoming";
      R.updateMatch(db, m.id, { state: back, lineup_out: h <= LINEUP_HOURS });
      continue;
    }

    // Only TIME-schedule the pre-live states; ESPN owns live/finished once it drives.
    if (m.state !== "upcoming" && m.state !== "lineup") continue;
    let nextState: MatchState, lineupOut: boolean;
    if (h <= 0) { nextState = "live"; lineupOut = true; }             // kicked off
    else if (h <= LINEUP_HOURS) { nextState = "lineup"; lineupOut = true; }
    else { nextState = "upcoming"; lineupOut = false; }
    if (nextState !== m.state || lineupOut !== m.lineup_out) {
      R.updateMatch(db, m.id, { state: nextState, lineup_out: lineupOut });
    }
  }
}

// ------------------------------------------------------------
// 1) Auto-analyze
// ------------------------------------------------------------

export interface AutoAnalyzeItem { matchId: string; match: string; stage: string; ok: boolean; bets: number }

/**
 * Analyze matches that have tradeable odds, belong to a FUNDED competition
 * (budget > 0 — no point spending LLM on matches no strategy can bet), and
 * haven't been analyzed for their current stage. Capped per run so a tick over
 * hundreds of discovered matches doesn't fire hundreds of model calls.
 */
export async function autoAnalyze(db: Database, deps: EngineDeps = {}, opts: { max?: number; liveOnly?: boolean } = {}): Promise<AutoAnalyzeItem[]> {
  // How many matches to analyse per pass. Bounded so one tick's LLM burst can't spike memory
  // on the small instance; env-tunable (ANALYZE_MAX_PER_TICK) to raise throughput on busy days.
  const max = opts.max ?? Math.max(1, Number(process.env.ANALYZE_MAX_PER_TICK) || 6);
  const nowMs = Date.parse(nowFn(deps)()) || Date.now();
  const budgetByComp = new Map(R.listCompetitions(db).map((c) => [c.id, c.budget]));
  const sportByComp = new Map(R.listCompetitions(db).map((c) => [c.id, c.sport_id]));
  const out: AutoAnalyzeItem[] = [];
  // PRIORITY: analyse the SOONEST-kickoff matches first. We only do `max` per pass, and matches
  // are otherwise iterated in competition/insertion order — so a match kicking off in 30 min could
  // sit behind ones that start next week and never get analysed before its whistle (the "AI didn't
  // auto-start" case). Sorting by kickoff ascending puts live + imminent matches at the front; a
  // missing/invalid kickoff sinks to the back. Live matches (kickoff in the past) naturally lead.
  const queue = activeMatches(db)
    .map((x) => ({ ...x, kickMs: x.match.kickoff_at ? (Date.parse(x.match.kickoff_at) || Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.kickMs - b.kickMs);
  for (const { comp, match: m } of queue) {
    if (out.length >= max) break;
    if (opts.liveOnly && m.state !== "live") continue;             // live-cycle back-fill: only rescue live-but-unanalysed matches
    if ((budgetByComp.get(comp) ?? 0) <= 0) continue;              // unfunded → skip (economical)
    if (!R.latestMarkets(db, m.id).length) continue;               // needs tradeable odds
    // Football (lineup-sport): NO analysis until the real starting XI is out — без составов
    // и без лайва не торгуем, поэтому и анализировать нечего (autoEnter всё равно держит вход
    // до составов). Silently skip; it becomes eligible the tick after the provider publishes
    // lineups. A live match is never held (awaitingLineup is false once state=live).
    if (R.awaitingLineup(db, m, sportByComp.get(comp) ?? "football")) continue;
    const stage = m.lineup_out ? "post_lineup" : "pre_lineup";
    // Time gate: pre-match assessment only within ~12h of kickoff. Matches with no known
    // kickoff (e.g. an ESPN live match) aren't gated.
    const h = hoursUntil(m.kickoff_at, nowMs);
    if (stage === "pre_lineup" && h != null && h > ANALYZE_PRE_HOURS) continue;
    if (R.assessmentsForMatch(db, m.id).some((a) => a.stage === stage && a.status === "ok")) continue; // already done this stage
    if (jobActive(R.getAnalysisJob(db, m.id), Date.now())) continue; // a run is in flight
    // A LIVE match reaching analysis here was NEVER analysed pre-kickoff (e.g. a
    // scheduler gap spanned kickoff). Produce the analysis so the live reassessment
    // isn't blind, and SKIP the pre-match strategist pass — live entries belong to
    // the live-window reassessment (its own prompt), not a stale pre-match proposal.
    // EXCEPTION: if the match only just kicked off (justKickedOff — 0:0, within the
    // grace of the whistle, prices still pre-match), give the pre-match strategist
    // its one shot; forfeiting it would leave the match wholly un-traded.
    const skipStrat = m.state === "live" && !justKickedOff(m, nowMs);
    const r = await analyzeMatch(db, m.id, deps, { skipStrategists: skipStrat });
    out.push({ matchId: m.id, match: `${m.home}–${m.away}`, stage, ok: r.ok, bets: r.betsCreated ?? 0 });
  }
  return out;
}

export interface AutoStrategistItem { matchId: string; match: string; bets: number }
/**
 * Unified strategist engine — the RE-RUN pass. For an already-analysed, funded,
 * NON-live match whose CURRENT (strategy, profile) roster hasn't produced a
 * battle_sheet yet (e.g. right after the roster/shares changed), re-run the
 * strategists off the stored analysis — WITHOUT re-running the expensive LLM
 * analysis. The per-pair battle_sheet artifact is the "already ran" marker, so
 * this self-limits: once every current pair has one, the match is skipped.
 */
export async function autoRunStrategists(db: Database, deps: EngineDeps = {}, opts: { max?: number } = {}): Promise<AutoStrategistItem[]> {
  const max = opts.max ?? 6;
  const budgetByComp = new Map(R.listCompetitions(db).map((c) => [c.id, c.budget]));
  const strategyById = new Map(R.listStrategies(db).map((s) => [s.id, s]));
  const out: AutoStrategistItem[] = [];
  for (const { comp, sport, match: m } of activeMatches(db)) {
    if (out.length >= max) break;
    if (m.state === "live" || m.state === "finished") continue;      // live is the reassess/live-executor path
    if ((budgetByComp.get(comp) ?? 0) <= 0) continue;
    if (!R.latestMarkets(db, m.id).length) continue;
    if (!R.assessmentsForMatch(db, m.id).some((a) => a.status === "ok")) continue; // not analysed yet → autoAnalyze handles it
    if (jobActive(R.getAnalysisJob(db, m.id), Date.now())) continue;   // analysis in flight
    // Build the expected-pair set the SAME way the producer (runStrategists) does:
    // strategies of the comp's sport only. Otherwise a cross-sport share would
    // expect a battle_sheet the producer never emits → the marker never completes
    // → re-run every tick.
    const pairs = R.sharesForComp(db, comp)
      .filter((sh) => sh.pct > 0 && strategyById.get(sh.strategy_id)?.sport_id === sport)
      .map((sh) => `${strategyById.get(sh.strategy_id)!.name} · ${sh.risk_profile_id}`);
    if (!pairs.length) continue;
    const sheets = new Set(R.artifactsForMatch(db, m.id).filter((a) => a.kind === "battle_sheet").map((a) => a.label));
    if (pairs.every((p) => sheets.has(p))) continue;                  // current roster already ran here
    const r = await runStrategists(db, m.id, deps);
    out.push({ matchId: m.id, match: `${m.home}–${m.away}`, bets: r.betsCreated });
  }
  return out;
}

// ------------------------------------------------------------
// 2) Auto-enter (paper fill proposed bets)
// ------------------------------------------------------------

export interface AutoEnterItem { matchId: string; strategyId: string; market: string; price: number; stake: number }

// Sports where a confirmed starting lineup materially changes the read
// (R.LINEUP_SPORTS) drive the pre-match capital hold below.

// A match has LIVE-DATA coverage once our provider has actually matched the
// fixture: real lineups/stats (a match_live row), a real in-match event
// (goal/card/… — NOT our own "stats"/"other" price snapshots), or a
// provider-driven live minute. No coverage means we can't follow or manage the
// position in play — opening one would be blind capital that bleeds — so entry is
// forbidden. A clock-only "live" match (minute null, no provider row) is NOT
// covered.
// Is the fixture provider-TRACKED at all — real lineups/stats (a match_live row), a
// real in-match event, or a provider-driven minute? Used by advanceClocks to decide
// a clock-only match is uncovered (our provider doesn't carry it) and can be
// finished. A lineup-only match_live counts here (the provider knows the fixture),
// which is exactly right for "don't clock-finish a match ESPN will deliver soon".
// For "is the provider actually DELIVERING live state right now" (the entry gate),
// see liveDelivering — a lineup-only row is NOT enough there.
export function hasLiveData(db: Database, m: Match): boolean {
  if (R.getMatchLive(db, m.id)) return true;
  if (m.state === "live" && m.minute != null) return true;
  return R.eventsForMatch(db, m.id).some((e) => e.type !== "stats" && e.type !== "other");
}

/** Is the provider actually DELIVERING live in-play state for this match right now
 *  (not just tracking the fixture)? The entry gate for a LIVE match: a fixture our
 *  clock flipped to "live" while the provider still shows "pre" (frozen at 0', no
 *  stats/events — a lagging or uncovered in-play feed) has a match_live row from its
 *  published lineups but ISN'T live — filling there is blind in-play capital. Require
 *  a real signal: an in-match event, live STATS (ESPN populates these only in-play),
 *  or a provider minute past 0. Non-lineup sports write match_live only from the live
 *  board, so the row itself is the signal there. */
export function liveDelivering(db: Database, m: Match, sport: string): boolean {
  // Real in-match event (goal/card/…) — the strongest, unforgeable proof.
  if (R.eventsForMatch(db, m.id).some((e) => e.type !== "stats" && e.type !== "other")) return true;
  // Tennis has NO provider clock and writes NO match_live row — the SCOUT is authoritative for
  // liveness (same source advanceClocks flips state on). Prove delivery from a fresh live snapshot,
  // else every live tennis match reads a permanent misleading «ждём данные».
  if (sport === "tennis") return tennisScoutInPlay(db, m.id, Date.now());
  // Non-lineup sports write match_live only from the live board, so the row is the signal.
  if (!R.LINEUP_SPORTS.has(sport)) return !!R.getMatchLive(db, m.id);
  // Football: the ONLY reliable "provider is delivering in-play" signal is a real
  // ADVANCING minute. NOT match_live.stats — ESPN returns a zeros stats object even
  // for a fixture it still shows as "pre" (Orlando–Kansas sat at 0' for 28min with a
  // stats row), which false-positived this gate. A real live match always carries a
  // provider minute > 0; a frozen/pre one does not.
  return m.state === "live" && m.minute != null && m.minute > 0;
}

/** Single source of truth for "does this token have a REAL, tradeable order book" —
 *  used by BOTH the entry gate (executeEntry) and the exit phantom guard (sellVwapCents)
 *  so "no real book" means the same thing on both sides of a position's life cycle
 *  (the untradeable-market gate). Classification:
 *    ok          — live levels present → trade against the book
 *    empty        — fetch OK but no/dead book → PLACEHOLDER market; never trade it
 *                   (don't parametric-enter, don't mark an exit off a modelled price)
 *    unavailable — the fetch failed → skip THIS cycle and retry next (a network hiccup
 *                   must never read as a permanently untradeable market)
 *  A missing CLOB token is treated as `empty`: there is no real market to trade.
 *  Per-token result is cached for the cycle so two profiles on one market fetch once. */
// The fill ENGINE (classifyOrderBook / paperBuyFill / paperSellFill / FillCost /
// scaleCost) lives in ./executor/paperFill.js so football and tennis share ONE model.
// executeEntry / sellVwapCents below are thin football-facing wrappers over it.
type EntryExec = EntryFillResult;

/** Persist a fill's cost breakdown to the ledger. Observe-only; never throws into a fill. */
function recordFill(db: Database, ids: { betId: string | null; matchId: string; competitionId: string; strategyId: string; profileId: string }, cost: FillCost, now: string): void {
  try {
    R.insertFillCost(db, {
      id: R.uid(), bet_id: ids.betId, match_id: ids.matchId, competition_id: ids.competitionId,
      strategy_id: ids.strategyId, profile_id: ids.profileId, side: cost.side,
      shares: round2(cost.shares), notional_usd: round2(cost.notionalUsd),
      quote_cents: cost.quoteCents, vwap_cents: cost.vwapCents,
      fee_cents: cost.feeCents, fee_usd: round2(cost.feeUsd),
      slip_cents: cost.slipCents, slip_usd: round2(cost.slipUsd),
      from_book: cost.fromBook ? 1 : 0, created_at: now,
    });
  } catch { /* cost ledger is observe-only, never break a real fill */ }
}

/** Football entry fill — thin wrapper over the shared paper fill engine. Reads the
 *  decision context off the Bet/Market (fair = ai_prob, phantom ref = proposed_price)
 *  and delegates the book-VWAP + edge-floor + phantom logic to paperBuyFill. */
async function executeEntry(
  b: Bet, mk: Market | undefined, quoteCents: number, proposedUsd: number,
  poly: PolymarketConfig, deps: EngineDeps,
  bookCache?: Map<string, OrderBookFetch>,
): Promise<EntryExec> {
  if (!poly.enabled) return { skip: false, priceCents: quoteCents, stake: proposedUsd }; // execution model off → quote fill
  const fairCents = (b.ai_prob ?? 0) * 100;
  const token = mk?.external_ref ?? null;
  const ref = b.proposed_price ?? quoteCents; // strategist-evaluated price → phantom reference
  const bookRes = await classifyOrderBook(token, poly, deps, bookCache);
  return paperBuyFill(bookRes, proposedUsd, fairCents, ref, quoteCents, poly.exec, ENTRY_PHANTOM_DIVERGENCE);
}

const appendReason = (existing: string | null, note?: string): string =>
  [existing, note].filter(Boolean).join(" · ");

/** Realistic exit price: sell the closed position's shares into the bid side of
 *  the real book (VWAP), so exit slippage is booked into P&L. Only called when a
 *  close is actually happening, so the book fetch stays bounded. `basisUsd` is the
 *  stake being closed (full or partial). Falls back to a parametric haircut, or
 *  (execution off) the passed quote. */
async function sellVwapCents(
  mk: Market | undefined, entryCents: number, basisUsd: number,
  poly: PolymarketConfig, deps: EngineDeps, quoteCents: number,
  bookCache?: Map<string, OrderBookFetch>,
): Promise<SellFillResult> {
  if (!poly.enabled) return { cents: quoteCents, fromBook: false, filledShares: 0, requestedShares: 0 };
  const token = mk?.external_ref ?? null;
  const shares = entryCents > 0 ? basisUsd / (entryCents / 100) : 0;
  // SAME single-source classification as the entry gate, so "no real book" is decided
  // identically on both sides of a position (the book is per-TOKEN — cache shared).
  const bookRes: OrderBookFetch = shares > 0 ? await classifyOrderBook(token, poly, deps, bookCache) : { status: "empty" };
  const liq = Number(mk?.liquidity ?? 0) || 0;
  return paperSellFill(bookRes, shares, basisUsd, quoteCents, liq, poly.exec);
}

export async function autoEnter(db: Database, deps: EngineDeps = {}): Promise<AutoEnterItem[]> {
  const now = nowFn(deps)();
  const poly = deps.polymarket ?? loadPolymarketConfig(deps.env);
  const out: AutoEnterItem[] = [];
  // Per-token order-book cache for the whole entry cycle: two profiles of one strategy
  // filling the same market must not each hit the (uncached) CLOB endpoint.
  const bookCache = new Map<string, OrderBookFetch>();
  // Shadow allocator: collect this cycle's real fills, then evaluate them as ONE batch
  // against the shared limited bank (observe-only — never changes what actually filled).
  const shadowReqs: ShadowEntryRequest[] = [];
  for (const { sport, match: m } of activeMatches(db)) {
    // Don't DEPLOY capital on a lineup-sport match before its lineups are out —
    // pre-lineup we still analyze and PROPOSE possible bets (shown as
    // «предлагается»), but they only fill once the lineup lands (lineup_out) or
    // the match is live. This keeps the pre-match read a preview, not an entry.
    const preLineupHold = R.LINEUP_SPORTS.has(sport) && !m.lineup_out && (m.state === "upcoming" || m.state === "lineup");
    const markets = R.latestMarkets(db, m.id);
    if (!markets.length) continue; // no quotes → nothing tradeable, no entry
    // Never open a position we can't follow. A PRE-kickoff fill (lineups out,
    // upcoming/lineup) only needs the fixture confirmed (hasLiveData). A LIVE-state
    // fill needs the provider to be actually DELIVERING in-play data (liveDelivering)
    // — otherwise a fixture our clock flipped to "live" while ESPN still shows "pre"
    // (frozen 0', no stats/events) would take blind in-play capital we can't manage.
    const liveData = m.state === "live" ? liveDelivering(db, m, sport) : hasLiveData(db, m);
    const bets = R.betsForMatch(db, m.id);
    // A (strategy, PROFILE) pair must never hold two OPEN positions on the SAME
    // market — that's the double-exposure a concurrent analyze/reassess race (or
    // analyze+reassess in one cycle) could otherwise fill. Keyed by PAIR, not
    // strategy: the same strategy funded under two profiles is a separate trading
    // unit (we simulate strategy+profile independently), so each may hold the
    // market with its own size. This single choke point guards it regardless of
    // how duplicate proposals were created.
    const pairMkt = (b: typeof bets[number]) => `${b.strategy_id}|${b.risk_profile_id ?? "medium"}|${b.market_label}`;
    const openKey = new Set(bets.filter((b) => b.status === "open").map(pairMkt));
    // P1 ZOMBIE QUARANTINE at the single fill choke: every proposal (prematch + live-reassess) passes here, so
    // blocking a quarantined book once here covers ALL entry consumers. No-op off football-live.
    const zMinute = m.minute ?? (isIsoTs(m.kickoff_at) ? Math.min(maxLiveMinutes(sport), Math.max(0, Math.floor(((Date.parse(now) || Date.now()) - Date.parse(m.kickoff_at as string)) / 60_000))) : null);
    const zombie = footballZombieMap(db, m, sport, markets, zMinute, deps.env ?? process.env, now);
    for (const b of bets) {
      if (b.status !== "proposed") continue;
      if (preLineupHold) continue; // preview only — keep it «предлагается» until lineups are out
      if (!liveData) continue; // no provider live coverage → hold as «предлагается», never fill blind
      const key = pairMkt(b);
      if (openKey.has(key)) { R.updateBet(db, b.id, { status: "not_filled" }); continue; } // already in this market — drop the dup
      const mk = markets.find((x) => x.label === b.market_label);
      const quote = mk?.price ?? b.proposed_price ?? 0;
      if (quote <= 0) continue;
      // P1: refuse a fill on a quarantined book — the quote isn't a real tradeable price (feeds unfillable_edge).
      const zr = zombie.get(b.market_label);
      if (zr) {
        // Z1: the not_filled status + rationale still records WHY on the bet; the per-tick trade-log line here
        // was redundant with footballZombieMap's episode line (throttleZombieLog) and drove ~44k of the storm.
        R.updateBet(db, b.id, { status: "not_filled", rationale: appendReason(b.rationale, `zombie_quarantine:${zr.code} — ${zr.detail}`) });
        continue;
      }
      const proposed = b.stake ?? 0;

      // Execute against the real order book: fill at VWAP (slippage), cap the size
      // to what the book can absorb while keeping edge AND not moving the price too
      // far (market impact). This is what stops a big stake from eating its own
      // edge on a thin market. Falls back to a parametric model, or (execution off)
      // the quote itself.
      const ex = await executeEntry(b, mk, quote, proposed, poly, deps, bookCache);
      // retry: a TRANSIENT reason not to fill (order book momentarily unavailable / no ask
      // offers) — leave the proposal untouched so the next cycle re-attempts it. A plain
      // skip is TERMINAL (phantom fill, edge gone, placeholder market) → mark not_filled.
      if (ex.skip) {
        if (!ex.retry) R.updateBet(db, b.id, { status: "not_filled", rationale: appendReason(b.rationale, ex.note) });
        continue;
      }
      // P0.2 MIN-DEPTH FLOOR: the book absorbed a CLAMPED fill below the floor — the depth to trade
      // meaningfully isn't there. Skip (don't open a dust position, Bohemian $80→$14). Feeds unfillable_edge.
      const MIN_DEPTH = Math.max(1, Number((deps.env ?? process.env).FOOTBALL_MIN_DEPTH_USD ?? 50));
      if (ex.clamped && ex.stake < MIN_DEPTH) {
        R.updateBet(db, b.id, { status: "not_filled", rationale: appendReason(b.rationale, `depth_floor_skip: книга дала лишь $${ex.stake} < floor $${MIN_DEPTH} — глубины нет`) });
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "skip", text: `depth_floor_skip «${b.market_label}»: клэмп $${ex.stake} < floor $${MIN_DEPTH} — вход отклонён`, created_at: now });
        continue;
      }
      // P0.2 STALE-PROPOSAL: the fill landed far from the price the decision was sized on (Bohemian
      // 11¢→4¢) — the quote was stale / the market moved, so the fill no longer matches the decision.
      // Block. Same runtime invariant as the tennis band-re-check («исполнение соответствует решению»).
      const proposedC = b.proposed_price ?? quote;
      const drift = proposalDrift(proposedC, ex.priceCents);
      if (isStaleProposal(proposedC, ex.priceCents, deps.env ?? process.env)) {
        R.updateBet(db, b.id, { status: "not_filled", rationale: appendReason(b.rationale, `stale_proposal: филл ${ex.priceCents}¢ vs предложение ${proposedC}¢ (Δ${drift.toFixed(0)}¢)`) });
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "skip", text: `stale_proposal «${b.market_label}»: филл ${ex.priceCents}¢ vs предложение ${proposedC}¢ (Δ${drift.toFixed(0)}¢) — рынок ушёл, вход отклонён`, created_at: now });
        continue;
      }

      R.updateBet(db, b.id, { status: "open", entry_price: ex.priceCents, current_price: ex.priceCents, stake: ex.stake, entered_minute: minuteLabel(m) });
      openKey.add(key);
      // Augment the decision-time snapshot with what's only known at FILL: the actual
      // filled size and the entry slippage (measurement only — no money-path effect).
      const em = parseEntryMeta(b.entry_meta);
      if (em) {
        em.sizeFilled = ex.stake;
        if (ex.cost) em.entrySlipCents = ex.cost.slipCents;
        R.updateBet(db, b.id, { entry_meta: serializeEntryMeta(em) });
      }
      if (ex.cost) recordFill(db, { betId: b.id, matchId: m.id, competitionId: m.competition_id, strategyId: b.strategy_id, profileId: b.risk_profile_id ?? "medium" }, ex.cost, now);
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "enter", text: `вход «${b.market_label}» @ ${ex.priceCents}¢ · $${ex.stake}${ex.note ? ` · ${ex.note}` : ""}`, created_at: now });
      out.push({ matchId: m.id, strategyId: b.strategy_id, market: b.market_label, price: ex.priceCents, stake: ex.stake });
      // Mirror this fill into the shadow batch. edge = our prob − executed price; a fill
      // while the match is already live counts as a live-triggered entry (live_buffer).
      // intensity = the budget-INDEPENDENT pre-cap Kelly×edge fraction (size / sizing-base),
      // exactly as sizePrematch computes it — so the shadow projection can re-size the entry
      // against a bank-derived base instead of the isolated $1000 pair budget.
      const pcfg = getProfileConfig(db, b.risk_profile_id ?? "medium");
      const pp = ex.priceCents / 100, ourP = b.ai_prob ?? 0;
      const kEdge = pp > 0 && pp < 1 ? (ourP - pp) / (1 - pp) : 0;
      const kFrac = Math.min(Math.max(pcfg.sizing.kelly_fraction_base, pcfg.sizing.kelly_fraction_clamp[0]), pcfg.sizing.kelly_fraction_clamp[1]);
      const intensity = kEdge > 0 ? Math.min(kFrac * kEdge, pcfg.sizing.max_position_pct) : 0;
      shadowReqs.push({
        betId: b.id, matchId: m.id, competitionId: m.competition_id, strategyId: b.strategy_id,
        profileId: b.risk_profile_id ?? "medium", size: ex.stake, edge: round2((b.ai_prob ?? 0) - ex.priceCents / 100),
        isLive: m.state === "live", intensity: Math.round(intensity * 10000) / 10000,
      });
      // §5 REAL MIRROR (build != enable): mirror this FILLED football entry into the real contour.
      // GATE-FIRST — the pure env read below skips ALL of it (no ctx build, no DB, no book) in the prod
      // default (off), keeping autoEnter's hot path free. Isolated inside mirrorPaperEntryToReal: any
      // failure degrades to paper-only. Only football reaches here (sport gate is also enforced inside).
      if (readTradingMode(deps.env) !== "off" && sport === "football") {
        // A1 (audit #12): the ENTIRE mirror path — including the support reads getBet / dryVirtualFreeUsd
        // — is wrapped here, so ANY throw (incl. SQLITE_BUSY on a read) degrades to paper-only and NEVER
        // breaks the paper loop. Before, those reads sat outside the mirror's try/catch and a DB hiccup
        // could abort autoEnter for the rest of the cycle.
        const mirrorLog = (msg: string) => { try { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "skip", text: `real-mirror: ${msg}`, created_at: now }); } catch { /* logger must not throw */ } };
        try {
          const fresh = R.getBet(db, b.id);
          if (fresh) await mirrorPaperEntryToReal(db, fresh, {
            env: deps.env ?? process.env, poly, deps, now: () => now, bookCache,
            sport, categoryId: m.competition_id, tokenId: mk?.external_ref ?? "",
            sizeFraction: Math.round(intensity * 10000) / 10000, realFreeUsd: dryVirtualFreeUsd(db, deps.env ?? process.env),
            onError: mirrorLog,
          });
        } catch (e) { mirrorLog(`support-read failed (paper unaffected): ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
  }
  try { if (shadowReqs.length) shadowOnEntries(db, shadowReqs, loadShadowConfig(db, deps.env), now); } catch { /* observe-only, never break real entries */ }
  return out;
}

// ------------------------------------------------------------
// 3) Evaluate exits (close open positions early, at market)
// ------------------------------------------------------------

export interface ExitItem { matchId: string; strategyId: string; market: string; reason: string; pnl: number }

/** Close a single open bet fully at the current price (cash out the position). */
function closeBetEarly(db: Database, bet: { id: string; stake: number | null; entry_price: number | null }, currentPriceCents: number, reason: string, minute: string, now: string): number {
  // Re-read under the current DB state: two concurrent reassess flows (double
  // click / two tabs / a manual reassess overlapping the scheduler) snapshot the
  // same open bet BEFORE the LLM await, then both try to close it. Fresh-read so
  // a bet already settled is a no-op (no double-settle) and we use the fresh stake.
  const fresh = R.getBet(db, bet.id);
  if (!fresh || fresh.status !== "open") return 0;
  const stake = fresh.stake ?? 0;
  const entry = fresh.entry_price ?? 0;
  const payout = entry > 0 ? round2(stake * (currentPriceCents / entry)) : 0;
  const pnl = round2(payout - stake);
  // "early" cash-out: booked by P&L sign, NOT by real outcome — excluded from
  // the predictive metrics (Brier/CLV) so trading P&L doesn't masquerade as
  // prediction accuracy. A breakeven (pnl==0) is a PUSH — settled_void/result
  // null — not a "win": counting it as won inflates the strategy's win-rate.
  R.updateBet(db, bet.id, { status: pnl > 0 ? "settled_won" : pnl < 0 ? "settled_lost" : "settled_void", result: pnl > 0 ? "won" : pnl < 0 ? "lost" : null, payout, closing_price: currentPriceCents, settled_by: "early", settled_at: now });
  try { shadowOnExit(db, bet.id, 1, loadShadowConfig(db), now); } catch { /* shadow is observe-only, never break a real close */ }
  return pnl;
}

/**
 * Close a FRACTION of an open position (partial fixation, §4.2). fraction>=1 is
 * a full close; otherwise the closed slice is booked as a settled child bet and
 * the original open bet's stake shrinks by that slice, leaving the rest running.
 */
function closeBetPortion(db: Database, bet: any, fraction: number, currentPriceCents: number, minute: string, now: string, tag?: string): { pnl: number; partial: boolean } {
  if (fraction >= 1) return { pnl: closeBetEarly(db, bet, currentPriceCents, "", minute, now), partial: false };
  // Re-read: another flow may have already (partially) closed this position
  // during our LLM await. Skip if no longer open; size the slice off the FRESH
  // stake so two concurrent partial closes can't over-close (phantom exposure).
  const fresh = R.getBet(db, bet.id);
  if (!fresh || fresh.status !== "open") return { pnl: 0, partial: false };
  bet = fresh;
  const stake = bet.stake ?? 0, entry = bet.entry_price ?? 0;
  const closed = round2(stake * fraction);
  if (closed <= 0 || entry <= 0) return { pnl: closeBetEarly(db, bet, currentPriceCents, "", minute, now), partial: false };
  const payout = round2(closed * (currentPriceCents / entry));
  const pnl = round2(payout - closed);
  R.insertBet(db, {
    id: R.uid(), match_id: bet.match_id, strategy_id: bet.strategy_id, risk_profile_id: bet.risk_profile_id ?? "medium",
    market_label: bet.market_label,
    status: pnl > 0 ? "settled_won" : pnl < 0 ? "settled_lost" : "settled_void", proposed_price: bet.proposed_price, entry_price: entry,
    current_price: currentPriceCents, closing_price: currentPriceCents, ai_prob: bet.ai_prob, stake: closed,
    rationale: `частичная фиксация ${Math.round(fraction * 100)}%${tag ? ` [${tag}]` : ""}`, entered_minute: bet.entered_minute,
    result: pnl > 0 ? "won" : pnl < 0 ? "lost" : null, payout, settled_by: "partial", settled_at: now, created_at: now,
  });
  // T3.4: refresh the remaining leg's mark to THIS fill's price too — a partial that leaves the remainder on a
  // stale `тек` from before the cut is what made the Cruz Azul twins read as a divergence (two rows carrying
  // one carried-forward price). The settled child already stamps its own exec price; now the remainder does.
  R.updateBet(db, bet.id, { stake: round2(stake - closed), current_price: currentPriceCents }); // keep the remainder open
  try { shadowOnExit(db, bet.id, fraction, loadShadowConfig(db), now); } catch { /* observe-only */ }
  return { pnl, partial: true };
}

/**
 * P0.6 GAP-WAKE reprice sweep — resolves the deferrals armed at the stop-point. Runs before the main exit
 * loop, independent of match-delivering state (a watched position in a now-lagging match must still resolve).
 * Per open watch: (a) the position's declared thesis INVALIDATOR now met on fresh state → execute the stop
 * immediately; (b) price back at/above the wake floor → RECOVERED, normal management resumes (no forced stop);
 * (c) window expired (≤repriceSec OR repriceTicks) and price still below floor → execute the stop
 * UNCONDITIONALLY at the current price (never cancelled, only delayed). Each resolution records the delta vs
 * the gap-bottom wake price so the window self-measures its own verdict. B8 preserved: no slippage cap on the
 * protective fill — we give the book ONE short chance to unclench, we don't cap the price.
 */
async function gapRepriceSweep(db: Database, deps: EngineDeps, poly: PolymarketConfig, bookCache: Map<string, OrderBookFetch>, nowMs: number, now: string): Promise<ExitItem[]> {
  const out: ExitItem[] = [];
  const watches = R.openGapReprices(db);
  if (!watches.length) return out;
  const { repriceTicks } = gapRepriceConfig(deps.env ?? process.env);
  const touched = new Set<string>();
  for (const w of watches) {
    const b = R.getBet(db, w.bet_id);
    if (!b || b.status !== "open") { // closed elsewhere (settled / manual) → GC, no measurement
      R.resolveGapReprice(db, w.bet_id, { outcome: "expired", execCents: w.wake_price_cents, deltaCents: 0, at: now }); continue;
    }
    const m = R.getMatch(db, w.match_id);
    if (!m) continue;
    const mk = R.latestMarkets(db, m.id).find((x) => x.label === b.market_label);
    if (!mk || mk.price == null || b.entry_price == null) continue;
    const sell = await sellVwapCents(mk, b.entry_price, b.stake ?? 0, poly, deps, mk.price, bookCache);
    const minNum = m.minute != null ? m.minute : (isIsoTs(m.kickoff_at) ? Math.max(0, Math.floor((nowMs - Date.parse(m.kickoff_at as string)) / 60_000)) : 0);
    const strat = R.getStrategy(db, b.strategy_id);
    const prof = b.risk_profile_id ?? "medium";
    const fill = (reasonTag: string) => {
      const pnl = closeBetEarly(db, b, sell.cents, reasonTag, minuteLabel(m), now);
      if (sell.cost) recordFill(db, { betId: b.id, matchId: m.id, competitionId: m.competition_id, strategyId: b.strategy_id, profileId: prof }, sell.cost, now);
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "exit", text: `выход «${b.market_label}» @ ${sell.cents}¢ · ${reasonTag}${sell.note ? ` · ${sell.note}` : ""}${modelFillTag(sell.fromBook)} · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, created_at: now });
      out.push({ matchId: m.id, strategyId: b.strategy_id, market: b.market_label, reason: reasonTag, pnl });
      touched.add(b.strategy_id);
    };
    // (a) invalidator materialised during the wait → immediate unconditional exit.
    if (strat && gapWakeInvalidatorMet(db, m, strat.name, prof, b.market_label, minNum)) {
      R.resolveGapReprice(db, w.bet_id, { outcome: "expired", execCents: sell.cents, deltaCents: round1(sell.cents - w.wake_price_cents), at: now });
      fill(`gap-wake стоп: инвалидатор тезиса сработал за время ожидания — немедленный выход (gap_wake_invalidator)`); continue;
    }
    // (b) the protective stop no longer fires on the fresh executable price → the dislocation eased; drop the
    //     deferral and keep the position under normal management (recovered).
    const rex = getProfileConfig(db, prof).exits;
    const rd = exitDecision({ params: { takeProfit: rex.take_profit_pct, exitStop: rex.hard_stop_pct, edgeExit: false }, aiProb: b.ai_prob ?? 1, entryPriceCents: b.entry_price, currentPriceCents: sell.cents });
    if (!(rd.exit && rd.kind === "stop")) {
      R.resolveGapReprice(db, w.bet_id, { outcome: "recovered", execCents: sell.cents, deltaCents: round1(sell.cents - w.wake_price_cents), at: now });
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "hold", text: `gap-wake: стоп по «${b.market_label}» снят — цена ${sell.cents}¢ вернулась выше уровня стопа, книга разжалась, штатное управление (gap_wake_recovered)`, created_at: now });
      continue;
    }
    // (c) window: count this tick; execute unconditionally once expired (≤repriceSec OR repriceTicks).
    const ticks = R.bumpGapRepriceTick(db, w.bet_id);
    if (nowMs >= Date.parse(w.deadline_at) || ticks >= repriceTicks) {
      R.resolveGapReprice(db, w.bet_id, { outcome: "expired", execCents: sell.cents, deltaCents: round1(sell.cents - w.wake_price_cents), at: now });
      fill(`gap-wake стоп: окно репрайса истекло (${ticks} тик(ов)), цена ${sell.cents}¢ не вернулась выше ${Math.round(w.floor_cents)}¢ — исполняю безусловно (gap_wake_expired)`);
    }
  }
  for (const sid of touched) recomputeMetrics(db, sid, deps);
  return out;
}

export async function evaluateExits(db: Database, deps: EngineDeps = {}): Promise<ExitItem[]> {
  const now = nowFn(deps)();
  const poly = deps.polymarket ?? loadPolymarketConfig(deps.env);
  const out: ExitItem[] = [];
  const touched = new Set<string>();
  // One order-book fetch per TOKEN per cycle — shared by the gap-wake sweep and the main loop.
  const bookCacheShared = new Map<string, OrderBookFetch>();
  // P0.6: resolve any gap-wake deferrals FIRST (execute expired / clear recovered), so a position the sweep
  // just closed is skipped by the main loop below.
  out.push(...await gapRepriceSweep(db, deps, poly, bookCacheShared, Date.parse(now) || Date.now(), now));
  // Degraded-mode: when the strategist layer is in an active outage, the price-stop exemption
  // for melting-option markets is UNSAFE (nothing else manages those positions) — restore the
  // stop for this pass. Computed once per cycle. See strategistDegraded / the OPTIONALITY GATE.
  const degraded = strategistDegraded(db, Date.parse(now) || Date.now());
  // One order-book fetch per TOKEN per cycle — profiles sharing a market reuse it (shared with the sweep above).
  const bookCache = bookCacheShared;
  for (const { sport, match: m } of activeMatches(db)) {
    // Price-driven exits (take-profit / stop / edge-gone) are LIVE management —
    // per ТЗ §3.3 mark-to-market and price triggers belong to the live phase. A
    // position opened on lineup is HELD untouched until kickoff; letting exits run
    // pre-match closed positions on pure Polymarket drift (the «вход… → выход…
    // предматч» churn). Settlement of finished matches is handled elsewhere.
    if (m.state !== "live") continue;
    // A "live" match the provider isn't actually DELIVERING (frozen at 0', no events
    // — ESPN stuck on "pre"/lagging) offers only UNVERIFIABLE Polymarket price drift
    // to react to. Don't cut positions on that noise (the −$5.85 Orlando–Kansas
    // partial was exactly this) — HOLD them until real live data resumes or the match
    // settles on its final result. Mirrors the autoEnter entry gate.
    if (!liveDelivering(db, m, sport)) continue;
    const markets = R.latestMarkets(db, m.id);
    for (const b of R.betsForMatch(db, m.id)) {
      if (b.status !== "open") continue;
      const mk = markets.find((x) => x.label === b.market_label);
      if (!mk || mk.price == null || b.entry_price == null) continue;
      const strat = R.getStrategy(db, b.strategy_id);
      if (!strat) continue;
      // Mark the position on the REAL EXECUTABLE BID — what you'd actually net selling
      // the full stake right now — NOT the parametric mid. On a thin book the mid is
      // pulled up by a phantom ask; a take-profit computed on it fires at a "profit"
      // the bid can't pay (the «+197% тейк-профит» that filled at a LOSS, then the
      // strategist re-entered and it churned). Deciding on the same value we then fill
      // at removes the phantom trigger at the source. Fetch ONCE, reuse for the fill.
      // (poly off → sellVwapCents returns the quote, so the decision falls back to mid.)
      const sell = await sellVwapCents(mk, b.entry_price, b.stake ?? 0, poly, deps, mk.price, bookCache);
      // The live match minute (provider, else the timer estimate) — a deterministic FACT,
      // shared by the time_stop and the optionality-gate floor below.
      const minNum = m.minute != null ? m.minute
        : (isIsoTs(m.kickoff_at) ? Math.min(maxLiveMinutes(sport), Math.max(0, Math.floor(((Date.parse(now) || Date.now()) - Date.parse(m.kickoff_at as string)) / 60_000))) : 0);
      // TIME_STOP (Fix 2, deterministic): the strategist's planned minute past which a MELTING
      // option isn't sat to zero if the event hasn't happened. The minute is a FACT — code fires
      // it, no LLM needed. Independent of the price-stop logic below (this is a PLANNED close, not
      // a stop) and of the optionality exemption, so it fires even on an exempt market. Skips a
      // market that already RESOLVED (mark ≥ resolved¢ → event happened → let take-profit handle it).
      // Coexists with the time_decay_floor (≤4¢/≥80'): that's the last-ditch dust safety; this is
      // the strategist's earlier plan, at any price. Fires at most ONCE per position.
      const ts = plannedTimeStop(db, m.id, strat.name, b.risk_profile_id ?? "medium", b.market_label);
      if (ts && minNum >= ts.minute && mk.price < EXIT_TIME_STOP_RESOLVED_CENTS && sell.cents < EXIT_TIME_STOP_RESOLVED_CENTS) {
        // Fire at most once PER POSITION (strategy·profile·market). The throttle must
        // include the risk profile — two profiles of one strategy hold their own bets on
        // the same market, so a market-only key would let the first profile's fire suppress
        // every other profile's planned time_stop forever. The marker embeds the profile.
        const prof = b.risk_profile_id ?? "medium";
        const tsMarker = `(time_stop·${prof})`;
        const already = R.tradeLogForMatch(db, m.id).some((e) => e.strategy_id === b.strategy_id && e.type === "exit" && e.text.includes(`«${b.market_label}»`) && e.text.includes(tsMarker));
        // Phantom-bid guard, as on every exit path: a planned close still must not dump into a
        // momentarily-broken book (≤FLOOR¢ bid far under the mark) — hold to a real book/settle.
        const phantom = sell.fromBook && sell.cents <= EXIT_PHANTOM_FLOOR && (mk.price - sell.cents) >= EXIT_PHANTOM_GAP;
        if (!already && !phantom) {
          const planned = ts.action === "close_half" ? 0.5 : 1;
          // T3.3: book only the fraction the bid actually absorbed (planned × fillFrac), remainder re-offered.
          const tsFillFrac = sell.requestedShares > 0 ? Math.min(1, sell.filledShares / sell.requestedShares) : 1;
          const fraction = planned * tsFillFrac;
          const reason = `плановый тайм-стоп: ${minNum}' ≥ ${ts.minute}', событие не наступило (рынок ${mk.price}¢) — ${ts.action === "close_half" ? "фиксирую половину" : "закрываю"} ${tsMarker}`;
          if (fraction <= 1e-6) { // book absorbed nothing — hold the whole leg, time_stop retries next cycle
            const tsKey = `«${b.market_label}»`;
            if (!R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === b.strategy_id).slice(-8).some((e) => e.type === "hold" && e.text.includes(tsKey) && e.text.includes("exit_partial_zero")))
              R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "hold", text: `тайм-стоп по ${tsKey} не исполнен: бид не принял размер (0% филл); держим до реального рынка/сеттла (exit_partial_zero)`, created_at: now });
            continue;
          }
          const res = closeBetPortion(db, b, fraction, sell.cents, minuteLabel(m), now);
          if (sell.cost) recordFill(db, { betId: b.id, matchId: m.id, competitionId: m.competition_id, strategyId: b.strategy_id, profileId: prof }, scaleCost(sell.cost, fraction), now);
          R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "exit", text: `выход «${b.market_label}» @ ${sell.cents}¢ · ${reason}${sell.note ? ` · ${sell.note}` : ""}${modelFillTag(sell.fromBook)} · P&L ${res.pnl >= 0 ? "+" : ""}$${res.pnl.toFixed(2)}`, created_at: now });
          out.push({ matchId: m.id, strategyId: b.strategy_id, market: b.market_label, reason, pnl: res.pnl });
          touched.add(b.strategy_id);
          continue;
        }
      }
      // When the model prob is unknown, DON'T let it read as "edge gone" (which
      // would force-close on the first tick) — pass 1 so only take-profit / hard
      // stop can fire. (Defensive: entries always store a non-null ai_prob.)
      // Deterministic safety-net take-profit / hard-stop come from the position's
      // RISK PROFILE (aggressive holds longer + wider stop; conservative locks in
      // sooner), not per-strategy params. edgeExit:false — the strategist manages
      // edge/thesis exits in live (module 5); this net only catches extreme moves.
      const ex = getProfileConfig(db, b.risk_profile_id ?? "medium").exits;
      let d = exitDecision({ params: { takeProfit: ex.take_profit_pct, exitStop: ex.hard_stop_pct, edgeExit: false }, aiProb: b.ai_prob ?? 1, entryPriceCents: b.entry_price, currentPriceCents: sell.cents });
      if (!d.exit) continue;
      // Log a HOLD at most once per continuous hold period for THIS market (guillemets
      // delimit the label so «Over 1.5» ≠ «Over 1.5 goals»; scan a recent window so two
      // alternating held markets don't each re-log every cycle).
      const holdKey = `«${b.market_label}»`;
      const holdOnce = (text: string) => {
        const recent = R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === b.strategy_id).slice(-8);
        if (!recent.some((e) => e.type === "hold" && e.text.includes(holdKey))) {
          R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "hold", text, created_at: now });
        }
      };
      // OPTIONALITY GATE (audit: Argentina–Switzerland). For a market that WINS on a future
      // event (Over / BTTS Yes / team-to-score), the price is a MELTING OPTION — a price STOP
      // liquidates it at its cheapest right before it can pay (stop −44% @ 30.8¢ on 62',
      // Switzerland scored on 67' → 100¢). Suppress the STOP for these; take-profit + edge-gone
      // still fire, and the strategist still manages thesis/counter exits. A genuinely spent
      // option (deep-dust AND late) is instead closed by the time-decay floor — exempt is NOT
      // "ride the corpse to settlement". Under / No / clean-sheet / directional keep the stop
      // (each goal there is an irreversible step down — Örgryte Under 2.5 in a goal storm).
      if (d.kind === "stop" && winsOnEventOccurrence(b.market_label) && !degraded) {
        if (sell.cents <= EXIT_TIME_FLOOR_CENTS && minNum >= EXIT_TIME_FLOOR_MIN) {
          d = { exit: true, reason: `тайм-флор: ${sell.cents}¢ на ${minNum}' — опцион на событие истёк (time_decay_floor)`, pnlFrac: d.pnlFrac, kind: "stop" };
        } else {
          holdOnce(`ценовой стоп подавлен по ${holdKey}: рынок выигрывает от наступления события — цена тает по времени, это не слом тезиса (price_stop_exempt); держим до стратег-выхода / тайм-флора / сеттла`);
          continue;
        }
      } else if (d.kind === "stop" && winsOnEventOccurrence(b.market_label) && degraded) {
        // Strategist layer is down → the exemption's guardian is blind. Let the price stop
        // fire (insurance restored) and note WHY, so the log distinguishes it from a normal stop.
        d = { ...d, reason: `${d.reason} · стратег-слой недоступен, ценовой стоп восстановлен (degraded_mode)` };
      }
      // UNDER-THESIS GATE (mirror of the melting-option exemption). An Under/team-total LOSES only
      // when goals climb to the line — so while the score sits ≥ UNDER_STOP_SUPPRESS_MARGIN goals
      // BELOW the line, a price crash is a book artifact (Sarpsborg Under 3.5 @1:0 dumped @21-26¢;
      // Inter FK Sarajevo Under 1.5 @7-8¢ then SETTLED 100¢), not a broken thesis. Suppress the
      // price STOP; take-profit / edge-gone still fire. GAP-based & self-correcting: re-checked
      // against the live score every cycle, so unlike the Over exemption it needs NO degraded-mode
      // restore — a goal narrowing the margin below the threshold restores the stop on its own,
      // even through a strategist blackout. Only the STOP is gated (winsOnEventOccurrence already
      // handled Over, so this reaches Under/No totals). Take-profit unaffected.
      if (d.kind === "stop") {
        const uMargin = underThesisMarginGoals(b.market_label, m.score_home ?? 0, m.score_away ?? 0, { home: m.home, away: m.away });
        if (uMargin != null && uMargin >= UNDER_STOP_SUPPRESS_MARGIN) {
          holdOnce(`ценовой стоп подавлен по ${holdKey}: Under-тезис в запасе — до линии ещё ${uMargin} гол(ов) при счёте ${m.score_home ?? 0}:${m.score_away ?? 0}; цена оторвана книгой, тезис не под ударом (under_thesis_safe); держим до стратег-выхода / сеттла`);
          continue;
        }
      }
      // T1.1 STATE↔PRICE contradiction: a stop on a position that is CURRENTLY WINNING by the score, whose
      // executable bid collapsed to a phantom low far below its frozen entry reference (or an already-won
      // melting option at any low bid) — the book is a zombie, not a broken thesis. HOLD to settle. Anchored
      // on game state (not the decayed mark), so it stays effective as the book bleeds — unlike the guards
      // below, which weaken with it (Cienciano team-Under −$141 on a bet that settled +$212).
      if (d.kind === "stop") {
        const sc = stopContradictsGameState(b.market_label, m.score_home, m.score_away, { home: m.home, away: m.away }, b.entry_price, sell);
        if (sc) { holdOnce(`выход отклонён по ${holdKey}: ${sc}`); continue; }
        // T1.2: a terminal-phase winning position (or a melting model-fill) is held to settle, not stopped.
        const th = terminalProtectiveHold(b.market_label, m.score_home, m.score_away, minNum, { home: m.home, away: m.away }, sell.fromBook, true);
        if (th) { holdOnce(`выход отклонён по ${holdKey}: ${th}`); continue; }
      }
      // Phantom-bid guard: a stop firing on a degenerate bid (≤FLOOR¢) that sits far
      // below the mid is dumping into a momentarily-broken book, not managing risk —
      // HOLD, let it settle on the real result. (A take-profit can no longer fire on a
      // phantom-inflated mark: the decision above is made on this same executable bid.)
      // ONLY on a REAL book (fromBook) — a modelled parametric price this low is a
      // genuine illiquidity haircut, not a phantom, and a real stop must still fire.
      if (sell.fromBook && sell.cents <= EXIT_PHANTOM_FLOOR && (mk.price - sell.cents) >= EXIT_PHANTOM_GAP) {
        holdOnce(`выход отклонён по ${holdKey}: бид ${sell.cents}¢ — фантом при марке ${mk.price}¢ (${d.reason}); держим до реального рынка/сеттла (exit_phantom_block)`);
        continue;
      }
      // Slippage guard: the best bid can pay far MORE than the full-stake dump realizes —
      // the top of book just can't absorb the size. That gap (not the real value) both
      // crushes the price AND self-triggers this stop. HOLD, let it ride to a deeper book
      // / settlement, rather than book a depth artifact as a −70% loss. Only on a real
      // book; a genuine small-slip stop (0–1¢) still fires.
      if (sell.fromBook && sell.bestBidCents != null && (sell.bestBidCents - sell.cents) >= EXIT_SLIPPAGE_BLOCK) {
        holdOnce(`выход отклонён по ${holdKey}: фулл-стейк VWAP ${sell.cents}¢ против бида ${sell.bestBidCents}¢ (слип −${Math.round((sell.bestBidCents - sell.cents) * 10) / 10}¢) — книга не держит размер (${d.reason}); держим до реального рынка/сеттла (exit_slippage_block)`);
        continue;
      }
      // Illiquid-mark-gap guard (audit: 20-26¢ bids that slipped between the ≤5¢ phantom floor and
      // the 15¢ slippage gap). On a real book, a RICH mark (≥ MIN¢) with the best bid ≥ GAP¢ below it
      // means the executable bid decoupled from the value — illiquidity, not a thesis break — so a
      // stop would dump at a price the market doesn't bear. HOLD. Only for a STOP (a take-profit
      // needs a HIGH bid, never triggers here); conservative + logged for calibration.
      if (d.kind === "stop" && sell.fromBook && sell.bestBidCents != null && mk.price >= EXIT_ILLIQUID_MARK_MIN && (mk.price - sell.bestBidCents) >= EXIT_ILLIQUID_MARK_GAP) {
        holdOnce(`выход отклонён по ${holdKey}: марк ${mk.price}¢, но лучший бид ${sell.bestBidCents}¢ (Δ−${Math.round((mk.price - sell.bestBidCents) * 10) / 10}¢) — книга неликвидна, цена оторвана от стоимости, не слом тезиса (${d.reason}); держим до реального рынка/сеттла (exit_illiquid_mark_gap)`);
        continue;
      }
      // P0.6 GAP-WAKE protective-exit invariant — ONLY a protective stop, ONLY right after a scheduler sleep
      // window. Normal-time stops and take-profits are untouched (this whole block is gated on gapWakeActive).
      // The stop is NEVER cancelled — at most delayed ≤repriceSec / repriceTicks so a gapped book can unclench;
      // a declared thesis invalidator exits immediately; the sweep above executes an expired window. This is
      // the exit-side twin of the stale-proposal entry guard: «исполнение соответствует решению».
      if (d.kind === "stop") {
        const nowMs = Date.parse(now) || Date.now();
        if (R.getOpenGapReprice(db, b.id)) continue; // an active deferral — the sweep owns its resolution
        if (gapWakeActive(db, nowMs)) {
          if (gapWakeInvalidatorMet(db, m, strat.name, b.risk_profile_id ?? "medium", b.market_label, minNum)) {
            d = { ...d, reason: `${d.reason} · gap-wake: инвалидатор тезиса на свежем состоянии — немедленный выход (gap_wake_invalidator)` };
          } else {
            const cfg = gapRepriceConfig(deps.env ?? process.env);
            R.openGapReprice(db, { bet_id: b.id, match_id: m.id, strategy_id: b.strategy_id, profile: b.risk_profile_id ?? "medium", gap_sec: gapWakeGapSec(db), wake_price_cents: sell.cents, floor_cents: sell.cents, deadline_at: new Date(nowMs + cfg.repriceSec * 1000).toISOString(), created_at: now });
            holdOnce(`gap-wake: ценовой стоп по ${holdKey} отложен ≤${cfg.repriceSec}с/${cfg.repriceTicks} тика — даю книге разжаться после сна планировщика (gap_wake_reprice); стоп НЕ отменён`);
            continue;
          }
        }
      }
      // T3.3 PARTIAL-FILL ACCOUNTING (deterministic path, SYMMETRIC with the strategist path): a stop that the
      // bid book only partly absorbs must close ONLY the filled fraction — the remainder stays open and the
      // stop re-fires next cycle. Before this, closeBetEarly booked the WHOLE stake at the thin VWAP even on a
      // 42% fill (Cienciano: «исполнено 42%» yet the full $80 booked settled_lost), overstating the loss.
      const fillFrac = sell.requestedShares > 0 ? Math.min(1, sell.filledShares / sell.requestedShares) : 1;
      if (fillFrac <= 1e-6) { holdOnce(`выход по ${holdKey} не исполнен: бид не принял размер (0% филл, ${d.reason}); держим до реального рынка/сеттла (exit_partial_zero)`); continue; }
      const { pnl, partial } = closeBetPortion(db, b, fillFrac, sell.cents, minuteLabel(m), now);
      if (sell.cost) recordFill(db, { betId: b.id, matchId: m.id, competitionId: m.competition_id, strategyId: b.strategy_id, profileId: b.risk_profile_id ?? "medium" }, fillFrac < 1 ? scaleCost(sell.cost, fillFrac) : sell.cost, now);
      const fillTag = partial ? ` (частично ${Math.round(fillFrac * 100)}%)` : "";
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: b.strategy_id, minute: minuteLabel(m), type: "exit", text: `выход «${b.market_label}»${fillTag} @ ${sell.cents}¢ · ${d.reason}${sell.note ? ` · ${sell.note}` : ""}${modelFillTag(sell.fromBook)} · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, created_at: now });
      out.push({ matchId: m.id, strategyId: b.strategy_id, market: b.market_label, reason: d.reason, pnl });
      touched.add(b.strategy_id);
    }
  }
  for (const sid of touched) recomputeMetrics(db, sid, deps);
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The strategist's planned time_stop for a specific (strategy·profile, market), read
 *  from the pair's battle_sheet — the persistent home of exit plans (same source the
 *  counter_scenario condition is read from in reassess). Deterministic: minute is a fact.
 *  Returns null when no plan / no time_stop / malformed. */
function plannedTimeStop(
  db: Database, matchId: string, stratName: string, profile: string, marketLabel: string,
): { minute: number; action: "close_full" | "close_half" } | null {
  const sheet = R.artifactsForMatch(db, matchId).find((x) => x.kind === "battle_sheet" && x.label === `${stratName} · ${profile}`)?.content;
  if (!sheet) return null;
  try {
    const bs = JSON.parse(sheet);
    for (const p of bs?.positions ?? []) {
      if (typeof p?.market !== "string" || norm(p.market) !== norm(marketLabel)) continue;
      const ts = p?.exit?.time_stop;
      if (ts && Number.isFinite(ts.minute) && Number(ts.minute) > 0) {
        return { minute: Number(ts.minute), action: ts.action === "close_half" ? "close_half" : "close_full" };
      }
    }
  } catch { /* free-text plan → no structured time_stop */ }
  return null;
}

/** The strategy's pre-registered counter_scenario_stop CONDITION for a market (from the pair's battle sheet) —
 *  the same field csCondByMarket reads in reassess. Used by the P0.6 gap-wake INVALIDATOR: a hard, declared
 *  thesis-break condition, not one invented from data. Returns the raw condition text, or null. */
function plannedCounterScenario(db: Database, matchId: string, stratName: string, profile: string, marketLabel: string): string | null {
  const sheet = R.artifactsForMatch(db, matchId).find((x) => x.kind === "battle_sheet" && x.label === `${stratName} · ${profile}`)?.content;
  if (!sheet) return null;
  try {
    const bs = JSON.parse(sheet);
    for (const p of bs?.positions ?? []) {
      if (typeof p?.market !== "string" || norm(p.market) !== norm(marketLabel)) continue;
      const c = p?.exit?.counter_scenario_stop;
      if (typeof c === "string" && c.trim()) return c;
    }
  } catch { /* free-text plan → no structured condition */ }
  return null;
}

/** P0.6 gap-wake INVALIDATOR: has the position's OWN declared counter_scenario condition objectively
 *  materialised on the fresh (post-gap) state? Exact score + minute-reached, via the same parser
 *  verifyExitTrigger uses. A met invalidator → exit immediately, no reprice window (the thesis is broken, not
 *  the book dislocated). No parseable condition / not met → null (fall to the bounded reprice window). */
function gapWakeInvalidatorMet(db: Database, m: Match, stratName: string, profile: string, marketLabel: string, minNum: number): boolean {
  const cond = plannedCounterScenario(db, m.id, stratName, profile, marketLabel);
  if (!cond || m.score_home == null || m.score_away == null) return false;
  const pc = parseScoreMinuteCondition(cond);
  return !!pc && m.score_home === pc.home && m.score_away === pc.away && minNum >= pc.minute;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Snapshot each live match's current prices as its kickoff baseline (first
 *  write wins), so the odds column shows in-match movement, not pre-match drift. */
function captureLiveOpens(db: Database, deps: EngineDeps): void {
  const now = nowFn(deps)();
  for (const { match: m } of activeMatches(db)) if (m.state === "live") R.captureOpenOdds(db, m.id, now);
}

export interface ReassessEntry { matchId: string; strategyId: string; market: string; stake: number }
export interface ReassessResult { exits: ExitItem[]; entries: ReassessEntry[]; llmCalls: number; llmFail: number; gateSkips?: number }

/**
 * Strategist-driven in-match reassessment. For funded matches that either hold
 * open positions OR just saw a fresh live event (goal / red card / lineups —
 * pulled from ESPN by enrichFromEspn, passed in via opts.newEventMatchIds), we
 * hand the strategy PROMPT the real match context (lineups + events) and let its
 * own methodology decide BOTH what to EXIT (full/partial fixation, "this event
 * broke the thesis") and what fresh markets to ENTER (a new pattern the event
 * opened). Code still sizes/gates entries (§9.6). Capped per run — one model
 * call per (match, strategy) — so it only fires where the user holds risk or a
 * trigger actually fired. This is what makes reassessment *react* to live data.
 */
/** Parse a liquidity string ("$2.5M", "1234", "780K") to a number, or null. */
function liqNum(s: string | null): number | null {
  if (s == null) return null;
  const m = String(s).replace(/[$,\s]/g, "").match(/^([\d.]+)\s*([mk]?)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  const suf = m[2].toLowerCase();
  return suf === "m" ? v * 1e6 : suf === "k" ? v * 1e3 : v;
}
/** Numeric analysis calibration for the live min_calibration gate: from the stored
 *  distribution artifact, else the word-confidence band. */
function liveCalibration(db: Database, matchId: string, confidence: string): number {
  const art = R.artifactsForMatch(db, matchId).find((x) => x.kind === "distribution");
  if (art) { try { const v = JSON.parse(art.content)?.calibration?.xg_confidence; if (typeof v === "number") return v; } catch { /* ignore */ } }
  return confidence === "высокая" ? 0.75 : confidence === "низкая" ? 0.3 : 0.5;
}

/**
 * P1 ZOMBIE-MARKET map for a LIVE football match: label → the reason its book is not a live tradeable price
 * (resolved_price / notation_desync / stale_book). Consumed by BOTH the strategist quote context and the
 * autoEnter fill choke — a quarantined market is dropped from what the strategist sees and can never be
 * entered. Quarantine is logged once per (match,label,code) per continuous zombie period (dedup vs the recent
 * trade log) so it shows up in the match log and is countable by the P2 unfillable_edge report. Non-football
 * or non-live → empty map (tennis has its own placeholder handling; §9.6 — a deterministic quote check).
 */
function footballZombieMap(
  db: Database, m: Match, sport: string, markets: Market[], minute: number | null,
  env: Record<string, string | undefined>, now: string, log = true,
): Map<string, ZombieReason> {
  const out = new Map<string, ZombieReason>();
  if (sport !== "football" || m.state !== "live" || !markets.length) return out;
  const cfg = loadZombieConfig(env);
  // A game-state RESOLVED leg (both scored → BTTS-Yes; a team scored → its Over 0.5) is pure SCORE logic —
  // liveAdjustedProb short-circuits to 1.0 before it touches xG — so a missing distribution (no core) must not
  // blind the resolved-price rule. Use the real core when present, a neutral zero-core otherwise (an UNresolved
  // leg then reads ≈0, never ≥0.995, so it's never falsely quarantined).
  const core = footballCore(db, m.id) ?? { xg_home: 0, xg_away: 0, home_share_1h: 0.5, away_share_1h: 0.5 };
  const lpCfg = loadLiveProbConfig(env);
  const spreads = notationSpreads(markets.map((mk) => ({ label: mk.label, price: mk.price })));
  // trade_log.strategy_id is FK-bound; the quarantine is match-level, so we attach the informational line to a
  // real football strategy id (dedup keeps it to one line per label+code). No football strategy → don't log.
  const logSid = log ? (R.listStrategies(db).find((s) => s.sport_id === "football")?.id ?? null) : null;
  for (const mk of markets) {
    const gs = minute != null
      ? liveAdjustedProb(mk.label, { home: m.home, away: m.away, scoreHome: m.score_home, scoreAway: m.score_away, minute, core }, lpCfg)
      : null;
    const bookAge = R.bookStaleMinutes(db, m.id, mk.label, mk.price, now);
    const z = classifyZombie({ label: mk.label, priceCents: mk.price, gsProb: gs?.prob ?? null, groupSpreadCents: spreads.get(mk.label) ?? null, bookAgeMin: bookAge, live: true }, cfg);
    if (!z) continue;
    out.set(mk.label, z);
    if (logSid) throttleZombieLog(db, m, mk.label, z.code, `zombie_quarantine:${z.code} «${mk.label}»: ${z.detail} — рынок на карантине для всех потребителей (вход/контекст)`, logSid, now);
  }
  // Z1: close episodes for markets no longer quarantined this tick — log the LIFT once, then drop the marker
  // (so a re-quarantine later starts a fresh episode). Bounded scan: only THIS match's episode markers.
  if (logSid) {
    for (const rec of R.metaByPrefix(db, `${ZOMBIE_EP}${m.id} `)) {
      const label = rec.key.slice(`${ZOMBIE_EP}${m.id} `.length);
      if (out.has(label)) continue; // still quarantined → its marker was already refreshed above
      let ticks = 0; try { ticks = Number(JSON.parse(rec.value).ticks ?? 0); } catch { /* ignore */ }
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: logSid, minute: minuteLabel(m), type: "skip", text: `zombie_lifted «${label}»: карантин снят (эпизод ${ticks} тик.) — рынок снова торгуем`, created_at: now });
      try { R.metaDelete(db, rec.key); } catch { /* best-effort */ }
    }
  }
  return out;
}

// Z1 (batch-5): episode-throttled zombie log. ONE line per continuous (match, label, code) quarantine episode;
// each further tick of the SAME code accrues a silent counter (no line); a code change re-logs (class change),
// and the lift is logged once by the sweep above. Keyed on a meta marker so BOTH consumers (strategist context
// + autoEnter fill choke) that call footballZombieMap each tick collapse to a single episode line instead of
// re-logging every tick — the ~90k skip-line storm (staleSweep-frozen matches ran this for hours) becomes a
// handful of transition lines. Replaces the old slice(-14) tail dedup, which failed once #markets×#consumers>14.
const ZOMBIE_EP = "zombie_ep:";
export function throttleZombieLog(db: Database, m: Match, label: string, code: string, text: string, sid: string, now: string): void {
  const key = `${ZOMBIE_EP}${m.id} ${label}`;
  let ep: { code: string; ticks: number } | null = null;
  try { const s = R.metaGet(db, key); if (s) ep = JSON.parse(s); } catch { /* treat as new */ }
  if (ep && ep.code === code) { try { R.metaSet(db, key, JSON.stringify({ code, ticks: ep.ticks + 1 }), now); } catch { /* ignore */ } return; } // same episode → silent tick++
  try { R.metaSet(db, key, JSON.stringify({ code, ticks: 1 }), now); } catch { /* ignore */ }
  R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "skip", text, created_at: now });
}

export async function strategistReassess(
  db: Database, deps: EngineDeps = {}, opts: { max?: number; newEventMatchIds?: Set<string>; triggeredOnly?: boolean; labelFor?: Map<string, ReassessTrigger>; onlyStrategyId?: string } = {},
): Promise<ReassessResult> {
  const max = opts.max ?? 4;
  const triggered = opts.newEventMatchIds ?? new Set<string>();
  const labelFor = opts.labelFor ?? new Map<string, ReassessTrigger>();
  // Event-driven mode (fast live loop): only reassess matches with a fresh
  // trigger — don't burn an LLM call every tick on quiet open positions.
  const triggeredOnly = opts.triggeredOnly ?? false;
  const now = nowFn(deps)();
  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  const analysisDuel = loadAnalysisDuel(env); // tag live bets with the match's analysis model
  const poly = deps.polymarket ?? loadPolymarketConfig(env);
  const comps = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  const out: ReassessResult = { exits: [], entries: [], llmCalls: 0, llmFail: 0, gateSkips: 0 };
  const touched = new Set<string>();
  let calls = 0;
  // Process on-pitch event triggers (goal / red card — anything NOT labelled
  // "time") BEFORE the periodic heartbeat matches, so an urgent reaction to a
  // goal is never crowded out of the per-run `max` budget by routine 5-min ticks.
  const isPeriodic = (id: string) => (labelFor.get(id) ?? "time") === "time";
  const ordered = activeMatches(db).slice().sort((a, b) => Number(isPeriodic(a.match.id)) - Number(isPeriodic(b.match.id)));
  for (const { comp, sport, match: m } of ordered) {
    if (calls >= max) break;
    const c = comps.get(comp);
    if (!c || c.budget <= 0) continue;
    // Reassessment is IN-MATCH management that reacts to real events (goal / red
    // card / price move) — per ТЗ §3.3 it belongs to the LIVE phase. Never run it
    // pre-match: for leagues we can't enrich, `lineup_out` is a pure time-flip
    // (advanceClocks, ~1h before kickoff) with NO real teamsheet, so allowing the
    // lineup_out branch churned not-yet-started matches on pre-match price noise
    // ("движение цены на старте без игрового триггера; статичное 0:0"). Entry on
    // lineup still happens (autoAnalyze post_lineup + autoEnter); we just hold
    // those positions untouched until the ball is actually rolling.
    if (m.state !== "live") continue;
    // A "live" match the provider isn't DELIVERING (frozen at 0', no events — ESPN
    // stuck "pre"/lagging) has only stale state + Polymarket price noise to reassess
    // on. Don't burn a call or let the strategist cut positions on that noise — HOLD
    // until real live data resumes or the match settles. A real event would make
    // liveDelivering true, so this never skips a genuine reaction.
    if (!liveDelivering(db, m, sport)) continue;
    const open = R.betsForMatch(db, m.id).filter((b) => b.status === "open");
    // Reassess only where there's live risk (open positions) or a fresh trigger.
    // In triggeredOnly mode (fast loop) a trigger is REQUIRED — quiet positions
    // are handled by the deterministic exits + the slow full cycle.
    if (triggeredOnly ? !triggered.has(m.id) : (!open.length && !triggered.has(m.id))) continue;
    const markets = R.latestMarkets(db, m.id);
    if (!markets.length) continue;
    const opens = R.openOddsFor(db, m.id); // kickoff price per label → price_move direction/size
    const nowMs = Date.parse(now) || Date.now();
    // A live minute for the strategist even when no provider drives one: the timer
    // estimate from kickoff (capped at the sport ceiling so it never reads absurd).
    const minuteApprox = m.minute == null && isIsoTs(m.kickoff_at)
      ? Math.min(maxLiveMinutes(sport), Math.max(0, Math.floor((nowMs - Date.parse(m.kickoff_at as string)) / 60000)))
      : null;
    const assess = R.assessmentsForMatch(db, m.id).filter((a) => a.status === "ok").sort((a, b) => (a.created_at >= b.created_at ? -1 : 1))[0];
    // A/B duel tag: attribute this match's live bets to the model that analysed it, so a
    // match's whole bet set (prematch + live) segments under one arm. Null → plain epoch.
    const analysisTag = analysisDuel.enabled && assess?.model ? analysisModelTag(assess.model) : null;
    // Match facts + the outcome tree / match_shape / scenarios the strategist
    // reasons over (single-sourced; the pair's battle sheet is appended below).
    const ctx = strategistContext(db, m.id);
    // GAME-STATE live probability for MELTING options (тающие опционы: командный
    // Over 0.5/1.5, BTTS-Yes). The strategist previously back-extrapolated P from
    // accumulated tempo and cut Switzerland Over 0.5 at 31–43¢ minutes before the
    // goal. Supply a code-computed P(event in the remainder) from score-state+time
    // NEXT TO the price, per market — so live edge is judged against game-state,
    // not an LLM guess. §9.6 preserved: code supplies the number, the LLM judges.
    // Uses the provider minute, else the timer estimate; null core → no adjustment.
    const lpCfg = loadLiveProbConfig(env);
    const core = footballCore(db, m.id);
    const liveMinute = m.minute ?? minuteApprox;
    const gsProbByLabel = new Map<string, { prob: number; note: string }>();
    if (core && sport === "football") {
      for (const mk of markets) {
        const adj = liveAdjustedProb(mk.label, {
          home: m.home, away: m.away,
          scoreHome: m.score_home, scoreAway: m.score_away,
          minute: liveMinute, core,
        }, lpCfg);
        if (adj) gsProbByLabel.set(mk.label, adj);
      }
    }
    // P1 ZOMBIE QUARANTINE: markets whose quote isn't a live tradeable price (resolved/desynced/stale) are
    // dropped from what the strategist SEES (context + entry candidates) so it never reasons on or opens into a
    // phantom price. Exits still use the full `markets` (an open position must always be manageable).
    const zombie = footballZombieMap(db, m, sport, markets, liveMinute, env, now);
    const liveMarkets = zombie.size ? markets.filter((mk) => !zombie.has(mk.label)) : markets;

    // PAIRS to run (LIVE branch of the unified engine — same (strategy, profile)
    // unit as the prematch pass): pairs with an active share (can enter) plus any
    // pair already holding an open position (must be able to exit, pct=0).
    const shares = R.sharesForComp(db, comp).filter((s) => s.pct > 0);
    const strategyById = new Map(R.listStrategies(db).map((s) => [s.id, s]));
    const pairMap = new Map<string, { strat: Strategy; profile: string; pct: number }>();
    for (const s of shares) { const st = strategyById.get(s.strategy_id); if (st) pairMap.set(`${s.strategy_id}::${s.risk_profile_id}`, { strat: st, profile: s.risk_profile_id, pct: s.pct }); }
    for (const b of open) { const pid = b.risk_profile_id ?? "medium"; const key = `${b.strategy_id}::${pid}`; if (!pairMap.has(key)) { const st = strategyById.get(b.strategy_id); if (st) pairMap.set(key, { strat: st, profile: pid, pct: 0 }); } }
    // De-vigged implied + numeric calibration once for the match.
    const quotes = markets.map((mk) => ({ label: mk.label, priceCents: mk.price, liquidity: liqNum(mk.liquidity) }));
    const impliedMap = impliedProbs(quotes);
    const calibration = liveCalibration(db, m.id, assess?.confidence ?? "средняя");

    // The `max` budget bounds how many MATCHES a run touches (outer break), NOT
    // how many strategies within a match. Capping per-pair here starved lower-
    // ordered (strategy, profile) pairs: a match only ever reassessed its first
    // `max` pairs (all of the first strategy), and the per-MATCH due-reset then
    // blocked the rest forever — so Overreaction / Pre-match Value never got a
    // live reassessment while Live xG (ordered first) ate the budget every run.
    // Run ALL of a due match's pairs; a generous per-match cap only guards a
    // pathological config.
    // DEDUP ПО ПРОФИЛЯМ (§9.6): суждение стратега — prob, входы, тезисные выходы —
    // НЕ зависит от риск-профиля (размер и ценовые стоп/тейк считает код), поэтому
    // зовём модель ОДИН раз на СТРАТЕГИЮ, а не на каждую пару strategy×profile.
    // Общее решение затем применяем к каждому профилю с его сайзингом. При 3
    // профилях это ×3 меньше живых LLM-вызовов без потери качества.
    const byStrategy = new Map<string, { strat: Strategy; profiles: Array<{ profile: string; pct: number }> }>();
    for (const { strat, profile, pct } of pairMap.values()) {
      const g = byStrategy.get(strat.id);
      if (g) g.profiles.push({ profile, pct });
      else byStrategy.set(strat.id, { strat, profiles: [{ profile, pct }] });
    }
    const matchStart = calls;
    let blockedLogged = false; // circuit-breaker: log the outage once per match, not per pair
    for (const { strat, profiles } of byStrategy.values()) {
      if (calls - matchStart >= MAX_PAIRS_PER_MATCH) break; // бюджет теперь считает СТРАТЕГИИ, не пары
      if (opts.onlyStrategyId && strat.id !== opts.onlyStrategyId) continue; // manual: one strategy only
      const sid = strat.id;
      // Все открытые позиции стратегии (по всем профилям) — контекст для стратега; в
      // промпт дедупим по рынку (стратегу важен рынок, не профиль). P&L и ценовой
      // стоп/тейк на реальный вход каждого профиля считает код в per-profile цикле.
      const stratOpen = open.filter((b) => b.strategy_id === sid);
      const seenMkt = new Set<string>();
      const promptPositions = stratOpen.filter((b) => { const k = norm(b.market_label); if (seenMkt.has(k)) return false; seenMkt.add(k); return true; });
      // BATTLE SHEET (план прематча) — тезисный (триггеры / take_price / thesis_stop),
      // а не про размер, и почти одинаков по профилям одной стратегии; берём первый
      // доступный как представителя (LIVE-окно исполняет его, не переизобретает).
      const battleSheet = profiles.map((p) => R.artifactsForMatch(db, m.id).find((x) => x.kind === "battle_sheet" && x.label === `${strat.name} · ${p.profile}`)?.content).find(Boolean);
      // ── ДЕТЕРМИНИСТИЧЕСКИЙ ПРЕ-LLM ГЕЙТ (§9.6: не денежное решение — только «может ли
      // стратег вообще действовать сейчас?»). P0.4: событийная переоценка зовёт LLM только если
      // (открытые позиции > 0) ИЛИ (есть живой армед-триггер, чьи предусловия события совпали).
      // Иначе — детерминированный skip. Раньше гейт стоял ТОЛЬКО на периодическом тике, и каждое
      // событие (гол/красная/цена) на пустом портфеле жгло LLM-вызов «воздерживаюсь» (91 на 7 матчей):
      // мёртвый триггер (окно истекло / счёт противоречит условию) разоружается КОДОМ здесь и LLM не
      // будит. Fail-open: любая неоднозначность → зовём стратега. live_xg НЕ гейтим (вход по live-xG
      // потоку — нужно суждение LLM).
      if (!stratOpen.length) {
        let skipReason: string | null = null, skipTag: string | null = null;
        if (sid === "prematch_value") {
          // Live-роль Pre-match Value (футбол) — «защита открытого»; открытой позиции нет → защищать
          // нечего (P0.3 — входов в live нет). (Полное имя, а не «PMV» — чтобы не путать с теннисной PMV.)
          skipReason = "Pre-match Value live (футбол): пустой портфель — защищать нечего (детерминированный пропуск, без LLM)";
          skipTag = "det_gate_skip:pmv_empty";
        } else if (sid === "overreaction") {
          // Вход overreaction возможен ТОЛЬКО через заряженный buyback-триггер; нет ни одного живого
          // (событие/глубина + окно) → пропуск с конкретной причиной разоружения.
          const g = overreactionGate(battleSheet ?? null, { totalGoals: (m.score_home ?? 0) + (m.score_away ?? 0), minute: m.minute ?? minuteApprox });
          if (!g.call) { skipReason = `Overreaction: ${g.reason} — детерминированный пропуск, без LLM`; skipTag = "det_gate_skip:ovr_dormant"; }
        }
        if (skipReason) {
          // Count EVERY tick (the до/после metric), but LOG only once per continuous skip episode — the gate
          // fires every ~20s tick on a quiet match, which flooded trade_log with hundreds of identical rows
          // (Club Nacional: 420 in one match). Re-log only when this strategy's last det-gate line differs
          // (a state flip, e.g. overreaction arms then goes dormant again) — like the exit holdOnce pattern.
          out.gateSkips = (out.gateSkips ?? 0) + 1;
          const lastGate = R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === sid && e.type === "skip" && (e.text ?? "").includes("det_gate_skip:")).slice(-1)[0];
          if (!lastGate || !(lastGate.text ?? "").includes(skipTag!)) {
            R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "skip", text: `${skipReason} [${skipTag}]`, created_at: now });
          }
          continue;
        }
      }
      // CIRCUIT-BREAKER short-circuit: a hard strategist outage (credit/auth) is open → don't
      // re-issue the dead call for every pair. The deterministic exit net (degraded → price-stop
      // restore + Under gap-suppression) manages the positions until a probe closes the breaker.
      if (strategistHardBlocked(db, nowMs)) {
        if (!blockedLogged) {
          blockedLogged = true;
          const until = Number(R.metaGet(db, STRATEGIST_HARD_BLOCK_KEY) ?? 0);
          const hhmm = new Date(until).toISOString().slice(11, 16);
          R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "skip", text: `стратег разомкнут (кредит/авторизация) — переоценки приостановлены до ~${hhmm}Z; позиции ведёт детерминированный слой (стоп/gap-подавление/сеттл) (strategist_circuit_open)`, created_at: now });
        }
        continue;
      }
      calls++;
      // Pre-registered counter_scenario conditions per market (structured field in the plan) —
      // used to verify a counter_scenario exit tag against the live score/minute (trigger honesty).
      const csCondByMarket = new Map<string, string>();
      if (battleSheet) { try { const bs = JSON.parse(battleSheet); for (const p of bs?.positions ?? []) { const c = p?.exit?.counter_scenario_stop; if (typeof p?.market === "string" && typeof c === "string") csCondByMarket.set(norm(p.market), c); } } catch { /* free-text plan → fall back to the echo check */ } }
      const dec = await strategistDecide({
        strategyName: strat.name, strategyPrompt: strat.prompt_live ?? strat.prompt,
        match: { home: m.home, away: m.away, sport, state: m.state, minute: m.minute, scoreHome: m.score_home, scoreAway: m.score_away, minuteApprox },
        assessment: { confidence: assess?.confidence ?? "средняя", short: assess?.short ?? "", verdict: assess?.verdict ?? "" },
        markets: liveMarkets.map((mk) => ({ label: mk.label, priceCents: mk.price, aiProb: mk.ai_prob, liquidity: mk.liquidity != null ? Number(mk.liquidity) : null, openCents: mk.label in opens ? opens[mk.label] : null, liveProbAdjusted: gsProbByLabel.get(mk.label) ?? null })),
        openPositions: promptPositions.map((b) => ({ market: b.market_label, entryCents: b.entry_price ?? 0, currentCents: b.current_price ?? b.entry_price ?? 0 })),
        context: [ctx, battleSheet ? `БОЕВОЙ ЛИСТ (план из предматча — исполняй его, не переизобретай):\n${battleSheet}` : null].filter(Boolean).join("\n\n") || undefined,
        // LIVE-переоценка исполняет уже сформированный боевой лист — держим её на
        // более дешёвой модели (model_live), а предматч-вход остаётся на model.
      }, strat.model_live ?? strat.model ?? "Claude Opus 4.8", { fetchImpl: deps.fetchImpl, env });
      out.llmCalls++;
      if (!dec.ok) {
        // The reassessment could NOT be produced (LLM/budget outage, invalid JSON).
        // Record it as a first-class SKIP in the match timeline — otherwise an
        // outage window looks identical to a quiet period (no reassessments), and
        // post-match analysis can't tell "model chose to hold" from "model was
        // unreachable". The run-level count (out.llmFail) surfaces in the cron log.
        out.llmFail++;
        // Stamp the strategist-layer OUTAGE so the deterministic exit net can restore the
        // price stop to exempt markets while the LLM is blind (degraded-mode fallback).
        try { R.metaSet(db, LAST_STRATEGIST_FAIL_KEY, String(nowMs), now); } catch {}
        // A HARD outage (credit/auth) → OPEN the breaker so the rest of this pass (and the next
        // cooldown) doesn't re-issue the same dead call for every pair. A transient failure
        // (timeout / 5xx / empty reply) does NOT trip it — those are worth a fresh try next cycle.
        if (isHardStrategistFailure(dec.error)) {
          try { R.metaSet(db, STRATEGIST_HARD_BLOCK_KEY, String(nowMs + STRATEGIST_HARD_COOLDOWN_MIN * 60_000), now); } catch {}
        }
        R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "skip", text: `переоценка не выполнена — стратег недоступен (${dec.error || "нет ответа ИИ"})`, created_at: now });
        continue;
      }
      touched.add(sid);
      // The strategist layer is alive — record it so the exit net keeps trusting it to manage
      // the melting-option positions (and doesn't restore the price stop). A live success also
      // CLOSES the hard-outage breaker immediately (recovery beats waiting out the cooldown).
      try { R.metaSet(db, LAST_STRATEGIST_OK_KEY, String(nowMs), now); } catch {}
      try { if (Number(R.metaGet(db, STRATEGIST_HARD_BLOCK_KEY) ?? 0) > 0) R.metaSet(db, STRATEGIST_HARD_BLOCK_KEY, "0", now); } catch {}
      // Одно решение — на КАЖДЫЙ профиль: выходы бьют только по позициям профиля,
      // входы сайзятся его risk_config (§9.6), заметка переоценки — своя.
      // Дедуп заметок: суждение стратега общее (Модель А), поэтому в частом случае
      // «ничего не сделано» текст заметки идентичен по всем профилям — пишем его ОДИН
      // раз на стратегию за тик, а не ×N профилей (иначе вкладка «Переоценки» и таблица
      // раздуваются четырьмя одинаковыми строками, как в логе Djurgården–Halmstad).
      const seenReassessBodies = new Set<string>();
      for (const { profile, pct } of profiles) {
        const myOpen = open.filter((b) => b.strategy_id === sid && (b.risk_profile_id ?? "medium") === profile);
        // Track what ACTUALLY happened, so the reassessment note (written AFTER the
        // exits/entries below) states reality — not the LLM's intent. Otherwise the
        // note musing "держу BTTS No" showed even when no such position was ever
        // opened (picks gated / abstained), reading like positions that don't exist.
        const enteredMarkets: string[] = [], exitedMarkets: string[] = [], unfilled: string[] = [];

        // (a) EXITS — full or partial fixation on this strategy's open positions.
        const exitedIds = new Set<string>();
        for (const ex of dec.exits) {
          // Resolve the strategist's (possibly paraphrased) exit label to a real
          // open position — exact first, then the safe fuzzy match, so an exit the
          // model asked for isn't silently dropped and the position left open.
          const b = myOpen.find((x) => norm(x.market_label) === norm(ex.market)) ?? myOpen.find((x) => sameMarketLabel(x.market_label, ex.market));
          const mk = b && markets.find((x) => x.label === b.market_label);
          if (!b || !mk || mk.price == null || b.entry_price == null) continue;
          // Dedup on the RESOLVED bet id, not the label: two paraphrased exits
          // ("Under 2.5" / "Under 2.5 goals") map to the same position and the
          // second would size off the already-shrunk stake → over-fixation.
          if (exitedIds.has(b.id)) continue;
          exitedIds.add(b.id);
          // ── F1: UNVERIFIED DEFENSIVE EXIT → BLOCK (do not move money). A defensive-tagged exit
          // (counter_scenario / thesis_stop) claims a PRE-REGISTERED adverse scenario materialised. It
          // executes ONLY when that registered score/minute condition DETERMINISTICALLY matches the live
          // fact. An unverified one (Vila Nova 78' «0:0 к 70'» at 2:0; Cruz Azul «закрыть при 3 голах» at 2)
          // used to execute anyway and get relabelled «discretionary» — a decorative safeguard on a live
          // money path for every prematch position. Now it is HELD; the deterministic layer + settlement
          // manage the position. Counter feeds the F4 counterfactual report. (Non-defensive exits — take_price
          // et al. — are unaffected; a met condition or a genuine take still executes below.)
          {
            const f1Min = m.minute != null ? m.minute : minuteApprox;
            const ver = verifyExitTrigger(ex.trigger, ex.reason ?? "", { scoreHome: m.score_home, scoreAway: m.score_away, minute: f1Min, conditionText: csCondByMarket.get(norm(b.market_label)) ?? csCondByMarket.get(norm(ex.market ?? "")) });
            if (ver.flagged) {
              // The registered defensive condition is objectively UNMET (or the tag has no substance) — the
              // old path executed then relabelled «discretionary»; now the money exit is BLOCKED.
              R.metaSet(db, F1_UNVERIFIED_EXIT_KEY, String(Number(R.metaGet(db, F1_UNVERIFIED_EXIT_KEY) ?? 0) + 1), now);
              const holdKey = `«${b.market_label}»`;
              const recentHold = R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === sid).slice(-8).some((e) => e.type === "hold" && e.text.includes(holdKey) && e.text.includes("unverified_exit_blocked"));
              if (!recentHold) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "hold", text: `выход стратега ЗАБЛОКИРОВАН по ${holdKey}: защитный тег «${ex.trigger}» не подтверждён фактом${ver.note ? ` (${ver.note})` : ""} (счёт ${m.score_home ?? 0}:${m.score_away ?? 0}, ${f1Min ?? "?"}') — деньги не двигаем, держим до сеттла/детерминированного слоя (unverified_exit_blocked)`, created_at: now });
              continue;
            }
          }
          // Take-profit CHURN throttle: the periodic heartbeat, on a drifting price, provokes a
          // partial fixation every cycle (ten in 20 min). Cap it — one partial TAKE-PROFIT per
          // position per PARTIAL_TP_THROTTLE_MIN. A DEFENSIVE exit (stop / thesis_stop /
          // counter_scenario) and a FULL close (fraction≥1) are NEVER throttled; classification
          // fails toward EXECUTING, so a defensive exit is never delayed by a misread.
          const exBlob = `${ex.trigger ?? ""} ${ex.reason ?? ""}`.toLowerCase();
          const defensiveExit = /thesis_stop|counter_scenario|\bstop\b|стоп|слома|сломан|красн|удал|травм/.test(exBlob);
          const takeProfitExit = /take_price|take_profit|тейк|фикс|прибыл|edge (исчерп|закры)|цена (дош|дости)|на пике/.test(exBlob);
          if (PARTIAL_TP_THROTTLE_MIN > 0 && ex.fraction < 1 && takeProfitExit && !defensiveExit) {
            const prof = b.risk_profile_id ?? "medium";
            const lastPartialMs = R.betsForMatch(db, m.id, sid)
              .filter((x) => x.settled_by === "partial" && (x.risk_profile_id ?? "medium") === prof && norm(x.market_label) === norm(b.market_label) && x.settled_at)
              .reduce((mx, x) => Math.max(mx, Date.parse(x.settled_at as string)), 0);
            if (lastPartialMs && nowMs - lastPartialMs < PARTIAL_TP_THROTTLE_MIN * 60_000) {
              const holdKey = `«${b.market_label}» тейк`;
              const recentHold = R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === sid).slice(-8).some((e) => e.type === "hold" && e.text.includes(holdKey));
              if (!recentHold) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "hold", text: `частичная фиксация ${holdKey} отложена — последняя ${Math.round((nowMs - lastPartialMs) / 60_000)}м назад < ${PARTIAL_TP_THROTTLE_MIN}м (partial_tp_throttle); держим ногу`, created_at: now });
              continue;
            }
          }
          // T1.3 DEFENSIVE-cut throttle + count cap (León–Atlas cascade): a defensive PARTIAL cut must not
          // repeat within DEFENSIVE_CUT_THROTTLE_MIN, and no more than DEFENSIVE_CUT_MAX defensive cuts may
          // fire on a position BETWEEN relevant game-state events. A new goal/red card is new information —
          // it resets the window (a full close and a genuine invalidator are unaffected; only partial nibbles).
          if (ex.fraction < 1 && defensiveExit) {
            const prof = b.risk_profile_id ?? "medium";
            // Reset anchor: the most recent material event (goal / red card) for this match, in ms.
            const lastEventMs = R.eventsForMatch(db, m.id)
              .filter((e) => e.type === "goal" || e.type === "red_card")
              .reduce((mx, e) => Math.max(mx, Date.parse(e.created_at) || 0), 0);
            const defCuts = R.betsForMatch(db, m.id, sid).filter((x) => x.settled_by === "partial"
              && (x.risk_profile_id ?? "medium") === prof && norm(x.market_label) === norm(b.market_label)
              && /\[defensive\]/.test(x.rationale ?? "") && x.settled_at && (Date.parse(x.settled_at) || 0) > lastEventMs);
            const lastDefMs = defCuts.reduce((mx, x) => Math.max(mx, Date.parse(x.settled_at as string) || 0), 0);
            const tooSoon = lastDefMs > 0 && nowMs - lastDefMs < DEFENSIVE_CUT_THROTTLE_MIN * 60_000;
            const tooMany = defCuts.length >= DEFENSIVE_CUT_MAX;
            if (tooSoon || tooMany) {
              const holdKey = `«${b.market_label}» защ-срез`;
              const recentHold = R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === sid).slice(-8).some((e) => e.type === "hold" && e.text.includes(holdKey));
              const why = tooMany ? `уже ${defCuts.length} защитных среза с последнего события (кэп ${DEFENSIVE_CUT_MAX})` : `последний ${Math.round((nowMs - lastDefMs) / 60_000)}м назад < ${DEFENSIVE_CUT_THROTTLE_MIN}м`;
              if (!recentHold) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "hold", text: `частичный защитный срез ${holdKey} отложен — ${why}; держим до нового события/сеттла (defensive_cut_throttle)`, created_at: now });
              continue;
            }
          }
          // Fill the (partial) close against the real bid book — exit slippage into P&L.
          const basis = (b.stake ?? 0) * Math.min(ex.fraction, 1);
          const sell = await sellVwapCents(mk, b.entry_price, basis, poly, deps, mk.price);
          // T1.1 STATE↔PRICE contradiction, SYMMETRIC with evaluateExits: a strategist DEFENSIVE exit must
          // not dump a position that is currently WINNING by the score into a phantom-low bid far below its
          // entry (or an already-won melting option) — the book is a zombie, not a broken thesis. Only for a
          // defensive exit (a take-profit sells into a HIGH bid and never reaches the floor). Anchored on game
          // state so it stays effective as the book decays. Log once per continuous hold period.
          if (defensiveExit) {
            const holdKey = `«${b.market_label}»`;
            const defMin = m.minute ?? minuteApprox;
            const alreadyHeld = () => R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === sid).slice(-8).some((e) => e.type === "hold" && e.text.includes(holdKey));
            const logHold = (why: string) => { if (!alreadyHeld()) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "hold", text: `выход стратега отклонён по ${holdKey}: ${why}`, created_at: now }); };
            // T1.1: state↔price contradiction (winning position dumped into a zombie bid).
            const sc = stopContradictsGameState(b.market_label, m.score_home, m.score_away, { home: m.home, away: m.away }, b.entry_price, sell);
            if (sc) { logHold(sc); continue; }
            // T1.2 (A/B): terminal-phase melting model-fill / winning-by-score hold to settle.
            const th = terminalProtectiveHold(b.market_label, m.score_home, m.score_away, defMin, { home: m.home, away: m.away }, sell.fromBook, true);
            if (th) { logHold(th); continue; }
            // T1.2 (C): a MELTING option defensively sold in the terminal phase BELOW its game-state floor —
            // the option still has live equity the crashed bid isn't paying; hold to settle (Fluminense: sold
            // at 7¢ with model P≈15%, then the goal landed at 90'+14' → won). gsFloor from liveAdjustedProb.
            const gsFloor = gsProbByLabel.get(b.market_label)?.prob ?? null;
            if (winsOnEventOccurrence(b.market_label) && defMin != null && defMin >= TERMINAL_MIN
              && gsFloor != null && sell.cents < gsFloor * 100 - TERMINAL_FLOOR_MARGIN) {
              logHold(`мелтинг-опцион: бид ${sell.cents}¢ ниже game-state-флора ${Math.round(gsFloor * 100)}¢ на ${defMin}' — живой апсайд не оплачен книгой; держим до сеттла (terminal_below_gs_floor)`); continue;
            }
            // T3.1: a totals thesis (Under/No total) BREAKS only when the total reaches the line — the goal
            // COUNT is the fact, not a price move or a single early goal. A counter_scenario / thesis_stop on
            // a totals market still ≥ UNDER_STOP_SUPPRESS_MARGIN goals from the line is premature (Rosenborg:
            // Under 1.5 cut on the FIRST goal at 0:1; it breaks only on the SECOND). Hold — the deterministic
            // layer re-checks every goal. Only the count-based tags; a genuine full break (margin 0) fires.
            if (/counter_scenario|thesis_stop/i.test(ex.trigger ?? "")) {
              // margin = line − total (fractional). > 0 ⟺ the total is still UNDER the line ⟺ goals_to_break > 0
              // ⟺ the totals thesis has NOT broken. Only a crossed line (margin < 0) lets the counter fire.
              const uMargin = underThesisMarginGoals(b.market_label, m.score_home ?? 0, m.score_away ?? 0, { home: m.home, away: m.away });
              if (uMargin != null && uMargin > 0) {
                logHold(`тотал-тезис не сломан: тотал ещё под линией (запас ${uMargin}) при счёте ${m.score_home ?? 0}:${m.score_away ?? 0} — ранний counter/thesis по тоталу отклонён (ломается только голом за линию) (totals_thesis_intact)`); continue;
              }
            }
          }
          // Phantom-bid guard, SYMMETRIC with the deterministic exit path (evaluateExits):
          // a strategist exit (thesis_stop / counter_scenario) must NOT dump into a degenerate
          // bid (≤FLOOR¢) sitting ≥GAP¢ below the mark — that's a momentarily-broken book, not
          // the real value. HOLD and let the position ride to real settlement / a real book next
          // cycle, exactly as a mechanical stop would. Only on a REAL book (fromBook) and only
          // for phantom-LOW bids: a genuine take-profit (high bid) or a modelled parametric price
          // is unaffected. Log at most once per continuous hold period for this market.
          if (sell.fromBook && sell.cents <= EXIT_PHANTOM_FLOOR && (mk.price - sell.cents) >= EXIT_PHANTOM_GAP) {
            const holdKey = `«${b.market_label}»`;
            const recentHold = R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === sid).slice(-8).some((e) => e.type === "hold" && e.text.includes(holdKey));
            if (!recentHold) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "hold", text: `выход стратега отклонён по ${holdKey}: бид ${sell.cents}¢ — фантом при марке ${mk.price}¢ (${ex.reason}); держим до реального рынка/сеттла (exit_phantom_block)`, created_at: now });
            continue;
          }
          // Slippage guard, SYMMETRIC with evaluateExits: don't dump the full stake through a
          // thin book when the best bid can pay far more than the dump realizes — that gap is a
          // depth artifact, not the value. HOLD and let it ride to a deeper book / settlement.
          if (sell.fromBook && sell.bestBidCents != null && (sell.bestBidCents - sell.cents) >= EXIT_SLIPPAGE_BLOCK) {
            const holdKey = `«${b.market_label}»`;
            const recentHold = R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === sid).slice(-8).some((e) => e.type === "hold" && e.text.includes(holdKey));
            if (!recentHold) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "hold", text: `выход стратега отклонён по ${holdKey}: фулл-стейк VWAP ${sell.cents}¢ против бида ${sell.bestBidCents}¢ (слип −${Math.round((sell.bestBidCents - sell.cents) * 10) / 10}¢) — книга не держит размер (${ex.reason}); держим до реального рынка/сеттла (exit_slippage_block)`, created_at: now });
            continue;
          }
          // STALENESS GUARD (audit) — AFTER the phantom/slippage guards, so a degenerate bid is
          // caught as a broken book, not misread as a reprice. On a real, non-degenerate book: if
          // the fresh TOP BID diverged from the decision snapshot (mk.price) by a material amount,
          // reality moved between decision and execution — a goal/red repriced the market (the 64'
          // race: decided at 35¢, book already 95¢; or the reverse — decided at 95¢, crashed to
          // 35¢). Don't execute a decision from a different reality: skip and let the next cycle
          // re-decide on fresh data (the same event triggers that reassessment). Symmetric to entry.
          if (sell.fromBook && sell.bestBidCents != null && mk.price != null && Math.abs(sell.bestBidCents - mk.price) >= EXIT_STALE_GAP) {
            const holdKey = `«${b.market_label}»`;
            const recentHold = R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === sid).slice(-8).some((e) => e.type === "hold" && e.text.includes(holdKey));
            if (!recentHold) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "hold", text: `выход стратега отложен по ${holdKey}: решение по ${mk.price}¢, книга уже ${sell.bestBidCents}¢ (Δ${Math.round(Math.abs(sell.bestBidCents - mk.price))}¢) — событие/сдвиг между решением и исполнением; переоценка на свежих данных (exit_staleness_reassess)`, created_at: now });
            continue;
          }
          // P0.4 PARTIAL-FILL ACCOUNTING (Bohemian «исполнено 20%»): the bid book may absorb only part
          // of the requested exit size. Close ONLY the actually-filled fraction — the remainder stays
          // open and is re-offered next cycle (the same fill invariant tennisTrading already applies).
          // Before this, the full ex.fraction was booked at the thin-book VWAP, so a 20% fill recorded a
          // near-full-position P&L (−$13.30 «полный» на филле 20%) with the other 80% silently vanished.
          const fillFrac = sell.requestedShares > 0 ? Math.min(1, sell.filledShares / sell.requestedShares) : 1;
          const effFraction = ex.fraction * fillFrac;
          if (effFraction <= 1e-6) {
            // The book gave nothing this cycle — hold the WHOLE position, retry on a deeper book. Never
            // fall through to closeBetPortion (fraction 0 hits its closed<=0 → FULL-close fallback).
            const holdKey = `«${b.market_label}»`;
            const recentHold = R.tradeLogForMatch(db, m.id).filter((e) => e.strategy_id === sid).slice(-8).some((e) => e.type === "hold" && e.text.includes(holdKey));
            if (!recentHold) R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "hold", text: `выход стратега по ${holdKey} не исполнен: бид не принял размер (0% филл, ${ex.reason}); держим до реального рынка/сеттла (exit_partial_zero)`, created_at: now });
            continue;
          }
          // T1.3: tag a DEFENSIVE partial so the throttle/count-cap above can distinguish it from a take-profit
          // partial (which is spaced by its own throttle). Only partial defensive cuts carry the marker.
          const { pnl, partial } = closeBetPortion(db, b, effFraction, sell.cents, minuteLabel(m), now, defensiveExit && effFraction < 1 ? "defensive" : undefined);
          if (sell.cost) recordFill(db, { betId: b.id, matchId: m.id, competitionId: m.competition_id, strategyId: sid, profileId: profile }, sell.cost, now);
          const tag = partial ? `частично ${Math.round(effFraction * 100)}%` : "полностью";
          // F1: a defensive tag that reaches HERE is already condition-verified (unverified ones were blocked
          // above) — no more «discretionary» demotion, the category is gone. Just name the fired trigger.
          const trg = ex.trigger ? ` (${ex.trigger})` : "";
          R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m), type: "exit", text: `выход «${b.market_label}» (${tag})${trg} @ ${sell.cents}¢ · стратег: ${ex.reason}${sell.note ? ` · ${sell.note}` : ""}${modelFillTag(sell.fromBook)} · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, created_at: now });
          out.exits.push({ matchId: m.id, strategyId: sid, market: b.market_label, reason: `стратег (${tag}): ${ex.reason}`, pnl });
          exitedMarkets.push(`${b.market_label} (${tag})`);
          touched.add(sid);
        }

        // (b) ENTRIES — live positions the trigger/plan opened (buyback, xG add).
        // Only a pair with an ACTIVE share can open (pct=0 = exit-only pair whose
        // share was removed). Code sizes/gates via the profile's risk_config (§9.6,
        // module #3/#5); the strategist re-estimates the live prob, edge is off the
        // de-vigged price. Dedup against markets this pair already holds/proposed.
        // P0.3: prematch_value is DEFEND-ONLY in live — it never opens a new position, no exceptions. The
        // prompt says so; this is the code belt behind it. Even a cached prompt or a stray LLM pick is
        // refused here, and the refusal is logged (phantom accounting: the record reflects the ACTUAL
        // pipeline outcome — «отклонён кодом», never a fictional «вошёл»).
        if (sid === "prematch_value" && pct > 0 && dec.picks.length) {
          R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: sid, minute: `${m.minute ?? minuteApprox ?? "?"}'`, type: "skip", text: `[${profile}] prematch_value_live_entry_blocked: live = только защита, ${dec.picks.length} pick(s) отклонены кодом (P0.3 — exception удалён)`, created_at: now });
        }
        if (pct > 0 && dec.picks.length && sid !== "prematch_value") {
          const budget = stratBudget(c.budget, pct);
          const cfg = getProfileConfig(db, profile);
          const pairBets = R.betsForMatch(db, m.id, sid).filter((b) => (b.risk_profile_id ?? "medium") === profile);
          const liveHeld = pairBets.filter((b) => b.status === "open" || b.status === "proposed");
          const myPairSettled = pairBets.filter((b) => b.status === "settled_lost"); // for the re-entry cooldown
          const held = new Set(liveHeld.map((b) => norm(b.market_label)));
          // §9.3 cap is per-COMPETITION and per-pair (open + proposed − realized).
          let exposure = strategyCompExposure(db, comp, sid, profile) - strategyCompRealized(db, comp, sid, profile);
          let matchExposure = myOpen.reduce((s, b) => s + (b.stake ?? 0), 0);
          // Same-event correlation exposure, seeded from held/proposed positions so
          // a live add to a correlated market stacks against them (see correlationKey).
          const clusterExp = new Map<string, number>();
          for (const b of liveHeld) { const k = correlationKey(b.market_label, m.home, m.away); if (k) clusterExp.set(k, (clusterExp.get(k) ?? 0) + (b.stake ?? 0)); }
          // T3.2: the strategist's OWN rejected[] is authoritative over its picks — a market it named as
          // rejected («коррелирует против тезиса», «дубликат-конфликт», placeholder price) must NEVER be
          // opened, even if it also (contradictorily) appears in picks/actions (Hammarby BTTS-Yes: rejected
          // by every profile, still entered live). The execution gate reads the rejected set and hard-blocks.
          const rejectedSet = new Set((dec.rejected ?? []).map((r) => norm(r.market)));
          for (const pick of dec.picks) {
            // T2.2: a HOLD ticket never opens. If the pair already holds this market, holding is the default
            // (nothing to do); if it holds NOTHING, a hold pick is a NO-OP — it must not manufacture a new
            // position (the Cruz Azul/Göteborg/Hammarby «hold, не новый вход» → phantom «вошёл» bug).
            if (pick.hold) { unfilled.push(`«${pick.label}» — hold-тикет, позиция не открывается (hold_no_op)`); continue; }
            if (rejectedSet.has(norm(pick.label))) { unfilled.push(`«${pick.label}» — в rejected того же решения, вход заблокирован (rejected_market_block)`); continue; }
            const mk = markets.find((x) => norm(x.label) === norm(pick.label)) ?? markets.find((x) => sameMarketLabel(x.label, pick.label));
            if (!mk || mk.price == null) { unfilled.push(`«${pick.label}» — нет рынка`); continue; }
            // P1: never open into a quarantined book (the strategist shouldn't even see it, but a cached
            // plan / battle-sheet trigger could still name it) — belt behind the context filter.
            const zr = zombie.get(mk.label);
            if (zr) { unfilled.push(`«${mk.label}» — рынок на карантине (${zr.code}): ${zr.detail} (zombie_quarantine:${zr.code})`); continue; }
            // LIVE re-scoring: size off the strategist's OWN current probability (it
            // re-estimates from the live score/minute — a 0:2 game's "Over 1.5" is
            // ~1.0, not the stale pre-match prob). Fall back to the stored prob only
            // if none given. Refresh the market ai_prob so the UI edge is live too.
            const ourProb = pick.prob != null ? pick.prob : mk.ai_prob;
            if (ourProb == null) { unfilled.push(`«${mk.label}» — нет оценки`); continue; }
            if (pick.prob != null) R.setMarketAiProb(db, mk.id, pick.prob);
            if (held.has(norm(mk.label))) continue;                       // already in this market
            // PROB-SUM COHERENCE (audit #4: Larne «Draw 100¢» + «Draw — No 100¢» = 200¢; corrupted
            // 3-way twins). Two supposedly-complementary contracts whose prices sum far from 100¢ are
            // an incoherent/duplicated book — the "edge" against either is a phantom of the bad quote.
            // The prematch analysis path already blocks these (analysis.ts probSumFlags); wire the SAME
            // guard into the LIVE entry path, which was ungated. Reuses the cycle's de-vig groupSum.
            const psInfo = impliedMap.get(mk.label);
            if (psInfo?.sided && psInfo.groupSum != null && Math.abs(psInfo.groupSum - 1) > cfg.safeguards.prob_sum_tolerance + 1e-9) {
              unfilled.push(`«${mk.label}» — сумма пары ${Math.round(psInfo.groupSum * 100)}¢ вне допуска (±${Math.round(cfg.safeguards.prob_sum_tolerance * 100)}¢) — несогласованный/дублированный рынок, не торгуем (prob_sum_block)`);
              continue;
            }
            // MARTINGALE BLOCK (audit #3b: NWSL VAR martingale $80→$200; Örgryte re-add). This pair
            // already CLOSED this market at a LOSS in THIS match — re-entering is doubling down into a
            // broken thesis, the escalation pattern INDEPENDENT of where the (possibly phantom) edge
            // came from. Widened from a time-window cooldown to the WHOLE MATCH (Petro): an
            // early/partial losing close can only occur mid-live, and a real end-of-match settlement
            // never triggers it, so match-scope is safe. A WINNING close never blocks (re-entry ok).
            const lostThisMarket = myPairSettled.some((x) => x.status === "settled_lost"
              && (x.settled_by === "early" || x.settled_by === "partial")
              && norm(x.market_label) === norm(mk.label));
            if (lostThisMarket) { unfilled.push(`«${mk.label}» — уже был убыточный выход в этом матче, доливка запрещена (martingale_block)`); continue; }
            const implied = impliedMap.get(mk.label)?.implied ?? mk.price / 100;
            const cKey = correlationKey(mk.label, m.home, m.away);
            const r = sizePrematch({ ourProb, priceCents: mk.price, implied, calibration, liquidity: liqNum(mk.liquidity), budget, matchExposure, compExposure: exposure, clusterExposure: cKey ? (clusterExp.get(cKey) ?? 0) : 0, cfg, allowLargeEdge: true });
            if (r.status !== "enter") { unfilled.push(`«${mk.label}» — ${r.reason}`); continue; }
            exposure += r.stake; matchExposure += r.stake;
            if (cKey) clusterExp.set(cKey, (clusterExp.get(cKey) ?? 0) + r.stake);
            held.add(norm(mk.label));
            // Decision-time snapshot for a LIVE entry — includes the game-state live_prob_adjusted.
            const liveMin = m.minute ?? minuteApprox;
            const liveEntryMeta: BetEntryMeta = {
              phase: "live", minute: liveMin, scoreHome: m.score_home ?? null, scoreAway: m.score_away ?? null,
              edge: round2(r.edge), aiProb: round2(ourProb), derivedProb: mk.ai_prob != null ? round2(mk.ai_prob) : null,
              marketPrice: mk.price, impliedProb: round2(implied), liveProbAdjusted: gsProbByLabel.get(mk.label)?.prob ?? null,
              kellyFraction: round2(r.kellyFraction), sizeRequested: round2(r.stake), sizeFilled: null, entrySlipCents: null,
              calibration: calibration != null ? round2(calibration) : null,
              branchWeightSum: pick.branchWeightSum != null ? round2(pick.branchWeightSum) : null,
              phantomCheck: pick.phantomCheck ?? null, marketThinnessUsd: liqNum(mk.liquidity),
              winsOnEvent: winsOnEventOccurrence(mk.label), exitPlan: pick.exitPlan ?? null,
              // Live entries run the live-reassess tier (model_live→model→Opus); analysis = the
              // model that analysed the match (duel arm), so the bet is fully attributable.
              models: { analysis: assess?.model ?? null, strategist: strat.model_live ?? strat.model ?? "Claude Opus 4.8" },
            };
            R.insertBet(db, {
              id: R.uid(), match_id: m.id, strategy_id: sid, risk_profile_id: profile, market_label: mk.label,
              status: "proposed", proposed_price: mk.price, entry_price: null, current_price: null,
              closing_price: null, ai_prob: ourProb, stake: r.stake,
              rationale: `переоценка (лайв): «${mk.label}» edge ${(r.edge * 100).toFixed(1)}%. ${pick.reason || r.reason}.`,
              entered_minute: null, result: null, payout: null, entry_meta: serializeEntryMeta(liveEntryMeta), code_version: effectiveCodeVersion(db, analysisTag), created_at: now,
            });
            out.entries.push({ matchId: m.id, strategyId: sid, market: mk.label, stake: r.stake });
            enteredMarkets.push(mk.label);
            touched.add(sid);
          }
        }

        // Reassessment note (Переоценки tab) — written AFTER acting, LEADING with
        // the FACTUAL result so it can't imply positions that weren't opened.
        const facts: string[] = [];
        if (enteredMarkets.length) facts.push(`вошёл: ${enteredMarkets.join(", ")}`);
        if (exitedMarkets.length) facts.push(`вышел: ${exitedMarkets.join(", ")}`);
        if (!enteredMarkets.length && !exitedMarkets.length) facts.push(myOpen.length ? `держу ${myOpen.length} поз.` : "позиций нет, вход не сделан");
        if (unfilled.length) facts.push(`не вошёл: ${unfilled.slice(0, 3).join("; ")}`);
        const branchNote = dec.currentBranch ? ` [ветка: ${dec.currentBranch}]` : ""; // which of the 6 outcome branches the match is in now
        const noteBody = `${facts.join(" · ")}${branchNote}.${dec.note?.trim() ? " " + dec.note.trim() : ""}`;
        // Only write a note whose text we haven't already written for this strategy this
        // tick — a profile that acted differently produces a distinct body and is kept.
        if (!seenReassessBodies.has(noteBody)) {
          seenReassessBodies.add(noteBody);
          R.insertReassessment(db, {
            id: R.uid(), match_id: m.id, strategy_id: sid, minute: minuteLabel(m),
            body: noteBody, confidence: assess?.confidence ?? null,
            trigger: labelFor.get(m.id) ?? "time", created_at: now,
          });
        }
      }
    }
  }
  for (const sid of touched) recomputeMetrics(db, sid, deps);
  // P0.4 METRIC (до/после): cumulative LLM calls vs deterministic gate skips, so the operator can
  // re-measure the «LLM-мельница» ratio (base was 91 calls / 7 matches, ~all «воздерживаюсь»). Cheap
  // running counters in app_meta — read by ops; never a money decision.
  if (out.llmCalls || (out.gateSkips ?? 0)) {
    const bump = (k: string, by: number) => { if (by) R.metaSet(db, k, String(Number(R.metaGet(db, k) ?? 0) + by), now); };
    bump("reassess_llm_calls_total", out.llmCalls);
    bump("reassess_gate_skips_total", out.gateSkips ?? 0);
    // F5: anchor the counters so «LLM-calls-per-traded-match» has an honest denominator (bets since the
    // anchor), not the all-time match count. Set once, on the first tick that touches the counters.
    if (!R.metaGet(db, "reassess_counter_since")) R.metaSet(db, "reassess_counter_since", now, now);
  }
  return out;
}

// ------------------------------------------------------------
// 4) Orchestration
// ------------------------------------------------------------

export interface AutoCycleResult {
  synced: number; imported: number; discovered: number; oddsMatches: number; oddsUpdated: number;
  enriched: number; triggers: number;
  analyzed: AutoAnalyzeItem[]; entered: AutoEnterItem[]; exited: ExitItem[]; reassessEntries: ReassessEntry[];
  /** strategist LLM calls made this pass and how many failed (outage/budget/parse).
   *  Surfaced in the cron log so an outage window is data, not an inferred gap. */
  llmCalls: number; llmFail: number;
}

/**
 * One full automated pass. Order matters: import & status first (settles
 * finished matches, fires goal reassessments), then refresh prices (mark to
 * market, price_move reassessments), then exits on fresh prices, then analyze
 * newly-eligible matches, then fill their proposals.
 */
export async function runAutoCycle(
  db: Database, provider: SportsProvider | null, deps: EngineDeps = {}, opts: { linkOdds?: boolean; discoverLimit?: number; discover?: boolean } = {},
): Promise<AutoCycleResult> {
  // Each stage is isolated: a transient throw in one provider call (ESPN /
  // Polymarket network blip) must NOT abort the whole cycle and skip the
  // downstream money-management steps (exits / entries / settlement). Failed
  // stages degrade to their empty result and the pass continues.
  const step = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) { console.error(`[autoCycle:${label}]`, e instanceof Error ? e.message : e); return fallback; }
  };
  const stepSync = <T>(label: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (e) { console.error(`[autoCycle:${label}]`, e instanceof Error ? e.message : e); return fallback; }
  };

  const synced = provider ? await step("sync", () => syncCompetitions(db, provider!, deps, opts), []) : [];
  // Discover the many matches Polymarket lists directly (into catch-all comps).
  // Gated by opts.discover so the frequent tick can skip the daily-ish parse.
  let discovered = 0;
  if (opts.discover !== false) {
    for (const sport of Object.keys(SPORT_TAG_IDS)) {
      const items = await step("discover", () => importPolymarketMatches(db, sport, deps, { limit: opts.discoverLimit }), [] as any[]);
      discovered += items.length;
    }
  }
  // Drop duplicate fixtures (a Polymarket row + a market-less provider clone that
  // slipped past name-matching) BEFORE enrich, so provider data lands on the
  // surviving tradeable row, not the bare clone.
  stepSync("dedupe", () => dedupeMatches(db), 0);
  const odds = await step("odds", () => refreshActiveOdds(db, deps), [] as Awaited<ReturnType<typeof refreshActiveOdds>>);
  // Pull real lineups + live events (ESPN) — this feeds matchContext and, via
  // its fresh events, arms the strategist's in-match reassessment triggers.
  const enrich = provider ? await step("enrich", () => enrichFromEspn(db, provider!, deps), { enriched: 0, newEvents: [] }) : { enriched: 0, newEvents: [] };
  // P0.1 backfill (slow cadence, bounded): re-fetch the ESPN date for historically-bound matches with no
  // frozen espn_event_date, then CLEAR settle_suspect on the ones proven clean (|Δkickoff| ≤ 1 day).
  if (provider) await step("fixtureDateBackfill", async () => { const r = await backfillEspnEventDates(db, provider!, deps); return r.dated; }, 0);
  const labelFor = new Map<string, ReassessTrigger>();
  for (const e of enrich.newEvents) if (!labelFor.has(e.matchId)) labelFor.set(e.matchId, LIVE_TRIGGER_TYPES.has(e.type) ? (e.type as ReassessTrigger) : "price_move");
  const triggers = new Set(enrich.newEvents.map((e) => e.matchId));
  stepSync("advanceClocks", () => advanceClocks(db, deps), undefined); // flip lineup_out ~1h before kickoff
  stepSync("stats", () => recordMatchStats(db, deps), 0); // 5-min match-stats snapshot into the events feed
  stepSync("settleStale", () => settleStaleOpenBets(db, deps), 0); // re-settle a finish that raced ahead of the score sync
  stepSync("captureLiveOpens", () => captureLiveOpens(db, deps), undefined); // kickoff-price baseline
  // Analyze BEFORE reassessment: analyzeMatch wipes a match's proposed bets to
  // replace them with the fresh stage's, which would otherwise delete brand-new
  // reassessment proposals created in the same cycle. Running it first means the
  // reassessment's entries are added afterwards and survive to autoEnter.
  const analyzed = await step("analyze", () => autoAnalyze(db, deps), [] as AutoAnalyzeItem[]);
  // Re-run the strategist engine on already-analysed matches whose current roster
  // changed (e.g. after reassigning strategies/profiles) — cheap, no re-analysis.
  await step("runStrategists", () => autoRunStrategists(db, deps), [] as AutoStrategistItem[]);
  // deterministic safety-net exits, then strategist-driven reassessment (exits +
  // fresh entries) on matches with risk or a fresh live trigger.
  // Raw provider + Polymarket snapshots (pre-match on the slow tick) — additive
  // capture for the post-match provider comparison; isolated so a provider blip
  // never aborts the money steps below.
  await step("snapshots", () => collectSnapshots(db, deps), 0);
  // Tennis provider scouting (Stage 0) — parallel, observe-only, gated on API_TENNIS_KEY.
  // Never touches football/money-path; isolated so a provider blip can't abort the tick.
  await step("tennisScout", () => collectTennisSnapshots(db, deps), 0);
  // Scout watchdog (the signal it never had): alert ONCE when the scout is silent while the schedule
  // says a match should be live — self-concealing death otherwise (a dead scout drops the match out of
  // "live", which then blinds the heartbeat's own recovery). Throttled: one alert per silence episode,
  // cleared on recovery, so a genuinely quiet slate never flaps.
  stepSync("tennisScoutWatchdog", () => {
    const at = nowFn(deps)();
    const h = tennisScoutSilence(db, deps);
    const KEY = "tennis_scout_silence_alerted";
    if (h.silent && !R.metaGet(db, KEY)) {
      console.warn(`[tennisScout] ${h.note}`);
      try { R.insertCronLog(db, { id: R.uid(), at, kind: "tick", ok: 0, summary: h.note, created_at: at }); } catch { /* journal best-effort */ }
      R.metaSet(db, KEY, "1", at);
    } else if (!h.silent && R.metaGet(db, KEY)) {
      R.metaSet(db, KEY, "", at); // recovered → re-arm the one-shot alert for the next episode
    }
    return 0;
  }, 0);
  stepSync("tennisBreakMarks", () => recordTennisBreakMarks(db, deps), 0); // mark completed break windows (≥6min old)
  await step("tennisExit", () => tennisExitTick(db, deps), 0);             // §6 paper: deterministic take_price / thesis_stop close via the book (no LLM, §9.6)
  await step("tennisFinalPoll", () => pollTennisFinals(db, deps), 0);      // A+B: chase FINAL results via get_fixtures for stranded positions (live feed drops finished matches) → writes the terminal snapshot settle consumes
  stepSync("tennisFinish", () => finishTennisMatches(db, deps), 0);        // drive tennis matches to finished from the scout (else they pile up in live)
  stepSync("tennisSettle", () => settleTennisBets(db, deps), 0);           // safety-net settle for finished tennis matches
  stepSync("tennisPmvSettle", () => settleTennisPmvBets(db, deps), 0);     // safety-net settle for PMV props (Gate-0.2 void clauses)
  stepSync("pmvShadowResolve", () => { const r = resolvePmvShadowSignals(db, deps); return r.resolved + r.unresolved; }, 0); // score flag-only would-be entries post-match (no money)
  stepSync("svShadowResolve", () => { const r = resolveSvShadowSignals(db, deps); return r.resolved + r.unresolved; }, 0); // score set_value flag-only would-be entries post-match (no money)
  const reassess = await step("reassess", () => strategistReassess(db, deps, { newEventMatchIds: triggers, labelFor }), { exits: [], entries: [], llmCalls: 0, llmFail: 0 } as ReassessResult);
  const exited = [...await step("exits", () => evaluateExits(db, deps), [] as ExitItem[]), ...reassess.exits];
  const entered = await step("autoEnter", () => autoEnter(db, deps), [] as AutoEnterItem[]); // fills both analyze- and reassess-proposed bets
  // §5 real EXIT mirror: close dry positions whose paper twin has settled (gate-first: off → no-op).
  if (readTradingMode(deps.env) !== "off") await step("dryExitSweep", () => sweepDryExits(db, { env: deps.env ?? process.env, poly: deps.polymarket ?? loadPolymarketConfig(deps.env), deps, now: () => nowFn(deps)(), bookCache: new Map() }), 0);
  stepSync("prune", () => R.pruneMarketSnapshots(db), 0); // keep the snapshot history bounded (persistent DB)
  stepSync("pruneProviderSnapshots", () => { const cut = new Date((Date.parse(nowFn(deps)()) || Date.now()) - SNAPSHOT_RETENTION_DAYS * 86400_000).toISOString(); R.pruneSnapshots(db, cut); R.pruneTennisSnapshots(db, cut); R.capTennisSnapshots(db); R.capTennisMapLog(db);
    // T1: record the ACTUAL retained tennis-snapshot window so the retro-cohort depth is visible (the 20k
    // row-cap undercuts SNAPSHOT_RETENTION_DAYS when scouting is dense). Read by ops / the sv_cohort report.
    try { const d = R.tennisSnapshotDepth(db); R.metaSet(db, "tennis_snapshot_depth", JSON.stringify(d), nowFn(deps)()); } catch { /* best-effort */ }
    return 0; }, 0); // snapshot retention + hard row-caps — a burst once bloated tennis_snapshots to 1.2 GB and starved boot
  // A match that passed kickoff but never went live (scout never saw the court / ESPN never delivered)
  // is stuck in upcoming/lineup — give it a terminal state so it leaves «Актуальные» within a tick
  // (voids its open bets, flags it «поломан» for the «Поломанные» bucket) instead of lingering 3 days.
  stepSync("sweepAbandoned", () => { const r = sweepAbandonedMatches(db, Date.parse(nowFn(deps)()) || Date.now()); return r.abandoned + r.fixed; }, 0);
  // Bound the matches table: drop finished/stale matches that carry NO bets (the
  // Polymarket discovery flood). Never touches a match with betting history, so
  // metrics/P&L are preserved. Keeps buildAppData's per-poll scan bounded (§502).
  stepSync("pruneMatches", () => R.pruneStaleMatches(db, { staleBeforeMs: (Date.parse(nowFn(deps)()) || Date.now()) - 3 * 86400_000 }), 0);
  // Drop categories we no longer track: untracked sports (cricket) + non-ATP
  // tennis. No-bet only, never a seeded comp. Discovery already stops importing
  // them; this clears the ones imported before the rule changed.
  // Reconcile football categories against PROVEN provider coverage: backfill the
  // ESPN league on any that was mis/unmapped at import, fund a covered-but-unfunded
  // one, and delete a category we never received live data for (unmapped like the
  // Chinese Super League, or a wrong code) that holds no real P&L and has no
  // matches left. Runs before the generic prune so freshly-backfilled leagues keep
  // their new mapping. (Empirical: funded ⇔ ESPN-mapped, surviving ⇔ ESPN-fed.)
  stepSync("reconcileFootball", () => reconcileFootballCategories(db, nowFn(deps)(), espnLeagueForSeries).deleted, 0);
  stepSync("pruneCategories", () => R.pruneRemovedCategories(db, {
    keepSports: new Set(Object.keys(SPORT_LABELS)),
    tennisSeriesAllow: seriesAllowFor("tennis", deps.env), // null = unrestricted (keep all liquid tennis)
  }), 0);
  return {
    synced: synced.length, imported: synced.filter((r) => r.created).length, discovered,
    oddsMatches: odds.length, oddsUpdated: odds.reduce((n, r) => n + r.updated, 0),
    enriched: enrich.enriched, triggers: triggers.size,
    analyzed, entered, exited, reassessEntries: reassess.entries,
    llmCalls: reassess.llmCalls, llmFail: reassess.llmFail,
  };
}

// High-impact events that warrant an immediate strategist reassessment (an LLM
// call). Goals and red cards change the game state; yellows/subs are recorded
// and shown, but don't burn a model call on the fast loop.
// A penalty (saved/missed/awarded) is a high-impact swing — the scoreline often
// doesn't move but the game state does (a ~0.79 xG chance, momentum, emotion) —
// so it fires an immediate reassessment like a goal / red card.
const LIVE_TRIGGER_TYPES = new Set(["goal", "red_card", "penalty"]);

// The periodic LLM reassessment HEARTBEAT: the slowest, cheapest safety net. On-pitch
// events (goal / red / penalty) and price_move triggers fire their OWN reassessment
// immediately and DON'T wait for this interval (see the reassess-trigger union in
// runLiveCycle) — this is only the "nothing happened, re-check for creep" cadence. It's
// the main LLM-cost + micro-churn lever, so it's deliberately slower than the data/stats
// cadence (a quiet 0:0 shouldn't burn a reassessment every few minutes). Env-tunable.
export const REASSESS_INTERVAL_MIN = (() => { const n = Number(process.env.REASSESS_INTERVAL_MIN); return Number.isFinite(n) && n >= 1 ? n : 10; })();
// Safety ceiling on (strategy, profile) pairs reassessed for ONE match per run —
// high enough to cover every real pair (≈ strategies × profiles) so none is
// starved, low enough to bound a pathological config.
const MAX_PAIRS_PER_MATCH = 24;

// Provider snapshots are the raw material for later strategy research (build
// «свой» models once we've accrued ~50 matches), so we DON'T prune them on the
// short retention the market snapshots use — keep them for years. Env-overridable.
export const SNAPSHOT_RETENTION_DAYS = Math.max(1, Number(process.env.SNAPSHOT_RETENTION_DAYS ?? 5));

// Match-stats snapshots are DATA (layer 1) — decoupled from the LLM reassessment
// heartbeat so the possession/shots feed stays dense (raw material for lag/CLV research)
// even as the expensive reassessment cadence is dialled slower. Default 5 min. Env-tunable.
export const STATS_INTERVAL_MIN = (() => { const n = Number(process.env.STATS_INTERVAL_MIN); return Number.isFinite(n) && n >= 1 ? n : 5; })();

/** Format the stored ESPN team-stats JSON into one compact «home–away» line, e.g.
 *  "владение 58%–42% · удары 7–4 · в створ 3–1". Returns null if there's nothing. */
export function formatMatchStats(statsJson: string | null | undefined): string | null {
  if (!statsJson) return null;
  let s: any;
  try { s = JSON.parse(statsJson); } catch { return null; }
  const home = s?.home, away = s?.away;
  const hi = new Map<string, string>(((home?.items ?? []) as any[]).map((x) => [x.label, x.value]));
  const ai = new Map<string, string>(((away?.items ?? []) as any[]).map((x) => [x.label, x.value]));
  // Preserve the order stats appear in for the home side, then any away-only labels.
  const labels = [...hi.keys(), ...[...ai.keys()].filter((l) => !hi.has(l))];
  const parts = labels.map((l) => `${l} ${hi.get(l) ?? "—"}–${ai.get(l) ?? "—"}`);
  if (!parts.length) return null;
  return parts.join(" · ");
}

/**
 * Emit a match-stats snapshot into the events feed for each LIVE match that has
 * ESPN stats, at most one per STATS_INTERVAL_MIN (wall-clock) — the possession /
 * shots / chances readout of «what's happening now», beside goals & cards. Cheap,
 * LLM-free, and deduped by a fresh event_key so it layers a new row each cadence.
 */
export function recordMatchStats(db: Database, deps: EngineDeps = {}): number {
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  let written = 0;
  for (const { match: m } of activeMatches(db)) {
    if (m.state !== "live") continue;
    const live = R.getMatchLive(db, m.id);
    // Prefer real ESPN team stats (possession/shots); fall back to a basic market
    // snapshot (score + prices) so «События матча» ALWAYS shows a 5-min heartbeat,
    // even on matches ESPN can't feed (tennis / obscure leagues) — otherwise the
    // tab would be empty and vanish there.
    const text = formatMatchStats(live?.stats) ?? formatMarketSnapshot(db, m);
    if (!text) continue;
    // Elapsed minute for a clock-only match (no ESPN minute), for the event label.
    const elapsed = m.minute ?? (isIsoTs(m.kickoff_at) ? Math.max(0, Math.floor((nowMs - Date.parse(m.kickoff_at as string)) / 60000)) : null);
    // Cadence gate: skip if a stats snapshot landed within the last interval.
    const prior = R.eventsForMatch(db, m.id).filter((e) => e.type === "stats");
    const last = prior.length ? Date.parse(prior[prior.length - 1].created_at) : NaN;
    if (!isNaN(last) && nowMs - last < STATS_INTERVAL_MIN * 60_000) continue;
    if (R.insertMatchEvent(db, { id: R.uid(), match_id: m.id, event_key: `stats-${now}`, minute: elapsed, type: "stats", team: null, text, created_at: now })) written++;
  }
  return written;
}

const isIsoTs = (s: string | null | undefined): boolean => !!s && /^\d{4}-\d\d-\d\dT/.test(s) && !isNaN(Date.parse(s));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Shorten a verbose Polymarket label for the snapshot: drop the "Tournament: "
 *  prefix and the redundant "A vs B" match title, leaving just the market bit
 *  ("Set 1 Over 10.5"). Falls back to the bare side/name for a plain moneyline. */
function shortMarketLabel(label: string, home: string, away: string): string {
  let s = label.replace(/^[^:]{1,40}:\s*/, ""); // "Quito: ..." → "..."
  for (const [a, b] of [[home, away], [away, home]])
    s = s.replace(new RegExp(`${escapeRe(a)}\\s+vs\\.?\\s+${escapeRe(b)}`, "i"), "");
  s = s.replace(/\bvs\.?\b/i, "").replace(/\s{2,}/g, " ").trim();
  return s || "победитель"; // the title emptied out → it's the match-winner market
}

/** Basic market snapshot for a live match with no sport-stats feed: current score
 *  (if any) + the market-implied leaders — «what's happening now» through the
 *  market, so «События матча» has a heartbeat even without ESPN. Kept short:
 *  degenerate/settled markets (≈0/100¢, "Completed Match") dropped, labels
 *  stripped of the repeated match title, capped to the top 2 by price. */
function formatMarketSnapshot(db: Database, m: Match): string | null {
  const markets = R.latestMarkets(db, m.id).filter((mk) =>
    mk.price != null && mk.price > 2 && mk.price < 98 && !/completed match/i.test(mk.label));
  if (!markets.length) return null;
  const seen = new Set<string>();
  const top: string[] = [];
  for (const mk of markets.slice().sort((a, b) => (b.price ?? 0) - (a.price ?? 0))) {
    const lbl = shortMarketLabel(mk.label, m.home, m.away);
    if (seen.has(lbl)) continue;
    seen.add(lbl);
    top.push(`${lbl} ${mk.price}¢`);
    if (top.length >= 2) break;
  }
  if (!top.length) return null;
  const score = (m.score_home != null && m.score_away != null) ? `счёт ${m.score_home}:${m.score_away} · ` : "";
  return `${score}рынок: ${top.join(" · ")}`;
}

/** LIVE matches due for a periodic reassessment — those not reassessed in the
 *  last REASSESS_INTERVAL_MIN minutes (or never). Fires on ANY funded live match
 *  with tradeable markets, regardless of whether a position is open: reassessment
 *  is both fresh analytics AND a chance to open/exit, so it must not wait for an
 *  on-pitch event (user: «переоценку надо делать каждые 5 минут независимо»).
 *  Gated to state==="live" only: pre-match (`lineup`/time-flipped `lineup_out`)
 *  has no game to react to, and the heartbeat there just churned reassessments. */
function periodicReassessMatches(db: Database, deps: EngineDeps): Set<string> {
  const nowMs = Date.parse(nowFn(deps)()) || Date.now();
  const budgetByComp = new Map(R.listCompetitions(db).map((c) => [c.id, c.budget]));
  const due = new Set<string>();
  for (const { comp, match: m } of activeMatches(db)) {
    if (m.state !== "live") continue;
    if ((budgetByComp.get(comp) ?? 0) <= 0) continue;        // unfunded → skip (economical)
    if (!R.latestMarkets(db, m.id).length) continue;         // nothing to price/trade
    const notes = R.reassessmentsForMatch(db, m.id);
    const last = notes.length ? Date.parse(notes[notes.length - 1].created_at) : NaN;
    if (isNaN(last) || nowMs - last >= REASSESS_INTERVAL_MIN * 60_000) due.add(m.id);
  }
  return due;
}

export interface LiveCycleResult { live: number; oddsUpdated: number; enriched: number; triggers: number; exits: number; entries: number; llmCalls: number; llmFail: number }

/**
 * FAST live loop — runs on a short cadence (every LIVE_TICK_SEC, default 90s)
 * so the system reacts to what happens ON the pitch, not on the 30-minute tick.
 * It is deliberately narrow and cheap:
 *   1) re-price only live/lineup matches (mark to market),
 *   2) pull fresh ESPN events (goals / cards / subs),
 *   3) deterministic exits (take-profit / stop) — no LLM, every tick,
 *   4) strategist reassessment ONLY on a high-impact trigger (goal / red card),
 *      handing it the live context so it acts on open positions or opens new.
 * No Polymarket discovery, no pre-match analysis — those stay on the slow cycle.
 * Returns quickly (and does ~nothing) when no match is in play.
 */
export async function runLiveCycle(
  db: Database, provider: SportsProvider | null, deps: EngineDeps = {}, opts: { exitsOnly?: boolean } = {},
): Promise<LiveCycleResult> {
  const stepLive = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) { console.error(`[liveCycle:${label}]`, e instanceof Error ? e.message : e); return fallback; }
  };
  const stepSyncLive = <T>(label: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (e) { console.error(`[liveCycle:${label}]`, e instanceof Error ? e.message : e); return fallback; }
  };
  const inPlay = activeMatches(db).filter(({ match: m }) => m.state === "live" || m.state === "lineup" || m.lineup_out);
  if (!inPlay.length) { stepSyncLive("settleStale", () => settleStaleOpenBets(db, deps), 0); return { live: 0, oddsUpdated: 0, enriched: 0, triggers: 0, exits: 0, entries: 0, llmCalls: 0, llmFail: 0 }; }

  // P0.2: EXITS-ONLY protective pass (boot-grace / post-restart). A restart mid-live-match kills the
  // in-process loop, and the 300s boot-grace keeps the HEAVY cycle silent so the port probe stays free —
  // but that left protective stops unmanaged for the whole grace (the Gorgodze/Vacherot floor overshoot:
  // stop at 21¢ realized at 9¢ during a 27-min live blackout). This runs ONLY the price-refresh + the
  // deterministic (no-LLM) exit/settle steps — bounded to live matches, no entries, no analysis, no
  // reassessment, no discovery — so stops fire on fresh prices without the event-loop starvation that
  // boot-grace exists to prevent.
  if (opts.exitsOnly) {
    const odds = await stepLive("odds", () => refreshActiveOdds(db, deps, { onlyLive: true }), [] as Awaited<ReturnType<typeof refreshActiveOdds>>);
    stepSyncLive("advanceClocks", () => advanceClocks(db, deps), undefined);
    stepSyncLive("settleStale", () => settleStaleOpenBets(db, deps), 0);
    await stepLive("tennisScout", () => collectTennisSnapshots(db, deps), 0);   // fresh tennis prices for the stops
    const tExit = await stepLive("tennisExit", () => tennisExitTick(db, deps), 0); // deterministic tennis stops (no LLM)
    stepSyncLive("tennisFinish", () => finishTennisMatches(db, deps), 0);
    stepSyncLive("tennisSettle", () => settleTennisBets(db, deps), 0);
    const detExits = await stepLive("exits", () => evaluateExits(db, deps), [] as ExitItem[]); // deterministic football TP/stop
    return { live: inPlay.length, oddsUpdated: odds.reduce((n, r) => n + r.updated, 0), enriched: 0, triggers: 0, exits: detExits.length + tExit, entries: 0, llmCalls: 0, llmFail: 0 };
  }

  // Each stage isolated: a transient throw in one (a DB/JSON error inside enrich,
  // a settleMatch throw) must NOT abort the deterministic exits / autoEnter below.
  const odds = await stepLive("odds", () => refreshActiveOdds(db, deps, { onlyLive: true }), [] as Awaited<ReturnType<typeof refreshActiveOdds>>);
  stepSyncLive("advanceClocks", () => advanceClocks(db, deps), undefined);
  const enrich = provider ? await stepLive("enrich", () => enrichFromEspn(db, provider, deps), { enriched: 0, newEvents: [] }) : { enriched: 0, newEvents: [] };
  stepSyncLive("settleStale", () => settleStaleOpenBets(db, deps), 0); // re-settle a finish that raced ahead of the score
  stepSyncLive("stats", () => recordMatchStats(db, deps), 0); // 5-min match-stats snapshot into the events feed
  stepSyncLive("captureLiveOpens", () => captureLiveOpens(db, deps), undefined); // snapshot kickoff prices the first time a match is live
  await stepLive("snapshots", () => collectSnapshots(db, deps), 0); // raw provider + Polymarket capture on the live cadence
  await stepLive("bookDepth", () => captureBookDepth(db, deps), 0); // MEASURED capacity: throttled book-depth snapshots on live matches
  await stepLive("tennisScout", () => collectTennisSnapshots(db, deps), 0); // tennis scouting on the fast (~20s) cadence — dense break-lag data
  stepSyncLive("tennisBreakMarks", () => recordTennisBreakMarks(db, deps), 0); // passive break marker (§4)
  await stepLive("tennisTrade", () => tennisTradingTick(db, deps), 0); // §6 paper: break-triggered Overreaction entry (isolated, budget-0 comps)
  await stepLive("tennisSetValue", () => tennisSetValueTick(db, deps), 0); // §6 paper: lost-set-1 Set-Value entry (cross-strategy one-position rule)
  await stepLive("tennisPmv", () => tennisPmvTick(db, deps), 0);       // PMV: deterministic pre-match prop-consistency entry (no LLM v1)
  stepSyncLive("tennisPmvSettle", () => settleTennisPmvBets(db, deps), 0); // settle PMV props from the scout final (Gate-0.2 void clauses)
  await stepLive("tennisExit", () => tennisExitTick(db, deps), 0);     // §6 paper: deterministic book-VWAP exits for BOTH tennis strategies (no LLM, §9.6)
  stepSyncLive("tennisFinish", () => finishTennisMatches(db, deps), 0); // drive tennis matches to finished from the scout (else they pile up in live)
  stepSyncLive("tennisSettle", () => settleTennisBets(db, deps), 0);   // settle tennis bets from the scout's final result
  // Reassessment fires on TWO conditions, unioned: (1) a high-impact on-pitch
  // event (goal / red card) — labelled by its type; (2) the periodic 5-min
  // heartbeat on any match with open risk — labelled "time". Both hand the
  // strategist the live context to re-evaluate positions AND open fresh ones.
  const labelFor = new Map<string, ReassessTrigger>();
  const eventTriggers = new Set<string>();
  for (const e of enrich.newEvents) if (LIVE_TRIGGER_TYPES.has(e.type)) { labelFor.set(e.matchId, e.type as ReassessTrigger); eventTriggers.add(e.matchId); }
  for (const id of periodicReassessMatches(db, deps)) if (!labelFor.has(id)) labelFor.set(id, "time");
  const reassessIds = new Set(labelFor.keys());

  // Back-fill analysis for a funded match that reached LIVE with none — a scheduler
  // gap over kickoff means autoAnalyze (slow discover/tick cadence) never ran for it,
  // and the live cycle would otherwise reassess it forever with no distribution. Run
  // it HERE on the fast live cadence (analysis-only for live — see autoAnalyze) so
  // the reassessment below has the outcome tree instead of guessing from the score.
  await stepLive("liveBackfillAnalyze", () => autoAnalyze(db, deps, { max: 3, liveOnly: true }), [] as AutoAnalyzeItem[]);
  const detExits = await stepLive("exits", () => evaluateExits(db, deps), [] as ExitItem[]); // cheap TP/stop, reacts to price every tick
  const reassess = await stepLive("reassess", () => strategistReassess(db, deps, { newEventMatchIds: reassessIds, triggeredOnly: true, labelFor }), { exits: [], entries: [], llmCalls: 0, llmFail: 0 } as ReassessResult);
  await stepLive("autoEnter", () => autoEnter(db, deps), [] as AutoEnterItem[]); // fill any positions the strategist just opened
  // (dry-exit sweep runs ONLY in the slow auto cycle — see runAutoCycle. Fetching a book per open dry
  //  position every fast tick, in BOTH cycles, was the OOM that downed the box; once/slow-tick is enough:
  //  a settled twin's position isn't going anywhere.)

  return {
    live: inPlay.length, oddsUpdated: odds.reduce((n, r) => n + r.updated, 0),
    enriched: enrich.enriched, triggers: eventTriggers.size, // on-pitch events only (periodic reassess is separate)
    exits: detExits.length + reassess.exits.length, entries: reassess.entries.length,
    llmCalls: reassess.llmCalls, llmFail: reassess.llmFail,
  };
}
