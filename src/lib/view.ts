// ============================================================
// EDGE LAB — view assembler  [SERVER-ONLY]
// Transforms DB rows into the payload the UI consumes (shapes mirror the
// reference mockup so rendering code ports over near-verbatim).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { providerEnabled, effectiveEnv } from "./llm.js";
import { jobActive } from "./analysis.js";
import { warsawLabel, warsawClock, isIso } from "./time.js";
import { SPORT_LABELS, isNoiseMarket } from "./polymarket.js";
import { resolveFootballMarket } from "./settlement.js";
import { maxLiveMinutes, liveDelivering } from "./lifecycle.js";
import { listRiskProfileViews, type RiskProfileView } from "./riskConfig.js";
import type { StrategyParams, Match, Bet } from "./types.js";

export interface MarketView {
  id: string; label: string; price: number; aiProb: number | null;
  liq: string | null; tokenId: string | null;
  /** opening (pre-match, first-seen) price in cents — for the "line moved" delta */
  openCents: number | null;
}
export interface AssessmentView {
  confidence: string | null; short: string | null; text: string | null; verdict: string | null; status: string;
}
export interface BetItemView {
  market: string; price: number | null; aiProb: number | null; pct?: number;
  stake?: number; entryPrice?: number | null; currentPrice?: number | null;
  status: string; entered?: string | null; profileId?: string;
}
export interface MatchView {
  id: string; competitionId: string; home: string; away: string; state: string;
  minute: number | null; clock: string | null; scoreHome: number | null; scoreAway: number | null;
  // state==="live" by our CLOCK, but the provider isn't actually delivering in-play
  // data yet (ESPN still "pre"/lagging — no real minute, no events). The badge shows
  // «ждём данные», not «LIVE», and nothing trades until real data lands.
  liveNoData: boolean;
  lineupOut: boolean; lineupsReady: boolean; kickoff: string | null; kickoffAt: string | null; oddsUpdated: string | null;
  finalScore: string | null; kickoffTime: string | null; endTime: string | null;
  duration: string | null; endNote: string | null;
  /** a per-match LLM analyze run is in flight (durable; survives reload) */
  analyzing: boolean;
  preLineup: AssessmentView | null; postLineup: AssessmentView | null;
  /** past analyses (older runs), newest first — the current pre/post are excluded */
  assessmentHistory: { stage: string; label: string; at: string | null; confidence: string | null; short: string | null; text: string | null; verdict: string | null }[];
  /** raw JSON of each analysis layer's output (base / category / distribution /
   *  strategist), for review + copy in the «Анализ» tab. Newest first. */
  artifacts: { kind: string; label: string; stage: string | null; model: string | null; at: string | null; content: string }[];
  markets: MarketView[];
  bets: Record<string, { rationale: string | null; items: BetItemView[] }>;
  reassessByStrat: Record<string, { min: string | null; at: string | null; text: string; conf: string | null }[]>;
  logByStrat: Record<string, { min: string | null; at: string | null; text: string; type: string }[]>;
  settledBets: Record<string, { market: string; stake: number; result: string; payout: number; settledBy: string | null; closedPct: number; at: string | null; profileId?: string }[]>;
  result: Record<string, number>;
  /** real lineups (ESPN), if enriched — shown under the СОСТАВ toggle */
  lineups: { home: LineupView | null; away: LineupView | null } | null;
  /** real in-match events (ESPN): goals / cards / subs, newest last */
  events: { minute: number | null; type: string; team: string | null; text: string }[];
  /** number of provider/Polymarket raw snapshots captured for this match (Анализ tab) */
  snapshotCount: number;
}
export interface LineupView { team: string; formation: string | null; starters: string[] }
export interface StrategyView {
  id: string; name: string; tag: string | null; color: string; version: number;
  sport: string; model: string | null; prompt: string; promptLive: string | null; params: StrategyParams;
}
export interface QualityView {
  brier: number | null; clv: number | null; samples: number;
  calib: { bucket: string; predicted: number; actual: number }[];
  /** realised results split by ENTRY phase (pre-match vs in-match) */
  phases?: { id: string; label: string; bets: number; wins: number; pnl: number; clv: number | null }[];
  /** value of active management: actual realised vs holding every close to resolution */
  mgmt?: { actualPnl: number; heldToEndPnl: number; managed: number };
  /** bank value per match (chronological), for the equity sparkline */
  equity?: number[];
}
export interface FeedItem {
  t: string; at?: string | null; type: string; sport: string; match: string; score?: string | null;
  strat?: string; color?: string; text: string; pnl?: number;
}
export interface ProviderView { id: string; name: string; keyHint: string; models: string[]; hasKey: boolean; }

