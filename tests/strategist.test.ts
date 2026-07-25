import { test } from "node:test";
import assert from "node:assert/strict";
import { siblingLabel, impliedProbs, sizePrematch, probSumFlags, correlationKey } from "../src/lib/strategist.js";
import { normalizeStrategistJson } from "../src/lib/llm.js";
import { getProfileConfig, seedRiskProfiles, loadRiskConfig } from "../src/lib/riskConfig.js";
import { openDb } from "../src/lib/db.js";

const MED = loadRiskConfig({}).config!; // defaults ≡ medium

test("siblingLabel: pairs Over/Under and Yes/No, null for one-sided", () => {
  const labels = ["Over 2.5", "Under 2.5", "Both Teams to Score — Yes", "Both Teams to Score — No", "Team to Advance — Portugal"];
  assert.equal(siblingLabel("Over 2.5", labels), "Under 2.5");
  assert.equal(siblingLabel("Under 2.5", labels), "Over 2.5");
  assert.equal(siblingLabel("Both Teams to Score — Yes", labels), "Both Teams to Score — No");
  assert.equal(siblingLabel("Team to Advance — Portugal", labels), null);
});

test("siblingLabel: Yes/No de-vig is symmetric even with inconsistent dash formatting", () => {
  const labels = ["BTTS - Yes", "BTTS No"]; // one side dashed, the other not
  assert.equal(siblingLabel("BTTS - Yes", labels), "BTTS No", "yes side finds no side");
  assert.equal(siblingLabel("BTTS No", labels), "BTTS - Yes", "no side finds yes side (symmetric)");
  // both sides de-vig to the same group → sum to 1
  const imp = impliedProbs([{ label: "BTTS - Yes", priceCents: 58 }, { label: "BTTS No", priceCents: 49 }]);
  assert.ok(imp.get("BTTS - Yes")!.sided && imp.get("BTTS No")!.sided, "both sides de-vigged");
  assert.ok(Math.abs((imp.get("BTTS - Yes")!.implied + imp.get("BTTS No")!.implied) - 1) < 1e-9);
});

test("sizePrematch: a binding cap is honored with FLOOR — never exceeded by rounding", () => {
  // max_position_pct 5% of budget 110 = $5.50 cap; a big edge would size past it.
  const r = sizePrematch({ ourProb: 0.75, priceCents: 55, implied: 0.55, calibration: 0.8, budget: 110, cfg: MED });
  assert.equal(r.status, "enter");
  assert.ok(r.stake <= 5, `floored at or below the $5.50 cap, got ${r.stake}`); // 5, not 6
});

test("sizePrematch B2: absurdEdgeBlock override widens the ceiling (tennis 40%); default 25% still flags", () => {
  const base = { ourProb: 0.75, priceCents: 45, implied: 0.45, calibration: 0.7, budget: 1000, cfg: MED }; // edge 30%
  assert.equal(sizePrematch(base).status, "flag", "default 25% ceiling flags a 30% edge as probably-a-bug");
  const r = sizePrematch({ ...base, absurdEdgeBlock: 0.40 });
  assert.equal(r.status, "enter", "the 40% tennis override admits the 30% edge (deep-but-real snapback)");
  assert.ok(r.edge > 0.25 && r.edge < 0.40);
  // above the override it still flags — the ceiling widened, it wasn't removed.
  assert.equal(sizePrematch({ ...base, ourProb: 0.90, implied: 0.45, absurdEdgeBlock: 0.40 }).status, "flag", "edge 45% > 40% override → still flagged");
});

