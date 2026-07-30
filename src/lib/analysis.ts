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

import { isRailPrice } from "./zombieMarket.js";
import { recordRefusalForMatch } from "./refusalShadow.js";
import type { Database } from "./db.js";
import * as R from "./repo.js";
import { assessMatchLLM, assessFootballStructured, assessCategoryModifier, effectiveEnv, strategistDecide, resolveModel, type MatchAssessment, type FootballAnalysis, type CategoryDelta } from "./llm.js";
import { assembleFootball, type AssembledAnalysis } from "./assembler.js";
import { footballLabelProb } from "./footballMarkets.js";
import { impliedProbs, probSumFlags, sizePrematch, correlationKey } from "./strategist.js";
import { matchThesisRoom, bankUsd } from "./thesisExposure.js";
import { marketFamily } from "./signals.js";
import { recordFamilyShadowSignal, killedFamilies, isDemotedFamily } from "./familyShadow.js";
import { getProfileConfig } from "./riskConfig.js";
import { stratBudget } from "./money.js";
import { winsOnEventOccurrence } from "./thresholds.js";
import { serializeEntryMeta, type BetEntryMeta } from "./betMeta.js";
import { effectiveCodeVersion } from "./codeEpoch.js";
import { loadAnalysisDuel, pickAnalysisModel, analysisModelTag } from "./analysisDuel.js";

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
  db: Database, matchId: string, deps: AnalyzeDeps = {}, opts: { skipStrategists?: boolean; allowNoLineup?: boolean } = {},
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
  // …unless the CALLER has established that no teamsheet is coming. The gate assumes lineups are merely
  // late; for a fixture with no provider binding at all there is nothing to wait for, and waiting means the
  // analysis only ever runs after kickoff (state='live' is what clears this gate), which stamps the decision
  // origin='live' and makes ft_blind refuse it. The blind-fixture judgement lives in ONE place — autoAnalyze,
  // which knows the anchor window and the feed state — and is passed down explicitly rather than re-derived
  // here, so the two call sites cannot drift into disagreeing about what "blind" means.
  if (!opts.allowNoLineup && R.awaitingLineup(db, match, sport)) {
    return { ok: false, error: "ждём состав — без стартового состава анализ не делаем", stage: "pre_lineup" };
  }
  const prompt = R.analyticsPromptFor(db, sport, match.competition_id);
  // A strategy/prompt whose saved model label was later removed would otherwise
  // abort the whole analyze with "неизвестная модель" — fall back to the default
  // instead of dead-ending.
  const DEFAULT_MODEL = deps.defaultModel ?? "Claude Opus 4.8";
  const safeModel = (m: string | null | undefined) => (m && resolveModel(m) ? m : DEFAULT_MODEL);
  const stage: "pre_lineup" | "post_lineup" = match.lineup_out ? "post_lineup" : "pre_lineup";

  // Key resolution: explicit deps.env wins (tests/callers); otherwise env vars
  // OR a key entered via the UI (Models screen), resolved from the DB.
  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  // Two-model analysis duel: half the matches (stable hash of the id) are analysed by
  // model B instead of the configured one, so the two can be compared head-to-head. Both
  // analysis layers (base + ЧМ modifier) use the SAME chosen model, so a match is fully
  // attributable to one model. Off → the single configured analytics model, as before.
  const duel = loadAnalysisDuel(env);
  const model = duel.enabled ? safeModel(pickAnalysisModel(matchId, duel)) : safeModel(prompt.model);
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
      if (modifier?.body) category = await assessCategoryModifier(modifier.body, base, match.home, match.away, model, { fetchImpl: deps.fetchImpl, env });
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
  // Analysis-only mode: produce the artifacts (base/category/distribution) but do
  // NOT run the PRE-MATCH strategist pass. Used when back-filling a match that went
  // LIVE without analysis (a scheduler gap over kickoff) — the LIVE reassessment
  // owns live entries via its own prompt, so a pre-match proposal pass on a live
  // match would be the wrong window. The stored distribution still feeds that
  // live reassessment (distributionContext), so it's no longer blind.
  if (opts.skipStrategists) return { ok: true, stage, confidence: a.confidence, betsCreated: 0, decisions: [] };
  // Strategist pass is DECOUPLED (unified engine): it reads the stored analysis +
  // fresh quotes + risk_config and can be re-run on its own (e.g. when the roster
  // /shares change) without re-running the expensive analysis. Pass the exact
  // calibration we just computed so this run doesn't have to reload it.
  const res = await runStrategists(db, matchId, deps, { calibration: calibrationNum });
  return { ok: true, stage, confidence: a.confidence, betsCreated: res.betsCreated, decisions: res.decisions };
}

/**
 * The STRATEGIST engine, decoupled from analysis. Reads the latest OK assessment
 * + the markets' analysis probs + fresh quotes + each (strategy, profile) pair's
 * risk_config, then proposes/sizes bets in CODE (module #3). Re-runnable: a roster
 * or shares change re-runs THIS without re-analysing. Returns per-pair decisions.
 * A no-op (returns 0) when there's no usable assessment/probabilities yet.
 */
