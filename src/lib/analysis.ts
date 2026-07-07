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
import { assessMatchLLM, assessFootballStructured, assessCategoryModifier, effectiveEnv, strategistDecide, resolveModel, type MatchAssessment, type FootballAnalysis, type CategoryDelta } from "./llm.js";
import { assembleFootball, type AssembledAnalysis } from "./assembler.js";
import { footballLabelProb } from "./footballMarkets.js";
import { impliedProbs, probSumFlags, sizePrematch } from "./strategist.js";
import { getProfileConfig } from "./riskConfig.js";
import { stratBudget } from "./money.js";

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

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Turn the ASSEMBLED football analysis (base + optional category modifier, already
 *  derived by the assembler) into the generic assessment: map each real market label
 *  to its derived probability and render a readable body carrying the scenario tree
 *  (the seed for live management) and any category notes. */
function footballToAssessment(as: AssembledAnalysis, home: string, away: string, marketLabels: string[]): MatchAssessment {
  const d = as.derived;
  const markets = marketLabels
    .map((label) => ({ label, prob: footballLabelProb(label, home, away, d) }))
    .filter((x): x is { label: string; prob: number } => x.prob != null);
  const conf = as.calibration.xg_confidence >= 0.7 ? "высокая" : as.calibration.xg_confidence >= 0.4 ? "средняя" : "низкая";
  const o = d.outcome_90;
  const verdict = `xG ${as.core.xg_home.toFixed(2)}–${as.core.xg_away.toFixed(2)} · П1 ${pct(o.home)} / X ${pct(o.draw)} / П2 ${pct(o.away)} · Over2.5 ${pct(d.totals_match["2.5"])} · BTTS ${pct(d.btts)}`;
  const short = `Тип: ${as.matchType}${as.matchTypeReason ? ` — ${as.matchTypeReason}` : ""}`;
  return { ok: true, confidence: conf, short, body: renderFootballBody(as), verdict, markets };
}

