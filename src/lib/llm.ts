// ============================================================
// EDGE LAB — LLM provider abstraction (ТЗ §5.3)  [SERVER-ONLY]
//
// One entry point for every call site: analysis, strategy decisions,
// reassessments, name generation, threshold extraction, improvement.
// Keys are read from the environment only — never the browser or DB
// (ТЗ §4.6, §9.9). A missing key disables that provider gracefully; a bad
// response never crashes the system (ТЗ §6) — callers get {ok:false} and
// decide (e.g. assessment.status='failed').
//
// In this sandbox the provider hosts are blocked by egress policy, so live
// calls resolve to {ok:false}; heuristic fallbacks keep the app usable.
// ============================================================

import "./http.js"; // configure proxy dispatcher for server-side fetch

export type ProviderId = "anthropic" | "openai" | "google";

/** Map a UI model label (or raw id) to provider + API model id. */
const MODEL_MAP: Record<string, { provider: ProviderId; apiId: string }> = {
  "Claude Opus 4.8": { provider: "anthropic", apiId: "claude-opus-4-8" },
  "Claude Sonnet 5": { provider: "anthropic", apiId: "claude-sonnet-5" },
  "Claude Haiku 4.5": { provider: "anthropic", apiId: "claude-haiku-4-5-20251001" },
  "Claude Fable 5": { provider: "anthropic", apiId: "claude-fable-5" },
  "GPT-5": { provider: "openai", apiId: "gpt-5" },
  "GPT-5 mini": { provider: "openai", apiId: "gpt-5-mini" },
  o4: { provider: "openai", apiId: "o4" },
  "Gemini 2.5 Pro": { provider: "google", apiId: "gemini-2.5-pro" },
  "Gemini 2.5 Flash": { provider: "google", apiId: "gemini-2.5-flash" },
};

export function resolveModel(
  model: string,
): { provider: ProviderId; apiId: string } | null {
  if (MODEL_MAP[model]) return MODEL_MAP[model];
  const l = model.toLowerCase();
  if (l.startsWith("claude")) return { provider: "anthropic", apiId: model };
  if (l.startsWith("gpt") || l.startsWith("o1") || l.startsWith("o3") || l.startsWith("o4"))
    return { provider: "openai", apiId: model };
  if (l.startsWith("gemini")) return { provider: "google", apiId: model };
  return null;
}

const ENV_KEY: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

export function apiKeyFor(
  provider: ProviderId,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const k = env[ENV_KEY[provider]];
  return k && k.trim() ? k.trim() : undefined;
}

export function providerEnabled(
  provider: ProviderId,
  env?: Record<string, string | undefined>,
): boolean {
  return !!apiKeyFor(provider, env);
}

export interface LLMRequest {
  model: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export type LLMResult =
  | { ok: true; text: string; provider: ProviderId; model: string }
  | { ok: false; error: string; provider?: ProviderId };

interface Deps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * Single graceful call. Never throws: returns {ok:false} on missing key,
 * network failure, timeout, or a non-2xx / malformed response.
 */
export async function callLLM(
  req: LLMRequest,
  deps: Deps = {},
): Promise<LLMResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const resolved = resolveModel(req.model);
  if (!resolved) return { ok: false, error: `неизвестная модель: ${req.model}` };
  const { provider, apiId } = resolved;

