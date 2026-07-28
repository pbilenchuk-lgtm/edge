// ============================================================
// EDGE LAB — МАТЧ НЕ МОЖЕТ БЫТЬ СЫГРАН ДО СВОЕГО КИКОФФА  [инвариант + разовая починка данных]
//
// 28 июля торговля встала целиком — ни футбола, ни тенниса. Причина оказалась не в коде, который мы правили,
// а в данных: матчи вторых кругов еврокубковой квалификации (Vardar–Rīga, Dinamo Zagreb–Thun, Celje–Egnatia,
// Sturm Graz–Hearts, Ararat–Shamrock) с кикоффом СЕГОДНЯ в 17:00–19:00 лежали в состоянии `finished` со
// счётом и 90-й минутой — при том что на часах было 13:00 и матчи ещё не начинались.
//
// Счёт был чужой. Привязка к ESPN у всех датирована 22 ИЮЛЯ — днём ПЕРВЫХ матчей этих же пар. Расписание
// импортируется вперёд, поэтому 22 июля запись второго матча уже существовала, имена команд совпали, и
// событие первого круга село на неё: state=finished, счёт первого матча, минута 90.
//
// Двухматчевый гейт (`two_leg_no_datematch` / `date_gap`) это уже не пропустит — но он появился ПОСЛЕ 22
// июля. Он защищает от новой порчи и ничего не делает со старой: `updated_at` этих строк так и стоит на 22-м.
// Матч, который система считает сыгранным, не войдёт в живую фазу, стратега для него не позовут, ставок не
// будет. Никогда. Отсюда и «ничего не происходит» при исправном тике, скауте, книге и балансе.
//
// ПОЧЕМУ ИМЕННО ЭТОТ ИНВАРИАНТ. «Матч завершён раньше собственного кикоффа» не эвристика и не порог, который
// можно подобрать — это логическая невозможность. Поэтому проверка не требует ни калибровки, ни выборки, и
// её нельзя ошибочно применить к здоровой записи. Всё, что она ловит, испорчено по определению.
//
// ЧЕГО ЧИНИЛКА НЕ ДЕЛАЕТ. Она не трогает матч, у которого есть хоть одна РЕШЁННАЯ ставка: расчёт уже
// состоялся, и откат состояния переписал бы книгу задним числом. Такие случаи только перечисляются — решение
// по ним за владельцем. Порча состояния и порча денег лечатся разными руками.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

export interface FutureFinishedRow {
  matchId: string; home: string; away: string; competition: string;
  kickoffAt: string; state: string; minute: number | null;
  scoreHome: number | null; scoreAway: number | null;
  boundEventDate: string | null; boundAt: string | null;
  /** Разрыв между привязанным событием ESPN и собственным кикоффом матча, в днях. */
  legGapDays: number | null;
  settledBets: number; openBets: number;
  action: "сброшен" | "БУДЕТ сброшен" | "пропущен: есть решённые ставки";
}

export interface FutureFinishedReport {
  scanned: number; broken: number; reset: number; skippedWithMoney: number;
  rows: FutureFinishedRow[]; note: string;
}

const DAY = 86_400_000;

/**
 * Найти (и по `apply` — починить) матчи, помеченные сыгранными до собственного кикоффа.
 *
 * Починка возвращает запись в `upcoming` и стирает НАВЕДЁННЫЕ поля (счёт, минуту, финальный счёт, время
 * окончания), после чего снимает привязку к чужому событию ESPN — иначе следующий проход обогащения нашёл бы
 * её на месте и не стал бы искать правильную. Сама пара «матч ↔ рынки» не трогается: рынки Polymarket
 * привязаны к матчу, а не к событию ESPN, и с ними всё в порядке.
 */
export function repairFutureFinished(
  db: Database, opts: { apply?: boolean; nowMs?: number } = {},
): FutureFinishedReport {
  const nowMs = opts.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const res: FutureFinishedReport = { scanned: 0, broken: 0, reset: 0, skippedWithMoney: 0, rows: [], note: "" };

  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      res.scanned++;
      if (!m.kickoff_at) continue;                       // без кикоффа сравнивать не с чем
      const koMs = Date.parse(m.kickoff_at);
      if (!Number.isFinite(koMs) || koMs <= nowMs) continue;
      // Кикофф в будущем. Единственные допустимые состояния — те, где матч ещё не игрался.
      if (m.state !== "finished" && m.state !== "live") continue;
      res.broken++;

      const bets = R.betsForMatch(db, m.id);
      const settled = bets.filter((b) => String(b.status).startsWith("settled")).length;
      const open = bets.filter((b) => b.status === "open").length;
      const live = R.getMatchLive(db, m.id);
      const evMs = live?.espn_event_date ? Date.parse(live.espn_event_date) : NaN;

      const row: FutureFinishedRow = {
        matchId: m.id, home: m.home, away: m.away, competition: c.name,
        kickoffAt: m.kickoff_at, state: m.state, minute: m.minute ?? null,
        scoreHome: m.score_home ?? null, scoreAway: m.score_away ?? null,
        boundEventDate: live?.espn_event_date ?? null, boundAt: live?.updated_at ?? null,
        legGapDays: Number.isFinite(evMs) ? Math.round(((koMs - evMs) / DAY) * 10) / 10 : null,
        settledBets: settled, openBets: open,
        action: settled > 0 ? "пропущен: есть решённые ставки" : opts.apply ? "сброшен" : "БУДЕТ сброшен",
      };
      res.rows.push(row);

      if (settled > 0) { res.skippedWithMoney++; continue; }
      if (!opts.apply) continue;

      try {
        R.updateMatch(db, m.id, {
          state: "upcoming", minute: null, score_home: null, score_away: null,
          final_score: null, end_time: null, clock: null, lineup_out: false,
        } as any);
        // Снять привязку к чужому событию: пока она на месте, следующее обогащение считает матч уже
        // сопоставленным и не ищет верное событие — состояние вернулось бы на следующем же проходе.
        db.prepare(`DELETE FROM match_live WHERE match_id=?`).run(m.id);
        // Наведённые «события матча» (голы первого круга) тоже уходят — иначе инвариант счёт↔события
        // (scoreRace) увидит голы при пустом счёте и заблокирует переоценку уже по своей причине.
        db.prepare(`DELETE FROM match_events WHERE match_id=?`).run(m.id);
        res.reset++;
      } catch { /* одна упрямая строка не должна отменять починку остальных */ }
    }
  }

  res.note = res.broken === 0
    ? `чисто: ни одного матча, помеченного сыгранным до своего кикоффа (просмотрено ${res.scanned}).`
    : `${opts.apply ? "СБРОШЕНО" : "БУДЕТ сброшено (сухой прогон)"}: ${opts.apply ? res.reset : res.broken - res.skippedWithMoney} из ${res.broken} испорченных` +
      (res.skippedWithMoney ? `; ${res.skippedWithMoney} пропущено — там уже есть решённые ставки, откат переписал бы книгу задним числом, это решение владельца.` : ".") +
      ` Такие матчи не входят в живую фазу и не торгуются вообще, поэтому каждый из них — это пропущенный слейт целиком.`;
  return res;
}
