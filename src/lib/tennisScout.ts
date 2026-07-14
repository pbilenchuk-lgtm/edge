// ============================================================
// EDGE LAB — TENNIS provider scouting (Stage 0)  [SERVER-ONLY]
//
// PARALLEL, observe-only stream — does NOT touch football or any money-path. Polls a
// tennis score provider (API-Tennis, chosen in docs/tennis_provider_scouting.md) for LIVE
// matches and stores raw+parsed snapshots so break detection + lag can be measured offline
// while snapshots are hot. A "break" = the SERVER loses their service game — which is only
// detectable because API-Tennis exposes `event_serve` (the field ESPN lacked).
//
// Gated on API_TENNIS_KEY: no key → inert (returns 0), exactly like the football providers.
// ============================================================

import "./http.js";
import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { loadPolymarketConfig, fetchMidpointCents } from "./polymarket.js";
import { mapTennisMatch, logMapDecision, normName } from "./tennisMatch.js";
import { computeWindowMetrics, polymarketSeries } from "./overreactionLatency.js";
import { effectiveCodeVersion } from "./codeEpoch.js";

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());

export interface TennisConfig { enabled: boolean; key: string; base: string; timeoutMs: number }
export function loadTennisConfig(env: Record<string, string | undefined> = process.env): TennisConfig {
  const key = (env.API_TENNIS_KEY ?? env.APITENNIS_KEY ?? "").trim();
  return { enabled: !!key, key, base: env.API_TENNIS_BASE ?? "https://api.api-tennis.com/tennis/", timeoutMs: Number(env.API_TENNIS_TIMEOUT_MS ?? 8000) };
}

// ── Field parsing (confirmed against the live feed) ──
/** "First Player"/"Second Player" → 'first'/'second'; anything else → null. */
export function serverSide(eventServe: unknown): "first" | "second" | null {
  const s = String(eventServe ?? "").toLowerCase();
  if (s.includes("first")) return "first";
  if (s.includes("second")) return "second";
  return null;
}
/** "1 - 0" → [1, 0]; unparseable → [null, null]. */
export function parsePair(s: unknown): [number | null, number | null] {
  const m = String(s ?? "").match(/(\d+)\s*[-:]\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}
/** From the API-Tennis `scores` array, the CURRENT set number + games in it. */
export function currentSet(scores: unknown): { setNum: number | null; gamesP1: number | null; gamesP2: number | null } {
  if (!Array.isArray(scores) || !scores.length) return { setNum: null, gamesP1: null, gamesP2: null };
  let best: any = null, bestN = -1;
  for (const s of scores) { const n = Number(s?.score_set); if (Number.isFinite(n) && n > bestN) { bestN = n; best = s; } }
  if (!best) return { setNum: null, gamesP1: null, gamesP2: null };
  return { setNum: bestN, gamesP1: Number(best.score_first), gamesP2: Number(best.score_second) };
}

export interface TennisLive {
  eventKey: string; p1: string; p2: string; tournament: string | null; eventType: string | null;
  live: number; status: string | null; setsP1: number | null; setsP2: number | null;
  setNum: number | null; gamesP1: number | null; gamesP2: number | null; gamePoints: string | null;
  server: "first" | "second" | null; raw: unknown;
}
export function normalizeLive(m: any): TennisLive | null {
  if (!m?.event_key) return null;
  const [sp1, sp2] = parsePair(m.event_final_result);
  const cs = currentSet(m.scores);
  return {
    eventKey: String(m.event_key), p1: String(m.event_first_player ?? ""), p2: String(m.event_second_player ?? ""),
    tournament: m.tournament_name ?? null, eventType: m.event_type_type ?? null,
    live: Number(m.event_live) === 1 ? 1 : 0, status: m.event_status ?? null,
    setsP1: sp1, setsP2: sp2, setNum: cs.setNum, gamesP1: cs.gamesP1, gamesP2: cs.gamesP2,
    gamePoints: m.event_game_result ?? null, server: serverSide(m.event_serve), raw: m,
  };
}

/** Fetch live tennis matches from API-Tennis. Never throws — returns [] on failure. */
export async function fetchTennisLivescores(cfg: TennisConfig, deps: EngineDeps = {}): Promise<TennisLive[]> {
  if (!cfg.enabled) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const doFetch = deps.fetchImpl ?? fetch;
    const url = `${cfg.base}?method=get_livescore&APIkey=${encodeURIComponent(cfg.key)}`;
    const res = await doFetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const j = (await res.json()) as { success?: number; result?: unknown };
    const rows = Array.isArray(j?.result) ? j.result : [];
    return rows.map(normalizeLive).filter((x): x is TennisLive => x != null);
  } catch { return []; }
  finally { clearTimeout(timer); }
}

