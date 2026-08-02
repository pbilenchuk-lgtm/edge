// ============================================================
// EDGE LAB — МЕТКА КУСКА = ИСХОД РЫНКА  [W1 / Z2(а)(б), третья ратификация — блокирующая]
//
// Один рынок «разрешался в обе стороны»: Over 1.5, куски одной позиции — settled_lost (выход 11.7¢) и
// settled_won (выход 54.8¢). Это невозможно как факт о рынке и возможно только потому, что статус куска
// ставился по ЗНАКУ P&L куска: closeBetEarly/closeBetPortion пишут won/lost из pnl>0. Для денег это
// безвредно (payout честный), но win-rate, Brier и калибровка потребляют result/status как ПРЕДСКАЗАНИЕ —
// и торговый P&L маскировался под точность прогноза. Ратифицировано в batch5 (Z2а) и batch10 (R6),
// реализуется только сейчас — потому эскалировано в блокирующее.
//
// Разделение по ратификации:
//   • МЕТКА (status/result) = исход РЫНКА. У куска, закрытого досрочно, исход рынка в момент закрытия
//     неизвестен — значит метка ставится ПОСЛЕ разрешения рынка, проходом ниже. Тот же проход по всей
//     истории и есть ретро-миграция: код один, различие только в том, сколько строк ещё не размечено.
//   • СУДЬБА КУСКА (заработал/потерял) — отдельное поле piece_pnl, штампуется из payout−stake и не
//     зависит от исхода рынка. Кусок, проданный в плюс на рынке, который потом проиграл, — это
//     piece_pnl>0 при result='lost', и обе цифры правдивы одновременно.
//   • payout НЕ ТРОГАЕТСЯ НИКОГДА: деньги куска реализованы по цене продажи, перемаркировка меняет
//     смысл ярлыка, а не кассу.
//
// Z2(б), early-путь: рынок, чей исход проверить НЕЛЬЗЯ (ярлык не разрешается по счёту, теннис без
// читаемой детали финала, матч под state_suspect) — НЕ причина молча оставить старую метку и не причина
// выключить проход. Такой кусок помечается market_labeled=2 (accounting_unverifiable): его ожидание
// остаётся оценкой от цены выхода, а потребители калибровки обязаны его отбрасывать как непроверяемый —
// ровно как settle_suspect, только причина не «чужой матч», а «нечем проверить».
//
// market_labeled: 0 = ещё не смотрели · 1 = метка выставлена по исходу рынка · 2 = непроверяемый.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { resolveFootballMarket, matchPhase } from "./settlement.js";
import { isStateSuspect } from "./engine.js";
import { recomputeMetrics } from "./engine.js";
import { tennisFinalResult } from "./tennisTrading.js";
import { bookTotals, type BookTotals } from "./suspectBreakdown.js";

const round2 = (x: number) => Math.round(x * 100) / 100;
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zа-я0-9]+/g, " ").trim();

export interface PieceRelabelResult {
  scanned: number;
  pnlBackfilled: number;       // piece_pnl проставлен (судьба куска — отдельное поле)
  relabeled: number;           // метка выставлена по исходу рынка
  flipped: number;             // ...и при этом сменила значение (won→lost или lost→won) — цена бага в строках
  unverifiable: number;        // market_labeled=2: проверить нечем, потребители обязаны отбрасывать
  deferred: number;            // матч не финишировал / под подозрением — вернёмся следующим проходом
  /** Книга ДО и ПОСЛЕ прохода, снятая ИЗ БАЗЫ. payout не входит в UPDATE — но обещание и факт разные
   *  вещи, и после массовой записи ноль подтверждается измерением. Двусторонний критерий владельца:
   *  win↓ при неизменном P&L — снятие искажения; win↓ вместе с P&L — баг миграции. */
  bookBefore: BookTotals; bookAfter: BookTotals; bookDeltaUsd: number;
  /** Распределение меток до и после ЭТОГО прохода — чтобы сдвиг win-rate был подписан миграцией. */
  labelsBefore: LabelDistribution; labelsAfter: LabelDistribution;
  note: string;
}

/** Распределение исходов по решённым ставкам — то, чем питаются win-rate, Brier и калибровка. */
export interface LabelDistribution {
  won: number; lost: number; void: number; total: number;
  winPct: number | null;
  /** Та же разбивка по стратегиям: сдвиг может быть локальным, и усреднение его спрячет. */
  byStrategy: Record<string, { won: number; lost: number; void: number; winPct: number | null }>;
}