/** Per-strategy operational stats (distinct from the quality metrics). Open
 *  positions are marked to market against the FRESHEST quote, not the price
 *  stored on the bet, so "в плюсе/в минусе" reflects the current line. */
export interface StrategyStats {
  matches: number;        // distinct matches the strategy bet on
  predictions: number;    // filled bets (open + settled) — actual predictions
  won: number;            // settled by the real match outcome → correct
  lost: number;           // settled by the real match outcome → wrong
  openPlus: number;       // open positions currently in profit (current quote)
  openMinus: number;      // open positions currently at a loss
  openPnl: number;        // current unrealized P&L on open positions ($)
  earned: number;         // realized profit ($) — sum of positive settled P&L
  lostMoney: number;      // realized loss ($, positive number)
  inMatch: number;        // predictions entered in-match (live)
  inMatchPlus: number;    // in-match predictions currently/finally positive
  inMatchMinus: number;   // in-match predictions currently/finally negative
}

export interface AppData {
  treasuryTotal: number;
  sports: { id: string; label: string }[];
  competitions: { id: string; sport: string; name: string; matches: string[] }[];
  compBudget: Record<string, number>;
  /** per-comp summed share % by strategy (across its profiles) — back-compat display */
  shares: Record<string, Record<string, number>>;
  /** per-comp allocation ROWS: the real (strategy, profile, pct) pairs */
  shareRows: Record<string, { strategyId: string; profileId: string; pct: number }[]>;
  catalog: StrategyView[];
  analysis: { modelBySport: Record<string, string>; bySport: Record<string, string>; byComp: Record<string, string> };
  matchDb: Record<string, MatchView>;
  quality: Record<string, QualityView>;
  eventFeed: FeedItem[];
  providers: ProviderView[];
  cron: CronView;
  strategyStats: Record<string, StrategyStats>;
  /** named risk presets (Окно 4); a competition assigns (strategy, profile) pairs */
  riskProfiles: RiskProfileView[];
}
export interface CronView {
  enabled: boolean; tickMin: number; discoverHr: number; liveSec: number; nextRunAt: string | null;
  recent: { at: string; kind: string; ok: boolean; summary: string }[];
}

const PROVIDER_DEFS: Omit<ProviderView, "hasKey">[] = [
  { id: "anthropic", name: "Anthropic", keyHint: "sk-ant-…", models: ["Claude Opus 4.8", "Claude Sonnet 5", "Claude Haiku 4.5", "Claude Fable 5"] },
  { id: "openai", name: "OpenAI", keyHint: "sk-…", models: ["GPT-5", "GPT-5 mini", "o4"] },
  { id: "google", name: "Google", keyHint: "AIza…", models: ["Gemini 2.5 Pro", "Gemini 2.5 Flash"] },
];

