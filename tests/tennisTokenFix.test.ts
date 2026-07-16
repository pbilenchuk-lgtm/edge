// ============================================================
// token-fix-m1 — the FOURTH orientation bug (Mrva–Roncadelli "73¢ @ 25¢"): the tennis buyback always
// transacted outcomes[0]'s token, but reasoned/sized/settled on the FAVOURITE. When the favourite was
// the SECOND moneyline outcome the position HELD THE WRONG PLAYER. These tests pin the fix: the
// favourite's OWN token is bought at entry and sold at exit (favTokenOf), the runtime orientation
// invariant blocks a flipped token, and pre-fix wrong-token bets are quarantined out of calibration.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { serializeEntryMeta, parseEntryMeta } from "../src/lib/betMeta.js";
import { favTokenOf, tennisMoneyline, type TennisMoneyline } from "../src/lib/tennisScout.js";
import { tennisTradingTick, tennisExitTick, migrateQuarantinePoisonedTennis, tennisPanicThresholds } from "../src/lib/tennisTrading.js";
import { migrateTennisStrategy, migrateTennisSetValueStrategy } from "../src/lib/seed.js";
import { betRecords } from "../src/lib/profileAnalytics.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
// Seed a tennis match + ONE moneyline "ATP: p1 vs p2" carrying BOTH outcome tokens (external_ref =
// outcomes[0]/p1 token, token_second = outcomes[1]/p2 token). `p1price` = P(p1) in cents.
function seedMatch(db: ReturnType<typeof openDb>, o: { p1: string; p2: string; p1price: number; book?: number; token1?: string; token2?: string | null; mid?: string }) {
  migrateTennisStrategy(db); migrateTennisSetValueStrategy(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const mid = o.mid ?? R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-atp", home: o.p1, away: o.p2, state: "live", lineup_out: true, kickoff_at: "2026-07-14T09:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  R.insertMarket(db, { id: R.uid(), match_id: mid, label: `ATP: ${o.p1} vs ${o.p2}`, price: o.p1price, ai_prob: null, liquidity: String(o.book ?? 8000), external_ref: o.token1 ?? "t1", token_second: o.token2 === undefined ? "t2" : o.token2, snapshot_at: "t", is_closing: false });
  return mid;
}
function snap(db: ReturnType<typeof openDb>, mid: string, o: { at: string; p1: string; p2: string; g1: number; g2: number; server: "first" | "second" | null; p1c: number | null; setNum?: number; live?: number; status?: string }) {
  R.insertTennisSnapshot(db, { event_key: "EX", provider: "apitennis", batch_at: o.at, p1: o.p1, p2: o.p2, tournament: "Granby", event_type: "ATP Singles", live: o.live ?? 1, status: o.status ?? "live", sets_p1: 0, sets_p2: 0, set_num: o.setNum ?? 1, games_p1: o.g1, games_p2: o.g2, game_points: null, server: o.server, pm_match_id: mid, pm_mid_cents: o.p1c, pm_p1_cents: o.p1c, pm_p2_cents: o.p1c == null ? null : 100 - o.p1c, raw: "{}" } as any);
}
// A fetchImpl that answers the CLOB /book per token_id AND the LLM. `books[token]` → that token's book.
function tokenBookAndLLM(books: Record<string, { bids: [number, number][]; asks: [number, number][] }>, pickLabel: string, prob = 0.5) {
  const toBook = (b: { bids: [number, number][]; asks: [number, number][] }) => ({ bids: b.bids.map(([p, s]) => ({ price: String(p), size: String(s) })), asks: b.asks.map(([p, s]) => ({ price: String(p), size: String(s) })) });
  return (async (url: any) => {
    const u = String(url);
    if (u.includes("/book")) {
      const tok = (u.match(/token_id=([^&]+)/) ?? [])[1] ?? "";
      const b = books[tok];
      return b ? ({ ok: true, status: 200, json: async () => toBook(b) } as any) : ({ ok: true, status: 200, json: async () => ({ bids: [], asks: [] }) } as any);
    }
    return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ picks: [{ label: pickLabel, prob, reason: "выкуп переоценки" }] }) }] }) } as any;
  }) as unknown as typeof fetch;
}
const ML = (o: Partial<TennisMoneyline>): TennisMoneyline => ({ p1Cents: 50, p2Cents: 50, label: "ATP: U vs F", token: "t1", tokenSecond: "t2", liquidity: 8000, firstIsP1: true, ...o });

