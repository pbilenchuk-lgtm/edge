import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadLiveProbConfig, remainingXgFraction, gameStateMultiplier, lateGameProfile,
  liveScoreProb, poissonAtLeast, liveAdjustedProb,
} from "../src/lib/liveProb.js";

const cfg = loadLiveProbConfig({}); // defaults

// ── ЭТАЛОННЫЙ КЕЙС (Argentina–Switzerland, matchId d271b090) ──────────────────
// Швейцария 0:1 на 54', базовый xg_away 1.05, away_share1h 0.45. Система раньше
// оценила P(забьёт за остаток) ≈ 0.34 от накопленного live-xG и срезала позицию.
// Game-state-число должно выйти в 0.45–0.60 (отстающий обязан раскрыться + концовка).
test("reference case: Switzerland 0:1 at 54' lands in [0.45, 0.60], not 0.34", () => {
  const r = liveScoreProb({ teamXgFull: 1.05, teamShare1h: 0.45, minute: 54, scoreDiff: -1 }, cfg);
  assert.ok(r.prob >= 0.45 && r.prob <= 0.60, `expected P in [0.45,0.60], got ${r.prob.toFixed(3)}`);
  assert.ok(r.prob > 0.40, `must beat the buggy back-extrapolated 0.34, got ${r.prob.toFixed(3)}`);
  assert.equal(r.gs, cfg.gsTrail1, "trailing by 1 → gsTrail1 multiplier");
  assert.ok(r.late > 1, "past 45' the late-game profile boosts");
});

test("reference case wired through liveAdjustedProb for 'Switzerland Over 0.5'", () => {
  const adj = liveAdjustedProb("Switzerland Over 0.5", {
    home: "Argentina", away: "Switzerland",
    scoreHome: 1, scoreAway: 0, minute: 54,
    core: { xg_home: 1.6, xg_away: 1.05, home_share_1h: 0.5, away_share_1h: 0.45 },
  }, cfg);
  assert.ok(adj, "melting Over 0.5 → adjusted prob returned");
  assert.ok(adj!.prob >= 0.45 && adj!.prob <= 0.60, `expected [0.45,0.60], got ${adj!.prob.toFixed(3)}`);
});

// ── UNIT: game_state_multiplier applies ONLY to the trailing team ─────────────
test("gameStateMultiplier: trailing boosted, leading reduced, level neutral", () => {
  assert.ok(gameStateMultiplier(-1, cfg) > 1, "trailing by 1 → boost");
  assert.equal(gameStateMultiplier(-1, cfg), cfg.gsTrail1);
  assert.equal(gameStateMultiplier(-2, cfg), cfg.gsTrail2plus);
  assert.ok(gameStateMultiplier(-2, cfg) < gameStateMultiplier(-1, cfg), "trailing 2+ modest (не задирать)");
  assert.equal(gameStateMultiplier(0, cfg), 1, "level → 1.0");
  assert.ok(gameStateMultiplier(1, cfg) < 1, "leading → reduction");
  assert.equal(gameStateMultiplier(1, cfg), cfg.gsLead);
});

test("leading team gets the reduction, trailing gets the boost (same xg/minute)", () => {
  const trail = liveScoreProb({ teamXgFull: 1.05, teamShare1h: 0.45, minute: 54, scoreDiff: -1 }, cfg);
  const lead = liveScoreProb({ teamXgFull: 1.05, teamShare1h: 0.45, minute: 54, scoreDiff: 1 }, cfg);
  assert.ok(trail.prob > lead.prob, "trailing team's remainder P must exceed the leading team's");
  assert.equal(lead.gs, cfg.gsLead);
});

// ── UNIT: late_game_profile ramps the endgame ────────────────────────────────
test("lateGameProfile: flat until lateFromMin, ramps to 1+lateBoost by regEnd", () => {
  assert.equal(lateGameProfile(30, cfg), 1, "before lateFromMin → 1.0");
  assert.equal(lateGameProfile(cfg.lateFromMin, cfg), 1, "at lateFromMin → 1.0");
  assert.ok(lateGameProfile(70, cfg) > lateGameProfile(55, cfg), "monotonic ramp toward the end");
  assert.ok(Math.abs(lateGameProfile(90, cfg) - (1 + cfg.lateBoost)) < 1e-9, "at regEnd → 1+lateBoost");
});

