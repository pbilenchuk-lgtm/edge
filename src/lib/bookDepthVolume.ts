// ============================================================
// EDGE LAB — ДОСТАТОЧНО ЛИ КНИГИ ДЛЯ ИЗМЕРЕННОЙ ЁМКОСТИ (Часть 2 capacity)
//
// Вопрос Petro: накопился ли `book_depth_snapshots` настолько, чтобы строить ЗАМЕРЕННУЮ кривую ёмкости
// Overreaction — пере-VWAP-ить масштабированные размеры по РЕАЛЬНОЙ книге вместо линейного коэффициента.
//
// ПОЧЕМУ ОДНОГО ЧИСЛА МАЛО. Голое `COUNT(*)` на этот вопрос не отвечает, и это уже стоило нам вердикта:
// 31.07 фильтр исполнимости дал 2 из 143 при 25 418 снимках — снимков было море, а ПЕРЕСЕЧЕНИЕ с
// когортой почти пусто, потому что когорта пишется в одной точке, а глубина снималась в другой.
// Поэтому здесь считается не объём, а ПРИГОДНОСТЬ: сколько снимков лежит на токенах, где Overreaction
// РЕАЛЬНО торговал, и сколько его входов имеют книгу рядом по времени.
//
// КРИТЕРИЙ НАЗВАН ДО ЧИСЛА (иначе это подгон): измеренную кривую строим, когда
//   • ≥ MIN_MATCHED_ENTRIES входов Overreaction имеют книгу в окне ±MATCH_WINDOW_MIN, И
//   • эти входы приходятся на ≥ MIN_MATCHES разных матчей (иначе это один вечер, а не выборка).
// Ретеншн книги — 14 дней (bookDepthCapture.RETENTION_DAYS), поэтому «мало» здесь означает «копим
// дальше», а не «данные потеряны»; но и означает, что окно замера физически не длиннее двух недель.
//
// Модуль ТОЛЬКО читает.
// ============================================================

import type { Database } from "./db.js";

/** Входов Overreaction с книгой рядом — минимум для измеренной кривой. Назван до первого прогона. */
export const MIN_MATCHED_ENTRIES = 30;
/** …и они обязаны прийти минимум из стольких разных матчей: один вечер выборкой не является. */
export const MIN_MATCHES = 8;
/** Насколько близко книга должна стоять к моменту входа, чтобы считаться его книгой. */
export const MATCH_WINDOW_MIN = 12;
/** Стратегия, ради которой задан вопрос о банке. Та же, что VERDICT_STRATEGY в capacityCurve. */
export const CAPACITY_STRATEGY = "overreaction";

export interface VolumeBySource { source: string; rows: number; matches: number; tokens: number }
export interface VolumeByDay { day: string; rows: number; matches: number }

export interface BookDepthVolume {
  at: string;
  /** Три числа из вопроса — ровно они, без пересчёта. */
  rows: number; matches: number; tokens: number;
  oldest: string | null; newest: string | null;
  bySource: VolumeBySource[];
  byDay: VolumeByDay[];
  /** Сколько снимков вообще НЕ имеют уровней (пустая книга) — это факт ёмкости, а не брак. */
  emptyRows: number;
  /** Пригодность под вопрос о банке: пересечение книги с реальными входами Overreaction. */
  overreaction: {
    entries: number; entriesWithBook: number; matchesWithBook: number;
    onFillRows: number;   // снимки источника fill_* — несмещённая выборка момента решения
    note: string;
  };
  criterion: string;
  verdict: "build_measured" | "accumulate" | "no_data";
  note: string;
}