export async function runStrategists(
  db: Database, matchId: string, deps: AnalyzeDeps = {}, opts: { calibration?: number | null } = {},
): Promise<{ betsCreated: number; decisions: AnalyzeResult["decisions"] }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const match = R.getMatch(db, matchId);
  if (!match) return { betsCreated: 0, decisions: [] };
  const comp = R.listCompetitions(db).find((c) => c.id === match.competition_id);
  const sport = comp?.sport_id ?? "football";
  const assessment = R.assessmentsForMatch(db, matchId).filter((x) => x.status === "ok").sort((x, y) => (x.created_at >= y.created_at ? -1 : 1))[0];
  if (!assessment) return { betsCreated: 0, decisions: [] }; // nothing analysed yet
  const stage: "pre_lineup" | "post_lineup" = match.lineup_out ? "post_lineup" : "pre_lineup";
  const prompt = R.analyticsPromptFor(db, sport, match.competition_id);
  const DEFAULT_MODEL = deps.defaultModel ?? "Claude Opus 4.8";
  const safeModel = (m: string | null | undefined) => (m && resolveModel(m) ? m : DEFAULT_MODEL);
  const model = safeModel(prompt.model);
  const env = deps.env ?? effectiveEnv(R.getProviderKeys(db));
  // Duel tag for this match's bets = the model that actually produced its analysis
  // (recorded on the assessment). Null when the duel is off → plain epoch label.
  const duel = loadAnalysisDuel(env);
  const analysisTag = duel.enabled && assessment.model ? analysisModelTag(assessment.model) : null;

  // [прод-разбор 29.07] ПЛАНОЧНЫЕ ЦЕНЫ НЕ ПОКАЗЫВАЕМ СТРАТЕГУ НА НЕСЫГРАННОМ МАТЧЕ.
  //
  // Карантин зомби-рынков работает ТОЛЬКО для live-футбола (footballZombieMap гейтится на state==='live'),
  // поэтому в предматче стратег получал книгу как есть — а она была отравлена: 2030 из 6660 рынков стояли
  // у планки, 865 из них на матчах, которые ещё не начались. Стратег вёл себя правильно и отказывался
  // торговать целиком («котировки нерепрезентативны, ждать live-глубины», picks: []) — то есть мусор в
  // книге останавливал торговлю, а не отдельную ставку. Убираем такие рынки из его поля зрения: у
  // несыгранного матча планка означает мёртвую/одностороннюю книгу, а не эффективную котировку.
  //
  // Завершённый матч не трогаем: там планка — честная цена разрешения, и прятать её незачем.
  // Граница — СТАРТОВЫЙ СВИСТОК: после него планку объясняет счёт (этим занимается resolved_price), и
  // прятать «Over 0.5 @98¢» при забитом голе было бы враньём. См. zombieMarket.isRailPrice.
  const kickedOff = match.state === "live" || match.state === "finished"
    || (!!match.kickoff_at && (Date.parse(match.kickoff_at) || Infinity) <= (Date.parse(now()) || Date.now()));
  const allMarkets = R.latestMarkets(db, matchId);
  const railed = kickedOff ? [] : allMarkets.filter((m) => m.price != null && isRailPrice(m.price));
  const freshMarkets = railed.length ? allMarkets.filter((m) => !railed.includes(m)) : allMarkets;
  if (railed.length) {
    // Цена скрытия обязана быть посчитана: молча сузить стратегу выбор — это тот же класс, что молча
    // отказать во входе. Одна строка на матч, не на рынок.
    try {
      R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: R.listStrategies(db).find((x) => x.sport_id === sport)?.id ?? "", minute: null, type: "skip",
        text: `rail_price: ${railed.length} из ${allMarkets.length} рынков у планки ДО стартового свистка — скрыты от стратега (мёртвая/односторонняя книга, не котировка)`,
        dedup_key: `rail:${matchId}:${stage}`, created_at: now() });
    } catch { /* улика не имеет права ломать анализ */ }
  }
  // Only replace existing proposals if we actually have usable probabilities — a
  // degenerate state must not wipe the previous good proposals with nothing.
  if (!freshMarkets.some((m) => m.ai_prob != null)) return { betsCreated: 0, decisions: [] };
  // P4 [batch-7]: a stable in-cycle catalog id (m1..mN) per market so the strategist selects BY REFERENCE, not
  // by a free-text paraphrase of the label (a paraphrase miss silently dropped Lugano ML @44¢/78%). Built once
  // from freshMarkets (fetched once), so the id the prompt shows and the id the match loop reads are identical.
  const catId = new Map<string, string>();
  freshMarkets.forEach((m, i) => catId.set(m.id, `m${i + 1}`));
  const catIdSet = new Set(catId.values());
  R.clearProposedBets(db, matchId);
  // Calibration for the min_calibration gate: caller-supplied (fresh analysis),
  // else the stored distribution artifact, else the word-confidence band.
  const calibration = opts.calibration ?? calibrationFromArtifact(db, matchId) ?? confBand(assessment.confidence ?? "средняя");

  // The budget unit is a (strategy, risk-profile) PAIR: a comp can fund the same
  // strategy under several profiles, each with its own share.
  const strategyById = new Map(R.listStrategies(db, sport).map((s) => [s.id, s]));
  const pairs = R.sharesForComp(db, match.competition_id)
    .filter((sh) => sh.pct > 0 && (comp?.budget ?? 0) > 0 && strategyById.has(sh.strategy_id))
    .map((sh) => ({ strat: strategyById.get(sh.strategy_id)!, profile: sh.risk_profile_id, pct: sh.pct }));

  // Quotes → de-vigged implied probs, once (same for every pair).
  const quotes = freshMarkets.map((m) => ({ label: m.label, priceCents: m.price, liquidity: parseLiq(m.liquidity) }));
  const impliedMap = impliedProbs(quotes);
  // Duplicate-outcome price conflicts (Polymarket listing the same outcome twice at
  // divergent prices) — surfaced to every strategist and hard-blocked at entry, so a
  // phantom "edge" on a mispriced twin can't be traded even if a strategist misses it.
  const conflicts = duplicateOutcomeConflicts(freshMarkets.map((m) => ({ label: m.label, priceCents: m.price })));
  // [Phase 1.1/1.2] Family governance, computed ONCE per match analysis: which (strategy, family) are KILLED
  // (matured-negative signal verdict → no money, no shadow). The demote gate itself (pmv non-totals → shadow)
  // is applied inline per market below.
  const killedFams = killedFamilies(db);

  let betsCreated = 0;
  const decisions: AnalyzeResult["decisions"] = [];
  // Strategist context = match facts + the outcome tree / match_shape / scenarios
  // the strategist reasons over. Same for every pair, so build it once.
  const stratCtx = strategistContext(db, matchId);
  // Model A — the strategist JUDGMENT (which markets, and the refined prob per
  // market) is made ONCE per strategy and SHARED across its risk profiles. Profiles
  // then diverge ONLY in the deterministic threshold + sizing (sizePrematch below),
  // so a stricter profile's entries are a NESTED SUBSET of one candidate list — not
  // different picks from independent, non-deterministic per-profile LLM calls (which
  // made profile-vs-profile PnL a comparison of luck, not of thresholds). It also
  // cuts pre-match strategist calls ~Nx (one per strategy, not per profile), easing
  // credit burn. Safe as a single point of failure because that one call is hardened
  // by JSON-repair (parseJsonLoose) + transient retry (callLLM). A profile that
  // already HOLDS positions (a mid-match roster/share change) still gets its OWN call
  // that sees them — the shared judgment is built with NO open positions, so it's
  // only reused for profiles that likewise hold none (the pre-match norm).
  const sharedDec = new Map<string, Awaited<ReturnType<typeof strategistDecide>>>();
  for (const { strat, profile, pct } of pairs) {
    const budget = stratBudget(comp!.budget, pct);
    const pairLabel = `${strat.name} · ${profile}`;
    const stratModel = safeModel(strat.model ?? model);
    const openPos = R.betsForMatch(db, matchId, strat.id).filter((b) => b.status === "open" && (b.risk_profile_id ?? "medium") === profile);
    let dec = openPos.length === 0 ? sharedDec.get(strat.id) : undefined;
    const reused = dec != null;
    if (!dec) {
      dec = await strategistDecide({
        strategyName: strat.name, strategyPrompt: strat.prompt,
        match: { home: match.home, away: match.away, sport, state: match.state, minute: match.minute, scoreHome: match.score_home, scoreAway: match.score_away },
        assessment: { confidence: assessment.confidence ?? "средняя", short: assessment.short ?? "", verdict: assessment.verdict ?? "" },
        markets: freshMarkets.map((m) => ({ id: catId.get(m.id), label: m.label, priceCents: m.price, aiProb: m.ai_prob, conflict: conflicts.get(m.label) ?? null })),
        openPositions: openPos.map((b) => ({ market: b.market_label, entryCents: b.entry_price ?? 0, currentCents: b.current_price ?? b.entry_price ?? 0 })),
        context: stratCtx,
      }, stratModel, { fetchImpl: deps.fetchImpl, env });
      if (openPos.length === 0) sharedDec.set(strat.id, dec);
    }
    // On a FAILED strategist call, propose NOTHING (empty picks) — do NOT fall back
    // to raw base-model edge. That fallback bypassed every strategist safeguard
    // (anti-phantom, thin-market skepticism, methodology gating) and produced
    // ungated bets — e.g. all strategists proposing the SAME value bets off a
    // degenerate quote, which is not any strategy's decision. A failed call means
    // "no decision", not "trade the base model".
    const picksArr = dec.ok ? dec.picks : [];
    try { R.saveArtifact(db, { match_id: matchId, kind: "strategist", label: pairLabel, stage, content: JSON.stringify(dec, null, 2), model: stratModel, created_at: now() }); } catch { /* best-effort */ }
    if (!dec.ok && !reused) {
      R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: strat.id, minute: null, type: "skip", text: `стратег недоступен (${dec.error || "нет ответа ИИ"}) — входов нет (без базовой подмены)`, created_at: now() });
    }

    // [batch-12 W5-аудит] Экспозиция матча и кластера СЧИТАЕТСЯ ПО open+proposed. Раньше — только по open,
    // и это асимметрично соседней строке: comp-кэп (strategyCompExposure) proposed уже включал. Стадии
    // pre_lineup и post_lineup — два независимых прогона, autoAnalyze идёт ДО autoEnter в тике, поэтому
    // второй прогон не видел предложений первого и мог напредлагать ещё столько же: до 2× кэпа матча и
    // кластера, оба пакета филлятся (openKey-дедуп ловит лишь идентичный рынок пары, а тезисный кэп по
    // умолчанию выключен). Футбол в дефолте прикрыт lineup-гейтом, но теннис/киберспорт и краевые случаи
    // футбола (перенос, откатывающий lineup_out) — нет. Считать надо ОБЯЗАТЕЛЬСТВА, а не только исполненное.
    const committed = committedBets(R.betsForMatch(db, matchId, strat.id), profile);
    const held = new Set(openPos.map((b) => norm(b.market_label)));
    let exposure = strategyCompExposure(db, match.competition_id, strat.id, profile) - strategyCompRealized(db, match.competition_id, strat.id, profile);
    const cfg = getProfileConfig(db, profile);
    const psFlags = probSumFlags(quotes, cfg);
    let matchExposure = committed.reduce((s, b) => s + (b.stake ?? 0), 0);
    // Same-event correlation exposure, seeded from positions this pair already
    // holds so a fresh correlated market sizes against the existing stack, not
    // from zero (see correlationKey / the cluster cap in sizePrematch).
    const clusterExp = new Map<string, number>();
    for (const b of committed) { const k = correlationKey(b.market_label, match.home, match.away); if (k) clusterExp.set(k, (clusterExp.get(k) ?? 0) + (b.stake ?? 0)); }
    // T3.2: a market the strategist listed in rejected[] must never be entered, even if it also appears in
    // picks — rejected is authoritative over picks (Hammarby BTTS-Yes). The execution gate reads it.
    const rejectedSet = new Set((dec.ok && dec.rejected ? dec.rejected : []).map((r) => norm(r.market)));
    let entries = 0, skipped = 0, flagged = 0;
    const battle: any[] = [];
    const ranked = freshMarkets.filter((m) => m.ai_prob != null)
      .map((m) => { const implied = impliedMap.get(m.label)?.implied ?? m.price / 100; return { m, implied, edge: (m.ai_prob as number) - implied }; })
      .sort((x, y) => y.edge - x.edge);
    for (const { m, implied } of ranked) {
      // P4: match by catalog id first (identity by reference); fall back to label ONLY for a pick the model left
      // id-less (transitional non-compliance) — a tagged pick can never be lost to a paraphrase again.
      const mCatId = catId.get(m.id);
      const pick = picksArr?.find((p) => p.marketId && p.marketId === mCatId)
        ?? picksArr?.find((p) => !p.marketId && sameMarketLabel(p.label, m.label));
      if (picksArr && !pick) { skipped++; continue; }
      if (pick?.hold) { skipped++; continue; } // T2.2: a hold ticket never opens — no-op prematch too
      if (rejectedSet.has(norm(m.label))) { skipped++; battle.push({ market: m.label, status: "skip", reason: "в rejected — вход заблокирован (rejected_market_block)" }); continue; } // T3.2
      if (held.has(norm(m.label))) { skipped++; continue; }
      // Duplicate-outcome price conflict → never enter, even if the strategist picked
      // it: one of the twins is a data artifact, so its edge is phantom.
      if (conflicts.has(m.label)) { flagged++; battle.push({ market: m.label, status: "flag", reason: conflicts.get(m.label) }); continue; }
      const ourProb = pick?.prob != null ? pick.prob : (m.ai_prob as number);
      if (pick?.prob != null) R.setMarketAiProb(db, m.id, pick.prob);
      if (psFlags.has(m.label)) { flagged++; battle.push({ market: m.label, status: "flag", reason: "prob_sum вне допуска" }); continue; }
      const cKey = correlationKey(m.label, match.home, match.away);
      // Executable-ask edge (fix #1): a BUY pays the ASK, not the mid. Size/gate against the executable
      // ask when we have the book (ask ≥ mid keeps it conservative — never inflates edge, closes the
      // "1−ask phantom" on the other side); else fall back to the mid and FLAG it (mid_fallback) so the
      // edge-analytics can separate honest executable edges from mid estimates.
      const askUsable = m.ask_cents != null && m.ask_cents >= m.price && m.ask_cents < 100;
      const execCents = askUsable ? (m.ask_cents as number) : m.price;
      const edgeSource: "executable" | "mid_fallback" = askUsable ? "executable" : "mid_fallback";
      const effImplied = askUsable ? execCents / 100 : implied;
      // bankCeiling: the sizing_insanity backstop, built after a corrupted budget sized a $28k tennis stake on a
      // $1k bank, was wired into tennis ONLY — football sized off `competitions.budget` (a DB row, i.e. the exact
      // corruptible input) with no absolute floor under it. Undeclared bank → 0 → undefined → guard stays inert,
      // so nothing changes for a deployment that never stated its bank.
      const bank = bankUsd(env) || undefined;
      const r = sizePrematch({ ourProb, priceCents: execCents, implied: effImplied, calibration, liquidity: parseLiq(m.liquidity), budget, matchExposure, compExposure: exposure, clusterExposure: cKey ? (clusterExp.get(cKey) ?? 0) : 0, cfg, bankCeiling: bank });
      // S5 (R0.5): MATCH-WIDE thesis cap — a correlated stack (dom:/total: cluster) is one thesis across ALL
      // strategies/profiles, so clamp the entry to the thesis' remaining room on the match (not just this
      // pair's). Off by default (THESIS_MATCH_CAP_USD unset → room=Infinity → no-op); the real=on blocker.
      if (r.status === "enter" && cKey) {
        const room = matchThesisRoom(db, match.id, cKey, match.home, match.away, env);
        if (room < r.stake) {
          if (room < 1) { r.status = "skip"; r.reason = `thesis_cap: тезис «${cKey}» на матче уже у кэпа — вход заблокирован (R0.5)`; }
          else { r.stake = Math.round(room * 100) / 100; r.reason = `${r.reason} · thesis_cap: урезан до остатка тезиса $${r.stake}`; }
        }
      }
      // [Phase 1.1/1.2] FAMILY GATE (money-path concentration). Applies to a sized ENTER only:
      //   • a KILLED (matured-negative) family → skip entirely, no money and no shadow;
      //   • prematch_value on a NON-totals family → DEMOTE to a shadow signal (would-be, zero money) so the
      //     weak family keeps accruing a signal cohort, and skip the real bet.
      // The traded family (totals) and all other strategies fall through to the normal money path.
      if (r.status === "enter") {
        const fam = marketFamily(m.label);
        if (killedFams.has(`${strat.id}|${fam}`)) {
          r.status = "skip"; r.reason = `family_kill: «${fam}» — созревший ОТРИЦАТЕЛЬНЫЙ сигнальный вердикт; семья снята и с денег, и с shadow (R0.1)`;
        } else if (isDemotedFamily(strat.id, fam)) {
          recordFamilyShadowSignal(db, { matchId, strategyId: strat.id, label: m.label, family: fam, ourProb, implied, edge: r.edge, wouldBeStake: r.stake, entryCents: execCents, kickoffAt: match.kickoff_at ?? null, codeVersion: effectiveCodeVersion(db, analysisTag), at: now() });
          r.status = "skip"; r.reason = `family_shadow: prematch_value ставит деньги только в «totals» — «${fam}» демоутнут в shadow-когорту (kill/promote по созревшему R0.1-вердикту), капитал не выделен`;
        }
      }
      battle.push({ market: m.label, our_prob: round3(ourProb), implied: round3(implied), edge_pct: round3(r.edge * 100), status: r.status, stake: r.stake, kelly_fraction: round3(r.kellyFraction), reason: r.reason,
        ...(pick?.role ? { role: pick.role } : {}), ...(pick?.livesInBranches ? { lives_in_branches: pick.livesInBranches } : {}), ...(pick?.branchWeightSum != null ? { branch_weight_sum: pick.branchWeightSum } : {}), ...(pick?.phantomCheck ? { phantom_check: pick.phantomCheck } : {}), ...(pick?.totalCheck ? { total_check: pick.totalCheck } : {}), ...(pick?.exitPlan ? { exit: pick.exitPlan } : {}) });
      if (r.status === "flag") { flagged++; continue; }
      if (r.status !== "enter") { skipped++; continue; }
      exposure += r.stake; matchExposure += r.stake; entries++;
      if (cKey) clusterExp.set(cKey, (clusterExp.get(cKey) ?? 0) + r.stake);
      // Decision-time snapshot for risk-profile analytics (measurement only; forward-only).
      const entryMeta: BetEntryMeta = {
        phase: match.state === "live" ? "live" : "prematch",
        minute: match.state === "live" ? match.minute ?? null : null,
        scoreHome: match.score_home ?? null, scoreAway: match.score_away ?? null,
        edge: round3(r.edge), aiProb: round3(ourProb), derivedProb: m.ai_prob != null ? round3(m.ai_prob) : null,
        marketPrice: m.price, impliedProb: round3(implied), liveProbAdjusted: null,
        // fix #1 provenance: was the edge measured against the executable ask or a mid fallback?
        edgeSource, execAskCents: askUsable ? execCents : null, spreadCents: m.spread_cents ?? null,
        kellyFraction: round3(r.kellyFraction), sizeRequested: round2p(r.stake), sizeFilled: null, entrySlipCents: null,
        calibration: calibration != null ? round3(calibration) : null,
        branchWeightSum: pick?.branchWeightSum != null ? round3(pick.branchWeightSum) : null,
        phantomCheck: pick?.phantomCheck ?? null, marketThinnessUsd: parseLiq(m.liquidity),
        winsOnEvent: winsOnEventOccurrence(m.label), exitPlan: pick?.exitPlan ?? null,
        models: { analysis: model, strategist: stratModel }, // ground truth for the A/B
      };
      R.insertBet(db, {
        id: R.uid(), match_id: matchId, strategy_id: strat.id, risk_profile_id: profile, market_label: m.label,
        status: "proposed", proposed_price: m.price, entry_price: null, current_price: null,
        closing_price: null, ai_prob: ourProb, stake: r.stake,
        rationale: `«${m.label}»: edge ${(r.edge * 100).toFixed(1)}% (наша ${(ourProb * 100).toFixed(0)}% vs рынок ${(implied * 100).toFixed(0)}%). ${pick?.reason || r.reason}.${pickTreeNote(pick)}`,
        entered_minute: null, result: null, payout: null, entry_meta: serializeEntryMeta(entryMeta), code_version: effectiveCodeVersion(db, analysisTag), created_at: now(),
      });
    }
    // A pick the strategist named that resolves to NO real market (a mislabel, or a
    // market+side split like {market:"BTTS", side:"No"}) would otherwise vanish
    // silently — the ranked loop only iterates markets, so an unmatched pick is
    // never seen. Surface it in the battle sheet + trade log so it's visible, not lost.
    if (picksArr) {
      // P4: a pick resolves iff its catalog id exists, OR (id-less) its label fuzzy-matches a real market.
      const resolves = (p: typeof picksArr[number]) => p.marketId ? catIdSet.has(p.marketId) : freshMarkets.some((m) => sameMarketLabel(p.label, m.label));
      const unresolved = picksArr.filter((p) => !resolves(p));
      // A pick that named a market_id NOT in the catalog is a HARD error (the model invented an id), not a quiet
      // skip — it's exactly the class of silent drop P4 exists to kill. Surface it loudly + distinctly.
      const badId = unresolved.filter((p) => p.marketId && !catIdSet.has(p.marketId));
      if (badId.length) {
        for (const p of badId) battle.push({ market: p.label || p.marketId!, status: "unresolved", reason: `market_id «${p.marketId}» отсутствует в каталоге — HARD ERROR (выдуманный id), вход не открыт` });
        console.error(`[strategist] ${strat.id} @ ${matchId}: несуществующий market_id: ${badId.map((p) => `«${p.marketId}»`).join(", ")} — рынки каталога: ${[...catIdSet].join(",")}`);
        R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: strat.id, minute: null, type: "skip", text: `стратег назвал НЕсуществующий market_id: ${badId.slice(0, 3).map((p) => `«${p.marketId}»`).join(", ")} — вход потерян (hard error, не тихий дроп)`, created_at: now() });
      }
      const labelMiss = unresolved.filter((p) => !p.marketId);
      if (labelMiss.length) {
        for (const p of labelMiss) battle.push({ market: p.label, status: "unresolved", reason: "нет market_id и ярлык без совпадения (проверь ярлык/сторону)" });
        R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: strat.id, minute: null, type: "skip", text: `стратег назвал рынок(и) без id и без совпадения ярлыка: ${labelMiss.slice(0, 3).map((p) => `«${p.label}»`).join(", ")}`, created_at: now() });
      }
    }
    try { R.saveArtifact(db, { match_id: matchId, kind: "battle_sheet", label: pairLabel, stage, content: JSON.stringify({ pair: pairLabel, profile, budget, calibration, positions: battle, flagged, ...(dec.ok && dec.liveTriggersArmed ? { live_triggers_armed: dec.liveTriggersArmed } : {}), ...(dec.ok && dec.liveEntryConfig ? { live_entry_config: dec.liveEntryConfig } : {}), strategist_plan: dec.ok ? dec : { ok: false } }, null, 2), model: stratModel, created_at: now() }); } catch { /* best-effort */ }
    // Overreaction and Live xG open nothing pre-match by design — they ARM the
    // live window (buyback triggers / xG-entry config). Log THAT, not a misleading
    // "edge insufficient".
    const armedN = dec.ok && Array.isArray(dec.liveTriggersArmed) ? dec.liveTriggersArmed.length : 0;
    const armedConfig = dec.ok && !!dec.liveEntryConfig;
    // A no-entry SKIP is a strategy-level fact (the shared decision opened nothing); log it
    // ONCE, not once per profile — `reused` is true for the 2nd+ profile of the same strategy.
    // A profile that DID enter has entries>0 and logs nothing here, so its entry isn't hidden.
    if (!reused && entries === 0) {
      // Build a TRUTHFUL no-entry reason. `!dec.ok` (outage) is already logged above as
      // "стратег недоступен" — don't double-log it here as an edge/skip verdict.
      if (armedN > 0 || armedConfig) {
        const what = armedN > 0 ? `заряжено ${armedN} триггер(ов) выкупа на live` : "настроен порог live-xG входа";
        R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: strat.id, minute: null, type: "skip", text: `предматч-входов нет — ${what}`, created_at: now() });
      } else if (dec.ok && Array.isArray(picksArr) && picksArr.length === 0) {
        // Стратег СОЗНАТЕЛЬНО вернул пустой список picks — это полный пропуск матча его
        // решением. Движок затем авто-скипает КАЖДЫЙ рынок (нет pick → skip), так что
        // `skipped` == число рынков, и старое «N рынков ниже порога edge» — ложь движка.
        R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: strat.id, minute: null, type: "skip", text: `пропуск матча — стратег вернул 0 picks (полный пропуск)`, created_at: now() });
        // [R5 / batch-10] Freeze the walked-away totals with a committed edge as would-be signals. Only a
        // DELIBERATE refusal (ok=true, zero picks) qualifies — a failed or gated call is not a judgement and
        // must never enter this cohort. Never blocks the flow.
        try {
          const nRef = recordRefusalForMatch(db, matchId, strat.id, (dec as { note?: string }).note ?? null, now());
          if (nRef > 0) R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: strat.id, minute: null, type: "skip", text: `refusal_shadow: ${nRef} тотал(ов) с заявленным краем записаны would-be — отказ будет оценён когортой, а не спором`, created_at: now() });
        } catch { /* measurement must never break the decision path */ }
      } else if (dec.ok && (skipped + flagged) > 0) {
        // TRUTHFUL audit (правдивый лог): `skipped` = markets the STRATEGIST chose not to pick (his
        // judgement: no edge there), NOT markets a code threshold rejected — so "N рынков ниже порога"
        // was a lie of the engine. And if the strategist DID name picks (nPicks>0) that then failed to
        // enter, say THAT — "chose N, none passed entry" is a different event than "chose nothing",
        // and the difference matters for audit (his call vs the code's gate).
        const nPicks = Array.isArray(picksArr) ? picksArr.length : 0;
        const why = nPicks > 0
          ? `стратег выбрал ${nPicks} pick(s), ни один не прошёл вход${flagged > 0 ? ` (${flagged} снят предохранителем)` : " (порог edge / неисполнимо на книге)"}`
          : flagged > 0
            ? `флаги предохранителей сняли ${flagged} рынк.`
            : `стратег не выбрал ни один рынок (нет края по его оценке)`;
        R.insertTradeLog(db, { id: R.uid(), match_id: matchId, strategy_id: strat.id, minute: null, type: "skip", text: `пропуск матча — ${why}`, created_at: now() });
      }
    }
    decisions.push({ strategy: pairLabel, entries, skipped });
    betsCreated += entries;
  }
  return { betsCreated, decisions };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round2p = (x: number) => Math.round(x * 100) / 100;

