// ============================================================
// EDGE LAB — view assembler  [SERVER-ONLY]
// Transforms DB rows into the payload the UI consumes (shapes mirror the
// reference mockup so rendering code ports over near-verbatim).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { providerEnabled, effectiveEnv } from "./llm.js";
import { jobActive } from "./analysis.js";
import { warsawLabel } from "./time.js";
import type { StrategyParams } from "./types.js";

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
  status: string; entered?: string | null;
}
export interface MatchView {
  id: string; competitionId: string; home: string; away: string; state: string;
  minute: number | null; clock: string | null; scoreHome: number | null; scoreAway: number | null;
  lineupOut: boolean; kickoff: string | null; oddsUpdated: string | null;
  finalScore: string | null; kickoffTime: string | null; endTime: string | null;
  duration: string | null; endNote: string | null;
  /** a per-match LLM analyze run is in flight (durable; survives reload) */
  analyzing: boolean;
  preLineup: AssessmentView | null; postLineup: AssessmentView | null;
  markets: MarketView[];
  bets: Record<string, { rationale: string | null; items: BetItemView[] }>;
  reassessByStrat: Record<string, { min: string | null; text: string; conf: string | null }[]>;
  logByStrat: Record<string, { min: string | null; text: string; type: string }[]>;
  settledBets: Record<string, { market: string; stake: number; result: string; payout: number; settledBy: string | null; closedPct: number }[]>;
  result: Record<string, number>;
  /** real lineups (ESPN), if enriched — shown under the СОСТАВ toggle */
  lineups: { home: LineupView | null; away: LineupView | null } | null;
  /** real in-match events (ESPN): goals / cards / subs, newest last */
  events: { minute: number | null; type: string; team: string | null; text: string }[];
}
export interface LineupView { team: string; formation: string | null; starters: string[] }
export interface StrategyView {
  id: string; name: string; tag: string | null; color: string; version: number;
  sport: string; model: string | null; prompt: string; params: StrategyParams;
}
export interface QualityView {
  brier: number | null; clv: number | null; samples: number;
  calib: { bucket: string; predicted: number; actual: number }[];
}
export interface FeedItem {
  t: string; type: string; sport: string; match: string; strat?: string;
  color?: string; text: string; pnl?: number;
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
  shares: Record<string, Record<string, number>>;
  catalog: StrategyView[];
  analysis: { modelBySport: Record<string, string>; bySport: Record<string, string>; byComp: Record<string, string> };
  matchDb: Record<string, MatchView>;
  quality: Record<string, QualityView>;
  eventFeed: FeedItem[];
  providers: ProviderView[];
  cron: CronView;
  strategyStats: Record<string, StrategyStats>;
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

  const compBudget: Record<string, number> = {};
  const shares: Record<string, Record<string, number>> = {};
  const competitions = comps.map((c) => {
    compBudget[c.id] = c.budget;
    const sh = R.sharesForComp(db, c.id);
    if (sh.length) shares[c.id] = Object.fromEntries(sh.map((s) => [s.strategy_id, s.pct]));
    return { id: c.id, sport: c.sport_id, name: c.name, matches: R.listMatches(db, c.id).map((m) => m.id) };
  });

  const catalog: StrategyView[] = strategies.map((s) => ({
    id: s.id, name: s.name, tag: s.tag, color: s.color ?? "#8b95a5", version: s.version,
    sport: s.sport_id, model: s.model, prompt: s.prompt, params: s.params,
  }));

  // analytics maps
  const analysis = { modelBySport: {} as Record<string, string>, bySport: {} as Record<string, string>, byComp: {} as Record<string, string> };
  for (const p of R.allAnalyticsPrompts(db)) {
    if (p.scope === "sport") { analysis.bySport[p.scope_id] = p.body; if (p.model) analysis.modelBySport[p.scope_id] = p.model; }
    else analysis.byComp[p.scope_id] = p.body;
  }

