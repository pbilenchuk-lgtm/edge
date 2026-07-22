import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyZombie, outcomeKey, notationSpreads, loadZombieConfig, type ZombieConfig } from "../src/lib/zombieMarket.js";

const CFG: ZombieConfig = { staleBookMin: 30, notationSpreadCents: 12, resolvedMarginCents: 12 };

test("P1 classifyZombie (a): a game-state-resolved leg priced far below 100¢ is a resolved_price zombie", () => {
  // both teams scored → BTTS-Yes gsProb ≈ 1, but the book still sits at 50¢ (Vardar)
  const z = classifyZombie({ label: "BTTS — Yes", priceCents: 50, gsProb: 1, groupSpreadCents: null, bookAgeMin: 2, live: true }, CFG);
  assert.equal(z?.code, "resolved_price");
});

test("P1 classifyZombie (a): a resolved leg already priced near 100¢ is NOT a zombie (book caught up)", () => {
  const z = classifyZombie({ label: "BTTS — Yes", priceCents: 96, gsProb: 1, groupSpreadCents: null, bookAgeMin: 2, live: true }, CFG);
  assert.equal(z, null);
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
