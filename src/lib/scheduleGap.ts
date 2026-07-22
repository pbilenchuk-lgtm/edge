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

/** A sleep shorter than this (seconds) is a missed tick or two, not a "gap" — the catch-up handles it. */
export function gapAlertSec(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SCHEDULE_GAP_ALERT_SEC);
  return Number.isFinite(n) && n > 0 ? n : 300; // 5 min
}

export interface ScheduleGap { startMs: number; endMs: number; sec: number; liveInPlay: boolean }

/**
 * Detect + record a scheduler sleep window. Call at each live-tick stamp with the PREVIOUS marker value and
 * the current time. Returns the gap when the delta ≥ threshold (records it once), else null (fresh marker or
 * first-ever stamp). `inPlay` = a live match is in play at wake — the harmful case where stops sat unmanaged.
 */
export function recordScheduleGap(
  db: Database, prevMs: number, nowMs: number, inPlay: boolean, env: Record<string, string | undefined> = process.env,
): ScheduleGap | null {
  if (!prevMs || !Number.isFinite(prevMs) || !Number.isFinite(nowMs) || nowMs <= prevMs) return null;
  const sec = Math.round((nowMs - prevMs) / 1000);
  if (sec < gapAlertSec(env)) return null;
  const gap: ScheduleGap = { startMs: prevMs, endMs: nowMs, sec, liveInPlay: inPlay };
  const at = new Date(nowMs).toISOString();
  const startIso = new Date(prevMs).toISOString();
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
  return gap;
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
