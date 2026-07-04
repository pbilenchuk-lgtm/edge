// ============================================================
// EDGE LAB — sports data provider (ТЗ §5.2)  [SERVER-ONLY]
//
// Schedule, live events (goals via score delta), minute, and final score —
// used to drive match state transitions, reassessment triggers, and
// settlement (ТЗ §3.3). Validated against ESPN's public JSON API (no key):
//   https://site.api.espn.com/apis/site/v2/sports/{espnSport}/{league}/scoreboard
//   event.status.type.state: "pre" | "in" | "post"  (+ completed)
//   status.displayClock -> minute, competitors[].score -> score
//
// Provider-agnostic: EspnSportsProvider is live; MockSportsProvider drives
// scripted matches for tests/sandbox. Everything degrades gracefully — a
// blocked/failed fetch yields [] and the app keeps its last DB state (§6).
// ============================================================

import "./http.js"; // proxy-aware fetch
import type { MatchState } from "./types.js";

export interface SportsMatchStatus {
  externalRef: string;
  home: string;
  away: string;
  state: MatchState;
  minute: number | null;
  scoreHome: number | null;
  scoreAway: number | null;
  final: boolean;
  detail?: string;
}

export interface TeamLineup { team: string; formation: string | null; starters: string[] }
export interface MatchEvent { key: string; minute: number | null; type: "goal" | "red_card" | "yellow_card" | "sub" | "other"; team: string | null; text: string }
export interface MatchDetail { lineupOut: boolean; lineups: { home: TeamLineup | null; away: TeamLineup | null }; events: MatchEvent[] }

export interface SportsProvider {
  readonly name: string;
  scoreboard(sport: string, league: string): Promise<SportsMatchStatus[]>;
  /** Lineups + key events for one event (ESPN summary). Optional per provider. */
  matchDetail?(sport: string, league: string, eventId: string): Promise<MatchDetail | null>;
}

function eventType(text: string): MatchEvent["type"] {
  const t = text.toLowerCase();
  if (/red card/.test(t)) return "red_card";
  if (/yellow card/.test(t)) return "yellow_card";
  if (/goal/.test(t) && !/no goal|disallow/.test(t)) return "goal";
  if (/substitution|\bsub\b/.test(t)) return "sub";
  return "other";
}

export interface SportsConfig {
  enabled: boolean;
  espnBase: string;
  timeoutMs: number;
  /** default league per ТЗ sport id */
  leagues: Record<string, string>;
}

export function loadSportsConfig(env: Record<string, string | undefined> = process.env): SportsConfig {
  return {
    enabled: (env.SPORTS_ENABLED ?? "false").toLowerCase() === "true",
    espnBase: env.ESPN_BASE ?? "https://site.api.espn.com/apis/site/v2/sports",
    timeoutMs: Number(env.SPORTS_TIMEOUT_MS ?? 8000),
    leagues: { football: env.ESPN_SOCCER_LEAGUE ?? "eng.1", tennis: "atp" },
  };
}

/** ТЗ sport id -> ESPN sport path. */
const ESPN_SPORT: Record<string, string> = { football: "soccer", tennis: "tennis" };

function mapState(espnState: string, completed: boolean): MatchState {
  if (completed || espnState === "post") return "finished";
  if (espnState === "in") return "live";
  return "upcoming";
}

function parseMinute(displayClock: unknown, detail: unknown): number | null {
  const s = String(displayClock ?? detail ?? "");
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export class EspnSportsProvider implements SportsProvider {
  readonly name = "espn";
  constructor(private cfg: SportsConfig, private fetchImpl: typeof fetch = fetch) {}

  async scoreboard(sport: string, league: string): Promise<SportsMatchStatus[]> {
    const espnSport = ESPN_SPORT[sport];
    if (!espnSport) return [];
    const url = `${this.cfg.espnBase}/${espnSport}/${league}/scoreboard`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      return (data.events ?? []).map(parseEspnEvent).filter(Boolean) as SportsMatchStatus[];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** Real lineups + key events from ESPN's summary endpoint. Degrades to null. */
  async matchDetail(sport: string, league: string, eventId: string): Promise<MatchDetail | null> {
    const espnSport = ESPN_SPORT[sport];
    if (!espnSport) return null;
    const url = `${this.cfg.espnBase}/${espnSport}/${league}/summary?event=${encodeURIComponent(eventId)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const s = (await res.json()) as any;
      return parseEspnSummary(s);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseEspnSummary(s: any): MatchDetail {
  const teamLineup = (r: any): TeamLineup | null => {
    if (!r) return null;
    const starters = (r.roster ?? []).filter((p: any) => p.starter).map((p: any) => p.athlete?.displayName).filter(Boolean);
    return { team: r.team?.displayName ?? "?", formation: r.formation ?? null, starters };
  };
  const rosters = s.rosters ?? [];
  const home = teamLineup(rosters.find((r: any) => r.homeAway === "home") ?? rosters[0]);
  const away = teamLineup(rosters.find((r: any) => r.homeAway === "away") ?? rosters[1]);
  const events: MatchEvent[] = (s.keyEvents ?? []).map((e: any): MatchEvent => {
    const text = String(e.text ?? e.shortText ?? "");
    const type = eventType(String(e.type?.text ?? text));
    const minute = (() => { const m = String(e.clock?.displayValue ?? e.time?.displayValue ?? "").match(/(\d+)/); return m ? parseInt(m[1], 10) : null; })();
    return { key: String(e.id ?? `${minute}-${text.slice(0, 30)}`), minute, type, team: e.team?.displayName ?? null, text };
  });
  // lineups are "out" once starters are published for both sides
  const lineupOut = !!(home?.starters.length && away?.starters.length);
  return { lineupOut, lineups: { home, away }, events };
}

export function parseEspnEvent(e: any): SportsMatchStatus | null {
  try {
    const comp = e.competitions[0];
    const cs = comp.competitors;
    const home = cs.find((c: any) => c.homeAway === "home");
    const away = cs.find((c: any) => c.homeAway === "away");
    const st = e.status?.type ?? {};
    const num = (x: any) => (x == null || x === "" ? null : Number(x));
    return {
      externalRef: String(e.id),
      home: home?.team?.displayName ?? "?",
      away: away?.team?.displayName ?? "?",
      state: mapState(st.state, !!st.completed),
      minute: parseMinute(e.status?.displayClock, st.detail),
      scoreHome: num(home?.score),
      scoreAway: num(away?.score),
      final: !!st.completed,
      detail: st.detail,
    };
  } catch {
    return null;
  }
}

/** Scripted provider for tests/simulation: returns queued statuses per ref. */
export class MockSportsProvider implements SportsProvider {
  readonly name = "mock";
  private idx: Record<string, number> = {};
  constructor(private scripts: Record<string, SportsMatchStatus[]>) {}
  async scoreboard(): Promise<SportsMatchStatus[]> {
    const out: SportsMatchStatus[] = [];
    for (const [ref, seq] of Object.entries(this.scripts)) {
      const i = Math.min(this.idx[ref] ?? 0, seq.length - 1);
      out.push(seq[i]);
      this.idx[ref] = i + 1;
    }
    return out;
  }
}

export function loadSportsProvider(
  cfg = loadSportsConfig(),
  fetchImpl: typeof fetch = fetch,
): SportsProvider | null {
  return cfg.enabled ? new EspnSportsProvider(cfg, fetchImpl) : null;
}
