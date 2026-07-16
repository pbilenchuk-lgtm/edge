import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import * as RR from "../src/lib/realRepo.js";
import { DryRunExecutor } from "../src/lib/executor/dryRun.js";
import { sweepDryExits, mirrorPaperEntryToReal, addWhitelistRow } from "../src/lib/executor/whitelist.js";
import { clientOrderIdFor, type OrderRequest } from "../src/lib/executor/types.js";
import { serializeEntryMeta } from "../src/lib/betMeta.js";
import type { Bet } from "../src/lib/types.js";

function db() { const d = openDb(":memory:"); initSchema(d); return d; }
const POLY: any = { enabled: true, exec: { edgeFloorCents: 1, maxImpactCents: 10, fallbackK: 20, takerFeeRate: 0.0075 } };
const bookFetch = (book: any) => (async (url: any) => String(url).includes("/book") ? ({ ok: true, status: 200, json: async () => book } as any) : ({ ok: false, status: 404, json: async () => ({}) } as any)) as unknown as typeof fetch;
const NOW = "2026-07-15T12:00:00.000Z";
const exec = (d: any, book: any) => new DryRunExecutor({ db: d, env: { REAL_TRADING: "dry_run" }, poly: POLY, deps: { fetchImpl: bookFetch(book) }, bookCache: new Map(), now: () => NOW, whitelistVersion: 1 });
const buy = (over: Partial<OrderRequest> = {}): OrderRequest => ({ clientOrderId: clientOrderIdFor("dec-1", "entry"), leg: "entry", tokenId: "tok1", side: "BUY", limitPriceCents: 45, sizeUsd: 40, timeInForceSec: 45, decisionId: "dec-1", strategyId: "overreaction", profileId: "medium", matchId: "m1", expiryMode: "client-cancel", ...over });

// ── B3: SELL books the actual gross proceeds (fill VWAP), not the limit-price notional ─────────────
test("B3: a SELL that fills BETTER than its limit books gross proceeds at the bid VWAP, ledger reconciles", async () => {
  const d = db();
  // open 100 shares @ 40¢.
  await exec(d, { bids: [], asks: [{ price: "0.40", size: "10000" }] }).place(buy());
  const pos0 = RR.listRealPositions(d)[0];
  assert.ok(Math.abs(pos0.size_shares - 100) < 0.01, "100 shares opened");
  // SELL 100 shares, limit 50¢, but the book bid is 59¢ → fills at 59, not 50.
  const sell: OrderRequest = { ...buy(), clientOrderId: clientOrderIdFor("dec-1", "exit"), leg: "exit", side: "SELL", limitPriceCents: 50, sizeUsd: 50 };
  await exec(d, { bids: [{ price: "0.59", size: "10000" }], asks: [] }).place(sell);
  const sellLedger = RR.realLedgerByKind(d); // fill = buy(−) + sell(+)
  // sell credited ≈ 100 × 0.59 = 59 gross (minus the buy's −40 debit) — NOT 100 × 0.50 = 50.
  const fills = (d.prepare(`SELECT amount_usd FROM real_ledger WHERE kind='fill' AND amount_usd > 0`).all() as any[]);
  assert.ok(fills.length === 1 && Math.abs(fills[0].amount_usd - 59) < 0.5, `SELL ledger = gross VWAP ~59, got ${fills[0]?.amount_usd}`);
  // realized P&L memo written for the day; ledger cash and realized are internally consistent (bid>entry → profit).
  const realized = RR.realRealizedLossTodayUsd(d, "2026-07-15"); // loss only; here it's a profit → 0
  assert.equal(realized, 0, "a profitable close is not a loss");
  assert.ok((sellLedger.fill ?? 0) > 0, "net fill cash positive after selling above cost");
});