  const key = apiKeyFor(provider, env);
  if (!key)
    return { ok: false, provider, error: `нет ключа для ${provider} (ТЗ §4.6)` };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 30000);
  try {
    const { url, init } = buildRequest(provider, apiId, key, req);
    const res = await doFetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, provider, error: `${provider} HTTP ${res.status}` };
    }
    const json = await res.json();
    const text = extractText(provider, json);
    if (text == null) return { ok: false, provider, error: "пустой ответ модели" };
    return { ok: true, text, provider, model: apiId };
  } catch (e) {
    return {
      ok: false,
      provider,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildRequest(
  provider: ProviderId,
  apiId: string,
  key: string,
  req: LLMRequest,
): { url: string; init: RequestInit } {
  const maxTokens = req.maxTokens ?? 1024;
  if (provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: apiId,
          max_tokens: maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
        }),
      },
    };
  }
  if (provider === "openai") {
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.prompt },
    ];
    return {
      url: "https://api.openai.com/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model: apiId, max_completion_tokens: maxTokens, messages }),
      },
    };
  }
  // google
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${apiId}:generateContent?key=${encodeURIComponent(key)}`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: req.system
          ? { parts: [{ text: req.system }] }
          : undefined,
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    },
  };
}

function extractText(provider: ProviderId, json: any): string | null {
  try {
    if (provider === "anthropic") {
      const parts = json.content;
      return Array.isArray(parts)
        ? parts.map((p: any) => p.text ?? "").join("").trim() || null
        : null;
    }
    if (provider === "openai") {
      return json.choices?.[0]?.message?.content?.trim() ?? null;
    }
    return (
      json.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text ?? "")
        .join("")
        .trim() ?? null
    );
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Higher-level helpers with heuristic fallbacks (usable without keys)
// ------------------------------------------------------------

/**
 * Structured threshold extraction (ТЗ §3.2, "extract to JSON"). Returns the
 * parsed object or throws so thresholds.extractThresholds() can fall back to
 * the heuristic. Enforces JSON-only output and parses defensively.
 */
export async function llmExtractThresholds(
  prompt: string,
  model: string,
  deps: Deps = {},
): Promise<unknown> {
  const res = await callLLM(
    {
      model,
      system:
        "Ты извлекаешь числовые пороги стратегии ставок из текста. Верни ТОЛЬКО JSON с любыми из полей: maxPerBet, stop, minEdge, flatSize, kellyFraction, cap, tiers ([[edge%,fraction]...]), minConfidence. Доли — как доли 0..1, minEdge — в процентах. Без пояснений.",
      prompt,
      maxTokens: 400,
    },
    deps,
  );
  if (!res.ok) throw new Error(res.error);
  return JSON.parse(stripFences(res.text));
}

/** Generate a 1–2 word strategy name; falls back to a keyword heuristic. */
export async function generateStrategyName(
  prompt: string,
  model: string,
  deps: Deps = {},
): Promise<string> {
  const res = await callLLM(
    {
      model,
      system:
        "Придумай короткое название стратегии из 1–2 слов по её описанию. Верни только название.",
      prompt,
      maxTokens: 20,
    },
    deps,
  );
  if (res.ok) {
    const name = res.text.replace(/["'.]/g, "").trim().split(/\s+/).slice(0, 2).join(" ");
    if (name) return name;
  }
  return heuristicName(prompt);
}

export interface ReassessContext {
  match: string; minute: number | null; trigger: string;
  scoreHome: number | null; scoreAway: number | null;
  strategyName: string; strategyPrompt: string;
}

/**
 * Narrative reassessment for a strategy on a live event (ТЗ §2.12). Uses the
 * LLM when a key is present, otherwise a deterministic heuristic so triggers
 * still produce a reasoned note without any provider.
 */
export async function reassessNarrative(
  ctx: ReassessContext, model: string | null, deps: Deps = {},
): Promise<{ body: string; confidence: string; source: "llm" | "heuristic" }> {
  if (model) {
    const res = await callLLM({
      model,
      system: "Ты стратег ставок. По событию матча дай краткую переоценку (2–3 предложения): держать/добавить/фиксировать и почему. Учитывай правила стратегии.",
      prompt: `Матч ${ctx.match}, ${ctx.minute ?? "?"}', счёт ${ctx.scoreHome ?? "?"}:${ctx.scoreAway ?? "?"}. Триггер: ${ctx.trigger}. Стратегия «${ctx.strategyName}»: ${ctx.strategyPrompt}`,
      maxTokens: 200,
    }, deps);
    if (res.ok) return { body: res.text, confidence: "средняя", source: "llm" };
  }
  return { body: heuristicReassess(ctx), confidence: "средняя", source: "heuristic" };
}

export function heuristicReassess(ctx: ReassessContext): string {
  const score = `${ctx.scoreHome ?? 0}:${ctx.scoreAway ?? 0}`;
  const at = ctx.minute != null ? `${ctx.minute}'` : "по ходу";
  switch (ctx.trigger) {
    case "goal":
      return `Гол (${at}, счёт ${score}). Цена рынка сдвинулась — по правилам «${ctx.strategyName}» пересматриваю: если край сузился ниже порога, фиксирую часть позиции, иначе держу.`;
    case "red_card":
      return `Удаление (${at}). Баланс сил изменился; переоцениваю вероятности и экспозицию по дисциплине «${ctx.strategyName}».`;
    case "price_move":
      return `Значимое движение цены (${at}, счёт ${score}). Проверяю остаточный край против порога входа стратегии «${ctx.strategyName}».`;
    default:
      return `Переоценка (${at}, счёт ${score}) по стратегии «${ctx.strategyName}»: держу позицию, если край сохраняется.`;
  }
}

export interface AssessInput {
  home: string; away: string; sport: string; state: string;
  analyticsPrompt: string;
  markets: { label: string; price: number }[]; // price in cents
}
export interface MatchAssessment {
  ok: boolean;
  confidence: "низкая" | "средняя" | "высокая";
  short: string; body: string; verdict: string;
  markets: { label: string; prob: number }[]; // model probability 0..1 per market
  error?: string;
}

/**
 * Objective match assessment (ТЗ §2.9, аналитика). The analyst does NOT see
 * money (§9.5) — it only estimates probabilities and a narrative. Returns
 * ok:false on any failure so the caller can mark the assessment failed (§6).
 */
