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

/**
 * Overlay UI-provided keys (from the DB) onto the environment. The environment
 * wins — a deployment secret is never overridden by a UI key — so this only
 * fills providers the env doesn't already set. Returns a plain env object to
 * pass as `deps.env` to any LLM call site; llm.ts itself stays db-agnostic.
 */
export function effectiveEnv(
  dbKeys: Partial<Record<string, string | undefined>>,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = { ...base };
  for (const p of Object.keys(ENV_KEY) as ProviderId[]) {
    const cur = env[ENV_KEY[p]];
    if ((!cur || !cur.trim()) && dbKeys[p]) env[ENV_KEY[p]] = dbKeys[p];
  }
  return env;
}

export interface LLMRequest {
  model: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Extra attempts on a TRANSIENT failure (network blip / 5xx / rate-limit).
   *  Total attempts = 1 + retries. Default 2. A hard failure (auth, bad request,
   *  our own response-timeout abort) never retries. */
  retries?: number;
  /** Base backoff (ms) between retries; doubles each attempt. Default 400. */
  retryBackoffMs?: number;
  /** Anthropic prompt caching: mark the `system` block as a cacheable prefix
   *  (cache_control ephemeral). Only helps when `system` is a large STABLE prefix
   *  reused across many calls (e.g. the live strategist's rules + methodology,
   *  resent every reassess of a match). Ignored for openai/google (their caching
   *  is automatic). Below the model's min cacheable size it silently no-ops. */
  cacheSystem?: boolean;
}

export type LLMResult =
  | { ok: true; text: string; provider: ProviderId; model: string }
  | { ok: false; error: string; provider?: ProviderId };

interface Deps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Injectable delay so tests don't wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HTTP statuses worth a retry (transient upstream state), vs a 4xx that will
 *  fail identically on retry (auth / bad request / not found). 529 = Anthropic
 *  "overloaded"; 429 = rate limit; 5xx = upstream hiccup. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 529 || (status >= 500 && status <= 504);
}

/**
 * Single graceful call with retry on TRANSIENT failures. Never throws: returns
 * {ok:false} on missing key, network failure, timeout, or a non-2xx / malformed
 * response. A network blip (ETIMEDOUT / ECONNRESET / "fetch failed"), a 5xx, or a
 * rate-limit is retried with backoff — one dropped socket must not sink a whole
 * live cycle (8/8 pairs failing on the same hiccup). Hard failures — auth, bad
 * request, our own 120s response-timeout abort — do NOT retry (a retry would just
 * wait again for the same wall).
 */
export async function callLLM(
  req: LLMRequest,
  deps: Deps = {},
): Promise<LLMResult> {
  const env = deps.env ?? process.env;
  const resolved = resolveModel(req.model);
  if (!resolved) return { ok: false, error: `неизвестная модель: ${req.model}` };
  const { provider, apiId } = resolved;

  const key = apiKeyFor(provider, env);
  if (!key)
    return { ok: false, provider, error: `нет ключа для ${provider} (ТЗ §4.6)` };

  const maxAttempts = 1 + Math.max(0, req.retries ?? 2);
  const doSleep = deps.sleep ?? sleep;
  let last: LLMResult = { ok: false, provider, error: "нет попыток" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { result, retryable } = await callLLMOnce(req, deps, provider, apiId, key);
    if (result.ok) return result;
    last = result;
    if (!retryable || attempt >= maxAttempts) break;
    // 400, 800, … ms (+ small jitter-free determinism for tests).
    await doSleep((req.retryBackoffMs ?? 400) * 2 ** (attempt - 1));
  }
  return last;
}

/** Appended verbatim to the prompt on a CONTENT re-ask. Firm, format-only — it
 *  never changes the task, only insists on clean JSON. */
export const JSON_REPAIR_NUDGE =
  "\n\nВНИМАНИЕ: твой предыдущий ответ НЕ распарсился как JSON. Верни СТРОГО один валидный JSON-объект по описанной выше схеме — без markdown-заборов (```), без любого текста до или после, все строки в двойных кавычках, без висячих запятых. Только JSON.";

/**
 * callLLM + parse, with ONE content-level RE-ASK on unparseable output. This is the
 * rung ABOVE parseJsonLoose/repairJson: the repair fixes salvageable malformations in
 * place; when a reply is UNsalvageable (truncated mid-value, a refusal/prose, the wrong
 * shape) we re-ask once with a firm "JSON only" nudge before declaring the call failed.
 * Distinct from callLLM's NETWORK retry — a dropped socket re-sends the SAME request;
 * this re-sends a CORRECTED request, and ONLY after we actually got text that won't
 * parse. On a provider/network failure it returns {ok:false} WITHOUT a content re-ask
 * (not a formatting problem — callLLM already retried it). `parse` throwing is the
 * signal to re-ask, so callers throw for a structurally-wrong-but-valid-JSON reply too
 * (e.g. missing required fields), not just for a JSON syntax error.
 */
export async function callLLMParsed<T>(
  req: LLMRequest,
  parse: (text: string) => T,
  deps: Deps = {},
  jsonRetries = 1,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const attempts = 1 + Math.max(0, jsonRetries);
  let lastText = "";
  let providerErr: string | null = null;
  for (let a = 1; a <= attempts; a++) {
    const r = await callLLM(a === 1 ? req : { ...req, prompt: req.prompt + JSON_REPAIR_NUDGE }, deps);
    if (!r.ok) { providerErr = r.error; break; } // network/provider outage — no content re-ask
    lastText = r.text;
    try { return { ok: true, value: parse(r.text) }; } catch { /* re-ask on the next iteration, or fall out */ }
  }
  if (providerErr != null) return { ok: false, error: providerErr };
  const tail = lastText.slice(-160).replace(/\s+/g, " ");
  return { ok: false, error: `невалидный JSON от модели (хвост: …${tail})` };
}