// Group KEY that strips a "(Home vs. Away)" qualifier so labels that LOOK like the same
// outcome ("Draw (Spain vs. Belgium) — Yes" and "Draw — Yes") land in one bucket — used
// ONLY to detect a price conflict between look-alikes. It does NOT assert they ARE one
// outcome. Only a parenthetical that reads like "… vs …" is stripped; real ones
// (handicaps "(-1.5)") stay intact.
const canonOutcome = (label: string): string =>
  norm(label.replace(/\([^)]*\bvs\.?\b[^)]*\)/gi, " "));
const CONFLICT_CENTS = 8; // ≥ this price gap between two look-alike listings = do-not-trade signal
/**
 * ⚠️ DO NOT "collapse/dedup" these markets. Empirically established on Spain–Belgium:
 * a bare "Draw" and "Draw (Spain vs. Belgium)" are TWO DIFFERENT Polymarket contracts —
 * different tokens, different RESOLUTION CONDITIONS — not one outcome listed twice. Proof:
 * at 1:1 live one Draw sat at 100¢ (reacts to "a draw on the scoreboard NOW" — HT/current
 * state) while the other sat at 31.6¢ (draw AT 90'). One outcome cannot cost 100 and 31.6
 * at once ⇒ the outcomes differ. Merging them would CREATE a bug (trade one contract at the
 * other's price), not remove one.
 *
 * So this function only FLAGS+BLOCKS: when two look-alikes' prices diverge ≥CONFLICT_CENTS,
 * every member gets a note so the strategist sees it and the entry loop refuses it. That
 * guard holds the money while the REAL fix waits in the backlog (no rush):
 *   (1) PROVENANCE first — token-check whether the bare "Draw" even belongs to THIS match
 *       or was dragged in by the importer from another event; step 1 is research, not code.
 *   (2) if it belongs — SPLIT the semantics: each token gets its own resolution condition
 *       and its own ai_prob — do NOT dedup.
 *   (3) same class covers "broken labels" (e.g. "Team — Yes" = 100¢): a token with an
 *       unclear resolution condition, resolved by the same provenance pass.
 * Returns a per-label conflict note for every market caught, so the model isn't relied on.
 */