  // matches
  const matchDb: Record<string, MatchView> = {};
  for (const c of comps) {
    for (const m of R.listMatches(db, c.id)) {
      // Only surface completed assessments; a failed run (§6) is reported to
      // the user via the analyze poll, not as an empty analysis card.
      const assessments = R.assessmentsForMatch(db, m.id).filter((a) => a.status !== "failed");
      const pre = assessments.find((a) => a.stage === "pre_lineup");
      const post = assessments.find((a) => a.stage === "post_lineup");
      const kickoff = R.openOddsFor(db, m.id); // price at kickoff (empty pre-match)
      const markets = R.latestMarkets(db, m.id).map((mk) => ({
        id: mk.id, label: mk.label, price: mk.price, aiProb: mk.ai_prob, liq: mk.liquidity, tokenId: mk.external_ref,
        openCents: mk.label in kickoff ? kickoff[mk.label] : null,
      }));
      const allBets = R.betsForMatch(db, m.id);
      const bets: MatchView["bets"] = {};
      const settledBets: MatchView["settledBets"] = {};
      const result: Record<string, number> = {};
      for (const b of allBets) {
        if (b.status === "settled_won" || b.status === "settled_lost") {
          // How much of the position this close represents: a partial fixation
          // stamps «частичная фиксация NN%» into the rationale; a full early
          // close / resolution is 100%.
          const pctM = b.settled_by === "partial" ? /(\d+)\s*%/.exec(b.rationale ?? "") : null;
          const closedPct = pctM ? Number(pctM[1]) : 100;
          (settledBets[b.strategy_id] ||= []).push({
            market: b.market_label, stake: b.stake ?? 0, result: b.result ?? "lost", payout: b.payout ?? 0,
            settledBy: b.settled_by ?? null, closedPct,
          });
          result[b.strategy_id] = (result[b.strategy_id] ?? 0) + ((b.payout ?? 0) - (b.stake ?? 0));
        } else {
          const grp = (bets[b.strategy_id] ||= { rationale: null, items: [] });
          if (!grp.rationale && b.rationale) grp.rationale = b.rationale;
          grp.items.push({
            market: b.market_label, price: b.proposed_price ?? b.entry_price, aiProb: b.ai_prob,
            stake: b.stake ?? undefined, entryPrice: b.entry_price, currentPrice: b.current_price,
            status: b.status, entered: b.entered_minute,
          });
        }
      }
      const reassessByStrat: MatchView["reassessByStrat"] = {};
      for (const r of R.reassessmentsForMatch(db, m.id))
        (reassessByStrat[r.strategy_id] ||= []).push({ min: r.minute, text: r.body, conf: r.confidence });
      const logByStrat: MatchView["logByStrat"] = {};
      for (const l of R.tradeLogForMatch(db, m.id))
        (logByStrat[l.strategy_id] ||= []).push({ min: l.minute, text: l.text, type: l.type });

      // real lineups + events from ESPN enrichment (if any)
      const live = R.getMatchLive(db, m.id);
      const parseLineup = (j: string | null): LineupView | null => { if (!j) return null; try { const l = JSON.parse(j); return { team: l.team ?? "?", formation: l.formation ?? null, starters: Array.isArray(l.starters) ? l.starters : [] }; } catch { return null; } };
      const lineups = live && (live.home_lineup || live.away_lineup)
        ? { home: parseLineup(live.home_lineup), away: parseLineup(live.away_lineup) } : null;
      const events = R.eventsForMatch(db, m.id).filter((e) => e.type !== "other")
        .map((e) => ({ minute: e.minute, type: e.type, team: e.team, text: e.text }));

      matchDb[m.id] = {
        id: m.id, competitionId: m.competition_id, home: m.home, away: m.away, state: m.state,
        minute: m.minute, clock: m.clock ?? null, scoreHome: m.score_home, scoreAway: m.score_away, lineupOut: m.lineup_out,
        kickoff: warsawLabel(m.kickoff_at), oddsUpdated: null, finalScore: m.final_score, kickoffTime: m.kickoff_time,
        endTime: m.end_time, duration: m.duration, endNote: m.end_note,
        analyzing: jobActive(R.getAnalysisJob(db, m.id), nowMs),
        preLineup: pre ? view(pre) : null, postLineup: post ? view(post) : null,
        markets, bets, reassessByStrat, logByStrat, settledBets, result, lineups, events,
      };
    }
  }