function renderFootballBody(as: AssembledAnalysis): string {
  const d = as.derived;
  const L: string[] = [];
  L.push(`Ядро: xG ${as.core.xg_home.toFixed(2)}–${as.core.xg_away.toFixed(2)}; доля 1-го тайма ${as.core.home_share_1h.toFixed(2)}/${as.core.away_share_1h.toFixed(2)}; поправка ${as.core.poisson_correction}.`);
  L.push(`Рынок (Пуассон): П1/X/П2 ${pct(d.outcome_90.home)}/${pct(d.outcome_90.draw)}/${pct(d.outcome_90.away)}; тоталы 1.5/2.5/3.5 ${pct(d.totals_match["1.5"])}/${pct(d.totals_match["2.5"])}/${pct(d.totals_match["3.5"])}; BTTS ${pct(d.btts)}.`);
  if (as.drivers.length) L.push("Драйверы: " + as.drivers.map((x) => `${x.factor} (${x.direction}, ${x.magnitude})`).join("; ") + ".");
  if (as.scenarios.length) L.push("Сценарии (для лайв-управления):\n" + as.scenarios.map((s) => `• ${s.trigger} (P≈${pct(s.prob)})${s.note ? ` — ${s.note}` : ""}`).join("\n"));
  if (as.categoryNotes) L.push("Категория (ЧМ и т.п.): " + as.categoryNotes);
  if (as.unknowns.length) L.push("Неизвестно: " + as.unknowns.join("; ") + ".");
  if (as.calibration.notes) L.push("Калибровка: " + as.calibration.notes);
  return L.join("\n");
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
  // Football (and any lineup-sport): NO pre-match analysis until the real starting
  // XI is published. The `lineup_out` flag isn't enough on its own — it also flips
  // on a pure ~1h-before-kickoff timer with no confirmed roster. Require actual
  // lineup data (без составов анализ не делаем). A live match's lineup is out by
  // definition, so it's never held here. Returned before any assessment is
  // recorded, so a match still waiting on lineups is «ждём состав», not a failure.
  if (R.awaitingLineup(db, match, sport)) {
    return { ok: false, error: "ждём состав — без стартового состава анализ не делаем", stage: "pre_lineup" };
  }
  const prompt = R.analyticsPromptFor(db, sport, match.competition_id);
  // A strategy/prompt whose saved model label was later removed would otherwise
  // abort the whole analyze with "неизвестная модель" — fall back to the default
  // instead of dead-ending.
  const DEFAULT_MODEL = deps.defaultModel ?? "Claude Opus 4.8";
  const safeModel = (m: string | null | undefined) => (m && resolveModel(m) ? m : DEFAULT_MODEL);
  const model = safeModel(prompt.model);
  const stage: "pre_lineup" | "post_lineup" = match.lineup_out ? "post_lineup" : "pre_lineup";

  // Key resolution: explicit deps.env wins (tests/callers); otherwise env vars
  // OR a key entered via the UI (Models screen), resolved from the DB.
  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  const ctx = matchContext(db, matchId); // real lineups + events, if enriched from ESPN
  // Football → two-layer analysis: Layer 1 (base) estimates CORE from the SPORT
  // prompt; if the competition carries a MODIFIER prompt (e.g. World Cup), Layer 2
  // returns only category deltas; a deterministic assembler folds them and CODE
  // derives every market by Poisson. Other sports keep the generic path. The
  // analyst never sees quotes either way.
  let a: MatchAssessment;
  // Numeric analysis calibration (0..1) for the profile's min_calibration gate —
  // the word confidence loses the number. Football fills it from the assembled
  // distribution; other sports map the word back to a band.
  let calibrationNum: number | null = null;
  if (sport === "football") {
    const basePrompt = R.analyticsPromptRow(db, "sport", sport)?.body ?? prompt.body;
    const base = await assessFootballStructured({ home: match.home, away: match.away, state: match.state, analyticsPrompt: basePrompt, marketLabels: markets.map((m) => m.label), context: ctx }, model, { fetchImpl: deps.fetchImpl, env });
    if (!base.ok) {
      a = { ok: false, confidence: "средняя", short: "", body: "", verdict: "", markets: [], error: base.error ?? "анализ не удался" };
    } else {
      const modifier = R.analyticsPromptRow(db, "competition", match.competition_id);
      let category: CategoryDelta | null = null;
      if (modifier?.body) category = await assessCategoryModifier(modifier.body, base, match.home, match.away, safeModel(modifier.model), { fetchImpl: deps.fetchImpl, env });
      const assembled = assembleFootball(base, category?.ok ? category : null);
      calibrationNum = assembled.calibration.xg_confidence;
      a = footballToAssessment(assembled, match.home, match.away, markets.map((m) => m.label));
      // Record the raw filled schema of EACH layer so the «Анализ» tab can show/
      // copy exactly what the base produced, what the ЧМ modifier changed, and the
      // assembled distribution — for review and tests. Best-effort; never blocks.
      const artAt = now();
      try {
        R.saveArtifact(db, { match_id: matchId, kind: "base", stage, content: JSON.stringify(base, null, 2), model, created_at: artAt });
        if (category?.ok) R.saveArtifact(db, { match_id: matchId, kind: "category", stage, content: JSON.stringify(category, null, 2), model: safeModel(modifier?.model), created_at: artAt });
        R.saveArtifact(db, { match_id: matchId, kind: "distribution", stage, content: JSON.stringify(assembled, null, 2), model, created_at: artAt });
      } catch { /* artifact recording is best-effort */ }
    }
  } else {
    a = await assessMatchLLM(
      { home: match.home, away: match.away, sport, state: match.state, analyticsPrompt: prompt.body, markets: markets.map((m) => ({ label: m.label })), context: ctx },
      model,
      { fetchImpl: deps.fetchImpl, env },
    );
  }

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

  const asmtAt = now();
  R.upsertAssessment(db, { id: R.uid(), match_id: matchId, stage, confidence: a.confidence, short: a.short, body: a.body, verdict: a.verdict, model, status: "ok", created_at: asmtAt });
  // Archive every successful run so the «Анализ» tab can show the history of the
  // model's reasoning, not just the latest (which the upsert above overwrites).
  R.appendAssessmentHistory(db, { id: R.uid(), match_id: matchId, stage, confidence: a.confidence, short: a.short, body: a.body, verdict: a.verdict, model, created_at: asmtAt });

  // update market ai_prob from the model. Match exactly on the normalized
  // label first; if the model paraphrased ("Over 2.5" vs "Over 2.5 goals"),
  // fall back to a token-subset match so minor wording drift doesn't silently
  // drop the probability (the distinctive number must still line up).
  const modelProbs = a.markets.map((mm) => ({ key: norm(mm.label), toks: tokenSet(mm.label), prob: mm.prob, used: false }));
  for (const m of markets) {
    const key = norm(m.label);
    const mt = tokenSet(m.label);
    // Exact normalized match first; consume the entry so it can't be reused.
    let hit = modelProbs.find((e) => !e.used && e.key === key);
    if (!hit) {
      // Fuzzy fallback ONLY when it's SAFE: numbers must line up and every extra
      // token is pure filler ("Over 2.5" ↔ "Over 2.5 goals"). This stops "Draw"
      // from grabbing "Draw no bet" (differs by the meaningful {no,bet}), and
      // requires a unique candidate so ambiguous labels aren't guessed.
      const cands = modelProbs.filter((e) => !e.used && numTokens(e.key) === numTokens(key) && extraAllFiller(mt, e.toks));
      if (cands.length === 1) hit = cands[0];
    }
    if (hit) { hit.used = true; if (hit.prob != null) R.setMarketAiProb(db, m.id, hit.prob); }
  }
  const freshMarkets = R.latestMarkets(db, matchId);

  // strategy decisions (§9.5: strategy reads analytics; §9.6: code sizes).
  // Only replace existing proposals if this run actually produced usable
  // probabilities — a degenerate run (no market label matched, all probs
  // invalid) must not wipe the previous good proposals with nothing to replace.
  const anyAiProb = freshMarkets.some((m) => m.ai_prob != null);
  if (!anyAiProb) {
    return { ok: true, stage, confidence: a.confidence, betsCreated: 0, decisions: [] };
  }
  R.clearProposedBets(db, matchId);
  // The budget unit is now a (strategy, risk-profile) PAIR: a competition can
  // fund the same strategy under several profiles, each with its own share.
  const strategyById = new Map(R.listStrategies(db, sport).map((s) => [s.id, s]));
  const pairs = R.sharesForComp(db, match.competition_id)
    .filter((sh) => sh.pct > 0 && (comp?.budget ?? 0) > 0 && strategyById.has(sh.strategy_id))
    .map((sh) => ({ strat: strategyById.get(sh.strategy_id)!, profile: sh.risk_profile_id, pct: sh.pct }));

  // Quotes → de-vigged implied probs, once (same for every pair). The strategist
  // is the FIRST layer to see prices (the analyst was blind); edge is computed
  // here, in code, off the cleaned prices.
  const quotes = freshMarkets.map((m) => ({ label: m.label, priceCents: m.price, liquidity: parseLiq(m.liquidity) }));
  const impliedMap = impliedProbs(quotes);

  let betsCreated = 0;
  const decisions: AnalyzeResult["decisions"] = [];
  for (const { strat, profile, pct } of pairs) {
    const budget = stratBudget(comp!.budget, pct);
    const pairLabel = `${strat.name} · ${profile}`;

    // Universal path: let the strategy's PROMPT (any methodology) pick the
    // markets + conviction. Code still sizes/gates (§9.6). If no key / the
    // strategist fails, fall back to the pure edge+threshold path below.
    const stratModel = safeModel(strat.model ?? model);
    // Positions THIS pair already holds (same strategy AND same profile).
    const openPos = R.betsForMatch(db, matchId, strat.id).filter((b) => b.status === "open" && (b.risk_profile_id ?? "medium") === profile);
    const dec = await strategistDecide({
      strategyName: strat.name, strategyPrompt: strat.prompt,
      match: { home: match.home, away: match.away, sport, state: match.state, minute: match.minute, scoreHome: match.score_home, scoreAway: match.score_away },
      assessment: { confidence: a.confidence, short: a.short, verdict: a.verdict },
      markets: freshMarkets.map((m) => ({ label: m.label, priceCents: m.price, aiProb: m.ai_prob })),
      openPositions: openPos.map((b) => ({ market: b.market_label, entryCents: b.entry_price ?? 0, currentCents: b.current_price ?? b.entry_price ?? 0 })),
      context: ctx,
    }, stratModel, { fetchImpl: deps.fetchImpl, env });
    const picksArr = dec.ok ? dec.picks : null;
    // Record the strategist's raw output per (strategy, profile) so the «Анализ»
    // tab can show/copy exactly what each pair decided (for review). Best-effort.
    try { R.saveArtifact(db, { match_id: matchId, kind: "strategist", label: pairLabel, stage, content: JSON.stringify(dec, null, 2), model: stratModel, created_at: now() }); } catch { /* best-effort */ }

    // Seed exposure from positions this pair ALREADY holds on the match, and
    // never re-propose on a market it's already in — otherwise the post-lineup
    // re-analysis would double up and breach the per-match budget cap (§9.3).
    const held = new Set(openPos.map((b) => norm(b.market_label)));
    // §9.3 budget cap is per-COMPETITION and per-PAIR: seed exposure + realized
    // from ALL of this (strategy, profile) pair's matches in the comp, so total
    // committed stake across concurrent matches can't exceed the pair's share.
    let exposure = strategyCompExposure(db, match.competition_id, strat.id, profile) - strategyCompRealized(db, match.competition_id, strat.id, profile);
    // money math is CODE, sized against the PAIR's risk profile (§9.6, module #3)
    const cfg = getProfileConfig(db, profile);
    const psFlags = probSumFlags(quotes, cfg);
    const calibration = calibrationNum ?? confBand(a.confidence);
    let matchExposure = openPos.reduce((s, b) => s + (b.stake ?? 0), 0);
    let entries = 0, skipped = 0, flagged = 0;
    const battle: any[] = [];
    // best de-vigged edges first
    const ranked = freshMarkets.filter((m) => m.ai_prob != null)
      .map((m) => { const implied = impliedMap.get(m.label)?.implied ?? m.price / 100; return { m, implied, edge: (m.ai_prob as number) - implied }; })
      .sort((x, y) => y.edge - x.edge);
    for (const { m, implied } of ranked) {
      // When the strategist ran, only its picks are eligible.
      const pick = picksArr?.find((p) => sameMarketLabel(p.label, m.label));
      if (picksArr && !pick) { skipped++; continue; }
      if (held.has(norm(m.label))) { skipped++; continue; } // already open on this market
      // Prefer the strategist's own probability when it gave one, else the analysis prob.
      const ourProb = pick?.prob != null ? pick.prob : (m.ai_prob as number);
      if (pick?.prob != null) R.setMarketAiProb(db, m.id, pick.prob);
      // Safeguard: a group whose prices don't sum near 1 is a bad/stale book — flag.
      if (psFlags.has(m.label)) { flagged++; battle.push({ market: m.label, status: "flag", reason: "prob_sum вне допуска" }); continue; }
      const r = sizePrematch({ ourProb, priceCents: m.price, implied, calibration, liquidity: parseLiq(m.liquidity), budget, matchExposure, compExposure: exposure, cfg });
      battle.push({ market: m.label, our_prob: round3(ourProb), implied: round3(implied), edge_pct: round3(r.edge * 100), status: r.status, stake: r.stake, kelly_fraction: round3(r.kellyFraction), reason: r.reason });
      if (r.status === "flag") { flagged++; continue; }
      if (r.status !== "enter") { skipped++; continue; }
      exposure += r.stake; matchExposure += r.stake; entries++;
      R.insertBet(db, {
        id: R.uid(), match_id: matchId, strategy_id: strat.id, risk_profile_id: profile, market_label: m.label,
        status: "proposed", proposed_price: m.price, entry_price: null, current_price: null,
        closing_price: null, ai_prob: ourProb, stake: r.stake,
        rationale: `«${m.label}»: edge ${(r.edge * 100).toFixed(1)}% (наша ${(ourProb * 100).toFixed(0)}% vs рынок ${(implied * 100).toFixed(0)}%). ${pick?.reason || r.reason}.`,
        entered_minute: null, result: null, payout: null, created_at: now(),
      });
    }
    // Battle-sheet artifact: the CODE-side sizing (edge/implied/stake/flags per
    // market) for the pair + the strategist's plan — for review and tests.
    try { R.saveArtifact(db, { match_id: matchId, kind: "battle_sheet", label: pairLabel, stage, content: JSON.stringify({ pair: pairLabel, profile, budget, calibration, positions: battle, flagged, strategist_plan: dec.ok ? dec : { ok: false } }, null, 2), model: stratModel, created_at: now() }); } catch { /* best-effort */ }
    // Discipline event: a funded, active strategy that looked at the match and
    // entered NOTHING (край недостаточен) — a valid «Пропуск» (ТЗ §4.2), so it
    // shows in the feed instead of the tab being permanently empty. One per
    // (match, strategy, run), not per-market, to avoid flooding the log.
    if (entries === 0 && (skipped + flagged) > 0) {
      const why = flagged > 0 && skipped === 0 ? `флаги предохранителей (${flagged})` : `край недостаточен (${skipped} ниже порога)`;
      R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: strat.id, minute: null, type: "skip", text: `пропуск матча — ${why}`, created_at: now() });
    }
    decisions.push({ strategy: pairLabel, entries, skipped });
    betsCreated += entries;
  }

  return { ok: true, stage, confidence: a.confidence, betsCreated, decisions };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const round3 = (x: number) => Math.round(x * 1000) / 1000;