/** One HTTP attempt. Returns the result plus whether the failure is worth a retry. */
async function callLLMOnce(
  req: LLMRequest, deps: Deps, provider: ProviderId, apiId: string, key: string,
): Promise<{ result: LLMResult; retryable: boolean }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  // 120s: the analytics/strategist calls send a long prompt + many markets and
  // Opus can take 40–70s; 30s aborted them mid-flight ("operation was aborted").
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 120_000);
  try {
    const { url, init } = buildRequest(provider, apiId, key, req);
    const res = await doFetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const hint = body.slice(0, 200).replace(/\s+/g, " ");
      return { result: { ok: false, provider, error: `${provider} HTTP ${res.status}${hint ? ` — ${hint}` : ""}` }, retryable: retryableStatus(res.status) };
    }
    const json = await res.json();
    const text = extractText(provider, json);
    // An EMPTY completion (2xx but no text — an overload/safety stop / transient hiccup) is TRANSIENT,
    // not a hard failure: re-sending the same request usually gets a real answer. Marking it retryable
    // routes it through callLLM's backoff so the strategist gets its retries instead of silently
    // dropping the decision on the first empty reply (the Visker 40→4 "failure masked as a decision").
    if (text == null) return { result: { ok: false, provider, error: "пустой ответ модели" }, retryable: true };
    return { result: { ok: true, text, provider, model: apiId }, retryable: false };
  } catch (e) {
    // undici's fetch throws a bare "fetch failed" and hides the real reason on
    // `.cause` (ENOTFOUND / ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT / TLS / an
    // abort on timeout). Surface it so a network failure in production is
    // actually diagnosable instead of an opaque "fetch failed".
    const msg = e instanceof Error ? e.message : String(e);
    const cause = (e as any)?.cause;
    const code = cause?.code || cause?.message;
    const detail = cause ? ` (${code || String(cause)})` : "";
    const aborted = (e as any)?.name === "AbortError" || /abort/i.test(msg);
    // Transient network faults are worth a retry; our own timeout-abort is not
    // (it already waited the full window — retrying just waits it again).
    const transient = !aborted && /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EPIPE|socket|UND_ERR|network|terminated/i.test(`${msg} ${code ?? ""}`);
    return {
      result: { ok: false, provider, error: aborted ? `модель не ответила за отведённое время (таймаут)` : `${msg}${detail}` },
      retryable: transient,
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
    // Prompt caching: when the caller flags a large stable prefix, send `system`
    // as a content block with cache_control so the repeated live-reassess calls
    // for one match read it at ~0.1× instead of re-billing it every tick.
    const system = req.system == null ? undefined
      : req.cacheSystem
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : req.system;
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
          ...(system !== undefined ? { system } : {}),
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
        "Ты извлекаешь числовые пороги стратегии ставок из текста. Верни ТОЛЬКО JSON с любыми из полей: maxPerBet, stop, minEdge, flatSize, kellyFraction, cap, tiers ([[edge%,fraction]...]), minConfidence, takeProfit, exitStop. Доли (maxPerBet, flatSize, cap, stop) — как доли 0..1; stop — доля просадки портфеля 0..1. minEdge — в процентах. takeProfit — доля прибыли позиции для фиксации (0.5 = +50%); exitStop — доля убытка позиции для выхода (0..1). minConfidence — строго одно из: 'низкая'|'средняя'|'высокая'. Без пояснений.",
      prompt,
      maxTokens: 400,
    },
    deps,
  );
  if (!res.ok) throw new Error(res.error);
  return parseJsonLoose(res.text);
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
  // Market LABELS only — NO prices. The analyst estimates probabilities blind to
  // the market (§9.5); the engine computes edge = model prob vs price in code.
  // Feeding the quote here would anchor the estimate and make "edge" circular.
  markets: { label: string }[];
  context?: string; // real lineups + in-match events (from ESPN), if available
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
  const marketList = input.markets.map((m) => `- ${m.label}`).join("\n");
  const res = await callLLM({
    model,
    system:
      "Ты — объективный спортивный аналитик. Оцени матч по методологии из инструкции. НЕ думай про деньги/ставки/котировки — их ты НЕ видишь и видеть не должен. Дай ЧЕСТНУЮ независимую вероятность от себя, а не подгонку под рынок. " +
      "ВАЖНО ПРО ФОРМАТ: инструкция аналитики описывает КАК думать, а не формат ответа. Что бы она ни говорила про формат — ты обязан вернуть ТОЛЬКО валидный JSON (без markdown-ограждений, без текста до/после): " +
      "{confidence:'низкая'|'средняя'|'высокая', short:'2-3 предложения', body:'сжатый разбор, ключевое', verdict:'итог одним абзацем', markets:[{label, prob}]}. " +
      "body держи компактным (до ~600 слов). Для КАЖДОГО рынка из списка укажи prob — свою вероятность (0..1), что рынок сыграет ДА (используй ТОЧНЫЙ label из списка).",
    prompt: `Спорт: ${input.sport}. Матч: ${input.home} — ${input.away} (состояние: ${input.state}).\n\nМЕТОДОЛОГИЯ АНАЛИЗА (как думать):\n${input.analyticsPrompt}\n${input.context ? `\nФАКТИЧЕСКИЕ ДАННЫЕ (составы/события):\n${input.context}\n` : ""}\nРынки для оценки (дай prob для каждого):\n${marketList}\n\nОтветь СТРОГО одним JSON-объектом в описанном формате — без пояснений вне JSON.`,
    maxTokens: 6000,
  }, deps);

  if (!res.ok) return failed(res.error);
  try {
    const j = parseJsonLoose(res.text);
    const markets = Array.isArray(j.markets)
      ? j.markets.filter((m: any) => m && typeof m.label === "string" && Number.isFinite(m.prob))
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

// ------------------------------------------------------------
// Football analysis — Layer 1 (structured CORE, no quotes). The model estimates
// only xG + first-half shares + scenarios; the ENGINE (poisson.ts) derives every
// market. See football_analysis_schema. Prices are never shown to the analyst.
// ------------------------------------------------------------

export interface FootballCore { xg_home: number; xg_away: number; home_share_1h: number; away_share_1h: number; poisson_correction: number }
export interface FootballOverride { target: string; adjust: number; reason: string }
export interface FootballAnalysis {
  ok: boolean;
  matchType: "group" | "knockout" | "uncertain";
  matchTypeReason: string;
  core: FootballCore;
  overrides: FootballOverride[];
  drivers: { factor: string; direction: string; magnitude: string; confidence: number }[];
  scenarios: { trigger: string; prob: number; shifts: unknown; note: string }[];
  calibration: { xg_confidence: number; scenario_confidence: number; sample_size: number; notes: string };
  unknowns: string[];
  error?: string;
}
export interface FootballAssessInput {
  home: string; away: string; state: string;
  analyticsPrompt: string;   // the base football prompt (methodology + rules)
  marketLabels: string[];    // available markets — used ONLY to infer match_type, never as quotes
  context?: string;          // real lineups / stats / events (no prices)
}

const num = (x: unknown, def = 0): number => (Number.isFinite(x) ? Number(x) : def);

export async function assessFootballStructured(
  input: FootballAssessInput, model: string, deps: Deps = {},
): Promise<FootballAnalysis> {
  const parsed = await callLLMParsed({
    model,
    system:
      "Ты — футбольный аналитик Слоя 1. Следуй методологии из промпта пользователя и верни СТРОГО один JSON-объект по схеме ниже — без markdown-заборов, без текста вокруг. " +
      "Ты оцениваешь ТОЛЬКО ядро (несколько чисел) и сценарии; весь рынок (тоталы/форы/BTTS/исход) посчитает код по Пуассону — сам их НЕ считай. Котировки НЕ используешь. " +
      "РАЗДЕЛЕНИЕ СЛОЁВ (важно): здесь ты оцениваешь ЧИСТУЮ силу матча — качество и форму команд, составы, фундаментальные xG. НЕ применяй нарративы КОНТЕКСТА ТУРНИРА: репутацию/престиж турнира, историческую сверх- или недо-результативность сборной на больших турнирах, шаблоны вроде «в плей-офф андердог осторожен / паркует автобус», мотивационные поправки на стадию. Эти корректировки — ИСКЛЮЧИТЕЛЬНО задача Слоя 2 (специалист категории). Если применить один и тот же нарратив и здесь, и в Слое 2, он посчитается дважды и раздует край (кейс France—Morocco: фаворит был занижен в обоих слоях). Тут — только фундамент. " +
      "СХЕМА: {match_type:'group'|'knockout'|'uncertain', match_type_reason:str, " +
      "core:{xg_home:float, xg_away:float, home_share_1h:float 0..1, away_share_1h:float 0..1, poisson_correction:float (0=чистый Пуассон, >0 повышает ничьи; эффективный диапазон −0.1..0.1 — больше движок обрежет)}, " +
      "overrides:[{target:'напр. totals_match.2.5.over или outcome_90.draw', adjust:float (сдвиг вероятности), reason:str}] (пусто если нет; КАЖДЫЙ с reason), " +
      "drivers:[{factor:str, direction:str, magnitude:'small'|'medium'|'large', confidence:float 0..1}], " +
      "scenarios:[{trigger:str, prob:float 0..1, shifts:{outcome_90:{home,draw,away}, xg_remaining_home:float, xg_remaining_away:float, note:str}}] (МИНИМУМ 5 узлов), " +
      "calibration:{xg_confidence:float 0..1, scenario_confidence:float 0..1, sample_size:int, notes:str}, unknowns:[str]}. " +
      "Блок derived НЕ заполняй — его считает код.",
    prompt: `${input.analyticsPrompt}\n\n## ВХОДНЫЕ ДАННЫЕ\nМатч: ${input.home} — ${input.away} (состояние: ${input.state}).\nДоступные рынки (ТОЛЬКО чтобы определить match_type — это НЕ котировки, цен тут нет):\n${input.marketLabels.map((l) => `- ${l}`).join("\n")}\n${input.context ? `\nФАКТИЧЕСКИЕ ДАННЫЕ (составы/статистика/события):\n${input.context}\n` : ""}\nВерни ТОЛЬКО JSON по схеме.`,
    maxTokens: 6000,
  },
  // Throw on unparseable OR structurally-wrong (no xg core) so callLLMParsed re-asks
  // once with a JSON-only nudge before the analysis is marked failed.
  (text) => { const j = parseJsonLoose(text); if (!Number.isFinite(j?.core?.xg_home) || !Number.isFinite(j?.core?.xg_away)) throw new Error("нет xg_home/xg_away в core"); return j; },
  deps);
  if (!parsed.ok) return failedFootball(parsed.error);
  {
    const j = parsed.value;
    const c = j.core ?? {};
    const mt = ["group", "knockout", "uncertain"].includes(j.match_type) ? j.match_type : "uncertain";
    return {
      ok: true,
      matchType: mt,
      matchTypeReason: String(j.match_type_reason ?? ""),
      core: {
        xg_home: num(c.xg_home), xg_away: num(c.xg_away),
        home_share_1h: c.home_share_1h != null ? clamp01(num(c.home_share_1h, 0.44)) : 0.44,
        away_share_1h: c.away_share_1h != null ? clamp01(num(c.away_share_1h, 0.44)) : 0.44,
        poisson_correction: num(c.poisson_correction, 0),
      },
      overrides: Array.isArray(j.overrides)
        ? j.overrides.filter((o: any) => o && typeof o.target === "string" && Number.isFinite(o.adjust) && typeof o.reason === "string" && o.reason.trim())
            .map((o: any) => ({ target: String(o.target), adjust: num(o.adjust), reason: String(o.reason) }))
        : [],
      drivers: Array.isArray(j.drivers) ? j.drivers.filter((x: any) => x && typeof x.factor === "string").map((x: any) => ({ factor: String(x.factor), direction: String(x.direction ?? ""), magnitude: String(x.magnitude ?? "medium"), confidence: clamp01(num(x.confidence, 0.5)) })) : [],
      scenarios: Array.isArray(j.scenarios) ? j.scenarios.filter((x: any) => x && typeof x.trigger === "string").map((x: any) => ({ trigger: String(x.trigger), prob: clamp01(num(x.prob, 0)), shifts: x.shifts ?? null, note: String(x.shifts?.note ?? x.note ?? "") })) : [],
      calibration: {
        xg_confidence: clamp01(num(j.calibration?.xg_confidence, 0.5)),
        scenario_confidence: clamp01(num(j.calibration?.scenario_confidence, 0.5)),
        sample_size: Math.max(0, Math.round(num(j.calibration?.sample_size, 0))),
        notes: String(j.calibration?.notes ?? ""),
      },
      unknowns: Array.isArray(j.unknowns) ? j.unknowns.map((u: any) => String(u)).filter(Boolean) : [],
    };
  }
}
function failedFootball(error?: string): FootballAnalysis {
  return { ok: false, matchType: "uncertain", matchTypeReason: "", core: { xg_home: 0, xg_away: 0, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0, scenario_confidence: 0, sample_size: 0, notes: "" }, unknowns: [], error };
}

// ------------------------------------------------------------
// Category modifier — Layer 2. Given the Layer-1 base analysis, the specialist
// outputs ONLY deltas specific to a category (e.g. World Cup): core adjustments,
// new drivers/scenarios, override tweaks, confidence shifts. It never recomputes
// the match and never sees quotes. The deterministic assembler folds it in.
// ------------------------------------------------------------

export interface CategoryDelta {
  ok: boolean;
  coreAdjustments: { target: string; op: "multiply" | "add"; value: number; reason: string }[];
  newDrivers: { factor: string; direction: string; magnitude: string; confidence: number }[];
  newScenarios: { trigger: string; prob: number; shifts: unknown; note: string }[];
  overrideAdjustments: { target: string; adjust: number; reason: string }[];
  confidenceXgDelta: number;
  confidenceScenarioDelta: number;
  notes: string;
  error?: string;
}

export async function assessCategoryModifier(
  modifierPrompt: string, base: FootballAnalysis, home: string, away: string, model: string, deps: Deps = {},
): Promise<CategoryDelta> {
  // Show the specialist the Layer-1 output (NO prices) so it corrects, not recomputes.
  const baseJson = JSON.stringify({ match_type: base.matchType, core: base.core, drivers: base.drivers, scenarios: base.scenarios, calibration: base.calibration, unknowns: base.unknowns });
  const failedDelta = (error?: string): CategoryDelta => ({ ok: false, coreAdjustments: [], newDrivers: [], newScenarios: [], overrideAdjustments: [], confidenceXgDelta: 0, confidenceScenarioDelta: 0, notes: "", error });
  const parsed = await callLLMParsed({
    model,
    system:
      "Ты — специалист по специфике КАТЕГОРИИ (напр. ЧМ). Тебе дан готовый базовый анализ (Слой 1). Ты НЕ пересчитываешь матч и НЕ выдаёшь готовые вероятности — только ДЕЛЬТЫ, специфичные для категории, каждая с причиной. Котировки не используешь. Верни СТРОГО один JSON — без markdown, без текста вокруг. " +
      "Именно ТЫ — единственный слой, который вносит нарративы контекста турнира (репутация/стадия турнира, мотивация, историческое поведение сборных в плей-офф, дисциплина андердога в кубках). Слой 1 их НЕ применял, поэтому здесь их вносить — не двойной счёт, а твоя работа. Но вноси только то, что реально меняет исход, и одной поправкой, а не тем же нарративом в нескольких целях. " +
      "СХЕМА: {core_adjustments:[{target:'xg_home|xg_away|home_share_1h|away_share_1h|poisson_correction', op:'multiply'|'add', value:float, reason:str}], " +
      "new_drivers:[{factor,direction,magnitude:'small'|'medium'|'large',confidence:float,reason}], " +
      "new_scenarios:[{trigger,prob:float,shifts:{},reason}], " +
      "override_adjustments:[{target:'напр. totals_match.2.5.over', adjust:float, reason}], " +
      "confidence_adjustments:{xg_confidence_delta:float, scenario_confidence_delta:float, reason:str}, notes:str}. " +
      "Пусто — если специфики мало. Лучше две обоснованные поправки, чем десять натянутых.",
    prompt: `${modifierPrompt}\n\n## БАЗОВЫЙ АНАЛИЗ (Слой 1) — корректируй его, не переписывай:\nМатч: ${home} — ${away}.\n${baseJson}\n\nВерни ТОЛЬКО JSON с дельтами по схеме.`,
    maxTokens: 3000,
  }, (text) => parseJsonLoose(text), deps);
  if (!parsed.ok) return failedDelta(parsed.error);
  {
    const j = parsed.value;
    const reasoned = (x: any) => x && typeof x.reason === "string" && x.reason.trim();
    return {
      ok: true,
      coreAdjustments: Array.isArray(j.core_adjustments) ? j.core_adjustments.filter((o: any) => reasoned(o) && Number.isFinite(o.value) && (o.op === "multiply" || o.op === "add") && typeof o.target === "string").map((o: any) => ({ target: String(o.target), op: o.op, value: num(o.value), reason: String(o.reason) })) : [],
      newDrivers: Array.isArray(j.new_drivers) ? j.new_drivers.filter((x: any) => x && typeof x.factor === "string").map((x: any) => ({ factor: String(x.factor), direction: String(x.direction ?? ""), magnitude: String(x.magnitude ?? "medium"), confidence: clamp01(num(x.confidence, 0.5)) })) : [],
      newScenarios: Array.isArray(j.new_scenarios) ? j.new_scenarios.filter((x: any) => x && typeof x.trigger === "string").map((x: any) => ({ trigger: String(x.trigger), prob: clamp01(num(x.prob, 0)), shifts: x.shifts ?? null, note: String(x.shifts?.note ?? x.note ?? "") })) : [],
      overrideAdjustments: Array.isArray(j.override_adjustments) ? j.override_adjustments.filter((o: any) => reasoned(o) && Number.isFinite(o.adjust) && typeof o.target === "string").map((o: any) => ({ target: String(o.target), adjust: num(o.adjust), reason: String(o.reason) })) : [],
      confidenceXgDelta: num(j.confidence_adjustments?.xg_confidence_delta, 0),
      confidenceScenarioDelta: num(j.confidence_adjustments?.scenario_confidence_delta, 0),
      notes: String(j.notes ?? ""),
    };
  }
}

// ------------------------------------------------------------
// Strategist — turns a strategy PROMPT (any methodology) into market picks
// (§9.5: strategy reads analytics; §9.6: CODE still sizes the actual stake).
// This is what makes the strategy universal — the prompt drives the decisions,
// nothing about a specific methodology is hard-coded.
// ------------------------------------------------------------

export interface StrategistInput {
  strategyName: string; strategyPrompt: string;
  match: { home: string; away: string; sport: string; state: string; minute: number | null; scoreHome: number | null; scoreAway: number | null; minuteApprox?: number | null };
  assessment: { confidence: string; short: string; verdict: string };
  markets: { label: string; priceCents: number; aiProb: number | null; liquidity?: number | null; openCents?: number | null; conflict?: string | null; liveProbAdjusted?: { prob: number; note: string } | null }[];
  openPositions: { market: string; entryCents: number; currentCents: number }[];
  context?: string; // real lineups + in-match events (ESPN) — the reassessment triggers
}
/** The exit plan the strategist attaches to an entry at ENTRY time (the v3
 *  battle-sheet: how this leg should be closed). Free-text triggers the live
 *  window then executes. Optional — a minimal pick carries none of it. */
export interface StrategistExitPlan {
  take_price?: string; thesis_stop?: string; counter_scenario_stop?: string;
  /** Time-conditioned plan for a MELTING option: the minute past which the strategist
   *  won't sit the position to zero if the event hasn't happened. A DETERMINISTIC layer
   *  (evaluateExits) fires it — minute is a fact, not an LLM judgment. */
  time_stop?: { minute: number; condition?: string; action?: "close_full" | "close_half" };
}
export interface StrategistPick {
  label: string; conviction: "низкая" | "средняя" | "высокая"; reason: string; prob?: number;
  // v3 tree-reasoning metadata (optional). The ENGINE still sizes from `prob`
  // (§9.6 invariant); these are captured for the battle sheet / display / audit,
  // NOT used to compute stakes.
  role?: "anchor" | "satellite";
  livesInBranches?: string[];    // which outcome_scenarios branches this bet wins in
  branchWeightSum?: number;      // Σ weight of those branches — "in how many outcomes it lives"
  phantomCheck?: string;         // anti-phantom verdict for this bet
  totalCheck?: string;           // total_note reconciliation on a borderline total
  exitPlan?: StrategistExitPlan; // the pre-written exit plan for the live window
}
export interface StrategistExit {
  market: string; reason: string; fraction: number; // fraction 0..1 of the position to close
  /** Which live trigger fired (free-form: take_price / thesis_stop / counter_scenario
   *  / liquidity_time_stop, or a strategy-specific one like goal_scored /
   *  pressure_faded / counterattack_conceded). Recorded in the exit log. */
  trigger?: string;
}
/** Score-correlation summary the strategist reports for a portfolio (v3). */
export interface StrategistPortfolioCorrelation { both_lose_on_scores?: string[]; both_lose_weight?: number; coverage_note?: string }
export interface StrategistDecision {
  ok: boolean; picks: StrategistPick[]; exits: StrategistExit[]; note: string; source: "llm" | "none"; error?: string;
  // v3 top-level reasoning (optional, stored in the battle sheet / strategist artifact).
  matchShape?: "A" | "B" | "C" | "mixed";
  currentBranch?: string;        // live: which of the 6 branches the match is currently in
  portfolioCorrelation?: StrategistPortfolioCorrelation;
  rejected?: { market: string; reason: string }[];
  flagged?: { market: string; reason: string }[];
  /** Overreaction prematch: the buyback triggers armed for the live window (scenario
   *  trigger + target price + false-signal filter). Passed through verbatim — the
   *  live strategist reads them from the battle sheet to execute the buyback. */
  liveTriggersArmed?: unknown[];
  /** Live xG prematch: the live-entry config (xg_gap_threshold tuned to match_shape,
   *  min_pressure_duration). Passed through to the live window via the battle sheet. */
  liveEntryConfig?: unknown;
}

/**
 * Apply the strategy's methodology (its prompt) to a match: which markets to
 * ENTER (with conviction + a nameable reason) and which OPEN positions to EXIT.
 * The model must follow the prompt literally — entry discipline, "name why the
 * market is wrong", no conflicting bets, in-match management. Returns picks;
 * the engine sizes and gates them (budget/caps/stop) in code.
 */
/** Normalise the strategist's JSON (any of the three window schemas — picks/
 *  pre_match_positions/actions, exits/actions) into the engine's action core
 *  {picks, exits} plus the captured v3 reasoning. Tolerant of key aliases so a
 *  strategy can output in its own methodology's shape. The engine still SIZES
 *  from pick.prob (§9.6) — the rich fields are metadata for the battle sheet. */
export function normalizeStrategistJson(j: any): Omit<StrategistDecision, "ok" | "source" | "error"> {
  const conv = (c: unknown) => (["низкая", "средняя", "высокая"].includes(c as string) ? c : "средняя") as StrategistPick["conviction"];
  const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? String(x) : undefined);
  const arrStr = (x: unknown): string[] | undefined => (Array.isArray(x) ? x.map((v) => String(v)).filter(Boolean) : undefined);
  const isAdd = (a: unknown) => a === "add" || a === "open_new";
  const isClose = (a: unknown) => a === "reduce" || a === "close";
  // ENTRY sources: explicit picks, v3 pre_match_positions, or live actions=add.
  const rawEntries: any[] = [
    ...(Array.isArray(j.picks) ? j.picks : []),
    ...(Array.isArray(j.pre_match_positions) ? j.pre_match_positions : []),
    ...(Array.isArray(j.actions) ? j.actions.filter((a: any) => a && isAdd(a.action)) : []),
  ];
  const picks: StrategistPick[] = rawEntries
    .filter((p: any) => p && (typeof p.label === "string" || typeof p.market === "string"))
    .map((p: any) => {
      const probRaw = Number.isFinite(p.prob) ? p.prob : Number.isFinite(p.our_prob) ? p.our_prob : null;
      const ex = p.exit && typeof p.exit === "object" ? p.exit : null;
      // time_stop: {minute, condition?, action?} — the strategist's planned time cut for a
      // melting option. Minute is required and finite; action defaults to a full close.
      const ts = ex?.time_stop && typeof ex.time_stop === "object" ? ex.time_stop : null;
      const tsMinute = ts && Number.isFinite(ts.minute) ? Number(ts.minute) : null;
      const timeStop = tsMinute != null && tsMinute > 0
        ? { minute: tsMinute, ...(str(ts.condition) ? { condition: str(ts.condition) } : {}), action: (ts.action === "close_half" ? "close_half" : "close_full") as "close_full" | "close_half" }
        : null;
      const exitPlan: StrategistExitPlan | undefined = ex
        ? { ...(str(ex.take_price) ? { take_price: str(ex.take_price) } : {}), ...(str(ex.thesis_stop) ? { thesis_stop: str(ex.thesis_stop) } : {}), ...(str(ex.counter_scenario_stop) ? { counter_scenario_stop: str(ex.counter_scenario_stop) } : {}), ...(timeStop ? { time_stop: timeStop } : {}) }
        : undefined;
      return {
        label: String(p.label ?? p.market),
        conviction: conv(p.conviction),
        reason: String(p.reason ?? p.phantom_check ?? ""),
        ...(probRaw != null ? { prob: clamp01(probRaw) } : {}),
        ...(p.role === "anchor" || p.role === "satellite" ? { role: p.role } : {}),
        ...(arrStr(p.lives_in_branches) ? { livesInBranches: arrStr(p.lives_in_branches) } : {}),
        ...(Number.isFinite(p.branch_weight_sum) ? { branchWeightSum: Number(p.branch_weight_sum) } : {}),
        ...(str(p.phantom_check) ? { phantomCheck: str(p.phantom_check) } : {}),
        ...(str(p.total_check) ? { totalCheck: str(p.total_check) } : {}),
        ...(exitPlan && Object.keys(exitPlan).length ? { exitPlan } : {}),
      } as StrategistPick;
    });
  // EXIT sources: explicit `exits`, live `actions`=reduce/close, AND `exit_checks`
  // — the per-position exit channel the live prompts emit ({position, trigger_hit,
  // action}). A close expressed ONLY in exit_checks must still fire, so we include
  // any exit_check whose trigger actually fired (trigger_hit not none/empty) or
  // whose action is a close/reduce. The live loop dedups by resolved bet id, so an
  // exit that also appears in `actions` won't double-close.
  const trig = (t: unknown): string | undefined => (typeof t === "string" && t.trim() ? String(t) : undefined);
  const fired = (e: any): boolean => {
    const th = typeof e.trigger_hit === "string" ? e.trigger_hit.trim().toLowerCase() : "";
    // A NEGATIVE answer means the trigger did NOT fire. The model writes free text and
    // the negation is not always the LEADING word — "ещё нет", "пока нет", "пока не
    // сработал стоп" all mean "not yet / hold". Match a standalone negation WORD
    // anywhere (Unicode letter-boundaries, since ASCII \b never fires after Cyrillic),
    // so a held position isn't force-closed (harmless when up, a wrong cut when down).
    // "недооценка отыграна" is NOT suppressed — "не" there is glued to a letter, not a
    // standalone word. A deliberate action:close still fires regardless (isClose).
    const negative = !th || /(^|[^\p{L}])(нет|не|no|not|none|н\/д)($|[^\p{L}])/u.test(th);
    return !negative || isClose(e.action);
  };
  const fracOf = (e: any): number => {
    if (typeof e.fraction === "number" && e.fraction > 0 && e.fraction <= 1) return e.fraction;
    const a = typeof e.action === "string" ? e.action.toLowerCase() : "";
    if (a.includes("reduce") || a.includes("частичн") || a.includes("половин")) { if (Number.isFinite(e.size_pct)) { const v = Number(e.size_pct); return v > 1 ? Math.min(1, v / 100) : v > 0 ? v : 0.5; } return 0.5; }
    return 1; // close / thesis_stop / counter_scenario etc. → full
  };
  const rawExits: any[] = [
    ...(Array.isArray(j.exits) ? j.exits : []),
    ...(Array.isArray(j.actions) ? j.actions.filter((a: any) => a && isClose(a.action)) : []),
    ...(Array.isArray(j.exit_checks) ? j.exit_checks.filter((e: any) => e && (e.market || e.position) && fired(e)) : []),
  ];
  const exits: StrategistExit[] = rawExits
    .filter((e: any) => e && (typeof e.market === "string" || typeof e.position === "string"))
    .map((e: any) => ({ market: String(e.market ?? e.position), reason: String(e.reason ?? e.trigger_hit ?? ""), fraction: fracOf(e), ...(trig(e.trigger ?? e.trigger_hit) ? { trigger: trig(e.trigger ?? e.trigger_hit) } : {}) }));
  // Top-level reasoning.
  const pcRaw = j.portfolio_correlation && typeof j.portfolio_correlation === "object" ? j.portfolio_correlation : null;
  const portfolioCorrelation: StrategistPortfolioCorrelation | undefined = pcRaw
    ? { ...(arrStr(pcRaw.both_lose_on_scores) ? { both_lose_on_scores: arrStr(pcRaw.both_lose_on_scores) } : {}), ...(Number.isFinite(pcRaw.both_lose_weight) ? { both_lose_weight: Number(pcRaw.both_lose_weight) } : {}), ...(str(pcRaw.coverage_note) ? { coverage_note: str(pcRaw.coverage_note) } : {}) }
    : undefined;
  const rejMap = (x: unknown) => (Array.isArray(x) ? x.filter((r: any) => r && (r.market || r.reason)).map((r: any) => ({ market: String(r.market ?? ""), reason: String(r.reason ?? "") })) : undefined);
  const shape = ["A", "B", "C", "mixed"].includes(j.match_shape) ? j.match_shape : undefined;
  return {
    picks, exits, note: String(j.note ?? j.notes ?? ""),
    ...(shape ? { matchShape: shape } : {}),
    ...(str(j.current_branch) ? { currentBranch: str(j.current_branch) } : {}),
    ...(portfolioCorrelation && Object.keys(portfolioCorrelation).length ? { portfolioCorrelation } : {}),
    ...(rejMap(j.rejected_markets ?? j.rejected)?.length ? { rejected: rejMap(j.rejected_markets ?? j.rejected) } : {}),
    ...(rejMap(j.flagged)?.length ? { flagged: rejMap(j.flagged) } : {}),
    ...(Array.isArray(j.live_triggers_armed) && j.live_triggers_armed.length ? { liveTriggersArmed: j.live_triggers_armed } : {}),
    ...(j.live_entry_config && typeof j.live_entry_config === "object" && Object.keys(j.live_entry_config).length ? { liveEntryConfig: j.live_entry_config } : {}),
  };
}