/** Strip the heavy arrays (pointbypoint / statistics) from a stored raw row — not needed for
 *  Stage-1 break detection, and they blow up the persistent disk at 20s cadence. */
function trimRaw(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null;
  const { pointbypoint, statistics, ...rest } = raw;
  try { return JSON.stringify(rest); } catch { return null; }
}

/** A market label's price is for player X's "to win" if the label contains X's surname. */
function priceForPlayer(markets: { label: string; external_ref: string | null }[], player: string): string | null {
  const toks = normName(player).replace(/\./g, " ").split(/\s+/).filter((t) => t.length > 1);
  const hit = markets.find((mk) => { const l = normName(mk.label); return toks.some((t) => l.includes(t)); });
  return hit?.external_ref ?? null;
}

/**
 * Collect one poll of live tennis into tennis_snapshots. Observe-only; never throws into
 * the caller (the collector is wrapped). Optionally captures the linked Polymarket match's
 * mid so break-vs-market lag is measurable. Returns rows written.
 */
export async function collectTennisSnapshots(db: Database, deps: EngineDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cfg = loadTennisConfig(env);
  if (!cfg.enabled) return 0;
  const batchAt = nowFn(deps)();
  const live = (await fetchTennisLivescores(cfg, deps)).filter((m) => m.live === 1);
  const poly = deps.polymarket ?? loadPolymarketConfig(env);
  let written = 0;
  const seenLog = new Set<string>(); // log a match's mapping verdict once per collection pass
  for (const m of live) {
    let pmMatchId: string | null = null, pmMid: number | null = null, p1c: number | null = null, p2c: number | null = null;
    try {
      // PROPER fuzzy mapping (translit/diacritics/initials) — only an AUTO verdict links + trades.
      const res = mapTennisMatch(db, { p1: m.p1, p2: m.p2, startMs: null });
      if (!seenLog.has(m.eventKey)) { logMapDecision(db, m.eventKey, { p1: m.p1, p2: m.p2 }, res, batchAt); seenLog.add(m.eventKey); }
      if (res.verdict === "auto" && res.matchId) {
        pmMatchId = res.matchId;
        if (poly.enabled) {
          const mks = R.latestMarkets(db, res.matchId).filter((x) => x.external_ref).map((x) => ({ label: x.label, external_ref: x.external_ref }));
          const t1 = priceForPlayer(mks, m.p1), t2 = priceForPlayer(mks, m.p2);
          if (t1) p1c = await fetchMidpointCents(t1, poly, { fetchImpl: deps.fetchImpl }).catch(() => null);
          if (t2) p2c = await fetchMidpointCents(t2, poly, { fetchImpl: deps.fetchImpl }).catch(() => null);
          pmMid = p1c ?? p2c;
        }
      }
    } catch { /* mapping/pricing is best-effort, never blocks the snapshot */ }
    R.insertTennisSnapshot(db, {
      event_key: m.eventKey, provider: "apitennis", batch_at: batchAt, p1: m.p1, p2: m.p2,
      tournament: m.tournament, event_type: m.eventType, live: m.live, status: m.status,
      sets_p1: m.setsP1, sets_p2: m.setsP2, set_num: m.setNum, games_p1: m.gamesP1, games_p2: m.gamesP2,
      game_points: m.gamePoints, server: m.server, pm_match_id: pmMatchId, pm_mid_cents: pmMid, pm_p1_cents: p1c, pm_p2_cents: p2c,
      raw: trimRaw(m.raw),
    });
    written++;
  }
  return written;
}

// ── §4 Passive break marker: the panic window on the broken player's winner market ──
const MARK_DELAY_MS = 6 * 60_000; // a break is markable once its +6min window is complete
const BREAK_R = [1, 2, 3, 5];

/**
 * Persist a panic-window mark for every confirmed break on a MAPPED match, once the break's
 * +6min window has elapsed. Idempotent (skip already-marked). Reuses the football window math
 * (overreactionLatency.computeWindowMetrics) over the broken player's winner-price series
 * captured in tennis_snapshots. Read-only; never throws into the caller.
 */