/** Word confidence → a numeric band for the profile's min_calibration gate
 *  (used only for non-football, where there's no assembled xg_confidence). */
const confBand = (c: string) => (c === "высокая" ? 0.75 : c === "низкая" ? 0.3 : 0.5);
/** Parse a liquidity string ("$2.5M", "1234", "780K") to a number, or null. */
function parseLiq(s: string | null): number | null {
  if (s == null) return null;
  const m = String(s).replace(/[$,\s]/g, "").match(/^([\d.]+)\s*([mk]?)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  const suf = m[2].toLowerCase();
  return suf === "m" ? v * 1e6 : suf === "k" ? v * 1e3 : v;
}

/** Real lineups + in-match events (ESPN) as a compact context string for the
 *  analytics/strategist prompts — this is what makes reassessment meaningful. */
export function matchContext(db: Database, matchId: string): string | undefined {
  const live = R.getMatchLive(db, matchId);
  const fmt = (j: string | null) => { if (!j) return null; try { const l = JSON.parse(j); return `${l.team} (${l.formation ?? "?"}): ${(l.starters ?? []).slice(0, 11).join(", ")}`; } catch { return null; } };
  const parts: string[] = [];
  const m = R.getMatch(db, matchId);
  // Real match time incl. stoppage ("45'+2'") — so the model knows how much game
  // is actually left, not just the whole-minute figure.
  if (m?.state === "live" && m.clock) parts.push(`Время матча: ${m.clock}`);
  const h = fmt(live?.home_lineup ?? null), a = fmt(live?.away_lineup ?? null);
  if (h) parts.push(`Состав (дом) — ${h}`);
  if (a) parts.push(`Состав (гости) — ${a}`);
  // Live team statistics (possession, shots, chances) — the flow of play beyond
  // the scoreline; a core reassessment signal, not just the goal/card events.
  if (live?.stats) {
    try {
      const s = JSON.parse(live.stats) as { home: any; away: any };
      const line = (t: any) => (t && Array.isArray(t.items) ? t.items.map((it: any) => `${it.label} ${it.value}`).join(", ") : "");
      const hl = line(s.home), al = line(s.away);
      if (hl) parts.push(`Статистика (дом, ${s.home?.team ?? "?"}): ${hl}`);
      if (al) parts.push(`Статистика (гости, ${s.away?.team ?? "?"}): ${al}`);
    } catch { /* ignore malformed stats */ }
  }
  // Real match events only — drop our own "stats"/"other" market-price snapshots so
  // no quote-derived noise reaches the (price-blind) analyst or the strategist.
  const events = R.eventsForMatch(db, matchId).filter((e) => e.type !== "other" && e.type !== "stats");
  if (events.length) parts.push("События: " + events.map((e) => `${e.minute ?? "?"}' ${e.type}${e.team ? " " + e.team : ""}`).join("; "));
  return parts.length ? parts.join("\n") : undefined;
}
const tokenSet = (s: string) => new Set(norm(s).split(" ").filter(Boolean));
// Numbers a label carries (e.g. "over 2.5 goals" → "2.5"). Two labels can only
// fuzzy-match if their numbers are identical.
const numTokens = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).sort().join(",");
// Non-numeric words safe to differ between a market label and the model's
// paraphrase of it. Anything OUTSIDE this set changes the market's meaning.
const LABEL_FILLER = new Set(["goals", "goal", "total", "points", "point", "match", "result", "the", "full", "time", "of"]);
/** True iff every token present in exactly one of the two sets is pure filler. */
const extraAllFiller = (a: Set<string>, b: Set<string>): boolean => {
  for (const t of a) if (!b.has(t) && !LABEL_FILLER.has(t) && !/^\d/.test(t)) return false;
  for (const t of b) if (!a.has(t) && !LABEL_FILLER.has(t) && !/^\d/.test(t)) return false;
  return true;
};
/** Do two market labels refer to the same market? Exact (normalized) match, or a
 *  SAFE fuzzy match where the numbers line up and the only differing tokens are
 *  filler ("Over 2.5" ↔ "Over 2.5 goals") — never "Draw" ↔ "Draw no bet". Used
 *  to resolve the strategist's paraphrased pick/exit labels back to real markets. */