// ── A. favTokenOf: the favourite's OWN outcome token, by (favSide, firstIsP1) ────────────────────
test("favTokenOf: resolves the favourite's token from favSide × firstIsP1 (both orderings)", () => {
  // moneyline order == scout order (p1 == outcomes[0])
  assert.equal(favTokenOf(ML({ firstIsP1: true }), "first"), "t1", "fav=p1=outcome0 → token");
  assert.equal(favTokenOf(ML({ firstIsP1: true }), "second"), "t2", "fav=p2=outcome1 → tokenSecond (the bug's case)");
  // moneyline order REVERSED vs scout order (p1 == outcomes[1])
  assert.equal(favTokenOf(ML({ firstIsP1: false }), "first"), "t2", "fav=p1 but p1 is outcome1 → tokenSecond");
  assert.equal(favTokenOf(ML({ firstIsP1: false }), "second"), "t1", "fav=p2 but p2 is outcome0 → token");
  // second-outcome token not persisted → null → caller HONEST-SKIPS (never transacts the wrong side)
  assert.equal(favTokenOf(ML({ firstIsP1: true, tokenSecond: null }), "second"), null);
});

// ── B. tennisMoneyline surfaces token_second from the market row ──────────────────────────────────
test("tennisMoneyline: exposes BOTH outcome tokens (token = outcomes[0], tokenSecond = outcomes[1])", () => {
  const db = openDb(":memory:");
  const mid = seedMatch(db, { p1: "Underdog U", p2: "Favorito F", p1price: 30, token1: "tok-U", token2: "tok-F" });
  const ml = tennisMoneyline(db, mid, { p1: "Underdog U", p2: "Favorito F" })!;
  assert.equal(ml.token, "tok-U", "external_ref = first outcome (p1) token");
  assert.equal(ml.tokenSecond, "tok-F", "token_second = second outcome (p2) token");
  assert.equal(ml.firstIsP1, true);
  assert.equal(favTokenOf(ml, "second"), "tok-F", "favourite = second outcome → holds F's token, not U's");
});

// ── C. ENTRY: favourite = SECOND → buys token_second (the fix routes to F's token, not U's) ────────
test("tennisTradingTick: favourite is the SECOND player → entry BUYS token_second (F's own token)", async () => {
  const db = openDb(":memory:");
  // p1 = underdog (outcomes[0]/t1); p2 = FAVOURITE (outcomes[1]/t2). Pre-break P(p1)=38 → favourite p2=62.
  const mid = seedMatch(db, { p1: "Underdog U", p2: "Favorito F", p1price: 38, token1: "t1", token2: "t2" });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", p1: "Underdog U", p2: "Favorito F", g1: 3, g2: 3, server: "second", p1c: 38, setNum: 1 }); // pre-break: favourite (second) serving
  snap(db, mid, { at: "2026-07-14T10:02:00Z", p1: "Underdog U", p2: "Favorito F", g1: 4, g2: 3, server: "first", p1c: 50, setNum: 1 });  // favourite's serve broken (server "second" lost) → panics to 50
  // Book keyed by token: the FAVOURITE's token (t2) has a coherent book near the favourite price (~50¢);
  // the underdog token (t1) is left EMPTY. So a correct fill (t2) succeeds; the old wrong-token fill (t1) would skip.
  const fetchImpl = tokenBookAndLLM({ t2: { bids: [[0.49, 2000]], asks: [[0.51, 2000]] } }, "Favorito F", 0.7);
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { ANTHROPIC_API_KEY: "k", POLYMARKET_ENABLED: "true" }, fetchImpl });
  assert.ok(opened >= 1, "opened on the FAVOURITE's token (t2) — the underdog token (t1) had no book");
  const bets = R.betsForMatch(db, mid, "tennis_overreaction").filter((b) => b.status === "open");
  assert.ok(bets.length >= 1 && bets.every((b) => b.market_label === "Favorito F"), "bet is on the favourite (second-named)");
  const em = parseEntryMeta(bets[0].entry_meta);
  assert.equal(em?.favSide, "second", "orientation PINNED on the bet: favourite = second");
  assert.equal(em?.firstIsP1, true, "moneyline order recorded so the exit resolves the SAME token");
});

