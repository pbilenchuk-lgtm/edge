// ============================================================
// EDGE LAB — CLV МЕРЯЕТСЯ ПО ЛИНИИ ЗАКРЫТИЯ, А НЕ ПО СОБСТВЕННОЙ ЦЕНЕ ВЫХОДА  [пункт 6, batch-12]
//
// CLV отвечает на один вопрос: обыграли ли мы РЫНОК — двинулась ли линия в нашу сторону после того, как мы
// вошли. Считался он как `bets.closing_price − entry_price`, а `closing_price` — это НЕ линия закрытия:
//   • при досрочном выходе туда пишется НАША ЦЕНА ВЫХОДА (closeBetEarly). Тогда «CLV» = реализованный ход,
//     то есть тот же P&L в центах, только под другим именем: любая фиксация прибыли даёт положительный
//     «CLV» по построению. Две ноги вердикта переставали быть независимыми — одна и та же сделка считалась
//     дважды, как «мы заработали» и как «мы обыграли линию»;
//   • при расчёте по резолюции туда пишется цена РАЗРЕШЕНИЯ (≈100 или ≈0). Тогда «CLV» = исход. Это уже не
//     метрика качества входа вообще, а переименованный win/loss.
//
// Настоящая линия закрытия — последний снимок котировки ДО конца самого матча. Он есть в `markets`
// (снимки пишутся каждый живой тик), и именно оттуда его надо брать. Отсечка — конец МАТЧА, а не момент
// расчёта: после финального свистка цена уезжает к планке разрешения, и снимок «до расчёта» вернул бы тот
// же исход через чёрный ход.
//
// ГДЕ ЛИНИИ НЕТ — ТАМ n/a, И ЭТО ЧЕСТНЫЙ ОТВЕТ, А НЕ ПОВОД ПОДСТАВИТЬ ЧТО-НИБУДЬ ПОХОЖЕЕ. n/a законен
// ровно там, где снимка физически нет в данных (слепые фикстуры без покрытия, старые матчи до плотных
// снимков, протухший последний снимок), и НЕ законен там, где линия есть и просто неудобна.
// ============================================================

import type { Database } from "./db.js";

/** Сколько может пройти между последним снимком и концом матча, чтобы снимок ещё считался линией закрытия. */
export const CLV_MAX_LAG_MIN = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.CLV_CLOSING_MAX_LAG_MIN);
  return Number.isFinite(n) && n > 0 ? n : 90;
};
/** Окно матча от кикоффа, если время окончания не проставлено (90' + перерыв + компенсированное). */
const MATCH_WINDOW_MIN = 135;
/** То же для тенниса: матч из трёх сетов спокойно идёт три часа, футбольное окно обрезало бы линию. */
const TENNIS_WINDOW_MIN = 300;

export type ClvSource = "closing_line" | "no_snapshot" | "stale_snapshot" | "no_match_clock";

export interface ClvLeg {
  clvCents: number | null;
  source: ClvSource;
  closingLineCents: number | null;
  /** Снимок, признанный линией закрытия (ISO) — чтобы решение можно было перепроверить руками. */
  lineAt: string | null;
}

const NA = (source: ClvSource): ClvLeg => ({ clvCents: null, source, closingLineCents: null, lineAt: null });

/**
 * Линия закрытия для (матч, рынок): последний снимок котировки НЕ ПОЗЖЕ конца матча.
 * Отсечка — `end_time`, иначе кикофф + окно матча. Ни того, ни другого нет → часов матча нет → n/a.
 */
export function closingLine(
  db: Database,
  m: { id: string; kickoff_at?: string | null; end_time?: string | null },
  label: string,
  env: Record<string, string | undefined> = process.env,
): { cents: number; at: string } | null {
  const endMs = m.end_time ? Date.parse(m.end_time) : NaN;
  const koMs = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
  const cutoffMs = Number.isFinite(endMs) ? endMs : Number.isFinite(koMs) ? koMs + MATCH_WINDOW_MIN * 60_000 : NaN;
  if (!Number.isFinite(cutoffMs)) return null;
  const row = db.prepare(
    `SELECT price, snapshot_at FROM markets WHERE match_id=? AND label=? AND snapshot_at <= ?
      ORDER BY snapshot_at DESC LIMIT 1`,
  ).get(m.id, label, new Date(cutoffMs).toISOString()) as { price: number; snapshot_at: string } | undefined;
  if (!row || row.price == null) return null;
  const lagMin = (cutoffMs - (Date.parse(row.snapshot_at) || 0)) / 60_000;
  if (!Number.isFinite(lagMin) || lagMin > CLV_MAX_LAG_MIN(env)) return null;   // протух — это не линия закрытия
  return { cents: row.price, at: row.snapshot_at };
}