export function sameMarketLabel(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  return numTokens(na) === numTokens(nb) && extraAllFiller(tokenSet(a), tokenSet(b));
}

/** Open + still-proposed stake ($) a (strategy, profile) PAIR has committed across
 *  the WHOLE competition. The §9.3 budget cap is per-COMPETITION and per-pair —
 *  seeding the sizer with only the current match's exposure let a pair stake its
 *  full share on each of N concurrent matches (≈N× the budget). Pass profileId to
 *  scope to one pair; omit to sum the strategy across all profiles. */
export function strategyCompExposure(db: Database, competitionId: string, strategyId: string, profileId?: string): number {
  let sum = 0;
  for (const mt of R.listMatches(db, competitionId))
    for (const b of R.betsForMatch(db, mt.id, strategyId))
      if ((b.status === "open" || b.status === "proposed") && (profileId == null || (b.risk_profile_id ?? "medium") === profileId)) sum += b.stake ?? 0;
  return sum;
}
/** Realized P&L ($) a (strategy, profile) pair booked across the WHOLE competition
 *  (bankroll = budget + realized, so a loss elsewhere shrinks what's re-stakeable
 *  here). Pass profileId to scope to one pair; omit for the whole strategy. */
export function strategyCompRealized(db: Database, competitionId: string, strategyId: string, profileId?: string): number {
  let sum = 0;
  for (const mt of R.listMatches(db, competitionId))
    for (const b of R.betsForMatch(db, mt.id, strategyId))
      if ((b.status === "settled_won" || b.status === "settled_lost") && (profileId == null || (b.risk_profile_id ?? "medium") === profileId)) sum += (b.payout ?? 0) - (b.stake ?? 0);
  return sum;
}
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

