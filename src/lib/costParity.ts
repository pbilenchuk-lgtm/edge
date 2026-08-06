// ============================================================
// EDGE LAB — T5: ПАРИТЕТ ИЗДЕРЖЕК МЕЖДУ НОГАМИ ПОРТФЕЛЯ  [read-only]
//
// ДЕФЕКТ БЫЛ СТРУКТУРНЫМ, А НЕ ЗАБЫВЧИВОСТЬЮ. Футбольный путь зовёт `paperBuyFill`/`paperSellFill`
// НАПРЯМУЮ и получает разбивку издержек; теннисный ходит через исполнителя, а `OrderAck` поля `cost`
// не нёс — числа считались и выбрасывались НА ГРАНИЦЕ АБСТРАКЦИИ. Значит теннисный леджер списывал
// $0 комиссий по построению, а не потому, что их не было.
//
// ЧЕМ ЭТО ХУЖЕ ПРОСТОЙ НЕТОЧНОСТИ: net_ev-гейт ТОЙ ЖЕ теннисной ветки режет кандидатов, ЗНАЯ про
// 2.6¢ издержек. То есть вход считался в одних единицах, а учёт вёлся в других — и P&L двух ног
// портфеля сравнивался как однородный, будучи разнородным. До вердикта n=25 теннисная нога обязана
// считаться в честных издержках, иначе вердикт «теннис прибыльнее футбола» может быть целиком
// артефактом бухгалтерии.
//
// ЭТОТ МОДУЛЬ НИЧЕГО НЕ ПЕРЕПИСЫВАЕТ. История append-only: прошлые ставки остаются как есть, а
// недосписанное называется ЧИСЛОМ и помечается флагом. Переписать P&L задним числом значило бы
// сделать неотличимыми «мы посчитали честно тогда» и «мы поправили потом».
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

/** Комиссия тейкера в долях (тот же дефолт, что у исполнения: POLYMARKET_TAKER_FEE_RATE). */
export function takerRate(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.POLYMARKET_TAKER_FEE_RATE);
  return Number.isFinite(n) && n >= 0 ? n : 0.0075;
}

export interface CostParityLeg {
  leg: string;
  bets: number;
  /** Ставки, у которых В ЛЕДЖЕРЕ есть хоть одна строка издержек. */
  betsWithLedger: number;
  notionalUsd: number;
  ledgerFeeUsd: number; ledgerSlipUsd: number;
  /** Оценка комиссии, которая ДОЛЖНА была быть списана по той же модели, что у исполнения. */
  expectedFeeUsd: number;
  /** Недосписано = ожидание − леджер. Отрицательное невозможно и означало бы двойное списание. */
  underchargedUsd: number;
  note: string;
}

export interface CostParityReport {
  at: string; takerRate: number;
  legs: CostParityLeg[];
  /** Флаг, а не переписывание: строки прошлого остаются, но их неоднородность названа. */
  flagged: boolean;
  note: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Оценка недосписанного по каждой ноге. НОТIONAL считается по САМИМ ставкам (stake на входе + payout
 * на выходе), а не по леджеру — иначе нога, у которой леджер пуст, показала бы нулевой оборот и
 * нулевое расхождение: сторож, доказывающий своё отсутствие собственным отсутствием.
 */
export function buildCostParity(db: Database, nowIso: string, env: Record<string, string | undefined> = process.env): CostParityReport {
  const rate = takerRate(env);
  const strategies = R.listStrategies(db);
  const sportOf = new Map(strategies.map((s) => [s.id, s.sport_id]));
  const ledgerByBet = new Map<string, { fee: number; slip: number }>();
  try {
    const rows = db.prepare(`SELECT bet_id, SUM(fee_usd) f, SUM(slip_usd) s FROM fill_costs WHERE bet_id IS NOT NULL GROUP BY bet_id`).all() as { bet_id: string; f: number; s: number }[];
    for (const r of rows) ledgerByBet.set(r.bet_id, { fee: Number(r.f) || 0, slip: Number(r.s) || 0 });
  } catch { /* леджера может не быть — тогда всё «без строк», и это честный ответ */ }

  const acc = new Map<string, CostParityLeg>();
  for (const b of R.allBets(db)) {
    if (b.status === "proposed" || b.status === "not_filled") continue;
    const leg = sportOf.get(b.strategy_id) ?? "unknown";
    if (!acc.has(leg)) acc.set(leg, { leg, bets: 0, betsWithLedger: 0, notionalUsd: 0, ledgerFeeUsd: 0, ledgerSlipUsd: 0, expectedFeeUsd: 0, underchargedUsd: 0, note: "" });
    const a = acc.get(leg)!;
    a.bets++;
    const led = ledgerByBet.get(b.id);
    if (led) { a.betsWithLedger++; a.ledgerFeeUsd += led.fee; a.ledgerSlipUsd += led.slip; }
    // Оборот: вход всегда, выход — только если позиция закрылась (payout это проданный номинал).
    const inUsd = b.stake ?? 0;
    const outUsd = R.isSettled(b.status) ? (b.payout ?? 0) : 0;
    a.notionalUsd += inUsd + outUsd;
    a.expectedFeeUsd += (inUsd + outUsd) * rate;
  }
  const legs = [...acc.values()].map((a) => {
    a.notionalUsd = r2(a.notionalUsd); a.ledgerFeeUsd = r2(a.ledgerFeeUsd); a.ledgerSlipUsd = r2(a.ledgerSlipUsd);
    a.expectedFeeUsd = r2(a.expectedFeeUsd);
    a.underchargedUsd = r2(Math.max(0, a.expectedFeeUsd - a.ledgerFeeUsd));
    const cov = a.bets ? Math.round((a.betsWithLedger / a.bets) * 1000) / 10 : 0;
    a.note = `${a.betsWithLedger}/${a.bets} ставок несут строку издержек (${cov}%) · оборот $${a.notionalUsd}`
      + ` · в леджере комиссий $${a.ledgerFeeUsd} + слиппеджа $${a.ledgerSlipUsd}`
      + ` · по модели ожидалось комиссий $${a.expectedFeeUsd}`
      + (a.underchargedUsd > 0 ? ` · НЕДОСПИСАНО ≈$${a.underchargedUsd}` : ` · расхождения нет`);
    return a;
  }).sort((x, y) => y.underchargedUsd - x.underchargedUsd);

  const flagged = legs.some((l) => l.underchargedUsd > 0 && l.bets > 0);
  const worst = legs[0];
  return {
    at: nowIso, takerRate: rate, legs, flagged,
    note: !legs.length ? "ставок нет — сравнивать нечего"
      : flagged
        ? `ПАРИТЕТА НЕТ: нога «${worst!.leg}» недосписала ≈$${worst!.underchargedUsd} комиссий (покрытие леджера ${worst!.betsWithLedger}/${worst!.bets}).`
          + ` История НЕ переписывается — расхождение названо числом и помечено; вперёд обе ноги считаются одной моделью.`
          + ` Сравнивать P&L ног ДО этой отметки как однородный нельзя.`
        : `паритет держится: все ноги списывают по одной модели (ставка ${rate})`,
  };
}

/** Строка для еженедельника: одно число на ногу, ноль печатается наравне с сотней. */
export function costParityLine(r: CostParityReport): string {
  return `паритет издержек: ` + (r.legs.map((l) => `${l.leg} ${l.betsWithLedger}/${l.bets} строк, недосписано $${l.underchargedUsd}`).join(" · ") || "ставок нет")
    + ` · ставка комиссии ${r.takerRate}`;
}