export function buildBookDepthVolume(db: Database, nowIso: string): BookDepthVolume {
  const q = <T,>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args as never[]) as T[]; } catch { return []; } };
  const one = <T,>(sql: string, ...args: unknown[]): T | null => q<T>(sql, ...args)[0] ?? null;

  const tot = one<{ n: number; m: number; t: number; oldest: string | null; newest: string | null }>(
    `SELECT COUNT(*) n, COUNT(DISTINCT match_id) m, COUNT(DISTINCT token_id) t, MIN(at) oldest, MAX(at) newest
       FROM book_depth_snapshots`,
  ) ?? { n: 0, m: 0, t: 0, oldest: null, newest: null };

  const bySource = q<VolumeBySource>(
    `SELECT source, COUNT(*) rows, COUNT(DISTINCT match_id) matches, COUNT(DISTINCT token_id) tokens
       FROM book_depth_snapshots GROUP BY source ORDER BY rows DESC`,
  );
  const byDay = q<VolumeByDay>(
    `SELECT substr(at,1,10) day, COUNT(*) rows, COUNT(DISTINCT match_id) matches
       FROM book_depth_snapshots GROUP BY day ORDER BY day DESC LIMIT 21`,
  );
  // Пустая книга пишется нулевыми уровнями и своим источником; это ФАКТ «налить было нечем», и мешать
  // его с браком захвата нельзя — поэтому считается отдельной строкой, а не вычитается из объёма.
  const emptyRows = one<{ n: number }>(
    `SELECT COUNT(*) n FROM book_depth_snapshots WHERE COALESCE(asks_json,'[]') = '[]' AND COALESCE(bids_json,'[]') = '[]'`,
  )?.n ?? 0;
  const onFillRows = one<{ n: number }>(
    `SELECT COUNT(*) n FROM book_depth_snapshots WHERE source LIKE 'fill\\_%' ESCAPE '\\'`,
  )?.n ?? 0;

  // ПРИГОДНОСТЬ, А НЕ ОБЪЁМ. Вход сопоставляется с книгой по (матч × метка рынка) и времени: именно так
  // его будет читать пере-VWAP. Знаменатель — ВСЕ входы Overreaction, включая те, у которых книги нет.
  const entries = q<{ id: string; match_id: string; market_label: string; created_at: string }>(
    `SELECT id, match_id, market_label, created_at FROM bets
      WHERE strategy_id = ? AND status NOT IN ('proposed','not_filled')`, CAPACITY_STRATEGY,
  );
  const books = q<{ match_id: string; label: string; at: string }>(
    `SELECT match_id, label, at FROM book_depth_snapshots`,
  );
  const byKey = new Map<string, number[]>();
  for (const b of books) {
    const k = `${b.match_id}|${b.label}`;
    const ms = Date.parse(b.at); if (!Number.isFinite(ms)) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    (byKey.get(k) as number[]).push(ms);
  }
  const win = MATCH_WINDOW_MIN * 60_000;
  let entriesWithBook = 0;
  const matchesWithBook = new Set<string>();
  for (const e of entries) {
    const ms = Date.parse(e.created_at); if (!Number.isFinite(ms)) continue;
    const list = byKey.get(`${e.match_id}|${e.market_label}`);
    if (list?.some((t) => Math.abs(t - ms) <= win)) { entriesWithBook++; matchesWithBook.add(e.match_id); }
  }

  const criterion = `измеренную кривую строим при ≥${MIN_MATCHED_ENTRIES} входах ${CAPACITY_STRATEGY} с книгой в окне ±${MATCH_WINDOW_MIN}м И ≥${MIN_MATCHES} разных матчах.`
    + " Пороги названы ДО первого прогона. Голое COUNT(*) критерием не является: 31.07 при 25 418 снимках пересечение с когортой было почти пустым — объём и ПРИГОДНОСТЬ это разные величины.";

  const verdict: BookDepthVolume["verdict"] = !tot.n ? "no_data"
    : entriesWithBook >= MIN_MATCHED_ENTRIES && matchesWithBook.size >= MIN_MATCHES ? "build_measured" : "accumulate";

  const overNote = !entries.length
    ? `у ${CAPACITY_STRATEGY} нет ни одной исполненной ставки — мерить ёмкость нечему (это ОТСУТСТВИЕ ЗАМЕРА, а не «книги не хватает»)`
    : `${entriesWithBook} из ${entries.length} входов ${CAPACITY_STRATEGY} имеют книгу в окне ±${MATCH_WINDOW_MIN}м, на ${matchesWithBook.size} разных матчах`
      + ` · снимков НА ФИЛЛЕ (несмещённая выборка момента решения): ${onFillRows}`
      + (onFillRows === 0 ? " — захват на филле ещё не дал строк: либо не задеплоен, либо входов после деплоя не было" : "");

  const note = !tot.n
    ? "book_depth_snapshots пуст — захват не работает или ретеншн 14 дней уже съел всё; строить нечего"
    : `${tot.n} снимков · ${tot.m} матчей · ${tot.t} токенов · окно ${tot.oldest} … ${tot.newest}`
      + ` · пустых книг ${emptyRows} (это факт ёмкости «налить было нечем», а не брак)`
      + ` · ${overNote}`
      + ` · вердикт: ${verdict === "build_measured" ? "МОЖНО строить измеренную кривую" : "КОПИМ — критерий не выполнен"}`;

  return {
    at: nowIso,
    rows: tot.n, matches: tot.m, tokens: tot.t, oldest: tot.oldest, newest: tot.newest,
    bySource, byDay, emptyRows,
    overreaction: { entries: entries.length, entriesWithBook, matchesWithBook: matchesWithBook.size, onFillRows, note: overNote },
    criterion, verdict, note,
  };
}

export function bookDepthVolumeLine(r: BookDepthVolume): string {
  return `book_depth_volume: ${r.rows} снимков / ${r.matches} матчей / ${r.tokens} токенов`
    + ` · пригодных входов ${r.overreaction.entriesWithBook}/${r.overreaction.entries} на ${r.overreaction.matchesWithBook} матчах`
    + ` · на филле ${r.overreaction.onFillRows}`
    + ` · ${r.verdict === "build_measured" ? "МОЖНО СТРОИТЬ" : r.verdict === "no_data" ? "ДАННЫХ НЕТ" : "копим"}`;
}