test("sizePrematch #3b: live backstops catch a fabricated edge (VAR phantom) while a real in-play edge passes", () => {
  // allowLargeEdge=true is the live path where the plain absurd block is OFF.
  // (1) DIVERGENCE: model near-certain (≥90%) vs a market pricing it near-dead (≤12¢) → block.
  const div = sizePrematch({ ourProb: 0.95, priceCents: 8, implied: 0.08, calibration: 0.7, budget: 1000, cfg: MED, allowLargeEdge: true });
  assert.equal(div.status, "flag", "prob 95% vs market 8¢ → data-error, blocked");
  assert.match(div.reason, /live_divergence_block/);
  // (2) ABSOLUTE CAP: edge > 80% even in live (price 15¢ dodges the ≤12¢ divergence gate) → block.
  const cap = sizePrematch({ ourProb: 0.99, priceCents: 15, implied: 0.15, calibration: 0.7, budget: 1000, cfg: MED, allowLargeEdge: true });
  assert.equal(cap.status, "flag", "edge 84% > live_absurd_cap 80% → blocked");
  assert.match(cap.reason, /live_absurd_edge_block/);
  // (3) REAL in-play edge PASSES: a 0:2 game's Over 1.5 — model 90%, market 44¢ (edge 46%). Neither
  //     divergence (price > 12¢) nor the absolute cap (edge < 80%) fires → this is the edge we KEEP.
  const real = sizePrematch({ ourProb: 0.90, priceCents: 44, implied: 0.44, calibration: 0.7, budget: 1000, cfg: MED, allowLargeEdge: true });
  assert.equal(real.status, "enter", "a genuine large in-play edge still trades");
  // Prematch (allowLargeEdge=false) is unchanged: the tight absurd block still catches a 46% edge.
  const pre = sizePrematch({ ourProb: 0.90, priceCents: 44, implied: 0.44, calibration: 0.7, budget: 1000, cfg: MED });
  assert.equal(pre.status, "flag", "prematch keeps the tight absurd_edge_block");
});

test("impliedProbs: de-vigs a two-sided group to sum 1; raw for one-sided", () => {
  // Over 55¢ + Under 52¢ = 1.07 vig → implied Over = 55/107 ≈ 0.514
  const imp = impliedProbs([{ label: "Over 2.5", priceCents: 55 }, { label: "Under 2.5", priceCents: 52 }, { label: "Team to Advance — X", priceCents: 70 }]);
  assert.ok(Math.abs(imp.get("Over 2.5")!.implied - 55 / 107) < 1e-9, "de-vigged");
  assert.ok(imp.get("Over 2.5")!.sided);
  assert.ok(Math.abs((imp.get("Over 2.5")!.implied + imp.get("Under 2.5")!.implied) - 1) < 1e-9, "group sums to 1");
  assert.equal(imp.get("Team to Advance — X")!.implied, 0.70, "one-sided uses raw price");
  assert.equal(imp.get("Team to Advance — X")!.sided, false);
});

test("sizePrematch: enters on real edge, skips below the profile threshold", () => {
  // our 0.62 vs implied 0.52, price 53¢ → edge 10% ≥ medium min_edge 5%
  const r = sizePrematch({ ourProb: 0.62, priceCents: 53, implied: 0.52, calibration: 0.7, budget: 1000, cfg: MED });
  assert.equal(r.status, "enter");
  assert.ok(r.stake > 0 && r.stake <= 50, `stake within max_position_pct 5% of 1000, got ${r.stake}`);
  // thin edge → skip
  const r2 = sizePrematch({ ourProb: 0.55, priceCents: 53, implied: 0.53, calibration: 0.7, budget: 1000, cfg: MED });
  assert.equal(r2.status, "skip");
});