/**
 * A 'running' job older than this is treated as stale — its background promise
 * died (crash/restart/another instance) and will never call finishAnalysisJob.
 * Comfortably longer than any real analyze round-trip (~30s LLM timeout).
 */
// One analyze is a CHAIN of LLM calls: 1 assessment + one strategist per funded
// strategy, each with a 120s ceiling (llm.ts). A legit run with several
// strategies can therefore take many minutes; a 5-min window flagged it stale
// mid-flight → false "таймаут" in the UI AND let a second run start concurrently
// (duplicate proposals). 10 min comfortably covers a realistic chain while still
// self-healing a genuinely dead job.
export const ANALYSIS_STALE_MS = 10 * 60_000;
export function jobActive(job: { status: string; started_at: string } | undefined, nowMs: number): boolean {
  if (!job || job.status !== "running") return false;
  const started = Date.parse(job.started_at);
  return !isNaN(started) && nowMs - started < ANALYSIS_STALE_MS;
}

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
  // Lineup gate (football): don't even fire the model until the real starting XI
  // is out — mirrors the guard in analyzeMatch, but rejects cheaply here so a
  // manual «Прогнать» shows «ждём состав» instead of launching a doomed run.
  const compForGate = R.listCompetitions(db).find((c) => c.id === match.competition_id);
  if (R.awaitingLineup(db, match, compForGate?.sport_id ?? "football")) {
    return { ok: false, error: "ждём состав — без стартового состава анализ не делаем" };
  }
  // An active (non-stale) running job means a real run is in flight — dedupe.
  // A stale 'running' row (dead promise) is not honored: we re-kick over it.
  if (jobActive(R.getAnalysisJob(db, matchId), Date.now())) return { ok: true, status: "analyzing" };

  R.startAnalysisJob(db, matchId, now(deps)());
  // Fire-and-forget: analyzeMatch records its own success/failure assessment
  // (§6); we mirror the outcome onto the durable job so any client/instance can
  // see that this run failed even when we kept the previous good assessment.
  void analyzeMatch(db, matchId, deps)
    .then(async (r) => {
      // A manual "Прогнать стратегию" must actually PLACE the bets it proposes —
      // otherwise they sit as «предлагается» until a cron tick happens to fill
      // them (and never, if the in-process cron isn't running). Fill immediately
      // at the current quote, the same step the cron/reassess run. Dynamic import
      // avoids the analysis⇄lifecycle import cycle; best-effort so a fill error
      // never masks a successful analysis.
      if (r.ok) {
        try { const { autoEnter } = await import("./lifecycle.js"); await autoEnter(db, deps); } catch { /* fill is best-effort */ }
      }
      R.finishAnalysisJob(db, matchId, !r.ok, r.error ?? null, now(deps)());
    })
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
  if (job.status === "running") {
    return jobActive(job, Date.now())
      ? { status: "analyzing" }
      : { status: "done", failed: true, error: "анализ прервался (таймаут)" };
  }
  return { status: "done", failed: job.status === "failed", error: job.error ?? undefined };
}