// ── UNIT: remainingXgFraction decays 1→0 across the match ────────────────────
test("remainingXgFraction: 1 at kick-off, small-positive in stoppage, 0 past reg+stoppage, back-loaded when share1h<0.5", () => {
  assert.equal(remainingXgFraction(0, 0.45), 1);
  // A still-live option in the 90'+ window keeps a SMALL positive fraction (not 0) —
  // late/stoppage goals still cluster; it decays to 0 only past regEnd + stoppage.
  assert.ok(remainingXgFraction(90, 0.45) > 0 && remainingXgFraction(90, 0.45) < 0.1, "90' → small positive (stoppage still to play)");
  assert.equal(remainingXgFraction(95, 0.45), 0, "past reg+stoppage → 0");
  assert.equal(remainingXgFraction(90, 0.45, 90, 0), 0, "with stoppage=0 → 0 at regEnd (back-compat)");
  assert.ok(remainingXgFraction(45, 0.45) > 0.5, "at half-time most xG (2nd half) still to come when share1h<0.5");
  // Monotonic non-increasing across the whole window incl. stoppage.
  let prev = 1;
  for (let mn = 0; mn <= 95; mn += 5) { const f = remainingXgFraction(mn, 0.45); assert.ok(f <= prev + 1e-9, `non-increasing at ${mn}'`); prev = f; }
});

// ── UNIT: poissonAtLeast for Over 1.5 (≥2 goals) ─────────────────────────────
test("poissonAtLeast: P(X>=k) monotonic in lambda, k", () => {
  assert.equal(poissonAtLeast(0, 0.5), 1, "k<=0 → 1");
  assert.ok(poissonAtLeast(1, 1) > poissonAtLeast(2, 1), "P(>=1) > P(>=2) for same lambda");
  assert.ok(poissonAtLeast(2, 2) > poissonAtLeast(2, 1), "higher lambda → higher P(>=2)");
});

// ── SCOPE: only melting options (team Over 0.5/1.5, BTTS-Yes) get a number ────
test("liveAdjustedProb: out-of-scope markets return null", () => {
  const base = {
    home: "Argentina", away: "Switzerland", scoreHome: 1, scoreAway: 0, minute: 54,
    core: { xg_home: 1.6, xg_away: 1.05, home_share_1h: 0.5, away_share_1h: 0.45 },
  };
  assert.equal(liveAdjustedProb("Under 2.5 goals", base, cfg), null, "Under → null");
  assert.equal(liveAdjustedProb("Both Teams To Score - No", base, cfg), null, "BTTS-No → null");
  assert.equal(liveAdjustedProb("Argentina", base, cfg), null, "1X2 directional → null");
  assert.equal(liveAdjustedProb("Switzerland Over 0.5", { ...base, minute: null }, cfg), null, "no minute → null");
});

test("liveAdjustedProb: an already-resolved leg reads ~1.0", () => {
  const adj = liveAdjustedProb("Argentina Over 0.5", {
    home: "Argentina", away: "Switzerland", scoreHome: 1, scoreAway: 0, minute: 54,
    core: { xg_home: 1.6, xg_away: 1.05, home_share_1h: 0.5, away_share_1h: 0.45 },
  }, cfg);
  assert.ok(adj && adj.prob >= 0.999, "Argentina already scored → Over 0.5 resolved ~1.0");
});

test("liveAdjustedProb: BTTS-Yes multiplies both sides' remainder P", () => {
  const adj = liveAdjustedProb("Both Teams To Score - Yes", {
    home: "Argentina", away: "Switzerland", scoreHome: 1, scoreAway: 0, minute: 54,
    core: { xg_home: 1.6, xg_away: 1.05, home_share_1h: 0.5, away_share_1h: 0.45 },
  }, cfg);
  // Home already scored (P=1) → BTTS reduces to P(away scores in remainder).
  const away = liveScoreProb({ teamXgFull: 1.05, teamShare1h: 0.45, minute: 54, scoreDiff: -1 }, cfg);
  assert.ok(adj && Math.abs(adj.prob - away.prob) < 1e-9, "BTTS-Yes = 1 × P(away scores)");
});

// ── env-tunable: constants come from env, not hardcoded ──────────────────────
test("loadLiveProbConfig: env overrides the defaults", () => {
  const c = loadLiveProbConfig({ LIVEPROB_GS_TRAIL1: "1.5", LIVEPROB_LATE_BOOST: "0.2" });
  assert.equal(c.gsTrail1, 1.5);
  assert.equal(c.lateBoost, 0.2);
  assert.equal(c.gsLead, 0.85, "unset stays at default");
});
