// ============================================================
// EDGE LAB — Betfair Exchange price source  [SERVER-ONLY, runs on a NON-US host]
//
// WHY separate: the Betfair Exchange API geo-blocks US IPs
// (BETTING_RESTRICTED_LOCATION). Our main app egresses through a US proxy, so
// this module is NOT imported by the Next app — it runs from `scripts/
// betfair-collect.ts` on a Betfair-allowed host (EU/UA/UK) and POSTs snapshots
// back to the main app's /api ingest endpoint.
//
// Maps the exchange back/lay book onto our price model, exactly like Polymarket:
//   implied probability (cents) = 100 / decimal_odds
//   best BACK  → the ask side ; best LAY → the bid side ; mid = their average
//   totalMatched (£) → liquidity (real traded volume)
// Nothing here trades — read-only market data for paper-trading simulation.
// ============================================================

import { Agent, setGlobalDispatcher } from "undici";

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface BetfairConfig {
  appKey: string;
  /** Pre-obtained session token (skip login) — or use certLogin() to get one. */
  session?: string;
  /** cert-login credentials (non-interactive bot login). */
  username?: string;
  password?: string;
  certPem?: string; // client certificate (PEM)
  keyPem?: string;  // client private key (PEM)
  base: string;         // betting REST base
  certLoginUrl: string; // identity cert-login endpoint
  keepAliveUrl: string;
  timeoutMs: number;
}

export function loadBetfairConfig(env: Record<string, string | undefined> = process.env): BetfairConfig {
  return {
    appKey: env.BETFAIR_APP_KEY ?? "",
    session: env.BETFAIR_SESSION || undefined,
    username: env.BETFAIR_USERNAME || undefined,
    password: env.BETFAIR_PASSWORD || undefined,
    certPem: env.BETFAIR_CERT_PEM || undefined,
    keyPem: env.BETFAIR_KEY_PEM || undefined,
    base: env.BETFAIR_BASE ?? "https://api.betfair.com/exchange/betting/rest/v1.0",
    certLoginUrl: env.BETFAIR_CERTLOGIN_URL ?? "https://identitysso-cert.betfair.com/api/certlogin",
    keepAliveUrl: env.BETFAIR_KEEPALIVE_URL ?? "https://identitysso.betfair.com/api/keepAlive",
    timeoutMs: Number(env.BETFAIR_TIMEOUT_MS ?? 10000),
  };
}

// ---- pure mapping (unit-tested; no network) --------------------------------

export interface RunnerPrice {
  selectionId: number;
  runnerName: string;
  status: string;              // ACTIVE | WINNER | LOSER | REMOVED
  backCents: number | null;    // implied prob of the best BACK price
  layCents: number | null;     // implied prob of the best LAY price
  midCents: number | null;
  spreadCents: number | null;  // lay - back (in cents)
  lastTradedCents: number | null;
  matchedVolume: number | null; // £ matched on this runner
}
export interface MarketPrices {
  marketId: string;
  marketName: string;          // "Match Odds", "Over/Under 2.5 Goals", …
  inPlay: boolean;
  totalMatched: number | null; // £ matched on the whole market
  runners: RunnerPrice[];
}

/** decimal odds → implied probability in cents (0..100). 2.0 → 50, 1.5 → 66.7. */
export function oddsToCents(decimalOdds: number | null | undefined): number | null {
  const o = Number(decimalOdds);
  return isFinite(o) && o > 0 ? round1(100 / o) : null;
}

/** Parse one listMarketBook `market` + its catalogue names into our shape. */
export function parseMarketBook(book: any, names: { name: string; runners: Record<number, string> }): MarketPrices {
  const runners: RunnerPrice[] = (book.runners ?? []).map((r: any): RunnerPrice => {
    const backOdds = r.ex?.availableToBack?.[0]?.price ?? null;
    const layOdds = r.ex?.availableToLay?.[0]?.price ?? null;
    const back = oddsToCents(backOdds), lay = oddsToCents(layOdds);
    const mid = back != null && lay != null ? round1((back + lay) / 2) : (back ?? lay);
    // spread in cents: lay implied prob - back implied prob (back odds < lay odds
    // ⇒ back cents > lay cents, so this is back - lay to stay positive). Use abs.
    const spread = back != null && lay != null ? round1(Math.abs(back - lay)) : null;
    return {
      selectionId: r.selectionId,
      runnerName: names.runners[r.selectionId] ?? String(r.selectionId),
      status: r.status ?? "",
      backCents: back, layCents: lay, midCents: mid, spreadCents: spread,
      lastTradedCents: oddsToCents(r.lastPriceTraded),
      matchedVolume: r.totalMatched != null ? Number(r.totalMatched) : null,
    };
  });
  return {
    marketId: book.marketId,
    marketName: names.name,
    inPlay: !!book.inplay,
    totalMatched: book.totalMatched != null ? Number(book.totalMatched) : null,
    runners,
  };
}

/** Snapshot `extracted` payload for a match — mirrors the Polymarket snapshot
 *  shape (a price source), so the Анализ tab renders it the same way. */