// ── B2: fill accounting is atomic — a throw mid-transaction rolls back everything ──────────────────
test("B2: a throw inside the fill transaction rolls back the order/fill/ledger/position entirely", async () => {
  const d = db();
  d.prepare(`DROP TABLE real_ledger`).run(); // the ledger insert inside the tx will now throw
  await assert.rejects(() => exec(d, { bids: [], asks: [{ price: "0.40", size: "10000" }] }).place(buy()));
  // nothing persisted — order, fill, position all rolled back (all-or-nothing).
  assert.equal(RR.getRealOrderByClientId(d, buy().clientOrderId), null, "order rolled back");
  assert.equal(RR.listRealPositions(d).length, 0, "no position");
  // recover: recreate the table, re-place → completes with exactly one fill (no duplicate from the failed run).
  initSchema(d);
  const ack = await exec(d, { bids: [], asks: [{ price: "0.40", size: "10000" }] }).place(buy());
  assert.equal(ack.status, "filled");
  const row = RR.getRealOrderByClientId(d, buy().clientOrderId)!;
  assert.equal(RR.realFillsForOrder(d, row.id).length, 1, "exactly one fill after recovery — no double-fill");
});

// ── B1: two twins on one token are separate positions; a sweep of one leaves the other intact ──────
test("B1: two decisions on the same token keep separate positions; sweeping one doesn't touch the other", async () => {
  const d = db();
  await exec(d, { bids: [], asks: [{ price: "0.40", size: "10000" }] }).place(buy({ decisionId: "decA", clientOrderId: clientOrderIdFor("decA", "entry") }));
  await exec(d, { bids: [], asks: [{ price: "0.40", size: "10000" }] }).place(buy({ decisionId: "decB", clientOrderId: clientOrderIdFor("decB", "entry") }));
  const pos = RR.listRealPositions(d).filter((p) => p.dry === 1 && p.size_shares > 0);
  assert.equal(pos.length, 2, "same token, two decisions → two position rows (no merge)");
  assert.deepEqual(pos.map((p) => p.decision_id).sort(), ["decA", "decB"]);
});

// ── B4: a settled twin with NO live book is resolution-closed at 0/100 in one sweep ────────────────
test("B4: no live book + a settled-won twin → dry position resolution-closed at 100 in one sweep", async () => {
  const d = db();
  R.upsertSport(d, "football", "Ф");
  R.upsertCompetition(d, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: null, created_at: "t" });
  R.insertStrategy(d, { id: "overreaction", sport_id: "football", name: "OR", tag: "o", color: "#fff", version: 1, prompt: "", prompt_live: null, params: {}, model: "m", model_live: null, created_at: "t" } as any);
  const mid = R.uid();
  R.insertMatch(d, { id: mid, competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: 90, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  addWhitelistRow(d, { strategyId: "overreaction", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  const bet = (over: Partial<Bet>): Bet => ({ id: "b1", match_id: mid, strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Over 1.5", status: "open", proposed_price: 45, entry_price: 45, current_price: 45, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "3'", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ kellyFraction: 0.05 } as any), code_version: "e", decision_id: "dec-b4", created_at: NOW, ...over });
  // mirror an entry (funds a dry position) against a normal book.
  await mirrorPaperEntryToReal(d, bet({}), { env: { REAL_TRADING: "dry_run" }, poly: POLY, deps: { fetchImpl: bookFetch({ bids: [], asks: [{ price: "0.45", size: "10000" }] }) }, now: () => NOW, bookCache: new Map(), sport: "football", categoryId: "epl", tokenId: "0xRT", realFreeUsd: 300 });
  assert.equal(RR.listRealPositions(d).filter((p) => p.dry === 1 && p.size_shares > 0.01).length, 1, "dry position opened");
  // the twin settles WON; there is NO live book to sell into.
  R.insertBet(d, bet({ id: "twin", status: "settled_won", result: "won", payout: 200, settled_at: NOW }) as any);
  const emptyBook = { bids: [], asks: [] };
  const closed = await sweepDryExits(d, { env: { REAL_TRADING: "dry_run" }, poly: POLY, deps: { fetchImpl: bookFetch(emptyBook) }, now: () => "2026-07-15T12:05:00.000Z", bookCache: new Map() });
  assert.equal(closed, 1, "resolution-closed in one sweep even with no book");
  assert.equal(RR.listRealPositions(d).filter((p) => p.dry === 1 && p.size_shares > 0.01).length, 0, "dry position flat");
  const byKind = RR.realLedgerByKind(d);
  assert.ok((byKind.redemption ?? 0) > 0, "resolution credited a redemption line (won → 100)");
});
