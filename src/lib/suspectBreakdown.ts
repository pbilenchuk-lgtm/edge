// ============================================================
// EDGE LAB — ПОЧЕМУ 53 СТАВКИ ВСЁ ЕЩЁ В КАРАНТИНЕ  [раскладка, не новое расследование]
//
// Пере-снимок гейта 02.08: в вердиктную когорту вошло 36 записей (13 сигналов), а ИСКЛЮЧЕНО как
// `settle_suspect` — 53. Карантин больше включённой выборки. Гейт не «копит медленно» — он копит из
// четверти потока, и это отдельный факт, который стоит назвать вслух.
//
// Мотивация владельца дословно: если хотя бы половина раскарантинивается ЧЕСТНО, гейт-когорта удваивается
// без единого нового матча — самый быстрый легальный рычаг её созревания. «Честно» здесь несущее слово:
// снять метку по недоказанной привязке значит впустить в вердикт чужой счёт, а это ровно тот класс, ради
// которого карантин и вводился.
//
// ПОЧЕМУ ЭТО РАСКЛАДКА, А НЕ ВТОРАЯ РЕАЛИЗАЦИЯ. Машинерия пере-сеттла уже есть (reSettleSuspectBets), и
// написать «свой» классификатор рядом означало бы завести второй авторитет, который однажды разойдётся с
// первым — та же болезнь, что скрипт-мимо-кода у CLV. Поэтому решающий предикат ОДИН: `classifySuspect`.
// Отчёт вызывает его и ничего не делает; пере-сеттл вызывает его и действует. Разойтись они не могут.
//
// ТРИ КЛАССА, которые различает раскладка, — ровно те, что были заказаны:
//   (а) `unprovable_binding` — привязка честно недоказуема (нет даты события ESPN или разрыв больше
//       допустимого). Такие остаются в карантине НАВСЕГДА, и это правильный исход, а не недоработка;
//   (б) `ready` — доказуемо, пере-сеттл их закроет: прогнать;
//   (в) `uncovered` — доказуемо по привязке, но пере-сеттлер их не берёт (ярлык не разрешается по счёту,
//       матч не в терминальном состоянии, заморозка F2). ВОТ ЭТО было бы работой, и раскладка отвечает
//       на вопрос «есть ли она вообще», числом, а не мнением.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Bet, Match } from "./types.js";

/** Версия решающего предиката. Пишется в `settle_verified_by` вместе с датой: через месяц вопрос «чем
 *  именно снят этот флаг» обязан иметь ответ в самой строке, а не в чьей-то памяти. Поднимать при ЛЮБОМ
 *  изменении условий классификации — иначе снятия разных эпох станут неразличимы. */
export const CLASSIFY_VERSION = "classify-1.0";

/** Итог массовой записи, СНЯТЫЙ ИЗ БАЗЫ ПОСЛЕ неё, а не выведенный из предиката. Предикат обещает нулевую
 *  дельгу денег и покрыт тестом — но стандарт со времён бэкфиллов такой: после каждой массовой записи
 *  дельта книги подтверждается ИЗМЕРЕНИЕМ. Обещание и факт — разные вещи, и вторая дешевле первой. */
export interface BookTotals { settledBets: number; stakeSum: number; payoutSum: number; pnlSum: number }

