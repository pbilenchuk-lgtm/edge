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
}

/** ТЗ sport id -> Polymarket Gamma tag id. */
export const SPORT_TAG_IDS: Record<string, number> = {
  football: 100350, // soccer (NOT tag 10 = American football)
  tennis: 864,
};

export function loadPolymarketConfig(
  env: Record<string, string | undefined> = process.env,
): PolymarketConfig {
  return {
    enabled: (env.POLYMARKET_ENABLED ?? "false").toLowerCase() === "true",
    gammaBase: env.POLYMARKET_GAMMA_BASE ?? "https://gamma-api.polymarket.com",
    clobBase: env.POLYMARKET_CLOB_BASE ?? "https://clob.polymarket.com",
    timeoutMs: Number(env.POLYMARKET_TIMEOUT_MS ?? 6000),
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

export function normalizeEvent(raw: any): PolyEvent {
  const markets: PolyMarketRow[] = (raw.markets ?? []).map((m: any): PolyMarketRow => {
    const outcomes = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcomePrices);
    const tokenIds = parseJsonArray(m.clobTokenIds);
    const first = prices.length ? Number(prices[0]) : NaN;
    return {
      label: m.groupItemTitle || m.question || "",
      outcomes,
      priceCents: isFinite(first) ? round1(first * 100) : null,
      tokenIds,
      liquidity: m.liquidity != null ? String(m.liquidity) : null,
      conditionId: m.conditionId ?? null,
    };
  });
  return {
    id: String(raw.id ?? ""),
    slug: String(raw.slug ?? ""),
    title: String(raw.title ?? ""),
    startDate: raw.startDate ?? null,
    markets,
  };
}

async function gammaEvents(
  cfg: PolymarketConfig,
  qs: string,
  deps: FetchDeps,
): Promise<PolyEvent[]> {
  if (!cfg.enabled) return [];
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await withTimeout(cfg.timeoutMs, (signal) =>
      doFetch(`${cfg.gammaBase}/events?${qs}`, { signal }),
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as any[];
    return Array.isArray(rows) ? rows.map(normalizeEvent) : [];
  } catch {
    return [];
  }
}

/** Near-term events for a sport (newest first). Empty on failure/disabled. */
export async function listSportEvents(
  cfg: PolymarketConfig,
  sport: string,
  limit = 40,
  deps: FetchDeps = {},
): Promise<PolyEvent[]> {
  const tag = SPORT_TAG_IDS[sport];
  if (tag == null) return [];
  return gammaEvents(
    cfg,
    `tag_id=${tag}&closed=false&limit=${limit}&order=startDate&ascending=false`,
    deps,
  );
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
  const tag = SPORT_TAG_IDS[q.sport];
  if (tag == null) return null;
  const limit = q.limit ?? 60;
  const events = await gammaEvents(
    cfg,
    `tag_id=${tag}&closed=false&limit=${limit}&order=startDate&ascending=false`,
    deps,
  );
  let best: { ev: PolyEvent; score: number } | null = null;
  for (const ev of events) {
    const score = titleMatchScore(ev.title, q.home, q.away);
    if (score >= 2 && (!best || score > best.score)) best = { ev, score };
  }
  return best?.ev ?? null;
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
  const key = nameKey(name);
  return key.length >= 3 && titleWords.has(key);
}

/**
 * Map a discovered event's markets to EDGE LAB market snapshots (ready for
 * the `markets` table): label, price in cents, the backing CLOB token as
 * external_ref, and liquidity. Markets without a usable price are skipped.
 */
export function eventToMarketSnapshots(
  event: PolyEvent,
  snapshotAt: string,
): Array<{ label: string; price: number; external_ref: string | null; liquidity: string | null }> {
  return event.markets
    .filter((m) => m.priceCents != null && m.label)
    .map((m) => ({
      label: m.label,
      price: m.priceCents as number,
      external_ref: m.tokenIds[0] ?? null,
      liquidity: m.liquidity,
    }));
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
function nameKey(name: string): string {
  const toks = norm(name).split(/\s+/).filter((w) => w.length >= 3);
  return toks.length ? toks[toks.length - 1] : "";
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
