// ============================================================
// EDGE LAB — N4: «ПРЕДМАТЧ» — ЭТО ДВЕ РАЗНЫЕ ПОПУЛЯЦИИ, И ОДИН WIN-RATE ИХ СКЛАДЫВАЛ
//
// ИМЕННОЙ КЕЙС: Celtic FC — Dundee FC, 03.08. Кикофф 18:30:00Z, base-анализ 18:31:06Z, стратег 18:32:10Z,
// вход 18:32:56Z. Весь «предматчевый» конвейер отработал ЧЕРЕЗ 66 СЕКУНД ПОСЛЕ КИКОФФА — и вошёл по
// котировке РОВНО 50.0¢ с нулевым слиппеджем, при том что соседние рынки того же матча висели в карантине
// `stale_book` («книга не менялась 550 минут при живом матче»). К 25' рынок сам приехал на 67.8¢, к 90' —
// на 99.9¢.
//
// То есть прибыль там — не эдж модели против размеченного рынка, а ОПОЗДАНИЕ РЫНКА К РАЗМЕТКЕ, пойманное
// нашим собственным опозданием. Это работает, пока сторона угадана; в другую сторону тот же дизайн даёт
// вход по 50¢ в рынок, который стоит 10¢. Складывать такие входы с настоящим предматчем в один win-rate
// значит мерить среднюю температуру двух разных болезней.
//
// ДВЕ МЕТКИ, ДВА РАЗНЫХ ФАКТА — и они НЕ синонимы:
//   • `catchUp`      — решение принято ПОСЛЕ кикоффа (опоздал КОНВЕЙЕР). Матч могли поймать поздно и при
//                      живой размеченной книге — тогда это просто поздний вход.
//   • `unmarkedBook` — цена входа стоит в плейсхолдер-полосе вокруг 50¢ (опоздал РЫНОК). Такое бывает и
//                      задолго до кикоффа, если книгу ещё никто не трогал.
// Пересечение этих двух — Celtic — самый дорогой случай: обе стороны опоздали одновременно.
//
// ЧЕГО ЗДЕСЬ НЕТ. Нет запрета на catch-up-вход: терять поздно обнаруженную фикстуру мы не хотим, и ТЗ это
// прямо оговаривает. Есть ЧЕСТНАЯ ПОМЕТКА и половинный размер до созревания собственной когорты — тот же
// паттерн, которым уже ограничен ft_blind (риск-класс, чей вердикт ещё не измерен, ходит половиной).
// ============================================================

/** Полоса вокруг 50¢, внутри которой цена считается неторгованным дефолтом, а не котировкой.
 *  Тот же порог, что у плейсхолдер-фильтра PMV — один авторитет на одно определение «книга не размечена». */
export const UNMARKED_BOOK_BAND_CENTS = (() => {
  const n = Number(process.env.TENNIS_PMV_PLACEHOLDER_BAND);
  return Number.isFinite(n) && n > 0 ? n : 0.5;
})();

/** Доля размера для catch-up-входа до созревания его собственной когорты. Паттерн ft_blind. */
export const CATCH_UP_CAP_FRAC = (() => {
  const n = Number(process.env.CATCH_UP_CAP_FRAC);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5;
})();

export interface PopulationTags { catchUp: boolean; unmarkedBook: boolean }

/**
 * Решение принято после кикоффа? `null`-кикофф — НЕ повод объявить catch-up: неизвестное время старта
 * это отсутствие факта, а не факт опоздания (и метка, поставленная на незнании, отравила бы когорту).
 */
export function isCatchUp(kickoffAt: string | null | undefined, decidedAt: string): boolean {
  const k = Date.parse(kickoffAt ?? "");
  const d = Date.parse(decidedAt);
  if (!Number.isFinite(k) || !Number.isFinite(d)) return false;
  return d > k;
}

/** Цена входа стоит в плейсхолдер-полосе — книга на момент входа не размечена. */
export function isUnmarkedBook(entryCents: number | null | undefined): boolean {
  return entryCents != null && Math.abs(entryCents - 50) <= UNMARKED_BOOK_BAND_CENTS;
}

export function populationTags(o: { kickoffAt: string | null | undefined; decidedAt: string; entryCents: number | null | undefined }): PopulationTags {
  return { catchUp: isCatchUp(o.kickoffAt, o.decidedAt), unmarkedBook: isUnmarkedBook(o.entryCents) };
}

/** Имя популяции для разрезов. Пересечение НАЗВАНО отдельно — это самый дорогой случай, а не сумма двух. */
export type PopulationName = "предматч" | "catch_up" | "неразмеченная книга" | "catch_up + неразмеченная";
export function populationOf(t: PopulationTags): PopulationName {
  if (t.catchUp && t.unmarkedBook) return "catch_up + неразмеченная";
  if (t.catchUp) return "catch_up";
  if (t.unmarkedBook) return "неразмеченная книга";
  return "предматч";
}

/** Золотая ячейка — СТРОГО настоящий предматч: ни опоздания конвейера, ни неразмеченной книги. */
export function isGoldenPopulation(t: PopulationTags): boolean {
  return !t.catchUp && !t.unmarkedBook;
}