export function buildAppData(db: Database, env = process.env): AppData {
  const nowMs = Date.now();
  const treasury = R.getTreasury(db);
  const sports = db.prepare(`SELECT id,label FROM sports ORDER BY rowid`).all() as { id: string; label: string }[];
  const comps = R.listCompetitions(db);
  const strategies = R.listStrategies(db);

  // Load each competition's matches ONCE (used by the competitions map, the
  // match loop, and the stats/quality aggregation) instead of re-querying.
  const matchesByComp = new Map(comps.map((c) => [c.id, R.listMatches(db, c.id)]));
  const sharesByComp = new Map(comps.map((c) => [c.id, R.sharesForComp(db, c.id)]));

  const compBudget: Record<string, number> = {};
  const shares: Record<string, Record<string, number>> = {};
  const shareRows: Record<string, { strategyId: string; profileId: string; pct: number }[]> = {};
  const competitions = comps.map((c) => {
    compBudget[c.id] = c.budget;
    const sh = sharesByComp.get(c.id)!;
    if (sh.length) {
      // back-compat map: strategy → summed pct across its profiles
      const byStrat: Record<string, number> = {};
      for (const s of sh) byStrat[s.strategy_id] = (byStrat[s.strategy_id] ?? 0) + s.pct;
      shares[c.id] = byStrat;
      shareRows[c.id] = sh.map((s) => ({ strategyId: s.strategy_id, profileId: s.risk_profile_id, pct: s.pct }));
    }
    return { id: c.id, sport: c.sport_id, name: c.name, matches: (matchesByComp.get(c.id) ?? []).map((m) => m.id) };
  });

  const catalog: StrategyView[] = strategies.map((s) => ({
    id: s.id, name: s.name, tag: s.tag, color: s.color ?? "#8b95a5", version: s.version,
    sport: s.sport_id, model: s.model, prompt: s.prompt, promptLive: s.prompt_live, params: s.params,
  }));

  // analytics maps
  const analysis = { modelBySport: {} as Record<string, string>, bySport: {} as Record<string, string>, byComp: {} as Record<string, string> };
  for (const p of R.allAnalyticsPrompts(db)) {
    if (p.scope === "sport") { analysis.bySport[p.scope_id] = p.body; if (p.model) analysis.modelBySport[p.scope_id] = p.model; }
    else analysis.byComp[p.scope_id] = p.body;
  }

  // ALL bets in one query, grouped — the match loop, stats and quality then read
  // from these maps instead of a per-match betsForMatch scan (×M each pass).
  const betsByMatch = new Map<string, Bet[]>();
  const betsByStrategy = new Map<string, Bet[]>();
  for (const b of R.allBets(db)) {
    (betsByMatch.get(b.match_id) ?? betsByMatch.set(b.match_id, []).get(b.match_id)!).push(b);
    (betsByStrategy.get(b.strategy_id) ?? betsByStrategy.set(b.strategy_id, []).get(b.strategy_id)!).push(b);
  }

  // matches
  const matchDb: Record<string, MatchView> = {};
  const allMatches: Match[] = [];
  const matchById = new Map<string, Match>();
  const pricesByMatch = new Map<string, Record<string, number>>(); // freshest quote per label
  for (const c of comps) {
    for (const m of matchesByComp.get(c.id) ?? []) {
      allMatches.push(m); matchById.set(m.id, m);
      // Only surface completed assessments; a failed run (§6) is reported to
      // the user via the analyze poll, not as an empty analysis card.
      const assessments = R.assessmentsForMatch(db, m.id).filter((a) => a.status !== "failed");
      const pre = assessments.find((a) => a.stage === "pre_lineup");
      const post = assessments.find((a) => a.stage === "post_lineup");
      // History of past analyses: newest first, dropping the single most-recent
      // row per stage (that one is already surfaced as the current pre/post).
      const stageLabel: Record<string, string> = { pre_lineup: "до состава", post_lineup: "после состава" };
      const seenStage = new Set<string>();
      const assessmentHistory = R.assessmentHistoryForMatch(db, m.id).filter((h) => {
        if (!seenStage.has(h.stage)) { seenStage.add(h.stage); return false; } // skip current
        return true;
      }).map((h) => ({
        stage: h.stage, label: stageLabel[h.stage] ?? h.stage, at: warsawLabel(h.created_at),
        confidence: h.confidence, short: h.short, text: h.body, verdict: h.verdict,
      }));
      const kickoff = R.openOddsFor(db, m.id); // price at kickoff (empty pre-match)
      const latest = R.latestMarkets(db, m.id);
      const prices: Record<string, number> = {}; // freshest quote per label (for stats)
      for (const mk of latest) if (!(mk.label in prices)) prices[mk.label] = mk.price;
      pricesByMatch.set(m.id, prices);
      // Hide noise markets (correct-score residuals: "Neither", "Any Other
      // Score", winning margin…) even if a match was imported before they were
      // filtered — so existing matches clean up without a DB migration.
      const markets = latest.filter((mk) => !isNoiseMarket(mk.label)).map((mk) => ({
        id: mk.id, label: mk.label, price: mk.price, aiProb: mk.ai_prob, liq: mk.liquidity, tokenId: mk.external_ref,
        openCents: mk.label in kickoff ? kickoff[mk.label] : null,
      }));
      const allBets = betsByMatch.get(m.id) ?? [];
      const bets: MatchView["bets"] = {};
      const settledBets: MatchView["settledBets"] = {};
      // Newest close on top — collect with the raw settle timestamp, then sort desc.
      const settledTmp: Record<string, { view: MatchView["settledBets"][string][number]; at: string }[]> = {};
      const result: Record<string, number> = {};
      for (const b of allBets) {
        if (b.status === "settled_won" || b.status === "settled_lost") {
          // How much of the position this close represents: a partial fixation
          // stamps «частичная фиксация NN%» into the rationale; a full early
          // close / resolution is 100%.
          const pctM = b.settled_by === "partial" ? /(\d+)\s*%/.exec(b.rationale ?? "") : null;
          const closedPct = pctM ? Number(pctM[1]) : 100;
          (settledTmp[b.strategy_id] ||= []).push({
            view: { market: b.market_label, stake: b.stake ?? 0, result: b.result ?? "lost", payout: b.payout ?? 0, settledBy: b.settled_by ?? null, closedPct, at: warsawClock(b.settled_at), profileId: b.risk_profile_id ?? "medium" },
            at: b.settled_at ?? "",
          });
          result[b.strategy_id] = (result[b.strategy_id] ?? 0) + ((b.payout ?? 0) - (b.stake ?? 0));
        } else {
          const grp = (bets[b.strategy_id] ||= { rationale: null, items: [] });
          if (!grp.rationale && b.rationale) grp.rationale = b.rationale;
          grp.items.push({
            market: b.market_label, price: b.proposed_price ?? b.entry_price, aiProb: b.ai_prob,
            stake: b.stake ?? undefined, entryPrice: b.entry_price, currentPrice: b.current_price,
            status: b.status, entered: b.entered_minute, profileId: b.risk_profile_id ?? "medium",
          });
        }
      }
      // «Закрытия»: newest close on top (sort by the raw settle timestamp desc).
      for (const k in settledTmp) {
        settledTmp[k].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        settledBets[k] = settledTmp[k].map((x) => x.view);
      }
      // repo returns these ORDER BY created_at (oldest→newest); the UI wants the
      // NEWEST on top, so reverse each strategy's list after collecting. Each row
      // also carries a wall-clock timestamp (`at`, Warsaw HH:MM) beside the
      // match-minute label. (SQL order is left ascending — the engine relies on it.)
      const reassessByStrat: MatchView["reassessByStrat"] = {};
      for (const r of R.reassessmentsForMatch(db, m.id))
        (reassessByStrat[r.strategy_id] ||= []).push({ min: r.minute, at: warsawClock(r.created_at), text: r.body, conf: r.confidence });
      for (const k in reassessByStrat) reassessByStrat[k].reverse();
      const logByStrat: MatchView["logByStrat"] = {};
      for (const l of R.tradeLogForMatch(db, m.id))
        (logByStrat[l.strategy_id] ||= []).push({ min: l.minute, at: warsawClock(l.created_at), text: l.text, type: l.type });
      for (const k in logByStrat) logByStrat[k].reverse();

      // real lineups + events from ESPN enrichment (if any)
      const live = R.getMatchLive(db, m.id);
      const parseLineup = (j: string | null): LineupView | null => { if (!j) return null; try { const l = JSON.parse(j); return { team: l.team ?? "?", formation: l.formation ?? null, starters: Array.isArray(l.starters) ? l.starters : [] }; } catch { return null; } };
      const lineups = live && (live.home_lineup || live.away_lineup)
        ? { home: parseLineup(live.home_lineup), away: parseLineup(live.away_lineup) } : null;
      // NEWEST event first (repo returns oldest→newest) — easier to read the
      // «События матча» tab without scrolling to the bottom for the latest.
      const events = R.eventsForMatch(db, m.id).filter((e) => e.type !== "other")
        .map((e) => ({ minute: e.minute, type: e.type, team: e.team, text: e.text })).reverse();
      // For a clock-driven live match (no ESPN minute) show how long it's been
      // going, computed from kickoff — so the card reads "LIVE · N'" instead of a
      // bare "LIVE". ESPN-driven matches keep their real match minute.
      const liveMinute = m.state === "live" && m.minute == null && isIso(m.kickoff_at)
        ? Math.min(maxLiveMinutes(c.sport_id), Math.max(0, Math.floor((nowMs - Date.parse(m.kickoff_at)) / 60000)))
        : m.minute;

      // "live" by our clock, but the provider isn't delivering in-play data yet
      // (frozen at 0', no events — ESPN still "pre"/lagging). Same predicate the
      // entry/exit gate uses, so the badge matches reality: no trading, «ждём данные».
      const liveNoData = m.state === "live" && !liveDelivering(db, m, c.sport_id);
      matchDb[m.id] = {
        id: m.id, competitionId: m.competition_id, home: m.home, away: m.away, state: m.state, liveNoData,
        minute: liveNoData ? null : liveMinute, clock: m.clock ?? null, scoreHome: m.score_home, scoreAway: m.score_away, lineupOut: m.lineup_out,
        // Real starting XI published (provider), NOT the ~1h timer flip — this is
        // what actually gates football analysis, so the UI badge must track it.
        lineupsReady: R.hasLineups(db, m.id),
        kickoff: warsawLabel(m.kickoff_at), kickoffAt: m.kickoff_at, oddsUpdated: null, finalScore: m.final_score,
        // Finish/kickoff clocks shown in Warsaw everywhere: an ISO value formats to
        // HH:MM, a value already stored as a Warsaw string passes straight through.
        kickoffTime: warsawClock(m.kickoff_time) ?? m.kickoff_time,
        endTime: warsawClock(m.end_time) ?? m.end_time, duration: m.duration, endNote: m.end_note,
        analyzing: jobActive(R.getAnalysisJob(db, m.id), nowMs),
        preLineup: pre ? view(pre) : null, postLineup: post ? view(post) : null,
        assessmentHistory,
        artifacts: R.artifactsForMatch(db, m.id).map((x) => ({ kind: x.kind, label: x.label, stage: x.stage, model: x.model, at: x.created_at, content: x.content })),
        markets: orderMarkets(markets), bets, reassessByStrat, logByStrat, settledBets, result, lineups, events,
        snapshotCount: R.snapshotCount(db, m.id),
      };
    }
  }

  // quality: stored predictive metrics (Brier/CLV/calibration) + derived
  // per-phase / management / equity extras computed from the bet history.
  const quality: Record<string, QualityView> = {};
  const budgetOf: Record<string, number> = {};
  for (const c of comps) for (const sh of (sharesByComp.get(c.id) ?? [])) budgetOf[sh.strategy_id] = (budgetOf[sh.strategy_id] ?? 0) + Math.floor((c.budget * sh.pct) / 100);
  for (const s of strategies) {
    const q = R.getQuality(db, s.id);
    const extras = computeQualityExtras(matchById, betsByStrategy.get(s.id) ?? [], budgetOf[s.id] ?? 0);
    if (q || extras.phases.some((p) => p.bets > 0) || extras.equity) {
      quality[s.id] = {
        brier: q?.brier ?? null, clv: q?.clv ?? null, samples: q?.samples ?? 0, calib: q?.calibration ?? [],
        phases: extras.phases, mgmt: extras.mgmt, equity: extras.equity,
      };
    }
  }

  // event feed (built from trade log + reassessments + settlements)
  const eventFeed = buildFeed(db, comps, strategies, matchDb);

  // env keys OR keys entered via the UI (server-side); never expose the key itself.
  const keyEnv = effectiveEnv(R.getProviderKeys(db), env);
  const providers: ProviderView[] = PROVIDER_DEFS.map((p) => ({
    ...p, hasKey: providerEnabled(p.id as any, keyEnv),
  }));

  // cron audit: schedule (from env) + recent runs (from the log)
  const cronEnabled = (env.AUTO_TICK ?? "false").toLowerCase() === "true";
  const tickMin = Math.max(1, Number(env.TICK_INTERVAL_MIN ?? 30));
  const discoverHr = Math.max(1, Number(env.DISCOVER_INTERVAL_HR ?? 24));
  const liveSec = Math.max(15, Number(env.LIVE_TICK_SEC ?? 20));
  const recentRuns = R.recentCronLog(db, 15);
  const lastFull = recentRuns.find((r) => r.kind !== "live");
  const lastAt = lastFull ? Date.parse(lastFull.at) : NaN;
  const nextRunAt = cronEnabled && !isNaN(lastAt) ? new Date(lastAt + tickMin * 60_000).toISOString() : null;
  const cron: CronView = {
    enabled: cronEnabled, tickMin, discoverHr, liveSec, nextRunAt,
    recent: recentRuns.map((r) => ({ at: r.at, kind: r.kind, ok: r.ok === 1, summary: r.summary })),
  };

  const strategyStats = computeStrategyStats(strategies, allMatches, betsByMatch, pricesByMatch);

  const payload: AppData = { treasuryTotal: treasury.total_balance, sports, competitions, compBudget, shares, shareRows, catalog, analysis, matchDb, quality, eventFeed, providers, cron, strategyStats, riskProfiles: listRiskProfileViews(db) };
  // node:sqlite rows have a null prototype; React Server Components can't pass
  // those to a client component. A JSON round-trip yields plain objects.
  return JSON.parse(JSON.stringify(payload));
}

