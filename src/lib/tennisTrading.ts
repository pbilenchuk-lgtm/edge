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
import { detectBreaks, detectTennisEvents } from "./tennisScout.js";
import { effectiveCodeVersion } from "./codeEpoch.js";
import { serializeEntryMeta, parseEntryMeta, type BetEntryMeta } from "./betMeta.js";
import { strategistDecide, effectiveEnv } from "./llm.js";
import { sizePrematch, impliedProbs } from "./strategist.js";
import { getProfileConfig } from "./riskConfig.js";
import { shadowOnEntries, type ShadowEntryRequest } from "./shadow.js";
import { getStrategy } from "./repo.js";

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const surnames = (name: string) => norm(name).replace(/[.,]/g, " ").split(/[\s-]+/).filter((t) => t.length > 1);

// Per-match tradeability: winner-book depth ≥ this ($) on BOTH sides at charge time. Env-tunable.
const TENNIS_MIN_BOOK_USD = (() => { const n = Number(process.env.TENNIS_MIN_BOOK_USD); return Number.isFinite(n) && n > 0 ? n : 2000; })();
const TENNIS_STRATEGY = "tennis_overreaction";

/** Latest scout state for a Polymarket-linked match: the final result if it's over. */
export interface TennisFinal { finished: boolean; canceled: boolean; retired: boolean; advancing: "first" | "second" | null; p1: string; p2: string }
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
  // Advancing = event_winner from raw if present, else the side with more sets.
  let advancing: "first" | "second" | null = null;
  try { const raw = r.raw ? JSON.parse(r.raw) : null; const w = String(raw?.event_winner ?? "").toLowerCase(); if (w.includes("first")) advancing = "first"; else if (w.includes("second")) advancing = "second"; } catch { /* fall through */ }
  if (advancing == null && r.sets_p1 != null && r.sets_p2 != null) advancing = r.sets_p1 > r.sets_p2 ? "first" : r.sets_p2 > r.sets_p1 ? "second" : null;
  return { finished: true, canceled, retired, advancing: canceled ? null : advancing, p1: String(r.p1 ?? ""), p2: String(r.p2 ?? "") };
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
    if (b.strategy_id !== TENNIS_STRATEGY || !tennisMatchIds.has(b.match_id)) continue;
    const fin = tennisFinalResult(db, b.match_id);
    if (!fin || !fin.finished) continue; // still live → leave open
    const won = resolveTennisWinner(b.market_label, fin.p1, fin.p2, fin.advancing, fin.canceled);
    if (won == null) {
      // Void: canceled/ambiguous → refund the stake, zero P&L (excluded from accuracy).
      R.updateBet(db, b.id, { status: "settled_lost", result: null, payout: b.stake ?? 0, closing_price: b.current_price ?? b.entry_price ?? null, settled_at: now, settled_by: "void" });
    } else {
      const patch = settleBet({ entry_price: b.entry_price, stake: b.stake }, won, b.entry_price ?? null);
      R.updateBet(db, b.id, { status: patch.status, result: patch.result, payout: patch.payout, closing_price: patch.closing_price, settled_at: now });
    }
    try { shadowOnExit(db, b.id, 1, shadowCfg, now); } catch { /* observe-only */ }
    R.insertTradeLog(db, { id: R.uid(), match_id: b.match_id, strategy_id: TENNIS_STRATEGY, minute: "финал", type: "settle", text: `${b.market_label}: ${won == null ? "возврат (не сыграл/ретайр-неоднозначность)" : won ? "выигрыш" : "проигрыш"}${fin.retired ? " · ретайр" : ""}`, created_at: now });
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
  const tail = `геймы ${extra.gameScore ?? "?"}, приёмных ${extra.recvGames ?? 0} · слиппедж 0¢ (paper) · пороги:${TENNIS_ARMED_EPOCH}`;
  R.insertTradeLog(db, { id: R.uid(), match_id: fresh.match_id, strategy_id: TENNIS_STRATEGY, minute: fresh.entered_minute ?? "лайв", type: "exit", text: `${reason} @ ${currentCents}¢ · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} · ${tail} (${trigger})`, created_at: now });
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
    if (b.strategy_id !== TENNIS_STRATEGY || !tennisMatchIds.has(b.match_id)) continue;
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
    const cur = (curRow ? priceOn(curRow) : null) ?? winnerMarketFor(db, b.match_id, b.market_label)?.price ?? null;
    if (cur == null) continue;
    const prev = priced.length >= 2 ? priceOn(priced[priced.length - 2]) : null;
    // Post-entry events: receiving-game count (server = opponent) + break-back + a new favourite break.
    const evs = detectTennisEvents(snaps).filter((e) => (Date.parse(e.batchAt) || 0) > entryMs);
    const recvGames = evs.filter((e) => (e.type === "hold" || e.type === "break") && e.server === oppSide).length;
    const counterBreak = evs.some((e) => e.type === "break" && e.server === oppSide); // favourite broke opponent back
    const gs = curRow ? `${curRow.games_p1}-${curRow.games_p2}` : "?";
    const ext = { gameScore: gs, recvGames };

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

