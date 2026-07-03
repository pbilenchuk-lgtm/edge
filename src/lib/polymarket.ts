// ============================================================
// EDGE LAB — Polymarket quotes client (ТЗ §5.1)  [SERVER-ONLY]
//
// Reading quotes needs NO API key. Two public APIs:
//   Gamma  (https://gamma-api.polymarket.com)  — market/event metadata;
//          each market carries `clobTokenIds` = the outcome token ids.
//   CLOB   (https://clob.polymarket.com)        — live prices per token:
//          /price?token_id=..&side=buy|sell , /midpoint , /book
//   WS     (wss://ws-subscribe-clob.polymarket.com/ws/market) — realtime.
//
// We call from the SERVER (never the browser): avoids CORS, keeps egress
// controllable, and lets us degrade gracefully. If POLYMARKET_ENABLED is
// off, or the network blocks the host, or a request times out, we return
// the caller-supplied snapshot with source:"snapshot" and stale:true
// (ТЗ §6: "API котировок недоступен: показать последний snapshot").
//
// NOTE: in this sandbox the egress policy blocks Polymarket hosts, so live
// fetching resolves to the fallback path. It works unchanged wherever the
// hosts are reachable.
// ============================================================

export interface PolymarketConfig {
  enabled: boolean;
  gammaBase: string;
  clobBase: string;
  timeoutMs: number;
}

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

export type QuoteSource = "live" | "snapshot" | "disabled" | "error";

export interface Quote {
  tokenId: string;
  /** price in cents 0..100 (== probability * 100), or null if unknown */
  priceCents: number | null;
  source: QuoteSource;
  stale: boolean;
  fetchedAt: string;
  error?: string;
}

interface FetchDeps {
  fetchImpl?: typeof fetch;
  now?: () => string;
}

/**
 * Live midpoint for one CLOB token, in cents. Throws on any failure so the
 * batch wrapper can fall back per-token.
 */
export async function fetchMidpointCents(
  tokenId: string,
  cfg: PolymarketConfig,
  deps: FetchDeps = {},
): Promise<number> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${cfg.clobBase}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`CLOB ${res.status}`);
    const json = (await res.json()) as { mid?: string | number };
    const mid = Number(json.mid);
    if (!isFinite(mid)) throw new Error("CLOB midpoint not numeric");
    return round1(mid * 100); // probability 0..1 -> cents
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get quotes for a set of token ids, each with an optional last-known
 * snapshot in cents. Never throws — every token resolves to a Quote,
 * falling back to its snapshot when live data is unavailable.
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
        const priceCents = await fetchMidpointCents(t.tokenId, cfg, deps);
        return {
          tokenId: t.tokenId,
          priceCents,
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

export interface GammaMarket {
  id: string;
  question: string;
  clobTokenIds: string[];
  outcomes: string[];
}

/**
 * List markets for a Gamma event (used to discover token ids). Returns []
 * on any failure. `clobTokenIds`/`outcomes` come back JSON-encoded from
 * Gamma, so we parse defensively.
 */
export async function listEventMarkets(
  eventId: string,
  cfg: PolymarketConfig,
  deps: FetchDeps = {},
): Promise<GammaMarket[]> {
  if (!cfg.enabled) return [];
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${cfg.gammaBase}/markets?event_id=${encodeURIComponent(eventId)}&closed=false`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const rows = (await res.json()) as any[];
    return rows.map((r) => ({
      id: String(r.id),
      question: String(r.question ?? ""),
      clobTokenIds: parseMaybeJson(r.clobTokenIds),
      outcomes: parseMaybeJson(r.outcomes),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function parseMaybeJson(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
