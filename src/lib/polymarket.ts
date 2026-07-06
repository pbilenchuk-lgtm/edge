// ============================================================
// EDGE LAB — Polymarket integration (ТЗ §5.1)  [SERVER-ONLY]
//
// Validated against the live API. Two public APIs, NO key needed to read:
//
//   Gamma (https://gamma-api.polymarket.com)
//     /events?tag_id=<sport>&closed=false&order=startDate&ascending=false
//     /events?slug=<event-slug>
//     A single SPORTS MATCH is a Gamma *event* with title "A vs B", a slug
//     like "atp-doig-gonzal-2026-07-04", the tag `games`, and its markets[]:
//       - match winner  (outcomes = the two sides, e.g. ["Alcaraz","Sinner"])
//       - set/goal totals (outcomes = ["Over","Under"] or ["Over 2.5",...])
//       - etc. Each market carries `outcomePrices` and `clobTokenIds`.
//     Gamma returns outcomes/outcomePrices/clobTokenIds as JSON *strings*.
//
//   CLOB (https://clob.polymarket.com)
//     /midpoint?token_id=..  -> {"mid":"0.555"}   (probability 0..1)
//     /price?token_id=..&side=buy|sell -> {"price":"0.54"}
//     WS wss://ws-subscribe-clob.polymarket.com/ws/market for realtime.
//
// Price convention: probability 0..1  ->  * 100  =  cents 0..100¢.
//
// IMPORTANT tag mapping: Polymarket's `football` tag (id 10) is AMERICAN
// football. Association football (soccer) is tag 100350. ТЗ "football" ==
// soccer, so we map it to 100350.
//
// Everything degrades gracefully: discovery returns [] and quotes fall back
// to the caller's snapshot on any failure (ТЗ §6).
// ============================================================

import "./http.js"; // configure proxy dispatcher for server-side fetch

export interface PolymarketConfig {
  enabled: boolean;
  gammaBase: string;
  clobBase: string;
  timeoutMs: number;
  /** how many near-term events of a sport to scan when linking a match */
  discoverLimit: number;
  /** cap on markets attached per match (best by liquidity) */
  maxMarketsPerMatch: number;
  /** skip discovered matches whose total market liquidity is below this (USD).
   *  Low-liquidity fixtures aren't worth betting — user: «меня не интересуют
   *  матчи с низкой ликвидностью». 0 disables the filter. */
  minLiquidity: number;
}

/**
 * ТЗ sport id -> Polymarket Gamma tag id(s). A sport may span SEVERAL tags:
 * Polymarket has no single hub tag for cricket / e-sports / table tennis, so we
 * union the relevant league tags. Discovery queries every tag and dedups events
 * by id, so overlaps are harmless.
 */
export const SPORT_TAG_IDS: Record<string, number[]> = {
  football: [100350],          // soccer (NOT tag 10 = American football)
  tennis: [864],               // filtered to liquid tours at import (see SPORT_SERIES_ALLOW)
  basketball: [28],            // deep, liquid — NBA/EuroLeague/etc.
  hockey: [900],               // ice hockey
  tabletennis: [103774, 105330], // WTT + Olympic table tennis
  esports: [65, 102366, 100635], // League of Legends, Dota 2, CS
  // cricket removed — no liquidity on Polymarket (user).
};

/** Human labels (RU) for the sports above — seeds the `sports` table + UI. */
export const SPORT_LABELS: Record<string, string> = {
  football: "Футбол",
  tennis: "Теннис",
  basketball: "Баскетбол",
  hockey: "Хоккей",
  tabletennis: "Настольный теннис",
  esports: "Киберспорт",
};

/** The Gamma tag ids backing a sport (empty for an unknown sport). */
export function sportTags(sport: string): number[] {
  return SPORT_TAG_IDS[sport] ?? [];
}

