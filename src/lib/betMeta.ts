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
  edgeSource?: "executable" | "mid_fallback"; // was edge measured vs the executable ask, or a mid fallback?
  execAskCents?: number | null;     // ¢, the executable BUY ask edge was measured against (when executable)
  spreadCents?: number | null;      // ¢, bid/ask spread at entry (wide = phantom-prone thin book)
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
  // Ground-truth model attribution for the A/B: which model produced THIS bet's
  // analysis + strategist decision. Optional (legacy/minimal paths omit it). The
  // epoch on `code_version` segments coarsely; this records exactly what ran.
  models?: { analysis?: string | null; strategist?: string | null } | null;
  // Tennis PROP orientation, resolved ONCE at entry against the scout players and FROZEN on the bet:
  // does this prop market's LABEL first-named player == scout p1? Settlement reads THIS (never
  // re-derives from the moneyline), so a prop that lists players in the opposite order to the
  // moneyline settles on the side it was actually bought. null/undefined for non-oriented families.
  propFirstIsP1?: boolean | null;
  // Tennis MONEYLINE orientation, resolved ONCE at entry and FROZEN on the bet (token-fix-m1). The
  // buyback trades the FAVOURITE's winner token; `favSide` names which player is the favourite (scout
  // order) and `firstIsP1` whether scout-p1 == the moneyline's first outcome. Together they pin the
  // exact outcome the position holds, so the exit sells the SAME token it bought — no re-derivation.
  favSide?: "first" | "second" | null;
  firstIsP1?: boolean | null;
  // token-flip-poisoned: this bet was opened BEFORE token-fix-m1 while holding the WRONG outcome's
  // token (favourite = second moneyline outcome, but the engine always bought outcomes[0]). Its
  // take/exit P&L is about the opponent's token, not the favourite's — EXCLUDED from every
  // calibration/win-rate slice. Set by migrateQuarantinePoisonedTennis; never on a post-fix bet.
  tokenFlipPoisoned?: boolean | null;
  // ── Exit-execution flags (set when a tennis position is CLOSED against the book, book-fill-m1) ──
  // exitStalePrice: a protective exit had NO live bid book and executed at the MODELLED/stale price
  //   (§4.5). Its realized P&L is not a clean book fill — analytics EXCLUDES it from calibration/
  //   win-rate slices so a stale-priced defensive cut can't pollute the numbers.
  exitStalePrice?: boolean | null;
  // exitAttention: a protective exit could only PARTIALLY fill on a thin bid; the remainder is still
  //   open and awaiting the next tick's retry (never dumped below floor). Visibility flag.
  exitAttention?: boolean | null;
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
