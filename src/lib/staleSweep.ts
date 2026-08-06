// ============================================================
// EDGE LAB — stale/abandoned match sweep  [SERVER-ONLY]
//
// A match that passes kickoff but NEVER goes live (scout never sees the court / ESPN never delivers)
// gets stuck in upcoming/lineup (or a permanent live-no-data) and clutters «Актуальные» for days — the
// 3-day prune is too slow and skips anything with bets/snapshots. This sweep gives such matches a
// terminal state so they leave the active view within a tick:
//   • kickoff passed by > threshold (football 5h, tennis 6h — long enough for 5-setters / rain delays)
//   • no parseable kickoff → age by the last scout sighting, and only touch pure no-bet discovery junk
// Action: any OPEN/proposed bet is VOIDED (P&L 0 — the match didn't complete for us); then the match is
// marked finished. If it had SETTLED bets it actually resolved → just correct the stuck state (no broken
// marker). Otherwise it's flagged BROKEN_NOTE so the UI can bucket it under «Поломанные». Idempotent.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

export const BROKEN_NOTE = "⚠ поломан — провайдер не отдал live-данные";
const ABANDON_HOURS: Record<string, number> = { football: 5, tennis: 6 };

// ── [N1в] СВИП ЧИНИТ СОСТОЯНИЕ МАТЧА, А НЕ СУДЬБУ ДЕНЕГ ─────────────────────────────────────────
// ИМЕННОЙ КЕЙС: UMF Breiðablik — Aqtöbe FK, кикофф 04.08 14:00Z. Через ПЯТЬ часов свип объявил матч
// заброшенным и обнулил все пять ft_blind-ставок — settled_by="void", settled_via ПУСТ. Именно пустой
// провенанс и выдал путь: PM-резолюция пишет свою причину всегда (market_void / no_complement /
// timeout_not_closed) и ждёт 72 часа. Свип обогнал её на 67 часов и забрал решение себе.
//
// Для ft_blind это фатально ПО ПОСТРОЕНИЮ. ft_blind — вход на Polymarket-only фикстуру, у которой счёта
// нет и не будет: она и живёт до РЕЗОЛЮЦИИ РЫНКА. А свип видит ровно ту же картину («кикофф прошёл,
// live-данных нет») и читает её как «матч не состоялся». То есть свип систематически убивал стратегию,
// чьё нормальное состояние выглядит для него поломкой.
//
// ГРАНИЦА. Матч БЕЗ ставок — мусор дискавери, его убирает свип (за этим он и заведён). Матч СО
// ставками — деньги, и здесь авторитет один: PM-резолюция с её таймаутом. До его истечения свип может
// починить СОСТОЯНИЕ матча (чтобы тот ушёл из «Актуальных»), но НЕ трогает открытые ставки.
// Это тот же класс «два авторитета на одно решение», что уже стоил проекту 225 неверно проведённых строк.
const PM_RES_TIMEOUT_H = (() => { const n = Number(process.env.PM_RES_VOID_TIMEOUT_H); return Number.isFinite(n) && n > 0 ? n : 72; })();
const DEFAULT_HOURS = 6;
const NO_KICKOFF_HOURS = 24;
const H = 3_600_000;

interface Row { id: string; competition_id: string; kickoff_at: string | null; state: string }

