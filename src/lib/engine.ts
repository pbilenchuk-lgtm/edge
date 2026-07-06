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
import type { Bet, Match, MatchState } from "./types.js";
import type { SportsMatchStatus } from "./sports.js";
import { reassessNarrative, effectiveEnv } from "./llm.js";
import { settleBet, resolveFootballMarket } from "./settlement.js";
import { computeMetrics, type MetricSample } from "./metrics.js";
import { loadPolymarketConfig, getQuotes, findMatchEvents, matchMarketSnapshots, discoverSportMatches, SPORT_LABELS, type PolymarketConfig } from "./polymarket.js";
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

/** Monotonic match-state ordering — provider writes must never regress below the
 *  stored state (a stale poll can't flip live→upcoming or finished→live). */
const STATE_RANK: Record<MatchState, number> = { upcoming: 0, lineup: 1, live: 2, finished: 3 };

// ------------------------------------------------------------
// Reassessment triggers (rate-limited)
// ------------------------------------------------------------

/** §9.7: at most one reassessment per strategy per N match-minutes. */
export function canReassess(
  db: Database, matchId: string, strategyId: string, minute: number | null, gapMinutes: number,
): boolean {
  // Only engine-driven narratives (goal / red_card / price_move) count toward
  // THIS gap — a routine strategist heartbeat ('time') or a manual run must not
  // suppress a real on-pitch trigger's narrative (they use separate cadences).
  const prior = R.reassessmentsForMatch(db, matchId)
    .filter((r) => r.strategy_id === strategyId && r.trigger !== "time" && r.trigger !== "manual");
  if (!prior.length) return true;
  if (minute == null) {
    // No match clock (pre-clock / a league ESPN gives no minute for): rate-limit
    // on WALL-CLOCK instead, or every price tick would fire a fresh narrative.
    const last = Date.parse(prior[prior.length - 1].created_at);
    return isNaN(last) || Date.now() - last >= gapMinutes * 60_000;
  }
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
    // price_move reassessment trigger — LIVE only (ТЗ §3.3). Pre-match a
    // discovered match sits in `lineup`/time-flipped `lineup_out` with no game,
    // and illiquid Polymarket markets drift ≥threshold constantly, which fired a
    // flood of "движение цены на старте без игрового триггера" reassessments on a
    // not-yet-started match. Mark-to-market above still runs; only the trigger waits.
    if (match.state === "live" && Math.abs(price - m.price) >= cfg.priceMoveThreshold) {
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

  let settled = 0, skipped = 0;
  const affected = new Set<string>();
  for (const b of R.betsForMatch(db, match.id)) {
    if (b.status !== "open") continue;
    const won = resolveOutcome(b, match, overrides);
    if (won == null) {
      // Distinguish "no score yet" from "unresolvable market label". If the
      // final score isn't in yet (a finish that raced ahead of the score sync),
      // DON'T void — that would erase a real winner/loser. Leave it open; it
      // settles once the score lands. Only genuinely unresolvable markets
      // (Advance / penalties / unknown label, score KNOWN) fall through to void.
      if (match.score_home == null || match.score_away == null) { skipped++; continue; }
      // The match is FINISHED with a known score but this market can't be
      // auto-resolved (Advance / penalties / an unknown label, no override).
      // Leaving it open locks the stake in strategyDrawdown forever — the match
      // is never active again. Void it: refund the stake, zero P&L, tagged
      // 'void' so it's excluded from win/lose accuracy.
      R.updateBet(db, b.id, {
        status: "settled_lost", result: null, payout: b.stake ?? 0, settled_at: now,
        closing_price: b.current_price ?? b.entry_price ?? null, settled_by: "void",
      });
      R.insertTradeLog(db, {
        id: R.uid(), match_id: match.id, strategy_id: b.strategy_id, minute: "финал",
        type: "settle", text: `${b.market_label}: рынок не рассчитывается автоматически — возврат ставки ${fmt(b.stake ?? 0)} (P&L $0)`,
        created_at: now,
      });
      skipped++; affected.add(b.strategy_id);
      continue;
    }
    // Closing line for CLV = the KICKOFF snapshot — but ONLY for PRE-match bets.
    // CLV measures beating the closing (kickoff) line, which is defined relative
    // to a bet placed BEFORE kickoff. For an IN-MATCH entry the kickoff price
    // predates the bet, so benchmarking against it is meaningless and biased the
    // metric negative — give those a NEUTRAL CLV (closing = entry). With no
    // kickoff captured, fall back to entry too (never the post-resolution price).
    const preMatch = b.entered_minute == null || /предматч/i.test(b.entered_minute);
    const closing = preMatch ? (kickoff[b.market_label] ?? b.entry_price ?? null) : (b.entry_price ?? null);
    const patch = settleBet({ entry_price: b.entry_price, stake: b.stake }, won, closing);
    R.updateBet(db, b.id, { status: patch.status, result: patch.result, payout: patch.payout, closing_price: patch.closing_price, settled_at: now });
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

/**
 * Safety-net sweep: a finish that races ahead of the score sync makes settleMatch
 * leave those bets OPEN (see the skip branch above), and no state-transition edge
 * ever fires settleMatch again once the match row is already `finished`. So sweep
 * every finished match that still has open bets and a known score, and settle it.
 * Cheap (one query + one getMatch per affected match) and idempotent.
 */
export function settleStaleOpenBets(db: Database, deps: EngineDeps = {}): number {
  const matchIds = new Set<string>();
  for (const b of R.openBets(db)) matchIds.add(b.match_id);
  let settled = 0;
  for (const mid of matchIds) {
    const m = R.getMatch(db, mid);
    if (m && m.state === "finished" && m.score_home != null && m.score_away != null) {
      settled += settleMatch(db, m, deps).settled;
    }
  }
  return settled;
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

  // Never let a glitchy/stale provider poll REGRESS state (live→upcoming,
  // finished→live) — that would drop a live match out of the loop or, worse,
  // flip a finished match back to live and skip its re-settlement. And never
  // wipe a KNOWN score back to null. Mirrors advanceClocks' monotonic guard.
  const nextState = STATE_RANK[status.state] >= STATE_RANK[from] ? status.state : from;
  const scoreHome = status.scoreHome ?? match.score_home;
  const scoreAway = status.scoreAway ?? match.score_away;
  const patch: Partial<Match> = {
    state: nextState, minute: status.minute, clock: status.clock ?? null,
    score_home: scoreHome, score_away: scoreAway,
  };
  if (nextState === "finished") {
    patch.final_score = `${scoreHome ?? 0}:${scoreAway ?? 0}`;
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
  if (nextState === "finished" && from !== "finished") {
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
    // Adopt the ESPN ref so syncMatchStatus can drive/settle this fixture. AND
    // align home/away to ESPN's orientation: the twin (from a Polymarket title)
    // may be reversed, and syncMatchStatus writes scoreHome/scoreAway UNFLIPPED,
    // so a reversed twin would settle bets against mirrored scores (wrong
    // winner). Flip stored scores too if the twin already had any.
    const flipped = nameMatch(twin.home, status.away); // twin.home is ESPN's away side
    const patch: Partial<Match> = {};
    if (twin.external_ref !== status.externalRef) patch.external_ref = status.externalRef;
    if (flipped) {
      patch.home = status.home; patch.away = status.away;
      if (twin.score_home != null || twin.score_away != null) { patch.score_home = twin.score_away; patch.score_away = twin.score_home; }
    }
    if (Object.keys(patch).length) R.updateMatch(db, twin.id, patch);
    return { match: { ...twin, ...patch }, created: false };
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

const pmCompLabel = (sport: string): string => `Polymarket · ${SPORT_LABELS[sport] ?? sport} · прочее`;

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
// Fallback when the exact Polymarket series slug isn't in the table above:
// infer the ESPN league code from the series NAME/slug, so a newly-listed
// league (Nordic, etc.) still gets ESPN live scores + events instead of going
// dark in-match (enrichFromEspn only touches comps that have an external_league,
// and it still gates every enrich on a team-name match, so a loose guess here is
// safe — worst case it finds nothing). Extend as more leagues are traded.
const LEAGUE_NAME_ESPN: [RegExp, string][] = [
  [/allsvenskan/i, "swe.1"], [/superettan/i, "swe.2"],
  [/eliteserien/i, "nor.1"],
  [/eredivisie/i, "ned.1"], [/eerste divisie/i, "ned.2"],
  [/(primeira liga|liga portugal)/i, "por.1"],
  [/s[üu]per\s*lig/i, "tur.1"],
  [/(scottish premiership|scottish prem)/i, "sco.1"],
  [/(jupiler|belgian pro league|pro league)/i, "bel.1"],
  [/(swiss super|super league.*switzerland)/i, "sui.1"],
  [/(danish superliga|superligaen)/i, "den.1"],
  [/(major league soccer|\bmls\b)/i, "usa.1"],
  [/(brasileir|s[ée]rie a.*brazil)/i, "bra.1"],
  [/liga mx/i, "mex.1"],
  [/(efl championship|\bchampionship\b)/i, "eng.2"],
  [/saudi pro league/i, "ksa.1"],
  [/j1 league/i, "jpn.1"],
  [/a-?league/i, "aus.1"],
  [/(greek super league|super league greece)/i, "gre.1"],
  [/(austrian bundesliga|bundesliga.*austria)/i, "aut.1"],
];
const inferEspnLeague = (name: string | null): string | null => {
  if (!name) return null;
  for (const [re, code] of LEAGUE_NAME_ESPN) if (re.test(name)) return code;
  return null;
};
const slugify = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Ensure the CATEGORY competition a discovered match belongs to (its Polymarket
 * `series`, e.g. "FIFA World Cup" → "ЧМ-2026"). Matches with no series fall back
 * to the per-sport "…· прочее" bucket. Never clobbers an existing comp's budget;
 * backfills the ESPN league so its matches get lineups/events.
 */
/** The ESPN league a discovered match's series maps to, or null if ESPN doesn't
 *  cover it (→ no live scores/events, so we don't import it). */
/** The stable series slug for a discovered match (Polymarket seriesSlug, else a
 *  slug of the series name). "" when it has no series. */
export function seriesSlugOf(series: string | null, seriesSlug: string | null): string {
  return (seriesSlug ?? (series ? slugify(series) : "")).toLowerCase();
}

/** Per-sport series allow-list (slugs) — null = no restriction. Tennis keeps
 *  only ATP by default; override via TENNIS_SERIES (comma-separated slugs). */
export function seriesAllowFor(sport: string, env: Record<string, string | undefined> = process.env): Set<string> | null {
  if (sport !== "tennis") return null;
  const slugs = (env.TENNIS_SERIES ?? "atp").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set(slugs);
}

export function espnLeagueForSeries(series: string | null, seriesSlug: string | null): string | null {
  const slug = seriesSlug ?? (series ? slugify(series) : null);
  if (!slug && !series) return null;
  return (slug ? SERIES_ESPN_LEAGUE[slug] : null) ?? inferEspnLeague(series) ?? inferEspnLeague(slug) ?? null;
}

function ensureCategoryComp(db: Database, sport: string, series: string | null, seriesSlug: string | null, now: string): string {
  // The persistent prod DB was seeded before these sports existed, so guarantee
  // the sports(id) row exists (FK target for competitions.sport_id) at import
  // time — idempotent, safe on every run.
  R.upsertSport(db, sport, SPORT_LABELS[sport] ?? sport);
  if (!series && !seriesSlug) {
    const id = `pm-${sport}`;
    if (!R.listCompetitions(db).some((c) => c.id === id))
      R.upsertCompetition(db, { id, sport_id: sport, name: pmCompLabel(sport), budget: 0, external_league: null, created_at: now });
    return id;
  }
  const slug = seriesSlug ?? slugify(series!);
  const id = `pm-${slug}`;
  const league = espnLeagueForSeries(series, seriesSlug);
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
  // Widen coverage without more Polymarket calls: a longer window + higher match
  // cap pull MORE leagues out of the SAME fetched event set (no extra requests —
  // user: «отбиваемся от полимаркета»). Both env-tunable.
  const env = deps.env ?? process.env;
  const windowDays = Number(env.DISCOVER_WINDOW_DAYS ?? 21);
  const limit = opts.limit ?? Number(env.DISCOVER_MATCH_LIMIT ?? 400);
  const discovered = await discoverSportMatches(poly, sport, now, { fetchImpl: deps.fetchImpl }, { limit, windowDays, nowMs });
  const allow = seriesAllowFor(sport, deps.env); // e.g. tennis → only ATP tour
  const out: DiscoverItem[] = [];
  for (const d of discovered) {
    // Import by LIQUIDITY, not by ESPN coverage — user: «меня не интересуют
    // матчи с низкой ликвидностью… а где ликвидность есть — надо брать». A liquid
    // fixture is worth trading even without a live scoreboard (its «События
    // матча» then falls back to market-price snapshots); a thin one isn't, ESPN
    // feed or not. 0 disables the floor.
    if (poly.minLiquidity > 0 && d.liquidity < poly.minLiquidity) continue;
    // Per-sport series allow-list: tennis keeps only ATP (WTA/doubles/juniors
    // have no liquidity — user). Other sports: no restriction.
    if (allow && !allow.has(seriesSlugOf(d.series, d.seriesSlug))) continue;
    // Skip matches with NO tournament series — on Polymarket these are novelty /
    // prop "X vs Y" markets (player H2H, "to play?"), not real fixtures. They
    // fed the useless «… · прочее» catch-all. Real matches always carry a series.
    if (!d.series && !d.seriesSlug) continue;
    // Route into the tournament category this match belongs to (Polymarket series).
    const compId = ensureCategoryComp(db, sport, d.series, d.seriesSlug, now);
    // Order-INSENSITIVE ref (teams sorted): Polymarket may list a fixture as
    // "A vs B" one run and "B vs A" the next, which with an orientation-sensitive
    // key produced a duplicate row. Sorting the two sides collapses both to one.
    const ref = `pm:${sport}:${[d.home, d.away].map((s) => s.toLowerCase().replace(/\s+/g, "")).sort().join("-")}`;
    // Dedup, most-reliable first: (1) the order-insensitive pm: ref, (2) SHARED
    // CLOB tokens — the same fixture keeps its market tokens even if Polymarket
    // rewords the title, so this catches spelling drift the ref/name checks miss,
    // (3) team-name twin (the fixture may already exist under an ESPN id from
    // syncCompetitions). Never duplicate the game.
    const tokenRefs = d.markets.map((s) => s.external_ref).filter((r): r is string => !!r);
    let match = R.matchByExternalRef(db, ref)
      ?? R.matchByMarketTokens(db, tokenRefs)
      ?? findTwinMatch(db, compId, d.home, d.away);
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
    } else if (d.kickoff && match.kickoff_at) {
      // Existing match: Polymarket moved the start time (postponed/rescheduled).
      // Update kickoff_at so advanceClocks re-derives state from the NEW time —
      // otherwise a postponed match stays clock-driven "live" at its old slot.
      // Only for a real ISO kickoff and a meaningful shift (>5 min).
      const newMs = Date.parse(d.kickoff), oldMs = Date.parse(match.kickoff_at);
      if (!isNaN(newMs) && (isNaN(oldMs) || Math.abs(newMs - oldMs) > 5 * 60_000)) {
        R.updateMatch(db, match.id, { kickoff_at: d.kickoff });
        match.kickoff_at = d.kickoff;
      }
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
  const compSport = new Map(R.listCompetitions(db).map((c) => [c.id, c.sport_id]));
  // Build the (sport, league) scoreboards to poll. Football (and any other
  // ESPN-linked competition) contributes its mapped league; the provider also
  // declares fixed leagues per sport (nba/nhl/mlb…). Deduped per sport.
  const jobs = new Map<string, Set<string>>();
  const addJob = (sport: string, league: string | null) => {
    if (!league) return;
    let set = jobs.get(sport); if (!set) jobs.set(sport, (set = new Set()));
    set.add(league);
  };
  for (const c of R.linkedCompetitions(db)) addJob(c.sport_id, c.external_league);
  if (!jobs.has("football")) addJob("football", "fifa.world");
  if (provider.leaguesFor) for (const sport of new Set(compSport.values())) for (const lg of provider.leaguesFor(sport)) addJob(sport, lg);
  const dbMatches = R.listCompetitions(db).flatMap((c) => R.listMatches(db, c.id)).filter((m) => m.state !== "finished");
  const out: EnrichResult = { enriched: 0, newEvents: [] };
  for (const [sport, leagues] of jobs) for (const league of leagues) {
    const board = await provider.scoreboard(sport, league);
    for (const s of board) {
      // Same-sport only — otherwise "Poland vs Netherlands" basketball could
      // match a soccer fixture of the same nations.
      const m = dbMatches.find((dm) => compSport.get(dm.competition_id) === sport && sameTeams(dm.home, dm.away, s.home, s.away));
      if (!m) continue;
      // sameTeams is order-insensitive: the DB match's home/away orientation
      // (from the Polymarket title) may be the reverse of ESPN's. Align scores
      // and lineups to the DB match's home/away so nothing gets mirrored.
      const flip = nameMatch(m.home, s.away); // DB home is ESPN's away side → scores/lineups mirrored
      const scoreHome = flip ? s.scoreAway : s.scoreHome;
      const scoreAway = flip ? s.scoreHome : s.scoreAway;
      // Did THIS enrich transition the match into "finished"? Settlement lives
      // in settleMatch (called by syncMatchStatus, guarded on from!=="finished"),
      // so if enrich flips a match to finished first, syncMatchStatus would skip
      // it forever and its open bets would never resolve. Settle here instead.
      const becameFinished = (s.final || s.state === "finished") && m.state !== "finished";
      // Never regress state or wipe a known score on a stale/glitchy poll.
      const nextState = STATE_RANK[s.state] >= STATE_RANK[m.state] ? s.state : m.state;
      const sh = scoreHome ?? m.score_home, sa = scoreAway ?? m.score_away;
      R.updateMatch(db, m.id, { state: nextState, minute: s.minute, score_home: sh, score_away: sa, clock: s.clock ?? null, ...(s.final ? { final_score: `${sh ?? 0}:${sa ?? 0}` } : {}) });
      if (becameFinished) { const fresh = R.getMatch(db, m.id); if (fresh) settleMatch(db, fresh, deps); }
      const detail = await provider.matchDetail!(sport, league, s.externalRef);
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