export function duplicateOutcomeConflicts(markets: { label: string; priceCents: number }[]): Map<string, string> {
  const groups = new Map<string, { label: string; priceCents: number }[]>();
  for (const m of markets) {
    const k = canonOutcome(m.label);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(m);
  }
  const out = new Map<string, string>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const prices = members.map((m) => m.priceCents);
    if (Math.max(...prices) - Math.min(...prices) < CONFLICT_CENTS) continue; // agree → genuine, not a conflict
    const twins = members.map((m) => `${m.label} ${m.priceCents}¢`).join(" vs ");
    for (const m of members)
      out.set(m.label, `⚠ дубликат-конфликт: один исход торгуется по расходящимся ценам (${twins}) — вероятно артефакт данных, НЕ торговать без подтверждения`);
  }
  return out;
}
/** Short suffix appended to a bet's rationale from the strategist's tree-reasoning
 *  (role / how many outcome branches it lives in / anti-phantom verdict), so the
 *  decision row and trade log show WHY the bet was chosen, not just its edge. */
function pickTreeNote(pick: { role?: string; branchWeightSum?: number; livesInBranches?: string[]; phantomCheck?: string } | undefined): string {
  if (!pick) return "";
  const bits: string[] = [];
  if (pick.role) bits.push(pick.role === "anchor" ? "якорь" : "спутник");
  if (pick.branchWeightSum != null) bits.push(`живёт в ветках Σ${Math.round(pick.branchWeightSum * 100)}%`);
  else if (pick.livesInBranches?.length) bits.push(`ветки: ${pick.livesInBranches.join("/")}`);
  if (pick.phantomCheck) bits.push(`анти-фантом: ${pick.phantomCheck}`);
  return bits.length ? ` [${bits.join(" · ")}]` : "";
}
/** Word confidence → a numeric band for the profile's min_calibration gate
 *  (used only for non-football, where there's no assembled xg_confidence). */
