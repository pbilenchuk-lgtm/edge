// ============================================================
// EDGE LAB — D1: ЗАЩИТНЫЙ СРЕЗ ИСПОЛНЯЕТСЯ ПО СЛОМУ ТЕЗИСА, А НЕ ПО ЦЕНЕ
// [батч-13 D1; ратифицированное следствие вердикта noise_driven, критерий зафиксирован ДО данных]
//
// ЧТО ИЗМЕРЕНО. `stop_counterfactual` на n=1128 защитных выходов (порог ратификации 30 — перекрыт в 38×):
// медианный недобор 12.6¢ = 37.6% цены среза. То есть МЕДИАННЫЙ защитный выход продавал по цене, которая
// в ближайшие 30 минут стоила на треть дороже. Разрез по причине среза:
//   time_decay_floor  n= 58  недобор  27.2¢ / 1035%   ← «защита», отдающая 27¢ с доллара
//   capitulation      n= 51  недобор  47.2¢ /   89%
//   time_stop         n=465  недобор  15.7¢ /   65%
//   thesis_stop       n=382  недобор   9.6¢ /   29%
//   counter_scenario  n=172  недобор  −0.5¢ /  −50%   ← ЕДИНСТВЕННЫЙ, кто режет вовремя
// По стратегии: overreaction 33.9¢ / 102.8% — срез отдаёт БОЛЬШЕ, чем берёт.
//
// ПОЧЕМУ ИМЕННО ТАЮЩИЙ ОПЦИОН. У Over/BTTS-Yes downside уже ≈0: он гасится в 0, если событие не наступит.
// Значит досрочная продажа не может защитить — она может только отдать оставшийся шанс. Цена такого опциона
// падает ПО ВРЕМЕНИ, а не по смерти тезиса; путать одно с другим и есть источник недобора 1035%.
//
// ПРАВИЛО. Защитный срез тающего опциона исполняется ТОЛЬКО при сломе тезиса ПО GAME-STATE. Цена сама по
// себе — не основание. `counter_scenario` НЕ ТРОГАЕТСЯ: это единственный путь с отрицательным недобором.
//
// ЧЕСТНАЯ ГРАНИЦА, КОТОРУЮ НАДО НАЗВАТЬ. Для тающего опциона game-state почти никогда не подтверждает
// смерть тезиса до финального свистка: гол может прийти на 90+6. Поэтому правило по сути означает «тающие
// опционы держим до сеттла», и я не прячу это за формулировкой. Ровно на это и указывает недобор: в
// среднем поздний гол приходит чаще, чем стоит проданный за 4¢ билет.
//
// ЧТО ОСТАЁТСЯ ЗАЩИТОЙ. quasi-locked предикат (он и назван в ТЗ временным носителем функции), T1.1-якорь
// на противоречии счёта и цены, T1.2 терминальная защита, и весь не-тающий периметр (Under/No/директивы) —
// там каждый гол это необратимый шаг вниз, и стоп остаётся.
//
// ОТКАТ ЗАПИСАН ДО ДЕПЛОЯ. `netHoldBenefitUsd` считает, что удержание ВЗЯЛО и что ОТДАЛО. Две недели
// подряд отрицательная сумма → правило откатывается, вопрос возвращается с данными. Порог зафиксирован
// здесь, в коде, а не в чьей-то памяти.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { logLine } from "./logLine.js";

/** Причины среза, которые считаются ЗАЩИТНЫМИ. `counter_scenario` намеренно вне списка — он режет вовремя. */
export const DEFENSIVE_CUT_KINDS = new Set(["hard_stop", "thesis_stop", "capitulation", "time_stop", "time_decay_floor"]);

/**
 * time_decay_floor ПРИОСТАНОВЛЕН КАК КЛАСС до редизайна (D1). Недобор 27.2¢ при n=58 означает, что floor
 * систематически продаёт лотерейный билет ДЕШЕВЛЕ его справедливой цены: на 80'+ поздний гол приходит
 * чаще, чем 4¢. Включается обратно только явным `TIME_DECAY_FLOOR_ENABLED=1` — то есть решением, а не
 * умолчанием.
 */
