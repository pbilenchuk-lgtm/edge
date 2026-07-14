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

const lastName = (name: string): string => {
  const parts = String(name).replace(/[.,]/g, " ").trim().split(/\s+/).filter(Boolean);
  return (parts[parts.length - 1] ?? "").toLowerCase();
};
/** Link a live tennis match to a discovered Polymarket tennis match by BOTH surnames. */
export function linkPolymarketMatch(db: Database, live: TennisLive): { matchId: string } | null {
  const a = lastName(live.p1), b = lastName(live.p2);
  if (!a || !b) return null;
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    for (const m of R.listMatches(db, c.id)) {
      const h = lastName(m.home), aw = lastName(m.away);
      if ((h === a && aw === b) || (h === b && aw === a)) return { matchId: m.id };
    }
  }
  return null;
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
  for (const m of live) {
    let pmMatchId: string | null = null, pmMid: number | null = null;
    try {
      const link = linkPolymarketMatch(db, m);
      if (link) {
        pmMatchId = link.matchId;
        if (poly.enabled) {
          const mk = R.latestMarkets(db, link.matchId).find((x) => x.external_ref);
          if (mk?.external_ref) pmMid = await fetchMidpointCents(mk.external_ref, poly, { fetchImpl: deps.fetchImpl }).catch(() => null);
        }
      }
    } catch { /* linking/pricing is best-effort, never blocks the snapshot */ }
    R.insertTennisSnapshot(db, {
      event_key: m.eventKey, provider: "apitennis", batch_at: batchAt, p1: m.p1, p2: m.p2,
      tournament: m.tournament, event_type: m.eventType, live: m.live, status: m.status,
      sets_p1: m.setsP1, sets_p2: m.setsP2, set_num: m.setNum, games_p1: m.gamesP1, games_p2: m.gamesP2,
      game_points: m.gamePoints, server: m.server, pm_match_id: pmMatchId, pm_mid_cents: pmMid,
      raw: JSON.stringify(m.raw),
    });
    written++;
  }
  return written;
}

// ── Offline break detector ──
export interface BreakEvent {
  eventKey: string; batchAt: string; setNum: number; server: "first" | "second"; winner: "first" | "second";
  brokenPlayer: string; gameScore: string;
}
/**
 * A break = the SERVER lost their just-finished service game. From consecutive snapshots of
 * one match: exactly ONE game completed (game total +1), no rollback, same set, server known,
 * and the game's WINNER ≠ the server. Jumps of >1 game (missed polls) are skipped as coverage
 * gaps, not guessed. Deterministic — zero heuristics.
 */
export function detectBreaks(rows: R.TennisSnapshotRow[]): BreakEvent[] {
  const out: BreakEvent[] = [];
  const s = [...rows].sort((a, b) => (a.batch_at < b.batch_at ? -1 : 1));
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    if (a.set_num == null || b.set_num == null || a.set_num !== b.set_num) continue; // set boundary → games reset
    if (a.games_p1 == null || a.games_p2 == null || b.games_p1 == null || b.games_p2 == null) continue;
    const da = b.games_p1 - a.games_p1, dbb = b.games_p2 - a.games_p2;
    if (da < 0 || dbb < 0) continue;      // score correction/rollback
    if (da + dbb !== 1) continue;         // want exactly one clean completed game
    const winner: "first" | "second" = da === 1 ? "first" : "second";
    const server = a.server;              // who served the game that just finished
    if (server !== "first" && server !== "second") continue;
    if (winner !== server) {
      out.push({
        eventKey: b.event_key, batchAt: b.batch_at, setNum: b.set_num, server, winner,
        brokenPlayer: server === "first" ? (b.p1 ?? "first") : (b.p2 ?? "second"),
        gameScore: `${b.games_p1}-${b.games_p2}`,
      });
    }
  }
  return out;
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