export function toExtracted(markets: MarketPrices[]): unknown {
  return {
    source: "betfair-exchange",
    markets: markets.flatMap((m) => m.runners.map((r) => ({
      market: m.marketName, selection: r.runnerName, inPlay: m.inPlay,
      midCents: r.midCents, backCents: r.backCents, layCents: r.layCents,
      spreadCents: r.spreadCents, lastTradedCents: r.lastTradedCents,
      matchedVolume: r.matchedVolume, marketMatched: m.totalMatched,
    }))),
  };
}

// ---- HTTP client (runs on the EU/UA host) ----------------------------------

/** Install a global undici dispatcher carrying the client cert for cert-login.
 *  Call once before certLogin when using PEM credentials. */
export function installCertDispatcher(cfg: BetfairConfig): void {
  if (!cfg.certPem || !cfg.keyPem) return;
  setGlobalDispatcher(new Agent({ connect: { cert: cfg.certPem, key: cfg.keyPem } }));
}

/** Non-interactive cert login → session token. Throws on failure. */
export async function certLogin(cfg: BetfairConfig): Promise<string> {
  if (!cfg.username || !cfg.password) throw new Error("BETFAIR_USERNAME/PASSWORD required for certLogin");
  installCertDispatcher(cfg);
  const res = await fetch(cfg.certLoginUrl, {
    method: "POST",
    headers: { "X-Application": cfg.appKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: `username=${encodeURIComponent(cfg.username)}&password=${encodeURIComponent(cfg.password)}`,
  });
  const j = (await res.json()) as { loginStatus?: string; sessionToken?: string };
  if (j.loginStatus !== "SUCCESS" || !j.sessionToken) throw new Error(`Betfair login failed: ${j.loginStatus ?? res.status}`);
  return j.sessionToken;
}

async function rpc<T>(cfg: BetfairConfig, session: string, method: string, params: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.base}/${method}/`, {
      method: "POST", signal: ctrl.signal,
      headers: { "X-Application": cfg.appKey, "X-Authentication": session, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`Betfair ${method} HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const SOCCER = "1"; // Betfair eventTypeId for Soccer
// Market types we mirror (1X2 + goal lines). Extend as needed.
const MARKET_TYPES = ["MATCH_ODDS", "OVER_UNDER_25", "OVER_UNDER_15", "OVER_UNDER_35", "BOTH_TEAMS_TO_SCORE", "CORRECT_SCORE"];

/** Find the soccer event for a match by team names within a kickoff window. */
export async function resolveEvent(cfg: BetfairConfig, session: string, home: string, away: string, kickoffIso: string | null): Promise<string | null> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const from = kickoffIso ? new Date(Date.parse(kickoffIso) - 12 * 3600_000).toISOString() : undefined;
  const to = kickoffIso ? new Date(Date.parse(kickoffIso) + 12 * 3600_000).toISOString() : undefined;
  const events = await rpc<any[]>(cfg, session, "listEvents", {
    filter: { eventTypeIds: [SOCCER], ...(from && to ? { marketStartTime: { from, to } } : {}) },
  });
  const h = norm(home), a = norm(away);
  const hit = (name: string) => { const n = norm(name); return n.includes(h) && n.includes(a); };
  const ev = (events ?? []).find((e: any) => hit(e.event?.name ?? ""));
  return ev?.event?.id ?? null;
}

/** Full price snapshot for one resolved event: catalogue → book → mapped prices. */
export async function marketPricesForEvent(cfg: BetfairConfig, session: string, eventId: string): Promise<MarketPrices[]> {
  const cat = await rpc<any[]>(cfg, session, "listMarketCatalogue", {
    filter: { eventIds: [eventId], marketTypeCodes: MARKET_TYPES },
    marketProjection: ["RUNNER_DESCRIPTION", "MARKET_START_TIME"],
    maxResults: 25,
  });
  if (!cat?.length) return [];
  const names = new Map<string, { name: string; runners: Record<number, string> }>();
  for (const m of cat) {
    const runners: Record<number, string> = {};
    for (const r of m.runners ?? []) runners[r.selectionId] = r.runnerName;
    names.set(m.marketId, { name: m.marketName ?? m.description?.marketType ?? m.marketId, runners });
  }
  const marketIds = cat.map((m: any) => m.marketId);
  // EX_BEST_OFFERS = best back/lay; add EX_TRADED for lastPriceTraded/volume.
  const books = await rpc<any[]>(cfg, session, "listMarketBook", {
    marketIds,
    priceProjection: { priceData: ["EX_BEST_OFFERS", "EX_TRADED"] },
  });
  return (books ?? []).map((b: any) => parseMarketBook(b, names.get(b.marketId) ?? { name: b.marketId, runners: {} }));
}

export async function keepAlive(cfg: BetfairConfig, session: string): Promise<boolean> {
  try {
    const res = await fetch(cfg.keepAliveUrl, { headers: { "X-Application": cfg.appKey, "X-Authentication": session, Accept: "application/json" } });
    const j = (await res.json()) as { status?: string };
    return j.status === "SUCCESS";
  } catch { return false; }
}
