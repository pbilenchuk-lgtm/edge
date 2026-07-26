import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyZombie, outcomeKey, notationSpreads, loadZombieConfig, type ZombieConfig } from "../src/lib/zombieMarket.js";

const CFG: ZombieConfig = { staleBookMin: 30, notationSpreadCents: 12, resolvedMarginCents: 12, resolvedScoreCertainFloorCents: 5, placeholderBandCents: 0.5, placeholderStaleMin: 10, staleExtremeCents: 2, hysteresisCents: 3, hysteresisTicks: 2 };

test("P1 classifyZombie (a): a game-state-resolved leg priced far below 100¢ is a resolved_price zombie", () => {
  // both teams scored → BTTS-Yes gsProb ≈ 1, but the book still sits at 50¢ (Vardar)
  const z = classifyZombie({ label: "BTTS — Yes", priceCents: 50, gsProb: 1, groupSpreadCents: null, bookAgeMin: 2, live: true }, CFG);
  assert.equal(z?.code, "resolved_price");
});

test("P1 classifyZombie (a): a resolved leg already priced near 100¢ is NOT a zombie (book caught up)", () => {
  const z = classifyZombie({ label: "BTTS — Yes", priceCents: 96, gsProb: 1, groupSpreadCents: null, bookAgeMin: 2, live: true }, CFG);
  assert.equal(z, null);
});

test("P6 (batch-7) classifyZombie (a): a SCORE-CERTAIN Over (gsProb=1, goals locked) stays TRADEABLE below the 88¢ cap", () => {
  // "Team Over 1.5" with the team already on 2 → mathematically locked. A cheap executable price is a REAL buy
  // (+edge to 100¢), NOT a stale book — so it must NOT be quarantined (Shelbourne Over 1.5 @84¢).
  assert.equal(classifyZombie({ label: "Shelbourne Over 1.5", priceCents: 84, askCents: 84, gsProb: 1, groupSpreadCents: null, bookAgeMin: 2, live: true }, CFG), null, "locked Over @84¢ is tradeable, not a zombie");
  // even a deep-discount locked Over is a buy, down to the small broken/void floor (5¢).
  assert.equal(classifyZombie({ label: "Shelbourne Over 1.5", priceCents: 20, askCents: 20, gsProb: 1, groupSpreadCents: null, bookAgeMin: 2, live: true }, CFG), null, "locked Over @20¢ still tradeable");
  // an absurd sub-floor price on a "locked" Over is a broken/void book → still quarantined.
  assert.equal(classifyZombie({ label: "Shelbourne Over 1.5", priceCents: 3, askCents: 3, gsProb: 1, groupSpreadCents: null, bookAgeMin: 2, live: true }, CFG)?.code, "resolved_price");
});

test("P6 (batch-7) classifyZombie (a): MODEL-ONLY P≈1 (not score-locked) keeps the cautious 88¢ cap; BTTS untouched", () => {
  // gsProb 0.996 from the MODEL (not exactly 1) → cautious 88¢ cap still applies.
  assert.equal(classifyZombie({ label: "Home Over 1.5", priceCents: 84, askCents: 84, gsProb: 0.996, groupSpreadCents: null, bookAgeMin: 2, live: true }, CFG)?.code, "resolved_price");
  // score-certain BTTS (the original Vardar catch) is NOT an Over family → keeps the 88¢ cap.
  assert.equal(classifyZombie({ label: "BTTS — Yes", priceCents: 50, askCents: 50, gsProb: 1, groupSpreadCents: null, bookAgeMin: 2, live: true }, CFG)?.code, "resolved_price");
});

test("P1 classifyZombie (b): duplicate notations desynced beyond tolerance → notation_desync", () => {
  const z = classifyZombie({ label: "Draw — Yes", priceCents: 38, gsProb: null, groupSpreadCents: 29.5, bookAgeMin: 1, live: true }, CFG);
  assert.equal(z?.code, "notation_desync");
  // spread under tolerance → tradeable
  assert.equal(classifyZombie({ label: "Draw — Yes", priceCents: 38, gsProb: null, groupSpreadCents: 5, bookAgeMin: 1, live: true }, CFG), null);
});

