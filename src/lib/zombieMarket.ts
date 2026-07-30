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

import { RESOLVED_RAIL_CENTS } from "./polymarket.js";

export type ZombieCode = "rail_price" | "rail_unexplained" | "resolved_price" | "notation_desync" | "placeholder_mid" | "stale_book";
export interface ZombieReason { code: ZombieCode; detail: string }

export interface ZombieConfig {
  /** (c) minutes since the book's last price change, above which a LIVE market is a stale/dead book. */
  staleBookMin: number;
  /** (b) same-outcome price spread (cents) at or above which the notation group is desynced. */
  notationSpreadCents: number;
  /** (a) a game-state-RESOLVED (P≈1) leg priced at or below (100 − margin)¢ contradicts the event. */
  resolvedMarginCents: number;
  /** (a, P6 batch-7) SCORE-CERTAIN floor: when the Over is mathematically LOCKED by the actual score
   *  (gsProb === 1 — the goals already happened, not a model estimate), a low executable price is a REAL fillable
   *  buy on a locked outcome (+edge to 100¢), NOT a stale book to hide. So quarantine ONLY at an absurd price at
   *  or below this floor (default 5¢ = a broken/void book); everything above stays tradeable — capturing the
   *  cheap locked buys the 88¢ cap wrongly hid (Shelbourne Over 1.5 @84¢). Model-only P≈1 keeps the 88¢ cap. */
  resolvedScoreCertainFloorCents: number;
  /** F4: half-width (cents) of the mid-placeholder band — a book within 50±this is a mid-placeholder CANDIDATE.
   *  It only counts as a placeholder if it has ALSO sat unchanged ≥ placeholderStaleMin (an untraded default
   *  never moves) — so a fresh, legitimately-neutral 50¢ market is NOT falsely blocked. */
  placeholderBandCents: number;
  /** F4: minutes a mid-band book must sit UNCHANGED to count as an untraded placeholder (shorter than the
   *  general staleBookMin — an exact-50 book that never moves is a stronger placeholder signal). */
  placeholderStaleMin: number;
  /** F5: prices at/below this or at/above (100−this) are terminal/efficient — exempt from the stale_book rule
   *  (a book that "doesn't move" because it's ~0/~100¢ resolved is not a dead placeholder; quarantining it
   *  only hides an efficient quote from the strategist and flaps quarantine↔lift every tick). */
  staleExtremeCents: number;
  /** [R4 / batch-10] HYSTERESIS margin (cents) and dwell (ticks). Batch 10 measured 260 lift→re-quarantine
   *  cycles across 28 matches — and only 15 of 417 markets ever wore a second code, so the earlier
   *  "code-flip" theory was wrong: the driver is markets sitting ON a threshold and crossing it back and
   *  forth (Draw Yes/No, Over/Under 5.5, Over 4.5 — thin and extreme lines). A boundary that is identical
   *  in both directions guarantees chatter. So LEAVING quarantine requires clearing the threshold by this
   *  margin (entering still uses the plain threshold — protection must never be slow to engage), and the
   *  clean reading must hold for `hysteresisTicks` consecutive evaluations before the market is declared
   *  healthy again. */
  hysteresisCents: number;
  hysteresisTicks: number;
  /** (a1) Насколько game-state вероятность обязана подпирать планку, чтобы планка считалась ОБЪЯСНЁННОЙ.
   *  Цена ≥99¢ законна только при gsProb > этого порога; ниже — книга утверждает определённость, которой
   *  состояние игры не даёт. Зазор 4пп до планки выбран НАМЕРЕННО: класс ошибки #89 (98¢ на 90'+4' при
   *  запертом счёте, gsProb ≈ 0.99) обязан проходить с запасом, а не впритык. */
  railGsProbCeiling: number;
}

