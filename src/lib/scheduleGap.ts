// ============================================================
// EDGE LAB — SCHEDULER GAP MONITOR  [SERVER-ONLY]
//
// The scheduler is IN-PROCESS (setInterval inside the web process), so it dies on any redeploy / crash /
// instance blip. The live loop stamps `last_live_tick_ms` every ~LIVE_TICK_SEC as proof-of-life; the health
// ping drives a catch-up when it goes stale. But when the PROCESS itself is down (and no health ping lands),
// NOTHING stamps — a silent "sleep window". On wake the deterministic stops finally run, but at the POST-gap
// price: a stop that should have fired mid-gap executes at the bottom of the price gap ("стопы едут по дну
// гэпов, пока крон спит"). Until now that window was invisible — absorbed silently.
//
// This monitor makes the window DATA. At each live-tick stamp we compare the new time against the PREVIOUS
// stamp: a delta far beyond the tick cadence means the loop was asleep that whole time. We record the window
// (cron_log kind 'gap' + running counters) flagged by whether a live match was in play at wake — the harmful
// case. It never changes trading; it only surfaces the gap so it's countable and alertable.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

export const GAP_COUNT_KEY = "schedule_gap_count";
export const GAP_LONGEST_KEY = "schedule_gap_longest_sec";
export const GAP_LAST_KEY = "schedule_gap_last"; // JSON of the most recent ScheduleGap
export const GAP_WAKE_UNTIL_KEY = "gap_wake_until_ms"; // P0.6: a firing protective stop before this arms a deferral

/** A sleep shorter than this (seconds) is a missed tick or two, not a "gap" — the catch-up handles it. */
export function gapAlertSec(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SCHEDULE_GAP_ALERT_SEC);
  return Number.isFinite(n) && n > 0 ? n : 300; // 5 min
}

// P0.6 reprice-window design constants — INTERIM, to be calibrated from the self-measurement below, NOT tuned
// to today's cases. GAP_WAKE_START_SEC bounds how long after wake a firing stop may START a deferral (keeps
// the trigger to the immediate post-gap dislocation, not normal time). A deferral then lasts ≤ repriceSec OR
// repriceTicks, whichever comes first — it can only DELAY the stop, never cancel it.
export function gapWakeStartSec(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.GAP_WAKE_START_SEC); return Number.isFinite(n) && n > 0 ? n : 45;
}
export function gapRepriceConfig(env: Record<string, string | undefined> = process.env): { repriceSec: number; repriceTicks: number } {
  const s = Number(env.GAP_WAKE_REPRICE_SEC), t = Number(env.GAP_WAKE_REPRICE_TICKS);
  return { repriceSec: Number.isFinite(s) && s > 0 ? s : 90, repriceTicks: Number.isFinite(t) && t > 0 ? t : 2 };
}
/** Arm the post-wake window: a protective stop firing before untilMs enters the three-step. Carries the gap
 *  length so a deferral it spawns can record which sleep caused it. */
export function markGapWake(db: Database, nowMs: number, gapSec: number, env: Record<string, string | undefined> = process.env): void {
  try { R.metaSet(db, GAP_WAKE_UNTIL_KEY, JSON.stringify({ untilMs: nowMs + gapWakeStartSec(env) * 1000, gapSec }), new Date(nowMs).toISOString()); } catch { /* best-effort */ }
}
function readGapWake(db: Database): { untilMs: number; gapSec: number } {
  try { const s = R.metaGet(db, GAP_WAKE_UNTIL_KEY); if (s) { const o = JSON.parse(s); return { untilMs: Number(o.untilMs ?? 0), gapSec: Number(o.gapSec ?? 0) }; } } catch { /* ignore */ }
  return { untilMs: 0, gapSec: 0 };
}
/** Are we within the immediate post-gap window (so a NEW deferral may be armed)? */
export function gapWakeActive(db: Database, nowMs: number): boolean {
  return nowMs < readGapWake(db).untilMs;
}
/** Length (seconds) of the sleep that armed the current post-wake window — stamped onto a deferral it spawns. */
export function gapWakeGapSec(db: Database): number {
  return readGapWake(db).gapSec;
}

export interface ScheduleGap { startMs: number; endMs: number; sec: number; liveInPlay: boolean }

/**
 * Detect + record a scheduler sleep window. Call at each live-tick stamp with the PREVIOUS marker value and
 * the current time. Returns the gap when the delta ≥ threshold (records it once), else null (fresh marker or
 * first-ever stamp). `inPlay` = a live match is in play at wake — the harmful case where stops sat unmanaged.
 */