export async function assessMatchLLM(
  input: AssessInput, model: string, deps: Deps = {},
): Promise<MatchAssessment> {
  const marketList = input.markets.map((m) => `- ${m.label} (рынок: ${m.price}¢)`).join("\n");
  const res = await callLLM({
    model,
    system:
      "Ты — объективный спортивный аналитик. Оцени матч по инструкции. НЕ думай про деньги и ставки — только вероятности и разбор. Верни ТОЛЬКО JSON: {confidence:'низкая'|'средняя'|'высокая', short:'2-3 предложения', body:'развёрнутый разбор', verdict:'итог', markets:[{label, prob}]}. Для КАЖДОГО рынка из списка укажи prob — свою вероятность (0..1), что рынок сыграет ДА. Не копируй рыночную цену слепо: где видишь расхождение — покажи его.",
    prompt: `Спорт: ${input.sport}. Матч: ${input.home} — ${input.away} (состояние: ${input.state}).\n\nИнструкция аналитики:\n${input.analyticsPrompt}\n\nРынки для оценки:\n${marketList}`,
    maxTokens: 1500,
  }, deps);

  if (!res.ok) return failed(res.error);
  try {
    const j = JSON.parse(stripFences(res.text));
    const markets = Array.isArray(j.markets)
      ? j.markets.filter((m: any) => m && typeof m.label === "string" && typeof m.prob === "number")
          .map((m: any) => ({ label: String(m.label), prob: clamp01(m.prob) }))
      : [];
    return {
      ok: true,
      confidence: (["низкая", "средняя", "высокая"].includes(j.confidence) ? j.confidence : "средняя"),
      short: String(j.short ?? ""), body: String(j.body ?? ""), verdict: String(j.verdict ?? ""),
      markets,
    };
  } catch {
    return failed("невалидный JSON от модели");
  }
}
function failed(error?: string): MatchAssessment {
  return { ok: false, confidence: "средняя", short: "", body: "", verdict: "", markets: [], error };
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export interface ImprovementProposal {
  removed: string; added: string; newPrompt: string; reason: string; source: "llm" | "heuristic";
}

/**
 * Propose a strategy-prompt improvement from its stats (ТЗ §3.5). LLM when a
 * key is present, else a deterministic heuristic. Callers gate on samples ≥ 20
 * and re-extract params from newPrompt in CODE (§9.6).
 */
export async function proposeImprovement(
  strat: { name: string; prompt: string }, stats: { matches: number; roi: number },
  model: string | null, deps: Deps = {},
): Promise<ImprovementProposal> {
  if (model) {
    const res = await callLLM({
      model,
      system: "Ты улучшаешь промт стратегии ставок по её статистике. Верни ТОЛЬКО JSON {newPrompt, reason}: минимальная осмысленная правка промта и краткое обоснование.",
      prompt: `Стратегия «${strat.name}». Текущий промт:\n${strat.prompt}\n\nСтатистика: сыграно ${stats.matches} матчей, средний ROI ${stats.roi.toFixed(1)}%. Предложи одно улучшение.`,
      maxTokens: 500,
    }, deps);
    if (res.ok) {
      try {
        const j = JSON.parse(stripFences(res.text));
        if (j.newPrompt) return { removed: "(текущий промт)", added: "(предложение ИИ)", newPrompt: String(j.newPrompt), reason: String(j.reason ?? ""), source: "llm" };
      } catch { /* fall through to heuristic */ }
    }
  }
  return heuristicImprovement(strat, stats);
}

export function heuristicImprovement(
  strat: { name: string; prompt: string }, stats: { matches: number; roi: number },
): ImprovementProposal {
  const newPrompt = /Входи/.test(strat.prompt)
    ? strat.prompt.replace(/Входи[^\n]*/, "Входи ТОЛЬКО при уверенности «высокая» — входы на средней отключены (по данным убыточны).")
    : strat.prompt + "\nВходи только при высокой уверенности.";
  return {
    removed: "Входи при любой уверенности…",
    added: "Входи ТОЛЬКО при «высокой» уверенности",
    newPrompt,
    reason: `На ${stats.matches} матчах входы при средней уверенности дали отрицательный вклад — ужесточаем порог.`,
    source: "heuristic",
  };
}

export function heuristicName(prompt: string): string {
  const low = prompt.toLowerCase();
  if (low.includes("келли") || low.includes("kelly")) return "Kelly Edge";
  if (low.includes("лесен") || low.includes("ступен")) return "Tiered Edge";
  if (low.includes("фикс") || low.includes("всегда")) return "Flat Bet";
  if (low.includes("плей-офф") || low.includes("playoff")) return "Playoff Guard";
  if (low.includes("покрыт") || low.includes("сет")) return "Surface Edge";
  if (low.includes("высок")) return "High Conviction";
  if (low.includes("стоп")) return "Guarded";
  return "Custom";
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}