const confBand = (c: string) => (c === "высокая" ? 0.75 : c === "низкая" ? 0.3 : 0.5);
/** Numeric analysis calibration from the stored `distribution` artifact (for a
 *  strategist re-run that isn't attached to a fresh analysis), or null. */
function calibrationFromArtifact(db: Database, matchId: string): number | null {
  const art = R.artifactsForMatch(db, matchId).find((x) => x.kind === "distribution");
  if (!art) return null;
  try { const v = JSON.parse(art.content)?.calibration?.xg_confidence; return typeof v === "number" ? v : null; }
  catch { return null; }
}
/** The full-match FootballCore (xg + 1st-half shares) from the stored analysis —
 *  the game-state live-prob layer (liveProb.ts) needs the base λ per team. Prefer
 *  the ASSEMBLED distribution core (base folded with the category modifier + any
 *  overrides — the number the market derivation actually used); fall back to the
 *  raw `base` artifact. Football-only (no such artifact otherwise) → null. */
export function footballCore(
  db: Database, matchId: string,
): { xg_home: number; xg_away: number; home_share_1h: number; away_share_1h: number } | null {
  const arts = R.artifactsForMatch(db, matchId);
  const readCore = (kind: string) => {
    const art = arts.find((x) => x.kind === kind);
    if (!art) return null;
    try {
      const c = JSON.parse(art.content)?.core;
      if (c && Number.isFinite(c.xg_home) && Number.isFinite(c.xg_away)) {
        return {
          xg_home: Number(c.xg_home), xg_away: Number(c.xg_away),
          home_share_1h: Number.isFinite(c.home_share_1h) ? Number(c.home_share_1h) : 0.44,
          away_share_1h: Number.isFinite(c.away_share_1h) ? Number(c.away_share_1h) : 0.44,
        };
      }
    } catch { /* malformed artifact → try the next source */ }
    return null;
  };
  return readCore("distribution") ?? readCore("base");
}
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