export function sweepAbandonedMatches(db: Database, nowMs = Date.now()): { abandoned: number; fixed: number; voided: number; deferredBets: number; handedToPm: number } {
  const sportOf = new Map(R.listCompetitions(db).map((c) => [c.id, c.sport_id]));
  const rows = db.prepare(`SELECT id, competition_id, kickoff_at, state FROM matches WHERE state IN ('upcoming','lineup','live')`).all() as Row[];
  const nowIso = new Date(nowMs).toISOString();
  const lastSnapMs = (id: string): number => { const r = db.prepare(`SELECT MAX(batch_at) b FROM tennis_snapshots WHERE pm_match_id=?`).get(id) as { b: string | null } | undefined; const t = r?.b ? Date.parse(r.b) : NaN; return isNaN(t) ? -Infinity : t; };
  let abandoned = 0, fixed = 0, voided = 0, deferredBets = 0, handedToPm = 0;

  for (const m of rows) {
    const sport = sportOf.get(m.competition_id) ?? "";
    const kMs = m.kickoff_at && /^\d{4}-\d\d-\d\dT/.test(m.kickoff_at) ? Date.parse(m.kickoff_at) : NaN;
    const bets = R.betsForMatch(db, m.id);
    let stale = false;
    if (!isNaN(kMs)) {
      stale = nowMs - kMs > (ABANDON_HOURS[sport] ?? DEFAULT_HOURS) * H;
    } else if (bets.length === 0) {
      // No parseable kickoff: only sweep pure discovery junk (no bets), aged by the last scout sighting
      // (never seen → junk; seen recently → still forming, leave it). A no-kickoff match WITH bets is
      // left alone — we won't guess its age.
      const ls = lastSnapMs(m.id);
      stale = ls === -Infinity || nowMs - ls > NO_KICKOFF_HOURS * H;
    }
    if (!stale) continue;

    const hasSettled = bets.some((b) => R.isSettled(b.status));
    // Открытые деньги трогаем ТОЛЬКО после того, как истекло терпение PM-резолюции. До этого её очередь
    // ещё работает, и обнулить ставку значит отобрать у неё исход, который может прийти.
    const pmPatienceOver = !isNaN(kMs) && nowMs - kMs > PM_RES_TIMEOUT_H * H;
    let deferred = 0;
    for (const b of bets) {
      if (b.status !== "open" && b.status !== "proposed") continue;
      if (!pmPatienceOver) { deferred++; continue; }             // очередь резолюции ещё не выдохлась
      R.updateBet(db, b.id, {
        status: "settled_void", result: null, payout: b.stake ?? 0,
        closing_price: b.current_price ?? b.entry_price ?? null,
        // ПРОВЕНАНС ОБЯЗАТЕЛЕН: именно его отсутствие скрывало, каким путём пришёл возврат.
        settled_by: "void", settled_via: "abandoned_sweep", settled_at: nowIso,
      });
      voided++;
    }
    deferredBets += deferred;
    if (deferred) {
      // [ФИКС 06.08] СОСТОЯНИЕ ЧИНИТСЯ ИМЕННО ЗДЕСЬ, А НЕ «ПОТОМ». Прежняя строка делала `continue` —
      // и это был ДЕДЛОК, стоивший живых денег.
      //
      // ИМЕННОЙ КЕЙС: Racing FC Union Lëtzebuerg — Helsingin JK (WCL, кикофф 05.08 17:00Z, фикстура
      // unbound — ESPN/StatPal её не связали НИКОГДА). $125 в трёх профилях на «Under 3.5» висели
      // открытыми спустя 14 часов, матч всё ещё числился `live`.
      //   • свип видел матч, но не переписывал состояние, пока есть открытые деньги;
      //   • `settlePmResolutionBets` берёт в очередь ТОЛЬКО `state === "finished"` без счёта.
      // Каждый ждал другого. Через 72 часа тай-брейк делал свип — воидом, то есть худшим из трёх
      // исходов: рынок-то разрешился чисто, деньги надо было СЧИТАТЬ, а не возвращать.
      //
      // Условие входа в очередь урегулирования производилось теми самыми данными, чьё ОТСУТСТВИЕ и
      // отправляло матч в эту очередь — самозапечатывающийся гейт в чистом виде.
      //
      // Шапка этого модуля всё это время говорила правильно: «свип может починить СОСТОЯНИЕ матча, но
      // НЕ трогает открытые ставки». Реализация делала обратное. Теперь состояние чинится, ставки не
      // трогаются, и матч уходит в PM-резолюцию — к ЕДИНСТВЕННОМУ авторитету на судьбу этих денег,
      // включая её собственный таймаут-воид. BROKEN_NOTE не ставится: матч не «поломан», он наш-слепой
      // и ждёт разрешения рынка; пометка поломки была бы вердиктом, которого свип выносить не вправе.
      R.updateMatch(db, m.id, { state: "finished", final_score: null });
      handedToPm++;
      continue;
    }
    if (hasSettled) { R.updateMatch(db, m.id, { state: "finished" }); fixed++; }        // it resolved — just fix the stuck state
    else { R.updateMatch(db, m.id, { state: "finished", end_note: BROKEN_NOTE, final_score: null }); abandoned++; } // never lived → broken
  }
  return { abandoned, fixed, voided, deferredBets, handedToPm };
}