/** Order a match's markets so PAIRED SIDES sit together — the two sides of a
 *  yes/no or team market group adjacently (primary side first, "— No"/Under
 *  after), groups ordered by liquidity. Also shows a bare yes-market side as
 *  "— Yes" when its "— No" sibling exists, so an old BTTS reads symmetrically. */
export function orderMarkets(mkts: MatchView["markets"]): MatchView["markets"] {
  const orig = new Set(mkts.map((m) => m.label));
  const disp = mkts.map((m) => (!/\s—\s/.test(m.label) && orig.has(`${m.label} — No`)) ? { ...m, label: `${m.label} — Yes` } : m);
  // group key: strip a trailing "— side" AND fold Over/Under to one line so the
  // two totals sides share a base ("Over 2.5"/"Under 2.5" → "± 2.5").
  const baseOf = (l: string) => l.replace(/\s+—\s+[^—]+$/, "").replace(/\b(over|under)\b/gi, "±");
  const sideRank = (l: string) => /(\s—\s*no\b|\bunder\b)/i.test(l) ? 1 : 0;    // primary side first, No/Under after
  const liqOf = (m: MatchView["markets"][number]) => Number(m.liq ?? 0) || 0;
  const groupLiq = new Map<string, number>();
  for (const m of disp) { const b = baseOf(m.label); groupLiq.set(b, Math.max(groupLiq.get(b) ?? -1, liqOf(m))); }
  return disp.slice().sort((a, b) => {
    const ba = baseOf(a.label), bb = baseOf(b.label);
    if (ba !== bb) return (groupLiq.get(bb)! - groupLiq.get(ba)!) || (ba < bb ? -1 : 1); // liquid groups first
    return (sideRank(a.label) - sideRank(b.label)) || (a.label < b.label ? -1 : 1);      // sides adjacent, primary first
  });
}