// ── D. EXIT: favourite = SECOND → SELLS token_second at the favourite's price, not the opponent's ──
test("tennisExitTick: favourite = SECOND → take SELLS token_second (F's bid), not outcomes[0]'s (the 73¢@25¢ bug)", async () => {
  const db = openDb(":memory:");
  const mid = seedMatch(db, { p1: "Maxim Mrva", p2: "Franco Roncadelli", p1price: 40, token1: "t-mrva", token2: "t-ronca" });
  // Open buyback on the FAVOURITE (Roncadelli = p2). take_price at 59.
  R.insertBet(db, { id: "flip", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Franco Roncadelli", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", favSide: "second", firstIsP1: true, exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Favourite (Roncadelli = second) recovered to 73¢ → take fires. p1c(Mrva)=27 → p2c(Roncadelli)=73.
  snap(db, mid, { at: "2026-07-14T10:10:00Z", p1: "Maxim Mrva", p2: "Franco Roncadelli", g1: 2, g2: 4, server: "first", p1c: 27, setNum: 2 });
  // Both tokens have live bids on OPPOSITE sides: Roncadelli (t-ronca) bids at 73¢, Mrva (t-mrva) at 25¢.
  const fetchImpl = tokenBookAndLLM({ "t-ronca": { bids: [[0.73, 3000]], asks: [[0.75, 3000]] }, "t-mrva": { bids: [[0.25, 3000]], asks: [[0.27, 3000]] } }, "x");
  const n = await tennisExitTick(db, { now: () => "2026-07-14T10:10:05Z", env: { POLYMARKET_ENABLED: "true" }, fetchImpl });
  assert.equal(n, 1, "take_price fired");
  const b = R.getBet(db, "flip")!;
  assert.ok((b.closing_price ?? 0) >= 71, `SOLD Roncadelli's own token at the 73¢ bid (−fee) — NOT Mrva's 25¢; got ${b.closing_price}`);
  assert.equal(b.status, "settled_won", "favourite bought at 50 → sold at ~73 = a WIN (was booked as a −$6.49 loss on the wrong token)");
});

// ── D2. Runtime invariant: a token priced on the WRONG side is BLOCKED, not sold ──────────────────
test("tennisExitTick: orientation invariant BLOCKS a sell when the token's bid is ~100−price (flip guard)", async () => {
  const db = openDb(":memory:");
  const mid = seedMatch(db, { p1: "Maxim Mrva", p2: "Franco Roncadelli", p1price: 40, token1: "t-mrva", token2: "t-ronca" });
  R.insertBet(db, { id: "guard", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Franco Roncadelli", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", favSide: "second", firstIsP1: true, exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  snap(db, mid, { at: "2026-07-14T10:10:00Z", p1: "Maxim Mrva", p2: "Franco Roncadelli", g1: 2, g2: 4, server: "first", p1c: 27, setNum: 2 }); // favourite (second) = 73¢
  // The favourite's token (t-ronca) returns a book priced at 25¢ — as if it were the WRONG side (Δ48¢ > tol).
  const fetchImpl = tokenBookAndLLM({ "t-ronca": { bids: [[0.25, 3000]], asks: [[0.27, 3000]] } }, "x");
  const n = await tennisExitTick(db, { now: () => "2026-07-14T10:10:05Z", env: { POLYMARKET_ENABLED: "true" }, fetchImpl });
  assert.equal(n, 0, "the sell is BLOCKED — never realizes on a token priced on the wrong side");
  assert.equal(R.getBet(db, "guard")!.status, "open", "position HELD to settle, not dumped");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /token_orientation_mismatch/.test(l.text ?? "")), "loud token_orientation_mismatch alert");
});

// ── E. Missing token_second → honest skip (hold), never a wrong-token transaction ─────────────────
test("tennisExitTick: favourite = SECOND but token_second not persisted → exit BLOCKED (hold to settle)", async () => {
  const db = openDb(":memory:");
  const mid = seedMatch(db, { p1: "Underdog U", p2: "Favorito F", p1price: 40, token1: "t1", token2: null }); // no second token
  R.insertBet(db, { id: "noTok", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Favorito F", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", favSide: "second", firstIsP1: true, exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  snap(db, mid, { at: "2026-07-14T10:10:00Z", p1: "Underdog U", p2: "Favorito F", g1: 2, g2: 4, server: "first", p1c: 27, setNum: 2 }); // favourite = 73¢, take fires
  const fetchImpl = tokenBookAndLLM({ t1: { bids: [[0.27, 3000]], asks: [[0.29, 3000]] } }, "x");
  const n = await tennisExitTick(db, { now: () => "2026-07-14T10:10:05Z", env: { POLYMARKET_ENABLED: "true" }, fetchImpl });
  assert.equal(n, 0, "no favourite token → HOLD, never sell outcomes[0] by mistake");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /token_side_unavailable/.test(l.text ?? "")), "token_side_unavailable logged");
});

// ── F. No regression: favourite = FIRST still sells its own (outcomes[0]) token ────────────────────
test("tennisExitTick: favourite = FIRST → sells outcomes[0] token at its bid (unchanged behaviour)", async () => {
  const db = openDb(":memory:");
  const mid = seedMatch(db, { p1: "Favorito F", p2: "Underdog U", p1price: 60, token1: "t-fav", token2: "t-dog" });
  R.insertBet(db, { id: "first", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Favorito F", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", favSide: "first", firstIsP1: true, exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  snap(db, mid, { at: "2026-07-14T10:10:00Z", p1: "Favorito F", p2: "Underdog U", g1: 4, g2: 2, server: "second", p1c: 72, setNum: 2 }); // favourite (first) = 72¢
  const fetchImpl = tokenBookAndLLM({ "t-fav": { bids: [[0.72, 3000]], asks: [[0.74, 3000]] }, "t-dog": { bids: [[0.26, 3000]], asks: [[0.28, 3000]] } }, "x");
  const n = await tennisExitTick(db, { now: () => "2026-07-14T10:10:05Z", env: { POLYMARKET_ENABLED: "true" }, fetchImpl });
  assert.equal(n, 1);
  assert.ok((R.getBet(db, "first")!.closing_price ?? 0) >= 70, "sold the favourite's own outcomes[0] token at 72¢");
});

// ── B8. Exit slippage cap: a TAKE into a dust bid is NOT realized (held + retry), protective still leaves ─
test("tennisExitTick: a TAKE into a dust bid (slip > cap, within orientation tol) is HELD + retried, not realized", async () => {
  const db = openDb(":memory:");
  const mid = seedMatch(db, { p1: "Marco Favvi", p2: "Diego Doggi", p1price: 60, token1: "t-fav", token2: "t-dog" });
  R.insertBet(db, { id: "dust", match_id: mid, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Marco Favvi", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.62, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", favSide: "first", firstIsP1: true, exitPlan: { take_price: { at_cents: 59 } } }), code_version: "e5", created_at: "2026-07-14T10:00:00Z" } as any);
  // Favourite (first) recovered to 72¢ on the scout → take fires. But the live bid is DUST at 57¢:
  // slip = 72−57 ≈ 15¢ > the 10¢ cap, yet < the 28¢ orientation tolerance (so it's dust, not a flip).
  snap(db, mid, { at: "2026-07-14T10:10:00Z", p1: "Marco Favvi", p2: "Diego Doggi", g1: 4, g2: 2, server: "second", p1c: 72, setNum: 2 });
  const fetchImpl = tokenBookAndLLM({ "t-fav": { bids: [[0.57, 3000]], asks: [[0.59, 3000]] } }, "x");
  const n = await tennisExitTick(db, { now: () => "2026-07-14T10:10:05Z", env: { POLYMARKET_ENABLED: "true" }, fetchImpl });
  assert.equal(n, 0, "the take is NOT realized into a dust bid");
  assert.equal(R.getBet(db, "dust")!.status, "open", "position held for a real bid");
  const skips = R.tradeLogForMatch(db, mid).filter((l) => l.type === "skip");
  assert.ok(skips.some((l) => /dust-бид|тейк отложен/.test(l.text ?? "")), "slippage skip logged");
  assert.ok(!skips.some((l) => /token_orientation_mismatch/.test(l.text ?? "")), "NOT mislabelled as an orientation flip (15¢ < 28¢ tol)");
});

// ── Carle. A favourite that levelled to a coin-flip BY the break is not an overreaction setup ──────
test("tennisTradingTick: a favourite whose pre-break price levelled to a coin-flip (49.5¢) is skipped frozen_favourite", async () => {
  const db = openDb(":memory:");
  const mid = seedMatch(db, { p1: "Marta Carle", p2: "Nina Doria", p1price: 62, book: 8000, token1: "t1", token2: "t2" });
  // Pre-MATCH: Carle is a clear favourite (62¢, underdog 38¢) → charge IDs her. But the match TIGHTENS:
  // by the break the pre-break reference has drifted to a coin-flip (49.5¢). There is no favoured level
  // to snap back to → the Overreaction thesis doesn't hold.
  snap(db, mid, { at: "2026-07-14T10:00:00Z", p1: "Marta Carle", p2: "Nina Doria", g1: 0, g2: 0, server: "first", p1c: 62, setNum: 1 }); // pre-match anchor → favourite = first
  snap(db, mid, { at: "2026-07-14T10:02:00Z", p1: "Marta Carle", p2: "Nina Doria", g1: 3, g2: 3, server: "first", p1c: 49.5, setNum: 1 }); // levelled (pre-break reference)
  snap(db, mid, { at: "2026-07-14T10:03:00Z", p1: "Marta Carle", p2: "Nina Doria", g1: 3, g2: 4, server: "second", p1c: 45, setNum: 1 }); // favourite broken → the trigger
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:03:05Z", env: {} }); // no LLM key: the guard must fire BEFORE the strategist call
  assert.equal(opened, 0, "no buyback — the 'favourite' wasn't a favourite at the break");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /frozen_favourite/.test(l.text ?? "")), "frozen_favourite skip logged");
});

