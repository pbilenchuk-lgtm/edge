// ============================================================
// EDGE LAB — ORDER-BOOK DEPTH CAPTURE  [SERVER-ONLY]
//
// Part 2 of capacity: the MODEL curve extrapolates a linear slippage coefficient; a MEASURED curve needs
// the real book. We don't store book levels historically, so this starts capturing them from deploy —
// every day without it is a day of measured capacity we can never get back. Periodic snapshots on live
// in-scope matches (bounded + throttled) catch depth even in SKIP moments — «сколько мы НЕ смогли бы
// налить» IS the capacity. Persists the top-N bid/ask levels so a later report can re-VWAP any size.
//
// Bounded (≤ MAX_TOKENS per run), throttled (every CAPTURE_MIN min), pruned (RETENTION_DAYS), and it
// NEVER throws into the tick — a book fetch failure just skips that token.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { loadPolymarketConfig, type OrderBookFetch } from "./polymarket.js";
import { classifyOrderBook } from "./executor/paperFill.js";
import { bookDepthUsd } from "./execution.js";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const CAPTURE_MIN = (env: Record<string, string | undefined>) => num(env.BOOK_CAPTURE_MIN, 3);          // throttle
const MAX_TOKENS = (env: Record<string, string | undefined>) => num(env.BOOK_CAPTURE_MAX_TOKENS, 24);   // API budget/run
const MARKETS_PER_MATCH = 4, LEVELS = 12, RETENTION_DAYS = 14;
const LAST_KEY = "book_depth_last_ms";

export interface BookTarget { matchId: string; token: string; label: string }

/** Pure: which (match, token) books to snapshot — live matches, top markets by declared liquidity,
 *  bounded. Testable without the network. */
export function bookDepthTargets(db: Database, maxTokens: number, marketsPerMatch = MARKETS_PER_MATCH): BookTarget[] {
  const out: BookTarget[] = [];
  const live = R.listCompetitions(db).flatMap((c) => R.listMatches(db, c.id).filter((m) => m.state === "live"));
  for (const m of live) {
    const mkts = R.latestMarkets(db, m.id)
      .filter((k) => k.external_ref)
      .sort((a, b) => Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0))
      .slice(0, marketsPerMatch);
    for (const k of mkts) { out.push({ matchId: m.id, token: k.external_ref as string, label: k.label }); if (out.length >= maxTokens) return out; }
  }
  return out;
}

/** Persist one book's top-N levels + depth. Exposed so the on-fill path can reuse it (source='fill'). */
export function saveBookDepth(db: Database, t: BookTarget, book: { bids: { priceCents: number; size: number }[]; asks: { priceCents: number; size: number }[] }, source: string, nowIso: string): void {
  const asks = book.asks.slice(0, LEVELS), bids = book.bids.slice(0, LEVELS);
  db.prepare(
    `INSERT INTO book_depth_snapshots (id, match_id, token_id, label, source, best_bid_cents, best_ask_cents, bid_depth_usd, ask_depth_usd, bids_json, asks_json, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(R.uid(), t.matchId, t.token, t.label, source,
    bids[0]?.priceCents ?? null, asks[0]?.priceCents ?? null,
    Math.round(bookDepthUsd(book.bids)), Math.round(bookDepthUsd(book.asks)),
    JSON.stringify(bids.map((l) => [l.priceCents, l.size])), JSON.stringify(asks.map((l) => [l.priceCents, l.size])), nowIso);
}

export async function captureBookDepth(db: Database, deps: EngineDeps = {}, nowMs = Date.now()): Promise<number> {
  const env = deps.env ?? process.env;
  const poly = deps.polymarket ?? loadPolymarketConfig(env);
  if (!poly.enabled) return 0;                                  // no live book source → nothing to capture
  const last = Number(R.metaGet(db, LAST_KEY) ?? 0);
  if (nowMs - last < CAPTURE_MIN(env) * 60_000) return 0;       // throttle
  R.metaSet(db, LAST_KEY, String(nowMs), new Date(nowMs).toISOString());

  const targets = bookDepthTargets(db, MAX_TOKENS(env));
  const bookCache = new Map<string, OrderBookFetch>();
  const nowIso = new Date(nowMs).toISOString();
  let saved = 0;
  for (const t of targets) {
    try {
      const res = await classifyOrderBook(t.token, poly, deps, bookCache);
      if (res.status !== "ok") continue;
      saveBookDepth(db, t, res.book, "periodic", nowIso);
      saved++;
    } catch { /* a book fetch must never break the tick */ }
  }
  try { db.prepare(`DELETE FROM book_depth_snapshots WHERE at < ?`).run(new Date(nowMs - RETENTION_DAYS * 86400_000).toISOString()); } catch { /* ignore */ }
  return saved;
}