export async function strategistDecide(
  input: StrategistInput, model: string, deps: Deps = {},
): Promise<StrategistDecision> {
  const mkList = input.markets.map((m) => {
    // Movement from the kickoff (open) price — the price_move direction/size the
    // strategist reasons on; "" when we have no open snapshot to compare.
    const move = m.openCents != null
      ? (() => { const d = Math.round(m.priceCents - m.openCents!); return ` (старт ${Math.round(m.openCents!)}¢${d === 0 ? ", без движения" : `, ${d > 0 ? "+" : ""}${d}¢`})`; })()
      : "";
    const liq = m.liquidity != null ? `, ликв. $${Math.round(m.liquidity)}` : "";
    const ai = m.aiProb != null ? `, предматч. оценка ${(m.aiProb * 100).toFixed(0)}%` : "";
    // Game-state-adjusted live probability for a MELTING option (тающий опцион) —
    // P(событие наступит за остаток) от score-state + времени, посчитанная КОДОМ
    // (liveProb.ts), НЕ экстраполяция накопленного темпа. Стоит РЯДОМ с ценой, чтобы
    // live-edge мерился против game-state-числа, а не против прикидки от прошлого xG.
    const gsAdj = m.liveProbAdjusted != null
      ? `, game-state P=${(m.liveProbAdjusted.prob * 100).toFixed(0)}% (${m.liveProbAdjusted.note})`
      : "";
    const conflict = m.conflict ? `  ${m.conflict}` : "";
    return `- ${m.label}: ${m.priceCents}¢${move}${liq}${ai}${gsAdj}${conflict}`;
  }).join("\n");
  const posList = input.openPositions.length
    ? input.openPositions.map((p) => `- ${p.market}: вход ${p.entryCents}¢ → сейчас ${p.currentCents}¢`).join("\n")
    : "(открытых позиций нет — можешь только ВХОДИТЬ, не выходить)";
  const scoreKnown = input.match.scoreHome != null;
  const score = scoreKnown ? `${input.match.scoreHome}:${input.match.scoreAway}` : "не подтверждён провайдером";
  // Minute: real provider minute if we have it, else the timer estimate from
  // kickoff (clearly flagged) — so the strategist is never left without a clock.
  const liveMin = input.match.state !== "live" ? ""
    : input.match.minute != null ? `, ${input.match.minute}'`
    : input.match.minuteApprox != null ? `, ≈${input.match.minuteApprox}' (оценка по таймеру)` : "";
  const parsed = await callLLMParsed({
    model,
    system:
      "Ты — трейдер на прогнозных рынках, действующий СТРОГО по методологии из промта стратегии (это твой единственный свод правил). На основе оценки матча, дерева исходов и цен реши ДЕЙСТВИЯ. " +
      "Правила: входи в рынок ТОЛЬКО если методология это разрешает и ты можешь назвать конкретную причину, почему цена неверна; не давай конфликтующих ставок на один матч; уважай стадию (предматч/лайв); выход может быть ЧАСТИЧНЫМ (fraction 0..1: 0.5 = половина, 1 = полностью). " +
      "Для КАЖДОГО входа укажи prob — свою АКТУАЛЬНУЮ вероятность (0..1), что рынок сыграет ДА на ТЕКУЩИЙ момент (счёт/минута/события). НЕ копируй «предматч. оценку» — в лайве она устаревает (при 0:2 «Over 1.5» ≈ 1.0); пересчитай. " +
      "Где у рынка есть «game-state P=…%» — это P(события за остаток) от счёта и времени, посчитанная кодом (отстающий обязан раскрываться, голы кластеризуются в концовке). Для тающего опциона (ставка на наступление события: командный Over 0.5/1.5, BTTS-Yes) считай edge против этого числа, а НЕ против экстраполяции прошлого темпа. " +
      "ВАЖНО ПРО РАЗМЕР: РАЗМЕР СЧИТАЕТ ДВИЖОК по твоему prob и риск-профилю (Kelly, кэпы). Твои size_pct/kelly_fraction/role — справочные, на реальную ставку НЕ влияют; честный prob — единственное, что двигает размер. " +
      "ФОРМАТ ВЫХОДА — строгий JSON. Ключи входов и выходов могут называться как в твоей методологии, все они принимаются как синонимы: " +
      "ВХОДЫ — picks ИЛИ pre_match_positions ИЛИ actions с action:'add'/'open_new'; поля входа: {label|market (ДОСЛОВНО из списка), prob|our_prob, conviction:'низкая'|'средняя'|'высокая'(опц.), reason, и опционально role:'anchor'|'satellite', lives_in_branches:[], branch_weight_sum, phantom_check, total_check, exit:{take_price,thesis_stop,counter_scenario_stop, time_stop:{minute,condition,action:'close_full'|'close_half'} — для тающего опциона минута, после которой не досиживаешь до нуля, если событие не наступило}}. " +
      "В ЛЮБОМ входе, включая actions(add/open_new), поле prob ОБЯЗАТЕЛЬНО — без него движок посчитает размер по УСТАРЕВШЕЙ предматч-оценке. И бери market как ПОЛНЫЙ ярлык из списка ДОСЛОВНО (сторона уже в ярлыке: «… — No», «Over 2.5» и т.п.); НЕ дроби на market+side отдельными полями — иначе рынок не найдётся и вход потеряется. " +
      "ВЫХОДЫ — exits ИЛИ actions с action:'reduce'/'close' ИЛИ exit_checks с сработавшим trigger_hit; поля выхода: {market|position (ДОСЛОВНО, ПОЛНЫЙ ярлык), fraction (или action reduce≈частично/close=1), reason, trigger/trigger_hit (напр. take_price/thesis_stop/counter_scenario/goal_scored)}. Закрытие можно указать в exits, в actions ИЛИ в exit_checks — движок объединит и не закроет дважды. " +
      "Опционально на верхнем уровне: match_shape, current_branch (лайв), portfolio_correlation:{both_lose_on_scores,both_lose_weight,coverage_note}, rejected_markets:[{market,reason}], flagged:[{market,reason}], note/notes. " +
      "Пусто — значит воздержаться. Без текста вне JSON." +
      // Methodology lives in the SYSTEM block (not the user turn) so the stable
      // prefix — rules + this strategy's methodology — is cacheable and read at
      // ~0.1× on every reassess tick of the same match instead of re-billed.
      `\n\nМЕТОДОЛОГИЯ СТРАТЕГИИ «${input.strategyName}» (твой единственный свод правил):\n${input.strategyPrompt}`,
    cacheSystem: true,
    prompt: `МАТЧ: ${input.match.home} — ${input.match.away} (${input.match.sport}, ${input.match.state}${liveMin}, счёт ${score}).\nОценка аналитики: уверенность ${input.assessment.confidence}. ${input.assessment.short} Итог: ${input.assessment.verdict}\n${input.context ? `\nФАКТИЧЕСКИЕ ДАННЫЕ (составы + статистика + события матча — твои триггеры переоценки):\n${input.context}\n` : ""}\nРЫНКИ (цена в ¢, движение от старта = направление price_move, ликвидность = глубина):\n${mkList}\n\nОТКРЫТЫЕ ПОЗИЦИИ:\n${posList}\n${!scoreKnown && input.match.state === "live" ? `\nВАЖНО: провайдер пока не отдаёт счёт/минуту по этому матчу — опирайся на ДВИЖЕНИЕ ЦЕН (price_move от старта) и ликвидность как основной сигнал, оценивай prob по ним. Не отказывайся от решения только из-за отсутствия счёта.` : ""}\nРеши по методологии: во что входить (picks) и что закрывать/фиксировать (exits, можно частично).`,
    // The v3/v2 output schema is RICH (pre_match_positions with tree-reasoning +
    // portfolio_correlation, or live_triggers_armed / live_entry_config). At the
    // old 900 the JSON was truncated mid-object → "невалидный JSON" on EVERY pair
    // → base-model fallback (the identical-bets bug). Give it room.
    maxTokens: 3500,
  },
  // parseJsonLoose already repairs salvageable malformations; a throw here means the
  // reply is UNsalvageable (truncated / prose / refusal) → callLLMParsed re-asks ONCE
  // with a JSON-only nudge before we declare the strategist unavailable. This is the
  // exact "невалидный JSON от стратега" skip that reproduced twice — one re-ask
  // recovers it instead of dropping the whole reassess (and, for tennis, the buyback).
  (text) => normalizeStrategistJson(parseJsonLoose(text)), deps);
  if (!parsed.ok) return { ok: false, picks: [], exits: [], note: "", source: "none", error: parsed.error };
  return { ...parsed.value, ok: true, source: "llm" };
}