export function bookTotals(db: Database): BookTotals {
  const r = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(stake),0) st, COALESCE(SUM(payout),0) po
       FROM bets WHERE status LIKE 'settled%'`,
  ).get() as { n: number; st: number; po: number };
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return { settledBets: r.n, stakeSum: round2(r.st), payoutSum: round2(r.po), pnlSum: round2(r.po - r.st) };
}

export type SuspectClass =
  | "ready_regrade"        // (б) доказуемо и статус изменится
  | "ready_confirm"        // (б) доказуемо, статус уже верный — снимется метка
  | "unprovable_binding"   // (а) нет даты события / разрыв больше допустимого
  | "uncovered_label"      // (в) привязка доказана, но ярлык не разрешается по счёту
  | "uncovered_state"      // (в) матч не завершён / нет счёта / заморозка F2
  | "orphan";              // строка ставки/матча исчезла — не классифицируется

export interface SuspectRow {
  betId: string; matchId: string; matchLabel: string; competitionId: string;
  strategyId: string; marketLabel: string; status: string;
  cls: SuspectClass; reason: string;
  /** Разрыв между привязанным событием ESPN и кикоффом, в часах — чтобы «недоказуемо» было проверяемым. */
  legGapHours: number | null;
}

export interface SuspectBreakdown {
  total: number;
  byClass: Record<SuspectClass, number>;
  /** Сколько выйдет из карантина, если прогнать пере-сеттл прямо сейчас. */
  releasableNow: number;
  /** Останутся навсегда — карантин работает как задумано. */
  permanentQuarantine: number;
  /** Доказуемы, но конвейер их не берёт — единственный класс, который был бы РАБОТОЙ. */
  uncovered: number;
  rows: SuspectRow[];
  note: string;
}

/**
 * РЕШАЮЩИЙ ПРЕДИКАТ — один на отчёт и на действие.
 *
 * Условия дословно те же, по которым `reSettleSuspectBets` решает regrade / confirm / defer; разница
 * только в том, что здесь `deferred` разбит на ПРИЧИНЫ. Пере-сеттл вызывает эту же функцию, поэтому
 * «отчёт говорит одно, конвейер делает другое» невозможно по построению.
 */
export function classifySuspect(
  db: Database, betId: string,
  opts: { legGapMs: number; isStateSuspect: (db: Database, matchId: string) => boolean; resolveOutcome: (bet: Bet, match: Match) => boolean | null },
): { cls: SuspectClass; reason: string; legGapHours: number | null; won?: boolean } {
  const bet = R.getBet(db, betId);
  if (!bet) return { cls: "orphan", reason: "строка ставки исчезла", legGapHours: null };
  const m = R.getMatch(db, bet.match_id);
  if (!m) return { cls: "orphan", reason: "строка матча исчезла", legGapHours: null };

  if (m.state !== "finished") return { cls: "uncovered_state", reason: `матч не завершён (${m.state})`, legGapHours: null };
  if (m.score_home == null || m.score_away == null) return { cls: "uncovered_state", reason: "счёта нет — судить не по чему", legGapHours: null };
  if (opts.isStateSuspect(db, m.id)) return { cls: "uncovered_state", reason: "матч под state_suspect (F2) — сеттл заморожен", legGapHours: null };

  const live = R.getMatchLive(db, m.id);
  const koMs = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
  const evMs = live?.espn_event_date ? Date.parse(live.espn_event_date) : NaN;
  const gapH = Number.isFinite(koMs) && Number.isFinite(evMs) ? Math.round(Math.abs(evMs - koMs) / 360_000) / 10 : null;
  if (!Number.isFinite(evMs)) return { cls: "unprovable_binding", reason: "у привязки нет даты события ESPN — доказать, что это НАШ круг, нечем", legGapHours: null };
  if (!Number.isFinite(koMs)) return { cls: "unprovable_binding", reason: "у матча нет кикоффа — сравнивать не с чем", legGapHours: null };
  if (Math.abs(evMs - koMs) > opts.legGapMs) {
    return { cls: "unprovable_binding", reason: `событие ESPN отстоит от кикоффа на ${gapH}ч — за пределом допустимого разрыва`, legGapHours: gapH };
  }

  const won = opts.resolveOutcome(bet, m);
  if (won == null) return { cls: "uncovered_label", reason: `ярлык «${bet.market_label}» не разрешается по счёту ${m.score_home}:${m.score_away}`, legGapHours: gapH };

  const nextStatus = won ? "settled_won" : "settled_lost";
  return bet.status === nextStatus
    ? { cls: "ready_confirm", reason: "привязка доказана, статус уже верный — снимется только метка", legGapHours: gapH, won }
    : { cls: "ready_regrade", reason: `привязка доказана, статус изменится ${bet.status} → ${nextStatus}`, legGapHours: gapH, won };
}

const EMPTY: Record<SuspectClass, number> = {
  ready_regrade: 0, ready_confirm: 0, unprovable_binding: 0, uncovered_label: 0, uncovered_state: 0, orphan: 0,
};

/** Раскладка карантина. Только чтение — ничего не снимает и не пересчитывает. */
export function buildSuspectBreakdown(
  db: Database,
  opts: { legGapMs: number; isStateSuspect: (db: Database, matchId: string) => boolean; resolveOutcome: (bet: Bet, match: Match) => boolean | null },
): SuspectBreakdown {
  const ids = db.prepare(`SELECT id FROM bets WHERE settle_suspect=1 AND status LIKE 'settled%'`).all() as { id: string }[];
  const byClass = { ...EMPTY };
  const rows: SuspectRow[] = [];
  for (const { id } of ids) {
    const c = classifySuspect(db, id, opts);
    byClass[c.cls]++;
    const bet = R.getBet(db, id);
    const m = bet ? R.getMatch(db, bet.match_id) : null;
    rows.push({
      betId: id, matchId: bet?.match_id ?? "", matchLabel: m ? `${m.home} — ${m.away}` : "—",
      competitionId: m?.competition_id ?? "", strategyId: bet?.strategy_id ?? "",
      marketLabel: bet?.market_label ?? "", status: bet?.status ?? "",
      cls: c.cls, reason: c.reason, legGapHours: c.legGapHours,
    });
  }
  const releasableNow = byClass.ready_regrade + byClass.ready_confirm;
  const permanentQuarantine = byClass.unprovable_binding;
  const uncovered = byClass.uncovered_label + byClass.uncovered_state;

  const note = ids.length === 0
    ? "карантина нет — раскладывать нечего"
    : `в карантине ${ids.length}. ГОТОВЫ К СНЯТИЮ СЕЙЧАС: ${releasableNow} (${byClass.ready_regrade} с пересчётом статуса, ${byClass.ready_confirm} только снятие метки) — прогон reSettleSuspectBets закроет их тем же предикатом. `
      + `НАВСЕГДА В КАРАНТИНЕ: ${permanentQuarantine} — привязка честно недоказуема, и это правильный исход, а не недоработка. `
      + `КОНВЕЙЕР НЕ БЕРЁТ: ${uncovered} (${byClass.uncovered_label} нерешаемый ярлык, ${byClass.uncovered_state} матч не в терминальном состоянии) — единственный класс, который был бы РАБОТОЙ.`
      + (byClass.orphan ? ` Осиротевших строк: ${byClass.orphan}.` : "");

  return { total: ids.length, byClass, releasableNow, permanentQuarantine, uncovered, rows, note };
}
