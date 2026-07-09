// ============================================================
// EDGE LAB — provider snapshot collector  [SERVER-ONLY]
//
// One pass captures, at a COMMON timestamp (batch_at), what every active data
// provider (Sportmonks / TheStatsAPI / StatPal) AND Polymarket return for each
// relevant match — the whole raw JSON + extracted labels — into
// provider_snapshots. Runs on the live tick (in-play) and the slow tick
// (pre-match). Purely additive: never touches money/state, degrades to 0 on any
// provider failure. This is the raw material for the post-match provider
// comparison in the «Анализ» tab.
// ============================================================

import "./http.js";
import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { loadPolymarketConfig, fetchMidpointCents, type PolymarketConfig } from "./polymarket.js";
import { loadProvidersConfig, activeProviders, fetchProvider, type MatchRef } from "./providers.js";
import { hoursUntil } from "./time.js";
import type { Match } from "./types.js";

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());
const round1 = (n: number) => Math.round(n * 10) / 10;

// Only snapshot matches worth the API calls: live/lineup now, or kicking off
// within this window. Keeps the Polymarket discovery flood out of the collector.
const PRE_WINDOW_HOURS = 12;
// Cap matches touched per pass so a busy slate can't fan out into hundreds of calls.
const MAX_MATCHES = 12;

interface Active { comp: string; sport: string; match: Match }
function relevantMatches(db: Database, nowMs: number): Active[] {
  const out: Active[] = [];
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "football") continue; // the snapshot providers are football-only
    for (const m of R.listMatches(db, c.id)) {
      if (m.state === "finished") continue;
      const h = hoursUntil(m.kickoff_at, nowMs);
      const near = h == null ? false : h <= PRE_WINDOW_HOURS;
      if (m.state === "live" || m.state === "lineup" || m.lineup_out || near) out.push({ comp: c.id, sport: c.sport_id, match: m });
    }
  }
  // Prefer live, then soonest kickoff; bound the count.
  out.sort((a, b) => {
    const la = a.match.state === "live" ? 0 : 1, lb = b.match.state === "live" ? 0 : 1;
    if (la !== lb) return la - lb;
    return (Date.parse(a.match.kickoff_at ?? "") || Infinity) - (Date.parse(b.match.kickoff_at ?? "") || Infinity);
  });
  // No silent cap: if more matches qualify than we snapshot this pass, say so.
  if (out.length > MAX_MATCHES) console.warn(`[snapshots] ${out.length} relevant matches; capturing top ${MAX_MATCHES} (live-first). ${out.length - MAX_MATCHES} skipped this pass.`);
  return out.slice(0, MAX_MATCHES);
}

function phaseFor(state: string): "pre" | "live" | "post" {
  if (state === "live") return "live";
  if (state === "finished") return "post";
  return "pre";
}

/** CLOB best price for a token side (buy=ask, sell=bid), in cents. Null on failure. */
async function pmSideCents(cfg: PolymarketConfig, token: string, side: "buy" | "sell", deps: EngineDeps): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const doFetch = deps.fetchImpl ?? fetch;
    const url = `${cfg.clobBase}/price?token_id=${encodeURIComponent(token)}&side=${side}`;
    const res = await doFetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as { price?: string | number };
    const n = Number(j.price);
    return isFinite(n) ? round1(n * 100) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Polymarket price/spread/midpoint per market of a match, at the batch timestamp. */
async function polymarketSnapshot(db: Database, m: Match, cfg: PolymarketConfig, deps: EngineDeps): Promise<unknown | null> {
  const markets = R.latestMarkets(db, m.id).filter((mk) => mk.external_ref);
  if (!markets.length) return null;
  const rows = await Promise.all(markets.map(async (mk) => {
    const token = mk.external_ref as string;
    const [mid, bid, ask] = await Promise.all([
      fetchMidpointCents(token, cfg, { fetchImpl: deps.fetchImpl }).catch(() => null),
      pmSideCents(cfg, token, "sell", deps),
      pmSideCents(cfg, token, "buy", deps),
    ]);
    const spread = bid != null && ask != null ? round1(ask - bid) : null;
    return { label: mk.label, token, midCents: mid, bidCents: bid, askCents: ask, spreadCents: spread, storedPriceCents: mk.price, aiProb: mk.ai_prob };
  }));
  return { markets: rows };
}

/**
 * Collect one snapshot batch. Returns the number of snapshot rows written.
 * No-op (returns 0) when nothing is configured (no provider keys + Polymarket off).
 */
export async function collectSnapshots(db: Database, deps: EngineDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const pcfg = loadProvidersConfig(env);
  const poly = deps.polymarket ?? loadPolymarketConfig(env);
  const provs = activeProviders(pcfg);
  if (!provs.length && !poly.enabled) return 0;

  const batchAt = nowFn(deps)();
  const nowMs = Date.parse(batchAt) || Date.now();
  const matches = relevantMatches(db, nowMs);
  let written = 0;

  for (const { match: m } of matches) {
    const phase = phaseFor(m.state);
    const mref: MatchRef = { home: m.home, away: m.away, kickoffIso: m.kickoff_at ?? m.kickoff_time ?? null };

    // --- one row per sports provider (raw + extracted) ---
    for (const p of provs) {
      const cached = R.getProviderRef(db, m.id, p);
      let r;
      try {
        r = await fetchProvider(p, pcfg, mref, cached?.provider_ref ?? null, nowMs);
      } catch (e) {
        r = { ok: false, httpStatus: null, providerRef: cached?.provider_ref ?? null, minute: null, raw: null, extracted: null, latencyMs: 0, resolvedRef: cached?.provider_ref ?? null, error: e instanceof Error ? e.message : String(e) };
      }
      // Cache the resolved id (even a null "not found" so we don't research every tick;
      // it refreshes whenever a later pass does resolve it).
      if (!cached || cached.provider_ref !== r.resolvedRef) R.setProviderRef(db, m.id, p, r.resolvedRef);
      R.insertProviderSnapshot(db, {
        match_id: m.id, batch_at: batchAt, provider: p, phase, ok: r.ok, http_status: r.httpStatus,
        provider_ref: r.providerRef, minute: r.minute, latency_ms: r.latencyMs,
        extracted: r.extracted ?? (r.error ? { error: r.error } : null),
        raw: r.raw != null ? JSON.stringify(r.raw) : null,
      });
      written++;
    }

    // --- one row for Polymarket (price/spread/midpoint per market) ---
    if (poly.enabled) {
      let pm: unknown | null = null;
      try { pm = await polymarketSnapshot(db, m, poly, deps); } catch { pm = null; }
      if (pm) {
        R.insertProviderSnapshot(db, {
          match_id: m.id, batch_at: batchAt, provider: "polymarket", phase, ok: true, http_status: null,
          provider_ref: null, minute: m.minute ?? null, latency_ms: null, extracted: pm, raw: JSON.stringify(pm),
        });
        written++;
      }
    }
  }
  return written;
}
