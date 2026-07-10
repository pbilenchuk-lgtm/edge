// ============================================================
// EDGE LAB — multi-provider RAW snapshot layer  [SERVER-ONLY]
//
// Purpose (user ask): for every match, capture what EACH data provider returns
// — pre-match and live — storing the WHOLE raw JSON plus a small set of
// extracted labels, so after the match we can compare providers side by side:
//   • xG present? value home/away? growing or flat?
//   • shot events? with x/y coords? with zone? or only a counter? (own-xG?)
//   • live stats (possession / shots on target / corners) present live?
//   • lineups live? events full feed or only last_event?
//   • odds (exchange/bookmaker) present, live?
//   • latency: derived post-hoc from batch_at vs when a goal shows up.
//
// This is DISTINCT from SportsProvider (which returns parsed data to drive the
// lifecycle). Here we keep the raw payload untouched — «чтобы увидеть то, что
// ты мог не заметить». Every fetch degrades to {ok:false}; never throws.
// ============================================================

import "./http.js"; // proxy-aware fetch

// ---- normalized extraction shape (stored as JSON in provider_snapshots.extracted) ----
export interface Extracted {
  minute: number | null;
  xg: { present: boolean; home: number | null; away: number | null };
  /** shots signal — the "own xG or not" question: coords/zone vs bare counter. */
  shots: { present: boolean; withCoords: boolean; withZone: boolean; counterOnly: boolean; total: number | null };
  liveStats: { present: boolean; possession: boolean; shotsOnTarget: boolean; corners: boolean };
  lineups: { present: boolean; confirmed: boolean };
  events: { mode: "full" | "last_event" | "none"; count: number; goals: number };
  odds: { present: boolean; live: boolean };
  note?: string;
}

export interface RawFetch {
  ok: boolean;
  httpStatus: number | null;
  providerRef: string | null;
  minute: number | null;
  raw: unknown;            // full payload — stringified by the caller
  extracted: Extracted | null;
  latencyMs: number;
  error?: string;
}

export interface ProvidersConfig {
  timeoutMs: number;
  sportmonks: { enabled: boolean; key: string; base: string };
  thestatsapi: { enabled: boolean; key: string; base: string };
  statpal: { enabled: boolean; key: string; base: string };
}

export function loadProvidersConfig(env: Record<string, string | undefined> = process.env): ProvidersConfig {
  const smKey = env.SPORTMONKS_KEY ?? env.Sportmonks ?? env.SPORTMONKS ?? "";
  const tsaKey = env.THESTATSAPI_KEY ?? env.THESTATSAPI ?? "";
  const spKey = env.STATPAL_KEY ?? env.STATPAL ?? "";
  // RETIRED: TheStatsAPI + StatPal subscriptions were cancelled — the only live
  // football data now comes from ESPN (core SportsProvider, free) + Sportmonks
  // (live xG on the WC plan). Force these OFF regardless of any lingering key so
  // the collector never calls them and the UI badge never lists them. Flip back by
  // restoring `!!tsaKey` / `!!spKey` if a paid plan is re-added.
  return {
    timeoutMs: Number(env.SNAPSHOT_TIMEOUT_MS ?? env.SPORTS_TIMEOUT_MS ?? 8000),
    sportmonks: { enabled: !!smKey, key: smKey, base: env.SPORTMONKS_BASE ?? "https://api.sportmonks.com/v3/football" },
    thestatsapi: { enabled: false, key: tsaKey, base: env.THESTATSAPI_BASE ?? "https://api.thestatsapi.com" },
    statpal: { enabled: false, key: spKey, base: env.STATPAL_BASE ?? "https://statpal.io/api/v1" },
  };
}

/** Which providers are active (have a key). Used by the collector + UI badge. */
export function activeProviders(cfg: ProvidersConfig): string[] {
  const out: string[] = [];
  if (cfg.sportmonks.enabled) out.push("sportmonks");
  if (cfg.thestatsapi.enabled) out.push("thestatsapi");
  if (cfg.statpal.enabled) out.push("statpal");
  return out;
}