export function recordTennisBreakMarks(db: Database, deps: EngineDeps = {}): number {
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  const codeVer = effectiveCodeVersion(db);
  let written = 0;
  for (const key of R.tennisSnapshotEventKeys(db)) {
    const rows = R.tennisSnapshotsForEvent(db, key);
    const breaks = detectBreaks(rows);
    if (!breaks.length) continue;
    const already = R.tennisBreakMarkCountForEvent(db, key);
    if (already >= breaks.length) continue; // all marked
    // Build the broken player's winner-price series (bid unavailable → mid as the quote).
    const marked = already; // simple high-water mark: only add breaks beyond the count we stored
    let idx = 0;
    for (const br of breaks) {
      idx++;
      if (idx <= marked) continue;                 // already persisted this break (ordered, idempotent)
      const at = Date.parse(br.batchAt);
      if (nowMs - at < MARK_DELAY_MS) continue;    // window not complete yet
      const first = rows[0];
      const pmMatchId = rows.find((r) => r.pm_match_id)?.pm_match_id ?? null;
      // The broken side's winner price. Winner markets are complementary, so if only the OTHER
      // side's market was matched, derive the broken side's price as 100 − other (robustness:
      // a break marks whichever side we can price).
      const priceOf = (r: R.TennisSnapshotRow) => {
        const own = br.server === "first" ? r.pm_p1_cents : r.pm_p2_cents;
        if (own != null) return own;
        const other = br.server === "first" ? r.pm_p2_cents : r.pm_p1_cents;
        return other != null ? Math.round((100 - other) * 10) / 10 : null;
      };
      const series = rows.filter((r) => priceOf(r) != null).map((r) => ({ provider: "polymarket", batch_at: r.batch_at, extracted: JSON.stringify({ markets: [{ label: "win", bidCents: priceOf(r), midCents: priceOf(r) }] }) }));
      const wm = computeWindowMetrics(polymarketSeries(series, "win"), at, undefined, codeVer);
      const setNum = br.setNum;
      const broke_early = setNum != null && setNum <= 1 ? 1 : (setNum === 2 && (first?.sets_p1 ?? 0) + (first?.sets_p2 ?? 0) <= 1 ? 1 : 0);
      R.insertTennisBreakMark(db, {
        event_key: key, match_id: pmMatchId, players: `${first?.p1 ?? "?"} vs ${first?.p2 ?? "?"}`,
        tournament: first?.tournament ?? null, event_type: first?.event_type ?? null, set_num: setNum,
        broken_side: br.server, broke_early, t_event: br.batchAt,
        pre_cents: wm.panicAmplitudeCents != null && wm.priceFloorCents != null ? Math.round((wm.priceFloorCents + wm.panicAmplitudeCents) * 10) / 10 : null,
        floor_cents: wm.priceFloorCents, t_floor_sec: wm.tFloorSec, panic_cents: wm.panicAmplitudeCents,
        recovery_1: wm.recovery["1"], recovery_2: wm.recovery["2"], recovery_3: wm.recovery["3"], recovery_5: wm.recovery["5"],
        window_quotes: wm.windowQuotes, confidence_flags: wm.flags.length ? wm.flags.join(",") : null, code_version: codeVer, created_at: now,
      });
      written++;
    }
  }
  return written;
}

// ── Offline event detector (deterministic — §9.6: code, no LLM) ──
export type TennisEventType = "break" | "hold" | "set_won" | "match_finished" | "retirement" | "walkover" | "correction" | "tiebreak_set";
export interface TennisEvent {
  eventKey: string; type: TennisEventType; batchAt: string;
  setNum: number | null; server: "first" | "second" | null; winner: "first" | "second" | null;
  brokenPlayer: string | null; scoreBefore: string | null; scoreAfter: string | null; note?: string;
}
export interface BreakEvent { eventKey: string; batchAt: string; setNum: number; server: "first" | "second"; winner: "first" | "second"; brokenPlayer: string; gameScore: string }

const RETIRE = /retir|\bret\.?\b|ретай/i;
const WALKOVER = /walkover|w[\/.]o\b|w\.o/i;
const FINISHED = /finish|заверш|final/i;

/**
 * Full deterministic event stream from one match's snapshots (sorted). Handles:
 *  · break (server lost their game) vs hold (server held)
 *  · set_won / tiebreak_set (a 6-6 game decides the set — break logic does NOT apply)
 *  · match_finished / retirement / walkover (from status)
 *  · DEBOUNCE: a game change is confirmed only if it PERSISTS into the next snapshot; a
 *    change that reverts next snapshot is a provider correction (emitted, not acted on).
 *  · >1-game jumps (missed polls) are skipped as coverage gaps, never guessed.
 */
