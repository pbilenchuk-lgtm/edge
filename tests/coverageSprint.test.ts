import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { bindsNeededForTarget, buildCoverageSprint } from "../src/lib/coverageSprint.js";

test("bindsNeededForTarget: how many blind must bind to hit the target at fixed total", () => {
  assert.equal(bindsNeededForTarget(7, 10, 85), 2, "7/10=70% → need 2 more (9/10=90%≥85)");
  assert.equal(bindsNeededForTarget(9, 10, 85), 0, "already ≥ target");
  assert.equal(bindsNeededForTarget(0, 4, 85), 4, "capped at the blind count");
  assert.equal(bindsNeededForTarget(0, 0, 85), 0, "empty cohort");
});

function seed() {
  const d = openDb(":memory:"); initSchema(d);
  R.upsertSport(d, "football", "Football");
  const now = Date.now();
  const iso = (offH: number) => new Date(now + offH * 3_600_000).toISOString();
  // a euro cup comp (uefa.champions — a known two-leg euro league), funded, with a match that ran past kickoff
  // and has NO match_live (blind funded). league set → "unbound" → name_or_dark.
  R.upsertCompetition(d, { id: "c-ucl", sport_id: "football", name: "UEFA Champions League", budget: 8000, external_league: "uefa.champions", created_at: "t" });
  R.insertMatch(d, { id: "m-euro", competition_id: "c-ucl", home: "Neftçi PFK", away: "Some Club", state: "live", lineup_out: false, kickoff_at: iso(-1), minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m-euro" } as any);
  R.insertMarket(d, { id: "mk1", match_id: "m-euro", label: "Neftçi PFK", price: 50, ai_prob: null, liquidity: 1000, external_ref: "tok1", token_second: null, snapshot_at: "t", is_closing: 0, ask_cents: null, spread_cents: null } as any);
  // a funded comp with NO external_league → "no_league" (needs a league mapping)
  R.upsertCompetition(d, { id: "c-x", sport_id: "football", name: "Mystery League", budget: 5000, external_league: null, created_at: "t" });
  R.insertMatch(d, { id: "m-x", competition_id: "c-x", home: "Alpha", away: "Beta", state: "live", lineup_out: false, kickoff_at: iso(-1), minute: 20, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m-x" } as any);
  R.insertMarket(d, { id: "mk2", match_id: "m-x", label: "Alpha", price: 50, ai_prob: null, liquidity: 1000, external_ref: "tok2", token_second: null, snapshot_at: "t", is_closing: 0, ask_cents: null, spread_cents: null } as any);
  return d;
}

test("buildCoverageSprint: names the blind funded fixtures with class + action, and classes them", () => {
  const d = seed();
  const s = buildCoverageSprint(d);
  const euro = s.unbound.find((u) => u.match.startsWith("Neftçi"));
  const noLeague = s.unbound.find((u) => u.match === "Alpha—Beta");
  assert.ok(euro, "euro blind-funded fixture named");
  assert.equal(euro!.cls, "name_or_dark", "league set but unbound → name_or_dark");
  assert.ok(euro!.euro, "flagged euro");
  assert.match(euro!.action, /псевдоним|probe/i, "action points at the name/alias fix");
  assert.ok(noLeague, "no-league fixture named");
  assert.equal(noLeague!.cls, "no_league");
  assert.match(noLeague!.action, /привязать лигу|external_league/i);
  assert.equal(s.unboundByClass.no_league, 1);
  assert.equal(s.unboundByClass.name_or_dark, 1);
  // euro-first ordering
  assert.ok(s.unbound.indexOf(euro!) < s.unbound.indexOf(noLeague!), "euro sorts before non-euro");
  assert.equal(s.target.euroTargetPct, 85);
});
