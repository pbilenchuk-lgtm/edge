// ============================================================
// EDGE LAB — bet decision-time snapshot (entry_meta) for risk-profile analytics.
// A MEASUREMENT layer only: captured at the moment a bet is proposed/filled so the
// «Профили» tab and the export can answer, from data, which profile is best, where
// edge really pays, how calibrated the model is, and how the tails behave — without
// re-deriving point-in-time state that's since been overwritten. §9.6 untouched:
// nothing here sizes or moves money; it only records.
// ============================================================

// System EPOCH at entry — bump on a fix that changes what the numbers MEAN, so
// analysis can drop bets from a broken era (spec §4: "half the early history was
// taken on a broken system"). Not a git sha; a human-legible monotone label.
//   e1  pre-profiles / pre-Model-A
//   e2  Model-A dedup + phantom-exit guards
//   e3  melting-option / game-state live prob + time_stop
//   e4  fees+slippage ledger + real-$5000 budget view
//   e5  post-audit: partial-close P&L + reserve-leak + time_stop-per-profile fixes
export const CODE_VERSION = "e5";

/** Decision-time snapshot stored as JSON on the bet. Every field is what was TRUE at
 *  the instant the bet was proposed/filled — never re-read later. All optional so a
 *  minimal/legacy path can still record what it has. */
export interface BetEntryMeta {
  phase: "prematch" | "live";
  minute: number | null;            // match minute at entry (null = prematch)
  scoreHome: number | null;         // score at entry
  scoreAway: number | null;
  edge: number | null;              // our_prob − de-vigged implied, fraction
  aiProb: number | null;            // strategist's actual prob at entry (drives sizing)
  derivedProb: number | null;       // pure Poisson-derived prob (pre pick override)
  marketPrice: number | null;       // ¢, the de-vig-free quote at entry
  impliedProb: number | null;       // de-vigged implied prob
  liveProbAdjusted: number | null;  // game-state P (live melting-option entries), else null
  kellyFraction: number | null;     // the calibration-scaled, clamped Kelly used
  sizeRequested: number | null;     // $ the sizer asked for (pre book-depth cap)
  sizeFilled: number | null;        // $ actually filled (set at fill)
  entrySlipCents: number | null;    // adverse slippage on the entry fill (¢/share)
  calibration: number | null;       // analysis xg_confidence 0..1 at entry
  branchWeightSum: number | null;   // Σ outcome-tree branch weight the bet lives in
  phantomCheck: string | null;      // the anti-phantom verdict text
  marketThinnessUsd: number | null; // known book depth/liquidity at entry ($)
  winsOnEvent: boolean;             // melting option (bet ON an event) vs directional
  exitPlan: unknown | null;         // the pre-written exit plan (take_price/thesis/counter/time_stop)
}

/** Serialise an entry-meta snapshot (drops undefineds; stable for CSV/analytics). */
export function serializeEntryMeta(m: Partial<BetEntryMeta>): string {
  return JSON.stringify(m);
}

/** Parse a stored entry_meta blob; null/garbage → null (never throws). */
export function parseEntryMeta(raw: string | null | undefined): BetEntryMeta | null {
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v as BetEntryMeta : null; }
  catch { return null; }
}