/** Теннисные позиции по стороне матча котируются НЕ в `markets`, а в `tennis_snapshots` (pm_p1_cents /
 *  pm_p2_cents на скаут-каденции ~20с). Искать их линию только в `markets` — значит объявить n/a там, где
 *  линия физически ЕСТЬ, просто в другой таблице; такой n/a незаконен по нашему же правилу. Сторона берётся
 *  из ЗАКРЕПЛЁННОЙ при входе (`entry_meta.favSide`) — выводить её заново мы уже один раз запретили. Окно
 *  матча шире футбольного: теннисный матч спокойно идёт три часа. */
function tennisClosingLine(
  db: Database,
  m: { id: string; kickoff_at?: string | null; end_time?: string | null },
  b: { entry_meta?: string | null },
  env: Record<string, string | undefined> = process.env,
): { cents: number; at: string } | null {
  let favSide: string | null = null;
  try { favSide = b.entry_meta ? (JSON.parse(b.entry_meta)?.favSide ?? null) : null; } catch { favSide = null; }
  if (favSide !== "first" && favSide !== "second") return null;   // сторона не закреплена → не гадаем
  const endMs = m.end_time ? Date.parse(m.end_time) : NaN;
  const koMs = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
  const cutoffMs = Number.isFinite(endMs) ? endMs : Number.isFinite(koMs) ? koMs + TENNIS_WINDOW_MIN * 60_000 : NaN;
  if (!Number.isFinite(cutoffMs)) return null;
  const col = favSide === "first" ? "pm_p1_cents" : "pm_p2_cents";
  const row = db.prepare(
    `SELECT ${col} AS c, batch_at FROM tennis_snapshots WHERE pm_match_id=? AND ${col} IS NOT NULL AND batch_at <= ?
      ORDER BY batch_at DESC LIMIT 1`,
  ).get(m.id, new Date(cutoffMs).toISOString()) as { c: number; batch_at: string } | undefined;
  if (!row || row.c == null) return null;
  const lagMin = (cutoffMs - (Date.parse(row.batch_at) || 0)) / 60_000;
  if (!Number.isFinite(lagMin) || lagMin > CLV_MAX_LAG_MIN(env)) return null;
  return { cents: row.c, at: row.batch_at };
}

/**
 * Нога CLV одной ставки. Мы всегда держим купленный токен, поэтому вход и линия закрытия — одной стороны,
 * и `линия − вход` работает одинаково для Yes- и No-рынков.
 */
export function clvLeg(
  db: Database,
  m: { id: string; kickoff_at?: string | null; end_time?: string | null },
  b: { market_label: string; entry_price?: number | null; entry_meta?: string | null },
  env: Record<string, string | undefined> = process.env,
): ClvLeg {
  const entry = b.entry_price;
  if (entry == null) return NA("no_snapshot");
  const endMs = m.end_time ? Date.parse(m.end_time) : NaN;
  const koMs = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
  if (!Number.isFinite(endMs) && !Number.isFinite(koMs)) return NA("no_match_clock");
  const line = closingLine(db, m, b.market_label, env) ?? tennisClosingLine(db, m, b, env);
  if (!line) {
    // Отличаем «снимка нет вовсе» от «снимок есть, но протух»: это разные дыры в покрытии и чинятся разным.
    const any = db.prepare(`SELECT 1 FROM markets WHERE match_id=? AND label=? LIMIT 1`).get(m.id, b.market_label);
    return NA(any ? "stale_snapshot" : "no_snapshot");
  }
  return {
    clvCents: Math.round((line.cents - entry) * 10) / 10,
    source: "closing_line", closingLineCents: line.cents, lineAt: line.at,
  };
}

/** Покрытие CLV по когорте: сколько ног посчитано и почему остальные n/a. Без этого «средний CLV» — число
 *  неизвестно по какой доле выборки, а вердикт на нём читать нельзя. */
export interface ClvCoverage { total: number; measured: number; naNoSnapshot: number; naStale: number; naNoClock: number; pctMeasured: number | null }
export function clvCoverage(legs: ClvLeg[]): ClvCoverage {
  const total = legs.length;
  const measured = legs.filter((l) => l.source === "closing_line").length;
  return {
    total, measured,
    naNoSnapshot: legs.filter((l) => l.source === "no_snapshot").length,
    naStale: legs.filter((l) => l.source === "stale_snapshot").length,
    naNoClock: legs.filter((l) => l.source === "no_match_clock").length,
    pctMeasured: total ? Math.round((1000 * measured) / total) / 10 : null,
  };
}