export function detectTennisEvents(rows: R.TennisSnapshotRow[]): TennisEvent[] {
  const out: TennisEvent[] = [];
  const s = [...rows].sort((a, b) => (a.batch_at < b.batch_at ? -1 : 1));
  const gs = (r: R.TennisSnapshotRow) => `${r.games_p1}-${r.games_p2}`;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    if (a.set_num == null || b.set_num == null) continue;
    if (b.set_num > a.set_num) { // a set completed
      out.push({ eventKey: b.event_key, type: "set_won", batchAt: b.batch_at, setNum: a.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b), note: a.games_p1 === 6 && a.games_p2 === 6 ? "tiebreak" : undefined });
      continue;
    }
    if (b.set_num < a.set_num) continue;
    if (a.games_p1 == null || a.games_p2 == null || b.games_p1 == null || b.games_p2 == null) continue;
    const da = b.games_p1 - a.games_p1, dbb = b.games_p2 - a.games_p2;
    if (da === 0 && dbb === 0) continue;
    if (da < 0 || dbb < 0) { out.push({ eventKey: b.event_key, type: "correction", batchAt: b.batch_at, setNum: b.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b) }); continue; }
    if (da + dbb !== 1) continue; // missed poll → coverage gap, don't guess
    // Tiebreak: a game completed FROM 6-6 decides the set — not a break.
    if (a.games_p1 === 6 && a.games_p2 === 6) { out.push({ eventKey: b.event_key, type: "tiebreak_set", batchAt: b.batch_at, setNum: b.set_num, server: null, winner: da === 1 ? "first" : "second", brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b), note: "tiebreak" }); continue; }
    // DEBOUNCE: confirm the new score persists; a same-tick reversal is a correction.
    const n = s[i + 1];
    if (n && n.set_num === a.set_num && n.games_p1 === a.games_p1 && n.games_p2 === a.games_p2) { out.push({ eventKey: b.event_key, type: "correction", batchAt: b.batch_at, setNum: b.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b) }); continue; }
    const winner: "first" | "second" = da === 1 ? "first" : "second";
    const server = a.server; // who served the just-finished game
    if (server !== "first" && server !== "second") continue;
    if (winner === server) { out.push({ eventKey: b.event_key, type: "hold", batchAt: b.batch_at, setNum: b.set_num, server, winner, brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b) }); continue; }
    out.push({ eventKey: b.event_key, type: "break", batchAt: b.batch_at, setNum: b.set_num, server, winner, brokenPlayer: server === "first" ? (b.p1 ?? "first") : (b.p2 ?? "second"), scoreBefore: gs(a), scoreAfter: gs(b) });
  }
  // Terminal state from the last snapshot's status (retirement mid-game is detectable here).
  const last = s[s.length - 1];
  if (last) {
    const st = String(last.status ?? "");
    if (RETIRE.test(st)) out.push({ eventKey: last.event_key, type: "retirement", batchAt: last.batch_at, setNum: last.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: null, scoreAfter: gs(last) });
    else if (WALKOVER.test(st)) out.push({ eventKey: last.event_key, type: "walkover", batchAt: last.batch_at, setNum: last.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: null, scoreAfter: null });
    else if (FINISHED.test(st) || last.live === 0) out.push({ eventKey: last.event_key, type: "match_finished", batchAt: last.batch_at, setNum: last.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: null, scoreAfter: gs(last) });
  }
  return out;
}

/** Just the confirmed BREAK events (server lost their service game). */
export function detectBreaks(rows: R.TennisSnapshotRow[]): BreakEvent[] {
  return detectTennisEvents(rows).filter((e) => e.type === "break").map((e) => ({
    eventKey: e.eventKey, batchAt: e.batchAt, setNum: e.setNum as number, server: e.server as "first" | "second",
    winner: e.winner as "first" | "second", brokenPlayer: e.brokenPlayer as string, gameScore: e.scoreAfter as string,
  }));
}

