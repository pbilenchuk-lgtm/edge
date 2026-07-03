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
    // ТЗ §6: record the failure, don't block the match — but never clobber a
    // previously GOOD assessment of this stage with an empty failed row (a
    // failed re-run must not destroy the last usable analysis). The failure is
    // still surfaced to the caller (and, for the async path, via the run
    // registry) so the user sees it.
    const priorOk = R.assessmentsForMatch(db, matchId).some((x) => x.stage === stage && x.status === "ok");
    if (!priorOk) {
      R.upsertAssessment(db, { id: R.uid(), match_id: matchId, stage, confidence: null, short: null, body: null, verdict: null, model, status: "failed", created_at: now() });
    }
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
//
// Run state lives in the DB (`analysis_jobs`), not process memory, so it
// survives navigation/reload (the UI re-derives "analyzing" from the payload
// and resumes polling) and process restart (orphaned 'running' rows are
// reconciled to 'failed' on boot — see db.ts). With a shared DB it is also
// visible across instances; the background promise still runs on one instance.
// ============================================================

const now = (deps: AnalyzeDeps) => deps.now ?? (() => new Date().toISOString());

export interface StartResult { ok: boolean; status?: "analyzing"; error?: string }

/**
 * Cheap synchronous pre-checks (match/markets exist), then fire the model call
 * WITHOUT awaiting. Idempotent while running: a second call for the same match
 * sees the 'running' job and reports "analyzing" instead of launching a
 * duplicate LLM request.
 */
export function startAnalysis(db: Database, matchId: string, deps: AnalyzeDeps = {}): StartResult {
  const match = R.getMatch(db, matchId);
  if (!match) return { ok: false, error: "матч не найден" };
  if (!R.latestMarkets(db, matchId).length) {
    return { ok: false, error: "у матча нет рынков — сначала подтяни котировки (Polymarket)" };
  }
  if (R.getAnalysisJob(db, matchId)?.status === "running") return { ok: true, status: "analyzing" };

  R.startAnalysisJob(db, matchId, now(deps)());
  // Fire-and-forget: analyzeMatch records its own success/failure assessment
  // (§6); we mirror the outcome onto the durable job so any client/instance can
  // see that this run failed even when we kept the previous good assessment.
  void analyzeMatch(db, matchId, deps)
    .then((r) => R.finishAnalysisJob(db, matchId, !r.ok, r.error ?? null, now(deps)()))
    .catch((e) => R.finishAnalysisJob(db, matchId, true, e instanceof Error ? e.message : String(e), now(deps)()));
  return { ok: true, status: "analyzing" };
}

export interface AnalysisStatus {
  status: "analyzing" | "done" | "idle";
  failed?: boolean;
  error?: string;
}

/** Poll target: "analyzing" while the model runs, else the last run's outcome. */
export function analysisStatus(db: Database, matchId: string): AnalysisStatus {
  const job = R.getAnalysisJob(db, matchId);
  if (!job) return { status: "idle" };
  if (job.status === "running") return { status: "analyzing" };
  return { status: "done", failed: job.status === "failed", error: job.error ?? undefined };
}