export interface ImprovementProposal {
  removed: string; added: string; newPrompt: string; reason: string; source: "llm" | "heuristic";
}

/**
 * Propose a strategy-prompt improvement from its stats (ТЗ §3.5). LLM when a
 * key is present, else a deterministic heuristic. Callers gate on samples ≥ 20
 * and re-extract params from newPrompt in CODE (§9.6).
 */
export interface ImprovementStats { matches: number; clv?: number | null; brier?: number | null }

export async function proposeImprovement(
  strat: { name: string; prompt: string }, stats: ImprovementStats,
  model: string | null, deps: Deps = {},
): Promise<ImprovementProposal> {
  if (model) {
    const parts = [`сыграно ${stats.matches} матчей`];
    if (stats.clv != null) parts.push(`средний CLV ${stats.clv.toFixed(1)}¢ (положительный = входим лучше цены закрытия)`);
    if (stats.brier != null) parts.push(`Brier ${stats.brier.toFixed(3)} (ниже = точнее)`);
    const res = await callLLM({
      model,
      system: "Ты улучшаешь промт стратегии ставок по её статистике. Верни ТОЛЬКО JSON {newPrompt, reason}: минимальная осмысленная правка промта и краткое обоснование.",
      prompt: `Стратегия «${strat.name}». Текущий промт:\n${strat.prompt}\n\nСтатистика: ${parts.join(", ")}. Предложи одно улучшение.`,
      maxTokens: 500,
    }, deps);
    if (res.ok) {
      try {
        const j = parseJsonLoose(res.text);
        if (j.newPrompt) return { removed: "(текущий промт)", added: "(предложение ИИ)", newPrompt: String(j.newPrompt), reason: String(j.reason ?? ""), source: "llm" };
      } catch { /* fall through to heuristic */ }
    }
  }
  return heuristicImprovement(strat, stats);
}

