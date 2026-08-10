// ============================================================
// EDGE LAB — ДОЧИТЫВАНИЕ РЕЗОЛЮЦИИ ПОСЛЕ ФИНАЛА  (Р3, часть 1)
//
// ЧЕМ ЗАСЛУЖЕНО. Замер 09.08: у сыгранного матча (счёт 2:0) рынок `Completed Match` стоял в нашей базе на
// «Yes 50¢ / No 50¢», хотя на бирже он давно `['0','1'], closed:true`. Прочитай мы оракул сегодня — он
// честно ответил бы «не знаю» и был бы бесполезен ровно тогда, когда нужен.
//
// ПРИЧИНА СТРУКТУРНАЯ, А НЕ ЗАБЫВЧИВОСТЬ. `refreshActiveOdds` обновляет НЕзавершённые матчи. Для торговли
// это верно: котировать сыгранное незачем. Для УЛИКИ ровно наоборот — резолюция появляется ТОЛЬКО после
// финала, то есть именно в тот момент, когда обновление выключается. Один и тот же цикл обслуживает два
// вопроса с противоположными сроками, и второй вопрос проигрывал молча.
//
// СЕМЕЙСТВО ДЕФЕКТА. Рядом с «источник живёт короче архива» (144 неразрешённых теневых сигнала, снимки
// съедены пруном) — здесь источник не стёрт, а ЗАМОРОЖЕН раньше факта. В обоих случаях архив ссылается на
// то, что живёт по чужому расписанию.
//
// ПОЧЕМУ ПИШЕМ В ОТДЕЛЬНУЮ ТАБЛИЦУ. Дописать резолюцию в `markets` значило бы тихо поменять смысл
// `latestMarkets` для сыгранных матчей: у всякого потребителя «текущая цена» стала бы «исходом». На этом
// уже обжигались — калибровка по «текущим ценам» сыгранных матчей дала 92% попаданий именно потому, что
// цена И БЫЛА исходом. Торговый снимок и факт резолюции — разные вопросы, и у каждого свой стол.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { defaultResolveTokens, type ResolveTokensFn } from "./pmResolution.js";

/** Сколько матчей дочитывать за один проход: сеть, и жадность здесь ничего не ускоряет. */
export const BACKFILL_MAX_MATCHES = 12;
/** Матч должен «отстояться» — резолюция появляется не в секунду финального свистка. */
export const BACKFILL_MIN_AGE_MIN = 30;

export interface BackfillResult { matches: number; markets: number; resolved: number; skipped: number }

/**
 * Дочитывает резолюцию рынков ЗАВЕРШЁННЫХ матчей. Идемпотентно: UNIQUE(match_id, market_label), повтор
 * ничего не переписывает. Ничего не решает и никого не сеттлит — только КЛАДЁТ ФАКТ на стол.
 */
export async function backfillResolutions(db: Database, deps: EngineDeps = {}): Promise<BackfillResult> {
  const now = deps.now?.() ?? new Date().toISOString();
  const cutoff = new Date(Date.parse(now) - BACKFILL_MIN_AGE_MIN * 60_000).toISOString();
  const out: BackfillResult = { matches: 0, markets: 0, resolved: 0, skipped: 0 };

  let rows: { id: string }[] = [];
  try {
    // Завершённые матчи, у которых ЕЩЁ НЕТ ни одной строки резолюции. `end_time` может быть пуст на
    // старых строках — тогда опираемся на kickoff: лучше дочитать позже, чем не дочитать вовсе.
    rows = db.prepare(
      `SELECT m.id FROM matches m
        WHERE m.state = 'finished'
          AND COALESCE(m.end_time, m.kickoff_at) <= ?
          AND NOT EXISTS (SELECT 1 FROM market_resolutions r WHERE r.match_id = m.id)
        ORDER BY COALESCE(m.end_time, m.kickoff_at) DESC
        LIMIT ?`,
    ).all(cutoff, BACKFILL_MAX_MATCHES) as { id: string }[];
  } catch { return out; }
  if (!rows.length) return out;

  const resolve: ResolveTokensFn = (deps as { resolveTokens?: ResolveTokensFn }).resolveTokens ?? defaultResolveTokens(deps);

  for (const { id: matchId } of rows) {
    let markets: { label: string; token: string }[] = [];
    try {
      markets = R.latestMarkets(db, matchId)
        .filter((m) => m.external_ref)
        .map((m) => ({ label: m.label, token: String(m.external_ref) }));
    } catch { continue; }
    if (!markets.length) { out.skipped++; continue; }
    out.matches++; out.markets += markets.length;

    let res: Record<string, { priceCents: number | null; closed: boolean }> = {};
    try { res = await resolve(markets.map((m) => m.token)); }
    catch { out.skipped++; continue; }   // сеть подвела — не пишем ничего, дочитаем в следующий проход

    for (const m of markets) {
      const r = res[m.token];
      // Токена нет в ответе — это НЕ «не разрешён», это «мы не прочли». Молчим и вернёмся: записать
      // отсутствие как факт значило бы выдать свою слепоту за свойство биржи.
      if (!r) continue;
      try {
        const w = db.prepare(
          `INSERT INTO market_resolutions (id, match_id, market_label, token, price_cents, closed, src, fetched_at)
           VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(match_id, market_label) DO NOTHING`,
        ).run(R.uid(), matchId, m.label, m.token, r.priceCents, r.closed ? 1 : 0, "gamma_token_resolution", now);
        if ((w.changes ?? 0) > 0 && r.closed) out.resolved++;
      } catch { /* улика не имеет права ломать тик */ }
    }
  }
  return out;
}

