// ============================================================
// EDGE LAB — FOOTBALL FIXTURE INTEGRITY  [SERVER-ONLY]  (P0.1)
//
// Two-leg qualification ties play the SAME two teams twice, a week apart. enrichFromEspn bound events by
// team names alone (the date — the real identity key — was discarded), so a record could settle on the
// OTHER leg's result. The date gate (engine.ts) stops this going forward; this module protects the
// history:
//   1. markUefaSettleSuspect — CONSERVATIVE quarantine NOW: tag every settled bet on a UEFA two-leg
//      competition `settle_suspect` (no network). Verdict cuts (e5 / pmv_origin_cut / profile analytics)
//      drop suspect rows — «валидная метрика в валидной эпохе»: throw the dirty out immediately, refine later.
//   2. backfillEspnEventDates — refine BACKWARD: re-fetch each bound event's ISO date by espn_event_id and
//      freeze it; then recompute suspect by the SAME ±1-day gate — a proven-clean match (|Δkickoff| ≤ 1d)
//      has its mark cleared. One ESPN pass feeds both the date backfill and the suspect re-decision.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { FOOTBALL_EPOCH } from "./repo.js";
import { epochNum, crossEpoch } from "./codeEpoch.js";
import type { EngineDeps } from "./engine.js";
import type { SportsProvider } from "./sports.js";

// Competitions that run TWO-LEG ties (main league and its _qual sibling both count) — the same two teams
// play twice a week apart, so a settle can bind the OTHER leg's result. F2 expands this beyond UEFA to
// CONMEBOL (Libertadores/Sudamericana knockouts are two-legged) and other two-leg cups.
export const UEFA_TWO_LEG = new Set([
  "uefa.champions", "uefa.europa", "uefa.europa.conf", "uefa.wchampions",
  "conmebol.libertadores", "conmebol.sudamericana", "conmebol.recopa",
]);
const qualBase = (lg: string | null | undefined) => String(lg ?? "").replace(/_qual$/i, "");
const LEG_GAP_MS = (env: Record<string, string | undefined>) => Math.max(1, Number(env.FOOTBALL_LEG_GAP_HOURS ?? 30)) * 3_600_000;

/** Match ids in UEFA two-leg competitions (main or _qual). */
function uefaMatchIds(db: Database): string[] {
  const comps = R.listCompetitions(db).filter((c) => UEFA_TWO_LEG.has(qualBase(c.external_league)));
  return comps.flatMap((c) => R.listMatches(db, c.id).map((m) => m.id));
}

/** Conservative P0.1 quarantine: tag every SETTLED bet on a UEFA two-leg match `settle_suspect`. Immediate,
 *  no network — protects the verdict cuts before the precise date backfill runs. Idempotent. */
export function markUefaSettleSuspect(db: Database): number {
  const ids = uefaMatchIds(db);
  if (!ids.length) return 0;
  const ph = ids.map(() => "?").join(",");
  const r = db.prepare(`UPDATE bets SET settle_suspect=1 WHERE settle_suspect=0 AND status LIKE 'settled%' AND match_id IN (${ph})`).run(...ids);
  return Number(r.changes ?? 0);
}

export interface LegGapSuspectRow { matchId: string; match: string; competition: string; kickoffAt: string | null; eventDate: string | null; gapDays: number; betsTagged: number }
export interface LegGapSuspectResult { scanned: number; mismatched: number; betsTagged: number; rows: LegGapSuspectRow[] }

/**
 * ПОДОЗРЕНИЕ ПО ФАКТУ РАЗРЫВА, а не по названию турнира и не в момент расчёта.
 *
 * Две независимые дыры сошлись на Seattle Sounders–Portland Timbers: разрыв привязки 16 дней — самый грубый
 * из всех найденных — и `settle_suspect=0`.
 *
 *   1. ПО СПИСКУ. `markUefaSettleSuspect` метит матчи из перечня двухматчевых турниров (UEFA + CONMEBOL).
 *      Seattle–Portland — это MLS, в перечень не входит, значит не метится НИКОГДА, какой бы разрыв ни был.
 *      Перечень отвечает на вопрос «бывают ли здесь два круга», а метить надо по «эта запись привязана к
 *      чужому событию» — свойству строки, а не лиги.
 *   2. В МОМЕНТ РАСЧЁТА. Уточняющая маркировка живёт в сеттл-пути (`backfillEspnEventDates`, пере-сеттл в
 *      engine). Позиция, закрытая ДОСРОЧНО (early/partial), до расчёта по счёту не доходит вовсе — и метка
 *      её не догоняет. Все девять сиэтловских ставок закрыты именно так.
 *
 * Поэтому здесь: проход по ВСЕМ привязанным матчам любого спорта и турнира, сравнение замороженной даты
 * события с кикоффом, и пометка ВСЕХ ставок матча — независимо от того, каким путём они закрылись и
 * закрылись ли вообще. Деньги это не меняет (досрочный выход считает P&L по цене продажи, а не по счёту) —
 * меняет честность агрегатов: вердиктные срезы выбрасывают suspect-строки, и решение по стратегии не должно
 * опираться на сделки, принятые по чужому матчу.
 */
