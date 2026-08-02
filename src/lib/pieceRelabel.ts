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

/**
 * Снимок состояния до первого прохода В ЭТОМ ДЕПЛОЕ — и это НЕ то же самое, что «до миграции».
 *
 * ИМЯ ОБЕЩАЛО ГАРАНТИЮ, КОТОРУЮ КОД ДАТЬ НЕ МОЖЕТ. Здесь было написано «снимок состояния ДО САМОГО
 * ПЕРВОГО прохода миграции». Ключ, однако, появился только в #108 (02.08), а сама миграция поехала в #76
 * (28.07) — и на проде он записал состояние ЧЕТЫРЬМЯ СУТКАМИ ПОЗЖЕ первого прохода. Откат 30.07 снёс код,
 * но не строки, поэтому метки, переставленные 28–30.07, к моменту снимка уже лежали в базе.
 *
 * Условие «пусто ⇒ это первый проход» ложно в точности тогда, когда код успел поработать раньше ключа —
 * а именно так и бывает при восстановлении удалённого модуля. Оставлять формулировку было бы обещанием
 * задним числом, поэтому она заменена, а честное «до» строится отдельно: см. auditPieceMigration(), где
 * оно ВОССТАНАВЛИВАЕТСЯ из двух независимых следов и прямо называется реконструкцией.
 */
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

// ============================================================
// АУДИТ МИГРАЦИИ ЗАДНИМ ЧИСЛОМ — ПОТОМУ ЧТО «ДО» НЕ БЫЛО СНЯТО ВОВРЕМЯ
//
// Разбор 02.08 вечером: `PIECE_RELABEL_BEFORE_KEY` на проде проставлен 02.08 11:20Z, а сама миграция
// впервые поехала #76 от 28.07 17:12Z — на четверо суток раньше. Откат 30.07 снёс КОД, но не строки: метки,
// переставленные 28–30.07, остались в базе. Значит снимок, который в комментарии рядом назван «состоянием
// ДО САМОГО ПЕРВОГО прохода», на проде поймал состояние ПОСЛЕ. Имя ключа обещало гарантию, которой код
// дать не может: ключ фиксирует «до первого прохода ПОСЛЕ ЭТОГО ДЕПЛОЯ», а не «до миграции».
//
// Ратифицированное «до/после» из этого снимка не собирается. Но оно собирается из ДВУХ независимых следов,
// и их независимость здесь принципиальна — ровно как в приёмке O6:
//
//   ИСТОЧНИК A — СОБСТВЕННЫЕ УЛИКИ МИГРАЦИИ. На каждый переворот она пишет строку trade_log с
//     dedup_key `piece_relabel:<betId>` и текстом «метка куска <было>→<стало>». Это ПРЯМАЯ запись факта,
//     точная до строки. Слабость: журнал подрезается ретенцией, поэтому источник A — НИЖНЯЯ ГРАНИЦА.
//
//   ИСТОЧНИК B — РЕКОНСТРУКЦИЯ ИЗ ЗАМОРОЖЕННОГО ПОЛЯ. Старая метка была детерминированной функцией знака
//     P&L куска, а `piece_pnl` миграция сохранила. Значит «до» = знак piece_pnl. Слабость: это ВЫВОД, а не
//     запись. Сила: ретенции не подвержен вовсе.
//
// ПРАВИЛО B ПРОВЕРЯЕТСЯ НА ЖИВЫХ ДАННЫХ, А НЕ ПРИНИМАЕТСЯ НА ВЕРУ: строки, которых миграция НЕ меняла
// (market_labeled 0 и 2), обязаны совпадать со знаком своего piece_pnl. Доля совпадения — измеренная
// точность реконструкции, и она печатается рядом с ответом, а не прячется.
//
// Согласие A и B — не украшение. Разошлись — значит одно из двух неверно, и это находка, а не помеха.
// ============================================================