export interface ResolutionCoverage {
  at: string;
  finishedMatches: number; withAnyResolution: number; coveragePct: number | null;
  resolvedMarkets: number; unresolvedMarkets: number; unreadMarkets: number;
  /** Оракул `Completed Match`: сколько сыгранных матчей его имеют и у скольких он уже РАЗРЕШЁН. */
  oracle: { present: number; resolved: number; note: string };
  note: string;
}

/**
 * Покрытие дочитывания. Отвечает на два РАЗНЫХ вопроса, которые нельзя сливать: «дочитали ли мы» и
 * «разрешён ли рынок». Матч без строк — не «не разрешён», а «не прочитан», и лечится это по-разному.
 */
export function buildResolutionCoverage(db: Database, nowIso: string): ResolutionCoverage {
  const q = <T,>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args as never[]) as T[]; } catch { return []; } };
  const fin = q<{ n: number }>(`SELECT COUNT(*) n FROM matches WHERE state='finished'`)[0]?.n ?? 0;
  const withRes = q<{ n: number }>(`SELECT COUNT(DISTINCT match_id) n FROM market_resolutions`)[0]?.n ?? 0;
  const mk = q<{ closed: number; price_cents: number | null; n: number }>(
    `SELECT closed, price_cents IS NULL AS unread, COUNT(*) n FROM market_resolutions GROUP BY closed, unread`,
  );
  let resolved = 0, unresolved = 0, unread = 0;
  for (const r of mk as unknown as { closed: number; unread: number; n: number }[]) {
    if (r.unread) unread += r.n; else if (r.closed) resolved += r.n; else unresolved += r.n;
  }
  const orc = q<{ n: number; res: number }>(
    `SELECT COUNT(DISTINCT match_id) n, SUM(CASE WHEN closed=1 THEN 1 ELSE 0 END) res
       FROM market_resolutions WHERE market_label LIKE '%Completed Match%'`,
  )[0] ?? { n: 0, res: 0 };
  const coveragePct = fin ? Math.round((withRes / fin) * 1000) / 10 : null;
  return {
    at: nowIso, finishedMatches: fin, withAnyResolution: withRes, coveragePct,
    resolvedMarkets: resolved, unresolvedMarkets: unresolved, unreadMarkets: unread,
    oracle: { present: Number(orc.n) || 0, resolved: Number(orc.res) || 0,
      note: !orc.n ? "оракула Completed Match нет ни у одного дочитанного матча — читать пока нечего"
        : `оракул есть у ${orc.n} матчей, разрешён у ${orc.res}` },
    note: !fin ? "сыгранных матчей нет"
      : `дочитано ${withRes} из ${fin} сыгранных (${coveragePct}%) · рынков: разрешено ${resolved}, ещё открыто ${unresolved}, не прочитано ${unread}`
        + ` · «не прочитано» — НАША слепота, а не свойство биржи, и лечится повтором, а не ожиданием`,
  };
}
