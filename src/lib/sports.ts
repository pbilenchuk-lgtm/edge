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
  /** raw ESPN display clock, e.g. "45'+2'" / "90'+4'" — preserves stoppage time
   *  that the integer `minute` drops. Shown in the UI / fed to reassessment. */
  clock?: string | null;
}

export interface TeamLineup { team: string; formation: string | null; starters: string[] }
export interface MatchEvent { key: string; minute: number | null; type: "goal" | "red_card" | "yellow_card" | "sub" | "penalty" | "other"; team: string | null; text: string }
/** Compact team match statistics (possession, shots, etc.) — the "how the game
 *  is actually going" signal beyond the score, fed to analysis/reassessment. */
export interface TeamStats { team: string; items: { label: string; value: string }[] }
export interface MatchDetail {
  lineupOut: boolean;
  lineups: { home: TeamLineup | null; away: TeamLineup | null };
  events: MatchEvent[];
  stats?: { home: TeamStats | null; away: TeamStats | null };
}

export interface SportsProvider {
  readonly name: string;
  scoreboard(sport: string, league: string): Promise<SportsMatchStatus[]>;
  /** Lineups + key events for one event (ESPN summary). Optional per provider. */
  matchDetail?(sport: string, league: string, eventId: string): Promise<MatchDetail | null>;
  /** The leagues/feeds to poll for a sport (e.g. ESPN: ["nba","wnba"]). Lets the
   *  enrichment loop stay provider-agnostic — a unified paid provider can return
   *  a single "" feed per sport instead of ESPN's per-league slugs. */
  leaguesFor?(sport: string): string[];
}

function eventType(text: string): MatchEvent["type"] {
  const t = text.toLowerCase();
  if (/red card/.test(t)) return "red_card";
  if (/yellow card/.test(t)) return "yellow_card";
  if (/goal/.test(t) && !/no goal|disallow/.test(t)) return "goal";
  // Penalty NOT converted (saved / missed / awarded / VAR). A SCORED penalty
  // already reads as "goal" above; this catches the rest — a high-impact event
  // (a ~0.79 xG chance the scoreline doesn't reflect) that must not be dropped as
  // "other". e.g. ESPN "Penalty - Saved: Mbappé ... saved by Bounou".
  if (/penalty/.test(t)) return "penalty";
  if (/substitution|\bsub\b/.test(t)) return "sub";
  return "other";
}

export interface SportsConfig {
  enabled: boolean;
  espnBase: string;
  timeoutMs: number;
  /** default league per ТЗ sport id */
  leagues: Record<string, string>;
  /** ESPN leagues to poll per sport (football comes from linked competitions).
   *  These have stable slugs; tennis/table-tennis/esports aren't on ESPN. */
  sportLeagues: Record<string, string[]>;
  /** StatPal (paid, self-serve) — covers the sports ESPN can't: per-match tennis,
   *  esports, cricket. Empty key → StatPal off, ESPN-only. */
  statpalKey: string;
  statpalBase: string;
}