export function labelDistribution(db: Database): LabelDistribution {
  const rows = db.prepare(
    `SELECT strategy_id sid, status FROM bets WHERE status LIKE 'settled%'`,
  ).all() as { sid: string; status: string }[];
  const pct = (w: number, l: number) => (w + l ? Math.round((1000 * w) / (w + l)) / 10 : null);
  const out: LabelDistribution = { won: 0, lost: 0, void: 0, total: 0, winPct: null, byStrategy: {} };
  for (const r of rows) {
    out.total++;
    const k = r.status === "settled_won" ? "won" : r.status === "settled_lost" ? "lost" : "void";
    out[k]++;
    const s = (out.byStrategy[r.sid] ??= { won: 0, lost: 0, void: 0, winPct: null });
    s[k]++;
  }
  out.winPct = pct(out.won, out.lost);
  for (const s of Object.values(out.byStrategy)) s.winPct = pct(s.won, s.lost);
  return out;
}

/** Снимок состояния ДО САМОГО ПЕРВОГО прохода миграции — пишется один раз и живёт вечно. Старая метка
 *  была детерминированной функцией знака P&L, то есть «до» формально восстановимо задним числом — но
 *  восстановимость не заменяет измеримость в моменте, а «до/после» без измеренного «до» опирается на
 *  чью-то память. Ключ ставится ДО первой записи, иначе он бы фиксировал уже сдвинутую картину. */
export const PIECE_RELABEL_BEFORE_KEY = "piece_relabel_before";
export const PIECE_RELABEL_LAST_KEY = "piece_relabel_last";

/**
 * Один проход: судьба куска в piece_pnl, метка куска — по исходу рынка. Идемпотентен (только
 * market_labeled=0), поэтому он же — ретро-миграция всей истории при первом запуске в проде.
 */