export function loadZombieConfig(env: Record<string, string | undefined> = process.env): ZombieConfig {
  const num = (k: string, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    staleBookMin: num("FOOTBALL_ZOMBIE_STALE_MIN", 30),
    notationSpreadCents: num("FOOTBALL_ZOMBIE_NOTATION_SPREAD", 12),
    resolvedMarginCents: num("FOOTBALL_ZOMBIE_RESOLVED_MARGIN", 12),
    resolvedScoreCertainFloorCents: num("FOOTBALL_ZOMBIE_RESOLVED_SCORE_CERTAIN_FLOOR", 5),
    placeholderBandCents: num("FOOTBALL_ZOMBIE_PLACEHOLDER_BAND", 0.5),
    hysteresisCents: num("FOOTBALL_ZOMBIE_HYSTERESIS_CENTS", 3),
    hysteresisTicks: num("FOOTBALL_ZOMBIE_HYSTERESIS_TICKS", 2),
    placeholderStaleMin: num("FOOTBALL_ZOMBIE_PLACEHOLDER_STALE_MIN", 10),
    staleExtremeCents: num("FOOTBALL_ZOMBIE_STALE_EXTREME", 2),
    railGsProbCeiling: num("FOOTBALL_ZOMBIE_RAIL_GSPROB_CEILING", 0.95),
  };
}

export interface ZombieInput {
  label: string;
  priceCents: number;
  /** F6: live EXECUTABLE ask (cents) from the fresh book, or null when there's no live book. The resolved_price
   *  rule evaluates against THIS (what a buy would actually pay), not the possibly-stale stored mid — so a
   *  resolved leg whose live ask has already caught up to ~100¢ isn't falsely quarantined off a lagging mid. */
  askCents?: number | null;
  /** game-state live probability for this leg (liveAdjustedProb), or null when it's not a melting option. */
  gsProb: number | null;
  /** max−min price (cents) across the same-outcome notation group, or null when this label is a singleton. */
  groupSpreadCents: number | null;
  /** minutes since the last price CHANGE for this label, or null when unknown. */
  bookAgeMin: number | null;
  /** is the match live right now (gates the stale-book rule). */
  live: boolean;
  /** Начался ли матч. `false` включает правило (a0): планка ДО свистка — не цена. После свистка цену
   *  объясняет СЧЁТ, и этим занимается resolved_price. `undefined` — правило не срабатывает. */
  matchKickedOff?: boolean;
}

/**
 * [прод-разбор 29.07] ЦЕНА У ПЛАНКИ НА МАТЧЕ, КОТОРЫЙ ЕЩЁ НЕ НАЧАЛСЯ — ЭТО НЕ ЦЕНА.
 *
 * `Fenerbahçe — Yes 100¢`, `Górnik — Yes 0.1¢`, `Draw — Yes 0.1¢`; по всей базе 828 таких рынков стояло на
 * матчах, которые ещё не стартовали. До стартового свистка никакой счёт не может оправдать планку: это
 * мёртвая или односторонняя книга, а не эффективная котировка. Стратег отказывался торговать её целиком
 * («котировки нерепрезентативны») — то есть мусор останавливал торговлю, а карантин его пропускал:
 * единственное правило, способное поймать (`stale_book`), ИМЕННО такие цены и освобождало через `extreme`.
 *
 * ГРАНИЦА ПРАВИЛА — СТАРТОВЫЙ СВИСТОК, А НЕ ФИНАЛЬНЫЙ. Первая версия ключевалась на «матч не завершён», и
 * прод показал цену этой ошибки в тот же вечер: на 90'+4' матча Bay FC — NJ/NY Gotham (0:1) правило писало
 * «цена 98.5¢ у планки на НЕСЫГРАННОМ матче» про `Draw — No` и карантинило `Over 0.5 @98¢` — цены
 * АБСОЛЮТНО верные, потому что гол уже забит. Заодно вернулось хлопанье карантин↔снятие (3-я минута:
 * карантин → снят → карантин), ради устранения которого освобождение `extreme` и писалось.
 *
 * После свистка цену объясняет СЧЁТ, и для этого есть своё правило (resolved_price сравнивает цену с
 * game-state вероятностью). До свистка объяснять нечем — там работает это правило, и только там.
 */
