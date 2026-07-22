import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { buildUnfillableEdge, classifyReason } from "../src/lib/unfillableEdge.js";

test("P2 classifyReason: maps rationale keywords to the canonical reason vocabulary", () => {
  assert.equal(classifyReason("zombie_quarantine:resolved_price — game-state P≈1"), "zombie_resolved");
  assert.equal(classifyReason("zombie_quarantine:notation_desync"), "zombie_notation");
  assert.equal(classifyReason("depth_floor_skip: книга дала лишь $14 < floor $50 — глубины нет"), "depth_floor");
  assert.equal(classifyReason("stale_proposal — цена ушла от предложения"), "stale_proposal");
  assert.equal(classifyReason("«X» — сумма пары 200¢ вне допуска (prob_sum_block)"), "incoherent_book");
  assert.equal(classifyReason("плейсхолдер ~50¢ (нет реальной книги)"), "untradeable");
  assert.equal(classifyReason("нет рынка"), "no_market");
  assert.equal(classifyReason(""), "other");
});

function snap(db: any, matchId: string, label: string, asks: [number, number][], at: string) {
  const usd = asks.reduce((s, [p, sh]) => s + sh * (p / 100), 0);
  db.prepare(`INSERT INTO book_depth_snapshots (id, match_id, token_id, label, source, best_bid_cents, best_ask_cents, bid_depth_usd, ask_depth_usd, bids_json, asks_json, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(R.uid(), matchId, "tok-" + label, label, "periodic", asks[0]?.[0] ?? null, asks[0]?.[0] ?? null, usd, usd, "[]", JSON.stringify(asks), at);
}

test("P2 unfillable_edge: signals cut by fillability/reason, league coverage tier, and the F3 non-zombie side check", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "Pre-match Value", tag: "v", color: "#5b9bd5", version: 1, model: "m", model_live: "m", created_at: "t", prompt: "p", prompt_live: null, params: {} } as any);
  R.upsertCompetition(db, { id: "pm-svn", sport_id: "football", name: "Prva Liga", budget: 8000, external_league: "svn.1", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-svn", home: "Celje", away: "Maribor", state: "finished", lineup_out: true, kickoff_at: "2026-07-20T12:00:00Z", minute: null, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: mid });
  const T = "2026-07-20T12:00:00Z";
  const now = Date.parse("2026-07-22T12:00:00Z");
  const mk = (over: Partial<any>) => ({ id: R.uid(), match_id: mid, strategy_id: "prematch_value", risk_profile_id: "medium", market_label: "M", status: "not_filled", proposed_price: 40, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake: 60, rationale: "r", entered_minute: null, result: null, payout: null, created_at: T, ...over } as any);
  // 2 filled settled (F3: one won, one lost → winRate 0.5); both count as fillable signals.
  R.insertBet(db, mk({ market_label: "Home Win", status: "settled_won", entry_price: 40, payout: 150, result: "won" }));
  R.insertBet(db, mk({ market_label: "Home Win", status: "settled_lost", entry_price: 40, payout: 0, result: "lost" }));
  // not_filled, but the frozen book WAS deep enough (≥$50 within ≤3¢) → fillable despite the stale-proposal block.
  R.insertBet(db, mk({ market_label: "Deep Mkt", status: "not_filled", rationale: "stale_proposal — цена ушла" }));
  snap(db, mid, "Deep Mkt", [[41, 200]], T); // 200sh × 0.41 = $82 within 40+3
  // not_filled, book too thin within band → unfillable.
  R.insertBet(db, mk({ market_label: "Thin Mkt", status: "not_filled", rationale: "depth_floor_skip: глубины нет" }));
  snap(db, mid, "Thin Mkt", [[41, 50]], T);   // 50sh × 0.41 = $20.5 < $50
  // not_filled, no snapshot → unknown fillability.
  R.insertBet(db, mk({ market_label: "NoSnap Mkt", status: "not_filled", rationale: "depth_floor_skip: глубины нет" }));
  // not_filled zombie → unfillable by construction, no book probe.
  R.insertBet(db, mk({ market_label: "Zomb Mkt", status: "not_filled", rationale: "zombie_quarantine:resolved_price — событие свершилось" }));

  const rep = buildUnfillableEdge(db, { nowMs: now, windowDays: 14, env: { FOOTBALL_MIN_DEPTH_USD: "50" } });
  assert.equal(rep.totals.signals, 6);
  assert.equal(rep.totals.filled, 2);
  assert.equal(rep.totals.unfilled, 4);
  assert.equal(rep.totals.fillable, 3, "2 filled + 1 deep-book not_filled");
  assert.equal(rep.totals.unfillable, 2, "thin book + zombie");
  assert.equal(rep.totals.unknownFillability, 1, "NoSnap has no book snapshot in window");
  assert.equal(rep.totals.potentialStakeUsd, 240, "4 unfilled × $60");
  // reason cut
  const reasons = Object.fromEntries(rep.byLeagueStrategyReason.map((r) => [r.reason, r.count]));
  assert.equal(reasons.stale_proposal, 1);
  assert.equal(reasons.depth_floor, 2);
  assert.equal(reasons.zombie_resolved, 1);
  assert.ok(rep.byLeagueStrategyReason.every((r) => r.league === "svn.1" && r.strategy === "prematch_value"));
  // coverage: 3 fillable / 6 signals = 0.5 ≥ 0.30 → active
  assert.equal(rep.coverage.length, 1);
  assert.equal(rep.coverage[0].tier, "active");
  assert.equal(rep.coverage[0].fillableShare, 0.5);
  // F3 side check: 2 settled non-zombie fills, 1 won → 0.5
  assert.equal(rep.f3Check.filledNonZombieSettled, 2);
  assert.equal(rep.f3Check.winRate, 0.5);
  // mandatory seasonal caveat (July = off-season)
  assert.match(rep.seasonalCaveat, /межсезонье/);
  assert.ok(rep.notes.some((n) => /снапшот/.test(n)), "the unknown-fillability caveat is present");
});

test("P2 coverage: a thin league below 30% fillable and under 2/week lands in passive-tier", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "Overreaction", tag: "o", color: "#e8a838", version: 1, model: "m", model_live: "m", created_at: "t", prompt: "p", prompt_live: null, params: {} } as any);
  R.upsertCompetition(db, { id: "pm-x", sport_id: "football", name: "Minor", budget: 8000, external_league: "faroe.1", created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "pm-x", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "2026-07-20T12:00:00Z", minute: null, score_home: 0, score_away: 0, final_score: "0:0", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: mid });
  const now = Date.parse("2026-07-22T12:00:00Z");
  // 5 signals, all zombie/empty (unfillable), 0 fillable → share 0%, 0/week → passive.
  for (let i = 0; i < 5; i++) R.insertBet(db, { id: R.uid(), match_id: mid, strategy_id: "overreaction", risk_profile_id: "medium", market_label: `Z${i}`, status: "not_filled", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "zombie_quarantine:stale_book — стухшая", entered_minute: null, result: null, payout: null, created_at: "2026-07-20T12:00:00Z" } as any);
  const rep = buildUnfillableEdge(db, { nowMs: now, windowDays: 14 });
  assert.equal(rep.coverage[0].tier, "passive");
  assert.equal(rep.coverage[0].fillable, 0);
  assert.equal(rep.f3Check.filledNonZombieSettled, 0, "no filled signals → no F3 sample");
});
