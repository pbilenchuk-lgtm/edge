import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildPmvExitCounterfactual, marketFamily, pmvCounterfactualBets } from "../src/lib/pmvExitCounterfactual.js";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: "t" });
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: "t" } as any);
  // Finished 2:0 → total 2. Over 1.5 / Under 3.5 / Over 0.5 all WIN at settle.
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t", minute: 90, score_home: 2, score_away: 0, final_score: "2:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  return db;
}
function pmvSettled(db: any, o: { id: string; label: string; profile?: string; entry: number; stake: number; result: "won" | "lost"; payout: number }) {
  R.insertBet(db, {
    id: o.id, match_id: "m1", strategy_id: "prematch_value", risk_profile_id: o.profile ?? "medium",
    market_label: o.label, status: "open", proposed_price: o.entry, entry_price: o.entry, current_price: o.entry,
    closing_price: o.entry, ai_prob: 0.6, stake: o.stake, rationale: "r", entered_minute: "предматч",
    result: null, payout: null, entry_meta: null, created_at: "2026-07-10T00:00:00Z",
  } as any);
  const status = o.result === "won" ? "settled_won" : "settled_lost";
  db.prepare(`UPDATE bets SET status=?, result=?, payout=?, settled_by=?, settled_at=? WHERE id=?`)
    .run(status, o.result, o.payout, "early", "2026-07-10T02:00:00Z", o.id);
}
const exit = (db: any, label: string, text: string) => R.insertTradeLog(db, { id: R.uid(), match_id: "m1", strategy_id: "prematch_value", minute: "78'", type: "exit", text: `выход «${label}» ${text}`, created_at: "t" });

test("F4 isolation: the main line is the trio only; `max` (incl. legacy rp-lite alias) is a SEPARATE maxLine", () => {
  const db = seed();
  // Two MAIN-profile early-closed PMV bets (medium + aggressive) and TWO max bets (one new `max`, one legacy
  // rp-lite id that aliases to max) — all on Over 1.5 which WON at settle (2:0). Each was closed early.
  pmvSettled(db, { id: "mn1", label: "Over 1.5", profile: "medium", entry: 40, stake: 100, result: "lost", payout: 0 });
  pmvSettled(db, { id: "mn2", label: "Over 1.5", profile: "aggressive", entry: 40, stake: 100, result: "lost", payout: 0 });
  pmvSettled(db, { id: "mx1", label: "Over 1.5", profile: "max", entry: 40, stake: 200, result: "lost", payout: 0 });
  pmvSettled(db, { id: "mx2", label: "Over 1.5", profile: "rp-lite-mrca9dz8", entry: 40, stake: 200, result: "lost", payout: 0 });
  exit(db, "Over 1.5", "@ 25¢ · тезис · P&L -$100.00");
  const rep = buildPmvExitCounterfactual(db);
  assert.equal(rep.n, 2, "main line counts only the aggressive/medium trio bets");
  assert.equal(rep.turnover, 200, "main turnover = 100 + 100, max's 400 excluded");
  assert.equal(rep.maxLine.n, 2, "both max bets (new id + legacy alias) land in maxLine");
  assert.equal(rep.maxLine.turnover, 400, "max turnover isolated");
  // main cells never carry a max stake
  assert.ok(rep.byReasonFamily.every((c) => c.turnover <= 200), "no main cell includes max's stake");
});

test("F4 marketFamily: coarse classification", () => {
  assert.equal(marketFamily("Over 1.5"), "totals");
  assert.equal(marketFamily("Under 3.5 goals"), "totals");
  assert.equal(marketFamily("Both Teams to Score — Yes"), "btts");
  assert.equal(marketFamily("A -1.5"), "handicap");
  assert.equal(marketFamily("Portugal"), "moneyline/other");
});

test("F4: hold-to-settle counterfactual — early stop on a market that WON held is the max-harm row", () => {
  const db = seed();
  // CF1: bought Over 1.5 @40¢, stopped out early for a full loss; held → WINS (2:0).
  pmvSettled(db, { id: "cf1", label: "Over 1.5", entry: 40, stake: 100, result: "lost", payout: 0 });
  exit(db, "Over 1.5", "@ 25¢ · тезис сломан · P&L -$100.00");
  // CF2: bought Under 3.5 @60¢, took profit early (+$40); held → still WINS but pays more.
  pmvSettled(db, { id: "cf2", label: "Under 3.5", entry: 60, stake: 100, result: "won", payout: 140 });
  exit(db, "Under 3.5", "@ 72¢ · тейк на пике · P&L +$40.00");

  const { bets } = pmvCounterfactualBets(db);
  const cf1 = bets.find((b) => b.betId === "cf1")!;
  assert.equal(cf1.actualPnl, -100);
  assert.equal(cf1.holdPnl, 150, "shares 250 × $1 − $100 stake");
  assert.equal(cf1.delta, 250, "held would have been +$250 better");
  assert.equal(cf1.heldWin, true);
  assert.equal(cf1.family, "totals");
  assert.equal(cf1.reason, "thesis_stop");

  const rep = buildPmvExitCounterfactual(db);
  assert.equal(rep.n, 2);
  assert.equal(rep.totalActualPnl, -60);   // -100 + 40
  assert.equal(rep.totalHoldPnl, 216.67);  // 150 + 66.67
  assert.equal(rep.totalDelta, 276.67);
  // n=2 is below the 30-min, so nothing is flagged even though delta% is huge.
  assert.equal(rep.flaggedCells.length, 0);
  assert.equal(rep.byReasonFamily[0].reason, "thesis_stop", "most-harmful cell sorts first");
});

test("F4: opposite-outcome twin — same pick, one profile stopped out, its twin held to a win", () => {
  const db = seed();
  // Two profiles on the SAME pick (Over 0.5 @50¢, stake 40). One stopped out early (lost), one held (won).
  pmvSettled(db, { id: "twA", label: "Over 0.5", profile: "conservative", entry: 50, stake: 40, result: "lost", payout: 0 });
  pmvSettled(db, { id: "twB", label: "Over 0.5", profile: "aggressive", entry: 50, stake: 40, result: "won", payout: 80 });
  exit(db, "Over 0.5", "@ 20¢ · хард-стоп · P&L -$40.00");

  const rep = buildPmvExitCounterfactual(db);
  assert.equal(rep.twins.length, 1);
  const tw = rep.twins[0];
  assert.equal(tw.market, "Over 0.5");
  assert.equal(tw.oppositeOutcomes, true);
  assert.equal(tw.pnlSpread, 80, "won +40 vs lost −40 → $80 spread on identical picks");
  assert.equal(tw.legs.length, 2);
  // A same-outcome group (both won / both lost) is NOT a divergence and must be absent.
  pmvSettled(db, { id: "sameA", label: "Over 2.5", profile: "medium", entry: 50, stake: 40, result: "lost", payout: 0 });
  pmvSettled(db, { id: "sameB", label: "Over 2.5", profile: "aggressive", entry: 50, stake: 40, result: "lost", payout: 0 });
  assert.equal(buildPmvExitCounterfactual(db).twins.some((t) => t.market === "Over 2.5"), false);
});