export function isRailPrice(priceCents: number): boolean {
  // ОДИН порог с путём записи (`polymarket.RESOLVED_RAIL_CENTS`, «effectively-resolved / dead line»).
  // В первой версии здесь стоял `staleExtremeCents` (2¢) — я объявил «один порог, не два» и тут же завёл
  // второй. Из-за него под правило попадали живые длинные ставки в 1.5–2¢.
  return priceCents <= RESOLVED_RAIL_CENTS || priceCents >= 100 - RESOLVED_RAIL_CENTS;
}

/** Classify a single market. Returns the FIRST matching zombie reason (a → b → c), or null if tradeable. */
export function classifyZombie(inp: ZombieInput, cfg: ZombieConfig): ZombieReason | null {
  // (a0) Планочная цена на НЕЗАВЕРШЁННОМ матче. Проверяется ПЕРВОЙ: пока цена не является ценой, все
  // остальные суждения о ней (насколько отстала от исхода, разошлись ли нотации) бессмысленны.
  if (inp.matchKickedOff === false && isRailPrice(inp.priceCents)) {
    return { code: "rail_price", detail: `цена ${Math.round(inp.priceCents * 10) / 10}¢ у планки ДО стартового свистка — книга мёртвая/односторонняя, это не котировка` };
  }
  // (a1) ПЛАНКА, КОТОРУЮ СОСТОЯНИЕ ИГРЫ НЕ ОБЪЯСНЯЕТ. Между (a0) и resolved_price была незакрытая зона, и
  // прод 30.07 показал её размер: на шести живых матчах Conference League 36 из 40, 36 из 40, 32 из 36 и
  // 30 из 34 рынков стояли у планки — при счёте 0:0 на 24-й минуте. (a0) молчит по построению (матч начался),
  // resolved_price молчит тоже (он требует gsProb ≥ 0.995 — «счёт запер исход», а при 0:0 не заперто ничто).
  // Стратег видел доску, где 90% котировок утверждают уже известный результат, и отказывался от неё целиком.
  //
  // Правильный предикат — не «до/после свистка», а тот же, что в T1.1: ОБЪЯСНЯЕТ ЛИ СОСТОЯНИЕ ИГРЫ ЦЕНУ.
  // gsProb у нас уже посчитан; планка законна ровно тогда, когда он её подпирает.
  //
  // Возражение «модель не согласна с ценой — это же край» снято: У ПЛАНКИ КРАЯ НЕ СУЩЕСТВУЕТ ФИЗИЧЕСКИ.
  // Купить на 99.5¢ нечего (потолок 100¢ при нулевой глубине), продавать мы не умеем. Значит карантин таких
  // рынков не отнимает ни одной ТОРГУЕМОЙ возможности, а яд из доски убирает.
  //
  // gsProb === null → правило МОЛЧИТ. Не знаем состояния игры — не имеем права утверждать, что планка им не
  // объясняется; §9.6 fail-open на неоднозначности. Это же и защищает класс ошибки #89 на рынках без
  // game-state вероятности.
  if (inp.matchKickedOff !== false && inp.gsProb != null && isRailPrice(inp.priceCents)) {
    const high = inp.priceCents >= 100 - RESOLVED_RAIL_CENTS;
    // Симметрия: ≥99¢ требует gsProb > 0.95; ≤1¢ требует gsProb < 0.05 (та же уверенность с другой стороны).
    const unexplained = high ? inp.gsProb <= cfg.railGsProbCeiling : inp.gsProb >= 1 - cfg.railGsProbCeiling;
    if (unexplained) {
      return {
        code: "rail_unexplained",
        detail: `цена ${Math.round(inp.priceCents * 10) / 10}¢ у планки, но состояние игры даёт P=${Math.round(inp.gsProb * 1000) / 10}% (нужно ${high ? ">" : "<"} ${Math.round((high ? cfg.railGsProbCeiling : 1 - cfg.railGsProbCeiling) * 100)}%) — книга утверждает определённость, которой на поле нет`,
      };
    }
  }
  // (a) price contradicts a completed event: the leg is game-state-resolved yes but priced far below 100¢.
  // F6: compare against the live executable ask when we have one — a resolved leg whose real book already sits
  // at ~100¢ (only the stored mid lagged) is NOT a phantom and must not flap-quarantine; only quarantine when
  // the price a buy would actually pay is itself below the margin (stale/no-book → fall back to the stored mid).
  const resolvedPx = inp.askCents ?? inp.priceCents;
  // P6 (batch-7): SCORE-CERTAIN vs MODEL-ONLY. gsProb === 1 (exactly) only when the ACTUAL score already locks
  // the Over — the goals happened, liveAdjustedProb short-circuits need<=0 → prob 1; a Poisson MODEL estimate is
  // always < 1. A mathematically-locked Over at a low executable price is a REAL fillable buy (+edge to 100¢),
  // NOT a stale book — so it's quarantined ONLY below a small floor (a broken/void book), staying tradeable across
  // the normal range. Model-only P≈1 keeps the cautious 88¢ cap (a wrong model could make a cheap price genuine).
  // Scoped to OVER families (spec: «score-certain Over-семей»): a "Team Over N.5" locked by the score. BTTS-Yes
  // and others keep the cautious 88¢ cap (the original Vardar resolved_price catch is unchanged).
  const scoreCertain = inp.gsProb != null && inp.gsProb >= 1 && /\bover\b/i.test(inp.label);
  const threshold = scoreCertain ? cfg.resolvedScoreCertainFloorCents : 100 - cfg.resolvedMarginCents;
  if (inp.gsProb != null && inp.gsProb >= 0.995 && resolvedPx <= threshold) {
    return { code: "resolved_price", detail: `game-state P${scoreCertain ? "=1 (счёт запер исход)" : "≈1"}, но исполнимая цена ${Math.round(resolvedPx)}¢ ≤ ${threshold}¢ — ${scoreCertain ? "аномально дёшево для запертого счётом Over (битая книга/риск void)" : "книга не догнала исход"}` };
  }
  // (b) duplicate notations of one outcome desynced beyond tolerance.
  if (inp.groupSpreadCents != null && inp.groupSpreadCents >= cfg.notationSpreadCents) {
    return { code: "notation_desync", detail: `нотации одного исхода разошлись на ${Math.round(inp.groupSpreadCents)}¢ (≥ ${cfg.notationSpreadCents}¢) — несогласованный дублированный рынок` };
  }
  // (b2 = F4) mid-placeholder: an UNTRADED default book parked at 50±band AND unchanged ≥ placeholderStaleMin.
  // Football had no equivalent of the tennisPmv mid-50 filter, so a 50¢/ai_prob-90% parked book reached the
  // strategist as a fake 40% "edge". The staleness clause is essential: it fires only on a book that has SAT at
  // the mid (an untraded default never moves), so a fresh, legitimately-neutral 50¢ market is not falsely
  // blocked — and the empty-book/retry entry gate still owns brand-new books. Checked AFTER
  // resolved_price/notation_desync so a resolved or desynced 50¢ member keeps its more specific code.
  if (Math.abs(inp.priceCents - 50) <= cfg.placeholderBandCents && inp.bookAgeMin != null && inp.bookAgeMin >= cfg.placeholderStaleMin) {
    return { code: "placeholder_mid", detail: `книга у мид-плейсхолдера (${Math.round(inp.priceCents * 10) / 10}¢ ≈ 50¢, не менялась ${Math.round(inp.bookAgeMin)}м) — недоразмеченный дефолт, любой edge против неё фантом` };
  }
  // (c) stale/dead book on a live match — but NOT a terminal/efficient extreme (≤staleExtreme or ≥100−staleExtreme):
  // such a book "doesn't move" because it's resolved-priced, not dead; quarantining it only hides an efficient
  // quote and flaps quarantine↔lift each tick (F5).
  const extreme = inp.priceCents <= cfg.staleExtremeCents || inp.priceCents >= 100 - cfg.staleExtremeCents;
  if (inp.live && !extreme && inp.bookAgeMin != null && inp.bookAgeMin >= cfg.staleBookMin) {
    return { code: "stale_book", detail: `книга не менялась ${Math.round(inp.bookAgeMin)} мин при живом матче (≥ ${cfg.staleBookMin}) — стухшая/плейсхолдер` };
  }
  return null;
}