function view(a: { confidence: string | null; short: string | null; body: string | null; verdict: string | null; status: string }): AssessmentView {
  return { confidence: a.confidence, short: a.short, text: a.body, verdict: a.verdict, status: a.status };
}

const EVENT_LABEL: Record<string, string> = { goal: "⚽ гол", red_card: "🟥 красная", yellow_card: "🟨 жёлтая", sub: "🔁 замена", stats: "📊 статистика" };
// The feed filters group all match events under "События матча" (type "goal").
const FEED_EVENT_TYPE: Record<string, string> = { goal: "goal", red_card: "card", yellow_card: "card", sub: "sub", stats: "stats" };

/** Detailed per-strategy stats — open positions marked to the FRESHEST market
 *  price (not the price stored on the bet), so +/- reflects the current line. */
function computeStrategyStats(
  strategies: { id: string }[], matches: Match[],
  betsByMatch: Map<string, Bet[]>, pricesByMatch: Map<string, Record<string, number>>,
): Record<string, StrategyStats> {
  const out: Record<string, StrategyStats> = {};
  const seenMatch: Record<string, Set<string>> = {};
  for (const s of strategies) {
    out[s.id] = { matches: 0, predictions: 0, won: 0, lost: 0, openPlus: 0, openMinus: 0, openPnl: 0, earned: 0, lostMoney: 0, inMatch: 0, inMatchPlus: 0, inMatchMinus: 0 };
    seenMatch[s.id] = new Set();
  }
  {
    for (const m of matches) {
      const cur = pricesByMatch.get(m.id) ?? {}; // freshest quote per market label
      for (const b of betsByMatch.get(m.id) ?? []) {
        const st = out[b.strategy_id];
        if (!st) continue;
        const open = b.status === "open";
        const settled = b.status === "settled_won" || b.status === "settled_lost";
        if (!open && !settled) continue; // proposed / not_filled — not a prediction yet
        // A partial fixation ('partial') is a settled SLICE of a position whose
        // remaining part is still an open bet row — its money is real, but it is
        // NOT a separate prediction. Count its P&L, skip the prediction/inMatch
        // tallies so one logical position isn't counted twice.
        // A partial fixation is a slice of an open position; a 'void' is a
        // refunded, unscorable market. Neither is a distinct prediction — count
        // their (zero, for void) P&L but not a second prediction/in-match tally.
        const isPartialSlice = settled && (b.settled_by === "partial" || b.settled_by === "void");
        if (!isPartialSlice) { st.predictions++; seenMatch[b.strategy_id].add(m.id); }
        const inMatch = !isPartialSlice && !!b.entered_minute && /\d/.test(b.entered_minute); // a live minute, not "предматч"
        let pnl = 0;
        if (settled) {
          pnl = (b.payout ?? 0) - (b.stake ?? 0);
          if (pnl >= 0) st.earned += pnl; else st.lostMoney += -pnl;
          if (b.settled_by == null) { if (b.result === "won") st.won++; else st.lost++; } // real outcome only
        } else {
          const price = cur[b.market_label] ?? b.current_price ?? b.entry_price ?? 0; // current quote
          const entry = b.entry_price ?? 0;
          pnl = entry > 0 ? (b.stake ?? 0) * (price / entry - 1) : 0;
          st.openPnl += pnl;
          if (pnl >= 0) st.openPlus++; else st.openMinus++;
        }
        if (inMatch) { st.inMatch++; if (pnl >= 0) st.inMatchPlus++; else st.inMatchMinus++; }
      }
    }
  }
  for (const s of strategies) out[s.id].matches = seenMatch[s.id].size;
  return out;
}

