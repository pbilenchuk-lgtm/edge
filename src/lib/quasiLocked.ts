// ============================================================
// EDGE LAB — QUASI-LOCKED TAIL  [R1, batch-10 ТЗ]
//
// Boston: a position rode 95.8¢ and was cashed out there; the market resolved at 100¢. Those 4.2¢ were given
// away for nothing — the outcome was already decided by the score, and the only thing the cash-out bought was
// the commission on the way out.
//
// The temptation is to "hold winners to settlement". That is exactly the wrong lesson: holding an UNLOCKED
// position to resolution is how a 95¢ mark becomes 0¢ when a 94th-minute goal lands, and the whole reason the
// cash-out policy exists. So the tail is held ONLY when the game state has mathematically LOCKED the market —
// a deterministic predicate over the score and the clock, from the SAME vocabulary as the resolved_price
// zombie caps, never a judgement call and never a model estimate.
//
// Everything not locked cashes out exactly as before. The risk profile does not change; this only stops
// paying a spread to exit a position whose outcome the scoreboard has already written.
// ============================================================

import { liveAdjustedProb, loadLiveProbConfig, type LiveProbConfig } from "./liveProb.js";

export interface QuasiLockInput {
  label: string; home: string; away: string;
  scoreHome: number | null; scoreAway: number | null; minute: number | null;
}
export interface QuasiLockVerdict {
  locked: boolean;
  reason: string;
  /** True when the lock runs AGAINST the position — the score has decided the market, and decided it the wrong
   *  way. Carried as a field rather than inferred from the prose: the reasons are written for humans and decline
   *  («заперт ПРОТИВОПОЛОЖНО» / «ПРОТИВОПОЛОЖНЫЙ исход»), so any caller matching on the string eventually reads
   *  a losing tail as a winning one. Callers must branch on this, never on `reason`. */
  against?: boolean;
}

/** From which minute a lock may be declared. Before it, even an arithmetically-safe margin has too much match
 *  left to be called decided (and the market prices that risk, so there is no free spread to save). */
const LOCK_MIN_MINUTE = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.QUASI_LOCK_MIN_MINUTE);
  return Number.isFinite(n) && n > 0 ? n : 80;
};
/** How close to certain the game-state probability must be. 1.0 means the SCORE itself locks it — the goals
 *  already happened — which is the only class we accept; a model estimate never reaches exactly 1. */
const LOCK_PROB = 0.9995;

/**
 * Is this market mathematically decided by the current score? Uses liveAdjustedProb, whose score-certain
 * short-circuit returns exactly 1 when the goals on the board settle the question (an Over already cleared, a
 * Draw impossible at ≥2 difference, an Under whose total is unreachable in the minutes that remain).
 *
 * Deliberately conservative in three ways: it demands a LATE clock, it demands the probability be
 * score-certain rather than merely high, and any missing input (no score, no minute) is NOT locked.
 */