  // quality
  const quality: Record<string, QualityView> = {};
  for (const s of strategies) {
    const q = R.getQuality(db, s.id);
    if (q) quality[s.id] = { brier: q.brier, clv: q.clv, samples: q.samples, calib: q.calibration };
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

  const strategyStats = computeStrategyStats(db, strategies);

  const payload: AppData = { treasuryTotal: treasury.total_balance, sports, competitions, compBudget, shares, catalog, analysis, matchDb, quality, eventFeed, providers, cron, strategyStats };
  // node:sqlite rows have a null prototype; React Server Components can't pass
  // those to a client component. A JSON round-trip yields plain objects.
  return JSON.parse(JSON.stringify(payload));
}

function view(a: { confidence: string | null; short: string | null; body: string | null; verdict: string | null; status: string }): AssessmentView {
  return { confidence: a.confidence, short: a.short, text: a.body, verdict: a.verdict, status: a.status };
}

const EVENT_LABEL: Record<string, string> = { goal: "⚽ гол", red_card: "🟥 красная", yellow_card: "🟨 жёлтая", sub: "🔁 замена" };
// The feed filters group all match events under "События матча" (type "goal").
const FEED_EVENT_TYPE: Record<string, string> = { goal: "goal", red_card: "card", yellow_card: "card", sub: "sub" };

/** Detailed per-strategy stats — open positions marked to the FRESHEST market
 *  price (not the price stored on the bet), so +/- reflects the current line. */
function computeStrategyStats(db: Database, strategies: { id: string }[]): Record<string, StrategyStats> {
  const out: Record<string, StrategyStats> = {};
  const seenMatch: Record<string, Set<string>> = {};
  for (const s of strategies) {
    out[s.id] = { matches: 0, predictions: 0, won: 0, lost: 0, openPlus: 0, openMinus: 0, openPnl: 0, earned: 0, lostMoney: 0, inMatch: 0, inMatchPlus: 0, inMatchMinus: 0 };
    seenMatch[s.id] = new Set();
  }
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      const cur: Record<string, number> = {}; // freshest quote per market label
      for (const mk of R.latestMarkets(db, m.id)) if (!(mk.label in cur)) cur[mk.label] = mk.price;
      for (const b of R.betsForMatch(db, m.id)) {
        const st = out[b.strategy_id];
        if (!st) continue;
        const open = b.status === "open";
        const settled = b.status === "settled_won" || b.status === "settled_lost";
        if (!open && !settled) continue; // proposed / not_filled — not a prediction yet
        st.predictions++;
        seenMatch[b.strategy_id].add(m.id);
        const inMatch = !!b.entered_minute && /\d/.test(b.entered_minute); // a live minute, not "предматч"
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

function buildFeed(
  db: Database,
  comps: { id: string; sport_id: string; name: string }[],
  strategies: { id: string; name: string; color: string | null }[],
  matchDb: Record<string, MatchView>,
): FeedItem[] {
  const stratById = Object.fromEntries(strategies.map((s) => [s.id, s]));
  const sportLabel: Record<string, string> = { football: "Футбол", tennis: "Теннис" };
  // Collect with each source row's created_at so the feed is the 40 MOST RECENT
  // events across all matches, not the first 40 in iteration order.
  const rows: { at: string; item: FeedItem }[] = [];
  for (const c of comps) {
    const sp = sportLabel[c.sport_id] ?? c.sport_id;
    for (const mt of R.listMatches(db, c.id)) {
      const m = matchDb[mt.id];
      const matchName = `${m.home}–${m.away}`;
      for (const e of R.tradeLogForMatch(db, mt.id)) {
        const st = stratById[e.strategy_id];
        rows.push({ at: e.created_at, item: {
          t: e.minute ?? "", type: e.type === "settle" ? "settle" : e.type === "exit" ? "reassess" : "enter",
          sport: sp, match: matchName, strat: st?.name, color: st?.color ?? undefined, text: e.text,
        } });
      }
      for (const r of R.reassessmentsForMatch(db, mt.id)) {
        const st = stratById[r.strategy_id];
        rows.push({ at: r.created_at, item: {
          t: r.minute ?? "", type: "reassess", sport: sp, match: matchName,
          strat: st?.name, color: st?.color ?? undefined, text: r.body.slice(0, 120),
        } });
      }
      // real in-match events pulled from ESPN (goals / cards / subs)
      for (const e of R.eventsForMatch(db, mt.id)) {
        if (e.type === "other") continue;
        const label = EVENT_LABEL[e.type] ?? "событие";
        rows.push({ at: e.created_at, item: {
          t: e.minute != null ? `${e.minute}'` : "", type: FEED_EVENT_TYPE[e.type] ?? "goal",
          sport: sp, match: matchName, text: `${label}${e.team ? " · " + e.team : ""} — ${e.text}`,
        } });
      }
    }
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // newest first
  return rows.slice(0, 40).map((r) => r.item);
}