// ---- helpers ----
const strip = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Loose team-name match: one name contained in the other after normalization. */
function teamsMatch(aHome: string, aAway: string, bHome: string, bAway: string): boolean {
  const h1 = strip(aHome), a1 = strip(aAway), h2 = strip(bHome), a2 = strip(bAway);
  const hit = (x: string, y: string) => !!x && !!y && (x.includes(y) || y.includes(x));
  return (hit(h1, h2) && hit(a1, a2)) || (hit(h1, a2) && hit(a1, h2));
}
/** UTC calendar dates to search a provider's schedule on (kickoff day ± today). */
function candidateDates(kickoffIso: string | null | undefined, nowMs: number): string[] {
  const dates = new Set<string>();
  const add = (ms: number) => dates.add(new Date(ms).toISOString().slice(0, 10));
  const k = kickoffIso ? Date.parse(kickoffIso) : NaN;
  if (!isNaN(k)) { add(k); add(k - 86400_000); add(k + 86400_000); }
  add(nowMs);
  return [...dates];
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response | null; ms: number; err?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, ms: Date.now() - t0 };
  } catch (e) {
    return { res: null, ms: Date.now() - t0, err: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export interface MatchRef { home: string; away: string; kickoffIso: string | null }

// ============================================================
// Sportmonks (v3)
// ============================================================
const SM_INCLUDE = "participants;scores;state;periods;events.type;statistics.type;lineups;xgfixture";
// Sportmonks event type_ids that are a GOAL of some kind (open play / own goal /
// penalty / shootout) — used to count goals for the post-match latency check.
const SM_GOAL_TYPE_IDS = new Set([14, 15, 16, 23]);

async function smResolve(cfg: ProvidersConfig, m: MatchRef, nowMs: number): Promise<string | null> {
  for (const d of candidateDates(m.kickoffIso, nowMs)) {
    const url = `${cfg.sportmonks.base}/fixtures/date/${d}?api_token=${cfg.sportmonks.key}&include=participants&per_page=100`;
    const { res } = await timedFetch(url, {}, cfg.timeoutMs);
    if (!res || !res.ok) continue;
    const body: any = await res.json().catch(() => null);
    for (const f of body?.data ?? []) {
      const ps = f.participants?.data ?? f.participants ?? [];
      const home = ps.find((p: any) => (p.meta?.location ?? p.meta?.data?.location) === "home")?.name ?? ps[0]?.name ?? "";
      const away = ps.find((p: any) => (p.meta?.location ?? p.meta?.data?.location) === "away")?.name ?? ps[1]?.name ?? "";
      if (teamsMatch(m.home, m.away, home, away)) return String(f.id);
    }
  }
  return null;
}

function smExtract(f: any): Extracted {
  const ps = f.participants?.data ?? f.participants ?? [];
  const homeId = ps.find((p: any) => (p.meta?.location ?? p.meta?.data?.location) === "home")?.id;
  const awayId = ps.find((p: any) => (p.meta?.location ?? p.meta?.data?.location) === "away")?.id;
  const minute = (f.periods?.data ?? f.periods ?? []).map((p: any) => p.minutes).filter((x: any) => x != null).at(-1) ?? null;

  // xgfixture returns MANY rows per team (different xG metrics keyed by type_id:
  // 5304 = Expected Goals, plus xGOT / on-target / momentum variants). Pin the
  // convenience value to the canonical xG (5304); fall back to the first row if
  // the schema changes. The full set is preserved in `raw` regardless.
  const xgRows = (f.xgfixture?.data ?? f.xgfixture ?? f.xGFixture ?? []) as any[];
  const XG_TYPE = 5304;
  const xgFor = (pid: any) => {
    const r = xgRows.find((x) => x.participant_id === pid && Number(x.type_id) === XG_TYPE)
           ?? xgRows.find((x) => x.participant_id === pid);
    const v = r?.data?.value ?? r?.value;
    return v != null ? Number(v) : null;
  };
  const xgHome = xgFor(homeId), xgAway = xgFor(awayId);

  const stats = (f.statistics?.data ?? f.statistics ?? []) as any[];
  const hasStat = (re: RegExp) => stats.some((s) => re.test(String(s.type?.name ?? s.type?.code ?? "")));
  const shotsTotalRow = stats.find((s) => /shots total/i.test(String(s.type?.name ?? "")));
  const shotsTotal = shotsTotalRow ? Number(shotsTotalRow.data?.value ?? shotsTotalRow.value) : null;

  const events = (f.events?.data ?? f.events ?? []) as any[];
  const goals = events.filter((e) =>
    SM_GOAL_TYPE_IDS.has(Number(e.type_id)) ||
    /goal/i.test(String(e.type?.name ?? e.type?.developer_name ?? e.addition ?? ""))
  ).length;

  const lineups = (f.lineups?.data ?? f.lineups ?? []) as any[];

  return {
    minute,
    xg: { present: (xgRows as any[]).length > 0, home: xgHome, away: xgAway },
    // Sportmonks provides xG directly but shot data at fixture level is aggregate
    // counters (Shots Total/On Target), NOT per-shot x/y coordinates.
    shots: { present: hasStat(/shots/i), withCoords: false, withZone: hasStat(/inside|outside/i), counterOnly: true, total: isFinite(Number(shotsTotal)) ? Number(shotsTotal) : null },
    liveStats: { present: stats.length > 0, possession: hasStat(/possession/i), shotsOnTarget: hasStat(/shots on target/i), corners: hasStat(/corners/i) },
    lineups: { present: lineups.length > 0, confirmed: lineups.length > 0 },
    events: { mode: events.length ? "full" : "none", count: events.length, goals },
    odds: { present: !!(f.has_odds || f.has_premium_odds), live: false },
    note: "xG via xgfixture; shots = aggregate counters (no per-shot x/y at fixture level)",
  };
}

async function smFetch(cfg: ProvidersConfig, ref: string): Promise<{ res: Response | null; ms: number; err?: string }> {
  return timedFetch(`${cfg.sportmonks.base}/fixtures/${ref}?api_token=${cfg.sportmonks.key}&include=${encodeURIComponent(SM_INCLUDE)}`, {}, cfg.timeoutMs);
}

// ============================================================
// TheStatsAPI
// ============================================================
async function tsaResolve(cfg: ProvidersConfig, m: MatchRef, nowMs: number): Promise<string | null> {
  const H = { Authorization: `Bearer ${cfg.thestatsapi.key}` };
  // NB: a bare `?date=` is ignored by the API (returns a default window); the
  // working filter is `date_from`/`date_to` (verified live). Try live first, then
  // each candidate day.
  // limit=100: the default page is 20, which can truncate a busy date before the
  // target match — verified the param is honored (30 rows on a 30-match day).
  const paths = [`/api/football/matches?status=live&limit=100`, ...candidateDates(m.kickoffIso, nowMs).map((d) => `/api/football/matches?date_from=${d}&date_to=${d}&limit=100`)];
  for (const p of paths) {
    const { res } = await timedFetch(`${cfg.thestatsapi.base}${p}`, { headers: H }, cfg.timeoutMs);
    if (!res || !res.ok) continue;
    const body: any = await res.json().catch(() => null);
    const rows = body?.data ?? body?.matches ?? (Array.isArray(body) ? body : []);
    for (const r of rows ?? []) {
      const home = r.home_team?.name ?? r.home?.name ?? "";
      const away = r.away_team?.name ?? r.away?.name ?? "";
      if (teamsMatch(m.home, m.away, home, away)) return String(r.match_id ?? r.id);
    }
  }
  return null;
}

function tsaExtract(bundle: any): Extracted {
  const match = bundle?.match ?? {};
  const timeline = bundle?.timeline?.events ?? bundle?.timeline ?? [];
  const lineups = bundle?.lineups ?? null;
  const odds = bundle?.odds ?? null;
  const tl = Array.isArray(timeline) ? timeline : [];
  const minute = tl.length ? Number(tl[tl.length - 1]?.minute ?? null) : (match?.minute ?? null);
  const goals = tl.filter((e: any) => /goal/i.test(String(e.type ?? ""))).length;
  const hasShots = tl.some((e: any) => /shot/i.test(String(e.type ?? "")));
  const shotWithCoords = tl.some((e: any) => e.x != null || e.coordinates != null || e.location?.x != null);
  const lineupConfirmed = !!(lineups?.home?.starting_xi?.length || lineups?.confirmed);
  return {
    minute: isFinite(Number(minute)) ? Number(minute) : null,
    // match summary carries an `xg_available` flag, but the actual xG values are
    // not exposed on the obvious routes (/xg 404). Flag it, values unknown.
    xg: { present: !!match?.xg_available, home: null, away: null },
    shots: { present: hasShots, withCoords: shotWithCoords, withZone: false, counterOnly: false, total: null },
    liveStats: { present: false, possession: false, shotsOnTarget: false, corners: false },
    lineups: { present: !!lineups, confirmed: lineupConfirmed },
    events: { mode: tl.length ? "full" : "none", count: tl.length, goals },
    odds: { present: !!odds?.bookmakers?.length, live: !!match?.live_odds_available },
    note: "xg_available flag only (values route not found); timeline=full events incl shots (no x/y); aggregate stats route 404",
  };
}

/** TheStatsAPI splits a match across sub-routes; bundle them into one raw payload. */
async function tsaFetch(cfg: ProvidersConfig, ref: string): Promise<{ bundle: any; httpStatus: number | null; ms: number; err?: string }> {
  const H = { Authorization: `Bearer ${cfg.thestatsapi.key}` };
  const B = cfg.thestatsapi.base;
  const t0 = Date.now();
  const sub = async (path: string) => {
    const { res } = await timedFetch(`${B}${path}`, { headers: H }, cfg.timeoutMs);
    if (!res) return { status: null, data: null };
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  const [m, timeline, lineups, odds] = await Promise.all([
    sub(`/api/football/matches/${ref}`),
    sub(`/api/football/matches/${ref}/timeline`),
    sub(`/api/football/matches/${ref}/lineups`),
    sub(`/api/football/matches/${ref}/odds`),
  ]);
  return {
    bundle: { match: m.data?.data ?? m.data, timeline: timeline.data?.data ?? timeline.data, lineups: lineups.data?.data ?? lineups.data, odds: odds.data?.data ?? odds.data },
    httpStatus: m.status,
    ms: Date.now() - t0,
  };
}

// ============================================================
// StatPal (soccer livescores) — config-gated; best-effort raw capture.
// ============================================================
async function spResolve(cfg: ProvidersConfig, m: MatchRef, nowMs: number): Promise<string | null> {
  // StatPal live soccer feed: /soccer/livescores?access_key=. We can't reliably
  // map ids without their schema, so we resolve by team names against the live feed.
  const url = `${cfg.statpal.base}/soccer/livescores?access_key=${cfg.statpal.key}`;
  const { res } = await timedFetch(url, {}, cfg.timeoutMs);
  if (!res || !res.ok) return null;
  const body: any = await res.json().catch(() => null);
  const flat: any[] = [];
  const walk = (n: any) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === "object") { if (n.home || n.hometeam || n.localteam) flat.push(n); Object.values(n).forEach(walk); } };
  walk(body);
  for (const g of flat) {
    const home = g.home?.name ?? g.hometeam?.name ?? g.localteam?.name ?? g.home ?? "";
    const away = g.away?.name ?? g.awayteam?.name ?? g.visitorteam?.name ?? g.away ?? "";
    if (teamsMatch(m.home, m.away, String(home), String(away))) return String(g.id ?? g.match_id ?? `${home}-${away}`);
  }
  return null;
}

function spExtract(_g: any): Extracted {
  return {
    minute: null,
    xg: { present: false, home: null, away: null },
    shots: { present: false, withCoords: false, withZone: false, counterOnly: true, total: null },
    liveStats: { present: false, possession: false, shotsOnTarget: false, corners: false },
    lineups: { present: false, confirmed: false },
    events: { mode: "none", count: 0, goals: 0 },
    odds: { present: false, live: false },
    note: "StatPal raw captured; extraction is best-effort (schema-dependent)",
  };
}

// ============================================================
// Public API — resolve + fetch one provider for one match
// ============================================================
export async function fetchProvider(
  provider: string, cfg: ProvidersConfig, m: MatchRef, cachedRef: string | null, nowMs: number,
): Promise<RawFetch & { resolvedRef: string | null }> {
  const t0 = Date.now();
  try {
    if (provider === "sportmonks") {
      const ref = cachedRef ?? (await smResolve(cfg, m, nowMs));
      if (!ref) return { ok: false, httpStatus: null, providerRef: null, minute: null, raw: null, extracted: null, latencyMs: Date.now() - t0, resolvedRef: null, error: "fixture not resolved" };
      const { res, ms, err } = await smFetch(cfg, ref);
      if (!res) return { ok: false, httpStatus: null, providerRef: ref, minute: null, raw: null, extracted: null, latencyMs: ms, resolvedRef: ref, error: err };
      const body: any = await res.json().catch(() => null);
      const f = body?.data ?? null;
      const extracted = f ? smExtract(f) : null;
      return { ok: res.ok && !!f, httpStatus: res.status, providerRef: ref, minute: extracted?.minute ?? null, raw: body, extracted, latencyMs: ms, resolvedRef: ref };
    }
    if (provider === "thestatsapi") {
      const ref = cachedRef ?? (await tsaResolve(cfg, m, nowMs));
      if (!ref) return { ok: false, httpStatus: null, providerRef: null, minute: null, raw: null, extracted: null, latencyMs: Date.now() - t0, resolvedRef: null, error: "match not resolved" };
      const { bundle, httpStatus, ms } = await tsaFetch(cfg, ref);
      const extracted = bundle?.match ? tsaExtract(bundle) : null;
      return { ok: !!bundle?.match, httpStatus, providerRef: ref, minute: extracted?.minute ?? null, raw: bundle, extracted, latencyMs: ms, resolvedRef: ref };
    }
    if (provider === "statpal") {
      const ref = cachedRef ?? (await spResolve(cfg, m, nowMs));
      // StatPal: the resolve call already returns the live game; refetch feed and pick it.
      const url = `${cfg.statpal.base}/soccer/livescores?access_key=${cfg.statpal.key}`;
      const { res, ms } = await timedFetch(url, {}, cfg.timeoutMs);
      if (!res) return { ok: false, httpStatus: null, providerRef: ref, minute: null, raw: null, extracted: null, latencyMs: ms, resolvedRef: ref, error: "statpal unreachable" };
      const body: any = await res.json().catch(() => null);
      return { ok: res.ok, httpStatus: res.status, providerRef: ref, minute: null, raw: body, extracted: spExtract(body), latencyMs: ms, resolvedRef: ref };
    }
  } catch (e) {
    return { ok: false, httpStatus: null, providerRef: cachedRef, minute: null, raw: null, extracted: null, latencyMs: Date.now() - t0, resolvedRef: cachedRef, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: false, httpStatus: null, providerRef: null, minute: null, raw: null, extracted: null, latencyMs: 0, resolvedRef: null, error: `unknown provider ${provider}` };
}
