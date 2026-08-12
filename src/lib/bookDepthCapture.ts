// ============================================================
// EDGE LAB — ORDER-BOOK DEPTH CAPTURE  [SERVER-ONLY]
//
// Part 2 of capacity: the MODEL curve extrapolates a linear slippage coefficient; a MEASURED curve needs
// the real book. We don't store book levels historically, so this starts capturing them from deploy —
// every day without it is a day of measured capacity we can never get back. Periodic snapshots on live
// in-scope matches (bounded + throttled) catch depth even in SKIP moments — «сколько мы НЕ смогли бы
// налить» IS the capacity. Persists the top-N bid/ask levels so a later report can re-VWAP any size.
//
// Bounded (≤ MAX_TOKENS per run), throttled (every CAPTURE_MIN min), pruned (RETENTION_DAYS), and it
// NEVER throws into the tick — a book fetch failure just skips that token.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { loadPolymarketConfig, type OrderBookFetch } from "./polymarket.js";
import { classifyOrderBook } from "./executor/paperFill.js";
import { bookDepthUsd } from "./execution.js";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const CAPTURE_MIN = (env: Record<string, string | undefined>) => num(env.BOOK_CAPTURE_MIN, 3);          // throttle
const MAX_TOKENS = (env: Record<string, string | undefined>) => num(env.BOOK_CAPTURE_MAX_TOKENS, 24);   // API budget/run
const MARKETS_PER_MATCH = 4, LEVELS = 12, RETENTION_DAYS = 14;
const LAST_KEY = "book_depth_last_ms";

export interface BookTarget { matchId: string; token: string; label: string }

/** Pure: which (match, token) books to snapshot — live matches, top markets by declared liquidity,
 *  bounded. Testable without the network. */
export function bookDepthTargets(db: Database, maxTokens: number, marketsPerMatch = MARKETS_PER_MATCH): BookTarget[] {
  const out: BookTarget[] = [];
  const live = R.listCompetitions(db).flatMap((c) => R.listMatches(db, c.id).filter((m) => m.state === "live"));
  for (const m of live) {
    const mkts = R.latestMarkets(db, m.id)
      .filter((k) => k.external_ref)
      .sort((a, b) => Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0))
      .slice(0, marketsPerMatch);
    for (const k of mkts) { out.push({ matchId: m.id, token: k.external_ref as string, label: k.label }); if (out.length >= maxTokens) return out; }
  }
  return out;
}