test("sizePrematch П1 (batch-3): sizing_insanity flags a stake past bankCeiling×SHARE — the corrupted-budget backstop", () => {
  // The poisoned-epoch bug: a corrupted budget ($1M PMV-sim leak) sized a Set-Value bet at ~$7k while the
  // TRUE bank was $1000. The caps hold stake ≤ budget, so a budget-relative check misses it; a ceiling
  // anchored to the true bank (bankCeiling) catches it. Reproduce: budget corrupted to 1e6, bank still 1000.
  const r = sizePrematch({ ourProb: 0.62, priceCents: 53, implied: 0.52, calibration: 0.7, budget: 1_000_000, cfg: MED, bankCeiling: 1000 });
  assert.equal(r.status, "flag", "a $-thousands stake on a $1000 bank must be flagged, not booked");
  assert.match(r.reason, /sizing_insanity/);
  // Without bankCeiling the check is opt-out (football keeps its own caps) — the same corrupted budget sizes big.
  const noGuard = sizePrematch({ ourProb: 0.62, priceCents: 53, implied: 0.52, calibration: 0.7, budget: 1_000_000, cfg: MED });
  assert.equal(noGuard.status, "enter", "no bankCeiling → no insanity check (opt-in)");
  // A sane stake on a correct bank passes the guard.
  const ok = sizePrematch({ ourProb: 0.62, priceCents: 53, implied: 0.52, calibration: 0.7, budget: 1000, cfg: MED, bankCeiling: 1000 });
  assert.equal(ok.status, "enter", "a normal ≤max_position stake clears bankCeiling×SHARE");
});

test("sizePrematch T3 (batch-3): the min_edge boundary is INCLUSIVE — edge EXACTLY at the floor enters", () => {
  // medium min_edge = 5%. Construct edge == 0.05 exactly (ourProb − implied), deep-liquidity so the full
  // (not thin) floor applies. Must ENTER (the boundary is `<`, so equality passes), not skip.
  const cfg = MED;
  const minEdge = cfg.entry_thresholds.min_edge;
  const implied = 0.50, ourProb = implied + minEdge; // edge == min_edge to the ULP
  const r = sizePrematch({ ourProb, priceCents: 53, implied, calibration: 0.9, liquidity: 10_000_000, budget: 1000, cfg });
  assert.equal(r.status, "enter", `edge == min_edge (${minEdge}) must enter, not skip`);
  // A hair below the floor still skips.
  const below = sizePrematch({ ourProb: implied + minEdge - 0.005, priceCents: 53, implied, calibration: 0.9, liquidity: 10_000_000, budget: 1000, cfg });
  assert.equal(below.status, "skip", "edge below the floor skips");
});

test("sizePrematch: low calibration gate blocks entry regardless of edge", () => {
  const r = sizePrematch({ ourProb: 0.7, priceCents: 50, implied: 0.5, calibration: 0.3, budget: 1000, cfg: MED });
  assert.equal(r.status, "skip");
  assert.match(r.reason, /калибровк/i);
});

test("sizePrematch: absurd edge is flagged, not traded", () => {
  const r = sizePrematch({ ourProb: 0.95, priceCents: 50, implied: 0.5, calibration: 0.8, budget: 1000, cfg: MED });
  assert.equal(r.status, "flag");
  assert.match(r.reason, /absurd/i);
});

test("sizePrematch: min_liquidity_block — a market below the hard floor is untradeable, whatever the edge or window", async () => {
  const { MIN_LIQUIDITY_BLOCK } = await import("../src/lib/strategist.js");
  // The Orlando «Draw — No» case: $24 depth, a big 36% edge, live window. The LLM
  // "wanted" it; the code floor must veto regardless.
  const thin = { ourProb: 0.86, priceCents: 50, implied: 0.50, calibration: 0.8, budget: 1000, liquidity: 24, cfg: MED };
  const r = sizePrematch({ ...thin, allowLargeEdge: true });
  assert.equal(r.status, "skip", "below the hard floor → blocked even live, even on a huge edge");
  assert.match(r.reason, /min_liquidity_block/);
  assert.ok(MIN_LIQUIDITY_BLOCK >= 50, "hard floor defaults to $50");
  // Same edge on a market just above the floor is NOT blocked by this gate.
  assert.notEqual(sizePrematch({ ...thin, liquidity: MIN_LIQUIDITY_BLOCK + 1, allowLargeEdge: true }).reason, r.reason, "above the floor → not blocked by min_liquidity_block");
});