export const timeDecayFloorEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env.TIME_DECAY_FLOOR_ENABLED === "1";

/** Коды удержаний, введённые D1. Машиночитаемы (стандарт O5) — измерение не парсит прозу. */
export const D1_HOLD_CODES = ["time_decay_floor_suspended", "melting_time_stop_held", "melting_cut_no_thesis_break"] as const;
export type D1HoldCode = (typeof D1_HOLD_CODES)[number];

/**
 * Подтверждает ли game-state СМЕРТЬ тезиса тающего опциона? Возвращает null, если не подтверждает
 * (значит держим), либо причину, по которой срез законен.
 *
 * Для тающего опциона смерть наступает ровно тогда, когда событие больше не может произойти: матч
 * закончился. Всё, что раньше, — это падение цены по времени, а не слом тезиса. Функция намеренно
 * узкая: расширять её «структурными событиями» без замера — значит вернуть тот же недобор под новым
 * именем.
 */
export function meltingThesisDead(matchState: string, minute: number | null, maxMinutes: number): string | null {
  if (matchState === "finished") return "матч завершён — событие уже не наступит, опцион гасится";
  if (minute != null && minute >= maxMinutes + 10) return `${minute}' при регламенте ${maxMinutes}' — матч фактически закончен`;
  return null;
}

export interface CutGateInput {
  /** Причина среза в терминах отчёта (`hard_stop` / `time_stop` / `time_decay_floor` / `capitulation`). */
  kind: string;
  /** Тающий ли опцион (winsOnEventOccurrence): его downside уже ≈0. */
  melting: boolean;
  matchState: string;
  minute: number | null;
  maxMinutes: number;
  /** Стратег-слой недоступен: страховка восстанавливается, иначе позиция остаётся без присмотра вообще. */
  degraded: boolean;
  env?: Record<string, string | undefined>;
}
export interface CutGateVerdict { allow: boolean; code: D1HoldCode | null; reason: string }

/**
 * Единственная точка решения «резать защитно или держать». Один авторитет: и живой путь, и тесты, и
 * будущий отчёт спрашивают ЗДЕСЬ.
 */
export function defensiveCutAllowed(i: CutGateInput): CutGateVerdict {
  const env = i.env ?? process.env;
  // counter_scenario и любые НЕзащитные причины (тейк, edge_closed) проходят без изменений.
  if (!DEFENSIVE_CUT_KINDS.has(i.kind)) return { allow: true, code: null, reason: "не защитный срез — правило D1 не применяется" };
  // Деградация стратег-слоя: страховка возвращается. Позиция без присмотра хуже, чем срез с недобором.
  if (i.degraded) return { allow: true, code: null, reason: "стратег-слой недоступен — ценовая страховка восстановлена (degraded_mode)" };
  if (i.kind === "time_decay_floor") {
    // ФЛАГ ОБЯЗАН ЧТО-ТО ЗНАЧИТЬ. Первая версия оставляла флор под общим правилом тающего опциона — и
    // тогда `TIME_DECAY_FLOOR_ENABLED=1` не менял НИЧЕГО: включённый флор всё равно душился следующей
    // проверкой. Тумблер, который не переключает, — это ложь в конфиге, и тест это поймал.
    // Семантика: приостановка снимается ЯВНЫМ решением владельца после редизайна, и тогда флор — это
    // сознательно включённый путь, а не забытый дефолт. Поэтому включённый флор идёт мимо общего
    // правила: включать его имеет смысл ровно затем, чтобы он срабатывал.
    if (!timeDecayFloorEnabled(env)) {
      return {
        allow: false, code: "time_decay_floor_suspended",
        reason: "time_decay_floor ПРИОСТАНОВЛЕН как класс (D1): недобор 27.2¢ при n=58 — защита отдавала 27¢ с доллара; функцию временно несёт quasi-locked предикат",
      };
    }
    return { allow: true, code: null, reason: "time_decay_floor включён ЯВНЫМ решением (TIME_DECAY_FLOOR_ENABLED=1) — приостановка снята после редизайна" };
  }
  if (!i.melting) return { allow: true, code: null, reason: "не тающий опцион — каждый гол необратимый шаг вниз, стоп остаётся" };
  const dead = meltingThesisDead(i.matchState, i.minute, i.maxMinutes);
  if (dead) return { allow: true, code: null, reason: `слом тезиса подтверждён game-state: ${dead}` };
  return {
    allow: false,
    code: i.kind === "time_stop" ? "melting_time_stop_held" : "melting_cut_no_thesis_break",
    reason: `защитный срез «${i.kind}» тающего опциона НЕ исполнен: game-state слом тезиса не подтверждает, а цена сама по себе — не основание (D1). Downside опциона уже ≈0, срез может только отдать оставшийся шанс`,
  };
}

