// ============================================================
// EDGE LAB — ТЕРМИНАЛЬНЫЙ СНИМОК КНИГИ: СОСТОЯНИЕ РЫНКА СНИМАЕТСЯ СОБЫТИЕМ, А НЕ РАСПИСАНИЕМ
//
// ПРАВИЛО КЛАССА, РАТИФИЦИРОВАННОЕ 05.08 (см. O12 в docs/observability-silent-failures.md):
//   ВЕРДИКТ-РЕЛЕВАНТНОЕ СОСТОЯНИЕ РЫНКА СНИМАЕТСЯ В МОМЕНТ ВЕРДИКТ-РЕЛЕВАНТНОГО СОБЫТИЯ, НЕ ПО ТИКУ.
// Это третий экземпляр одного класса: глубина при записи would-be сигнала (bookDepthCapture),
// счёт в карточку при финише (tennisTrading), теперь — книга в момент терминального статуса.
//
// ЧЕМ ЗАСЛУЖЕНО. Замер T3 от 05.08: 63 из 73 нерешённых гандикапов имели цену старше 30 минут на момент
// конца матча, МЕДИАНА ОТСТАВАНИЯ 121 МИНУТА. Причина структурная, а не случайная:
//   • `markets` обновляет ТОЛЬКО `refreshActiveOdds`, и он идёт ПЕРВЫМ шагом тика, а терминальный статус
//     скаут узнаёт девятым — цена в тике записывается РАНЬШЕ, чем становится известен исход;
//   • со следующего тика `finishTennisMatches` ставит матчу `finished`, а `refreshActiveOdds` такие
//     пропускает по построению — значит терминальный момент это ПОСЛЕДНИЙ шанс снять цену, и он не
//     использовался вовсе.
// Журнал ±1.5 после O11-фикса честно отказывает таким наблюдениям — и потому тест почти не набирается.
//
// ПОЧЕМУ НЕ ПОЗВАТЬ refreshMatchOdds. У него есть RAIL-ФИЛЬТР: цена ≤ RESOLVED_RAIL или ≥ 100−RESOLVED_RAIL
// не пишется вовсе. У разрешившегося матча книга стоит ровно на планке — то есть штатный путь по
// построению не может записать именно ту цену, ради которой мы приходим. Фильтр правильный: он защищает
// ТОРГОВЫЙ путь от цены разрешения. Поэтому терминальный снимок идёт в `book_depth_snapshots` (там планки
// нет) и торгового пути не касается ни одним полем.
//
// ИДЕМПОТЕНТНОСТЬ БЕЗ МАРКЕРА: повтор определяется наличием строки с тем же source по этому матчу —
// маркер был бы вторым состоянием на тот же факт и мог бы разойтись с самой записью.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { captureShadowDepth, type BookTarget } from "./bookDepthCapture.js";

export const TERMINAL_BOOK_SOURCE = "tennis_terminal";

/** Снят ли уже терминальный снимок по этому матчу. Читается из САМОЙ записи, не из маркера. */
export function terminalBookTaken(db: Database, matchId: string): boolean {
  try {
    const r = db.prepare(
      `SELECT COUNT(*) n FROM book_depth_snapshots WHERE match_id=? AND source LIKE ?`,
    ).get(matchId, `${TERMINAL_BOOK_SOURCE}%`) as { n?: number } | undefined;
    return (r?.n ?? 0) > 0;
  } catch { return false; }
}

/**
 * Снять книгу по ВСЕМ рынкам матча с токеном В МОМЕНТ ТЕРМИНАЛЬНОГО СТАТУСА.
 *
 * Манилайн НЕ исключается, хотя скаут и кладёт его цену в свою же строку каждые ~20с: у той колонки два
 * разных происхождения — живой мидпойнт для рынков в скоупе и СОХРАНЁННЫЙ дискавери-манилайн для
 * вне-скоупных тиров, записанный под временем текущей строки. Предматчевая цена выглядела бы синхронной
 * со счётом, и различить их из строки нечем. Один механизм с собственным временем съёма лучше двух, из
 * которых один не может доказать свою свежесть.
 *
 * Возвращает число снятых рынков. Ноль печатается наравне с двадцатью: «нечего снимать» и «снять не
 * удалось» — разные факты, и второй обязан быть виден (tally уходит в app_meta через captureShadowDepth).
 */
export async function captureTerminalBook(
  db: Database, matchId: string, deps: EngineDeps = {}, nowIso?: string,
): Promise<number> {
  if (terminalBookTaken(db, matchId)) return 0;                    // уже снят — повтор не нужен
  const targets: BookTarget[] = R.latestMarkets(db, matchId)
    .filter((mk) => mk.external_ref)
    .map((mk) => ({ matchId, token: mk.external_ref as string, label: mk.label }));
  if (!targets.length) return 0;
  try {
    const t = await captureShadowDepth(db, targets, TERMINAL_BOOK_SOURCE, deps, nowIso);
    return t.saved;
  } catch { return 0; }                                            // измерение не роняет торговый путь
}

/** Цена терминального снимка для рынка: mid по лучшим bid/ask. null — снимка нет (это НЕ «нет цены»). */
export function terminalBookMid(db: Database, matchId: string, label: string): { cents: number; at: string } | null {
  try {
    const r = db.prepare(
      `SELECT best_bid_cents b, best_ask_cents a, at FROM book_depth_snapshots
        WHERE match_id=? AND label=? AND source LIKE ? ORDER BY at DESC LIMIT 1`,
    ).get(matchId, label, `${TERMINAL_BOOK_SOURCE}%`) as { b: number | null; a: number | null; at: string } | undefined;
    if (!r) return null;
    // Пустая книга (source …_empty) даёт обе стороны null — это отсутствие котировки, а не ноль центов.
    if (r.b == null && r.a == null) return null;
    const cents = r.b != null && r.a != null ? Math.round(((r.b + r.a) / 2) * 10) / 10 : (r.b ?? r.a as number);
    return { cents, at: r.at };
  } catch { return null; }
}