// ── B3. Dust real book is CUT at entry even when Gamma declared it healthy (Mrva $44 class) ────────
test("tennisTradingTick: a DUST real book (Gamma-declared healthy) is skipped thin_real_book, not clamped", async () => {
  const db = openDb(":memory:");
  // Favourite = first (Favvi = p1 = t1). Gamma declares $8000 liquidity, but the real ask book is $44.
  const mid = seedMatch(db, { p1: "Marco Favvi", p2: "Diego Doggi", p1price: 62, book: 8000, token1: "t1", token2: "t2" });
  snap(db, mid, { at: "2026-07-14T10:01:00Z", p1: "Marco Favvi", p2: "Diego Doggi", g1: 3, g2: 3, server: "first", p1c: 62, setNum: 1 });  // pre-break favourite serving
  snap(db, mid, { at: "2026-07-14T10:02:00Z", p1: "Marco Favvi", p2: "Diego Doggi", g1: 3, g2: 4, server: "second", p1c: 50, setNum: 1 }); // favourite's serve broken → panics to 50
  // The favourite token's REAL book is dust: 88 shares @ 50¢ = $44 (< $250 floor). Orientation is fine (50¢≈50¢).
  const fetchImpl = tokenBookAndLLM({ t1: { bids: [[0.49, 88]], asks: [[0.50, 88]] } }, "Marco Favvi", 0.7);
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { ANTHROPIC_API_KEY: "k", POLYMARKET_ENABLED: "true" }, fetchImpl });
  assert.equal(opened, 0, "a $44 real book is CUT, not clamped into a dust bet");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /thin_real_book/.test(l.text ?? "")), "thin_real_book logged with the real-vs-declared gap");
  assert.equal(R.betsForMatch(db, mid, "tennis_overreaction").filter((b) => b.status === "open").length, 0, "no dust position opened");
});

