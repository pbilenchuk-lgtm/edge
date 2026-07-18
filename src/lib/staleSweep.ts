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
const DEFAULT_HOURS = 6;
const NO_KICKOFF_HOURS = 24;
const H = 3_600_000;

interface Row { id: string; competition_id: string; kickoff_at: string | null; state: string }

export function sweepAbandonedMatches(db: Database, nowMs = Date.now()): { abandoned: number; fixed: number; voided: number } {
  const sportOf = new Map(R.listCompetitions(db).map((c) => [c.id, c.sport_id]));
  const rows = db.prepare(`SELECT id, competition_id, kickoff_at, state FROM matches WHERE state IN ('upcoming','lineup','live')`).all() as Row[];
  const nowIso = new Date(nowMs).toISOString();
  const lastSnapMs = (id: string): number => { const r = db.prepare(`SELECT MAX(batch_at) b FROM tennis_snapshots WHERE pm_match_id=?`).get(id) as { b: string | null } | undefined; const t = r?.b ? Date.parse(r.b) : NaN; return isNaN(t) ? -Infinity : t; };
  let abandoned = 0, fixed = 0, voided = 0;

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
    for (const b of bets) {
      if (b.status === "open" || b.status === "proposed") {
        R.updateBet(db, b.id, { status: "settled_void", result: null, payout: b.stake ?? 0, closing_price: b.current_price ?? b.entry_price ?? null, settled_by: "void", settled_at: nowIso });
        voided++;
      }
    }
    if (hasSettled) { R.updateMatch(db, m.id, { state: "finished" }); fixed++; }        // it resolved — just fix the stuck state
    else { R.updateMatch(db, m.id, { state: "finished", end_note: BROKEN_NOTE, final_score: null }); abandoned++; } // never lived → broken
  }
  return { abandoned, fixed, voided };
}