export function markLegGapSuspect(
  db: Database, env: Record<string, string | undefined> = process.env, opts: { apply?: boolean } = { apply: true },
): LegGapSuspectResult {
  const gap = LEG_GAP_MS(env);
  const res: LegGapSuspectResult = { scanned: 0, mismatched: 0, betsTagged: 0, rows: [] };
  const rows = db.prepare(
    `SELECT ml.match_id mid, ml.espn_event_date ed FROM match_live ml WHERE ml.espn_event_date IS NOT NULL AND ml.espn_event_date <> ''`,
  ).all() as { mid: string; ed: string }[];
  const compById = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  for (const r of rows) {
    res.scanned++;
    const m = R.getMatch(db, r.mid);
    if (!m?.kickoff_at) continue;
    const koMs = Date.parse(m.kickoff_at), evMs = Date.parse(r.ed);
    if (!Number.isFinite(koMs) || !Number.isFinite(evMs)) continue;
    const diff = Math.abs(evMs - koMs);
    if (diff <= gap) continue;                       // привязка в пределах допуска — запись честная
    res.mismatched++;
    // Все ставки матча, а не только settled: открытая позиция на чужой привязке — та же ложная посылка,
    // просто ещё не реализованная.
    const upd = opts.apply
      ? Number(db.prepare(`UPDATE bets SET settle_suspect=1 WHERE match_id=? AND settle_suspect=0`).run(r.mid).changes ?? 0)
      : Number((db.prepare(`SELECT COUNT(*) n FROM bets WHERE match_id=? AND settle_suspect=0`).get(r.mid) as { n: number }).n);
    res.betsTagged += upd;
    res.rows.push({
      matchId: r.mid, match: `${m.home} — ${m.away}`, competition: compById.get(m.competition_id)?.name ?? m.competition_id,
      kickoffAt: m.kickoff_at, eventDate: r.ed, gapDays: Math.round((diff / 86_400_000) * 10) / 10, betsTagged: upd,
    });
  }
  res.rows.sort((a, b) => b.gapDays - a.gapDays);
  return res;
}

export interface SvEspnDateProvider { eventDate(sport: string, league: string, eventId: string): Promise<string | null> }

/** Refine backward: for each bound match in a UEFA comp with no frozen date, re-fetch the ESPN event's ISO
 *  date and freeze it (a stable historical field — the re-fetch is logged with its source + fetch time).
 *  Then recompute settle_suspect by the same ±1-day gate: a proven-clean match clears its mark. Returns the
 *  counts. Bounded per call. Provider must expose eventDate (ESPN summary carries the header date). */
