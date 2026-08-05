// ============================================================
// EDGE LAB — N5: ТЕЙК-СТОРОНА ТОЙ ЖЕ МАШИНЕРИЕЙ, ЧТО И ЗАЩИТНАЯ
//
// `stopCounterfactual` спрашивал: не режем ли мы на шуме вместо смерти тезиса. Симметричный вопрос про
// ДРУГУЮ сторону лесенки не задавался ни разу: не фиксируем ли мы прибыль слишком рано на тающем
// опционе, чей тезис ЖИВ.
//
// ИМЕННОЙ КЕЙС: Celtic FC — Dundee FC, 03.08. Контракт `Under 3.5` СЫГРАЛ. Двенадцать кусков, $250
// вложено: фактический payout $392.31 (P&L +$142.31), удержание до сеттла дало бы $498.01 (+$248.01).
// Недобор ранних и частичных фиксаций — $105.70, то есть 42.3% от вложенного, в ОДНОМ матче и
// однонаправленно. Выходы шли по 65.9-88.9¢ на контракте, который стоил 100¢.
//
// МЕТОД — БЕЗ HINDSIGHT-ОТБОРА. Считаются ВСЕ тейк-куски решённых ставок, а не только те, где рынок
// потом выиграл: на проигравшем рынке ранний тейк ДЕНЬГИ СПАС, и его выгода обязана входить в ту же
// сумму со своим знаком. Иначе это была бы не оценка правила, а коллекция сожалений.
//   недобор куска = (что дало бы удержание до сеттла) − (что кусок дал фактически)
//   удержание: выигравший контракт стоит 100¢ ⇒ stake/entry × 100; проигравший ⇒ 0.
//
// КРИТЕРИЙ ЗАФИКСИРОВАН ДО ДАННЫХ (F4, стоит с батча-2): n ≥ 30 тейк-кусков И суммарный недобор ≥ 15%
// оборота когорты → лесенка приостанавливается на тезис-живом растущем опционе; частичники остаются
// только по тезис-событиям. Ниже порога — дизайн не трогаем.
//
// ЧТО ЭТО НЕ ДЕЛАЕТ. Не трогает защитные срезы (их судит stopCounterfactual) и ничего не меняет в
// торговом пути: read-only замер, следствие деплоится отдельно и по вердикту.
// ============================================================

import type { Database } from "./db.js";
import { betRecords, type BetRec, type ProfileFilter } from "./profileAnalytics.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Тейк-сторона: фиксация ПРИБЫЛИ. Имена берутся из производственного `classifyExitTrigger`, а не
 *  выдумываются — свой список был бы вторым авторитетом и молча не совпал бы ни с одной строкой.
 *  `time_stop` НЕ включён: он срабатывает по часам, а не по цене, и его уже судит защитная машинерия.
 *  `capitulation` тоже нет: тейк-по-словам, закрывшийся в убыток, там уже переклассифицирован. */
const TAKE_TRIGGERS = new Set<string>(["take_price", "edge_closed"]);

export const TAKE_CF_MIN_N = 30;          // кусков — порог зрелости
export const TAKE_CF_SHORTFALL_PCT = 15;  // % оборота когорты (критерий F4)

export interface TakeCfRow {
  matchId: string; matchLabel: string; strategyId: string; profileId: string; market: string;
  trigger: string; partial: boolean; exitCents: number | null; entryCents: number | null;
  stakeUsd: number; actualUsd: number; holdUsd: number; shortfallUsd: number;
  marketOutcome: "won" | "lost";
}
export interface TakeCfGroup { key: string; n: number; stakeUsd: number; shortfallUsd: number; shortfallPct: number | null }
export interface TakeCounterfactual {
  criterion: { needN: number; shortfallPct: number };
  n: number; stakeUsd: number; actualUsd: number; holdUsd: number;
  shortfallUsd: number; shortfallPct: number | null;
  byStrategy: TakeCfGroup[]; byTrigger: TakeCfGroup[]; byOutcome: TakeCfGroup[];
  verdict: "insufficient" | "ladder_costly" | "ladder_justified";
  rows: TakeCfRow[];
  note: string;
}

function group(rows: TakeCfRow[], key: (r: TakeCfRow) => string): TakeCfGroup[] {
  const by = new Map<string, TakeCfRow[]>();
  for (const r of rows) (by.get(key(r)) ?? by.set(key(r), []).get(key(r))!).push(r);
  return [...by.entries()].map(([k, rs]) => {
    const stake = rs.reduce((a, x) => a + x.stakeUsd, 0);
    const sf = rs.reduce((a, x) => a + x.shortfallUsd, 0);
    return { key: k, n: rs.length, stakeUsd: r2(stake), shortfallUsd: r2(sf), shortfallPct: stake > 0 ? r2((sf / stake) * 100) : null };
  }).sort((a, b) => b.shortfallUsd - a.shortfallUsd);
}

