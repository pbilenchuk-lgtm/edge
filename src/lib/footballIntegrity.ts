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
import type { EngineDeps } from "./engine.js";
import type { SportsProvider } from "./sports.js";

// UEFA competitions that run two-leg qualification ties (main league and its _qual sibling both count).
export const UEFA_TWO_LEG = new Set(["uefa.champions", "uefa.europa", "uefa.europa.conf", "uefa.wchampions"]);
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