test("P1 classifyZombie (c): a live book unchanged past the stale window → stale_book; not gated when unknown or not live", () => {
  assert.equal(classifyZombie({ label: "Over 2.5", priceCents: 55, gsProb: null, groupSpreadCents: null, bookAgeMin: 40, live: true }, CFG)?.code, "stale_book");
  assert.equal(classifyZombie({ label: "Over 2.5", priceCents: 55, gsProb: null, groupSpreadCents: null, bookAgeMin: 40, live: false }, CFG), null);
  assert.equal(classifyZombie({ label: "Over 2.5", priceCents: 55, gsProb: null, groupSpreadCents: null, bookAgeMin: null, live: true }, CFG), null);
});

test("P1 classifyZombie: a normal fresh tradeable quote is not a zombie; resolved_price wins priority over stale", () => {
  assert.equal(classifyZombie({ label: "Over 2.5", priceCents: 55, gsProb: 0.6, groupSpreadCents: 3, bookAgeMin: 5, live: true }, CFG), null);
  // both resolved AND stale → the harder contradiction (resolved) is reported
  assert.equal(classifyZombie({ label: "BTTS — Yes", priceCents: 40, gsProb: 1, groupSpreadCents: null, bookAgeMin: 99, live: true }, CFG)?.code, "resolved_price");
});

test("P1 outcomeKey: distinct notations of ONE outcome collapse; a different total keeps its number", () => {
  const k = outcomeKey("Draw — Yes");
  assert.equal(outcomeKey("Draw-Yes"), k);
  assert.equal(outcomeKey("Ничья Да"), k);
  assert.notEqual(outcomeKey("Over 1.5"), outcomeKey("Over 2.5"));
});

test("P1 notationSpreads: a same-outcome group at 20/38/50 gets a 30¢ spread on every member; singletons absent", () => {
  const s = notationSpreads([
    { label: "Draw — Yes", price: 20 }, { label: "Draw-Yes", price: 38 }, { label: "Ничья Да", price: 50 },
    { label: "Over 2.5", price: 55 },
  ]);
  assert.equal(s.get("Draw — Yes"), 30);
  assert.equal(s.get("Ничья Да"), 30);
  assert.equal(s.has("Over 2.5"), false, "a singleton outcome has no group spread");
});

test("P1 loadZombieConfig: defaults and env overrides", () => {
  const d = loadZombieConfig({});
  assert.equal(d.staleBookMin, 30);
  assert.equal(d.notationSpreadCents, 12);
  assert.equal(d.resolvedMarginCents, 12);
  const o = loadZombieConfig({ FOOTBALL_ZOMBIE_STALE_MIN: "15", FOOTBALL_ZOMBIE_NOTATION_SPREAD: "20", FOOTBALL_ZOMBIE_RESOLVED_MARGIN: "8" });
  assert.deepEqual([o.staleBookMin, o.notationSpreadCents, o.resolvedMarginCents], [15, 20, 8]);
});

test("F3 outcomeKey: a «(TeamA vs TeamB)» order-qualifier is stripped so all Draw notations collapse to one key", () => {
  // Debreceni–Pyunik: three disagreeing draw notations that used to key as distinct singletons
  const k = outcomeKey("Draw — Yes");
  assert.equal(outcomeKey("Draw (Pyunik FA vs. Debreceni VSC) — Yes"), k, "team-vs-team qualifier folds away");
  assert.equal(outcomeKey("Draw (Debreceni VSC vs. Pyunik FA) — Yes"), k, "reverse team order folds to the same key");
  // a handicap parenthetical (number is meaningful, no vs-token) is NOT stripped
  assert.notEqual(outcomeKey("Debreceni VSC (-1.5)"), outcomeKey("Debreceni VSC (-2.5)"));
});

test("F3 notationSpreads: the three-notation draw group now spreads together and trips notation_desync", () => {
  const s = notationSpreads([
    { label: "Draw — Yes", price: 99.6 },
    { label: "Draw (Pyunik FA vs. Debreceni VSC) — Yes", price: 42 },
    { label: "Draw (Debreceni VSC vs. Pyunik FA) — Yes", price: 0.1 },
  ]);
  assert.ok((s.get("Draw — Yes") ?? 0) >= CFG.notationSpreadCents, "grouped spread ≥ tolerance");
  const z = classifyZombie({ label: "Draw (Pyunik FA vs. Debreceni VSC) — Yes", priceCents: 42, gsProb: null, groupSpreadCents: s.get("Draw (Pyunik FA vs. Debreceni VSC) — Yes") ?? null, bookAgeMin: 1, live: true }, CFG);
  assert.equal(z?.code, "notation_desync", "the desynced draw member is now quarantined, not fed as phantom edge");
});

