// ============================================================
// EDGE LAB — match lifecycle & trigger engine (ТЗ §3.3)  [SERVER-ONLY]
//
// Consumes sports-provider status to:
//   - transition match state (upcoming → live → finished)
//   - fire reassessment triggers (goal / price_move) — rate-limited (§9.7)
//   - refresh Polymarket odds as versioned snapshots + mark-to-market (§2.10)
//   - on finish: snapshot closing prices, settle open bets (§3.4),
//     recompute quality metrics (§2.14)
// Reassessment narratives come from the LLM with a heuristic fallback, so
// triggers work with or without API keys.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Bet, Match } from "./types.js";
import type { SportsMatchStatus } from "./sports.js";
import { reassessNarrative, effectiveEnv } from "./llm.js";
import { settleBet, resolveFootballMarket } from "./settlement.js";
import { computeMetrics, type MetricSample } from "./metrics.js";
import { loadPolymarketConfig, getQuotes, findMatchEvents, matchMarketSnapshots, discoverSportMatches, type PolymarketConfig } from "./polymarket.js";
import type { SportsProvider } from "./sports.js";

export interface EngineConfig {
  reassessGapMinutes: number; // §9.7 rate limit
  priceMoveThreshold: number; // cents move that triggers a reassessment
}
export function loadEngineConfig(env: Record<string, string | undefined> = process.env): EngineConfig {
  return {
    reassessGapMinutes: Number(env.REASSESS_GAP_MIN ?? 5),
    priceMoveThreshold: Number(env.PRICE_MOVE_THRESHOLD ?? 5),
  };
}

export interface EngineDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => string;
  polymarket?: PolymarketConfig;
  config?: EngineConfig;
}

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());

// ------------------------------------------------------------
// Reassessment triggers (rate-limited)
// ------------------------------------------------------------

/** §9.7: at most one reassessment per strategy per N match-minutes. */
export function canReassess(
  db: Database, matchId: string, strategyId: string, minute: number | null, gapMinutes: number,
): boolean {
  const prior = R.reassessmentsForMatch(db, matchId).filter((r) => r.strategy_id === strategyId);
  if (!prior.length || minute == null) return true;
  // Compare against the last reassessment that HAS a parseable match-minute;
  // skip null-minute ones (e.g. manual triggers) so they don't reset the gap.
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = parseInt(String(prior[i].minute ?? ""), 10);
    if (!isNaN(m)) return Math.abs(minute - m) >= gapMinutes;
  }
  return true;
}

export interface ReassessResult { strategyId: string; created: boolean; reason?: string; source?: string; }

export async function triggerReassessment(
  db: Database,
  args: { match: Match; strategyId: string; trigger: "goal" | "red_card" | "price_move" | "time" | "manual"; minute: number | null },
  deps: EngineDeps = {},
): Promise<ReassessResult> {
  const cfg = deps.config ?? loadEngineConfig(deps.env);
  const { match, strategyId, trigger, minute } = args;
  if (trigger !== "manual" && !canReassess(db, match.id, strategyId, minute, cfg.reassessGapMinutes)) {
    return { strategyId, created: false, reason: "rate-limited (§9.7)" };
  }
  const strat = R.getStrategy(db, strategyId);
  if (!strat) return { strategyId, created: false, reason: "strategy not found" };

  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  const narr = await reassessNarrative(
    {
      match: `${match.home}–${match.away}`, minute, trigger,
      scoreHome: match.score_home, scoreAway: match.score_away,
      strategyName: strat.name, strategyPrompt: strat.prompt,
    },
    strat.model,
    { fetchImpl: deps.fetchImpl, env },
  );

  R.insertReassessment(db, {
    id: R.uid(), match_id: match.id, strategy_id: strategyId,
    minute: minute != null ? `${minute}'` : null, body: narr.body,
    confidence: narr.confidence, trigger, created_at: nowFn(deps)(),
  });
  return { strategyId, created: true, source: narr.source };
}