/** Derived quality extras from the bet history: results split by ENTRY phase
 *  (pre-match vs in-match — the old "post-event" bucket is folded into
 *  in-match), the value of active management (actual realised vs holding every
 *  early close to resolution), and a per-match equity curve. */
function computeQualityExtras(matchById: Map<string, Match>, bets: Bet[], base: number): {
  phases: { id: string; label: string; bets: number; wins: number; pnl: number; clv: number | null }[];
  mgmt: { actualPnl: number; heldToEndPnl: number; managed: number };
  equity: number[] | undefined;
} {
  const isLive = (entered: string | null) => !!entered && /\d/.test(entered); // a minute → in-match entry
  const agg = { pre: { bets: 0, wins: 0, pnl: 0, clvSum: 0, clvN: 0 }, live: { bets: 0, wins: 0, pnl: 0, clvSum: 0, clvN: 0 } };
  let actualSum = 0, heldSum = 0, managed = 0;
  const perMatch: { t: string; pnl: number }[] = [];
  const byMatch = new Map<string, Bet[]>(); // group this strategy's bets by match
  for (const b of bets) (byMatch.get(b.match_id) ?? byMatch.set(b.match_id, []).get(b.match_id)!).push(b);
  {
    for (const [matchId, mbets] of byMatch) {
      const m = matchById.get(matchId);
      if (!m) continue;
      let matchPnl = 0, matchT: string | null = null;
      for (const b of mbets) {
        if (b.status !== "settled_won" && b.status !== "settled_lost") continue;
        const stake = b.stake ?? 0, entry = b.entry_price ?? 0;
        const pnl = (b.payout ?? 0) - stake;
        matchPnl += pnl;
        if (!matchT || b.created_at < matchT) matchT = b.created_at;
        const ph = isLive(b.entered_minute) ? agg.live : agg.pre;
        ph.pnl += pnl;
        // Only resolution-settled bets (settled_by == null) feed the prediction
        // tallies: an early/partial cash-out's `result` is booked by P&L sign
        // (not the real outcome) and its `closing_price` is the exit price (not
        // the kickoff/closing line), so counting them would let trading P&L
        // masquerade as win-rate / CLV — consistent with recomputeMetrics.
        const resolution = b.settled_by == null;
        if (resolution) { ph.bets++; if (b.result === "won") ph.wins++; }
        if (resolution && b.closing_price != null && entry) { ph.clvSum += b.closing_price - entry; ph.clvN++; }
        // management value: on a FINISHED match, compare the actual close to
        // holding the position to resolution.
        if (m.state === "finished" && m.score_home != null && m.score_away != null) {
          actualSum += pnl;
          const early = b.settled_by === "early" || b.settled_by === "partial";
          if (early) {
            const won = resolveFootballMarket(b.market_label, m.score_home, m.score_away, { home: m.home, away: m.away });
            if (won != null) { heldSum += (won ? (entry > 0 ? stake / (entry / 100) : 0) : 0) - stake; managed++; }
            else heldSum += pnl; // can't derive the held outcome → treat as neutral
          } else heldSum += pnl; // resolution / void: it WAS held to the end
        }
      }
      if (matchT) perMatch.push({ t: matchT, pnl: matchPnl });
    }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const mk = (id: string, label: string, a: typeof agg.pre) => ({ id, label, bets: a.bets, wins: a.wins, pnl: r2(a.pnl), clv: a.clvN ? r2(a.clvSum / a.clvN) : null });
  const phases = [mk("pre", "До матча", agg.pre), mk("live", "В течение матча", agg.live)];
  const mgmt = { actualPnl: r2(actualSum), heldToEndPnl: r2(heldSum), managed };
  let equity: number[] | undefined;
  if (base > 0 && perMatch.length) {
    perMatch.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
    let eq = base; const pts = [r2(base)];
    for (const x of perMatch) { eq += x.pnl; pts.push(r2(eq)); }
    if (pts.length > 1) equity = pts;
  }
  return { phases, mgmt, equity };
}

function buildFeed(
  db: Database,
  comps: { id: string; sport_id: string; name: string }[],
  strategies: { id: string; name: string; color: string | null }[],
  matchDb: Record<string, MatchView>,
): FeedItem[] {
  const stratById = Object.fromEntries(strategies.map((s) => [s.id, s]));
  const sportByComp = Object.fromEntries(comps.map((c) => [c.id, SPORT_LABELS[c.sport_id] ?? c.sport_id]));
  // Pull the globally most-recent rows per source (bounded LIMIT) and merge —
  // instead of scanning every match's log/reassessments/events. The final feed
  // is 40 rows, so ≥40 from each source is provably enough (at most 40 of the
  // top-40 can come from any single source).
  const N = 40, POOL = 60;
  const info = (matchId: string) => {
    const m = matchDb[matchId];
    if (!m) return null;
    return {
      sp: sportByComp[m.competitionId] ?? m.competitionId,
      match: `${m.home}–${m.away}`,
      score: (m.scoreHome != null && m.scoreAway != null) ? `${m.scoreHome}:${m.scoreAway}` : null,
    };
  };
  const rows: { at: string; item: FeedItem }[] = [];
  for (const e of R.recentTradeLog(db, POOL)) {
    // «Пропуски» were pure noise: every cron tick logs a skip per pair, which
    // floods this bounded window and buries the real entries/settlements. Drop
    // them from the feed entirely — the strategy card already explains why a
    // pair isn't entering, so the лента only carries P&L-affecting rows.
    if (e.type === "skip") continue;
    const inf = info(e.match_id); if (!inf) continue;
    const st = stratById[e.strategy_id];
    // enter → «Входы»; exit (cash-out) AND settle → «Расчёты» (both realize P&L).
    rows.push({ at: e.created_at, item: {
      t: e.minute ?? "", at: warsawClock(e.created_at), type: e.type === "enter" ? "enter" : "settle",
      sport: inf.sp, match: inf.match, score: inf.score, strat: st?.name, color: st?.color ?? undefined, text: e.text,
    } });
  }
  for (const r of R.recentReassessments(db, POOL)) {
    const inf = info(r.match_id); if (!inf) continue;
    const st = stratById[r.strategy_id];
    rows.push({ at: r.created_at, item: {
      t: r.minute ?? "", at: warsawClock(r.created_at), type: "reassess", sport: inf.sp, match: inf.match, score: inf.score,
      strat: st?.name, color: st?.color ?? undefined, text: r.body.slice(0, 120),
    } });
  }
  for (const e of R.recentMatchEvents(db, POOL)) {
    const inf = info(e.match_id); if (!inf) continue;
    const label = EVENT_LABEL[e.type] ?? "событие";
    rows.push({ at: e.created_at, item: {
      t: e.minute != null ? `${e.minute}'` : "", at: warsawClock(e.created_at), type: FEED_EVENT_TYPE[e.type] ?? "goal",
      sport: inf.sp, match: inf.match, score: inf.score, text: `${label}${e.team ? " · " + e.team : ""} — ${e.text}`,
    } });
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // newest first
  return rows.slice(0, N).map((r) => r.item);
}