// ── Observability: the entry funnel (read-only; reconstructs the tick's own gates) ──
// The tick's skips are mostly SILENT (no_favourite / thin_book / no_break / underdog_broken /
// out_of_window / price_far go to app_meta, not the trade log), so from the UI a running-but-
// selective loop looks identical to a dead one. This recomputes each live tennis match's funnel
// stage from current state so you can SEE it's alive and WHY it's holding fire. Pure read.
export interface TennisFunnelRow { match: string; comp: string; stage: string; note: string }
export interface TennisFunnel {
  live: number; withFavourite: number; tradeable: number; withBreak: number; favBreak: number; gatePass: number;
  openPositions: number; entriesAllTime: number;
  actionMarkers: Record<string, number>;
  perMatch: TennisFunnelRow[];
  recentLog: { at: string; type: string; text: string }[];
  note: string;
}
export function buildTennisFunnel(db: Database): TennisFunnel {
  const f: TennisFunnel = { live: 0, withFavourite: 0, tradeable: 0, withBreak: 0, favBreak: 0, gatePass: 0, openPositions: 0, entriesAllTime: 0, actionMarkers: {}, perMatch: [], recentLog: [], note: "" };
  const tennisMatches = R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id).map((m) => ({ comp: c.id, m })));
  for (const { comp, m } of tennisMatches) {
    for (const b of R.betsForMatch(db, m.id, TENNIS_STRATEGY)) { f.entriesAllTime++; if (b.status === "open") f.openPositions++; }
    if (m.state !== "live") continue;
    const snaps = db.prepare(`SELECT * FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at`).all(m.id) as R.TennisSnapshotRow[];
    if (snaps.length < 2) continue; // not enough scout data to charge/detect yet
    f.live++;
    const label = `${m.home} — ${m.away}`;
    const row = (stage: string, note = ""): void => { f.perMatch.push({ match: label, comp, stage, note }); };
    const last = snaps[snaps.length - 1];
    const charge = chargeTennisMatch(db, m.id, { p1: last.p1 ?? "", p2: last.p2 ?? "" });
    if (!charge.favSide) { row("no_favourite", "обе стороны > порога андердога"); continue; }
    f.withFavourite++;
    if (!charge.tradeable) { row("thin_book", charge.bookNote); continue; }
    f.tradeable++;
    const br = detectBreaks(snaps).slice(-1)[0];
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
  f.note = f.entriesAllTime > 0
    ? `${f.entriesAllTime} входов всего (${f.openPositions} открыто); из ${f.live} live-матчей ${f.gatePass} на взводе сейчас`
    : f.gatePass > 0
      ? `${f.gatePass}/${f.live} live-матчей на взводе — вход на следующем тике (или уже acted)`
      : `${f.live} live-матчей, 0 на взводе прямо сейчас — воронка жива, сетап ещё не совпал (см. perMatch)`;
  return f;
}

export function tennisFunnelMarkdown(f: TennisFunnel): string {
  const L: string[] = [];
  L.push(`# Теннис — воронка входа (live)`);
  L.push(f.note);
  L.push(`\n## Ступени сейчас`);
  L.push(`live ${f.live} → с фаворитом ${f.withFavourite} → торгуемых ${f.tradeable} → с брейком ${f.withBreak} → брейк фаворита ${f.favBreak} → прошло гейт ${f.gatePass}`);
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
      if (fin?.finished) { try { R.updateMatch(db, m.id, { state: "finished", end_time: now }); n++; } catch { /* best-effort */ } }
    }
  }
  return n;
}

