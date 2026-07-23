// ============================================================
// EDGE LAB — SET-VALUE sizing audit  [SERVER-ONLY, READ-ONLY]  (P0.6)
//
// The 10-log review showed the profile now renamed `max` staked MORE than aggressive on every match
// ($129-135 vs $80). Owner decision 23.07.2026 (b): that is now INTENTIONAL — `max` is the super-risky
// profile, expected to be the largest, and is NOT an inversion. This report still prints, for each profile,
// the sizing knobs (kelly_fraction_base, clamp, max_position_pct, max_match_exposure_pct) and the stake each
// WOULD size on one fixed reference setup (median set_value entry: edge ~15% at 35¢). It flags an inversion
// ONLY when a "lite"/"conservative" profile outsizes "aggressive" — `max` outsizing everyone is by design.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { getProfileConfig } from "./riskConfig.js";
import { sizePrematch } from "./strategist.js";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export interface SvSizingRow {
  profileId: string; name: string;
  kellyBase: number; kellyClamp: [number, number]; maxPositionPct: number; maxMatchExposurePct: number;
  refStake: number; refFractionPct: number; refReason: string;
}
export interface SvSizingAudit {
  budget: number; reference: { edgePct: number; priceCents: number; liquidityUsd: number };
  rows: SvSizingRow[];       // sorted by refStake desc — biggest better on top
  inversion: string | null;  // set when a "lite"/"conservative" profile outsizes "aggressive"
  note: string;
}

/** Per-profile sizing on ONE fixed set_value setup, so a genuine lite/conservative-outsizes-aggressive inversion is
 *  visible with the exact knobs behind it. Pure read — never changes a config. */
export function buildSvSizingAudit(db: Database, env: Record<string, string | undefined> = process.env): SvSizingAudit {
  const budget = num(env.TENNIS_PAPER_BUDGET_USD, 1000);
  const priceCents = 35, ourProb = 0.5;   // median set_value entry from the review (edge = 0.5 − 0.35 = 15%)
  const profiles = R.listRiskProfiles(db).map((p) => ({ id: p.id, name: (p as any).name ?? p.id }));
  const rows: SvSizingRow[] = profiles.map(({ id, name }) => {
    const cfg = getProfileConfig(db, id);
    const r = sizePrematch({ ourProb, priceCents, implied: priceCents / 100, calibration: 0.6, liquidity: 8000, budget, matchExposure: 0, compExposure: 0, cfg });
    return {
      profileId: id, name,
      kellyBase: cfg.sizing.kelly_fraction_base, kellyClamp: cfg.sizing.kelly_fraction_clamp,
      maxPositionPct: cfg.sizing.max_position_pct, maxMatchExposurePct: cfg.sizing.max_match_exposure_pct,
      refStake: r.stake, refFractionPct: Math.round((r.fraction ?? 0) * 1000) / 10, refReason: r.reason,
    };
  }).sort((a, b) => b.refStake - a.refStake);

  const agg = rows.find((r) => /aggress|агресс/i.test(r.profileId + r.name));
  const lite = rows.find((r) => /lite|conserv|консерв|лайт/i.test(r.profileId + r.name));
  const inversion = agg && lite && lite.refStake > agg.refStake
    ? `⚠ ИНВЕРСИЯ: «${lite.name}» ставит $${lite.refStake} > «${agg.name}» $${agg.refStake} на одном сетапе — «лёгкий» профиль рискует БОЛЬШЕ агрессивного. Причина: kelly_fraction_base/max_position_pct у «${lite.name}» (${lite.kellyBase}/${lite.maxPositionPct}) ≥ «${agg.name}» (${agg.kellyBase}/${agg.maxPositionPct}). Решение по фиксу — за владельцем.`
    : null;

  return {
    budget, reference: { edgePct: Math.round((ourProb - priceCents / 100) * 1000) / 10, priceCents, liquidityUsd: 8000 },
    rows, inversion,
    note: inversion ?? "Сайзинг по профилям в ожидаемом порядке (агрессивный ≥ лёгкого) — правку не требует.",
  };
}
