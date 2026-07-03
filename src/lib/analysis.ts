// ============================================================
// EDGE LAB — LLM match analysis + strategy decisions (ТЗ §3.3)  [SERVER-ONLY]
//
// Two intellects, kept separate (§9.5):
//   1) Analytics — Claude assesses the match OBJECTIVELY (probabilities +
//      narrative), knowing nothing about money. Stored as an assessment;
//      each market gets ai_prob.
//   2) Strategy — reads the assessment, computes edge, and the ENGINE (code,
//      §9.6) sizes the bet. Proposed bets are created per strategy.
// Graceful: a failed model call marks the assessment failed (§6), no crash.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { assessMatchLLM } from "./llm.js";
import { sizeBet } from "./thresholds.js";
import { edgePct } from "./edge.js";
import { stratBudget } from "./money.js";
import type { Confidence } from "./types.js";

export interface AnalyzeDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => string;
  defaultModel?: string;
}

export interface AnalyzeResult {
  ok: boolean;
  error?: string;
  stage?: "pre_lineup" | "post_lineup";
  confidence?: string;
  betsCreated?: number;
  decisions?: { strategy: string; entries: number; skipped: number }[];
}

export async function analyzeMatch(
  db: Database, matchId: string, deps: AnalyzeDeps = {},
): Promise<AnalyzeResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const match = R.getMatch(db, matchId);
  if (!match) return { ok: false, error: "матч не найден" };

  const markets = R.latestMarkets(db, matchId);
  if (!markets.length) return { ok: false, error: "у матча нет рынков — сначала подтяни котировки (Polymarket)" };

  const comp = R.listCompetitions(db).find((c) => c.id === match.competition_id);
  const sport = comp?.sport_id ?? "football";
  const prompt = R.analyticsPromptFor(db, sport, match.competition_id);
  const model = prompt.model ?? deps.defaultModel ?? "Claude Opus 4.8";
  const stage: "pre_lineup" | "post_lineup" = match.lineup_out ? "post_lineup" : "pre_lineup";

  const a = await assessMatchLLM(
    { home: match.home, away: match.away, sport, state: match.state, analyticsPrompt: prompt.body, markets: markets.map((m) => ({ label: m.label, price: m.price })) },
    model,
    { fetchImpl: deps.fetchImpl, env: deps.env },
  );

  if (!a.ok) {
    // ТЗ §6: record the failure, don't block the match.
    R.upsertAssessment(db, { id: R.uid(), match_id: matchId, stage, confidence: null, short: null, body: null, verdict: null, model, status: "failed", created_at: now() });
    return { ok: false, error: a.error ?? "оценка не удалась", stage };
  }

  R.upsertAssessment(db, { id: R.uid(), match_id: matchId, stage, confidence: a.confidence, short: a.short, body: a.body, verdict: a.verdict, model, status: "ok", created_at: now() });

  // update market ai_prob from the model
  const probByLabel = new Map(a.markets.map((m) => [norm(m.label), m.prob]));
  for (const m of markets) {
    const p = probByLabel.get(norm(m.label));
    if (p != null) R.setMarketAiProb(db, m.id, p);
  }
  const freshMarkets = R.latestMarkets(db, matchId);

  // strategy decisions (§9.5: strategy reads analytics; §9.6: code sizes)
  R.clearProposedBets(db, matchId);
  const strategies = R.listStrategies(db, sport).filter((s) => {
    const share = R.sharesForComp(db, match.competition_id).find((x) => x.strategy_id === s.id);
    return share && share.pct > 0 && (comp?.budget ?? 0) > 0;
  });

  let betsCreated = 0;
  const decisions: AnalyzeResult["decisions"] = [];
  for (const strat of strategies) {
    const share = R.sharesForComp(db, match.competition_id).find((x) => x.strategy_id === strat.id)!;
    const budget = stratBudget(comp!.budget, share.pct);
    let exposure = 0, entries = 0, skipped = 0;
    // best edges first
    const ranked = freshMarkets.filter((m) => m.ai_prob != null)
      .map((m) => ({ m, edge: edgePct(m.ai_prob as number, m.price) }))
      .sort((x, y) => y.edge - x.edge);
    for (const { m } of ranked) {
      const d = sizeBet({ params: strat.params, aiProb: m.ai_prob as number, priceCents: m.price, budget, exposure, confidence: a.confidence as Confidence });
      if (!d.enter) { skipped++; continue; }
      exposure += d.stake;
      entries++;
      R.insertBet(db, {
        id: R.uid(), match_id: matchId, strategy_id: strat.id, market_label: m.label,
        status: "proposed", proposed_price: m.price, entry_price: null, current_price: null,
        closing_price: null, ai_prob: m.ai_prob, stake: d.stake,
        rationale: `«${m.label}»: край ${d.edge.toFixed(1)}%. ${d.reason}.`,
        entered_minute: null, result: null, payout: null, created_at: now(),
      });
    }
    decisions.push({ strategy: strat.name, entries, skipped });
    betsCreated += entries;
  }

  return { ok: true, stage, confidence: a.confidence, betsCreated, decisions };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// ============================================================
// Async, per-match orchestration (discover/analyze split).
//
// The list route (buildAppData) and `sync` are pure/DB-only — matches show up
// instantly. The expensive LLM path is dragged POINTWISE, per match, and runs
// OFF the request/response cycle: `startAnalysis` validates cheaply, kicks the
// model call into the background, and returns at once, so the HTTP request is
// never held open for the whole round-trip (no gateway timeouts / "hangs").
// The UI polls `analysisStatus` until it flips off "analyzing", then reloads.
// In-flight state is a process-local set (single-process Node server); on
// restart nothing is in flight and status falls back to the stored assessment.
// ============================================================

const inFlight = new Set<string>();

export interface StartResult { ok: boolean; status?: "analyzing"; error?: string }

/**
 * Cheap synchronous pre-checks (match/markets exist), then fire the model call
 * WITHOUT awaiting. Idempotent while running: a second call for the same match
 * just reports "analyzing" instead of launching a duplicate LLM request.
 */
export function startAnalysis(db: Database, matchId: string, deps: AnalyzeDeps = {}): StartResult {
  const match = R.getMatch(db, matchId);
  if (!match) return { ok: false, error: "матч не найден" };
  if (!R.latestMarkets(db, matchId).length) {
    return { ok: false, error: "у матча нет рынков — сначала подтяни котировки (Polymarket)" };
  }
  if (inFlight.has(matchId)) return { ok: true, status: "analyzing" };

  inFlight.add(matchId);
  // Fire-and-forget: analyzeMatch records its own success/failure assessment
  // (§6), so we only need to release the in-flight slot when it settles.
  void analyzeMatch(db, matchId, deps)
    .catch(() => {}) // analyzeMatch is graceful; guard against unexpected throws
    .finally(() => inFlight.delete(matchId));
  return { ok: true, status: "analyzing" };
}

export interface AnalysisStatus {
  status: "analyzing" | "done" | "idle";
  failed?: boolean;
  stage?: string;
}

/** Poll target: "analyzing" while the model runs, else the stored outcome. */
export function analysisStatus(db: Database, matchId: string): AnalysisStatus {
  if (inFlight.has(matchId)) return { status: "analyzing" };
  const rows = R.assessmentsForMatch(db, matchId);
  if (!rows.length) return { status: "idle" };
  const latest = rows.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
  return { status: "done", failed: latest.status === "failed", stage: latest.stage };
}
