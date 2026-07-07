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
  // 120s: the analytics/strategist calls send a long prompt + many markets and
  // Opus can take 40–70s; 30s aborted them mid-flight ("operation was aborted").
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 120_000);
  try {
    const { url, init } = buildRequest(provider, apiId, key, req);
    const res = await doFetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const hint = body.slice(0, 200).replace(/\s+/g, " ");
      return { ok: false, provider, error: `${provider} HTTP ${res.status}${hint ? ` — ${hint}` : ""}` };
    }
    const json = await res.json();
    const text = extractText(provider, json);
    if (text == null) return { ok: false, provider, error: "пустой ответ модели" };
    return { ok: true, text, provider, model: apiId };
  } catch (e) {
    // undici's fetch throws a bare "fetch failed" and hides the real reason on
    // `.cause` (ENOTFOUND / ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT / TLS / an
    // abort on timeout). Surface it so a network failure in production is
    // actually diagnosable instead of an opaque "fetch failed".
    const msg = e instanceof Error ? e.message : String(e);
    const cause = (e as any)?.cause;
    const detail = cause ? ` (${cause.code || cause.message || String(cause)})` : "";
    const aborted = (e as any)?.name === "AbortError" || /abort/i.test(msg);
    return {
      ok: false,
      provider,
      error: aborted ? `модель не ответила за отведённое время (таймаут)` : `${msg}${detail}`,
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
        "Ты извлекаешь числовые пороги стратегии ставок из текста. Верни ТОЛЬКО JSON с любыми из полей: maxPerBet, stop, minEdge, flatSize, kellyFraction, cap, tiers ([[edge%,fraction]...]), minConfidence, takeProfit, exitStop. Доли (maxPerBet, flatSize, cap, stop) — как доли 0..1; stop — доля просадки портфеля 0..1. minEdge — в процентах. takeProfit — доля прибыли позиции для фиксации (0.5 = +50%); exitStop — доля убытка позиции для выхода (0..1). minConfidence — строго одно из: 'низкая'|'средняя'|'высокая'. Без пояснений.",
      prompt,
      maxTokens: 400,
    },
    deps,
  );
  if (!res.ok) throw new Error(res.error);
  return JSON.parse(extractJson(res.text));
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
    const j = JSON.parse(extractJson(res.text));
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
  const res = await callLLM({
    model,
    system:
      "Ты — футбольный аналитик Слоя 1. Следуй методологии из промпта пользователя и верни СТРОГО один JSON-объект по схеме ниже — без markdown-заборов, без текста вокруг. " +
      "Ты оцениваешь ТОЛЬКО ядро (несколько чисел) и сценарии; весь рынок (тоталы/форы/BTTS/исход) посчитает код по Пуассону — сам их НЕ считай. Котировки НЕ используешь. " +
      "СХЕМА: {match_type:'group'|'knockout'|'uncertain', match_type_reason:str, " +
      "core:{xg_home:float, xg_away:float, home_share_1h:float 0..1, away_share_1h:float 0..1, poisson_correction:float (0=чистый Пуассон, >0 повышает ничьи)}, " +
      "overrides:[{target:'напр. totals_match.2.5.over или outcome_90.draw', adjust:float (сдвиг вероятности), reason:str}] (пусто если нет; КАЖДЫЙ с reason), " +
      "drivers:[{factor:str, direction:str, magnitude:'small'|'medium'|'large', confidence:float 0..1}], " +
      "scenarios:[{trigger:str, prob:float 0..1, shifts:{outcome_90:{home,draw,away}, xg_remaining_home:float, xg_remaining_away:float, note:str}}] (МИНИМУМ 5 узлов), " +
      "calibration:{xg_confidence:float 0..1, scenario_confidence:float 0..1, sample_size:int, notes:str}, unknowns:[str]}. " +
      "Блок derived НЕ заполняй — его считает код.",
    prompt: `${input.analyticsPrompt}\n\n## ВХОДНЫЕ ДАННЫЕ\nМатч: ${input.home} — ${input.away} (состояние: ${input.state}).\nДоступные рынки (ТОЛЬКО чтобы определить match_type — это НЕ котировки, цен тут нет):\n${input.marketLabels.map((l) => `- ${l}`).join("\n")}\n${input.context ? `\nФАКТИЧЕСКИЕ ДАННЫЕ (составы/статистика/события):\n${input.context}\n` : ""}\nВерни ТОЛЬКО JSON по схеме.`,
    maxTokens: 6000,
  }, deps);
  if (!res.ok) return failedFootball(res.error);
  try {
    const j = JSON.parse(extractJson(res.text));
    const c = j.core ?? {};
    if (!Number.isFinite(c.xg_home) || !Number.isFinite(c.xg_away)) return failedFootball("нет xg_home/xg_away в core");
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
  } catch {
    return failedFootball("невалидный JSON от модели");
  }
}
function failedFootball(error?: string): FootballAnalysis {
  return { ok: false, matchType: "uncertain", matchTypeReason: "", core: { xg_home: 0, xg_away: 0, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0, scenario_confidence: 0, sample_size: 0, notes: "" }, unknowns: [], error };
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
  markets: { label: string; priceCents: number; aiProb: number | null; liquidity?: number | null; openCents?: number | null }[];
  openPositions: { market: string; entryCents: number; currentCents: number }[];
  context?: string; // real lineups + in-match events (ESPN) — the reassessment triggers
}
export interface StrategistPick { label: string; conviction: "низкая" | "средняя" | "высокая"; reason: string; prob?: number }
export interface StrategistExit { market: string; reason: string; fraction: number } // fraction 0..1 of the position to close
export interface StrategistDecision { ok: boolean; picks: StrategistPick[]; exits: StrategistExit[]; note: string; source: "llm" | "none"; error?: string }

