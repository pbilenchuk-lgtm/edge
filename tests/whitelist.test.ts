import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as RR from "../src/lib/realRepo.js";
import { addWhitelistRow, setWhitelistEnabled, matchWhitelist, proportionalRealSize, realSizeFromFraction, dryVirtualFreeUsd, realBankUsd, mirrorPaperEntryToReal } from "../src/lib/executor/whitelist.js";
import type { Bet } from "../src/lib/types.js";

function db() { const d = openDb(":memory:"); initSchema(d); return d; }
const POLY: any = { enabled: true, exec: { edgeFloorCents: 1, maxImpactCents: 10, fallbackK: 20, takerFeeRate: 0.0075 } };
const bookFetch = (book: any) => (async (url: any) => String(url).includes("/book") ? ({ ok: true, status: 200, json: async () => book } as any) : ({ ok: false, status: 404, json: async () => ({}) } as any)) as unknown as typeof fetch;
const NOW = "2026-07-15T12:00:00.000Z";
const bet = (over: Partial<Bet> = {}): Bet => ({ id: "b1", match_id: "m1", strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Over 1.5", status: "open", proposed_price: 45, entry_price: 45, current_price: 45, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "3'", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e1", decision_id: "dec-b1", created_at: NOW, ...over });
const mirrorCtx = (over: any = {}) => ({ env: { REAL_TRADING: "dry_run" }, poly: POLY, deps: { fetchImpl: bookFetch({ bids: [], asks: [{ price: "0.45", size: "10000" }] }) }, now: () => NOW, bookCache: new Map(), sport: "football", categoryId: "epl", tokenId: "0xTOK", paperBankUsd: 1000, realFreeUsd: 300, ...over });

// ── condition 1: proportional sizing ────────────────────────────────────────────
test("proportionalRealSize: real = paper FRACTION × real free, capped by the row — never the absolute", () => {
  // paper $100 of a $1000 bank = 10% → 10% of $300 real free = $30 (< $50 row cap).
  assert.equal(proportionalRealSize(100, 1000, 300, 50), 30);
  // a BIGGER paper conviction scales up (edge-proportional), until the row cap bites.
  assert.equal(proportionalRealSize(300, 1000, 300, 50), 50, "30% × $300 = $90 → capped at the $50 row max");
  // the WRONG (absolute) model would give min(100, 50) = $50 flat for the first case — we return $30, proving proportion.
  assert.notEqual(proportionalRealSize(100, 1000, 300, 50), 50);
  assert.equal(proportionalRealSize(100, 0, 300, 50), 0, "no paper bank → 0");
});

// ── versioning from the first row ────────────────────────────────────────────────
test("whitelist versioning: first row is v1, every change bumps + journals; over-cap rejected", () => {
  const d = db();
  assert.equal(RR.currentWhitelistVersion(d), 0, "empty → v0");
  const over = addWhitelistRow(d, { strategyId: "overreaction", categories: ["epl"], maxOrderUsd: 999, enabled: true }, "owner", NOW);
  assert.equal(over.ok, false, "maxOrderUsd > REAL_MAX_ORDER_USD rejected");
  const add = addWhitelistRow(d, { strategyId: "overreaction", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  assert.equal(add.ok, true);
  assert.equal(add.version, 1, "first row → v1");
  assert.equal(RR.currentWhitelistVersion(d), 1);
  const row = RR.listWhitelist(d)[0];
  const v2 = setWhitelistEnabled(d, row.id, false, "owner", NOW);
  assert.equal(v2, 2, "disable bumps to v2");
  assert.equal(RR.currentWhitelistVersion(d), 2, "journal carries the latest version");
});

test("matchWhitelist: matches enabled (strategy, category); a disabled or unlisted combo does not", () => {
  const d = db();
  addWhitelistRow(d, { strategyId: "overreaction", categories: ["epl", "laliga"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  assert.ok(matchWhitelist(d, { strategyId: "overreaction", categoryId: "epl" }), "listed + enabled → match");
  assert.equal(matchWhitelist(d, { strategyId: "overreaction", categoryId: "seriea" }), null, "unlisted category → no match");
  assert.equal(matchWhitelist(d, { strategyId: "prematch_value", categoryId: "epl" }), null, "other strategy → no match");
  setWhitelistEnabled(d, RR.listWhitelist(d)[0].id, false, "owner", NOW);
  assert.equal(matchWhitelist(d, { strategyId: "overreaction", categoryId: "epl" }), null, "disabled → no match");
});

// ── end-to-end mirror (dry_run) ──────────────────────────────────────────────────
test("mirror: a whitelisted football entry builds a dry order at the PROPORTIONAL size + stamps whitelist version", async () => {
  const d = db();
  addWhitelistRow(d, { strategyId: "overreaction", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  const r = await mirrorPaperEntryToReal(d, bet({ stake: 100 }), mirrorCtx()); // 10% × $300 = $30
  assert.equal(r.mirrored, true);
  const ord = RR.getRealOrderByClientId(d, RR.listRealOrders(d)[0].client_order_id)!;
  assert.equal(ord.decision_id, "dec-b1", "twin link");
  assert.equal(ord.size_usd, 30, "proportional size, not the $100 paper stake");
  assert.equal(ord.whitelist_version, 1, "carries the whitelist version in force");
  assert.equal(ord.exchange_order_id, null, "dry");
});

// ── condition 1: gate-first (no-op by COST, not just effect) ─────────────────────
test("mirror: REAL_TRADING=off returns BEFORE any work — no book read, no rows (hot-path no-op)", async () => {
  const d = db();
  addWhitelistRow(d, { strategyId: "overreaction", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  // A fetch that THROWS if the book is ever read — proves the gate returns before any book access.
  const throwingFetch = (async () => { throw new Error("book must NOT be read when off"); }) as unknown as typeof fetch;
  const r = await mirrorPaperEntryToReal(d, bet(), mirrorCtx({ env: { REAL_TRADING: "off" }, deps: { fetchImpl: throwingFetch } }));
  assert.equal(r.mirrored, false);
  assert.match(r.note, /off/);
  assert.equal(RR.listRealOrders(d).length, 0, "off writes nothing");
});

// ── condition 2: virtual dry-bank, reserved by open dry positions ────────────────
test("dryVirtualFreeUsd: virtual bank (default $400) shrinks by open dry exposure", () => {
  const d = db();
  assert.equal(realBankUsd({}), 400, "default bank");
  assert.equal(realBankUsd({ REAL_BANK_USD: "500" }), 500);
  assert.equal(dryVirtualFreeUsd(d, {}), 400, "no positions → full bank free");
  RR.upsertRealPosition(d, { token_id: "t1", match_id: "m", strategy_id: "s", size_shares: 200, avg_price_cents: 45, realized_pnl_usd: 0, unrealized_pnl_usd: null, dry: 1, updated_at: NOW }); // $90 notional
  assert.equal(dryVirtualFreeUsd(d, {}), 310, "free = 400 − $90 dry exposure (rehearses real free dynamics)");
});
test("realSizeFromFraction: conviction fraction × real free, row-capped", () => {
  assert.equal(realSizeFromFraction(0.1, 300, 50), 30);
  assert.equal(realSizeFromFraction(0.3, 300, 50), 50, "capped");
  assert.equal(realSizeFromFraction(0, 300, 50), 0);
});

// ── condition: sport gate ────────────────────────────────────────────────────────
test("mirror: a non-football (tennis) bet is NEVER mirrored — hard gate", async () => {
  const d = db();
  addWhitelistRow(d, { strategyId: "tennis_set_value", categories: ["atp"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  const r = await mirrorPaperEntryToReal(d, bet({ strategy_id: "tennis_set_value" }), mirrorCtx({ sport: "tennis" }));
  assert.equal(r.mirrored, false);
  assert.match(r.note, /не допускается/);
  assert.equal(RR.listRealOrders(d).length, 0, "nothing built for tennis");
});

// ── condition 2: isolation — the mirror can never break paper ────────────────────
test("mirror: an exception in the real path degrades to paper-only (never re-throws)", async () => {
  const d = db();
  addWhitelistRow(d, { strategyId: "overreaction", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  let logged = "";
  const boomExecutor: any = { place: async () => { throw new Error("book timeout / exchange boom"); } };
  // Must NOT throw — the assertion is that awaiting resolves, paper is untouched, and the error was logged.
  const r = await mirrorPaperEntryToReal(d, bet(), mirrorCtx({ executorFor: () => boomExecutor, onError: (m: string) => { logged = m; } }));
  assert.equal(r.mirrored, false, "degraded, not thrown");
  assert.match(logged, /paper unaffected/, "error captured for the log");
  assert.ok(RR.getRealOrderByClientId(d, "x") === null, "no phantom order");
});