export function loadPolymarketConfig(
  env: Record<string, string | undefined> = process.env,
): PolymarketConfig {
  return {
    enabled: (env.POLYMARKET_ENABLED ?? "false").toLowerCase() === "true",
    gammaBase: env.POLYMARKET_GAMMA_BASE ?? "https://gamma-api.polymarket.com",
    clobBase: env.POLYMARKET_CLOB_BASE ?? "https://clob.polymarket.com",
    timeoutMs: Number(env.POLYMARKET_TIMEOUT_MS ?? 6000),
    discoverLimit: Number(env.POLYMARKET_DISCOVER_LIMIT ?? 1000),
    maxMarketsPerMatch: Number(env.POLYMARKET_MAX_MARKETS ?? 40),
    minLiquidity: Number(env.POLYMARKET_MIN_LIQUIDITY ?? 250),
  };
}

interface FetchDeps {
  fetchImpl?: typeof fetch;
  now?: () => string;
}

// ------------------------------------------------------------
// Quotes (CLOB) — realtime midpoint per token
// ------------------------------------------------------------

export type QuoteSource = "live" | "snapshot" | "disabled" | "error";

export interface Quote {
  tokenId: string;
  priceCents: number | null; // 0..100 (== probability * 100), or null
  source: QuoteSource;
  stale: boolean;
  fetchedAt: string;
  error?: string;
}

/** Live midpoint for one CLOB token, in cents. Throws on any failure. */
export async function fetchMidpointCents(
  tokenId: string,
  cfg: PolymarketConfig,
  deps: FetchDeps = {},
): Promise<number> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${cfg.clobBase}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
  const res = await withTimeout(cfg.timeoutMs, (signal) => doFetch(url, { signal }));
  if (!res.ok) throw new Error(`CLOB ${res.status}`);
  const json = (await res.json()) as { mid?: string | number };
  // Number("") === 0, so an empty midpoint (dead book) must be rejected BEFORE
  // the numeric coercion — else it fabricates a confident 0¢ live quote.
  if (json.mid == null || json.mid === "") throw new Error("CLOB midpoint empty");
  const mid = Number(json.mid);
  if (!isFinite(mid)) throw new Error("CLOB midpoint not numeric");
  return round1(mid * 100);
}

/**
 * Quotes for a set of tokens, each with an optional last-known snapshot in
 * cents. Never throws — every token resolves to a Quote, falling back to its
 * snapshot when live data is unavailable (ТЗ §6).
 */