// ── B1. A later underdog break must NOT bury an earlier qualifying favourite EARLY break ──────────
test("tennisTradingTick: a favourite early break is still acted on when a LATER underdog break follows it", async () => {
  const db = openDb(":memory:");
  const mid = seedMatch(db, { p1: "Marco Favvi", p2: "Diego Doggi", p1price: 62, book: 8000, token1: "t1", token2: "t2" });
  // Break 1 = the FAVOURITE (first) broken in set 1 (the qualifying setup). Break 2 = the UNDERDOG
  // (second) broken right after — the most-recent break. Old code looked only at breaks[last] (the
  // underdog break), gate-skipped it, and NEVER saw the favourite break. B1 iterates freshest-first.
  snap(db, mid, { at: "2026-07-14T10:01:00Z", p1: "Marco Favvi", p2: "Diego Doggi", g1: 3, g2: 3, server: "first", p1c: 62, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", p1: "Marco Favvi", p2: "Diego Doggi", g1: 3, g2: 4, server: "second", p1c: 55, setNum: 1 }); // fav (first) broken → br1
  snap(db, mid, { at: "2026-07-14T10:03:00Z", p1: "Marco Favvi", p2: "Diego Doggi", g1: 4, g2: 4, server: "first", p1c: 50, setNum: 1 });  // underdog (second) broken → br2 (most recent)
  const fetchImpl = tokenBookAndLLM({ t1: { bids: [[0.49, 2000]], asks: [[0.50, 2000]] } }, "Marco Favvi", 0.7);
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:03:05Z", env: { ANTHROPIC_API_KEY: "k", POLYMARKET_ENABLED: "true" }, fetchImpl });
  assert.ok(opened >= 1, "the favourite's early break was acted on, not buried by the later underdog break");
  assert.ok(R.betsForMatch(db, mid, "tennis_overreaction").some((b) => b.status === "open" && b.market_label === "Marco Favvi"), "buyback opened on the favourite");
});

// ── B6. Panic-depth quantiles: pool = ATP+WTA early, volume floor, per-profile min-drop entry gate ─
test("tennisPanicThresholds: interim below the volume floor; quantiles above it; Challenger + late excluded", () => {
  const db = openDb(":memory:");
  assert.equal(tennisPanicThresholds(db).source, "interim", "empty → interim floors");
  const mk = (evt: string, early: boolean, panic: number, i: number) => R.insertTennisBreakMark(db, { event_key: `e${evt}${i}`, match_id: null, players: null, tournament: null, event_type: evt, set_num: 1, broken_side: "first", broke_early: early ? 1 : 0, t_event: "t", pre_cents: 60, floor_cents: 60 - panic, t_floor_sec: 60, panic_cents: panic, recovery_1: null, recovery_2: null, recovery_3: null, recovery_5: null, window_quotes: 3, confidence_flags: null, code_version: "e", created_at: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z` } as any);
  // 250 in-scope ATP-early marks with panic ramping 1..25¢ → clear quantiles.
  for (let i = 0; i < 250; i++) mk("ATP Singles", true, 1 + (i % 25), i);
  // Noise that must NOT enter the pool: Challenger-early (huge) + ATP-LATE (huge). If they leaked, the
  // quantiles would be pulled far higher than the ATP-early distribution.
  for (let i = 0; i < 250; i++) mk("ATP Challenger", true, 90, 300 + i);
  for (let i = 0; i < 250; i++) mk("ATP Singles", false, 90, 600 + i);
  const th = tennisPanicThresholds(db);
  assert.equal(th.source, "quantile");
  assert.equal(th.n, 250, "pool is ONLY the 250 ATP-early marks (Challenger + late excluded)");
  assert.ok(th.aggressive < th.medium && th.medium < th.conservative, "p40 < p60 < p80");
  assert.ok(th.conservative <= 25, "quantiles bounded by the ATP-early range, NOT pulled to the 90¢ noise");
});

test("tennisTradingTick B6: a shallow panic enters aggressive+medium but is too thin for conservative", async () => {
  const db = openDb(":memory:");
  // Interim thresholds (no marks): aggressive 2¢ / medium 3.5¢ / conservative 6¢.
  const mid = seedMatch(db, { p1: "Marta Favvi", p2: "Nina Doria", p1price: 62, token1: "t1", token2: "t2" });
  // Pre-break favourite 56¢ (≥52 passes the frozen-favourite guard), panics to 52¢ → drop 4¢:
  // ≥ aggressive(2) and medium(3.5), but < conservative(6).
  snap(db, mid, { at: "2026-07-14T10:01:00Z", p1: "Marta Favvi", p2: "Nina Doria", g1: 3, g2: 3, server: "first", p1c: 56, setNum: 1 });
  snap(db, mid, { at: "2026-07-14T10:02:00Z", p1: "Marta Favvi", p2: "Nina Doria", g1: 3, g2: 4, server: "second", p1c: 52, setNum: 1 });
  const body = { content: [{ text: JSON.stringify({ picks: [{ label: "Marta Favvi", prob: 0.6, reason: "выкуп" }] }) }] };
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch; // exec off (no POLYMARKET) → quote fill
  const opened = await tennisTradingTick(db, { now: () => "2026-07-14T10:02:05Z", env: { ANTHROPIC_API_KEY: "k" }, fetchImpl });
  assert.equal(opened, 2, "aggressive + medium enter on the 4¢ panic; conservative does not");
  const profiles = R.betsForMatch(db, mid, "tennis_overreaction").filter((b) => b.status === "open").map((b) => b.risk_profile_id).sort();
  assert.deepEqual(profiles, ["aggressive", "medium"], "conservative skipped — 4¢ < its 6¢ floor");
  assert.ok(R.tradeLogForMatch(db, mid).some((l) => /\[conservative\].*паника 4¢ < порога 6¢/.test(l.text ?? "")), "conservative skip logged with the depth gate");
  // The admitting threshold is FROZEN on each bet.
  const em = parseEntryMeta(R.betsForMatch(db, mid, "tennis_overreaction").find((b) => b.status === "open")!.entry_meta);
  assert.equal(em?.panicDropCents, 4);
});

// ── G. Quarantine: flag pre-fix second-outcome bets; leave first-outcome + post-fix bets alone ─────
test("migrateQuarantinePoisonedTennis: flags ONLY pre-fix bets that held the wrong (second-outcome) token", () => {
  const db = openDb(":memory:");
  // match1: favourite = SECOND (moneyline "U vs F", F=p2). A pre-fix bet on F held outcomes[0] (U's token) = poisoned.
  const m1 = seedMatch(db, { p1: "Underdog U", p2: "Favorito F", p1price: 30, mid: "m1", token1: "t1", token2: "t2" });
  snap(db, m1, { at: "2026-07-14T10:00:00Z", p1: "Underdog U", p2: "Favorito F", g1: 1, g2: 1, server: "first", p1c: 30 });
  R.insertBet(db, { id: "poison", match_id: m1, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Favorito F", status: "settled_lost", proposed_price: 50, entry_price: 50, current_price: 25, closing_price: 25, ai_prob: 0.6, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: "lost", payout: 50, settled_by: "early", settled_at: "t", entry_meta: serializeEntryMeta({ phase: "live" }), code_version: "e5·book-fill-m1", created_at: "2026-07-14T10:05:00Z" } as any);
  // match2: favourite = FIRST (moneyline "F2 vs U2", F2=p1). A pre-fix bet on F2 held outcomes[0] = CLEAN.
  const m2 = seedMatch(db, { p1: "Favorito Two", p2: "Underdog Two", p1price: 70, mid: "m2", token1: "t3", token2: "t4" });
  snap(db, m2, { at: "2026-07-14T10:00:00Z", p1: "Favorito Two", p2: "Underdog Two", g1: 1, g2: 1, server: "first", p1c: 70 });
  R.insertBet(db, { id: "clean", match_id: m2, strategy_id: "tennis_overreaction", risk_profile_id: "medium", market_label: "Favorito Two", status: "settled_won", proposed_price: 55, entry_price: 55, current_price: 70, closing_price: 70, ai_prob: 0.6, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: "won", payout: 127, settled_by: "early", settled_at: "t", entry_meta: serializeEntryMeta({ phase: "live" }), code_version: "e5·book-fill-m1", created_at: "2026-07-14T10:05:00Z" } as any);
  // post-fix bet on match1: entry_meta already carries favSide → trusted, never re-flagged.
  R.insertBet(db, { id: "postfix", match_id: m1, strategy_id: "tennis_overreaction", risk_profile_id: "aggressive", market_label: "Favorito F", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "выкуп", entered_minute: "сет 2", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: serializeEntryMeta({ phase: "live", favSide: "second", firstIsP1: true }), code_version: "e5·token-fix-m1", created_at: "2026-07-14T10:06:00Z" } as any);

  const flagged = migrateQuarantinePoisonedTennis(db, "2026-07-14T12:00:00Z");
  assert.equal(flagged, 1, "exactly one poisoned (second-outcome) pre-fix bet");
  assert.equal(parseEntryMeta(R.getBet(db, "poison")!.entry_meta)?.tokenFlipPoisoned, true, "match1 second-outcome bet flagged");
  assert.notEqual(parseEntryMeta(R.getBet(db, "clean")!.entry_meta)?.tokenFlipPoisoned, true, "match2 first-outcome bet NOT flagged");
  assert.notEqual(parseEntryMeta(R.getBet(db, "postfix")!.entry_meta)?.tokenFlipPoisoned, true, "post-fix bet left alone");
  // Idempotent: a second run flags nothing new (marker-guarded).
  assert.equal(migrateQuarantinePoisonedTennis(db, "2026-07-14T12:05:00Z"), 0, "marker-guarded, runs once");

  // Analytics EXCLUDES the poisoned bet from every slice; the clean bet survives.
  const recs = betRecords(db);
  assert.ok(!recs.some((r) => r.id === "poison"), "poisoned bet dropped from the analytics sample");
  assert.ok(recs.some((r) => r.id === "clean"), "clean bet retained");
});
