// ============================================================
// EDGE LAB — СТАНДАРТ СТРОКИ  [O5 из ТЗ наблюдаемости]
//
// Строка события состоит из ДВУХ частей, и это разделение — весь смысл:
//   • МАШИНОЧИТАЕМЫЙ ПРЕФИКС — точка решения, вердикт, код причины, config_hash. По нему grep-ается и
//     считается статистика, не разбирая прозу. Каждый наш сторож, построенный против прозы, уже подводил:
//     ratifiedWatch искал улику не в той таблице, воронка читает причины регулярками. Префикс убирает
//     необходимость угадывать.
//   • ЧЕЛОВЕЧЕСКИЙ ХВОСТ — то, что читает владелец в 2 часа ночи. Без него префикс мёртв: код `below_edge`
//     не объясняет, ПОЧЕМУ решение верное.
//
// ПРИЧИНЫ — ИЗ СЛОВАРЯ, А НЕ FREE-TEXT. Свободная строка утекает в `other`, а `other` — немой ноль по
// построению: он растёт, ничего не утверждая. Новая причина = явное добавление в словарь (тот же приём,
// что в unfillableEdge и entryFunnel).
//
// СТАРЫЕ СТРОКИ МАССОВО НЕ ПЕРЕПИСЫВАЮТСЯ — по прямому указанию ТЗ, только по мере касания. Здесь
// инструмент; применение — там, где код и так меняется.
// ============================================================

/** Точка решения: где именно система решала. Список расширяется явным добавлением. */
export type DecisionPoint =
  | "entry_gate" | "exit_gate" | "settle" | "quarantine" | "migration" | "job" | "scout" | "board";

/** Вердикт точки — не «что случилось», а КАК это классифицируется. */
export type DecisionVerdict = "pass" | "skip" | "block" | "flag" | "repair" | "noop";

export interface LinePrefix {
  point: DecisionPoint;
  verdict: DecisionVerdict;
  /** Код причины ИЗ СЛОВАРЯ вызывающей стороны (entryFunnel.REJECT_REASONS, unfillableEdge и т.д.). */
  reason?: string;
  /** Эпоха порогов на момент решения — чтобы строку можно было отнести к конфигу без археологии. */
  configHash?: string | null;
  /** Числа, которые захочется просуммировать: n, usd, cents… */
  n?: number;
}

/**
 * Собрать строку стандарта. Формат префикса стабилен и парсится одной регуляркой:
 *   `[point/verdict reason=CODE cfg=HASH n=N] человеческий хвост`
 * Отсутствующие поля просто не печатаются — пустой `reason=` был бы тем же немым нулём.
 */
export function logLine(p: LinePrefix, human: string): string {
  const bits = [`${p.point}/${p.verdict}`];
  if (p.reason) bits.push(`reason=${p.reason}`);
  if (p.configHash) bits.push(`cfg=${p.configHash}`);
  if (p.n != null && Number.isFinite(p.n)) bits.push(`n=${p.n}`);
  return `[${bits.join(" ")}] ${human}`;
}

export interface ParsedLine { point: string; verdict: string; reason: string | null; configHash: string | null; n: number | null; human: string }

/** Разбор строки стандарта. Нужен и тестам, и будущим отчётам: если префикс нельзя разобрать
 *  механически, он не машиночитаем, и весь смысл O5 теряется. */
export function parseLogLine(line: string): ParsedLine | null {
  const m = /^\[([a-z_]+)\/([a-z]+)((?: [a-z]+=[^\]\s]+)*)\]\s?([\s\S]*)$/.exec(line);
  if (!m) return null;
  const kv = new Map<string, string>();
  for (const part of m[3].trim().split(/\s+/).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) kv.set(part.slice(0, i), part.slice(i + 1));
  }
  const nRaw = kv.get("n");
  return {
    point: m[1], verdict: m[2],
    reason: kv.get("reason") ?? null,
    configHash: kv.get("cfg") ?? null,
    n: nRaw != null && Number.isFinite(Number(nRaw)) ? Number(nRaw) : null,
    human: m[4],
  };
}

/** Проверка дисциплины словаря: код причины обязан быть ИЗ переданного набора. Возвращает список
 *  нарушителей, а не бросает — цель не остановить работу, а не дать причине утечь в free-text. */
export function reasonsOutsideDictionary(lines: string[], dictionary: Iterable<string>): string[] {
  const known = new Set(dictionary);
  const out: string[] = [];
  for (const l of lines) {
    const p = parseLogLine(l);
    if (p?.reason && !known.has(p.reason)) out.push(p.reason);
  }
  return [...new Set(out)];
}