/** Strategies that currently hold an open bet on a match. */
function strategiesWithOpenBets(db: Database, matchId: string): string[] {
  const ids = new Set<string>();
  for (const b of R.betsForMatch(db, matchId)) if (b.status === "open") ids.add(b.strategy_id);
  return [...ids];
}

// ------------------------------------------------------------
// Odds refresh (versioned snapshots + mark-to-market + price_move trigger)
// ------------------------------------------------------------

export async function refreshMatchOdds(
  db: Database, matchId: string, deps: EngineDeps = {},
): Promise<{ updated: number; triggers: ReassessResult[] }> {
  const match = R.getMatch(db, matchId);
  if (!match) return { updated: 0, triggers: [] };
  const cfg = deps.config ?? loadEngineConfig(deps.env);
  const poly = deps.polymarket ?? loadPolymarketConfig(deps.env);
  const now = nowFn(deps)();
  const markets = R.latestMarkets(db, matchId);
  const tokens = markets.filter((m) => m.external_ref).map((m) => ({ tokenId: m.external_ref as string, snapshotCents: m.price }));
  const quotes = await getQuotes(tokens, poly, { fetchImpl: deps.fetchImpl, now: () => now });
  const byTok: Record<string, number | null> = {};
  for (const q of quotes) byTok[q.tokenId] = q.priceCents;

  let updated = 0;
  const triggers: ReassessResult[] = [];
  for (const m of markets) {
    if (!m.external_ref) continue;
    const price = byTok[m.external_ref];
    if (price == null || price === m.price) continue;
    updated++;
    // new versioned snapshot (§2.10)
    R.insertMarket(db, {
      id: R.uid(), match_id: matchId, label: m.label, price, ai_prob: m.ai_prob,
      liquidity: m.liquidity, external_ref: m.external_ref, snapshot_at: now, is_closing: false,
    });
    // mark-to-market open bets on this market
    for (const b of R.betsForMatch(db, matchId)) {
      if (b.status === "open" && b.market_label === m.label) R.updateBet(db, b.id, { current_price: price });
    }
    // price_move reassessment trigger
    if (Math.abs(price - m.price) >= cfg.priceMoveThreshold) {
      for (const sid of strategiesWithOpenBets(db, matchId)) {
        if (R.betsForMatch(db, matchId, sid).some((b) => b.status === "open" && b.market_label === m.label)) {
          triggers.push(await triggerReassessment(db, { match, strategyId: sid, trigger: "price_move", minute: match.minute }, deps));
        }
      }
    }
  }
  return { updated, triggers };
}

// ------------------------------------------------------------
// Refresh odds across all active matches (scheduler/cron path)
// ------------------------------------------------------------

export interface OddsRefreshItem { matchId: string; match: string; updated: number; reassessments: number; }

/**
 * Re-quote every non-finished match that has Polymarket-backed markets. This is
 * the LLM-free half of the cron (no match ANALYSIS is triggered): only the live
 * engine's own price_move reassessments can fire — rate-limited (§9.7), only for
 * strategies already holding an open bet, and with a heuristic fallback, exactly
 * as the manual per-match refresh button behaves.
 */