test("sizePrematch: aggressive stakes more and enters lower edge than conservative", () => {
  const db = openDb(":memory:");
  seedRiskProfiles(db, "t");
  const agg = getProfileConfig(db, "aggressive"), con = getProfileConfig(db, "conservative");
  // a modest 4% edge on a LIQUID market (so the normal min_edge applies, not the
  // thin bar): aggressive (min 3%) enters, conservative (min 7%) skips
  const inp = { ourProb: 0.56, priceCents: 52, implied: 0.52, calibration: 0.6, budget: 1000, liquidity: 100000 };
  assert.equal(sizePrematch({ ...inp, cfg: agg }).status, "enter", "aggressive enters 4% edge");
  assert.equal(sizePrematch({ ...inp, cfg: con }).status, "skip", "conservative skips 4% edge");
  // on a big shared edge, aggressive stakes more (higher Kelly + higher caps)
  const big = { ourProb: 0.66, priceCents: 52, implied: 0.52, calibration: 0.7, budget: 1000, liquidity: 100000 };
  assert.ok(sizePrematch({ ...big, cfg: agg }).stake > sizePrematch({ ...big, cfg: con }).stake, "aggressive stakes more");
});

test("sizePrematch: unknown liquidity (null) is treated as THIN — the cautious bar applies", () => {
  // edge 6%: passes the normal min_edge (5%) but fails the thin bar (7%). With
  // liquidity unknown, the thin bar must apply → skip.
  const base = { ourProb: 0.61, priceCents: 55, implied: 0.55, calibration: 0.7, budget: 1000, cfg: MED };
  assert.equal(sizePrematch({ ...base, liquidity: null }).status, "skip", "unknown depth → cautious → skip a 6% edge");
  assert.equal(sizePrematch({ ...base, liquidity: 100000 }).status, "enter", "known-deep market → normal bar → 6% enters");
});

test("sizePrematch: match-exposure cap limits the stake", () => {
  // already near the match cap (medium max_match_exposure_pct = 10% of 1000 = 100)
  const r = sizePrematch({ ourProb: 0.7, priceCents: 55, implied: 0.55, calibration: 0.8, budget: 1000, matchExposure: 95, cfg: MED });
  assert.ok(r.stake <= 5, `only the remaining $5 of match room can be staked, got ${r.stake}`);
});

test("sizePrematch: effectively-resolved price (≤2¢ / ≥98¢) is skipped — no phantom edge", () => {
  // Under 1.5 at 0.2¢ on a live match that already has 2+ goals: model's stale
  // 22% vs a ~decided 0.2¢ = a +22% phantom. Must not enter.
  const r = sizePrematch({ ourProb: 0.22, priceCents: 0.2, implied: 0.002, calibration: 0.8, budget: 1000, cfg: MED });
  assert.equal(r.status, "skip");
  assert.match(r.reason, /фактически решён|планки/);
  // and the other rail
  assert.equal(sizePrematch({ ourProb: 0.5, priceCents: 99, implied: 0.99, calibration: 0.8, budget: 1000, cfg: MED }).status, "skip");
  // a normal mid-book price with real edge still enters
  assert.equal(sizePrematch({ ourProb: 0.62, priceCents: 53, implied: 0.52, calibration: 0.7, budget: 1000, cfg: MED }).status, "enter");
});

test("correlationKey: same-team 'more goals' markets share a cluster", () => {
  const home = "France", away = "Morocco";
  // France team-total Over and France negative handicap both need France's next
  // goal → one cluster.
  const a = correlationKey("France Over 2.5", home, away);
  const b = correlationKey("France -2.5", home, away);
  assert.ok(a && a === b, `France Over 2.5 and France -2.5 should cluster (${a} vs ${b})`);
  // Match total Over (no team qualifier) is a different cluster.
  assert.equal(correlationKey("Over 3.5", home, away), "total:over");
  assert.notEqual(correlationKey("Over 3.5", home, away), a);
  // Underdog positive handicap / opponent-side markets don't join France's cluster.
  assert.equal(correlationKey("Morocco +1.5", home, away), null);
  // S5 (R0.5): a team's MONEYLINE is the SAME dominance thesis as its Over/−handicap — all resolve on
  // France outperforming — so it now JOINS France's cluster (previously null → stacked uncapped).
  assert.equal(correlationKey("France to win", home, away), "dom:home");
  assert.equal(correlationKey("France", home, away), a); // bare team-name to-win market
  // The opponent's moneyline is the OTHER side — a different thesis, not France's.
  assert.equal(correlationKey("Morocco to win", home, away), "dom:away");
});