export async function backfillEspnEventDates(
  db: Database, provider: SportsProvider & Partial<SvEspnDateProvider>, deps: EngineDeps = {}, max = 40,
): Promise<{ dated: number; cleared: number; stillSuspect: number }> {
  const now = deps.now?.() ?? new Date().toISOString();
  const env = deps.env ?? process.env;
  if (!provider.eventDate) return { dated: 0, cleared: 0, stillSuspect: 0 };
  const compById = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  const rows = db.prepare(
    `SELECT ml.match_id mid, ml.espn_event_id eid, ml.league lg FROM match_live ml
     WHERE ml.espn_event_id IS NOT NULL AND (ml.espn_event_date IS NULL OR ml.espn_event_date='') LIMIT ?`,
  ).all(max) as { mid: string; eid: string; lg: string | null }[];
  let dated = 0, cleared = 0, stillSuspect = 0;
  for (const row of rows) {
    const m = R.getMatch(db, row.mid); const comp = m ? compById.get(m.competition_id) : null;
    if (!m || !comp) continue;
    let date: string | null = null;
    try { date = await provider.eventDate(comp.sport_id, row.lg ?? String(comp.external_league ?? ""), row.eid); } catch { date = null; }
    if (!date) continue;
    R.upsertMatchLive(db, { match_id: row.mid, espn_event_id: row.eid, league: row.lg ?? null, espn_event_date: date, home_lineup: null, away_lineup: null, stats: null, updated_at: now });
    console.log(`[fixtureBackfill] espn_event_date «${m.home}–${m.away}» = ${date} (event ${row.eid}, fetched ${now})`);
    dated++;
    // Re-decide suspect by the same gate: proven clean (|Δ| ≤ gap) clears; otherwise it stays quarantined.
    const koMs = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN, evMs = Date.parse(date);
    const clean = Number.isFinite(koMs) && Number.isFinite(evMs) && Math.abs(evMs - koMs) <= LEG_GAP_MS(env);
    if (clean) { const r = db.prepare(`UPDATE bets SET settle_suspect=0 WHERE match_id=? AND settle_suspect=1`).run(row.mid); cleared += Number(r.changes ?? 0); }
    else stillSuspect++;
  }
  return { dated, cleared, stillSuspect };
}

/** Count of currently-quarantined settled bets (for the ops report). */
export function settleSuspectCount(db: Database): number {
  return Number((db.prepare(`SELECT COUNT(*) n FROM bets WHERE settle_suspect=1`).get() as { n: number }).n);
}

const FOOTBALL_STRATS = ["prematch_value", "overreaction", "live_xg"];

/** P0.5: tag pre-fix football bets (no epoch) `epoch_unknown` so they drop out of verdict cuts — the clean
 *  era starts after the P0.1-P0.3 fixes and old rows are contaminated (leg-mismatch / exception branch).
 *  New bets stamp FOOTBALL_EPOCH in insertBet. Idempotent (only football_epoch IS NULL rows). */
export function migrateFootballEpochUnknown(db: Database): number {
  const ph = FOOTBALL_STRATS.map(() => "?").join(",");
  const r = db.prepare(`UPDATE bets SET football_epoch='epoch_unknown' WHERE football_epoch IS NULL AND strategy_id IN (${ph})`).run(...FOOTBALL_STRATS);
  return Number(r.changes ?? 0);
}

export interface EpochBackfillResult { scanned: number; recovered: number; stillUnknown: number; reasons: Record<string, number> }
/**
 * Petro-ratified: DETERMINISTIC epoch backfill. The blanket migrate above tagged EVERY null-epoch football
 * bet `epoch_unknown`, but a bet's own `code_version` already records which code-epoch it was placed in —
 * so a row placed in the CLEAN era (e5+) that was tagged unknown only because football_epoch stamping
 * postdated it is legally recoverable, no new match needed (56% of history was invisible). Recover a row iff
 * it uses the SAME clean predicate the e5-gate uses — entry epoch ≥ floor AND not cross-epoch (life didn't
 * span a deploy). Anything ambiguous (entry < floor, no/legacy code_version, or cross-epoch) STAYS unknown —
 * conservatism is NOT relaxed. Idempotent; reads only existing fields.
 */
export function backfillFootballEpoch(db: Database, cleanEpochMin = 5): EpochBackfillResult {
  const ph = FOOTBALL_STRATS.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, code_version, exit_code_version FROM bets WHERE football_epoch='epoch_unknown' AND strategy_id IN (${ph})`).all(...FOOTBALL_STRATS) as { id: string; code_version: string | null; exit_code_version: string | null }[];
  const upd = db.prepare(`UPDATE bets SET football_epoch=? WHERE id=?`);
  const reasons: Record<string, number> = { entry_pre_clean_or_unlabelled: 0, cross_epoch: 0 };
  let recovered = 0;
  for (const b of rows) {
    if (epochNum(b.code_version) < cleanEpochMin) { reasons.entry_pre_clean_or_unlabelled++; continue; }
    if (crossEpoch(b)) { reasons.cross_epoch++; continue; } // entry & exit epochs differ → two rule-sets → ambiguous
    upd.run(FOOTBALL_EPOCH, b.id); recovered++;
  }
  return { scanned: rows.length, recovered, stillUnknown: rows.length - recovered, reasons };
}