// ── Report ──
export interface TennisScoutReport {
  provider: string; totalSnapshots: number; events: number;
  coverageByType: { type: string; events: number }[];
  perEvent: { eventKey: string; players: string; tournament: string | null; type: string | null; snapshots: number; medianCadenceSec: number | null; breaks: number; linkedToPolymarket: boolean; gaps: number }[];
  breaks: BreakEvent[];
  lag: { measured: number; medianLagSec: number | null; note: string };
  limitations: string[];
}
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function buildTennisScoutReport(db: Database): TennisScoutReport {
  const keys = R.tennisSnapshotEventKeys(db);
  const perEvent: TennisScoutReport["perEvent"] = [];
  const allBreaks: BreakEvent[] = [];
  const typeCount = new Map<string, Set<string>>();
  let total = 0;
  const lagSamples: number[] = [];
  for (const k of keys) {
    const rows = R.tennisSnapshotsForEvent(db, k);
    total += rows.length;
    const t = rows[0]?.event_type ?? "(unknown)";
    (typeCount.get(t) ?? typeCount.set(t, new Set()).get(t)!).add(k);
    // cadence + gaps
    const gapsSec: number[] = [];
    for (let i = 1; i < rows.length; i++) gapsSec.push((Date.parse(rows[i].batch_at) - Date.parse(rows[i - 1].batch_at)) / 1000);
    const breaks = detectBreaks(rows);
    allBreaks.push(...breaks);
    // lag vs Polymarket: for each break, when did the linked mid move ≥ MOVE_CENTS after it?
    const MOVE_CENTS = 4;
    for (const br of breaks) {
      const withMid = rows.filter((r) => r.pm_mid_cents != null);
      const at = Date.parse(br.batchAt);
      const before = withMid.filter((r) => Date.parse(r.batch_at) <= at).slice(-1)[0];
      if (!before || before.pm_mid_cents == null) continue;
      const after = withMid.find((r) => Date.parse(r.batch_at) > at && Math.abs((r.pm_mid_cents as number) - (before.pm_mid_cents as number)) >= MOVE_CENTS);
      if (after) lagSamples.push((Date.parse(after.batch_at) - at) / 1000);
    }
    perEvent.push({
      eventKey: k, players: `${rows[0]?.p1 ?? "?"} vs ${rows[0]?.p2 ?? "?"}`, tournament: rows[0]?.tournament ?? null,
      type: rows[0]?.event_type ?? null, snapshots: rows.length,
      medianCadenceSec: gapsSec.length ? Math.round(median(gapsSec) as number) : null,
      breaks: breaks.length, linkedToPolymarket: rows.some((r) => r.pm_match_id != null),
      gaps: gapsSec.filter((g) => g > 40).length,
    });
  }
  return {
    provider: "apitennis", totalSnapshots: total, events: keys.length,
    coverageByType: [...typeCount.entries()].map(([type, s]) => ({ type, events: s.size })).sort((a, b) => b.events - a.events),
    perEvent: perEvent.sort((a, b) => b.snapshots - a.snapshots),
    breaks: allBreaks,
    lag: { measured: lagSamples.length, medianLagSec: lagSamples.length ? Math.round(median(lagSamples) as number) : null,
      note: lagSamples.length ? "медианный лаг: Polymarket сдвинулся ≥4¢ ПОСЛЕ детекции брейка (сек)" : "нет измерений лага — нужен линк к Polymarket-матчу + захваченный mid вокруг брейка" },
    limitations: [
      "один провайдер (API-Tennis) — лаг меряется относительно движения Polymarket, не относительно второго счёт-провайдера",
      "брейки при пропуске поллов (скачок >1 гейма за снапшот) не атрибутируются — считаются как gaps, не угадываются",
      "линк к Polymarket по фамилиям обоих игроков; несопоставленные матчи меряют только качество провайдера, без лага",
    ],
  };
}