test("correlationKey: LOW-total bets share one cluster (Under-symmetry — Örgryte–Häcken pseudo-diversification)", () => {
  const home = "Orgryte", away = "BK Hacken";
  // The two legs that were a doubled low-total bet at DOUBLE size, previously uncapped:
  // a team Under and a match Under both bleed on the same risk (a goal) → one cluster.
  const teamUnder = correlationKey("BK Hacken Under 2.5", home, away);
  const matchUnder = correlationKey("Under 3.5", home, away);
  assert.equal(teamUnder, "total:under", "team Under joins the low-total cluster");
  assert.equal(matchUnder, "total:under", "match Under joins the low-total cluster");
  assert.equal(teamUnder, matchUnder, "the two Under legs share a correlation cluster (capped together)");
  // BTTS-No is also a low-total bet → same cluster.
  assert.equal(correlationKey("Both Teams to Score — No", home, away), "total:under");
  // Symmetry preserved: Over stays its OWN (opposite) cluster, never folded into Under.
  assert.equal(correlationKey("Over 2.5", home, away), "total:over");
  assert.notEqual(correlationKey("Over 2.5", home, away), matchUnder);
  // BTTS-Yes (a high-scoring bet) must NOT land in the low-total cluster.
  assert.notEqual(correlationKey("Both Teams to Score — Yes", home, away), "total:under");
});

test("correlationKey: Draw-No ≡ Extra-Time-No share a cluster (knockout equivalence — France–Spain double bet)", () => {
  const home = "France", away = "Spain";
  // In a knockout "no draw at 90'" ⟺ "no extra time" — the SAME outcome. Both must cluster together so
  // buying both isn't an uncapped double-size position (the pre-match_value «якорь+спутник» that was empty).
  const drawNo = correlationKey("Draw — No", home, away);
  const etNo = correlationKey("Will the Match Go to Extra Time? — No", home, away);
  assert.equal(drawNo, "ko:decided");
  assert.equal(etNo, "ko:decided");
  assert.equal(drawNo, etNo, "Draw-No and ET-No are one correlation cluster");
  assert.equal(correlationKey("Will the Match Go to Penalties? — No", home, away), "ko:decided", "penalties-No: conservative co-cap");
  // The opposite (level/tie) trajectory is its OWN cluster — Yes sides don't co-lose with No sides.
  assert.equal(correlationKey("Draw — Yes", home, away), "ko:level");
  assert.equal(correlationKey("Will the Match Go to Extra Time? — Yes", home, away), "ko:level");
  assert.notEqual(correlationKey("Draw — No", home, away), correlationKey("Draw — Yes", home, away));
  // Draw No Bet is NOT the draw market — must not fold in.
  assert.notEqual(correlationKey("France Draw No Bet", home, away), "ko:decided");
});

test("sizePrematch: correlated cluster is capped like a single position", () => {
  // medium max_position_pct = 5% of 1000 = $50. A cluster already holding $48
  // leaves only $2 of correlated room even though match/comp room is ample.
  const r = sizePrematch({ ourProb: 0.7, priceCents: 55, implied: 0.55, calibration: 0.8, budget: 1000, clusterExposure: 48, cfg: MED });
  assert.ok(r.stake <= 2, `only $2 of correlated room left, got ${r.stake}`);
  // A full cluster blocks the entry with the correlation reason.
  const full = sizePrematch({ ourProb: 0.7, priceCents: 55, implied: 0.55, calibration: 0.8, budget: 1000, clusterExposure: 50, cfg: MED });
  assert.equal(full.status, "skip");
  assert.match(full.reason, /коррелирован/);
});

