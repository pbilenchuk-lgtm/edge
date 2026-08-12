// ============================================================
// EDGE LAB — T7: ЧТО СТОИТ СЛЕПОТА СКАУТА. ЗАМЕР, А НЕ ОБВИНЕНИЕ.
//
// ПОВОД. В хвосте висело «12 проигрышей `no_score_data_skip`» — число, взятое из чтения логов. Прежде чем
// что-либо чинить, его надо ПЕРЕСОБРАТЬ из базы и назвать честно, потому что в самой формулировке уже
// спрятаны две ошибки атрибуции, и обе стоит назвать вслух:
//
//   1. `no_score_data_skip` НИЧЕГО НЕ ОТКРЫВАЕТ И НИЧЕГО НЕ ЗАКРЫВАЕТ. Это fail-closed отказ Set-Value
//      армить триггер. Позиция, проигравшая на таком матче, открыта ДРУГИМ путём (overreaction, pmv,
//      футбольный конвейер — у каждого свой вход). Сказать «12 проигрышей no_score_data_skip» значит
//      приписать убыток сторожу, который в этой сделке не участвовал. Поэтому здесь всё режется ПО
//      СТРАТЕГИИ-ОТКРЫВАТЕЛЮ, и строка отказа считается ПРИЗНАКОМ МАТЧА, а не автором ставки.
//
//   2. Слепота — не случайная величина. Матчи, которых нет в фиде, — это преимущественно мелкие ITF, где
//      и книга тоньше, и цена хуже. Разница между когортами поэтому НЕ является эффектом слепоты: это
//      наблюдательное сравнение, и оно названо таковым в вердикте. Инструмент даёт число, а не причину.
//
// ЧТО ИМЕННО МЕРЯЕТСЯ. Матч попадает в когорту «слепой», если по нему есть хоть одна строка отказа
// `no_score_data_skip` (любой причины). Контроль — остальные теннисные матчи с расчётными ставками. По
// каждой когорте: сколько ставок, сколько выиграно/проиграно/void, оборот, выплата, P&L и доля побед.
// Плюс разрез по ПРИЧИНЕ слепоты, потому что «НЕ В ФИДЕ» и «НЕ СВЯЗАН» чинятся разными руками.
//
// Модуль ТОЛЬКО читает.
// ============================================================

import type { Database } from "./db.js";

/** Меньше этого в ЛЮБОЙ когорте — сравнение не выносится. Порог назван до первого прогона. */
export const COHORT_MIN_BETS = 20;

export interface SkipCohortStats {
  matches: number; bets: number; won: number; lost: number; voided: number;
  stakeUsd: number; payoutUsd: number; pnlUsd: number;
  winRate: number | null; roiPct: number | null;
}
export interface SkipStrategyRow extends SkipCohortStats { strategyId: string }
/** `matches` — все матчи с этой причиной; `matchesWithBets` — те из них, где мы торговали. Два разных
 *  знаменателя, и слитые в один они дали бы ту самую «единицу измерения», на которой мы уже обжигались. */
export interface SkipReasonRow { reason: string; matches: number; matchesWithBets: number; pnlUsd: number }

export interface NoScoreSkipCost {
  at: string;
  /** Матчи, по которым вообще есть строка отказа — включая те, где ставок не было ни одной. */
  skipMatchesTotal: number;
  skipMatchesWithBets: number;
  blind: SkipCohortStats;
  control: SkipCohortStats;
  byStrategy: { blind: SkipStrategyRow[]; control: SkipStrategyRow[] };
  byReason: SkipReasonRow[];
  verdict: "insufficient" | "measured";
  criterion: string;
  note: string;
}

interface BetRow { match_id: string; strategy_id: string; status: string; result: string | null; stake: number | null; payout: number | null }

const REASON_RE = /no_score_data_skip\[([^\]]+)\]/;
/** Имя причины из строки. Старые строки писались без скобок («(15м > 15м)») — они получают ЯВНОЕ имя
 *  «до именования причин», а не сваливаются в общую кучу: это разные эпохи диагностики, не один класс. */
export function skipReasonOf(text: string): string {
  const m = REASON_RE.exec(text);
  return m ? m[1] : "(до именования причин)";
}