// ── САМОИЗМЕРЕНИЕ С ОТКАТ-ПОРОГОМ ───────────────────────────────────────────────────────────────

/** Метка удержания: пишется машиночитаемой строкой, чтобы измерение НЕ разбирало прозу (стандарт O5). */
export function recordHoldMark(
  db: Database, matchId: string, strategyId: string, betId: string, code: D1HoldCode,
  priceCents: number, human: string, nowIso: string,
): void {
  try {
    R.insertTradeLog(db, {
      id: R.uid(), match_id: matchId, strategy_id: strategyId, minute: "d1", type: "hold",
      text: logLine({ point: "exit_gate", verdict: "block", reason: code, n: priceCents }, `${human} [bet:${betId}]`),
      dedup_key: `d1:${code}:${betId}`, created_at: nowIso,
    } as never);
  } catch { /* улика не имеет права ронять торговый путь */ }
}

export interface HoldBenefitRow {
  betId: string; code: string; matchLabel: string; strategyId: string; market: string;
  holdCents: number; entryCents: number | null; stakeUsd: number;
  wouldBeCutUsd: number | null; realizedUsd: number | null; benefitUsd: number | null;
}
export interface HoldBenefitWeek { weekStart: string; n: number; netHoldBenefitUsd: number; tookUsd: number; gaveUsd: number }
export interface NetHoldBenefit {
  weeks: HoldBenefitWeek[];
  /** Две недели подряд отрицательны → правило откатывается. Порог зафиксирован ДО деплоя. */
  rollback: { triggered: boolean; consecutiveNegative: number; needConsecutive: number; note: string };
  rows: HoldBenefitRow[];
  reviewDate: string | null;
  note: string;
}
export const HOLD_BENEFIT_ROLLBACK_WEEKS = 2;

/**
 * Что удержание ВЗЯЛО и что ОТДАЛО, деньгами.
 *
 * По каждой заблокированной резке: стоимость позиции, если бы её срезали в момент удержания
 * (`stake × holdCents / entryCents`), против фактически реализованной (`payout`). Разность и есть вклад
 * правила. Положительная сумма — удержание выиграло; отрицательная — отдало.
 *
 * Формула намеренно СИММЕТРИЧНА: она не умеет льстить правилу, потому что берёт фактический payout, а не
 * лучшую цену окна. Просадки входят в неё с тем же знаком, что и выигрыши.
 */