export function heuristicImprovement(
  strat: { name: string; prompt: string }, stats: ImprovementStats,
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

/** Pull the first balanced {...} object out of a model reply — tolerates prose
 *  before/after the JSON (a common failure when a prompt "describes the format"
 *  and the model adds a sentence). Falls back to the fenced text if there's no
 *  object. String-aware so braces inside quoted values don't miscount. */
export function extractJson(s: string): string {
  const t = stripFences(s);
  const start = t.indexOf("{");
  if (start < 0) return t;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { if (--depth === 0) return t.slice(start, i + 1); }
  }
  return t.slice(start); // unbalanced (truncated) — best effort, parse may still throw
}

/**
 * Parse a model reply as JSON, tolerant of the small malformations LLMs routinely
 * emit. Strict `JSON.parse(extractJson(...))` first (the fast, common path); only
 * if that throws do we attempt a REPAIR and re-parse. Repair is never applied to a
 * reply that already parsed, so a valid response is never altered — worst case the
 * repaired text still throws and the caller's existing error path runs.
 * Fixes the reproducing "невалидный JSON от стратега" skips: a reply that reached
 * its closing brace but carried a trailing comma, a bare newline inside a string,
 * or an unbalanced/stray bracket used to be discarded whole; now it's salvaged.
 */