export interface PieceFlipTally { total: number; wonToLost: number; lostToWon: number; byStrategy: Record<string, number> }
export interface PieceMigrationAudit {
  /** A: точный след самой миграции. Нижняя граница — журнал подрезается. */
  logged: PieceFlipTally;
  /** B: вывод из знака piece_pnl по строкам, размеченным миграцией. Ретенции не подвержен. */
  reconstructed: PieceFlipTally;
  /** Точность правила B, измеренная на строках, которых миграция НЕ касалась. */
  control: { checked: number; agree: number; agreePct: number | null };
  /** Куски с РОВНО нулевым piece_pnl: знак не определён, значит правило B к ним неприменимо. Не ошибка
   *  правила, а его честная область определения — считаются отдельно и в выводы не входят. */
  indeterminate: number;
  /** Сходятся ли два независимых источника по числу и направлению. */
  agreement: { same: boolean; note: string };
  /** Текущее распределение меток и восстановленное «до» (по источнику B, как не подверженному ретенции). */
  after: LabelDistribution; before: LabelDistribution; deltaWinPp: number | null;
  /** Можно ли доверять сохранённому снимку `PIECE_RELABEL_BEFORE_KEY` как «до». */
  storedSnapshot: { at: string | null; trustworthy: boolean; note: string };
  note: string;
}

const emptyTally = (): PieceFlipTally => ({ total: 0, wonToLost: 0, lostToWon: 0, byStrategy: {} });
const addFlip = (t: PieceFlipTally, from: string, to: string, sid: string) => {
  t.total++;
  if (from === "settled_won" && to === "settled_lost") t.wonToLost++;
  else if (from === "settled_lost" && to === "settled_won") t.lostToWon++;
  t.byStrategy[sid] = (t.byStrategy[sid] ?? 0) + 1;
};