export function buildNetHoldBenefit(db: Database, nowMs = Date.now()): NetHoldBenefit {
  const rows: HoldBenefitRow[] = [];
  let logs: { match_id: string; strategy_id: string; text: string; created_at: string }[] = [];
  try {
    logs = db.prepare(
      `SELECT match_id, strategy_id, text, created_at FROM trade_log WHERE dedup_key LIKE 'd1:%'`,
    ).all() as never;
  } catch { logs = []; }
  const byWeek = new Map<string, { n: number; took: number; gave: number }>();
  for (const l of logs) {
    const m = /^\[exit_gate\/block reason=([a-z_]+) n=([\d.]+)\].*\[bet:([^\]]+)\]/.exec(l.text ?? "");
    if (!m) continue;
    const [, code, cents, betId] = m;
    const b = db.prepare(`SELECT id, market_label, stake, entry_price, payout, status FROM bets WHERE id=?`).get(betId) as
      { id: string; market_label: string; stake: number | null; entry_price: number | null; payout: number | null; status: string } | undefined;
    if (!b) continue;
    const holdCents = Number(cents);
    const stake = b.stake ?? 0;
    const entry = b.entry_price;
    const wouldBeCut = entry && entry > 0 ? Math.round((stake * holdCents / entry) * 100) / 100 : null;
    const realized = b.status.startsWith("settled") ? (b.payout ?? 0) : null;   // ещё открытая — вклад НЕ считаем
    const benefit = wouldBeCut != null && realized != null ? Math.round((realized - wouldBeCut) * 100) / 100 : null;
    const mm = db.prepare(`SELECT home, away FROM matches WHERE id=?`).get(l.match_id) as { home: string; away: string } | undefined;
    rows.push({
      betId, code, matchLabel: mm ? `${mm.home} — ${mm.away}` : l.match_id, strategyId: l.strategy_id,
      market: b.market_label, holdCents, entryCents: entry, stakeUsd: stake,
      wouldBeCutUsd: wouldBeCut, realizedUsd: realized, benefitUsd: benefit,
    });
    if (benefit == null) continue;
    const d = new Date(Date.parse(l.created_at) || nowMs);
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const wk = monday.toISOString().slice(0, 10);
    const acc = byWeek.get(wk) ?? { n: 0, took: 0, gave: 0 };
    acc.n++; if (benefit >= 0) acc.took += benefit; else acc.gave += -benefit;
    byWeek.set(wk, acc);
  }
  const weeks: HoldBenefitWeek[] = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, v]) => ({ weekStart, n: v.n, tookUsd: Math.round(v.took * 100) / 100, gaveUsd: Math.round(v.gave * 100) / 100, netHoldBenefitUsd: Math.round((v.took - v.gave) * 100) / 100 }));
  let consec = 0;
  for (let i = weeks.length - 1; i >= 0; i--) { if (weeks[i].netHoldBenefitUsd < 0) consec++; else break; }
  const triggered = consec >= HOLD_BENEFIT_ROLLBACK_WEEKS;
  return {
    weeks, rows,
    rollback: {
      triggered, consecutiveNegative: consec, needConsecutive: HOLD_BENEFIT_ROLLBACK_WEEKS,
      note: triggered
        ? `⚠ ОТКАТ: ${consec} недели подряд netHoldBenefitUsd < 0 — правило D1 откатывается, вопрос возвращается С ДАННЫМИ, а не со спором`
        : `${consec}/${HOLD_BENEFIT_ROLLBACK_WEEKS} отрицательных недель подряд — порог отката НЕ достигнут`,
    },
    reviewDate: weeks.length ? weeks[weeks.length - 1].weekStart : null,
    note: weeks.length
      ? `netHoldBenefit: ${weeks.length} недель(и), последняя ${weeks[weeks.length - 1].netHoldBenefitUsd >= 0 ? "+" : ""}$${weeks[weeks.length - 1].netHoldBenefitUsd.toFixed(2)}`
      : "удержаний по правилу D1 ещё не было — это ОТСУТСТВИЕ ЗАМЕРА, а не ноль пользы",
  };
}

/** Строка для еженедельника. */
export function holdBenefitLine(r: NetHoldBenefit): string {
  const w = r.weeks[r.weeks.length - 1];
  return `d1_hold_benefit: ${w ? `${w.netHoldBenefitUsd >= 0 ? "+" : ""}$${w.netHoldBenefitUsd.toFixed(2)} (взято $${w.tookUsd.toFixed(2)} / отдано $${w.gaveUsd.toFixed(2)}, n=${w.n})` : "нет данных"}`
    + (r.rollback.triggered ? " · ⚠ ПОРОГ ОТКАТА ДОСТИГНУТ" : "");
}