// ── §4 break-marker report: panic calibration by context ──
export interface TennisBreakReport {
  totalMarks: number; targetForCalibration: number; ready: boolean;
  rawMarks: number; unmeasured: number; mapping: { auto: number; review: number; skip: number };
  byContext: { context: string; n: number; medianPanic: number | null; medianFloor: number | null; medianTFloorSec: number | null }[];
  overall: { medianPanic: number | null; medianFloor: number | null; medianRecovery2: number | null };
  note: string;
}
const CALIB_TARGET = 100;
export function buildTennisBreakReport(db: Database): TennisBreakReport {
  const allMarks = R.listTennisBreakMarks(db);
  const marks = allMarks.filter((m) => m.panic_cents != null); // measurable only (has a price window)
  const mapLog = R.tennisMapLog(db, 5000);
  const mapping = { auto: mapLog.filter((m) => m.verdict === "auto").length, review: mapLog.filter((m) => m.verdict === "review").length, skip: mapLog.filter((m) => m.verdict === "skip").length };
  const groups = new Map<string, R.TennisBreakMarkRow[]>();
  const levelOf = (t: string | null) => /challenger/i.test(t ?? "") ? "Challenger" : /wta/i.test(t ?? "") ? "WTA" : /atp|men/i.test(t ?? "") ? "ATP" : (t ?? "?");
  for (const m of marks) {
    const ctx = `${levelOf(m.event_type)} · ${m.broke_early ? "early" : "late"}`;
    (groups.get(ctx) ?? groups.set(ctx, []).get(ctx)!).push(m);
  }
  const med = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2 * 10) / 10) : null; };
  return {
    totalMarks: marks.length, targetForCalibration: CALIB_TARGET, ready: marks.length >= CALIB_TARGET,
    rawMarks: allMarks.length, unmeasured: allMarks.length - marks.length, mapping,
    byContext: [...groups.entries()].map(([context, ms]) => ({
      context, n: ms.length, medianPanic: med(ms.map((m) => m.panic_cents)), medianFloor: med(ms.map((m) => m.floor_cents)), medianTFloorSec: med(ms.map((m) => m.t_floor_sec)),
    })).sort((a, b) => b.n - a.n),
    overall: { medianPanic: med(marks.map((m) => m.panic_cents)), medianFloor: med(marks.map((m) => m.floor_cents)), medianRecovery2: med(marks.map((m) => m.recovery_2)) },
    note: marks.length >= CALIB_TARGET
      ? "≥100 брейков — можно калибровать армед-цены из распределения (новая эпоха, thresholds=calibrated)"
      : `накоплено ${marks.length}/${CALIB_TARGET} брейков — армед-цены остаются interim, копим`,
  };
}

/** Per-break-mark CSV — inspect the actual pre/floor/panic per break (is the panic real?). */
export function tennisBreakMarksCsv(db: Database): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["t_event", "players", "tournament", "event_type", "set_num", "broken_side", "broke_early", "match_id", "pre_cents", "floor_cents", "panic_cents", "t_floor_sec", "recovery_1", "recovery_2", "recovery_5", "window_quotes", "flags"];
  const rows = R.listTennisBreakMarks(db).map((m) => [m.t_event, m.players, m.tournament, m.event_type, m.set_num, m.broken_side, m.broke_early, m.match_id, m.pre_cents, m.floor_cents, m.panic_cents, m.t_floor_sec, m.recovery_1, m.recovery_2, m.recovery_5, m.window_quotes, m.confidence_flags].map(esc).join(","));
  return [head.join(","), ...rows].join("\n");
}

export function tennisScoutCsv(rep: TennisScoutReport): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["event_key", "players", "tournament", "type", "snapshots", "median_cadence_sec", "breaks", "linked_polymarket", "gaps"];
  const rows = rep.perEvent.map((e) => [e.eventKey, e.players, e.tournament, e.type, e.snapshots, e.medianCadenceSec, e.breaks, e.linkedToPolymarket ? "yes" : "no", e.gaps].map(esc).join(","));
  return [head.join(","), ...rows].join("\n");
}
export function tennisScoutMarkdown(rep: TennisScoutReport): string {
  const L: string[] = [];
  L.push("# Теннис — разведка провайдера (API-Tennis), Stage 0");
  L.push(`\nПровайдер: **${rep.provider}** · событий наблюдалось: **${rep.events}** · снапшотов: **${rep.totalSnapshots}** · брейков детектировано: **${rep.breaks.length}**`);
  L.push("\n## Покрытие по типу события");
  L.push("тип | событий"); L.push("---|---:");
  for (const c of rep.coverageByType) L.push(`${c.type} | ${c.events}`);
  L.push("\n## Лаг детекции брейка (vs Polymarket)");
  L.push(`- измерений: **${rep.lag.measured}** · медианный лаг: **${rep.lag.medianLagSec == null ? "—" : rep.lag.medianLagSec + " сек"}**`);
  L.push(`- ${rep.lag.note}`);
  L.push("\n## По событиям");
  L.push("игроки | турнир | тип | снапшотов | каденция | брейков | PM-линк | пропуски");
  L.push("---|---|---|---:|---:|---:|:-:|---:");
  for (const e of rep.perEvent) L.push(`${e.players} | ${e.tournament ?? "—"} | ${e.type ?? "—"} | ${e.snapshots} | ${e.medianCadenceSec == null ? "—" : e.medianCadenceSec + "с"} | ${e.breaks} | ${e.linkedToPolymarket ? "✓" : "—"} | ${e.gaps}`);
  L.push("\n## Ограничения");
  for (const l of rep.limitations) L.push(`- ${l}`);
  return L.join("\n");
}