export function auditPieceMigration(db: Database): PieceMigrationAudit {
  // ── A: улики самой миграции.
  const logged = emptyTally();
  const logRows = db.prepare(
    `SELECT strategy_id sid, text FROM trade_log WHERE dedup_key LIKE 'piece_relabel:%'`,
  ).all() as { sid: string; text: string }[];
  for (const r of logRows) {
    const m = /метка куска (settled_[a-z]+)→(settled_[a-z]+)/.exec(r.text ?? "");
    if (m) addFlip(logged, m[1], m[2], r.sid);
  }

  // ── B: реконструкция из знака piece_pnl + КОНТРОЛЬ правила на нетронутых строках.
  const pieces = db.prepare(
    `SELECT id, strategy_id sid, status, piece_pnl, market_labeled
       FROM bets
      WHERE settled_by IN ('early','partial') AND status LIKE 'settled%' AND piece_pnl IS NOT NULL`,
  ).all() as { id: string; sid: string; status: string; piece_pnl: number; market_labeled: number }[];
  const oldLabel = (pnl: number) => (pnl > 0 ? "settled_won" : "settled_lost");
  const reconstructed = emptyTally();
  let checked = 0, agree = 0, indeterminate = 0;
  for (const p of pieces) {
    // РОВНО НОЛЬ — ВНЕ ОБЛАСТИ ОПРЕДЕЛЕНИЯ ПРАВИЛА, А НЕ ЕГО ОШИБКА. Первый прод-замер дал точность
    // 98.1%, и все пять исключений оказались одним и тем же: piece_pnl == 0 при метке won. Знака у нуля
    // нет, значит правило к такой строке НЕ ПРИМЕНИМО — и «почти точное» правило с размытым краем хуже
    // точного с честно очерченной областью: первое приглашает считать погрешность там, где её нет.
    if (p.piece_pnl === 0) { indeterminate++; continue; }
    if (p.market_labeled === 1) {
      // Строка, которую миграция размечала: расхождение со знаком P&L и есть переворот.
      if (p.status !== oldLabel(p.piece_pnl)) addFlip(reconstructed, oldLabel(p.piece_pnl), p.status, p.sid);
    } else {
      // Строка, которой миграция метку НЕ меняла → она обязана всё ещё равняться знаку P&L.
      checked++;
      if (p.status === oldLabel(p.piece_pnl)) agree++;
    }
  }
  const agreePct = checked ? Math.round((1000 * agree) / checked) / 10 : null;

  const same = logged.total === reconstructed.total
    && logged.wonToLost === reconstructed.wonToLost && logged.lostToWon === reconstructed.lostToWon;
  const agreement = {
    same,
    note: same
      ? `два независимых источника сошлись: ${logged.total} переворот(ов), ${logged.wonToLost} won→lost, ${logged.lostToWon} lost→won`
      : `РАСХОЖДЕНИЕ: журнал миграции ${logged.total} (${logged.wonToLost}/${logged.lostToWon}), реконструкция ${reconstructed.total} (${reconstructed.wonToLost}/${reconstructed.lostToWon}). `
        + `Журнал подрезается ретенцией и потому НИЖНЯЯ ГРАНИЦА — превышение реконструкции ожидаемо; обратное (журнал больше) означало бы ошибку правила`,
  };

  // «До» строится по источнику B: он единственный не зависит от ретенции.
  const after = labelDistribution(db);
  const before: LabelDistribution = JSON.parse(JSON.stringify(after));
  const shift = (d: LabelDistribution, sid: string | null, dWon: number, dLost: number) => {
    const t = sid == null ? d : (d.byStrategy[sid] ??= { won: 0, lost: 0, void: 0, winPct: null });
    t.won += dWon; t.lost += dLost;
  };
  for (const [sid, _n] of Object.entries(reconstructed.byStrategy)) void sid;
  // Разворачиваем переворот: won→lost означает, что ДО была won, а сейчас lost.
  for (const p of pieces) {
    if (p.market_labeled !== 1 || p.piece_pnl === 0) continue;   // ноль вне области определения правила
    const was = oldLabel(p.piece_pnl);
    if (p.status === was) continue;
    const dWon = (was === "settled_won" ? 1 : 0) - (p.status === "settled_won" ? 1 : 0);
    const dLost = (was === "settled_lost" ? 1 : 0) - (p.status === "settled_lost" ? 1 : 0);
    shift(before, null, dWon, dLost);
    shift(before, p.sid, dWon, dLost);
  }
  const pct = (w: number, l: number) => (w + l ? Math.round((1000 * w) / (w + l)) / 10 : null);
  before.winPct = pct(before.won, before.lost);
  for (const s of Object.values(before.byStrategy)) s.winPct = pct(s.won, s.lost);
  const deltaWinPp = after.winPct != null && before.winPct != null
    ? Math.round((after.winPct - before.winPct) * 10) / 10 : null;

  // Доверять ли сохранённому снимку: он «до» только если на его момент миграция ещё ничего не размечала.
  let snapAt: string | null = null, trustworthy = false, snapNote = "снимок не найден";
  try {
    const raw = R.metaGet(db, PIECE_RELABEL_BEFORE_KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      snapAt = snap?.at ?? null;
      const snapWin = snap?.labels?.winPct ?? null;
      trustworthy = snapWin != null && before.winPct != null && Math.abs(snapWin - before.winPct) < 0.05;
      snapNote = trustworthy
        ? `снимок (${snapAt}) совпадает с восстановленным «до» — миграция на его момент ещё не размечала, снимку можно верить`
        : `снимок (${snapAt}) даёт win ${snapWin ?? "н/д"}%, восстановленное «до» — ${before.winPct ?? "н/д"}%. `
          + `Значит снимок снят ПОСЛЕ того, как миграция уже переставила метки: ключ фиксирует «до первого прохода ПОСЛЕ ЭТОГО ДЕПЛОЯ», а не «до миграции». Как «до» НЕ ИСПОЛЬЗОВАТЬ`;
    }
  } catch { /* улика не ломает отчёт */ }

  return {
    logged, reconstructed, control: { checked, agree, agreePct }, indeterminate, agreement,
    after, before, deltaWinPp,
    storedSnapshot: { at: snapAt, trustworthy, note: snapNote },
    note: `миграция меток: переворотов ${Math.max(logged.total, reconstructed.total)} `
      + `(журнал ${logged.total}, реконструкция ${reconstructed.total}, точность правила ${agreePct ?? "н/д"}% на ${checked} контрольных`
      + (indeterminate ? `, ${indeterminate} с нулевым piece_pnl вне области определения` : "") + `). `
      + `win-rate ${before.winPct ?? "н/д"}% → ${after.winPct ?? "н/д"}%`
      + (deltaWinPp != null ? ` (${deltaWinPp >= 0 ? "+" : ""}${deltaWinPp} пп)` : "")
      + `. Это РЕКОНСТРУКЦИЯ, а не замер в моменте: «до» не было снято вовремя, и восстановимость не делает его измерением.`,
  };
}
