// ============================================================
// EDGE LAB — T-MINUS PRE-MATCH ANCHOR  [R3, batch-10 ТЗ]
//
// The root cause behind ft_blind=0, proven by batch 10: the pre-match pass ran AFTER kickoff — 3, 7 and 9
// minutes late across the batch. A decision taken after the whistle is stamped origin='live', and ft_blind
// refuses live-origin on a blind fixture (correctly: blind means we cannot see the score). The 5-minute grace
// window recovered 36% of those proposals; the other 64% were lost to scheduling, not to judgement.
//
// The scheduler's own shape explains it. autoAnalyze sorts by kickoff and then takes only `max` matches per
// tick — so on a busy slate a fixture kicking off in 20 minutes can sit behind five others every tick until
// its whistle passes. Sorting alone cannot fix that: the cap is what starves it.
//
// So a funded fixture inside the T-minus window gets its OWN budget, spent before the general queue. It is a
// priority lane, not a bigger cap: the general pass is unchanged, and a slate with no imminent kickoffs
// behaves exactly as before.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Match } from "./types.js";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

/** How long before kickoff the anchor lane opens (minutes). Default 60 — comfortably ahead of the whistle
 *  even if a tick is missed, and late enough that lineups are usually out. */
export const ANCHOR_OPEN_MIN = (env: Record<string, string | undefined> = process.env) => num(env.PREMATCH_ANCHOR_OPEN_MIN, 60);
/** The lane stays open right up to kickoff; a match already past kickoff is NOT an anchor (it is late by
 *  definition, and the live path owns it). */
export const ANCHOR_CLOSE_MIN = (env: Record<string, string | undefined> = process.env) => num(env.PREMATCH_ANCHOR_CLOSE_MIN, 0);
/** Dedicated per-tick budget for the anchor lane. Separate from ANALYZE_MAX_PER_TICK so a busy general
 *  queue can never starve an imminent kickoff. */
export const ANCHOR_MAX_PER_TICK = (env: Record<string, string | undefined> = process.env) => Math.max(1, num(env.PREMATCH_ANCHOR_MAX_PER_TICK, 4));

/** Is this match inside the T-minus anchor window right now? Pure. Unknown kickoff → false (nothing to
 *  anchor to); already kicked off → false (too late for a pre-match pass). */
export function inAnchorWindow(m: Pick<Match, "kickoff_at">, nowMs: number, env: Record<string, string | undefined> = process.env): boolean {
  if (!m.kickoff_at) return false;
  const k = Date.parse(m.kickoff_at);
  if (!Number.isFinite(k)) return false;
  const minsToKick = (k - nowMs) / 60_000;
  return minsToKick <= ANCHOR_OPEN_MIN(env) && minsToKick > ANCHOR_CLOSE_MIN(env);
}

// ── Acceptance metric: are proposals actually landing before the whistle? ────────────────────────
export interface PrematchTimeliness {
  windowDays: number;
  funded: { proposals: number; beforeKickoff: number; pct: number | null; targetPct: number; met: boolean };
  lateness: { median: number | null; worst: number | null; buckets: Record<string, number> }; // minutes AFTER kickoff
  ftBlindTam: { blindFundedFixtures: number; withTradedFtBooks: number; placeholderOnly: number; note: string };
  note: string;
}

const TARGET_PCT = 90;               // R3 acceptance: ≥90% of funded proposals must predate kickoff
const PLACEHOLDER_BAND = 0.6;        // ¢ around 50 — an untraded default book (same band the zombie rule uses)
const TAM_MIN_BOOKS = 2;             // a fixture counts toward the TAM only with ≥N genuinely-priced FT books

/** [R3] Weekly-report metric. `beforeKickoff` counts a bet whose decision (created_at) predates the match
 *  kickoff — the thing the anchor lane exists to maximise. The ft_blind TAM answers the separate question
 *  «how big is this mode's feeding ground at all?», counting only fixtures with genuinely traded FT books:
 *  a wall of 50¢ placeholders is not tradeable inventory, and counting it would flatter the mode. */
export function buildPrematchTimeliness(db: Database, windowDays = 7, nowMs = Date.now()): PrematchTimeliness {
  const fromMs = nowMs - windowDays * 24 * 3600 * 1000;
  const funded = new Set(R.listCompetitions(db).filter((c) => (c.budget ?? 0) > 0).map((c) => c.id));
  let proposals = 0, before = 0;
  const late: number[] = [];
  for (const b of R.allBets(db)) {
    const m = R.getMatch(db, b.match_id);
    if (!m || !funded.has(m.competition_id)) continue;
    const created = Date.parse(b.created_at ?? "") || 0;
    if (!created || created < fromMs) continue;
    const kick = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
    if (!Number.isFinite(kick)) continue;
    proposals++;
    if (created <= kick) before++;
    else late.push(Math.round((created - kick) / 60_000));
  }
  const pct = proposals ? Math.round((1000 * before) / proposals) / 10 : null;
  const sorted = [...late].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const buckets: Record<string, number> = {};
  for (const l of late) { const k = l <= 5 ? "≤5м" : l <= 15 ? "6-15м" : l <= 45 ? "16-45м" : ">45м"; buckets[k] = (buckets[k] ?? 0) + 1; }

  // ft_blind TAM — blind funded football fixtures, split by whether they expose real FT inventory.
  let blindFunded = 0, withBooks = 0, placeholderOnly = 0;
  for (const c of R.listCompetitions(db).filter((x) => x.sport_id === "football" && (x.budget ?? 0) > 0)) {
    for (const m of R.listMatches(db, c.id)) {
      const kick = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
      if (!Number.isFinite(kick) || kick < fromMs) continue;
      if (R.getMatchLive(db, m.id)) continue;           // covered → not blind
      blindFunded++;
      const traded = R.latestMarkets(db, m.id).filter((mk) => Number.isFinite(mk.price) && Math.abs(mk.price - 50) > PLACEHOLDER_BAND).length;
      if (traded >= TAM_MIN_BOOKS) withBooks++; else placeholderOnly++;
    }
  }
  return {
    windowDays,
    funded: { proposals, beforeKickoff: before, pct, targetPct: TARGET_PCT, met: pct != null && pct >= TARGET_PCT },
    lateness: { median, worst: sorted.length ? sorted[sorted.length - 1] : null, buckets },
    ftBlindTam: {
      blindFundedFixtures: blindFunded, withTradedFtBooks: withBooks, placeholderOnly,
      note: `Кормовая база ft_blind за ${windowDays}д: ${blindFunded} слепых фандированных фикстур, из них ${withBooks} с реально торгуемыми книгами (≥${TAM_MIN_BOOKS} котировок вне полосы 50¢) и ${placeholderOnly} только с плейсхолдерами. Плейсхолдеры НЕ считаются инвентарём — иначе размер режима выглядел бы больше, чем он есть.`,
    },
    note: pct == null
      ? `нет предложений на фандированных фикстурах за ${windowDays}д — метрика пуста, это не «100%».`
      : `${before}/${proposals} предложений (${pct}%) приняты ДО кикоффа при цели ${TARGET_PCT}% — ${pct >= TARGET_PCT ? "цель достигнута" : "цель НЕ достигнута"}. Опоздавшие: медиана ${median}м, худшее ${sorted.length ? sorted[sorted.length - 1] : null}м. Опоздание стамплит решение origin=live, а ft_blind на слепой фикстуре live-тезис отвергает — поэтому это прямой кран золотой ячейки, а не косметика.`,
  };
}
