// ============================================================
// EDGE LAB — view assembler  [SERVER-ONLY]
// Transforms DB rows into the payload the UI consumes (shapes mirror the
// reference mockup so rendering code ports over near-verbatim).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { providerEnabled } from "./llm.js";
import type { StrategyParams } from "./types.js";

export interface MarketView {
  id: string; label: string; price: number; aiProb: number | null;
  liq: string | null; tokenId: string | null;
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
  minute: number | null; scoreHome: number | null; scoreAway: number | null;
  lineupOut: boolean; kickoff: string | null; oddsUpdated: string | null;
  finalScore: string | null; kickoffTime: string | null; endTime: string | null;
  duration: string | null; endNote: string | null;
  preLineup: AssessmentView | null; postLineup: AssessmentView | null;
  markets: MarketView[];
  bets: Record<string, { rationale: string | null; items: BetItemView[] }>;
  reassessByStrat: Record<string, { min: string | null; text: string; conf: string | null }[]>;
  logByStrat: Record<string, { min: string | null; text: string; type: string }[]>;
  settledBets: Record<string, { market: string; stake: number; result: string; payout: number }[]>;
  result: Record<string, number>;
}
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
}

const PROVIDER_DEFS: Omit<ProviderView, "hasKey">[] = [
  { id: "anthropic", name: "Anthropic", keyHint: "sk-ant-…", models: ["Claude Opus 4.8", "Claude Sonnet 5", "Claude Haiku 4.5", "Claude Fable 5"] },
  { id: "openai", name: "OpenAI", keyHint: "sk-…", models: ["GPT-5", "GPT-5 mini", "o4"] },
  { id: "google", name: "Google", keyHint: "AIza…", models: ["Gemini 2.5 Pro", "Gemini 2.5 Flash"] },
];

export function buildAppData(db: Database, env = process.env): AppData {
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
      const assessments = R.assessmentsForMatch(db, m.id);
      const pre = assessments.find((a) => a.stage === "pre_lineup");
      const post = assessments.find((a) => a.stage === "post_lineup");
      const markets = R.latestMarkets(db, m.id).map((mk) => ({
        id: mk.id, label: mk.label, price: mk.price, aiProb: mk.ai_prob, liq: mk.liquidity, tokenId: mk.external_ref,
      }));
      const allBets = R.betsForMatch(db, m.id);
      const bets: MatchView["bets"] = {};
      const settledBets: MatchView["settledBets"] = {};
      const result: Record<string, number> = {};
      for (const b of allBets) {
        if (b.status === "settled_won" || b.status === "settled_lost") {
          (settledBets[b.strategy_id] ||= []).push({
            market: b.market_label, stake: b.stake ?? 0, result: b.result ?? "lost", payout: b.payout ?? 0,
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

      matchDb[m.id] = {
        id: m.id, competitionId: m.competition_id, home: m.home, away: m.away, state: m.state,
        minute: m.minute, scoreHome: m.score_home, scoreAway: m.score_away, lineupOut: m.lineup_out,
        kickoff: m.kickoff_at, oddsUpdated: null, finalScore: m.final_score, kickoffTime: m.kickoff_time,
        endTime: m.end_time, duration: m.duration, endNote: m.end_note,
        preLineup: pre ? view(pre) : null, postLineup: post ? view(post) : null,
        markets, bets, reassessByStrat, logByStrat, settledBets, result,
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

  const providers: ProviderView[] = PROVIDER_DEFS.map((p) => ({
    ...p, hasKey: providerEnabled(p.id as any, env),
  }));

  return { treasuryTotal: treasury.total_balance, sports, competitions, compBudget, shares, catalog, analysis, matchDb, quality, eventFeed, providers };
}

function view(a: { confidence: string | null; short: string | null; body: string | null; verdict: string | null; status: string }): AssessmentView {
  return { confidence: a.confidence, short: a.short, text: a.body, verdict: a.verdict, status: a.status };
}

function buildFeed(
  db: Database,
  comps: { id: string; sport_id: string; name: string }[],
  strategies: { id: string; name: string; color: string | null }[],
  matchDb: Record<string, MatchView>,
): FeedItem[] {
  const stratById = Object.fromEntries(strategies.map((s) => [s.id, s]));
  const sportLabel: Record<string, string> = { football: "Футбол", tennis: "Теннис" };
  const items: FeedItem[] = [];
  for (const c of comps) {
    for (const mid of R.listMatches(db, c.id).map((m) => m.id)) {
      const m = matchDb[mid];
      const matchName = `${m.home}–${m.away}`;
      const sp = sportLabel[c.sport_id] ?? c.sport_id;
      for (const [sid, entries] of Object.entries(m.logByStrat)) {
        for (const e of entries) {
          const st = stratById[sid];
          items.push({
            t: e.min ?? "", type: e.type === "settle" ? "settle" : e.type === "exit" ? "reassess" : "enter",
            sport: sp, match: matchName, strat: st?.name, color: st?.color ?? undefined, text: e.text,
          });
        }
      }
      for (const [sid, rs] of Object.entries(m.reassessByStrat)) {
        for (const r of rs) {
          const st = stratById[sid];
          items.push({ t: r.min ?? "", type: "reassess", sport: sp, match: matchName, strat: st?.name, color: st?.color ?? undefined, text: r.text.slice(0, 120) });
        }
      }
    }
  }
  return items.slice(0, 40);
}