export function quasiLocked(inp: QuasiLockInput, core: { xg_home: number; xg_away: number; home_share_1h: number; away_share_1h: number } | null, env: Record<string, string | undefined> = process.env, cfg?: LiveProbConfig): QuasiLockVerdict {
  const minMinute = LOCK_MIN_MINUTE(env);
  if (inp.scoreHome == null || inp.scoreAway == null) return { locked: false, reason: "счёт неизвестен — запертость не доказуема" };
  if (inp.minute == null) return { locked: false, reason: "минута неизвестна — запертость не доказуема" };
  if (inp.minute < minMinute) return { locked: false, reason: `${inp.minute}' < ${minMinute}' — до конца слишком много матча, рынок справедливо оценивает риск` };

  const lab = inp.label.toLowerCase();
  const total = inp.scoreHome + inp.scoreAway;
  const diff = Math.abs(inp.scoreHome - inp.scoreAway);

  // (1) STRICT score-certainty, where the model can prove it: liveAdjustedProb short-circuits to exactly 1
  // when the goals on the board already settle the question (a team Over already cleared). No margin needed —
  // this is arithmetic, not estimation.
  const adj = liveAdjustedProb(inp.label, {
    home: inp.home, away: inp.away, scoreHome: inp.scoreHome, scoreAway: inp.scoreAway, minute: inp.minute,
    core: core ?? { xg_home: 0, xg_away: 0, home_share_1h: 0.5, away_share_1h: 0.5 },
  }, cfg ?? loadLiveProbConfig(env));
  if (adj && adj.prob >= LOCK_PROB) return { locked: true, reason: `счёт запер исход на ${inp.minute}' (${inp.scoreHome}:${inp.scoreAway}, P=${adj.prob.toFixed(4)}) — досиживаем до резолюции, кэш-аут здесь только платит спред` };
  if (adj && adj.prob <= 1 - LOCK_PROB) return { locked: true, against: true, reason: `счёт запер ПРОТИВОПОЛОЖНЫЙ исход на ${inp.minute}' (P=${adj.prob.toFixed(4)}) — держать нечего` };

  // (2) The RATIFIED classes liveAdjustedProb does not model — stated in the ТЗ's own vocabulary («Draw-No при
  // ≥2 разницы после 80', Under при недостижимом тотале»). These are NOT claims of mathematical impossibility:
  // three goals in stoppage time is possible, merely absurd. They are a ratified threshold, and they are
  // written as thresholds so nobody mistakes them for arithmetic later.
  const drawGap = Math.max(2, Number(env.QUASI_LOCK_DRAW_GAP) || 2);
  if (/\bdraw\b|ничья/.test(lab)) {
    const isNo = /—\s*no\b|- no\b|\bнет\b/.test(lab);
    if (diff >= drawGap) {
      return isNo
        ? { locked: true, reason: `ничья недостижима на ${inp.minute}' (разница ${diff} ≥ ${drawGap}, ратифицированный порог — не арифметика) — досиживаем Draw-No до резолюции` }
        : { locked: true, against: true, reason: `ничья недостижима на ${inp.minute}' (разница ${diff}) — Draw-Yes заперт ПРОТИВОПОЛОЖНО, держать нечего` };
    }
    return { locked: false, reason: `разница ${diff} < ${drawGap} на ${inp.minute}' — ничья ещё в игре, кэш-аут по обычному правилу` };
  }
  // Under/Over N.5 on the MATCH total: locked when the goals still needed can no longer plausibly arrive.
  const line = (() => { const mm = /\b(?:over|under|тб|тм)\s*(\d+(?:\.\d+)?)/i.exec(inp.label); return mm ? Number(mm[1]) : null; })();
  if (line != null && /\bunder\b|\bтм\b/.test(lab)) {
    if (total > line) return { locked: true, against: true, reason: `тотал ${total} уже перебил ${line} — Under заперт ПРОТИВОПОЛОЖНО, держать нечего` };
    const need = Math.ceil(line - total);
    if (need >= drawGap) return { locked: true, reason: `для перебоя нужно ещё ${need} гол(а) на ${inp.minute}' — тотал недостижим (ратифицированный порог ≥${drawGap}), досиживаем Under до резолюции` };
    return { locked: false, reason: `до перебоя ${need} гол — тотал достижим, кэш-аут по обычному правилу` };
  }
  if (line != null && /\bover\b|\bтб\b/.test(lab) && total > line) {
    return { locked: true, reason: `тотал ${total} уже перебил ${line} на ${inp.minute}' — Over заперт счётом, досиживаем до резолюции` };
  }
  return { locked: false, reason: `исход не заперт счётом на ${inp.minute}' — кэш-аут по обычному правилу` };
}

/** Convenience: only the affirmative lock (a winning tail worth riding to resolution). The losing-side lock is
 *  reported by quasiLocked for honesty but must never be read as «hold» — there is nothing left to hold. */
export function holdTailToSettle(inp: QuasiLockInput, core: Parameters<typeof quasiLocked>[1], env: Record<string, string | undefined> = process.env): QuasiLockVerdict {
  const v = quasiLocked(inp, core, env);
  if (!v.locked) return v;
  return v.against ? { locked: false, against: true, reason: v.reason } : v;
}