test("probSumFlags: flags a group whose raw sum drifts beyond tolerance", () => {
  // Over 70 + Under 70 = 1.40 → way past 1 ± 0.02
  const flags = probSumFlags([{ label: "Over 2.5", priceCents: 70 }, { label: "Under 2.5", priceCents: 70 }], MED);
  assert.ok(flags.has("Over 2.5") && flags.has("Under 2.5"));
  // a tight book is fine
  const ok = probSumFlags([{ label: "Over 2.5", priceCents: 51 }, { label: "Under 2.5", priceCents: 50 }], MED);
  assert.equal(ok.size, 0);
});

test("normalizeStrategistJson: minimal {picks,exits,note} still parses (back-compat)", () => {
  const d = normalizeStrategistJson({ picks: [{ label: "Over 2.5", conviction: "высокая", reason: "x", prob: 0.6 }], exits: [{ market: "BTTS No", fraction: 0.5, reason: "peak" }], note: "n" });
  assert.equal(d.picks.length, 1);
  assert.equal(d.picks[0].label, "Over 2.5");
  assert.equal(d.picks[0].prob, 0.6);
  assert.equal(d.exits[0].fraction, 0.5);
  assert.equal(d.note, "n");
});

test("P4 normalizeStrategistJson: market_id is captured (by any alias); label falls back to '' when only id given", () => {
  const d = normalizeStrategistJson({
    picks: [
      { market_id: "m3", label: "Lugano — Yes", prob: 0.78, reason: "value" }, // the Lugano case: id + label
      { marketId: "m7", prob: 0.6, reason: "id-only, no label" },               // id alias, no label
      { label: "Over 2.5", prob: 0.5, reason: "legacy id-less pick" },          // no id → transitional fallback
    ],
    note: "n",
  });
  assert.equal(d.picks.length, 3);
  assert.equal(d.picks[0].marketId, "m3");
  assert.equal(d.picks[0].label, "Lugano — Yes");
  assert.equal(d.picks[1].marketId, "m7");
  assert.equal(d.picks[1].label, "", "id-only pick still parses (label empty, id resolves it)");
  assert.equal(d.picks[2].marketId, undefined, "an id-less pick keeps the label-fallback path");
});

test("T2.2 normalizeStrategistJson: a HOLD ticket is flagged hold (explicit action OR «не новый вход» reason), a real pick isn't", () => {
  const d = normalizeStrategistJson({
    picks: [
      { label: "BTTS — No", conviction: "средняя", reason: "держу открытую anchor-позицию, не новый вход", prob: 0.6 },
      { label: "Over 1.5", conviction: "высокая", reason: "структурный value", prob: 0.7, action: "hold" },
      { label: "Draw — No", conviction: "средняя", reason: "живой выкуп после красной", prob: 0.55 },
    ],
    note: "n",
  });
  const byLabel = Object.fromEntries(d.picks.map((p) => [p.label, p]));
  assert.equal(byLabel["BTTS — No"].hold, true, "«не новый вход» reason → hold");
  assert.equal(byLabel["Over 1.5"].hold, true, "action:hold → hold");
  assert.equal(byLabel["Draw — No"].hold, undefined, "a genuine buyback pick is NOT flagged hold");
});

