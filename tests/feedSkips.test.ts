import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { migrateTennisStrategy } from "../src/lib/seed.js";

// The лента pulls the newest-N trade-log rows, then keeps only P&L-affecting ones. Every cron
// tick logs a skip per (strategy, profile, match), so with tennis (4 profiles × many live matches)
// a plain newest-N window is ALL skips and real enters/settles fall out — the feed showed no
// tennis entries though they happened. recentTradeLog(excludeSkips=true) must drop skips in SQL,
// BEFORE the LIMIT, so a real entry older than a flood of skips still makes the window.
test("recentTradeLog(excludeSkips): a real entry survives a flood of newer skips", () => {
  const db = openDb(":memory:");
  migrateTennisStrategy(db); // FK target for trade_log.strategy_id
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "c1", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "c1", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "2026-07-14T09:00:00Z", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);

  // One real entry at 18:09, then 100 skips at 18:10+ (each cron tick, every pair).
  R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: "tennis_overreaction", minute: "сет 1", type: "enter", text: "ВЫКУП @ 63.5¢", created_at: "2026-07-14T18:09:00Z" } as any);
  for (let i = 0; i < 100; i++)
    R.insertTradeLog(db, { id: R.uid(), match_id: mid, strategy_id: "tennis_overreaction", minute: "сет 2", type: "skip", text: "нет сетапа", created_at: `2026-07-14T18:${10 + Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}Z` } as any);

  // Newest 60 WITHOUT exclusion = all skips → the entry is invisible (the bug).
  const naive = R.recentTradeLog(db, 60);
  assert.equal(naive.some((r) => r.type === "enter"), false, "plain newest-60 is flooded by skips");

  // Newest 60 EXCLUDING skips = the entry survives (the fix).
  const clean = R.recentTradeLog(db, 60, true);
  assert.equal(clean.every((r) => r.type !== "skip"), true, "no skips leak through");
  assert.equal(clean.some((r) => r.type === "enter" && r.text.includes("63.5")), true, "the real entry makes the window");
});