export function recordScheduleGap(
  db: Database, prevMs: number, nowMs: number, inPlay: boolean, env: Record<string, string | undefined> = process.env,
  inPlaySinceMs = 0,
): ScheduleGap | null {
  // F7: with no valid prior live-tick marker (fresh boot / first live tick after a long quiet window) the
  // blackout over a match that has ALREADY been in play since kickoff was swallowed — nothing to diff against.
  // Fall back to the earliest in-play kickoff so that "a live match sat with no live tick since kickoff" is
  // recorded, not lost. A healthy loop (recent prevMs) is unaffected: prevMs wins whenever it's valid.
  const effStart = (prevMs && Number.isFinite(prevMs)) ? prevMs : (inPlay && inPlaySinceMs && Number.isFinite(inPlaySinceMs) ? inPlaySinceMs : 0);
  if (!effStart || !Number.isFinite(nowMs) || nowMs <= effStart) return null;
  const sec = Math.round((nowMs - effStart) / 1000);
  if (sec < gapAlertSec(env)) return null;
  const gap: ScheduleGap = { startMs: effStart, endMs: nowMs, sec, liveInPlay: inPlay };
  const at = new Date(nowMs).toISOString();
  const startIso = new Date(effStart).toISOString();
  const mins = Math.round(sec / 60);
  const liveNote = inPlay
    ? " · В ПЛЕЙ был лайв-матч — стопы могли исполниться по дну гэпа"
    : " · лайв-матчей не было (позициям без ущерба)";
  // ok=0 marks the HARMFUL (live-in-play) gaps so they read as failures in the cron journal / match log.
  try { R.insertCronLog(db, { id: R.uid(), at, kind: "gap", ok: inPlay ? 0 : 1, summary: `[gap] планировщик спал ~${mins}м (${startIso.slice(11, 16)}Z→${at.slice(11, 16)}Z)${liveNote}`, created_at: at }); } catch { /* journal best-effort */ }
  try {
    R.metaSet(db, GAP_COUNT_KEY, String(Number(R.metaGet(db, GAP_COUNT_KEY) ?? 0) + 1), at);
    if (sec > Number(R.metaGet(db, GAP_LONGEST_KEY) ?? 0)) R.metaSet(db, GAP_LONGEST_KEY, String(sec), at);
    R.metaSet(db, GAP_LAST_KEY, JSON.stringify(gap), at);
  } catch { /* meta best-effort */ }
  // P0.6: only a HARMFUL gap (a live match at wake) arms the protective-exit reprice window.
  if (inPlay) markGapWake(db, nowMs, sec, env);
  return gap;
}

export interface GapRepriceSummary {
  used: number; recovered: number; expired: number;
  medianDeltaCents: number | null; meanDeltaCents: number | null;
  verdict: string;
  recent: { betId: string; gapSec: number; wakeCents: number; execCents: number; outcome: string; deltaCents: number }[];
}

/** Self-measurement verdict for the reprice window: over the deferrals that actually USED the window
 *  (recovered/expired), the delta «сэкономлено/стоило» vs an immediate stop at the gap bottom. Criterion set in
 *  advance — a NEGATIVE median means waiting hurts on balance → the window should be removed. */
export function gapRepriceSummary(db: Database): GapRepriceSummary {
  const rows = R.gapRepriceMeasurements(db, 200);
  const deltas = rows.map((r) => Number(r.delta_cents ?? 0)).filter((n) => Number.isFinite(n));
  const median = deltas.length ? [...deltas].sort((a, b) => a - b)[Math.floor((deltas.length - 1) / 2)] : null;
  const mean = deltas.length ? Math.round((deltas.reduce((s, n) => s + n, 0) / deltas.length) * 100) / 100 : null;
  const recovered = rows.filter((r) => r.outcome === "recovered").length;
  const expired = rows.filter((r) => r.outcome === "expired").length;
  const verdict = median == null ? "нет данных — окно ещё не срабатывало"
    : median < 0 ? `МЕДИАННАЯ ДЕЛЬТА ${median}¢ < 0 — ожидание в среднем ВРЕДИТ, окно под снятие (критерий задан заранее)`
    : `медианная дельта +${median}¢ ≥ 0 — окно окупается; держим, добираем данные для калибровки 90с/2-тика`;
  return {
    used: rows.length, recovered, expired,
    medianDeltaCents: median, meanDeltaCents: mean, verdict,
    recent: rows.slice(0, 20).map((r) => ({ betId: r.bet_id, gapSec: r.gap_sec, wakeCents: r.wake_price_cents, execCents: Number(r.exec_price_cents ?? 0), outcome: r.outcome ?? "", deltaCents: Number(r.delta_cents ?? 0) })),
  };
}

export interface ScheduleGapSummary {
  count: number; longestSec: number; last: ScheduleGap | null;
  recent: { at: string; summary: string; harmful: boolean }[];
}

/** Read-only rollup of recorded gaps for /api/health and the schedule_gaps report. */
export function scheduleGapSummary(db: Database): ScheduleGapSummary {
  const recent = R.recentCronLog(db, 100).filter((r) => r.kind === "gap").slice(0, 20)
    .map((r) => ({ at: r.at, summary: r.summary, harmful: r.ok === 0 }));
  let last: ScheduleGap | null = null;
  try { const s = R.metaGet(db, GAP_LAST_KEY); if (s) last = JSON.parse(s) as ScheduleGap; } catch { /* ignore */ }
  return {
    count: Number(R.metaGet(db, GAP_COUNT_KEY) ?? 0),
    longestSec: Number(R.metaGet(db, GAP_LONGEST_KEY) ?? 0),
    last, recent,
  };
}