test("normalizeStrategistJson: v3 pre_match_positions + rich fields captured (engine still sizes from prob)", () => {
  const d = normalizeStrategistJson({
    match_shape: "A",
    pre_match_positions: [{
      market: "Under 2.5", side: "under", our_prob: 0.58, edge: 0.05, calibration: 0.7,
      role: "anchor", lives_in_branches: ["fav_clean", "draw_0_0"], branch_weight_sum: 0.72,
      total_check: "Over2.5:100%", phantom_check: "passed — конкретный фактор", size_pct: 5, kelly_fraction: 0.2,
      exit: { take_price: "62¢", thesis_stop: "красная у фаворита", counter_scenario_stop: "fav_concedes" },
    }],
    portfolio_correlation: { both_lose_on_scores: ["3:2"], both_lose_weight: 0.11, coverage_note: "покрытие ок" },
    rejected_markets: [{ market: "France advance", reason: "рынок прав" }],
    notes: "value в производных",
  });
  const p = d.picks[0];
  assert.equal(p.label, "Under 2.5");
  assert.equal(p.prob, 0.58, "our_prob → prob (what the engine sizes on)");
  assert.equal(p.role, "anchor");
  assert.deepEqual(p.livesInBranches, ["fav_clean", "draw_0_0"]);
  assert.equal(p.branchWeightSum, 0.72);
  assert.equal(p.phantomCheck, "passed — конкретный фактор");
  assert.equal(p.exitPlan?.counter_scenario_stop, "fav_concedes");
  assert.equal(d.matchShape, "A");
  assert.equal(d.portfolioCorrelation?.both_lose_weight, 0.11);
  assert.equal(d.rejected?.[0].market, "France advance");
  assert.equal(d.note, "value в производных");
});

test("normalizeStrategistJson: time_stop in the exit plan is captured (Fix 2)", () => {
  const d = normalizeStrategistJson({
    picks: [{ label: "Switzerland Over 0.5", prob: 0.5, reason: "тающий опцион", exit: { take_price: "80¢", time_stop: { minute: 80, condition: "не забили", action: "close_half" } } }],
  });
  assert.equal(d.picks[0].exitPlan?.time_stop?.minute, 80);
  assert.equal(d.picks[0].exitPlan?.time_stop?.action, "close_half");
  // action defaults to a full close; a non-positive/absent minute drops the time_stop.
  const full = normalizeStrategistJson({ picks: [{ label: "X", prob: 0.4, reason: "r", exit: { time_stop: { minute: 75 } } }] });
  assert.equal(full.picks[0].exitPlan?.time_stop?.action, "close_full");
  const none = normalizeStrategistJson({ picks: [{ label: "Y", prob: 0.4, reason: "r", exit: { time_stop: { minute: 0 } } }] });
  assert.equal(none.picks[0].exitPlan?.time_stop, undefined, "minute<=0 → no time_stop");
});

test("normalizeStrategistJson: overreaction prematch arms live_triggers (passed through, no picks)", () => {
  const d = normalizeStrategistJson({
    strategist: "overreaction", phase: "prematch",
    pre_match_positions: [],
    live_triggers_armed: [{ scenario_trigger: "ранний гол андердога", buyback_target: "38¢", depth_condition: "≤0:1", price_trigger: "≤40¢", size: "small", false_signal_filter: "live-xG качество", linked_node: "early_dog_goal" }],
    notes: "ждём панику на раннем голе",
  });
  assert.equal(d.picks.length, 0, "prematch overreaction opens no positions");
  assert.ok(Array.isArray(d.liveTriggersArmed) && d.liveTriggersArmed.length === 1, "armed triggers captured");
  assert.equal((d.liveTriggersArmed as any[])[0].buyback_target, "38¢");
});

test("normalizeStrategistJson: live_xg prematch arms live_entry_config (passed through, no picks)", () => {
  const d = normalizeStrategistJson({
    strategist: "live_xg", phase: "prematch", active: true, match_shape_used: "A",
    pre_match_positions: [],
    live_entry_config: { xg_gap_threshold: 1.1, min_pressure_duration_min: 20, target_markets: ["France Over 1.5"], context_note: "shape A — порог ниже" },
    notes: "порог настроен под A",
  });
  assert.equal(d.picks.length, 0, "prematch live_xg opens no positions");
  assert.ok(d.liveEntryConfig && (d.liveEntryConfig as any).xg_gap_threshold === 1.1, "live_entry_config captured");
});