test("F4 classifyZombie: an UNTRADED mid-placeholder (50±band, parked ≥stale) is placeholder_mid; a fresh 50¢ is not", () => {
  // SK Rapid Wien Over 0.5: 50¢ · ai_prob 90% on an untraded Polymarket-only book, sat unchanged
  assert.equal(classifyZombie({ label: "SK Rapid Wien Over 0.5", priceCents: 50, gsProb: null, groupSpreadCents: null, bookAgeMin: 20, live: true }, CFG)?.code, "placeholder_mid");
  assert.equal(classifyZombie({ label: "x", priceCents: 50.4, gsProb: null, groupSpreadCents: null, bookAgeMin: 20, live: true }, CFG)?.code, "placeholder_mid");
  // a FRESH 50¢ market (book not yet sat) is NOT falsely blocked — the entry gate owns brand-new books
  assert.equal(classifyZombie({ label: "x", priceCents: 50, gsProb: null, groupSpreadCents: null, bookAgeMin: 3, live: true }, CFG), null);
  assert.equal(classifyZombie({ label: "x", priceCents: 50, gsProb: null, groupSpreadCents: null, bookAgeMin: null, live: true }, CFG), null);
  // just outside the band → not a placeholder even if parked
  assert.equal(classifyZombie({ label: "x", priceCents: 47, gsProb: null, groupSpreadCents: null, bookAgeMin: 20, live: true }, CFG), null);
  // a resolved 50¢ leg keeps its more specific resolved_price code (placeholder is checked after)
  assert.equal(classifyZombie({ label: "BTTS — Yes", priceCents: 50, gsProb: 1, groupSpreadCents: null, bookAgeMin: 20, live: true }, CFG)?.code, "resolved_price");
});

test("F5 classifyZombie: an extreme-priced (≤2 / ≥98) stale book is exempt from stale_book; a mid one still fires", () => {
  // Debreceni Under 5.5 ~99.6¢ sitting unchanged 356 min was flap-quarantined; now exempt
  assert.equal(classifyZombie({ label: "Under 5.5", priceCents: 99.6, gsProb: null, groupSpreadCents: null, bookAgeMin: 356, live: true }, CFG), null);
  assert.equal(classifyZombie({ label: "Over 0.5", priceCents: 0.5, gsProb: null, groupSpreadCents: null, bookAgeMin: 356, live: true }, CFG), null);
  // a genuinely mid-priced stale book is still a stale_book zombie
  assert.equal(classifyZombie({ label: "Over 2.5", priceCents: 55, gsProb: null, groupSpreadCents: null, bookAgeMin: 40, live: true }, CFG)?.code, "stale_book");
});

test("F6 classifyZombie: resolved_price evaluates the live ask, not a lagging stored mid", () => {
  // Debreceni Over 0.5 @62': stored mid 77.5¢ (lagged) but live book already ~100¢ (ask 99.9) → NOT a zombie
  assert.equal(classifyZombie({ label: "Debreceni VSC Over 0.5", priceCents: 77.5, askCents: 99.9, gsProb: 1, groupSpreadCents: null, bookAgeMin: 5, live: true }, CFG), null);
  // a MODEL-ONLY resolved leg (gsProb 0.997, not score-locked) whose live ask is below the 88¢ margin stays
  // quarantined — the live ask, not the mid, is evaluated. (A score-certain Over here would instead be tradeable.)
  assert.equal(classifyZombie({ label: "Debreceni VSC Over 0.5", priceCents: 77.5, askCents: 74, gsProb: 0.997, groupSpreadCents: null, bookAgeMin: 5, live: true }, CFG)?.code, "resolved_price");
  // no live book (ask null) → fall back to the stored mid (unchanged fail-closed behaviour)
  assert.equal(classifyZombie({ label: "x", priceCents: 74, askCents: null, gsProb: 1, groupSpreadCents: null, bookAgeMin: 5, live: true }, CFG)?.code, "resolved_price");
});