export async function refreshActiveOdds(db: Database, deps: EngineDeps = {}, opts: { onlyLive?: boolean } = {}): Promise<OddsRefreshItem[]> {
  const out: OddsRefreshItem[] = [];
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      if (m.state === "finished") continue;
      // fast live loop: only re-price matches in play (or with lineups out)
      if (opts.onlyLive && !(m.state === "live" || m.state === "lineup" || m.lineup_out)) continue;
      if (!R.latestMarkets(db, m.id).some((mk) => mk.external_ref)) continue;
      const r = await refreshMatchOdds(db, m.id, deps);
      if (r.updated || r.triggers.length) {
        out.push({ matchId: m.id, match: `${m.home}–${m.away}`, updated: r.updated, reassessments: r.triggers.filter((t) => t.created).length });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------
// Settlement + metrics (on finish)
// ------------------------------------------------------------

export function recomputeMetrics(db: Database, strategyId: string, deps: EngineDeps = {}): void {
  // Only bets settled by the REAL match outcome measure prediction quality.
  // Early/partial cash-outs are booked by P&L sign and would bias Brier/CLV.
  const bets = R.settledBetsForStrategy(db, strategyId).filter((b) => b.settled_by == null);
  const samples: MetricSample[] = bets.map((b) => ({
    aiProb: b.ai_prob ?? 0, outcome: (b.result === "won" ? 1 : 0) as 0 | 1,
    entryPrice: b.entry_price ?? 0, closingPrice: b.closing_price,
  }));
  const m = computeMetrics(samples);
  R.upsertQuality(db, {
    strategy_id: strategyId, samples: m.samples, brier: m.brier, clv: m.clv,
    calibration: m.calibration, updated_at: nowFn(deps)(),
  });
}

export function settleMatch(
  db: Database, match: Match, deps: EngineDeps = {},
  overrides: Record<string, boolean> = {},
): { settled: number; skipped: number; affectedStrategies: string[] } {
  const now = nowFn(deps)();
  // CLV closing line: the KICKOFF price (when pre-match betting closed) is the
  // real benchmark — the finish-time market price is post-resolution (~0/100)
  // and would make CLV just P&L again. Fall back to the last price if no kickoff.
  const kickoff = R.openOddsFor(db, match.id);
  const closingByLabel: Record<string, number> = {};
  for (const m of R.latestMarkets(db, match.id)) if (!(m.label in closingByLabel)) closingByLabel[m.label] = m.price;

  let settled = 0, skipped = 0;
  const affected = new Set<string>();
  for (const b of R.betsForMatch(db, match.id)) {
    if (b.status !== "open") continue;
    const won = resolveOutcome(b, match, overrides);
    if (won == null) { skipped++; continue; } // needs external result (e.g. Advance)
    const closing = kickoff[b.market_label] ?? closingByLabel[b.market_label] ?? b.current_price ?? b.entry_price ?? null;
    const patch = settleBet({ entry_price: b.entry_price, stake: b.stake }, won, closing);
    R.updateBet(db, b.id, { status: patch.status, result: patch.result, payout: patch.payout, closing_price: patch.closing_price });
    R.insertTradeLog(db, {
      id: R.uid(), match_id: match.id, strategy_id: b.strategy_id, minute: "финал",
      type: "settle", text: `${b.market_label}: ${won ? "выигрыш" : "проигрыш"} → ${fmt(patch.payout)} (P&L ${fmt(patch.pnl)})`,
      created_at: now,
    });
    settled++; affected.add(b.strategy_id);
  }
  for (const sid of affected) recomputeMetrics(db, sid, deps);
  return { settled, skipped, affectedStrategies: [...affected] };
}

function resolveOutcome(bet: Bet, match: Match, overrides: Record<string, boolean>): boolean | null {
  if (bet.market_label in overrides) return overrides[bet.market_label];
  if (match.score_home == null || match.score_away == null) return null;
  return resolveFootballMarket(bet.market_label, match.score_home, match.score_away, { home: match.home, away: match.away });
}

// ------------------------------------------------------------
// Sync one match from a provider status
// ------------------------------------------------------------

export interface SyncResult {
  matchId: string; from: string; to: string;
  goals: number; reassessments: ReassessResult[];
  settlement?: { settled: number; skipped: number };
}

export async function syncMatchStatus(
  db: Database, status: SportsMatchStatus, deps: EngineDeps = {},
  settlementOverrides: Record<string, boolean> = {},
): Promise<SyncResult | null> {
  const match = R.matchByExternalRef(db, status.externalRef);
  if (!match) return null;

  const prevTotal = (match.score_home ?? 0) + (match.score_away ?? 0);
  const newTotal = (status.scoreHome ?? 0) + (status.scoreAway ?? 0);
  const from = match.state;

  const patch: Partial<Match> = {
    state: status.state, minute: status.minute, clock: status.clock ?? null,
    score_home: status.scoreHome, score_away: status.scoreAway,
  };
  if (status.state === "finished") {
    patch.final_score = `${status.scoreHome ?? 0}:${status.scoreAway ?? 0}`;
  }
  R.updateMatch(db, match.id, patch);
  const updated = { ...match, ...patch } as Match;

  const reassessments: ReassessResult[] = [];
  let goals = 0;

  // goal trigger (score increased while live). prevTotal already coalesces a
  // null prior score to 0, so an upcoming→live first goal is caught too; fresh
  // imports don't double-count because upsertImportedMatch has already set the
  // score before this runs (prevTotal == newTotal there).
  if ((status.state === "live" || status.state === "finished") && newTotal > prevTotal) {
    goals = newTotal - prevTotal;
    for (const sid of strategiesWithOpenBets(db, match.id)) {
      reassessments.push(await triggerReassessment(db, { match: updated, strategyId: sid, trigger: "goal", minute: status.minute }, deps));
    }
  }

  let settlement;
  if (status.state === "finished" && from !== "finished") {
    settlement = settleMatch(db, updated, deps, settlementOverrides);
  }

  return { matchId: match.id, from, to: status.state, goals, reassessments, settlement };
}

// ------------------------------------------------------------
// Auto-import & categorization: pull a competition's matches from the
// sports provider and file them under that competition (ТЗ иерархия §1).
// ------------------------------------------------------------

/** Find an existing match for the same fixture in a competition (order-insensitive
 *  team match), so different sources (Polymarket "pm:" ref vs ESPN numeric id)
 *  don't create duplicate rows for one game. */
function findTwinMatch(db: Database, competitionId: string, home: string, away: string): Match | undefined {
  return R.listMatches(db, competitionId).find((dm) => sameTeams(dm.home, dm.away, home, away));
}

/** Create the match under a competition if it's new (keyed by external_ref, then
 *  by team names). If a twin exists from another source, merge the ESPN identity
 *  into it (so status sync + settlement work) rather than duplicating the fixture. */
export function upsertImportedMatch(
  db: Database, competitionId: string, status: SportsMatchStatus,
): { match: Match; created: boolean } {
  const existing = R.matchByExternalRef(db, status.externalRef);
  if (existing) return { match: existing, created: false };
  const twin = findTwinMatch(db, competitionId, status.home, status.away);
  if (twin) {
    // adopt the ESPN ref so syncMatchStatus can drive/settle this fixture
    if (twin.external_ref !== status.externalRef) R.updateMatch(db, twin.id, { external_ref: status.externalRef });
    return { match: { ...twin, external_ref: status.externalRef }, created: false };
  }
  const match: Match = {
    id: R.uid(), competition_id: competitionId, home: status.home, away: status.away,
    state: status.state, lineup_out: status.state !== "upcoming", kickoff_at: status.detail ?? null,
    minute: status.minute, score_home: status.scoreHome, score_away: status.scoreAway,
    final_score: status.state === "finished" ? `${status.scoreHome ?? 0}:${status.scoreAway ?? 0}` : null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: status.externalRef,
  };
  R.insertMatch(db, match);
  return { match, created: true };
}

/** Best-effort: attach Polymarket markets to a match that has none. */
export async function linkMatchOdds(
  db: Database, match: Match, sport: string, deps: EngineDeps = {},
): Promise<number> {
  if (R.latestMarkets(db, match.id).length) return 0;
  const poly = deps.polymarket ?? loadPolymarketConfig(deps.env);
  if (!poly.enabled) return 0;
  const events = await findMatchEvents(poly, { sport, home: match.home, away: match.away }, { fetchImpl: deps.fetchImpl });
  if (!events.length) return 0;
  const now = nowFn(deps)();
  // Aggregate the match's settleable markets across its event variants, drop
  // prop/corner/card/halftime noise, cap to the most liquid.
  const snaps = matchMarketSnapshots(events, now, poly.maxMarketsPerMatch);
  for (const s of snaps) {
    R.insertMarket(db, {
      id: R.uid(), match_id: match.id, label: s.label, price: s.price, ai_prob: null,
      liquidity: s.liquidity, external_ref: s.external_ref, snapshot_at: now, is_closing: false,
    });
  }
  return snaps.length;
}

// ------------------------------------------------------------
// Discover matches directly FROM Polymarket (not only ESPN-linked leagues) —
// imports the many matches it lists into a per-sport catch-all competition.
// ------------------------------------------------------------

const PM_COMP_LABEL: Record<string, string> = { football: "Polymarket · Футбол · прочее", tennis: "Polymarket · Теннис · прочее" };

// Localized names + ESPN league (for lineup/event enrichment) for known series.
const SERIES_RU: Record<string, string> = {
  "soccer-fifwc": "ЧМ-2026",
  "soccer-ucl": "Лига чемпионов",
  "soccer-uel": "Лига Европы",
  "soccer-epl": "АПЛ",
  "soccer-laliga": "Ла Лига",
  "soccer-seriea": "Серия A",
  "soccer-bundesliga": "Бундеслига",
  "soccer-ligue1": "Лига 1",
};
const SERIES_ESPN_LEAGUE: Record<string, string> = {
  "soccer-fifwc": "fifa.world",
  "soccer-ucl": "uefa.champions",
  "soccer-uel": "uefa.europa",
  "soccer-epl": "eng.1",
  "soccer-laliga": "esp.1",
  "soccer-seriea": "ita.1",
  "soccer-bundesliga": "ger.1",
  "soccer-ligue1": "fra.1",
};
const slugify = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Ensure the CATEGORY competition a discovered match belongs to (its Polymarket
 * `series`, e.g. "FIFA World Cup" → "ЧМ-2026"). Matches with no series fall back
 * to the per-sport "…· прочее" bucket. Never clobbers an existing comp's budget;
 * backfills the ESPN league so its matches get lineups/events.
 */
function ensureCategoryComp(db: Database, sport: string, series: string | null, seriesSlug: string | null, now: string): string {
  if (!series && !seriesSlug) {
    const id = `pm-${sport}`;
    if (!R.listCompetitions(db).some((c) => c.id === id))
      R.upsertCompetition(db, { id, sport_id: sport, name: PM_COMP_LABEL[sport] ?? `Polymarket · ${sport}`, budget: 0, external_league: null, created_at: now });
    return id;
  }
  const slug = seriesSlug ?? slugify(series!);
  const id = `pm-${slug}`;
  const league = SERIES_ESPN_LEAGUE[slug] ?? null;
  const existing = R.listCompetitions(db).find((c) => c.id === id);
  if (!existing) {
    R.upsertCompetition(db, { id, sport_id: sport, name: SERIES_RU[slug] ?? series ?? slug, budget: 0, external_league: league, created_at: now });
  } else if (league && !existing.external_league) {
    R.setCompetitionLeague(db, id, league); // backfill without touching budget/shares
  }
  return id;
}

export interface DiscoverItem { sport: string; match: string; created: boolean; markets: number }

/**
 * Import the most-liquid matches Polymarket lists for a sport into its catch-all
 * competition, with their settleable odds. Idempotent: existing matches are left
 * alone (markets attached only if they have none). State/lineup come from the
 * event start date — live scores still need the ESPN sync.
 */
export async function importPolymarketMatches(
  db: Database, sport: string, deps: EngineDeps = {}, opts: { limit?: number } = {},
): Promise<DiscoverItem[]> {
  const poly = deps.polymarket ?? loadPolymarketConfig(deps.env);
  if (!poly.enabled) return [];
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  const discovered = await discoverSportMatches(poly, sport, now, { fetchImpl: deps.fetchImpl }, { limit: opts.limit ?? 200, windowDays: 7, nowMs });
  const out: DiscoverItem[] = [];
  for (const d of discovered) {
    // Route into the tournament category this match belongs to (Polymarket series).
    const compId = ensureCategoryComp(db, sport, d.series, d.seriesSlug, now);
    const ref = `pm:${sport}:${d.home}-${d.away}`.toLowerCase().replace(/\s+/g, "");
    // Dedup by pm: ref first, then by teams (the fixture may already exist under
    // an ESPN id if syncCompetitions imported it) — never duplicate the game.
    let match = R.matchByExternalRef(db, ref) ?? findTwinMatch(db, compId, d.home, d.away);
    let created = false;
    if (!match) {
      const startMs = d.kickoff ? Date.parse(d.kickoff) : NaN;
      // kickoff stored as ISO for scheduling; the view renders it in Warsaw time.
      match = {
        id: R.uid(), competition_id: compId, home: d.home, away: d.away,
        state: "upcoming", lineup_out: !isNaN(startMs) && startMs <= nowMs + 3600_000, kickoff_at: d.kickoff ?? null,
        minute: null, score_home: null, score_away: null, final_score: null,
        kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: ref,
      };
      R.insertMatch(db, match);
      created = true;
    }
    if (!R.latestMarkets(db, match.id).length) {
      for (const s of d.markets) {
        R.insertMarket(db, { id: R.uid(), match_id: match.id, label: s.label, price: s.price, ai_prob: null, liquidity: s.liquidity, external_ref: s.external_ref, snapshot_at: now, is_closing: false });
      }
    }
    out.push({ sport, match: `${d.home}–${d.away}`, created, markets: d.markets.length });
  }
  return out;
}

// ------------------------------------------------------------
// Enrich matches with REAL lineups + events from ESPN (so reassessment has
// teeth). Cross-refs DB matches (any competition, incl. Polymarket-discovered)
// to ESPN scoreboard events by team names, updates live state, stores lineups,
// and records new in-match events (goals/cards/subs) as reassessment triggers.
// ------------------------------------------------------------

// Generic club suffixes carry no identity — "Manchester United" and "Newcastle
// United" must NOT match on "united". Matching needs a distinctive token.
const TEAM_STOPWORDS = new Set(["fc", "afc", "sc", "cf", "ac", "as", "cd", "sv", "fk", "if", "bk", "club", "united", "city", "town", "county", "calcio", "sporting", "real", "athletic", "atletico"]);
function teamTokens(name: string): Set<string> {
  return new Set(name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length >= 3));
}
/** Do two team names refer to the same club/nation? Requires every token of the
 *  shorter name to appear in the longer (so "West Ham" ⊂ "West Ham United" ok,
 *  but "Manchester United" vs "Newcastle United" / "Manchester City" do NOT),
 *  and at least one shared DISTINCTIVE (non-suffix) token. */
function nameMatch(a: string, b: string): boolean {
  const ta = teamTokens(a), tb = teamTokens(b);
  if (!ta.size || !tb.size) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (![...small].every((t) => big.has(t))) return false;      // shorter ⊆ longer
  return [...small].some((t) => big.has(t) && !TEAM_STOPWORDS.has(t)); // a real, distinctive token
}
function sameTeams(h1: string, a1: string, h2: string, a2: string): boolean {
  return (nameMatch(h1, h2) && nameMatch(a1, a2)) || (nameMatch(h1, a2) && nameMatch(a1, h2));
}

export interface EnrichResult { enriched: number; newEvents: { matchId: string; type: string; minute: number | null; text: string }[] }

export async function enrichFromEspn(db: Database, provider: SportsProvider, deps: EngineDeps = {}): Promise<EnrichResult> {
  if (!provider.matchDetail) return { enriched: 0, newEvents: [] };
  const now = nowFn(deps)();
  const leagues = [...new Set(R.linkedCompetitions(db).map((c) => c.external_league).filter(Boolean))] as string[];
  if (!leagues.length) leagues.push("fifa.world");
  const dbMatches = R.listCompetitions(db).flatMap((c) => R.listMatches(db, c.id)).filter((m) => m.state !== "finished");
  const out: EnrichResult = { enriched: 0, newEvents: [] };
  for (const league of leagues) {
    const board = await provider.scoreboard("football", league);
    for (const s of board) {
      const m = dbMatches.find((dm) => sameTeams(dm.home, dm.away, s.home, s.away));
      if (!m) continue;
      // sameTeams is order-insensitive: the DB match's home/away orientation
      // (from the Polymarket title) may be the reverse of ESPN's. Align scores
      // and lineups to the DB match's home/away so nothing gets mirrored.
      const flip = nameMatch(m.home, s.away); // DB home is ESPN's away side → scores/lineups mirrored
      const scoreHome = flip ? s.scoreAway : s.scoreHome;
      const scoreAway = flip ? s.scoreHome : s.scoreAway;
      R.updateMatch(db, m.id, { state: s.state, minute: s.minute, score_home: scoreHome, score_away: scoreAway, clock: s.clock ?? null, ...(s.final ? { final_score: `${scoreHome ?? 0}:${scoreAway ?? 0}` } : {}) });
      const detail = await provider.matchDetail!("football", league, s.externalRef);
      if (detail) {
        const homeLineup = flip ? detail.lineups.away : detail.lineups.home;
        const awayLineup = flip ? detail.lineups.home : detail.lineups.away;
        // orient stats to the DB match's home/away, same as lineups
        const statHome = detail.stats ? (flip ? detail.stats.away : detail.stats.home) : null;
        const statAway = detail.stats ? (flip ? detail.stats.home : detail.stats.away) : null;
        const statsJson = (statHome || statAway) ? JSON.stringify({ home: statHome, away: statAway }) : null;
        R.upsertMatchLive(db, { match_id: m.id, espn_event_id: s.externalRef, league, home_lineup: homeLineup ? JSON.stringify(homeLineup) : null, away_lineup: awayLineup ? JSON.stringify(awayLineup) : null, stats: statsJson, updated_at: now });
        if (detail.lineupOut && !m.lineup_out) R.updateMatch(db, m.id, { lineup_out: true, state: s.state === "upcoming" ? "lineup" : s.state });
        for (const e of detail.events) {
          if (e.type === "other") continue;
          if (R.insertMatchEvent(db, { id: R.uid(), match_id: m.id, event_key: e.key, minute: e.minute, type: e.type, team: e.team, text: e.text, created_at: now })) {
            out.newEvents.push({ matchId: m.id, type: e.type, minute: e.minute, text: e.text });
          }
        }
      }
      out.enriched++;
    }
  }
  return out;
}

export interface CompetitionSyncItem {
  competition: string; match: string; created: boolean; state: string; oddsLinked?: number;
}

/**
 * Sync every competition that is linked to an external league: import new
 * matches into it (categorized), refresh live status, and optionally attach
 * Polymarket odds to freshly imported matches.
 */
export async function syncCompetitions(
  db: Database, provider: SportsProvider, deps: EngineDeps = {}, opts: { linkOdds?: boolean } = {},
): Promise<CompetitionSyncItem[]> {
  const out: CompetitionSyncItem[] = [];
  for (const c of R.linkedCompetitions(db)) {
    const statuses = await provider.scoreboard(c.sport_id, c.external_league as string);
    for (const s of statuses) {
      const { match, created } = upsertImportedMatch(db, c.id, s);
      let oddsLinked: number | undefined;
      // Attempt odds linking for any non-finished match that still has none —
      // not just on first import. Polymarket often lists a match's markets only
      // closer to kickoff, so a match imported early must be retried on later
      // syncs (linkMatchOdds is a no-op once markets exist).
      if (opts.linkOdds && s.state !== "finished" && !R.latestMarkets(db, match.id).length) {
        oddsLinked = await linkMatchOdds(db, match, c.sport_id, deps);
      }
      const r = await syncMatchStatus(db, s, deps);
      out.push({ competition: c.id, match: `${s.home}–${s.away}`, created, state: r?.to ?? s.state, oddsLinked });
    }
  }
  return out;
}

const fmt = (n: number) => `$${n.toFixed(1)}`;
