import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, eventToMarketSnapshots } from "../src/lib/polymarket.js";

// Fix #1: markets must carry the EXECUTABLE BUY ask (what a trade pays), not just the mid — so a
// decision's edge is measured against the ask, killing the wide-spread phantom (25.5¢ mid / 44¢ ask).
// The money-critical rule: outcome[0] ask = Gamma bestAsk; the complementary outcome[1] ask = 100 − bestBid
// (buying No = selling Yes at its bid). Never below the mid (that would be a phantom on the other side).

const NOW = "2026-07-15T23:00:00.000Z";
const rawEvent = (markets: any[]) => ({ id: "e1", slug: "s", title: "A vs B", markets });

test("executable ask: a 2-way BTTS expands into Yes=bestAsk and No=100−bestBid (the Orlando 44¢ case)", () => {
  const ev = normalizeEvent(rawEvent([{
    groupItemTitle: "Both Teams to Score", outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.745", "0.255"]), clobTokenIds: JSON.stringify(["tYes", "tNo"]),
    bestBid: "0.56", bestAsk: "0.85", spread: "0.29", liquidity: "200",
  }]));
  const snaps = eventToMarketSnapshots(ev, NOW);
  const yes = snaps.find((s) => /Yes/.test(s.label))!;
  const no = snaps.find((s) => /No/.test(s.label))!;
  assert.equal(yes.askCents, 85, "Yes side ask = Gamma bestAsk");
  assert.equal(no.askCents, 44, "No side ask = 100 − bestBid(56) = 44 — reproduces the real Orlando ask");
  assert.equal(no.price, 25.5, "No mid is still the misleading 25.5¢");
  assert.ok((no.askCents as number) >= no.price, "ask never below the mid (no inverse phantom)");
  assert.equal(no.spreadCents, 29);
});

test("executable ask: a directional single (Over 2.5) uses its own market's bestAsk", () => {
  const ev = normalizeEvent(rawEvent([{
    question: "Over 2.5", outcomes: JSON.stringify(["Over", "Under"]),
    outcomePrices: JSON.stringify(["0.55", "0.45"]), clobTokenIds: JSON.stringify(["tO", "tU"]),
    bestBid: "0.53", bestAsk: "0.58", spread: "0.05", liquidity: "500",
  }]));
  const snaps = eventToMarketSnapshots(ev, NOW);
  const over = snaps.find((s) => /Over/i.test(s.label))!;
  assert.equal(over.askCents, 58, "directional single → its own bestAsk, no complement");
});

test("executable ask: no book fields → askCents null (edge falls back to mid, flagged)", () => {
  const ev = normalizeEvent(rawEvent([{
    question: "Under 2.5", outcomes: JSON.stringify(["Under", "Over"]),
    outcomePrices: JSON.stringify(["0.6", "0.4"]), clobTokenIds: JSON.stringify(["tU", "tO"]),
    liquidity: "500", // no bestBid/bestAsk/spread
  }]));
  const snaps = eventToMarketSnapshots(ev, NOW);
  const u = snaps.find((s) => /Under/i.test(s.label))!;
  assert.equal(u.askCents, null);
  assert.equal(u.spreadCents, null);
});

test("executable ask: a tight liquid book keeps ask ≈ mid (no phantom, edge barely moves)", () => {
  const ev = normalizeEvent(rawEvent([{
    question: "Spain", outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.58", "0.42"]), clobTokenIds: JSON.stringify(["tY", "tN"]),
    bestBid: "0.579", bestAsk: "0.58", spread: "0.001", liquidity: "6000000",
  }]));
  const snaps = eventToMarketSnapshots(ev, NOW);
  const s = snaps.find((x) => /Spain/.test(x.label))!;
  assert.equal(s.askCents, 58, "tight book: ask = mid, edge basis unchanged");
  assert.equal(s.spreadCents, 0.1);
});