export async function getQuotes(
  tokens: { tokenId: string; snapshotCents?: number | null }[],
  cfg: PolymarketConfig,
  deps: FetchDeps = {},
): Promise<Quote[]> {
  const now = deps.now ?? (() => new Date().toISOString());
  if (!cfg.enabled) {
    return tokens.map((t) => ({
      tokenId: t.tokenId,
      priceCents: t.snapshotCents ?? null,
      source: "disabled" as const,
      stale: true,
      fetchedAt: now(),
    }));
  }
  return Promise.all(
    tokens.map(async (t): Promise<Quote> => {
      try {
        return {
          tokenId: t.tokenId,
          priceCents: await fetchMidpointCents(t.tokenId, cfg, deps),
          source: "live",
          stale: false,
          fetchedAt: now(),
        };
      } catch (e) {
        return {
          tokenId: t.tokenId,
          priceCents: t.snapshotCents ?? null,
          source: "error",
          stale: true,
          fetchedAt: now(),
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
}

// ------------------------------------------------------------
// Discovery (Gamma) — match -> event -> markets
// ------------------------------------------------------------

export interface PolyMarketRow {
  /** display label, e.g. "Under 2.5" or "Alcaraz vs Sinner" */
  label: string;
  outcomes: string[]; // ["Alcaraz","Sinner"] | ["Over","Under"]
  /** price of the FIRST outcome, in cents 0..100 */
  priceCents: number | null;
  /** all outcome prices in cents, aligned with `outcomes` (for 2-way expansion) */
  prices: (number | null)[];
  /** CLOB token ids aligned with outcomes; tokenIds[0] backs priceCents */
  tokenIds: string[];
  liquidity: string | null;
  conditionId: string | null;
}

export interface PolyEvent {
  id: string;
  slug: string;
  title: string;
  startDate: string | null;
  /** actual kickoff (Gamma `startTime`/`gameStartTime`) — NOT startDate, which
   *  is the market creation date. Null when Polymarket hasn't set it. */
  startTime: string | null;
  /** tournament this match belongs to, e.g. "FIFA World Cup" — used to
   *  categorize discovered matches (Gamma `series`). Null if unlabelled. */
  series: string | null;
  /** stable series key, e.g. "soccer-fifwc" — the category id we group by. */
  seriesSlug: string | null;
  markets: PolyMarketRow[];
}

/** Parse Gamma's JSON-string-or-array fields defensively. */
export function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Coerce Gamma's gameStartTime ("YYYY-MM-DD HH:MM:SS+00" and offset variants)
 *  to a parseable ISO string, or null. Handles a bare "+00" offset, a full
 *  "+00:00", or no offset at all (→ assume UTC) — the old naive replace only
 *  handled "+00" and could yield an invalid or local-time-parsed date. */
function normalizeGst(s: string): string | null {
  let v = s.trim().replace(" ", "T");
  if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(v)) {
    v += /[+-]\d{2}$/.test(v) ? ":00" : "Z"; // bare "+00" → "+00:00"; none → UTC
  }
  return isNaN(Date.parse(v)) ? null : v;
}

export function normalizeEvent(raw: any): PolyEvent {
  const markets: PolyMarketRow[] = (raw.markets ?? []).map((m: any): PolyMarketRow => {
    const outcomes = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcomePrices);
    const tokenIds = parseJsonArray(m.clobTokenIds);
    const cents = prices.map((p) => { const n = p === "" ? NaN : Number(p); return isFinite(n) ? round1(n * 100) : null; });
    return {
      label: m.groupItemTitle || m.question || "",
      outcomes,
      priceCents: cents[0] ?? null,
      prices: cents,
      tokenIds,
      liquidity: m.liquidity != null ? String(m.liquidity) : null,
      conditionId: m.conditionId ?? null,
    };
  });
  // kickoff: event startTime, else a market's gameStartTime ("YYYY-MM-DD HH:MM:SS+00").
  const gst = raw.markets?.find?.((m: any) => m.gameStartTime)?.gameStartTime;
  const startTime = raw.startTime ?? (gst ? normalizeGst(String(gst)) : null);
  // Gamma `series`: array of { title, slug } (or bare strings). First entry is
  // the tournament (e.g. "FIFA World Cup" / "soccer-fifwc").
  const s0 = Array.isArray(raw.series) ? raw.series[0] : null;
  const series = (s0 && typeof s0 === "object" ? s0.title : s0) ? String((s0 && typeof s0 === "object" ? s0.title : s0)) : (raw.seriesName ?? null);
  const seriesSlug = raw.seriesSlug ?? (s0 && typeof s0 === "object" && s0.slug ? String(s0.slug) : null);
  return {
    id: String(raw.id ?? ""),
    slug: String(raw.slug ?? ""),
    title: String(raw.title ?? ""),
    startDate: raw.startDate ?? null,
    startTime: startTime ? String(startTime) : null,
    series: series || null,
    seriesSlug: seriesSlug || null,
    markets,
  };
}

/** Low-level fetch that DISTINGUISHES a transient failure (ok:false) from a
 *  genuinely empty page (ok:true, events:[]) — the pagination cache needs the
 *  difference so a mid-pagination timeout isn't cached as a complete result. */
async function gammaEventsRaw(
  cfg: PolymarketConfig,
  qs: string,
  deps: FetchDeps,
): Promise<{ ok: boolean; events: PolyEvent[] }> {
  if (!cfg.enabled) return { ok: true, events: [] };
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await withTimeout(cfg.timeoutMs, (signal) =>
      doFetch(`${cfg.gammaBase}/events?${qs}`, { signal }),
    );
    if (!res.ok) return { ok: false, events: [] };
    const rows = (await res.json()) as any[];
    return { ok: true, events: Array.isArray(rows) ? rows.map(normalizeEvent) : [] };
  } catch {
    return { ok: false, events: [] };
  }
}

async function gammaEvents(
  cfg: PolymarketConfig,
  qs: string,
  deps: FetchDeps,
): Promise<PolyEvent[]> {
  return (await gammaEventsRaw(cfg, qs, deps)).events;
}

/** Near-term events for a sport (newest first). Empty on failure/disabled. */
export async function listSportEvents(
  cfg: PolymarketConfig,
  sport: string,
  limit = 40,
  deps: FetchDeps = {},
): Promise<PolyEvent[]> {
  const tags = sportTags(sport);
  if (!tags.length) return [];
  const byId = new Map<string, PolyEvent>();
  for (const tag of tags) {
    for (const ev of await gammaEvents(cfg, `tag_id=${tag}&closed=false&limit=${limit}&order=startDate&ascending=false`, deps))
      byId.set(ev.id, ev);
  }
  return [...byId.values()];
}

/** Direct lookup by event slug (e.g. "atp-alcaraz-sinner-2026-07-04"). */
export async function fetchEventBySlug(
  cfg: PolymarketConfig,
  slug: string,
  deps: FetchDeps = {},
): Promise<PolyEvent | null> {
  const events = await gammaEvents(cfg, `slug=${encodeURIComponent(slug)}`, deps);
  return events[0] ?? null;
}

export interface MatchQuery {
  sport: string; // ТЗ sport id: 'football' | 'tennis'
  home: string;
  away: string;
  limit?: number;
}

/**
 * Find the Gamma event for a sports match by scanning the sport's near-term
 * events and scoring titles against the two competitor names. Returns the
 * best match (score >= 2 => both names present) or null.
 */
export async function findMatchEvent(
  cfg: PolymarketConfig,
  q: MatchQuery,
  deps: FetchDeps = {},
): Promise<PolyEvent | null> {
  const events = await findMatchEvents(cfg, q, deps);
  return events[0] ?? null;
}

/**
 * All Gamma events for a match (score >= 2 => both names present). Polymarket
 * splits one match into several events by market family ("- More Markets",
 * "- Player Props", "- Total Corners", …) and the base "Home vs. Away" — these
 * land on DIFFERENT pages (Gamma caps a response at 100 events), so a single
 * request misses them. We page through `discoverLimit` events and return every
 * variant, best-scored first. Fetched pages are cached per sport for the tick.
 */
export async function findMatchEvents(
  cfg: PolymarketConfig,
  q: MatchQuery,
  deps: FetchDeps = {},
): Promise<PolyEvent[]> {
  const tags = sportTags(q.sport);
  if (!tags.length) return [];
  const events = await fetchSportEvents(cfg, tags, q.limit ?? cfg.discoverLimit ?? 1000, deps);
  return events
    .map((ev) => ({ ev, score: titleMatchScore(ev.title, q.home, q.away) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.ev);
}

const GAMMA_PAGE = 100; // Gamma caps a single /events response at 100
const sportEventCache = new Map<string, { at: number; events: PolyEvent[] }>();
const SPORT_CACHE_TTL_MS = 120_000;

/** Page through a sport's open events (across ALL its tags) up to `limit` per
 *  tag, dedup by event id. Real fetches are cached briefly so linking many
 *  matches in one tick doesn't refetch every page. */
async function fetchSportEvents(cfg: PolymarketConfig, tags: number[], limit: number, deps: FetchDeps): Promise<PolyEvent[]> {
  const live = !deps.fetchImpl; // don't cache injected (test) fetches
  const key = [...tags].sort((a, b) => a - b).join(",");
  if (live) {
    const c = sportEventCache.get(key);
    if (c && Date.now() - c.at < SPORT_CACHE_TTL_MS) return c.events;
  }
  const byId = new Map<string, PolyEvent>(); // a match tagged with two of a sport's tags appears once
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let ok = true;
  outer: for (const tag of tags) {
    for (let off = 0; off < limit; off += GAMMA_PAGE) {
      const q = `tag_id=${tag}&closed=false&limit=${GAMMA_PAGE}&offset=${off}&order=startDate&ascending=false`;
      let page = await gammaEventsRaw(cfg, q, deps);
      // Survive a transient Polymarket rejection (rate-limit) mid-pagination: one
      // backoff-retry instead of aborting — else discovery drops whole leagues
      // that live on later pages (user: «отбиваемся от полимаркета»).
      if (!page.ok && live) { await sleep(600); page = await gammaEventsRaw(cfg, q, deps); }
      if (!page.ok) { ok = false; break outer; } // still failing → result is PARTIAL
      for (const ev of page.events) byId.set(ev.id, ev);
      if (page.events.length < GAMMA_PAGE) break; // last page of this tag
      if (live) await sleep(120); // gentle pacing — don't hammer Gamma
    }
  }
  const all = [...byId.values()];
  // Cache ONLY a complete, non-empty fetch. A transient error mid-pagination
  // (ok=false, partial) or a fully-empty result is never cached — otherwise
  // a timeout on page N would truncate discovery for the whole 2-min TTL even
  // after the network recovers, dropping matches that live on later pages.
  if (live && ok && all.length) sportEventCache.set(key, { at: Date.now(), events: all });
  return all;
}

/** 0..2: how many of the two competitor names appear in the event title.
 * Matches on each name's most distinctive (trailing) token as a WHOLE WORD,
 * not a substring — so "Real Madrid" no longer scores against "Real Sociedad"
 * while "Carlos Alcaraz" still matches a title carrying only "Alcaraz". */
export function titleMatchScore(title: string, home: string, away: string): number {
  const words = new Set(norm(title).split(/\s+/).filter(Boolean));
  return [home, away].reduce(
    (n, name) => n + (matchesTitle(name, words) ? 1 : 0),
    0,
  );
}
function matchesTitle(name: string, titleWords: Set<string>): boolean {
  const { key, qualifiers } = nameKeyTokens(name);
  if (key.length < 2 || !titleWords.has(key)) return false;
  // Same-city / shared-suffix clubs collide on the bare key ("Real"/"Atlético"
  // Madrid → "madrid"; Manchester "United"/"City" → "manchester"), which linked
  // the WRONG fixture — bets then priced against another game's markets. When the
  // name carries a distinguishing qualifier, the title MUST carry it too.
  if (qualifiers.length && !qualifiers.some((q) => titleWords.has(q))) return false;
  return true;
}

/**
 * Map a discovered event's markets to EDGE LAB market snapshots (ready for
 * the `markets` table): label, price in cents, the backing CLOB token as
 * external_ref, and liquidity. Markets without a usable price are skipped.
 */
// ------------------------------------------------------------
// Match discovery FROM Polymarket (import the many matches it lists directly,
// not only ESPN-linked competitions). A match is spread across several events
// by market family; we parse the competitors from each event's title, group by
// (home, away), and aggregate the settleable markets.
// ------------------------------------------------------------

// Many sports prefix the title with the tournament ("ITF Skopje:", "LoL:",
// "Dota 2:", "Major League Cricket:"). Strip everything up to the first colon.
const TOURNEY_PREFIX_RE = /^[^:]*:\s*/;
// Trailing market-family text appended to a title after the "A vs B" core.
const FAMILY_SUFFIX_RE = /\s*(?:[-–]\s*)?(?:more markets|player props|total corners|exact score|halftime result|1st half result|first half result|second half result|first (?:team )?to score|to score first|moneyline|corners?|cards?|bookings?|set\s*\d.*|match o\/u.*|total sets.*|set handicap.*|completed match|winner|o\/u\s*[\d.]+.*)\s*$/i;
// Per-side trailing junk on e-sports / cricket titles:
//   "Dplus KIA (BO1) - Esports World Cup Group A"  ->  "Dplus KIA"
//   "Virtus.pro - Match Result (1x2)"              ->  "Virtus.pro"
// A " - …" tail (space-hyphen-space) or a "(BOx)/(1x2)/(Map n)" bracket is never
// part of a real team/player name, so both are safe to drop.
const SIDE_TAIL_RE = /\s+[-–]\s+.*$/;
const SIDE_BRACKET_RE = /\s*\((?:bo\s*\d+|best of \d+|1x2|map \d+|game \d+)\)\s*$/i;
function cleanSide(name: string): string {
  return name.replace(SIDE_TAIL_RE, "").replace(SIDE_BRACKET_RE, "").trim();
}

/** Extract {home, away} from an event title, or null if it isn't an A-vs-B match. */
export function parseMatchTitle(title: string, sport: string): { home: string; away: string } | null {
  let s = title.trim();
  // Drop a "Tournament: " prefix — but only if the remainder is still an A-vs-B
  // title, so a colon inside a non-match title can't corrupt the parse.
  const noPrefix = s.replace(TOURNEY_PREFIX_RE, "");
  if (/\s+vs\.?\s+/i.test(noPrefix)) s = noPrefix;
  s = s.replace(FAMILY_SUFFIX_RE, "").replace(FAMILY_SUFFIX_RE, "").trim(); // twice: "… Set 1 Winner"
  const parts = s.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  const home = cleanSide(parts[0]), away = cleanSide(parts[1]);
  if (home.length < 2 || away.length < 2) return null;
  return { home, away };
}

export interface DiscoveredMatch { home: string; away: string; kickoff: string | null; markets: MarketSnapshot[]; liquidity: number; series: string | null; seriesSlug: string | null }

/**
 * Discover matches a sport lists on Polymarket: group events by competitors,
 * aggregate each match's settleable markets, drop matches with none, and return
 * the most-liquid up to `limit`.
 */
export async function discoverSportMatches(
  cfg: PolymarketConfig, sport: string, snapshotAt: string, deps: FetchDeps = {},
  opts: { limit?: number; windowDays?: number; nowMs?: number } = {},
): Promise<DiscoveredMatch[]> {
  const tags = sportTags(sport);
  if (!tags.length) return [];
  const limit = opts.limit ?? 200;
  const nowMs = opts.nowMs ?? (Date.parse(snapshotAt) || 0);
  const windowMs = (opts.windowDays ?? 7) * 86_400_000;
  const events = await fetchSportEvents(cfg, tags, cfg.discoverLimit ?? 1000, deps);
  const groups = new Map<string, { home: string; away: string; kickoff: string | null; series: string | null; seriesSlug: string | null; events: PolyEvent[] }>();
  for (const ev of events) {
    const p = parseMatchTitle(ev.title, sport);
    if (!p) continue;
    const key = `${norm(p.home)}|${norm(p.away)}`;
    const g = groups.get(key) ?? { home: p.home, away: p.away, kickoff: ev.startTime, series: ev.series, seriesSlug: ev.seriesSlug, events: [] };
    if (!g.kickoff && ev.startTime) g.kickoff = ev.startTime; // real kickoff, not creation date
    if (!g.series && ev.series) { g.series = ev.series; g.seriesSlug = ev.seriesSlug; } // tournament label
    g.events.push(ev);
    groups.set(key, g);
  }
  const out: DiscoveredMatch[] = [];
  for (const g of groups.values()) {
    // window on the real kickoff: from a few hours ago up to `windowDays` ahead
    // (so a match surfaces ~7 days before it starts). Unknown kickoff → keep.
    if (nowMs && g.kickoff) {
      const s = Date.parse(g.kickoff);
      if (!isNaN(s) && (s < nowMs - 6 * 3600_000 || s > nowMs + windowMs)) continue;
    }
    const markets = matchMarketSnapshots(g.events, snapshotAt, cfg.maxMarketsPerMatch);
    if (!markets.length) continue;
    const liquidity = markets.reduce((n, m) => n + (Number(m.liquidity ?? 0) || 0), 0);
    out.push({ home: g.home, away: g.away, kickoff: g.kickoff, markets, liquidity, series: g.series, seriesSlug: g.seriesSlug });
  }
  // MOST-LIQUID first, then cap — liquidity is what matters for betting (user),
  // so when the cap binds we keep the deepest markets, not merely the soonest.
  // Tie-break by soonest kickoff so equally-liquid near-term matches rank higher.
  return out
    .sort((a, b) => (b.liquidity - a.liquidity) || ((a.kickoff ?? "9") < (b.kickoff ?? "9") ? -1 : 1))
    .slice(0, limit);
}

export interface MarketSnapshot { label: string; price: number; external_ref: string | null; liquidity: string | null }

export function eventToMarketSnapshots(event: PolyEvent, snapshotAt: string): MarketSnapshot[] {
  return matchMarketSnapshots([event], snapshotAt, Infinity, false);
}

/**
 * Niche / prop markets the engine can't settle (settlement.ts only resolves
 * full-time totals, BTTS, moneyline and handicaps). Attaching these would flood
 * the UI and create bets that never settle — so we drop them by default.
 */
export function isNoiseMarket(label: string): boolean {
  const l = label.toLowerCase();
  return (
    /:\s*\d+\+?\s/.test(l) || // player prop "Name: 1+ goals / 4+ saves / 2+ shots …"
    /\bcorners?\b|\bcards?\b|\bbookings?\b|\boffsides?\b|\bfouls?\b|\bthrow-?ins?\b|\bsaves?\b/.test(l) ||
    /1st half|first half|half[- ]?time|halftime|2nd half|second half/.test(l) ||
    /exact|correct score/.test(l) ||
    /\d\s*[-–]\s*\d/.test(l) || // correct-score "Team A 3 - 3 Team B" (handicaps like "-1.5" don't match)
    /first (team )?to score|to score first|anytime (goal ?)?scorer/.test(l) ||
    /\bneither\b|any other|other score|winning margin|margin of victory|score ?cast/.test(l) // correct-score residuals
  );
}

/**
 * Aggregate priced markets across a match's events, drop noise (unless kept),
 * dedup by label, and cap to the most liquid `cap` markets. This is what a
 * match's odds column is built from.
 */
export function matchMarketSnapshots(
  events: PolyEvent[], snapshotAt: string, cap = 16, dropNoise = true,
): MarketSnapshot[] {
  const seen = new Set<string>();
  const rows: (MarketSnapshot & { liq: number })[] = [];
  for (const ev of events) {
    for (const m of ev.markets) {
      if (!m.label) continue;
      if (dropNoise && isNoiseMarket(m.label)) continue;
      for (const side of marketSides(m)) {
        if (side.price == null) continue;
        if (dropNoise && (side.price <= 1 || side.price >= 99)) continue; // effectively-resolved / dead line
        const key = side.label.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ label: side.label, price: side.price, external_ref: side.token, liquidity: m.liquidity, liq: Number(m.liquidity ?? 0) || 0 });
      }
    }
  }
  rows.sort((a, b) => b.liq - a.liq);
  return rows.slice(0, cap).map(({ liq, ...s }) => s);
}

/**
 * The tradeable side(s) of a market. Usually one (the priced first outcome).
 * But a GENERIC 2-way market — two entity outcomes and a title that names
 * neither (e.g. "Team to Advance" with outcomes ["Canada","Morocco"]) — is
 * expanded into BOTH sides, each backed by its own CLOB token, so the second
 * team isn't hidden. Spreads/moneylines already name their side in the title
 * (and Polymarket lists each side separately), so they stay single.
 */
function marketSides(m: PolyMarketRow): { label: string; price: number | null; token: string | null }[] {
  const o = m.outcomes;
  if (o.length === 2 && o[0] && o[1] && m.prices[0] != null && m.prices[1] != null) {
    const l = m.label.toLowerCase();
    // If the label already NAMES one outcome it's a pre-split side (spread
    // "Morocco (-1.5)", moneyline "Portugal") — Polymarket lists the opposite
    // separately, so keep it single. Otherwise a 2-way market (Over/Under,
    // Yes/No, "Team to Advance") is TWO tradeable bets → surface BOTH sides,
    // each with its own CLOB token/price.
    const namesOutcome = l.includes(o[0].toLowerCase()) || l.includes(o[1].toLowerCase());
    // A label that EXPLICITLY names a direction/handicap ("Over 2.5", "Morocco
    // (-1.5)") is already one side — its opposite is a separate market — so keep
    // it single. An "O/U 2.5" label (side lives only in the outcomes) expands.
    const directionalLabel = /\bover\b|\bunder\b|[+-]\s*\d/i.test(m.label);
    if (!namesOutcome && !directionalLabel) return [0, 1].map((i) => ({ label: sideLabel(m.label, o[i], o[1 - i]), price: m.prices[i]!, token: m.tokenIds[i] ?? null }));
  }
  return [{ label: clarifyLabel(m.label, o), price: m.priceCents, token: m.tokenIds[0] ?? null }];
}

/** Clear label for ONE side of a 2-way market. Over/Under bakes the side into
 *  the label ("O/U 2.5" → "Over 2.5" / "Under 2.5"); Yes/No and entity outcomes
 *  append the side ("Both Teams to Score — Yes", "Team to Advance — Paraguay"). */
function sideLabel(label: string, outcome: string, other: string): string {
  const s = outcome.toLowerCase().trim();
  if (/^(over|under)/.test(s)) return clarifyLabel(label, [outcome, other]);
  return `${label} — ${s === "yes" ? "Yes" : s === "no" ? "No" : outcome}`;
}

/**
 * Make a totals market state WHICH side the shown price (outcomes[0]) is for.
 * Polymarket's priceCents is always the price of the first outcome. A title like
 * "O/U 3.5" doesn't say over or under, so we resolve it to the priced side
 * ("Over 3.5"), preserving any context ("Total Sets: O/U 2.5" → "…: Over 2.5").
 * Spread/winner/Yes-No titles already name their side and are left untouched.
 */
export function clarifyLabel(label: string, outcomes: string[]): string {
  const raw = outcomes[0] ?? "";
  const s = raw.toLowerCase();
  // Totals: resolve "O/U 3.5" to the priced side ("Over 3.5").
  if (s.startsWith("over") || s.startsWith("under")) {
    if (/\bover\b|\bunder\b/i.test(label)) return label;            // already explicit
    const word = s.startsWith("over") ? "Over" : "Under";
    if (/o\/u/i.test(label)) return label.replace(/o\/u/i, word);   // keep context
    const line = (label.match(/\d+(?:\.\d+)?/) || [])[0];
    return line ? `${word} ${line}` : `${word} — ${label}`;
  }
  // Yes/No markets (Draw, BTTS, penalties…) read fine as-is.
  if (s === "yes" || s === "no" || !raw) return label;
  // Team/player-named outcome (moneyline, "Team to Advance", spreads): the price
  // is for the FIRST side, so if the label doesn't already name it, append it —
  // "Team to Advance" → "Team to Advance — Canada".
  if (!label.toLowerCase().includes(s)) return `${label} — ${raw}`;
  return label;
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9Ѐ-ӿ ]+/g, " "); // keep latin, digits, cyrillic
}
/** Most distinctive token of a name: the trailing ≥3-char token (surname /
 * club-defining word). "Carlos Alcaraz"→"alcaraz", "Real Madrid"→"madrid". */
