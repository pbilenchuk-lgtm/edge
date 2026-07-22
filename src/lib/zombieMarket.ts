// ============================================================
// EDGE LAB — ZOMBIE-MARKET DETECTOR  [SERVER-ONLY]  (P1)
//
// A "zombie" book is one whose quote is not a live, tradeable price — trading on it (or feeding it to the
// strategist) manufactures a phantom edge. The placeholder filter (mid 50±0.5, tennisPmv) stays; this is
// the extension to STALE / CONTRADICTED / DESYNCED books. Quarantine is for ALL consumers — entries and the
// strategist's quote context — and is visible in the trade log + the P2 unfillable_edge report.
//
// Three deterministic conditions (any one → quarantine):
//   (a) resolved_price   — the price contradicts a completed in-match event. A melting-option leg the game
//                          state has already RESOLVED yes (game-state P ≈ 1: both teams scored → BTTS-Yes;
//                          a team scored → its Over 0.5) but the market still sits far below 100¢ — the book
//                          never caught up (Vardar BTTS ~50¢ with both scored).
//   (b) notation_desync  — duplicate NOTATIONS of one outcome quote different prices at the same time
//                          (Vardar Draw-Yes 20.5 / 38.5 / 50 simultaneously). The spread across the group is
//                          beyond tolerance → the whole group is an incoherent book, edge on any is a phantom.
//   (c) stale_book       — while the match is LIVE, the book's last price change is older than N minutes: a
//                          dead/placeholder market with no live maker.
//
// §9.6: this is NOT a money decision — it's a deterministic yes/no on whether a quote is real. Fails CLOSED
// only on unambiguous contradictions; anything it can't classify is left tradeable (fail-open on ambiguity).
// ============================================================

export type ZombieCode = "resolved_price" | "notation_desync" | "stale_book";
export interface ZombieReason { code: ZombieCode; detail: string }

export interface ZombieConfig {
  /** (c) minutes since the book's last price change, above which a LIVE market is a stale/dead book. */
  staleBookMin: number;
  /** (b) same-outcome price spread (cents) at or above which the notation group is desynced. */
  notationSpreadCents: number;
  /** (a) a game-state-RESOLVED (P≈1) leg priced at or below (100 − margin)¢ contradicts the event. */
  resolvedMarginCents: number;
}

export function loadZombieConfig(env: Record<string, string | undefined> = process.env): ZombieConfig {
  const num = (k: string, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    staleBookMin: num("FOOTBALL_ZOMBIE_STALE_MIN", 30),
    notationSpreadCents: num("FOOTBALL_ZOMBIE_NOTATION_SPREAD", 12),
    resolvedMarginCents: num("FOOTBALL_ZOMBIE_RESOLVED_MARGIN", 12),
  };
}

export interface ZombieInput {
  label: string;
  priceCents: number;
  /** game-state live probability for this leg (liveAdjustedProb), or null when it's not a melting option. */
  gsProb: number | null;
  /** max−min price (cents) across the same-outcome notation group, or null when this label is a singleton. */
  groupSpreadCents: number | null;
  /** minutes since the last price CHANGE for this label, or null when unknown. */
  bookAgeMin: number | null;
  /** is the match live right now (gates the stale-book rule). */
  live: boolean;
}

/** Classify a single market. Returns the FIRST matching zombie reason (a → b → c), or null if tradeable. */
export function classifyZombie(inp: ZombieInput, cfg: ZombieConfig): ZombieReason | null {
  // (a) price contradicts a completed event: the leg is game-state-resolved yes but priced far below 100¢.
  if (inp.gsProb != null && inp.gsProb >= 0.995 && inp.priceCents <= 100 - cfg.resolvedMarginCents) {
    return { code: "resolved_price", detail: `game-state P≈1 (событие свершилось), но цена ${Math.round(inp.priceCents)}¢ ≤ ${100 - cfg.resolvedMarginCents}¢ — книга не догнала исход` };
  }
  // (b) duplicate notations of one outcome desynced beyond tolerance.
  if (inp.groupSpreadCents != null && inp.groupSpreadCents >= cfg.notationSpreadCents) {
    return { code: "notation_desync", detail: `нотации одного исхода разошлись на ${Math.round(inp.groupSpreadCents)}¢ (≥ ${cfg.notationSpreadCents}¢) — несогласованный дублированный рынок` };
  }
  // (c) stale/dead book on a live match.
  if (inp.live && inp.bookAgeMin != null && inp.bookAgeMin >= cfg.staleBookMin) {
    return { code: "stale_book", detail: `книга не менялась ${Math.round(inp.bookAgeMin)} мин при живом матче (≥ ${cfg.staleBookMin}) — стухшая/плейсхолдер` };
  }
  return null;
}

/** Collapse a market label to a canonical OUTCOME key so distinct notations of the same outcome group together
 *  ("Draw — Yes" / "Draw-Yes" / "Ничья Да" → "drawyes"). Language synonyms are folded; everything non-alnum is
 *  stripped. A totals line keeps its number ("Over 2.5" → "over25") so Over 1.5 ≠ Over 2.5. */
export function outcomeKey(label: string): string {
  // \b is ASCII-only in JS, so Cyrillic tokens need unicode-letter lookarounds to isolate whole words
  // (else "да"/"нет" would never fold, or would fold inside a name). English words pass through untouched.
  let s = ` ${String(label).toLowerCase()} `;
  const syn: [RegExp, string][] = [
    [/ничья/gu, "draw"], [/(?<![\p{L}])x(?![\p{L}])/giu, "draw"],
    [/(?<![\p{L}])да(?![\p{L}])/giu, "yes"], [/(?<![\p{L}])нет(?![\p{L}])/giu, "no"],
    [/больше/gu, "over"], [/(?<![\p{L}])тб(?![\p{L}])/giu, "over"],
    [/меньше/gu, "under"], [/(?<![\p{L}])мб(?![\p{L}])/giu, "under"],
    [/обе забьют|обе команды забьют|both teams to score/gu, "btts"],
  ];
  for (const [re, to] of syn) s = s.replace(re, to);
  return s.replace(/[^a-z0-9]+/g, "");
}

/** Spread (cents) of each same-outcome notation group with ≥2 members: label → max−min price. Singletons are
 *  absent from the map. Feeds the notation_desync rule for every member of a desynced group. */
export function notationSpreads(markets: { label: string; price: number }[]): Map<string, number> {
  const groups = new Map<string, { label: string; price: number }[]>();
  for (const m of markets) {
    const k = outcomeKey(m.label);
    if (!k) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(m);
  }
  const out = new Map<string, number>();
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const prices = arr.map((x) => x.price).filter((p) => Number.isFinite(p));
    if (prices.length < 2) continue;
    const spread = Math.max(...prices) - Math.min(...prices);
    for (const x of arr) out.set(x.label, spread);
  }
  return out;
}