/**
 * Apply the strategy's methodology (its prompt) to a match: which markets to
 * ENTER (with conviction + a nameable reason) and which OPEN positions to EXIT.
 * The model must follow the prompt literally — entry discipline, "name why the
 * market is wrong", no conflicting bets, in-match management. Returns picks;
 * the engine sizes and gates them (budget/caps/stop) in code.
 */
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
    return `- ${m.label}: ${m.priceCents}¢${move}${liq}${ai}`;
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
  const res = await callLLM({
    model,
    system:
      "Ты — трейдер на прогнозных рынках, действующий СТРОГО по методологии из промта стратегии (это твой единственный свод правил). На основе оценки матча и цен реши ДЕЙСТВИЯ. Правила вывода: входи в рынок ТОЛЬКО если методология это разрешает и ты можешь назвать конкретную причину, почему цена неверна; не давай конфликтующих ставок на один матч; уважай стадию матча (предматч/лайв) и правила управления позицией; выход может быть ЧАСТИЧНЫМ (fraction — доля позиции 0..1, напр. 0.5 = зафиксировать половину на пике, 1 = закрыть полностью). Для КАЖДОГО пика укажи prob — свою АКТУАЛЬНУЮ вероятность (0..1), что этот рынок сыграет ДА, на ТЕКУЩИЙ момент матча (счёт/минута/события). НЕ копируй «предматч. оценку» — в лайве она устаревает (напр. при 0:2 «Over 1.5» уже ~1.0); пересчитай сам. Именно по твоему prob движок считает край и размер, поэтому оцени честно. Верни ТОЛЬКО JSON {picks:[{label, conviction:'низкая'|'средняя'|'высокая', reason, prob}], exits:[{market, fraction, reason}], note}. label/market бери ДОСЛОВНО из списков. Пусто — значит воздержаться. Без пояснений вне JSON.",
    prompt: `СТРАТЕГИЯ «${input.strategyName}» (методология):\n${input.strategyPrompt}\n\nМАТЧ: ${input.match.home} — ${input.match.away} (${input.match.sport}, ${input.match.state}${liveMin}, счёт ${score}).\nОценка аналитики: уверенность ${input.assessment.confidence}. ${input.assessment.short} Итог: ${input.assessment.verdict}\n${input.context ? `\nФАКТИЧЕСКИЕ ДАННЫЕ (составы + статистика + события матча — твои триггеры переоценки):\n${input.context}\n` : ""}\nРЫНКИ (цена в ¢, движение от старта = направление price_move, ликвидность = глубина):\n${mkList}\n\nОТКРЫТЫЕ ПОЗИЦИИ:\n${posList}\n${!scoreKnown && input.match.state === "live" ? `\nВАЖНО: провайдер пока не отдаёт счёт/минуту по этому матчу — опирайся на ДВИЖЕНИЕ ЦЕН (price_move от старта) и ликвидность как основной сигнал, оценивай prob по ним. Не отказывайся от решения только из-за отсутствия счёта.` : ""}\nРеши по методологии: во что входить (picks) и что закрывать/фиксировать (exits, можно частично).`,
    maxTokens: 900,
  }, deps);
  if (!res.ok) return { ok: false, picks: [], exits: [], note: "", source: "none", error: res.error };
  try {
    const j = JSON.parse(extractJson(res.text));
    const conv = (c: unknown) => (["низкая", "средняя", "высокая"].includes(c as string) ? c : "средняя") as StrategistPick["conviction"];
    const picks: StrategistPick[] = Array.isArray(j.picks)
      ? j.picks.filter((p: any) => p && typeof p.label === "string").map((p: any) => ({ label: String(p.label), conviction: conv(p.conviction), reason: String(p.reason ?? ""), ...(Number.isFinite(p.prob) ? { prob: clamp01(p.prob) } : {}) }))
      : [];
    const frac = (f: unknown) => (typeof f === "number" && f > 0 && f <= 1 ? f : 1);
    const exits: StrategistExit[] = Array.isArray(j.exits)
      ? j.exits.filter((e: any) => e && typeof e.market === "string").map((e: any) => ({ market: String(e.market), reason: String(e.reason ?? ""), fraction: frac(e.fraction) }))
      : [];
    return { ok: true, picks, exits, note: String(j.note ?? ""), source: "llm" };
  } catch {
    return { ok: false, picks: [], exits: [], note: "", source: "none", error: "невалидный JSON от стратега" };
  }
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
        const j = JSON.parse(extractJson(res.text));
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
