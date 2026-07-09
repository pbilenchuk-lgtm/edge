import { test } from "node:test";
import assert from "node:assert/strict";
import { oddsToCents, parseMarketBook, toExtracted } from "../src/lib/betfair.js";

test("oddsToCents: decimal odds → implied probability cents", () => {
  assert.equal(oddsToCents(2.0), 50);
  assert.equal(oddsToCents(1.5), 66.7);
  assert.equal(oddsToCents(4.0), 25);
  assert.equal(oddsToCents(0), null);
  assert.equal(oddsToCents(undefined), null);
});

test("parseMarketBook: back/lay → mid/spread + volume", () => {
  const names = { name: "Match Odds", runners: { 47973: "France", 47974: "Morocco", 58805: "The Draw" } };
  const book = {
    marketId: "1.234", inplay: true, totalMatched: 125000,
    runners: [
      { selectionId: 47973, status: "ACTIVE", lastPriceTraded: 1.8, totalMatched: 60000, ex: { availableToBack: [{ price: 1.8, size: 500 }], availableToLay: [{ price: 1.82, size: 400 }] } },
      { selectionId: 47974, status: "ACTIVE", lastPriceTraded: 5.0, totalMatched: 30000, ex: { availableToBack: [{ price: 4.9, size: 200 }], availableToLay: [{ price: 5.1, size: 150 }] } },
    ],
  };
  const m = parseMarketBook(book, names);
  assert.equal(m.marketName, "Match Odds");
  assert.equal(m.inPlay, true);
  assert.equal(m.totalMatched, 125000);
  const fr = m.runners[0];
  assert.equal(fr.runnerName, "France");
  assert.equal(fr.backCents, oddsToCents(1.8)); // ~55.6
  assert.equal(fr.layCents, oddsToCents(1.82)); // ~54.9
  assert.ok(fr.midCents! > fr.layCents! && fr.midCents! < fr.backCents!, "mid between lay and back");
  assert.ok(fr.spreadCents! >= 0);
  assert.equal(fr.lastTradedCents, oddsToCents(1.8));
  assert.equal(fr.matchedVolume, 60000);
});

test("parseMarketBook: empty book side degrades to null, not crash", () => {
  const m = parseMarketBook(
    { marketId: "1.1", runners: [{ selectionId: 1, status: "ACTIVE", ex: {} }] },
    { name: "Over/Under 2.5 Goals", runners: { 1: "Over 2.5 Goals" } },
  );
  assert.equal(m.runners[0].backCents, null);
  assert.equal(m.runners[0].midCents, null);
  assert.equal(m.runners[0].spreadCents, null);
});

test("toExtracted: flattens to snapshot market rows", () => {
  const ext: any = toExtracted([
    { marketId: "1.1", marketName: "Match Odds", inPlay: true, totalMatched: 100, runners: [
      { selectionId: 1, runnerName: "France", status: "ACTIVE", backCents: 55, layCents: 54, midCents: 54.5, spreadCents: 1, lastTradedCents: 55, matchedVolume: 60 },
    ] },
  ]);
  assert.equal(ext.source, "betfair-exchange");
  assert.equal(ext.markets.length, 1);
  assert.equal(ext.markets[0].market, "Match Odds");
  assert.equal(ext.markets[0].selection, "France");
  assert.equal(ext.markets[0].midCents, 54.5);
});
