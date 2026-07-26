// ============================================================
// EDGE LAB — SCORE↔EVENT CONSISTENCY  [G1/G2, batch-11 ТЗ]
//
// The most expensive live bug found so far. Brann–Vålerenga, in order:
//   40'  price stop on Under 3.5 suppressed — «до линии ещё 2.5 гол(ов) при счёте 0:1»
//   41'  GOAL → 0:2
//   42'  reassessment fires ON THAT GOAL, and the strategist is handed «При 0:1 и 42'»
//        → reasons that two more goals are still needed, holds
//   45'+5' exits at 9.9¢ from a 51.2¢ entry — −$263 across four profiles
//
// The mechanism is in enrichFromEspn: the match SCORE is written from the scoreboard response, and only
// afterwards is matchDetail() fetched — a second HTTP call whose `events` list is therefore NEWER than the
// score that was just committed. A goal event can thus trigger a reassessment while the stored score still
// predates it. The trigger and the snapshot disagree, and the strategist is never told.
//
// The invariant here is deliberately the crudest one that cannot be argued with: the number of GOAL events
// recorded for a match can never exceed the goals on the scoreboard. When it does, the snapshot is behind its
// own event feed, full stop — no timestamp arithmetic, no provider-specific assumptions.
//
// TWO CONSUMERS, OPPOSITE FAIL DIRECTIONS — this is the whole design, not an implementation detail:
//   • strategistReassess (G1) — a call on a stale snapshot produces a REASONED WRONG DECISION, which is worse
//     than no decision at all. So it waits.
//   • the under_thesis_safe stop suppression (G2) — waiting means the position rides unprotected. So it
//     does NOT wait: an unverifiable score cannot be used to disarm a stop, and the stop stays live.
// Same fact, opposite responses, because the cost of being wrong points in opposite directions.
//
// WAITING IS BOUNDED, and that bound is load-bearing. A goal chalked off by VAR leaves its event behind while
// the score reverts, so the inconsistency becomes PERMANENT. Without a deadline that one match would lose
// live management for the rest of its 90 minutes — trading a rare stale read for a guaranteed blackout. After
// the deadline the call proceeds and says so loudly.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Match } from "./types.js";

/** How long a match may be held back waiting for its score to catch up with its own goal feed. */
export const SCORE_RACE_MAX_WAIT_SEC = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.SCORE_RACE_MAX_WAIT_SEC);
  return Number.isFinite(n) && n > 0 ? n : 180;
};

const RACE_KEY = "score_race:";

export interface ScoreConsistency {
  ok: boolean;                 // snapshot may be reasoned on
  goalEvents: number;          // goal events recorded for this match
  scoreTotal: number | null;   // goals on the scoreboard (null = no score at all)
  forced: boolean;             // inconsistent, but the wait deadline expired → proceed anyway
  waitedSec: number;
  reason: string;
}

/**
 * Is the stored score consistent with the match's own event feed?
 *
 * Counts only `goal` events. Deliberately NOT counting own-goals separately or trying to attribute goals to
 * sides: the check is "does the scoreboard know about at least as many goals as the event feed does", and any
 * per-side attribution would import the very provider quirks this guard exists to survive.
 *
 * A match with no score yet (both null) is NOT consistent-by-default — it is unknown, and unknown is treated
 * as consistent only when there are also no goal events to contradict it.
 */
export function scoreConsistency(
  db: Database, m: Pick<Match, "id" | "score_home" | "score_away">,
  nowMs: number, env: Record<string, string | undefined> = process.env,
): ScoreConsistency {
  const goals = R.eventsForMatch(db, m.id).filter((e) => e.type === "goal").length;
  const total = m.score_home == null || m.score_away == null ? null : m.score_home + m.score_away;

  if (total == null) {
    // No score at all. Consistent only if the feed has nothing to contradict it.
    if (goals === 0) { clearRace(db, m.id); return { ok: true, goalEvents: 0, scoreTotal: null, forced: false, waitedSec: 0, reason: "счёт неизвестен, голов в фиде нет — противоречия нет" }; }
  } else if (goals <= total) {
    clearRace(db, m.id);
    return { ok: true, goalEvents: goals, scoreTotal: total, forced: false, waitedSec: 0, reason: `счёт ${total} ≥ голов в фиде ${goals} — снимок согласован` };
  }

  // Inconsistent: the event feed knows about goals the scoreboard has not applied.
  const first = firstSeen(db, m.id, nowMs);
  const waited = Math.round((nowMs - first) / 1000);
  const limit = SCORE_RACE_MAX_WAIT_SEC(env);
  if (waited >= limit) {
    return {
      ok: true, forced: true, goalEvents: goals, scoreTotal: total, waitedSec: waited,
      reason: `счёт (${total ?? "—"}) отстаёт от фида (${goals} гол-событий) уже ${waited}с ≥ ${limit}с — ` +
        `дальше НЕ ждём: так выглядит и отменённый по VAR гол, а вечное ожидание отключило бы ведение позиции до конца матча (score_race_forced)`,
    };
  }
  return {
    ok: false, forced: false, goalEvents: goals, scoreTotal: total, waitedSec: waited,
    reason: `снимок отстаёт от собственного фида: ${goals} гол-событий против счёта ${total ?? "—"} — ` +
      `решение на таком снимке было бы обоснованно НЕВЕРНЫМ, ждём консистентности (${waited}с из ${limit}с, score_race_requeue)`,
  };
}

function firstSeen(db: Database, matchId: string, nowMs: number): number {
  const raw = R.metaGet(db, RACE_KEY + matchId);
  const prev = raw == null ? NaN : Number(raw);
  if (Number.isFinite(prev) && prev > 0) return prev;
  try { R.metaSet(db, RACE_KEY + matchId, String(nowMs), new Date(nowMs).toISOString()); } catch { /* marker is best-effort */ }
  return nowMs;
}
function clearRace(db: Database, matchId: string): void {
  try { if (R.metaGet(db, RACE_KEY + matchId) != null) R.metaDelete(db, RACE_KEY + matchId); } catch { /* best-effort */ }
}

/**
 * [G2] May a PROTECTIVE rule be disarmed using this score? No — a guard that stands down on an unverifiable
 * reading is not a guard. Unlike the strategist path this never "forces" through on a deadline: the worst
 * case of keeping a stop armed is an exit the thesis did not require, while the worst case of disarming on a
 * phantom margin is Brann. Those are not comparable, so they do not get the same escape hatch.
 */
export function scoreTrustedForDisarm(c: ScoreConsistency): boolean {
  return c.ok && !c.forced;
}