/** Winner-market tokens for the favourite/underdog sides of a linked match, by surname. */
function winnerMarketFor(db: Database, matchId: string, playerName: string): { label: string; price: number; liquidity: string | null } | null {
  const toks = surnames(playerName);
  const mk = R.latestMarkets(db, matchId).find((m) => { const l = norm(m.label); return toks.some((t) => l.includes(t)); });
  return mk ? { label: mk.label, price: mk.price, liquidity: mk.liquidity } : null;
}

/** The favourite's current winner price (cents) for the linked match, using the last scout snapshot. */
function favPriceFromScout(db: Database, matchId: string, favSide: "first" | "second"): number | null {
  const r = (db.prepare(`SELECT pm_p1_cents,pm_p2_cents FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(matchId) as any) ?? null;
  if (!r) return null;
  return favSide === "first" ? r.pm_p1_cents : r.pm_p2_cents;
}

export interface TennisChargeInfo extends TennisCharge { matchId: string; tradeable: boolean; bookNote: string }

/**
 * DETERMINISTIC charge for one mapped tennis match: identify the favourite by the winner
 * prices, arm the interim triggers, and gate tradeability on winner-book depth ≥ threshold
 * on BOTH sides. Pure enough to unit-test with an injected market list.
 */
export function chargeTennisMatch(db: Database, matchId: string, players: { p1: string; p2: string }): TennisChargeInfo {
  const m1 = winnerMarketFor(db, matchId, players.p1), m2 = winnerMarketFor(db, matchId, players.p2);
  const charge = chargeTennisTriggers({ p1Cents: m1?.price ?? null, p2Cents: m2?.price ?? null });
  const liq1 = Number(m1?.liquidity ?? 0) || 0, liq2 = Number(m2?.liquidity ?? 0) || 0;
  const tradeable = liq1 >= TENNIS_MIN_BOOK_USD && liq2 >= TENNIS_MIN_BOOK_USD;
  return { ...charge, matchId, tradeable, bookNote: `книга: ${players.p1} $${Math.round(liq1)} / ${players.p2} $${Math.round(liq2)} (порог $${TENNIS_MIN_BOOK_USD})` };
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

// Per-match paper budget for a tennis Overreaction position (comps stay budget-0 so the
// football engine never touches tennis; this loop owns tennis sizing). Env-tunable.
const TENNIS_PAPER_BUDGET = (() => { const n = Number(process.env.TENNIS_PAPER_BUDGET_USD); return Number.isFinite(n) && n > 0 ? n : 300; })();

const ACTED = "tennis_acted:"; // per (match, break) idempotency marker

// Recovery-take buffer (¢): the take fires when the favourite climbs back to within this many
// cents of its pre-break price — the buyback has paid off, realize it. STRUCTURAL/interim; the
// only numbers that swap in from the §4 distribution are the ENTRY armed prices, not this. Env-tunable.
const TENNIS_TAKE_BUFFER = (() => { const n = Number(process.env.TENNIS_TAKE_BUFFER_CENTS); return Number.isFinite(n) && n >= 0 ? n : 3; })();
// A1 game-count stop (the strategy's MAIN stop): exit after the favourite has played this many
// RECEIVING games since entry without a break-back. §4: overreaction lives ~7.6min and recovery
// shows in a 3-5min window ≈ a few receiving games — beyond that we'd be holding a directional bet,
// not trading the overreaction. INTERIM; calibrated from the §4/B recovery split. Env-tunable.
const TENNIS_GAME_COUNT_STOP = (() => { const n = Number(process.env.TENNIS_GAME_COUNT_STOP); return Number.isFinite(n) && n > 0 ? Math.round(n) : 3; })();
// A2 catastrophic floor (¢ below entry): a BACKSTOP, not a working stop. Deliberately WIDE so it
// never catches game jitter (±5-8¢ on a deuce), only a collapse (injury/cascade) before the second
// break. INTERIM; calibrated from the §4/B no-recovery trajectory. Env-tunable.
const TENNIS_CATASTROPHIC_FLOOR = (() => { const n = Number(process.env.TENNIS_CATASTROPHIC_FLOOR_CENTS); return Number.isFinite(n) && n > 0 ? n : 15; })();
// Armed-threshold epoch: "interim" until the §4/B calibration swaps the numbers; bump to
// "calibrated" alongside the real values so exits are segmentable by which era's thresholds fired.
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
  const codeVer = effectiveCodeVersion(db);
  const shadowCfg = loadShadowConfig(db, deps.env);
  let opened = 0;

  const tennisMatches = R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id).map((m) => ({ comp: c.id, m })));
  for (const { comp, m } of tennisMatches) {
    if (m.state === "finished") continue;
    // Latest scout snapshots for this mapped match.
    const snaps = db.prepare(`SELECT * FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at`).all(m.id) as R.TennisSnapshotRow[];
    if (snaps.length < 2) continue;
    const players = { p1: snaps[snaps.length - 1].p1 ?? "", p2: snaps[snaps.length - 1].p2 ?? "" };
    const charge = chargeTennisMatch(db, m.id, players);
    if (!charge.favSide || !charge.tradeable) continue; // no favourite / thin book → skip
    const breaks = detectBreaks(snaps);
    const br = breaks[breaks.length - 1]; // most recent confirmed break
    if (!br) continue;
    if (R.metaGet(db, ACTED + m.id + ":" + br.batchAt)) continue; // already acted on this break
    const brSnap = snaps.find((s) => s.batch_at === br.batchAt) ?? snaps[snaps.length - 1];
    const favSetsLost = charge.favSide === "first" ? (brSnap.sets_p2 ?? 0) : (brSnap.sets_p1 ?? 0);
    const favPrice = favPriceFromScout(db, m.id, charge.favSide);
    const signal = { brokenSide: br.server, setNum: br.setNum, favSetsLost, favPriceCents: favPrice };
    if (!tennisReassessShouldCall(charge, signal)) { R.metaSet(db, ACTED + m.id + ":" + br.batchAt, "gate_skip", now); continue; }

    const favName = charge.favSide === "first" ? players.p1 : players.p2;
    const favMk = winnerMarketFor(db, m.id, favName);
    if (!favMk || favMk.price == null) { R.metaSet(db, ACTED + m.id + ":" + br.batchAt, "no_market", now); continue; }
    const prePrice = prePriceBefore(db, m.id, charge.favSide, br.batchAt) ?? favMk.price;

    // A3: ONE buyback position per match — never stack a second (any profile of this strategy).
    // Structurally resolves the trigger #1/#2 conflict: the early-break position exits by A1 (no
    // recovery) BEFORE the lost-set trigger would arm, and if #1 is still alive when #2's conditions
    // hit, #2 simply doesn't open — no "докупка в падающую". Blocks BEFORE the LLM call (saves it).
    if (R.betsForMatch(db, m.id, TENNIS_STRATEGY).some((b) => b.status === "open")) {
      R.metaSet(db, ACTED + m.id + ":" + br.batchAt, "blocked_second_buyback", now);
      R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `второй выкуп заблокирован — по матчу уже открыта выкупная позиция (blocked_second_buyback)`, created_at: now });
      continue;
    }

    // LLM judges ONLY real_shift (overreaction vs genuine collapse). Code did side/window/price.
    const dec = await strategistDecide({
      strategyName: strat.name, strategyPrompt: strat.prompt_live ?? strat.prompt,
      match: { home: players.p1, away: players.p2, sport: "tennis", state: "live", minute: null, scoreHome: null, scoreAway: null },
      assessment: { confidence: "средняя", short: "", verdict: "" },
      markets: [{ label: favMk.label, priceCents: favMk.price, aiProb: prePrice / 100, liquidity: Number(favMk.liquidity ?? 0) || null }],
      openPositions: [],
      context: `БРЕЙК: сломали ${br.server === charge.favSide ? "ФАВОРИТА" : "андердога"} в сете ${br.setNum}, фаворит проиграл сетов: ${favSetsLost}. Цена фаворита ${favPrice}¢ (до брейка ~${prePrice}¢). Заряжен триггер ${favSetsLost >= 1 ? "lost_first_set" : "early_break"}. Реши: overreaction (выкупаем) или real_shift (воздерживаемся).`,
    }, strat.model_live ?? strat.model ?? "Claude Opus 4.8", { fetchImpl: deps.fetchImpl, env });
    R.metaSet(db, ACTED + m.id + ":" + br.batchAt, "decided", now); // one shot per break

    const pick = dec.ok ? dec.picks.find((p) => norm(p.label) === norm(favMk.label) || surnames(favName).some((t) => norm(p.label).includes(t))) : null;
    if (!dec.ok) { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `стратег недоступен (${dec.error || "нет ответа"}) — входа нет`, created_at: now }); continue; }
    if (!pick) { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `real_shift: стратег воздержался (не overreaction) — ${dec.note?.slice(0, 120) ?? ""}`, created_at: now }); continue; }

    // CODE sizing: fair = pre-break price, buy at the panicked price. Edge = fair − implied(now).
    const ourProb = (pick.prob != null ? pick.prob * 100 : prePrice) / 100;
    const implied = impliedProbs([{ label: favMk.label, priceCents: favMk.price, liquidity: Number(favMk.liquidity ?? 0) || 0 }]).get(favMk.label)?.implied ?? favMk.price / 100;
    const profile = "medium";
    const cfg = getProfileConfig(db, profile);
    const held = R.betsForMatch(db, m.id, TENNIS_STRATEGY).filter((b) => b.status === "open").reduce((s, b) => s + (b.stake ?? 0), 0);
    const r = sizePrematch({ ourProb, priceCents: favMk.price, implied, calibration: 0.6, liquidity: Number(favMk.liquidity ?? 0) || null, budget: TENNIS_PAPER_BUDGET, matchExposure: held, compExposure: held, cfg, allowLargeEdge: true });
    if (r.status !== "enter") { R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "skip", text: `overreaction подтверждён, но сайзинг отклонил: ${r.reason}`, created_at: now }); continue; }

    const meta = tennisEntryMeta({ favPrice: favMk.price, prePrice, edge: r.edge, kelly: r.kellyFraction, stake: r.stake, thinnessUsd: Number(favMk.liquidity ?? 0) || null, setNum: br.setNum });
    const betId = R.uid();
    R.insertBet(db, {
      id: betId, match_id: m.id, strategy_id: TENNIS_STRATEGY, risk_profile_id: profile, market_label: favMk.label,
      status: "open", proposed_price: favMk.price, entry_price: favMk.price, current_price: favMk.price, closing_price: null,
      ai_prob: ourProb, stake: r.stake, rationale: `выкуп переоценки (теннис): фаворит сломан в сете ${br.setNum}, цена ${favMk.price}¢ vs предбрейк ${prePrice}¢. ${pick.reason || dec.note || ""}`,
      entered_minute: `сет ${br.setNum}`, result: null, payout: null, settled_by: null, settled_at: null,
      entry_meta: serializeEntryMeta(meta), code_version: codeVer, created_at: now,
    });
    try { shadowOnEntries(db, [{ betId, matchId: m.id, competitionId: comp, strategyId: TENNIS_STRATEGY, profileId: profile, size: r.stake, edge: r.edge, isLive: true }], shadowCfg, now); } catch { /* observe-only */ }
    R.insertTradeLog(db, { id: R.uid(), match_id: m.id, strategy_id: TENNIS_STRATEGY, minute: `сет ${br.setNum}`, type: "enter", text: `ВЫКУП фаворита «${favMk.label}» @ ${favMk.price}¢ · $${Math.round(r.stake)} (edge ${(r.edge * 100).toFixed(1)}%, тейк ~${prePrice - TENNIS_TAKE_BUFFER}¢, стоп ${TENNIS_GAME_COUNT_STOP} приёмных / floor ${favMk.price - TENNIS_CATASTROPHIC_FLOOR}¢, пороги:${TENNIS_ARMED_EPOCH})`, created_at: now });
    opened++;
  }
  return opened;
}