/**
 * [R4 / batch-10] Is this market clean with a MARGIN — i.e. clear enough of every threshold that calling it
 * healthy will not be reversed by the next tick's noise?
 *
 * classifyZombie uses plain thresholds, which is right for ENTERING quarantine: protection must engage the
 * instant a book looks wrong. It is wrong for LEAVING: a market sitting exactly on a boundary crosses it back
 * and forth, and each crossing writes a log line and re-opens the entry gate. Batch 10 measured 260 such
 * lift→re-quarantine cycles in 28 matches, concentrated in thin/extreme lines (Draw Yes/No, Over/Under 5.5).
 *
 * So leaving requires clearing each threshold by `hysteresisCents` (time-based staleness just needs a fresh
 * book — a price change resets the age to zero by construction, so no extra margin applies there).
 */
export function zombieClearWithMargin(inp: ZombieInput, cfg: ZombieConfig): boolean {
  if (classifyZombie(inp, cfg)) return false;               // still a zombie by the plain rules
  const h = Math.max(0, cfg.hysteresisCents);
  // notation spread must sit clearly BELOW the desync threshold, not just under it.
  if (inp.groupSpreadCents != null && inp.groupSpreadCents > cfg.notationSpreadCents - h) return false;
  // the price must be clearly OFF the mid-placeholder band (the band itself is tiny, so the margin does the work).
  if (Math.abs(inp.priceCents - 50) <= cfg.placeholderBandCents + h) return false;
  // a game-state-resolved leg must be clearly above the resolved-price cap it was quarantined under.
  if (inp.gsProb != null && inp.gsProb >= 0.995) {
    const px = inp.askCents ?? inp.priceCents;
    const scoreCertain = inp.gsProb >= 1 && /\bover\b/i.test(inp.label);
    const threshold = scoreCertain ? cfg.resolvedScoreCertainFloorCents : 100 - cfg.resolvedMarginCents;
    if (px <= threshold + h) return false;
  }
  // (a1) Выход из rail_unexplained тоже с зазором — иначе рынок, чья цена дрожит вокруг самой планки,
  // будет хлопать карантин↔снятие каждый тик. Ровно та беда, ради которой гистерезис и написан (260 циклов
  // на 28 матчах). Цена обязана отойти от планки на hysteresisCents, а не просто перестать её касаться.
  if (inp.matchKickedOff !== false && inp.gsProb != null) {
    const nearHigh = inp.priceCents >= 100 - RESOLVED_RAIL_CENTS - h;
    const nearLow = inp.priceCents <= RESOLVED_RAIL_CENTS + h;
    if (nearHigh && inp.gsProb <= cfg.railGsProbCeiling) return false;
    if (nearLow && inp.gsProb >= 1 - cfg.railGsProbCeiling) return false;
  }
  return true;
}