export function relabelPiecesByMarket(db: Database, deps: EngineDeps = {}): PieceRelabelResult {
  const now = deps.now?.() ?? new Date().toISOString();
  const bookBefore = bookTotals(db), labelsBefore = labelDistribution(db);
  // «До» фиксируется ДО первой записи и только один раз — иначе снимок поймал бы уже сдвинутую картину.
  if (!R.metaGet(db, PIECE_RELABEL_BEFORE_KEY)) {
    try { R.metaSet(db, PIECE_RELABEL_BEFORE_KEY, JSON.stringify({ at: now, book: bookBefore, labels: labelsBefore }), now); } catch { /* снимок не имеет права ломать миграцию */ }
  }
  const res: PieceRelabelResult = {
    scanned: 0, pnlBackfilled: 0, relabeled: 0, flipped: 0, unverifiable: 0, deferred: 0,
    bookBefore, bookAfter: bookBefore, bookDeltaUsd: 0, labelsBefore, labelsAfter: labelsBefore, note: "",
  };
  const sportByComp = new Map(R.listCompetitions(db).map((c) => [c.id, c.sport_id]));
  const touched = new Set<string>();

  const rows = db.prepare(
    `SELECT id, match_id, strategy_id, market_label, status, result, stake, payout, piece_pnl
       FROM bets
      WHERE settled_by IN ('early','partial') AND status LIKE 'settled%' AND market_labeled = 0`,
  ).all() as any[];

  for (const b of rows) {
    res.scanned++;
    // Судьба куска — всегда, даже если рынок ещё не разрешился: payout и stake уже финальны.
    if (b.piece_pnl == null) {
      db.prepare(`UPDATE bets SET piece_pnl=? WHERE id=?`).run(round2((b.payout ?? 0) - (b.stake ?? 0)), b.id);
      res.pnlBackfilled++;
    }
    const m = R.getMatch(db, b.match_id);
    if (!m || m.state !== "finished") { res.deferred++; continue; }
    // Матч с оборванным фидом / подозрительным финишем не может выдавать метки — отложить, не гадать.
    if (isStateSuspect(db, m.id)) { res.deferred++; continue; }

    let won: boolean | null | undefined;   // true/false = исход рынка · null = рынок void · undefined = проверить нечем
    const sport = sportByComp.get(m.competition_id);
    if (sport === "football") {
      won = m.score_home == null || m.score_away == null ? undefined
        : resolveFootballMarket(b.market_label, m.score_home, m.score_away, { home: m.home, away: m.away }, matchPhase(m)) ?? undefined;
      // resolveFootballMarket возвращает null и для «нерешаемого ярлыка», и это отличимо от void только
      // вручную — здесь консервативно: null = проверить нечем (unverifiable), НЕ void. Ложный void
      // перекрасил бы проигрыш в возврат — та же ошибка, что чинится этим модулем, только новым способом.
    } else if (sport === "tennis") {
      const fin = tennisFinalResult(db, b.match_id);
      if (!fin?.finished || fin.manual) won = undefined;
      else if (fin.canceled) won = null;                                   // walkover/отмена — рынок действительно void
      else if (fin.advancing) {
        // Куски Overreaction/Set-Value — манилайн победителя: ярлык это ИМЯ игрока. Пропозиции (PMV)
        // сюда не попадают — PMV не закрывается early/partial. Сопоставление fail-closed: имя из ярлыка
        // должно однозначно накрыть ровно одного из игроков, иначе — непроверяемо.
        const adv = fold(fin.advancing === "first" ? fin.p1 : fin.p2);
        const other = fold(fin.advancing === "first" ? fin.p2 : fin.p1);
        const lbl = fold(b.market_label);
        const hitAdv = adv.length > 3 && lbl.includes(adv);
        const hitOther = other.length > 3 && lbl.includes(other);
        won = hitAdv !== hitOther ? hitAdv : undefined;
      } else won = undefined;
    } else won = undefined;

    if (won === undefined) {
      db.prepare(`UPDATE bets SET market_labeled=2 WHERE id=?`).run(b.id);
      res.unverifiable++;
      continue;
    }
    const nextStatus = won == null ? "settled_void" : won ? "settled_won" : "settled_lost";
    const nextResult = won == null ? null : won ? "won" : "lost";
    const changed = b.status !== nextStatus;
    // payout сознательно отсутствует в UPDATE — метка меняется, деньги нет.
    db.prepare(`UPDATE bets SET status=?, result=?, market_labeled=1 WHERE id=?`).run(nextStatus, nextResult, b.id);
    res.relabeled++;
    if (changed) {
      res.flipped++;
      touched.add(b.strategy_id);
      R.insertTradeLog(db, {
        id: R.uid(), match_id: b.match_id, strategy_id: b.strategy_id, minute: "пересчёт", type: "settle",
        text: `piece_relabel «${b.market_label}»: метка куска ${b.status}→${nextStatus} по исходу РЫНКА; судьба куска $${round2((b.payout ?? 0) - (b.stake ?? 0))} сохранена в piece_pnl, деньги не тронуты [Z2]`,
        dedup_key: `piece_relabel:${b.id}`, created_at: now,
      });
    }
  }
  for (const sid of touched) { try { recomputeMetrics(db, sid, deps); } catch { /* метрики догонят следующим проходом */ } }

  res.bookAfter = bookTotals(db);
  res.labelsAfter = labelDistribution(db);
  res.bookDeltaUsd = round2(res.bookAfter.pnlSum - res.bookBefore.pnlSum);
  const dWin = res.labelsAfter.winPct != null && res.labelsBefore.winPct != null
    ? Math.round((res.labelsAfter.winPct - res.labelsBefore.winPct) * 10) / 10 : null;
  res.note = `просмотрено ${res.scanned}, размечено по рынку ${res.relabeled} (ПЕРЕВЁРНУТО ${res.flipped}), `
    + `piece_pnl проставлен ${res.pnlBackfilled}, непроверяемых ${res.unverifiable}, отложено ${res.deferred}. `
    + `win-rate ${res.labelsBefore.winPct ?? "н/д"}% → ${res.labelsAfter.winPct ?? "н/д"}%`
    + (dWin != null ? ` (${dWin >= 0 ? "+" : ""}${dWin} пп)` : "") + ". "
    + `Δ книги = ${res.bookDeltaUsd >= 0 ? "+" : ""}$${res.bookDeltaUsd.toFixed(2)} — `
    + (res.bookDeltaUsd === 0
      ? "измерено ИЗ БАЗЫ: метка сменилась, деньги нет. Просадка win-rate здесь — СНЯТИЕ ИСКАЖЕНИЯ, а не регресс."
      : "НЕНУЛЕВАЯ: payout в UPDATE не входит, значит это БАГ МИГРАЦИИ, а не снятие искажения. Разбирать, а не объяснять.");
  try { R.metaSet(db, PIECE_RELABEL_LAST_KEY, JSON.stringify({ at: now, ...res }), now); } catch { /* улика не ломает проход */ }
  return res;
}