export function parseJsonLoose(raw: string): any {
  const extracted = extractJson(raw);
  try { return JSON.parse(extracted); } catch { /* fall through to repair */ }
  return JSON.parse(repairJson(extracted));
}

/**
 * Best-effort structural repair of almost-valid JSON. A single string-aware pass:
 * escapes bare control chars inside strings (raw \n/\t a model dropped into a
 * "notes" field), drops trailing commas before a closer, discards a stray closing
 * bracket with no opener, auto-closes mismatched nesting, and closes anything left
 * open at EOF (truncation). Deliberately conservative — it only makes malformed
 * input parseable, it doesn't reinterpret values.
 */
export function repairJson(src: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let inStr = false, esc = false;
  // Drop trailing whitespace + an optional dangling comma from `out` (called right
  // before we emit a closer, so `[1,2,]` / `{"a":1,}` become valid).
  const trimTrailingComma = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j >= 0 && out[j] === ",") out.splice(j);
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { out.push(ch); esc = false; continue; }
      if (ch === "\\") { out.push(ch); esc = true; continue; }
      if (ch === '"') { out.push(ch); inStr = false; continue; }
      if (ch === "\n") { out.push("\\n"); continue; }
      if (ch === "\r") { out.push("\\r"); continue; }
      if (ch === "\t") { out.push("\\t"); continue; }
      if (ch === "\b") { out.push("\\b"); continue; }
      if (ch === "\f") { out.push("\\f"); continue; }
      out.push(ch); continue;
    }
    if (ch === '"') { inStr = true; out.push(ch); continue; }
    if (ch === "{" || ch === "[") { stack.push(ch); out.push(ch); continue; }
    if (ch === "}" || ch === "]") {
      const open = ch === "}" ? "{" : "[";
      trimTrailingComma();
      if (stack[stack.length - 1] === open) { stack.pop(); out.push(ch); }
      else if (stack.lastIndexOf(open) >= 0) {
        // close intermediate mismatched nesting until we reach the matching opener
        while (stack.length && stack[stack.length - 1] !== open) { const o = stack.pop()!; out.push(o === "{" ? "}" : "]"); }
        stack.pop(); out.push(ch);
      } // else: stray closer with no opener → drop it
      continue;
    }
    out.push(ch);
  }
  if (inStr) out.push('"');                       // unterminated string at EOF
  while (stack.length) { trimTrailingComma(); const o = stack.pop()!; out.push(o === "{" ? "}" : "]"); }
  return out.join("");
}
