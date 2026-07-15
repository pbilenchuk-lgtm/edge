import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import type { Bet } from "../src/lib/types.js";
import { clientOrderIdFor } from "../src/lib/executor/types.js";

function seedBet(db: ReturnType<typeof openDb>, over: Partial<Bet> = {}): string {
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "EPL", budget: 1000, external_league: null, created_at: "t" });
  try { R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "Overreaction", tag: "over", color: "#fff", version: 1, prompt: "", prompt_live: null, params: {}, model: "m", model_live: null, created_at: "t" } as any); } catch { /* already seeded */ }
  const mid = R.uid();
  R.insertMatch(db, { id: mid, competition_id: "c1", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: mid } as any);
  const id = R.uid();
  R.insertBet(db, { id, match_id: mid, strategy_id: "overreaction", risk_profile_id: "medium", market_label: "Over 1.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 100, rationale: "r", entered_minute: "3'", result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null, code_version: "e1", created_at: "t", ...over } as any);
  return id;
}

test("insertBet: every bet is born with a decision_id (auto-minted when absent)", () => {
  const db = openDb(":memory:");
  initSchema(db);
  const id = seedBet(db);
  const b = R.getBet(db, id)!;
  assert.ok(b.decision_id, "decision_id was auto-populated");
  assert.equal(typeof b.decision_id, "string");
});

test("insertBet: a caller-supplied decision_id is preserved (shared-decision grouping)", () => {
  const db = openDb(":memory:");
  initSchema(db);
  const shared = "dec-shared-123";
  const a = seedBet(db, { decision_id: shared } as any);
  const b = seedBet(db, { decision_id: shared } as any);
  assert.equal(R.getBet(db, a)!.decision_id, shared);
  assert.equal(R.getBet(db, b)!.decision_id, shared, "two bets can share one decision_id (twin group)");
});

test("clientOrderIdFor: deterministic, and distinct per leg — the idempotency key", () => {
  const dec = "decision-abc";
  assert.equal(clientOrderIdFor(dec, "entry"), clientOrderIdFor(dec, "entry"), "same (decision, leg) → same id across calls (idempotent re-place)");
  assert.notEqual(clientOrderIdFor(dec, "entry"), clientOrderIdFor(dec, "exit"), "entry and exit of one decision never collide");
  assert.notEqual(clientOrderIdFor(dec, "entry", 0), clientOrderIdFor(dec, "entry", 1), "seq disambiguates re-quotes");
  assert.notEqual(clientOrderIdFor("d1", "entry"), clientOrderIdFor("d2", "entry"), "different decisions → different ids");
  assert.match(clientOrderIdFor(dec, "entry"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "uuid-shaped");
});