/** Persist one book's top-N levels + depth. Exposed so the on-fill path can reuse it (source='fill'). */
export function saveBookDepth(db: Database, t: BookTarget, book: { bids: { priceCents: number; size: number }[]; asks: { priceCents: number; size: number }[] }, source: string, nowIso: string): void {
  const asks = book.asks.slice(0, LEVELS), bids = book.bids.slice(0, LEVELS);
  db.prepare(
    `INSERT INTO book_depth_snapshots (id, match_id, token_id, label, source, best_bid_cents, best_ask_cents, bid_depth_usd, ask_depth_usd, bids_json, asks_json, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(R.uid(), t.matchId, t.token, t.label, source,
    bids[0]?.priceCents ?? null, asks[0]?.priceCents ?? null,
    Math.round(bookDepthUsd(book.bids)), Math.round(bookDepthUsd(book.asks)),
    JSON.stringify(bids.map((l) => [l.priceCents, l.size])), JSON.stringify(asks.map((l) => [l.priceCents, l.size])), nowIso);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// ЗАХВАТ КНИГИ НА ФИЛЛЕ — НЕСМЕЩЁННАЯ ВЫБОРКА В МОМЕНТ РЕАЛЬНОГО РЕШЕНИЯ
//
// Периодический захват выше берёт ЖИВЫЕ матчи по объявленной ликвидности каждые N минут. Для вопроса
// «какая книга бывает» этого хватает; для вопроса «какая книга была В МОМЕНТ, КОГДА МЫ ВХОДИЛИ» — нет,
// и смещение здесь не случайное: вход Overreaction происходит в момент паники, то есть ровно там, где
// стакан не такой, как в среднем по матчу. Мерить ёмкость входа по средней книге матча значит отвечать
// на соседний вопрос.
//
// Стоимость нулевая: книга на этом пути УЖЕ запрошена и лежит в кеше цикла — мы её только сохраняем.
// Дедуп по (источник × токен) в пределах цикла: близнецы двух профилей делят одну книгу, и записать её
// дважды значило бы удвоить вес одного факта.
//
// ГРАНИЦА ЧЕСТНОСТИ ТА ЖЕ, ЧТО У ПЕРИОДИЧЕСКОГО: пустая книга — ФАКТ ёмкости («налить было нечем»),
// пишется нулём; НЕДОСТУПНАЯ — наша слепота, не свойство рынка, и не пишется вовсе.
// ────────────────────────────────────────────────────────────────────────────────────────────────

export interface FillCaptureCtx { db: Database; nowIso: string; seen: Set<string> }

/** Контекст захвата на один цикл — живёт ровно столько же, сколько кеш книг рядом с ним. */
export function makeFillCapture(db: Database, nowIso: string): FillCaptureCtx {
  return { db, nowIso, seen: new Set() };
}

export function captureFillBook(
  ctx: FillCaptureCtx | undefined,
  t: { matchId: string; token: string | null; label: string },
  bookRes: { status: string; book?: { bids: { priceCents: number; size: number }[]; asks: { priceCents: number; size: number }[] } },
  source: string,
): void {
  if (!ctx || !t.token) return;
  const key = `${source}|${t.token}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  // Измерение не имеет права уронить путь решения — но и молчать о себе оно здесь не обязано:
  // объём выборки виден отдельным отчётом, а не по этой строке.
  try {
    if (bookRes.status === "ok" && bookRes.book) saveBookDepth(ctx.db, { matchId: t.matchId, token: t.token, label: t.label }, bookRes.book, source, ctx.nowIso);
    else if (bookRes.status === "empty") saveBookDepth(ctx.db, { matchId: t.matchId, token: t.token, label: t.label }, { bids: [], asks: [] }, `${source}_empty`, ctx.nowIso);
  } catch { /* захват улики никогда не ломает сделку */ }
}

export async function captureBookDepth(db: Database, deps: EngineDeps = {}, nowMs = Date.now()): Promise<number> {
  const env = deps.env ?? process.env;
  const poly = deps.polymarket ?? loadPolymarketConfig(env);
  if (!poly.enabled) return 0;                                  // no live book source → nothing to capture
  const last = Number(R.metaGet(db, LAST_KEY) ?? 0);
  if (nowMs - last < CAPTURE_MIN(env) * 60_000) return 0;       // throttle
  R.metaSet(db, LAST_KEY, String(nowMs), new Date(nowMs).toISOString());

  const targets = bookDepthTargets(db, MAX_TOKENS(env));
  const bookCache = new Map<string, OrderBookFetch>();
  const nowIso = new Date(nowMs).toISOString();
  let ok = 0, empty = 0, unavail = 0;
  for (const t of targets) {
    try {
      const res = await classifyOrderBook(t.token, poly, deps, bookCache);
      if (res.status === "ok") { saveBookDepth(db, t, res.book, "periodic", nowIso); ok++; }
      // An EMPTY book (offers absent) is a capacity FACT — «couldn't fill here» — recorded as zero depth.
      // An UNAVAILABLE book is a fetch failure, NOT a liquidity fact — skip it (never poison depth with it).
      else if (res.status === "empty") { saveBookDepth(db, t, { bids: [], asks: [] }, "periodic_empty", nowIso); empty++; }
      else unavail++;
    } catch { unavail++; } // a book fetch must never break the tick
  }
  // Self-diagnosing tally: ok vs empty (dust) vs unavailable (fetch broken) — so a zero isn't mute.
  try { R.metaSet(db, "book_depth_tally", JSON.stringify({ targets: targets.length, ok, empty, unavail, at: nowIso }), nowIso); } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM book_depth_snapshots WHERE at < ?`).run(new Date(nowMs - RETENTION_DAYS * 86400_000).toISOString()); } catch { /* ignore */ }
  return ok + empty;
}


// ════════════════════════════════════════════════════════════════════════════════════════════════
// ИНВАРИАНТ КЛАССА: WOULD-BE ЗАПИСЬ ОБЯЗАНА НЕСТИ СНИМОК ИСПОЛНИМОСТИ В МОМЕНТ ЗАПИСИ
//
// 31.07. Фильтр исполнимости на refusal_shadow дал 2 из 143 (1.4%), и 140 из 143 оказались НЕ
// «неисполнимы», а «без снимка». Причина структурная, и она не про объём: снимков было 25 418 за
// пять дней. Просто когорта пишется в ТОЧКЕ A (предматчевый анализ), а глубина снималась в ТОЧКЕ B
// (живой цикл) — пересечение почти пусто. Вердикт screw_too_tight с p=0 рассыпался от одного вопроса
// «а существовали ли эти цены».
//
// Дыра этого КЛАССА не уникальна для refusal_shadow: family_shadow пишется из того же предматчевого
// анализа и болел бы тем же — его зрелость встретила бы нас тем же сюрпризом. (stale_proposal чист:
// он рождается на филле, где книга уже запрошена.)
//
// Отсюда правило, а не заплатка: КОГОРТА, РОЖДЁННАЯ БЕЗ СНИМКА ИСПОЛНИМОСТИ, РОЖДАЕТСЯ НЕВЕРДИКТНОЙ.
// Точка записи обязана звать этот захват сама — тем же замороженным стандартом полей, что читают
// unfillable_edge и refusal_shadow. Один стандарт исполнимости на все когорты, без диалектов.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Сколько книг максимум тянуть за одну would-be запись — бюджет API, не «сколько влезет». */
const SHADOW_MAX_TOKENS = (env: Record<string, string | undefined>) => num(env.SHADOW_DEPTH_MAX_TOKENS, 8);

/**
 * Снять глубину ПО РЫНКАМ С ЗАЯВЛЕННЫМ КРАЕМ в момент записи would-be сигнала. Возвращает число
 * сохранённых снимков. Никогда не бросает: измерение не имеет права ломать путь решения — но и
 * молчать о своём отказе не имеет права, поэтому счётчик отдаётся наружу.
 */
export interface ShadowDepthTally {
  saved: number; empty: number; unavailable: number; threw: number; skippedOverBudget: number;
  reason: string | null;   // почему НИ ОДНОГО снимка, если saved === 0
}

export async function captureShadowDepth(
  db: Database, targets: BookTarget[], source: string, deps: EngineDeps = {}, nowIso?: string,
): Promise<ShadowDepthTally> {
  const t0: ShadowDepthTally = { saved: 0, empty: 0, unavailable: 0, threw: 0, skippedOverBudget: 0, reason: null };
  const env = deps.env ?? process.env;
  const poly = deps.polymarket ?? loadPolymarketConfig(env);
  // НОЛЬ ОБЯЗАН НАЗЫВАТЬ ПРИЧИНУ. Первая версия возвращала голое число, и прод в тот же вечер написал
  // «глубина снята по 0» — ровно тот немой ноль, против которого написан весь этот файл. Три разные
  // причины нуля (выключён Polymarket, нет целей, книги недоступны) чинятся по-разному.
  if (!poly.enabled) { t0.reason = "polymarket выключен"; return t0; }
  if (!targets.length) { t0.reason = "нет целей с токеном — у рынков нет external_ref"; return t0; }
  const at = nowIso ?? (deps.now?.() ?? new Date().toISOString());
  const cache = new Map<string, OrderBookFetch>();
  const budget = SHADOW_MAX_TOKENS(env);
  t0.skippedOverBudget = Math.max(0, targets.length - budget);
  for (const t of targets.slice(0, budget)) {
    try {
      const res = await classifyOrderBook(t.token, poly, deps, cache);
      // Пустая книга — ФАКТ ёмкости («налить было нечем»), а не сбой: пишем её нулём.
      // Недоступная — сбой запроса, и притворяться, что там нет ликвидности, нельзя: пропускаем.
      if (res.status === "ok") { saveBookDepth(db, t, res.book, source, at); t0.saved++; }
      else if (res.status === "empty") { saveBookDepth(db, t, { bids: [], asks: [] }, `${source}_empty`, at); t0.saved++; t0.empty++; }
      else t0.unavailable++;
    } catch { t0.threw++; } // одна книга не имеет права уронить запись когорты
  }
  if (t0.saved === 0) {
    t0.reason = t0.unavailable || t0.threw
      ? `книга недоступна: ${t0.unavailable} unavailable, ${t0.threw} исключений из ${Math.min(targets.length, budget)} запросов`
      : "ни одного запроса не выполнено";
  }
  try { R.metaSet(db, `shadow_depth_tally_${source}`, JSON.stringify({ ...t0, targets: targets.length, at }), at); } catch { /* ignore */ }
  return t0;
}