/** Collapse a market label to a canonical OUTCOME key so distinct notations of the same outcome group together
 *  ("Draw — Yes" / "Draw-Yes" / "Ничья Да" → "drawyes"). Language synonyms are folded; everything non-alnum is
 *  stripped. A totals line keeps its number ("Over 2.5" → "over25") so Over 1.5 ≠ Over 2.5. */
export function outcomeKey(label: string): string {
  // \b is ASCII-only in JS, so Cyrillic tokens need unicode-letter lookarounds to isolate whole words
  // (else "да"/"нет" would never fold, or would fold inside a name). English words pass through untouched.
  let s = ` ${String(label).toLowerCase()} `;
  // F3: drop a "(TeamA vs TeamB)" order-qualifier before folding. Polymarket emits the same draw outcome under
  // "Draw — Yes", "Draw (A vs. B) — Yes" and "Draw (B vs. A) — Yes"; keeping the parenthetical made each a
  // distinct singleton key, so notationSpreads never grouped them and the notation_desync guard silently
  // no-opped on its exact target family. Only qualifiers containing a "vs"/"против" token are stripped, so a
  // handicap parenthetical like "(-1.5)" (where the number is meaningful) is untouched.
  s = s.replace(/\([^)]*\s(?:vs\.?|против|v)\s[^)]*\)/gu, " ");
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