/** Parse a comma-separated env override into a league slug list. */
function leaguesEnv(v: string | undefined, fallback: string[]): string[] {
  const list = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

export function loadSportsConfig(env: Record<string, string | undefined> = process.env): SportsConfig {
  return {
    enabled: (env.SPORTS_ENABLED ?? "false").toLowerCase() === "true",
    espnBase: env.ESPN_BASE ?? "https://site.api.espn.com/apis/site/v2/sports",
    timeoutMs: Number(env.SPORTS_TIMEOUT_MS ?? 8000),
    leagues: { football: env.ESPN_SOCCER_LEAGUE ?? "eng.1", tennis: "atp" },
    sportLeagues: {
      basketball: leaguesEnv(env.ESPN_BASKETBALL_LEAGUES, ["nba", "wnba"]),
      hockey: leaguesEnv(env.ESPN_HOCKEY_LEAGUES, ["nhl"]),
      baseball: leaguesEnv(env.ESPN_BASEBALL_LEAGUES, ["mlb"]),
      // ESPN cricket needs numeric series ids (no stable slug); StatPal covers
      // cricket properly, so ESPN cricket is off unless explicitly configured.
      cricket: leaguesEnv(env.ESPN_CRICKET_LEAGUES, []),
    },
    statpalKey: env.STATPAL_KEY ?? "",
    statpalBase: env.STATPAL_BASE ?? "https://statpal.io/api",
  };
}

/** ТЗ sport id -> ESPN sport path. Sports absent here (tennis per-match,
 *  table tennis, esports) have no ESPN feed — they need a paid provider. */
const ESPN_SPORT: Record<string, string> = {
  football: "soccer", basketball: "basketball", hockey: "hockey", baseball: "baseball", cricket: "cricket",
};

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

  leaguesFor(sport: string): string[] {
    return this.cfg.sportLeagues[sport] ?? [];
  }

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

// ------------------------------------------------------------
// StatPal provider — per-match tennis / esports / cricket (not on ESPN).
// Self-serve JSON API; feeds are XML-derived, so a single child collapses to an
// OBJECT instead of a 1-element array — `asArr` normalizes that everywhere.
// Live-only endpoints (in-play + finished today); upcoming matches come from
// Polymarket discovery and get their live score/state here once they start.
// ------------------------------------------------------------
const asArr = <T>(x: T | T[] | null | undefined): T[] => (Array.isArray(x) ? x : x == null ? [] : [x]);
const intOrNull = (x: unknown): number | null => {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
/** Leading integer of a cricket score string ("366" → 366, "108/9" → 108). */
const cricketRuns = (x: unknown): number | null => {
  const m = String(x ?? "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
};

/** StatPal live-feed path per ТЗ sport. Soccer is v2 with a different shape;
 *  the rest are v1 `/<sport>/livescores`. */
const STATPAL_FEED: Record<string, string> = {
  tennis: "v1/tennis/livescores", esports: "v1/esports/livescores",
  football: "v2/soccer/matches/live", // cricket dropped — no Polymarket liquidity
};

export class StatpalSportsProvider implements SportsProvider {
  readonly name = "statpal";
  constructor(private cfg: SportsConfig, private fetchImpl: typeof fetch = fetch) {}

  leaguesFor(sport: string): string[] {
    return STATPAL_FEED[sport] ? [""] : []; // one live feed per sport (no league slug)
  }

  async scoreboard(sport: string, _league: string): Promise<SportsMatchStatus[]> {
    const feed = STATPAL_FEED[sport];
    if (!feed) return [];
    const json = await this.get(feed);
    if (!json) return [];
    try {
      if (sport === "tennis") return parseStatpalTennis(json);
      if (sport === "esports") return parseStatpalEsports(json);
      if (sport === "cricket") return parseStatpalCricket(json);
      if (sport === "football") return parseStatpalSoccer(json);
    } catch { /* malformed feed → nothing, keep last DB state */ }
    return [];
  }

  private async get(path: string): Promise<any | null> {
    const url = `${this.cfg.statpalBase}/${path}?access_key=${encodeURIComponent(this.cfg.statpalKey)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return (await res.json()) as any;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

const isTime = (s: string) => /^\d{1,2}:\d{2}$/.test(s.trim());

// StatPal status vocab is open-ended and varies per sport, so classify the
// non-live cases EXPLICITLY and only fall through to "live" for a genuine
// in-play marker (set number, ball commentary, minute). Otherwise a status we
// don't recognize — "Canc.", "Postponed", "Abandoned", "" — was silently read
// as a live 0-0 game that never settles.
const STATPAL_DONE = /finish|ended|full ?time|\bft\b|aet|aot|\bap\b|\bpen\b|retired|walk\s?over|\bw\.?o\b|abandon|cancel|\bcanc\b|void|awarded|no result/i;
const STATPAL_PENDING = /not started|scheduled|\bns\b|tbd|postp|delay|suspend|\bsusp\b|interrupt|\bint\b|awaiting|to be/i;
/** "finished" | "upcoming" for a recognized non-live status, else null (in-play). */
function statpalNonLive(status: string): "finished" | "upcoming" | null {
  const s = status.trim();
  if (!s) return "upcoming";                 // empty → never assume live
  if (STATPAL_DONE.test(s)) return "finished";
  if (STATPAL_PENDING.test(s) || isTime(s)) return "upcoming";
  return null;                               // genuine in-play marker
}

export function parseStatpalTennis(json: any): SportsMatchStatus[] {
  const out: SportsMatchStatus[] = [];
  for (const t of asArr(json?.livescores?.tournament)) {
    for (const m of asArr((t as any).match)) {
      const ps = asArr((m as any).player);
      if (ps.length < 2) continue;
      const [h, a] = ps as any[];
      const st = String((m as any).status ?? "");
      const nl = statpalNonLive(st);
      const finished = nl === "finished" || /\bdef\b/i.test(st);
      out.push({
        externalRef: String((m as any).id),
        home: String(h.name ?? "?"), away: String(a.name ?? "?"),
        state: finished ? "finished" : nl === "upcoming" ? "upcoming" : "live",
        minute: null,
        scoreHome: intOrNull(h.totalscore), scoreAway: intOrNull(a.totalscore),
        final: finished,
        detail: (t as any).name ? String((t as any).name) : String((m as any).status ?? ""),
        clock: null,
      });
    }
  }
  return out;
}

export function parseStatpalEsports(json: any): SportsMatchStatus[] {
  const out: SportsMatchStatus[] = [];
  for (const m of asArr(json?.scores?.match)) {
    const st = String((m as any).status ?? "");
    const nl = statpalNonLive(st);
    const finished = nl === "finished";
    out.push({
      externalRef: String((m as any).id),
      home: String((m as any).home?.name ?? "?"), away: String((m as any).away?.name ?? "?"),
      state: finished ? "finished" : nl === "upcoming" ? "upcoming" : "live",
      minute: null,
      scoreHome: intOrNull((m as any).home?.score), scoreAway: intOrNull((m as any).away?.score),
      final: finished,
      detail: String((m as any).type ?? (m as any).league ?? ""),
      clock: null,
    });
  }
  return out;
}

export function parseStatpalCricket(json: any): SportsMatchStatus[] {
  const out: SportsMatchStatus[] = [];
  for (const c of asArr(json?.scores?.category)) {
    for (const m of asArr((c as any).match)) {
      const st = String((m as any).status ?? "");
      const homeWin = String((m as any).home?.winner) === "True";
      const awayWin = String((m as any).away?.winner) === "True";
      const post = String((m as any).comment?.post ?? "");
      const nl = statpalNonLive(st);
      const finished = nl === "finished" || homeWin || awayWin || /won by|match drawn|\bdraw\b/i.test(post);
      out.push({
        externalRef: String((m as any).id),
        home: String((m as any).home?.name ?? "?"), away: String((m as any).away?.name ?? "?"),
        state: finished ? "finished" : nl === "upcoming" ? "upcoming" : "live",
        minute: null,
        // cricket totalscore is "runs" (Tests) or "runs/wickets" (T20, e.g.
        // "108/9") — take the leading integer (runs) as the numeric score.
        scoreHome: cricketRuns((m as any).home?.totalscore), scoreAway: cricketRuns((m as any).away?.totalscore),
        final: finished,
        detail: (c as any).name ? String((c as any).name) : post || undefined,
        clock: null,
      });
    }
  }
  return out;
}

export function parseStatpalSoccer(json: any): SportsMatchStatus[] {
  const out: SportsMatchStatus[] = [];
  for (const lg of asArr(json?.live_matches?.league)) {
    for (const m of asArr((lg as any).match)) {
      const st = String((m as any).status ?? "").trim();
      const nl = statpalNonLive(st);
      const finished = nl === "finished";
      const live = nl === null;
      const minNum = /^\d{1,3}(\+\d+)?$/.test(st) ? parseInt(st, 10) : intOrNull((m as any).minute);
      out.push({
        externalRef: String((m as any).main_id ?? (m as any).id ?? (m as any).fallback_id_1 ?? ""),
        home: String((m as any).home?.name ?? "?"), away: String((m as any).away?.name ?? "?"),
        state: finished ? "finished" : nl === "upcoming" ? "upcoming" : "live",
        minute: live ? minNum : null,
        scoreHome: intOrNull((m as any).home?.goals), scoreAway: intOrNull((m as any).away?.goals),
        final: finished,
        detail: (lg as any).name ? String((lg as any).name) : undefined,
        clock: live && st ? st : null,
      });
    }
  }
  return out;
}

/** League tag telling the composite a job belongs to StatPal, not ESPN. */
const SP_TAG = "sp:";

/**
 * Route scoreboards by league tag: an "sp:<sport>" job → StatPal, anything else
 * → ESPN. `statpalSports` are the sports StatPal serves; FOOTBALL is in both —
 * ESPN covers its mapped leagues (with lineups/stats), StatPal covers every
 * other league (Morocco, minor leagues) that ESPN has no feed for.
 */
export class CompositeSportsProvider implements SportsProvider {
  readonly name = "composite";
  constructor(private statpal: SportsProvider, private espn: SportsProvider, private statpalSports: Set<string>) {}
  leaguesFor(sport: string): string[] {
    const out: string[] = [];
    if (this.statpalSports.has(sport)) out.push(SP_TAG + sport);            // StatPal live feed
    if (this.espn.leaguesFor) out.push(...this.espn.leaguesFor(sport));      // ESPN league slugs
    return out;
  }
  scoreboard(sport: string, league: string): Promise<SportsMatchStatus[]> {
    return league.startsWith(SP_TAG) ? this.statpal.scoreboard(sport, "") : this.espn.scoreboard(sport, league);
  }
  matchDetail(sport: string, league: string, eventId: string): Promise<MatchDetail | null> {
    if (league.startsWith(SP_TAG)) return this.statpal.matchDetail ? this.statpal.matchDetail(sport, "", eventId) : Promise.resolve(null);
    return this.espn.matchDetail ? this.espn.matchDetail(sport, league, eventId) : Promise.resolve(null);
  }
}

// The team-statistics ESPN publishes for soccer that actually inform a trade —
// tempo, territory, threat. Mapped from ESPN stat `name` to a short RU label.
const STAT_LABELS: Record<string, string> = {
  possessionPct: "владение",
  totalShots: "удары",
  shotsOnTarget: "в створ",
  wonCorners: "угловые",
  foulsCommitted: "фолы",
  saves: "сейвы",
  offsides: "офсайды",
  bigChanceCreated: "моменты",
  totalShotsOnGoal: "в створ",
  effectiveClearance: "выносы",
};
function teamStats(r: any): TeamStats | null {
  if (!r) return null;
  const src = Array.isArray(r.statistics) ? r.statistics : [];
  const items: { label: string; value: string }[] = [];
  for (const st of src) {
    const label = STAT_LABELS[String(st?.name ?? "")];
    const value = st?.displayValue;
    if (label && value != null && value !== "") items.push({ label, value: String(value) });
  }
  return { team: r.team?.displayName ?? "?", items };
}

export function parseEspnSummary(s: any): MatchDetail {
  const teamLineup = (r: any): TeamLineup | null => {
    if (!r) return null;
    // Keep the POSITIONAL layout, not just names: ESPN's roster carries each
    // starter's role (position.abbreviation) and slot in the shape
    // (formationPlace, 1..11). Order by that slot and tag the role, so the
    // analyst sees the actual раскладка (5-3-2 bus vs 4-3-3 with two wingers →
    // very different xG at identical names), not a flat name list. When a feed
    // omits the position we fall back to the bare name (no "(?)" noise).
    const starters = (r.roster ?? [])
      .filter((p: any) => p.starter)
      .map((p: any) => ({
        name: p.athlete?.displayName as string | undefined,
        pos: (p.position?.abbreviation ?? p.athlete?.position?.abbreviation) as string | undefined,
        slot: Number(p.formationPlace ?? NaN),
      }))
      .filter((p: { name?: string }) => p.name)
      .sort((a: { slot: number }, b: { slot: number }) => (isNaN(a.slot) ? 99 : a.slot) - (isNaN(b.slot) ? 99 : b.slot))
      .map((p: { name?: string; pos?: string }) => (p.pos ? `${p.name} (${p.pos})` : p.name!));
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
  // team statistics live under boxscore.teams[] (possession, shots, …)
  const boxTeams = s.boxscore?.teams ?? [];
  const statHome = teamStats(boxTeams.find((t: any) => t.homeAway === "home") ?? boxTeams[0]);
  const statAway = teamStats(boxTeams.find((t: any) => t.homeAway === "away") ?? boxTeams[1]);
  // lineups are "out" once starters are published for both sides
  const lineupOut = !!(home?.starters.length && away?.starters.length);
  return { lineupOut, lineups: { home, away }, events, stats: { home: statHome, away: statAway } };
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
      clock: (String(e.status?.displayClock ?? "").trim() || null),
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
  // A StatPal key implies intent to enrich even if SPORTS_ENABLED wasn't set.
  if (!cfg.enabled && !cfg.statpalKey) return null;
  const espn = new EspnSportsProvider(cfg, fetchImpl);
  if (!cfg.statpalKey) return espn;
  const statpal = new StatpalSportsProvider(cfg, fetchImpl);
  // StatPal serves tennis/esports/cricket (no ESPN feed) AND football — for
  // football it supplements ESPN, covering every league ESPN doesn't map
  // (Morocco, minor leagues), so liquid discovered matches all get live data.
  return new CompositeSportsProvider(statpal, espn, new Set(["tennis", "esports", "football"]));
}