// Max substitutions a team may use (modern football: 5). Env-tunable — a league
// with a different allowance overrides it. Only drives the "remaining subs" display.
const MAX_SUBS_PER_TEAM = (() => { const n = Number(process.env.MAX_SUBS_PER_TEAM); return Number.isFinite(n) && n > 0 ? n : 5; })();
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
  // Live xG flow (Sportmonks) — the signal the Live xG Momentum strategist REQUIRES
  // ("без потока live-xG стратег не действует"). ESPN gives possession/shots but NO
  // xG, so without this line that strategist is permanently blind. Captured every
  // tick into provider_snapshots; surfaced here so the strategist can actually read
  // live_xg_home/away and the gap.
  if (m?.state === "live") {
    const xg = R.latestLiveXg(db, matchId);
    if (xg) {
      const gap = Math.abs(xg.home - xg.away).toFixed(2);
      parts.push(`Live xG (${xg.provider}${xg.minute != null ? ", " + xg.minute + "'" : ""}): дом ${xg.home.toFixed(2)} – ${xg.away.toFixed(2)} гости · перекос ${gap}`);
    }
  }
  // Real match events only — drop our own "stats"/"other" market-price snapshots so
  // no quote-derived noise reaches the (price-blind) analyst or the strategist.
  const events = R.eventsForMatch(db, matchId).filter((e) => e.type !== "other" && e.type !== "stats");
  if (events.length) parts.push("События: " + events.map((e) => `${e.minute ?? "?"}' ${e.type}${e.team ? " " + e.team : ""}`).join("; "));
  // SUBSTITUTIONS delta block (live) — who came on/off and when, plus REMAINING subs
  // per team. The master prompt reasons about "джокеры" (impact subs off the bench)
  // and a trailing team's remaining changes feed the game-state read (Fix 1/3);
  // without this the strategist saw subs only mixed into the flat event list and had
  // no remaining-subs count at all. Football, live-only (no subs pre-match).
  if (m?.state === "live") {
    const subs = events.filter((e) => e.type === "sub");
    if (subs.length) {
      const line = subs.map((e) => `${e.minute ?? "?"}'${e.team ? " " + e.team : ""}${e.text && e.text.toLowerCase() !== "substitution" ? ` (${e.text})` : ""}`).join("; ");
      const byTeam = (team: string) => subs.filter((e) => e.team && e.team === team).length;
      const homeMade = m.home ? byTeam(m.home) : 0, awayMade = m.away ? byTeam(m.away) : 0;
      const rem = (made: number) => Math.max(0, MAX_SUBS_PER_TEAM - made);
      parts.push(`Замены: ${line}`);
      parts.push(`Осталось замен (макс ${MAX_SUBS_PER_TEAM}): ${m.home} ${rem(homeMade)}, ${m.away} ${rem(awayMade)}${homeMade + awayMade < subs.length ? " (часть замен без привязки к команде)" : ""}`);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}
/** The 6-branch outcome tree (+ match_shape + event scenarios) formatted for the
 *  STRATEGIST context, read from the saved `distribution` artifact. This is what
 *  Pre-match Value v3 reasons over ("в каких ветвях живёт ставка"). Kept OUT of
 *  matchContext so it never leaks into the price-blind analyst (which produces the
 *  tree). Football-only (no distribution artifact otherwise) → undefined. */
export function distributionContext(db: Database, matchId: string): string | undefined {
  const art = R.artifactsForMatch(db, matchId).find((x) => x.kind === "distribution");
  if (!art) return undefined;
  let a: any;
  try { a = JSON.parse(art.content); } catch { return undefined; }
  const d = a?.derived;
  const tree = d?.outcome_scenarios;
  if (!Array.isArray(tree) || !tree.length) return undefined;
  const lines: string[] = [
    `ДЕРЕВО ИСХОДОВ (outcome_scenarios · 6 MECE-веток по победитель×BTTS, сумма весов=1; match_shape=${d.match_shape ?? "?"}; фаворит=${tree[0]?.favorite ?? "?"}):`,
  ];
  for (const b of tree) {
    const scores = Array.isArray(b.score_cluster) && b.score_cluster.length ? ` счета=[${b.score_cluster.join(",")}]` : "";
    const lives = Array.isArray(b.bets_that_live) && b.bets_that_live.length ? ` живут=[${b.bets_that_live.join(",")}]` : "";
    const et = b.leads_to_extra_time ? " →ET" : "";
    const tn = b.total_note ? ` total_note="${b.total_note}"` : "";
    lines.push(`- ${b.id} «${b.label}» вес=${b.prob} winner=${b.winner_side} btts=${b.btts}${et}${scores}${lives}${tn}`);
  }
  const scen = a?.scenarios;
  if (Array.isArray(scen) && scen.length) {
    lines.push("Событийные сценарии (scenarios): " + scen.map((s: any) => `• ${s.trigger}${Number.isFinite(s.prob) ? ` (P≈${Math.round(s.prob * 100)}%)` : ""}${s.note ? ` — ${s.note}` : ""}`).join("; "));
  }
  // Веса веток = ЧИСТЫЙ Пуассон. Если аналитик применил override на конкретный
  // рынок (btts/исход/тотал/фора), рыночная оценка в СПИСКЕ РЫНКОВ уже сдвинута, а
  // веса веток — нет: тогда авторитетна рыночная оценка, а не сумма веток.
  if (Array.isArray(a?.overrides) && a.overrides.length) {
    lines.push(`(Аналитик применил ${a.overrides.length} override — по затронутым рынкам авторитетна оценка в списке рынков, а не сумма веток.)`);
  }
  return lines.join("\n");
}
/** The context handed to EVERY strategist (all three windows): the match facts
 *  (lineups/stats/live-xG/events) plus the outcome tree + match_shape + event
 *  scenarios. Single source of truth for the wiring, so a strategy prompt can
 *  never reference data the engine forgot to pass (see the invariant test). The
 *  live loop appends the pair's battle sheet on top of this. */
export function strategistContext(db: Database, matchId: string): string | undefined {
  return [matchContext(db, matchId), distributionContext(db, matchId)].filter(Boolean).join("\n\n") || undefined;
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
/** [batch-12 W5-аудит] ОБЯЗАТЕЛЬСТВА пары на ОДНОМ матче: open + ещё не отменённые proposed. Тот же счёт,
 *  что и у comp-кэпа выше — кэп матча и кластера обязан читать его же, иначе два прогона одного тика
 *  (pre_lineup и post_lineup) видят пустой матч дважды и предлагают до 2× кэпа. */
export function committedBets<T extends { status: string; risk_profile_id?: string | null }>(bets: T[], profileId: string): T[] {
  return bets.filter((b) => (b.status === "open" || b.status === "proposed") && (b.risk_profile_id ?? "medium") === profileId);
}
/** Realized P&L ($) a (strategy, profile) pair booked across the WHOLE competition
 *  (bankroll = budget + realized, so a loss elsewhere shrinks what's re-stakeable
 *  here). Pass profileId to scope to one pair; omit for the whole strategy. */
export function strategyCompRealized(db: Database, competitionId: string, strategyId: string, profileId?: string): number {
  let sum = 0;
  for (const mt of R.listMatches(db, competitionId))
    for (const b of R.betsForMatch(db, mt.id, strategyId))
      if (R.isSettled(b.status) && (profileId == null || (b.risk_profile_id ?? "medium") === profileId)) sum += (b.payout ?? 0) - (b.stake ?? 0);
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