export function buildTakeCounterfactual(db: Database, filter: ProfileFilter = {}): TakeCounterfactual {
  const recs: BetRec[] = betRecords(db, filter);
  const rows: TakeCfRow[] = [];
  for (const b of recs) {
    if (b.outcome !== "won" && b.outcome !== "lost") continue;   // открытые и возвраты не судят правило
    const entry = b.entryCents;
    if (entry == null || !(entry > 0)) continue;
    for (const e of b.exits) {
      if (!TAKE_TRIGGERS.has(e.trigger)) continue;
      // Доля куска в деньгах: сколько эта нога стоила на входе. Берём из её же P&L и цены выхода, чтобы
      // не выдумывать размер: actual = stake + pnl, а stake восстанавливается из цены выхода и P&L.
      const exitC = e.priceCents;
      if (exitC == null || !(exitC > 0)) continue;
      // stake куска: P&L = stake × (exit − entry)/entry ⇒ stake = P&L × entry / (exit − entry).
      const diff = exitC - entry;
      if (Math.abs(diff) < 0.01) continue;                        // выход по цене входа — куску нечего мерить
      const stake = r2((e.pnl * entry) / diff);
      if (!(stake > 0)) continue;                                 // отрицательный/нулевой размер — строка не читается
      const actual = r2(stake + e.pnl);
      const hold = b.outcome === "won" ? r2((stake / entry) * 100) : 0;   // выигравший контракт = 100¢, проигравший = 0
      rows.push({
        matchId: b.matchId, matchLabel: b.matchLabel, strategyId: b.strategyId, profileId: b.profileId,
        market: b.market, trigger: e.trigger, partial: e.partial, exitCents: exitC, entryCents: entry,
        stakeUsd: stake, actualUsd: actual, holdUsd: hold, shortfallUsd: r2(hold - actual),
        marketOutcome: b.outcome,
      });
    }
  }
  const stakeUsd = r2(rows.reduce((a, x) => a + x.stakeUsd, 0));
  const actualUsd = r2(rows.reduce((a, x) => a + x.actualUsd, 0));
  const holdUsd = r2(rows.reduce((a, x) => a + x.holdUsd, 0));
  const shortfallUsd = r2(holdUsd - actualUsd);
  const shortfallPct = stakeUsd > 0 ? r2((shortfallUsd / stakeUsd) * 100) : null;
  const matured = rows.length >= TAKE_CF_MIN_N;
  const costly = matured && shortfallPct != null && shortfallPct >= TAKE_CF_SHORTFALL_PCT;
  const verdict: TakeCounterfactual["verdict"] = !matured ? "insufficient" : costly ? "ladder_costly" : "ladder_justified";
  return {
    criterion: { needN: TAKE_CF_MIN_N, shortfallPct: TAKE_CF_SHORTFALL_PCT },
    n: rows.length, stakeUsd, actualUsd, holdUsd, shortfallUsd, shortfallPct,
    byStrategy: group(rows, (r) => r.strategyId),
    byTrigger: group(rows, (r) => `${r.trigger}${r.partial ? "·частичный" : ""}`),
    byOutcome: group(rows, (r) => (r.marketOutcome === "won" ? "рынок выиграл" : "рынок проиграл")),
    verdict,
    rows: rows.sort((a, b) => b.shortfallUsd - a.shortfallUsd).slice(0, 60),
    note: !matured
      ? `копим: ${rows.length}/${TAKE_CF_MIN_N} тейк-кусков. Критерий зафиксирован ДО данных (F4): недобор ≥${TAKE_CF_SHORTFALL_PCT}% оборота → лесенка приостанавливается на тезис-живом растущем опционе. Проигравшие рынки входят со своим знаком — там ранний тейк деньги СПАС, и это часть той же суммы`
      : costly
        ? `ЛЕСЕНКА ДОРОГА: недобор $${shortfallUsd} = ${shortfallPct}% оборота $${stakeUsd} на ${rows.length} кусках ≥ порога ${TAKE_CF_SHORTFALL_PCT}%. Ратифицированное следствие: частичники только по тезис-событиям, лесенка приостановлена при живом тезисе на растущем опционе`
        : `лесенка оправдана: недобор $${shortfallUsd} = ${shortfallPct}% оборота $${stakeUsd} на ${rows.length} кусках < порога ${TAKE_CF_SHORTFALL_PCT}% — ранние фиксации в сумме окупаются спасённым на проигравших рынках`,
  };
}

/** Строка для еженедельника. Недобор всегда с оборотом-знаменателем: доллар без базы ничего не говорит. */
export function takeCfLine(r: TakeCounterfactual): string {
  return `take_cf: ${r.n}/${r.criterion.needN} кусков`
    + (r.shortfallPct != null ? ` · недобор $${r.shortfallUsd} = ${r.shortfallPct}% оборота` : "")
    + ` · ${r.verdict}`;
}
