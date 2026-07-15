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
import { settleBet, resolveTennisWinner } from "./settlement.js";
import { loadShadowConfig, shadowOnExit } from "./shadow.js";
import { chargeTennisTriggers, tennisReassessShouldCall, type TennisCharge } from "./tennisOverreaction.js";
import { SET_VALUE_STRATEGY, SET_VALUE_ARMED, SET_VALUE_EPOCH, setValueGate } from "./tennisSetValue.js";
import { detectBreaks, detectTennisEvents, tennisMoneyline, tennisTourOf, fetchTennisFixtures, trimRaw, TENNIS_TERMINAL_RE, loadTennisConfig } from "./tennisScout.js";
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
const TENNIS_MIN_BOOK_USD = (() => { const n = Number(process.env.TENNIS_MIN_BOOK_USD); return Number.isFinite(n) && n > 0 ? n : 2000; })();
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
  const cfg = loadTennisConfig(env);
  if (!cfg.enabled) return 0;
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  const today = now.slice(0, 10);
  // 1. Collect stranded matches (scout-linked, not finished, stale, with a reason to settle).
  const byStart = new Map<string, { matchId: string; eventKey: string }[]>();
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    for (const m of R.listMatches(db, c.id)) {
      if (m.state === "finished") continue;
      const last = db.prepare(`SELECT event_key, batch_at FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(m.id) as { event_key?: string; batch_at?: string } | undefined;
      if (!last?.event_key) continue; // never scout-linked → nothing to poll
      const ageMin = (nowMs - (Date.parse(last.batch_at ?? "") || 0)) / 60000;
      if (ageMin <= TENNIS_FINAL_POLL_STALE_MIN) continue; // still fresh / recently live → not stranded
      const hasOpen = R.betsForMatch(db, m.id).some((b) => TENNIS_ALL_STRATEGIES.has(b.strategy_id) && b.status === "open");
      if (!hasOpen && m.state !== "live") continue; // no open position and not live → no reason to chase
      if (tennisFinalResult(db, m.id)?.finished) continue; // a terminal snapshot already exists → settle handles it
      const start = (m.kickoff_at ?? last.batch_at ?? now).slice(0, 10);
      (byStart.get(start) ?? byStart.set(start, []).get(start)!).push({ matchId: m.id, eventKey: last.event_key });
    }
  }
  if (!byStart.size) return 0;
  // 2. Per start-date, fetch fixtures over [start, today] (absorbs a match that spilled past midnight),
  //    index by event_key, and write the terminal snapshot for each stranded match that has finished.
  let written = 0;
  for (const [start, cands] of byStart) {
    const fixtures = await fetchTennisFixtures(cfg, start, today, deps).catch(() => [] as Awaited<ReturnType<typeof fetchTennisFixtures>>);
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

/** Cash out an open tennis paper bet at the current price (mirrors football's closeBetEarly:
 *  payout = stake·current/entry, booked settled_by="early" so it's excluded from Brier/CLV —
 *  a trading realize, not a prediction outcome). §9.6: pure arithmetic, no LLM. A5: the log
 *  carries trigger, game score, receiving games played, decision-vs-execution slippage (0 on
 *  paper — decision price IS the fill), and the armed-threshold epoch. */
function closeTennisBetEarly(db: Database, betId: string, currentCents: number, trigger: string, reason: string, deps: EngineDeps, now: string, extra: { gameScore?: string; recvGames?: number } = {}): number | null {
  const fresh = R.getBet(db, betId);
  if (!fresh || fresh.status !== "open") return null; // already closed/settled → no double-close
  const stake = fresh.stake ?? 0, entry = fresh.entry_price ?? 0;
  const payout = entry > 0 ? Math.round(stake * (currentCents / entry) * 100) / 100 : 0;
  const pnl = Math.round((payout - stake) * 100) / 100;
  R.updateBet(db, betId, { status: pnl >= 0 ? "settled_won" : "settled_lost", result: pnl >= 0 ? "won" : "lost", payout, closing_price: currentCents, settled_by: "early", settled_at: now });
  try { shadowOnExit(db, betId, 1, loadShadowConfig(db, deps.env), now); } catch { /* observe-only */ }
  const epoch = fresh.strategy_id === SET_VALUE_STRATEGY ? SET_VALUE_EPOCH : TENNIS_ARMED_EPOCH;
  const tail = `геймы ${extra.gameScore ?? "?"}, приёмных ${extra.recvGames ?? 0} · слиппедж 0¢ (paper) · пороги:${epoch}`;
  R.insertTradeLog(db, { id: R.uid(), match_id: fresh.match_id, strategy_id: fresh.strategy_id, minute: fresh.entered_minute ?? "лайв", type: "exit", text: `${reason} @ ${currentCents}¢ · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} · ${tail} (${trigger})`, created_at: now });
  return pnl;
}

/** Partial fixation: close a FRACTION of an open tennis position (mirrors football's closeBetPortion).
 *  The closed slice is booked as a settled child (settled_by="partial", rationale carries the %),
 *  the open bet's stake shrinks by that slice, and the remainder rides to settle. §9.6: pure arithmetic.
 *  Returns the realized P&L on the slice, or null if the position is gone / already fully closed. */
function closeTennisBetPortion(db: Database, betId: string, fraction: number, currentCents: number, reason: string, deps: EngineDeps, now: string): number | null {
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
    market_label: fresh.market_label, status: pnl >= 0 ? "settled_won" : "settled_lost", proposed_price: fresh.proposed_price,
    entry_price: entry, current_price: currentCents, closing_price: currentCents, ai_prob: fresh.ai_prob, stake: closed,
    rationale: `частичная фиксация ${Math.round(fraction * 100)}%`, entered_minute: fresh.entered_minute,
    result: pnl >= 0 ? "won" : "lost", payout, settled_by: "partial", settled_at: now, created_at: now,
  });
  R.updateBet(db, betId, { stake: Math.round((stake - closed) * 100) / 100 }); // keep the remainder open to settle
  try { shadowOnExit(db, betId, fraction, loadShadowConfig(db, deps.env), now); } catch { /* observe-only */ }
  const epoch = fresh.strategy_id === SET_VALUE_STRATEGY ? SET_VALUE_EPOCH : TENNIS_ARMED_EPOCH;
  R.insertTradeLog(db, { id: R.uid(), match_id: fresh.match_id, strategy_id: fresh.strategy_id, minute: fresh.entered_minute ?? "лайв", type: "exit", text: `${reason} @ ${currentCents}¢ · фиксация ${Math.round(fraction * 100)}% · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} · остаток до финала · пороги:${epoch} (take_partial)`, created_at: now });
  return pnl;
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
export function tennisExitTick(db: Database, deps: EngineDeps = {}): number {
  const now = nowFn(deps)();
  let closed = 0;
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
    if (cur == null) continue;
    const prev = priced.length >= 2 ? priceOn(priced[priced.length - 2]) : null;
    // Post-entry events: receiving-game count (server = opponent) + break-back + a new favourite break.
    const evs = detectTennisEvents(snaps).filter((e) => (Date.parse(e.batchAt) || 0) > entryMs);
    const recvGames = evs.filter((e) => (e.type === "hold" || e.type === "break") && e.server === oppSide).length;
    const counterBreak = evs.some((e) => e.type === "break" && e.server === oppSide); // favourite broke opponent back
    const gs = curRow ? `${curRow.games_p1}-${curRow.games_p2}` : "?";
    const ext = { gameScore: gs, recvGames };

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
          if (closeTennisBetEarly(db, b.id, cur, "thesis_stop", `стоп тезиса: брейк во 2-м сете без возврата за ${recvAfter} приёмных`, deps, now, ext) != null) closed++;
          continue;
        }
      }
      // catastrophic_floor — real collapse to ≤ floor, phantom-guarded by persistence (cur AND prev ≤ floor).
      const svFloor = Number.isFinite(plan?.catastrophic_floor?.at_cents) ? Number(plan.catastrophic_floor.at_cents) : null;
      if (svFloor != null && cur <= svFloor && prev != null && prev <= svFloor) {
        if (closeTennisBetEarly(db, b.id, cur, "catastrophic_floor", `катастрофический floor: коллапс к ${cur}¢ (≤${svFloor}¢, подтверждён)`, deps, now, ext) != null) closed++;
        continue;
      }
      // take_price — favourite recovered into the take band → fix HALF once, hold the rest to settle.
      const svTake = Number.isFinite(plan?.take_price?.at_cents) ? Number(plan.take_price.at_cents) : SET_VALUE_ARMED.takeLowCents;
      const frac = Number.isFinite(plan?.take_price?.fraction) ? Number(plan.take_price.fraction) : SET_VALUE_ARMED.takeFraction;
      const alreadyPartial = R.betsForMatch(db, b.match_id, SET_VALUE_STRATEGY).some((x) => x.settled_by === "partial" && (x.risk_profile_id ?? "medium") === (b.risk_profile_id ?? "medium") && x.market_label === b.market_label);
      if (cur >= svTake && !alreadyPartial) {
        if (closeTennisBetPortion(db, b.id, frac, cur, `тейк камбэка: фаворит вернулся к ${cur}¢ (цель ≥${svTake}¢)`, deps, now) != null) closed++;
        continue;
      }
      continue; // Set-Value handled — never fall through to the Overreaction ladder
    }

    // #2 thesis_stop — a NEW break of the FAVOURITE's serve after entry.
    if (evs.some((e) => e.type === "break" && e.server === favSide)) {
      if (closeTennisBetEarly(db, b.id, cur, "thesis_stop", `стоп тезиса: второй брейк фаворита — выход`, deps, now, ext) != null) closed++;
      continue;
    }
    // #3 catastrophic_floor — a real collapse to ≤ floor, phantom-guarded by PERSISTENCE: cur AND the
    // prior priced snapshot both ≤ floor, so a single artifact print can't dump the position (tennis
    // has a midpoint, not a raw bid — Örgryte lesson via debounce). Deliberately wide: game jitter
    // (±5-8¢) never reaches entry−15¢, only an injury/cascade does.
    const floorAt = Number.isFinite(plan?.catastrophic_floor?.at_cents) ? Number(plan.catastrophic_floor.at_cents) : null;
    if (floorAt != null && cur <= floorAt && prev != null && prev <= floorAt) {
      if (closeTennisBetEarly(db, b.id, cur, "catastrophic_floor", `катастрофический floor: коллапс к ${cur}¢ (≤${floorAt}¢, подтверждён)`, deps, now, ext) != null) closed++;
      continue;
    }
    // #4 game_count_stop — the favourite has played ≥K receiving games since entry with NO break-back.
    const K = Number.isFinite(plan?.game_count_stop?.receiver_games) ? Number(plan.game_count_stop.receiver_games) : TENNIS_GAME_COUNT_STOP;
    if (recvGames >= K && !counterBreak) {
      if (closeTennisBetEarly(db, b.id, cur, "game_count_stop", `стоп по геймам: ${recvGames} приёмных без брейка назад`, deps, now, ext) != null) closed++;
      continue;
    }
    // #5 take_price — recovered to the pre-written take level (pre-break − buffer).
    const takeAt = Number.isFinite(plan?.take_price?.at_cents) ? Number(plan.take_price.at_cents) : null;
    if (takeAt != null && cur >= takeAt) {
      if (closeTennisBetEarly(db, b.id, cur, "take_price", `тейк выкупа: фаворит вернулся к ${cur}¢ (цель ≥${takeAt}¢)`, deps, now, ext) != null) closed++;
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
export function tennisEntryMeta(o: { favPrice: number; prePrice: number; edge: number; kelly: number; stake: number; thinnessUsd: number | null; setNum: number }): BetEntryMeta {
  return {
    phase: "live", minute: null, scoreHome: null, scoreAway: null,
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
const TENNIS_ARMED_EPOCH = process.env.TENNIS_ARMED_EPOCH || "interim";

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
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  // Stamp the armed-threshold epoch INTO the bet's code_version so the showcase (which segments
  // by code_version) hard-separates interim from calibrated tennis bets — the same epoch discipline
  // that let the 247-football-bet analysis drop a broken era. Every bet from here reads «…·interim»
  // (the prop-priced calibration was discarded); it becomes «…·calibrated» once the moneyline marks land.
  const codeVer = `${effectiveCodeVersion(db)}·${TENNIS_ARMED_EPOCH}`;
  const shadowCfg = loadShadowConfig(db, deps.env);
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
    const br = breaks[breaks.length - 1]; // most recent confirmed break
    if (!br) continue;
    if (R.metaGet(db, ACTED + m.id + ":" + br.batchAt)) continue; // already acted on this break
    // Favourite ID off the MATCH-START (pre-match) price — NOT a per-break price. A per-break
    // reference re-identifies the favourite every break, so after the PRE-MATCH favourite loses a
    // set the current set-leader (the pre-match underdog) gets mislabelled "the favourite" and
    // bought back against its inflated set-lead price — a phantom edge (the −$93 Barrera flip).
    // startPrices is the clean pre-panic anchor Set-Value already uses; the recovery target below
    // still reads the true pre-break price via prePriceBefore.
    const charge = chargeTennisMatch(db, m.id, players, startPrices(db, m.id));
    if (!charge.favSide || !charge.tradeable) continue; // no favourite / thin book → skip
    const brSnap = snaps.find((s) => s.batch_at === br.batchAt) ?? snaps[snaps.length - 1];
    const favSetsLost = charge.favSide === "first" ? (brSnap.sets_p2 ?? 0) : (brSnap.sets_p1 ?? 0);
    const favPrice = favPriceFromScout(db, m.id, charge.favSide);
    const signal = { brokenSide: br.server, setNum: br.setNum, favSetsLost, favPriceCents: favPrice };
    if (!tennisReassessShouldCall(charge, signal)) { R.metaSet(db, ACTED + m.id + ":" + br.batchAt, "gate_skip", now); continue; }

    const favName = charge.favSide === "first" ? players.p1 : players.p2;
    // Trade the MONEYLINE (winner market). The bet's market_label is the FAVOURITE'S NAME so settle's
    // resolveTennisWinner matches it to the advancing player. No moneyline → HONEST skip (never a prop).
    const ml = tennisMoneyline(db, m.id, players);
    if (!ml) { R.metaSet(db, ACTED + m.id + ":" + br.batchAt, "no_moneyline", now); R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `манилайн не найден (только пропы / неоднозначно) — вход пропущен (no_moneyline)`, created_at: now }); continue; }
    const favMlPrice = charge.favSide === "first" ? ml.p1Cents : ml.p2Cents;
    const prePrice = prePriceBefore(db, m.id, charge.favSide, br.batchAt) ?? favMlPrice;

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
    for (const profile of freeProfiles) {
      // Race guard: freeProfiles was computed BEFORE the awaited LLM call — an overlapping tick
      // (live + catch-up firing together) could have opened a buyback on this profile during the
      // await. Re-check right before the insert so two overlapping ticks can't double-enter the same
      // profile (the 22:00:22 + 22:00:42 double-batch that only the shadow cap caught).
      if (R.betsForMatch(db, m.id).some((b) => TENNIS_STRATEGIES.has(b.strategy_id) && b.status === "open" && b.risk_profile_id === profile)) continue;
      const cfg = getProfileConfig(db, profile);
      const held = R.betsForMatch(db, m.id, TENNIS_STRATEGY).filter((b) => b.status === "open" && b.risk_profile_id === profile).reduce((s, b) => s + (b.stake ?? 0), 0);
      // allowLargeEdge OFF: unlike a football near-resolved market (where a huge edge is genuine), a
      // huge tennis moneyline edge is the phantom signature — the absurd_edge_block (>25%) is a real
      // backstop here (defense-in-depth behind the pre-match favourite anchor). Legit snapbacks are 5-12%.
      const r = sizePrematch({ ourProb, priceCents: entryCents, implied, calibration: 0.6, liquidity: ml.liquidity || null, budget: TENNIS_PAPER_BUDGET, matchExposure: held, compExposure: held, cfg });
      if (r.status !== "enter") { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `[${profile}] overreaction подтверждён, но сайзинг отклонил: ${r.reason}`, created_at: now }); continue; }
      const meta = tennisEntryMeta({ favPrice: entryCents, prePrice, edge: r.edge, kelly: r.kellyFraction, stake: r.stake, thinnessUsd: ml.liquidity || null, setNum: br.setNum });
      const betId = R.uid();
      R.insertBet(db, {
        id: betId, match_id: m.id, strategy_id: TENNIS_STRATEGY, risk_profile_id: profile, market_label: favName,
        status: "open", proposed_price: entryCents, entry_price: entryCents, current_price: entryCents, closing_price: null,
        ai_prob: ourProb, stake: r.stake, rationale: `выкуп переоценки (теннис): фаворит «${favName}» сломан в сете ${br.setNum}, манилайн ${entryCents}¢ vs предбрейк ${prePrice}¢. ${pick.reason || dec.note || ""}`,
        entered_minute: `сет ${br.setNum}`, result: null, payout: null, settled_by: null, settled_at: null,
        entry_meta: serializeEntryMeta(meta), code_version: codeVer, created_at: now,
      });
      try { shadowOnEntries(db, [{ betId, matchId: m.id, competitionId: comp, strategyId: TENNIS_STRATEGY, profileId: profile, size: r.stake, edge: r.edge, isLive: true }], shadowCfg, now); } catch { /* observe-only */ }
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "enter", text: `[${profile}] ВЫКУП «${favName}» @ ${entryCents}¢ · $${Math.round(r.stake)} (edge ${(r.edge * 100).toFixed(1)}%, тейк ~${prePrice - TENNIS_TAKE_BUFFER}¢, стоп ${TENNIS_GAME_COUNT_STOP} приёмных / floor ${entryCents - TENNIS_CATASTROPHIC_FLOOR}¢, пороги:${TENNIS_ARMED_EPOCH})`, created_at: now });
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
export function tennisSetValueEntryMeta(o: { favPrice: number; edge: number; kelly: number; stake: number; thinnessUsd: number | null; setNum: number }): BetEntryMeta {
  return {
    phase: "live", minute: null, scoreHome: null, scoreAway: null,
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

    const favName = charge.favSide === "first" ? players.p1 : players.p2;
    const ml = tennisMoneyline(db, m.id, players);
    if (!ml) { R.metaSet(db, SV_ACTED + m.id, "no_moneyline", now); R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "skip", text: `манилайн не найден — вход пропущен (no_moneyline)`, created_at: now }); continue; }

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

    const entryCents = favPrice ?? (charge.favSide === "first" ? ml.p1Cents : ml.p2Cents);
    const ourProb = SET_VALUE_ARMED.comebackProb; // interim constant for a competitive lost set (calibrated later)
    const implied = entryCents / 100;
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
      const meta = tennisSetValueEntryMeta({ favPrice: entryCents, edge: r.edge, kelly: r.kellyFraction, stake: r.stake, thinnessUsd: ml.liquidity || null, setNum: last.set_num ?? 2 });
      const betId = R.uid();
      R.insertBet(db, {
        id: betId, match_id: m.id, strategy_id: SET_VALUE_STRATEGY, risk_profile_id: profile, market_label: favName,
        status: "open", proposed_price: entryCents, entry_price: entryCents, current_price: entryCents, closing_price: null,
        ai_prob: ourProb, stake: r.stake, rationale: `set-value (теннис): фаворит «${favName}» проиграл 1-й сет, манилайн ${entryCents}¢, P(камбэк)≈${Math.round(ourProb * 100)}%. ${pick.reason || dec.note || ""}`,
        entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null,
        entry_meta: serializeEntryMeta(meta), code_version: codeVer, created_at: now,
      });
      try { shadowOnEntries(db, [{ betId, matchId: m.id, competitionId: comp, strategyId: SET_VALUE_STRATEGY, profileId: profile, size: r.stake, edge: r.edge, isLive: true }], shadowCfg, now); } catch { /* observe-only */ }
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: SET_VALUE_STRATEGY, minute: "сет 2", type: "enter", text: `[${profile}] SET-VALUE «${favName}» @ ${entryCents}¢ · $${Math.round(r.stake)} (edge ${(r.edge * 100).toFixed(1)}%, тейк 50% @ ${SET_VALUE_ARMED.takeLowCents}¢ / стоп брейк-невозврат K${SET_VALUE_ARMED.thesisStopReceiverGames} / floor ${entryCents - SET_VALUE_ARMED.floorBelowEntryCents}¢, пороги:${SET_VALUE_EPOCH})`, created_at: now });
      opened++;
    }
  }
  return opened;
}