// Generic club suffixes that don't identify a team on their own. Picking the
// LAST token blindly made "Manchester United" key on "united" and false-match
// "Newcastle United"; skipping these keys on "manchester" instead. (Mirrors
// engine.ts TEAM_STOPWORDS; kept local to avoid an engine→polymarket cycle.)
// Pure connectors — no identity, ignored entirely ("FC", "AC", "CF"…).
const NAME_CONNECTORS = new Set(["fc", "afc", "sc", "cf", "ac", "as", "cd", "sv", "fk", "if", "bk", "club", "calcio"]);
// Shared qualifiers/suffixes: several clubs share a city or word ("Real"/
// "Atlético" Madrid, Manchester "United"/"City"). These aren't the KEY (they'd
// collide) but they DISAMBIGUATE — required in the title when the name has one.
const NAME_QUALIFIERS = new Set(["united", "city", "town", "county", "sporting", "real", "athletic", "atletico", "racing", "deportivo", "inter"]);
/** Split a team name into its KEY (the identifying surname/city token used for
 *  the primary match) and any shared QUALIFIER tokens that must also agree. */
function nameKeyTokens(name: string): { key: string; qualifiers: string[] } {
  const all = norm(name).split(/\s+/).filter(Boolean);
  const long = all.filter((w) => w.length >= 3);
  const pool = (long.length ? long : all).filter((w) => !NAME_CONNECTORS.has(w));
  const core = pool.filter((w) => !NAME_QUALIFIERS.has(w));
  const pick = core.length ? core : pool;
  return { key: pick.length ? pick[pick.length - 1] : "", qualifiers: pool.filter((w) => NAME_QUALIFIERS.has(w)) };
}
async function withTimeout(
  ms: number,
  fn: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}
const round1 = (n: number) => Math.round(n * 10) / 10;
