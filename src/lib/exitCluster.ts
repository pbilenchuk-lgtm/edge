// ============================================================
// EDGE LAB — N5-АГРЕГАЦИЯ: ПАРАЛЛЕЛЬНЫЕ ВЫХОДЫ ОДНОГО РЫНКА ИДУТ ОДНИМ ОРДЕРОМ
//
// ИМЕННОЙ КЕЙС: Celtic FC — Dundee FC, 03.08, 41'. Два близнеца одного рынка вышли ОТДЕЛЬНЫМИ заявками
// против ОДНОЙ книги: бид стоял 78¢, а VWAP получились 68.4¢ и 66.1¢ — $16.00 из $16.01 всего слиппеджа
// матча пришлись на эти два выхода. Близнецы съели книгу друг у друга.
//
// Порт теннисного T3-батчинга (tennisTrading.resolveTennisSell): кластер открытых близнецов рынка
// оценивается КАК ОДИН ордер, один раз за тик на токен, и blended-цена с долей филла отдаётся каждому.
// Поздний близнец больше не получает худший фил, чем первый, а размер, который видит книга, наконец
// равен тому, что мы реально пытаемся продать.
//
// ГРАНИЦА ЕДИНИЦЫ — РЫНОК, А НЕ СТРАТЕГИЯ. Теннисная версия ключуется ещё и стратегией, потому что там
// на рынок приходится одна. В футболе на одном рынке стоят близнецы РАЗНЫХ стратегий и профилей, и
// книге всё равно, как мы их назвали: она одна на токен.
//
// ИЗВЕСТНОЕ СВОЙСТВО, НАЗВАННОЕ ЧЕСТНО: кластер — это ВСЕ открытые близнецы, а выйти в этом тике может
// не каждый. Значит модель оценивает размер сверху, а цену выхода снизу. Смещение консервативное и то
// же самое, что уже стоит в теннисе; менять его отдельно от тенниса значило бы завести два разных
// ответа на один вопрос.
//
// ЕДИНСТВЕННЫЙ БЛИЗНЕЦ КЛАСТЕРА НЕ ОБРАЗУЕТ — на одиночной ставке поведение прежнее до последнего знака.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Bet } from "./types.js";
import { normLabel } from "./marketLabel.js";
import { scaleCost, type SellFillResult } from "./executor/paperFill.js";

/** Контекст кластера выходов одного рынка: кэш ордера на тик + суммарный размер открытых близнецов. */
export interface ExitClusterCtx {
  matchId: string; marketLabel: string;
  clusterShares: number; clusterBasisUsd: number;
  cache: Map<string, SellFillResult>;
}

/**
 * [N5-агрегация] Собрать кластер открытых близнецов этого рынка — ВСЕ стратегии и профили, потому что
 * книга на токен одна. Возвращает undefined, когда близнец единственный: тогда агрегировать нечего и
 * поведение остаётся прежним до последнего знака.
 */
export function exitCluster(db: Database, b: Bet, cache: Map<string, SellFillResult>): ExitClusterCtx | undefined {
  const twins = R.betsForMatch(db, b.match_id)
    .filter((x) => x.status === "open" && normLabel(x.market_label) === normLabel(b.market_label));
  if (twins.length < 2) return undefined;
  let shares = 0, basis = 0;
  for (const t of twins) {
    const e = t.entry_price ?? 0, st = t.stake ?? 0;
    if (e > 0) shares += st / (e / 100);
    basis += st;
  }
  return { matchId: b.match_id, marketLabel: b.market_label, clusterShares: shares, clusterBasisUsd: basis, cache };
}

/**
 * Доля ОДНОГО близнеца в кластерном ордере. Цена за акцию и доля филла — общие (в этом и смысл единого
 * ордера), а `cost` обязан быть УРЕЗАН до этой доли: иначе комиссия и слиппедж всего кластера легли бы
 * в реестр филлов на каждого близнеца отдельно, и «честный учёт издержек» превратился бы в их кратное
 * завышение. Тот же класс, что «единица измерения»: строка учёта не равна ордеру.
 */
export function sliceOfCluster(agg: SellFillResult, shares: number): SellFillResult {
  const share = agg.requestedShares > 0 ? Math.min(1, shares / agg.requestedShares) : 1;
  const frac = agg.requestedShares > 0 ? agg.filledShares / agg.requestedShares : 1;
  return {
    ...agg,
    requestedShares: shares, filledShares: shares * frac,
    ...(agg.cost ? { cost: scaleCost(agg.cost, share) } : {}),
  };
}