function emptyStats(): SkipCohortStats {
  return { matches: 0, bets: 0, won: 0, lost: 0, voided: 0, stakeUsd: 0, payoutUsd: 0, pnlUsd: 0, winRate: null, roiPct: null };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

function finish(s: SkipCohortStats, matchIds: Set<string>): SkipCohortStats {
  const decided = s.won + s.lost;
  return {
    ...s, matches: matchIds.size,
    stakeUsd: r2(s.stakeUsd), payoutUsd: r2(s.payoutUsd), pnlUsd: r2(s.payoutUsd - s.stakeUsd),
    // Доля побед считается от РЕШЁННЫХ: void не проигрыш и не победа, и в знаменателе ему не место.
    winRate: decided ? Math.round((s.won / decided) * 1000) / 10 : null,
    roiPct: s.stakeUsd > 0 ? Math.round(((s.payoutUsd - s.stakeUsd) / s.stakeUsd) * 1000) / 10 : null,
  };
}

export function buildNoScoreSkipCost(db: Database, nowIso: string): NoScoreSkipCost {
  const q = <T,>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args as never[]) as T[]; } catch { return []; } };

  // (1) Строки отказа. `type='skip'` не фильтруем жёстко: строка может приехать другим типом, а имя
  // маркера уникально — искать по имени надёжнее, чем по типу, который однажды поменяют.
  const skipRows = q<{ match_id: string; text: string }>(
    `SELECT match_id, text FROM trade_log WHERE text LIKE '%no_score_data_skip%'`,
  );
  const skipMatches = new Set<string>();
  const reasonMatches = new Map<string, Set<string>>();
  for (const r of skipRows) {
    skipMatches.add(r.match_id);
    const reason = skipReasonOf(r.text);
    if (!reasonMatches.has(reason)) reasonMatches.set(reason, new Set());
    (reasonMatches.get(reason) as Set<string>).add(r.match_id);
  }

  // (2) Расчётные теннисные ставки. `settled_void` в когорте ОСТАЁТСЯ (это оборот и это риск), но в
  // доле побед не участвует — см. finish().
  const bets = q<BetRow>(
    `SELECT b.match_id, b.strategy_id, b.status, b.result, b.stake, b.payout
       FROM bets b
       JOIN matches m ON m.id = b.match_id
       JOIN competitions c ON c.id = m.competition_id
      WHERE c.sport_id = 'tennis' AND b.status LIKE 'settled%'`,
  );

  const blind = emptyStats(), control = emptyStats();
  const blindMatches = new Set<string>(), controlMatches = new Set<string>();
  const perStrategy = new Map<string, { blind: SkipCohortStats; control: SkipCohortStats; bm: Set<string>; cm: Set<string> }>();
  const pnlByMatch = new Map<string, number>();

  for (const b of bets) {
    const isBlind = skipMatches.has(b.match_id);
    const acc = isBlind ? blind : control;
    (isBlind ? blindMatches : controlMatches).add(b.match_id);
    const stake = Number(b.stake ?? 0) || 0, payout = Number(b.payout ?? 0) || 0;
    const bump = (s: SkipCohortStats) => {
      s.bets++; s.stakeUsd += stake; s.payoutUsd += payout;
      if (b.status === "settled_void") s.voided++;
      else if (b.result === "won") s.won++;
      else if (b.result === "lost") s.lost++;
    };
    bump(acc);
    if (!perStrategy.has(b.strategy_id)) perStrategy.set(b.strategy_id, { blind: emptyStats(), control: emptyStats(), bm: new Set(), cm: new Set() });
    const ps = perStrategy.get(b.strategy_id) as NonNullable<ReturnType<typeof perStrategy.get>>;
    bump(isBlind ? ps.blind : ps.control);
    (isBlind ? ps.bm : ps.cm).add(b.match_id);
    if (isBlind) pnlByMatch.set(b.match_id, (pnlByMatch.get(b.match_id) ?? 0) + (payout - stake));
  }

  const byStrategy = {
    blind: [...perStrategy.entries()].filter(([, v]) => v.blind.bets > 0)
      .map(([strategyId, v]) => ({ strategyId, ...finish(v.blind, v.bm) })).sort((a, b) => a.pnlUsd - b.pnlUsd),
    control: [...perStrategy.entries()].filter(([, v]) => v.control.bets > 0)
      .map(([strategyId, v]) => ({ strategyId, ...finish(v.control, v.cm) })).sort((a, b) => a.pnlUsd - b.pnlUsd),
  };
  const byReason: SkipReasonRow[] = [...reasonMatches.entries()].map(([reason, ids]) => {
    let pnl = 0, withBets = 0;
    for (const id of ids) { if (pnlByMatch.has(id)) { withBets++; pnl += pnlByMatch.get(id) as number; } }
    // `matches` — все матчи с этой причиной, `bets` — сколько из них несут расчётные ставки. Разные
    // знаменатели у разных вопросов: слепота бывает и там, где мы не торговали, и это не ноль цены.
    return { reason, matches: ids.size, matchesWithBets: withBets, pnlUsd: r2(pnl) };
  }).sort((a, b) => a.pnlUsd - b.pnlUsd);

  const B = finish(blind, blindMatches), C = finish(control, controlMatches);
  const enough = B.bets >= COHORT_MIN_BETS && C.bets >= COHORT_MIN_BETS;
  const criterion = `сравнение выносится только когда В ОБЕИХ когортах ≥${COHORT_MIN_BETS} расчётных ставок; порог назван до первого прогона.`
    + " Отказ «no_score_data_skip» — ПРИЗНАК МАТЧА (скаут ослеп), а не автор ставки: он fail-closed и сам не торгует, поэтому разрез по стратегии-открывателю обязателен.";

  const note = !skipMatches.size
    ? "строк `no_score_data_skip` в логе нет вовсе — это ОТСУТСТВИЕ ЗАМЕРА, а не нулевая цена слепоты"
    : !enough
      ? `слепая когорта ${B.bets} ставок на ${B.matches} матчах (P&L $${B.pnlUsd}), контроль ${C.bets} на ${C.matches} (P&L $${C.pnlUsd})`
        + ` — порога ${COHORT_MIN_BETS} не достигла ${B.bets < COHORT_MIN_BETS ? "слепая" : "контрольная"} когорта, вердикт НЕ выносится`
      : `слепая когорта: ${B.bets} ставок / ${B.matches} матчей, побед ${B.winRate}%, P&L $${B.pnlUsd} (ROI ${B.roiPct}%)`
        + ` · контроль: ${C.bets} / ${C.matches}, побед ${C.winRate}%, P&L $${C.pnlUsd} (ROI ${C.roiPct}%)`
        + ` · разница ROI ${C.roiPct != null && B.roiPct != null ? Math.round((B.roiPct - C.roiPct) * 10) / 10 : "?"} п.п.`
        + " — это НАБЛЮДАТЕЛЬНОЕ сравнение, а не эффект слепоты: когорты различаются и турнирами, и глубиной книги, отбора в них не было";

  return {
    at: nowIso,
    skipMatchesTotal: skipMatches.size,
    skipMatchesWithBets: B.matches,
    blind: B, control: C, byStrategy, byReason,
    verdict: enough ? "measured" : "insufficient",
    criterion, note,
  };
}

/** Строка для еженедельника. Печатается и при нуле — молчание здесь неотличимо от «слепоты нет». */
export function noScoreSkipCostLine(r: NoScoreSkipCost): string {
  if (!r.skipMatchesTotal) return "no_score_skip_cost: строк отказа нет — НЕ ИЗМЕРЯЕТСЯ";
  const worst = r.byStrategy.blind[0];
  return `no_score_skip_cost: слепых матчей ${r.skipMatchesTotal} (со ставками ${r.skipMatchesWithBets}) · слепая когорта ${r.blind.bets} ставок, P&L $${r.blind.pnlUsd}`
    + ` · контроль ${r.control.bets}, P&L $${r.control.pnlUsd}`
    + (worst ? ` · худший открыватель на слепых: ${worst.strategyId} ($${worst.pnlUsd} на ${worst.bets})` : "")
    + (r.verdict === "insufficient" ? " · вердикт НЕ вынесен (мало данных)" : "");
}