test("normalizeStrategistJson: exit_checks is an exit channel (a close expressed only there still fires)", () => {
  const d = normalizeStrategistJson({
    strategist: "prematch_value", phase: "live", current_branch: "fav_concedes",
    actions: [{ market: "Under 2.5", action: "hold", reason: "смотрю" }], // NOT a close
    exit_checks: [
      { position: "Under 2.5", trigger_hit: "counter_scenario", action: "close" }, // the real close, only here
      { position: "BTTS No", trigger_hit: "none", action: "hold" },                 // nothing fired → ignored
      { position: "France -1.5", trigger_hit: "goal_scored", action: "reduce", size_pct: 50 }, // strategy-specific trigger
    ],
  });
  assert.equal(d.exits.length, 2, "the fired exit_checks become exits; the 'none' one is ignored");
  const close = d.exits.find((e) => e.market === "Under 2.5")!;
  assert.equal(close.fraction, 1, "close → full");
  assert.equal(close.trigger, "counter_scenario");
  const red = d.exits.find((e) => e.market === "France -1.5")!;
  assert.equal(red.fraction, 0.5, "reduce+size_pct 50 → half");
  assert.equal(red.trigger, "goal_scored", "strategy-specific trigger preserved as free string");
});

test("normalizeStrategistJson: a NEGATIVE exit_check answer ('нет — …') does NOT fire (holds the position)", () => {
  const d = normalizeStrategistJson({
    strategist: "overreaction", phase: "live",
    exit_checks: [
      { position: "Molde FK", trigger_hit: "нет — переоценка ещё не отыграна, справедливая ~50¢", action: "hold" }, // NO (leading)
      { position: "Draw", trigger_hit: "no, not yet", action: "hold" },                                             // NO
      { position: "Bodo", trigger_hit: "ещё нет", action: "hold" },                                                  // NO — negation NOT leading
      { position: "Rosenborg", trigger_hit: "пока не сработал стоп", action: "hold" },                               // NO — negation mid-string
      { position: "Valued", trigger_hit: "недооценка отыграна", action: "close" },                                   // FIRES — "не" glued to a letter
      { position: "Over 2.5", trigger_hit: "take_price", action: "close" },                                          // real close
    ],
  });
  assert.ok(!d.exits.some((e) => e.market === "Molde FK"), "'нет — …' with an explanation is NOT a fired trigger");
  assert.ok(!d.exits.some((e) => e.market === "Draw"), "'no, not yet' is NOT a fired trigger");
  assert.ok(!d.exits.some((e) => e.market === "Bodo"), "'ещё нет' (non-leading negation) is NOT a fired trigger");
  assert.ok(!d.exits.some((e) => e.market === "Rosenborg"), "'пока не сработал' (mid-string negation) is NOT fired");
  assert.ok(d.exits.some((e) => e.market === "Valued"), "'недооценка' (не glued to a letter) is NOT a negation → fires");
  assert.ok(d.exits.some((e) => e.market === "Over 2.5"), "a real take_price close still fires");
});

test("normalizeStrategistJson: live actions map to picks/exits; close=1, reduce uses size_pct; trigger kept", () => {
  const d = normalizeStrategistJson({
    current_branch: "fav_concedes",
    actions: [
      { market: "Under 2.5", action: "close", reason: "counter", trigger: "counter_scenario" },
      { market: "BTTS No", action: "reduce", size_pct: 50, reason: "peak" },
      { market: "France -1.5", action: "add", our_prob: 0.55, reason: "add on event" },
      { market: "Draw", action: "hold" },
    ],
  });
  assert.equal(d.currentBranch, "fav_concedes");
  assert.equal(d.exits.length, 2, "close + reduce → 2 exits, hold ignored");
  const close = d.exits.find((e) => e.market === "Under 2.5")!;
  assert.equal(close.fraction, 1);
  assert.equal(close.trigger, "counter_scenario");
  const reduce = d.exits.find((e) => e.market === "BTTS No")!;
  assert.equal(reduce.fraction, 0.5, "size_pct 50 → fraction 0.5");
  assert.equal(d.picks.length, 1, "action=add → a pick");
  assert.equal(d.picks[0].label, "France -1.5");
  assert.equal(d.picks[0].prob, 0.55);
});
