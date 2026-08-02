import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { scoreConsistency, scoreTrustedForDisarm, SCORE_RACE_MAX_WAIT_SEC } from "../src/lib/scoreRace.js";
import { probeDrawCanon, buildDrawCanonProbe, PROBE_NEED_OBS } from "../src/lib/drawCanonProbe.js";

// ── G1: the score race that cost $263 ────────────────────────────────────────────────────────────
// Brann–Vålerenga: the reassessment fired ON the 41' goal and was handed a 0:1 snapshot, so the strategist
// reasoned that two more goals were still needed and held. enrichFromEspn writes the scoreboard score before
// fetching matchDetail, so the event list is newer than the score it would be answered with.

function brann(db: any, scoreHome: number, scoreAway: number, goalMinutes: number[]) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "Eliteserien", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertMatch(db, { id: "m-brann", competition_id: "c1", home: "SK Brann", away: "Vålerenga", state: "live",
    lineup_out: true, kickoff_at: "2026-07-27T16:00:00Z", minute: 42, score_home: scoreHome, score_away: scoreAway,
    final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m-brann" } as any);
  for (const min of goalMinutes) {
    R.insertMatchEvent(db, { id: R.uid(), match_id: "m-brann", event_key: `goal-${min}`, minute: min, type: "goal",
      team: "Vålerenga", text: `Goal at ${min}'`, created_at: "2026-07-27T16:42:00Z" });
  }
  return R.getMatch(db, "m-brann")!;
}

test("G1: a snapshot that lags its own goal feed is NOT reasoned on — the Brann timeline", () => {
  const db = openDb(":memory:"); initSchema(db);
  const now = Date.parse("2026-07-27T16:42:00Z");
  // The exact failure: two goals in the feed (24', 41'), scoreboard still says 0:1.
  const stale = brann(db, 0, 1, [24, 41]);
  const c = scoreConsistency(db, stale, now, {});
  assert.equal(c.ok, false, "2 goal events vs a 1-goal scoreboard — the snapshot is behind its own feed");
  assert.equal(c.goalEvents, 2); assert.equal(c.scoreTotal, 1);
  assert.match(c.reason, /обоснованно НЕВЕРНЫМ/, "and the reason says WHY waiting beats deciding");
  assert.equal(scoreTrustedForDisarm(c), false, "…so it also may not be used to stand a guard down");

  // Once the score catches up, the same call proceeds — this must not be a one-way latch.
  R.updateMatch(db, "m-brann", { score_home: 0, score_away: 2 });
  const fixed = scoreConsistency(db, R.getMatch(db, "m-brann")!, now, {});
  assert.equal(fixed.ok, true, "0:2 matches the two goals in the feed");
  assert.equal(fixed.forced, false, "and it is genuinely consistent, not forced through");
  assert.equal(scoreTrustedForDisarm(fixed), true);
});

test("G1: waiting is BOUNDED — a VAR-cancelled goal must not blank live management for the rest of the match", () => {
  const db = openDb(":memory:"); initSchema(db);
  const t0 = Date.parse("2026-07-27T16:42:00Z");
  const m = brann(db, 0, 1, [24, 41]);
  assert.equal(scoreConsistency(db, m, t0, {}).ok, false, "first sighting → wait");
  // The inconsistency never resolves (the goal was chalked off; the event row stays behind).
  const later = t0 + (SCORE_RACE_MAX_WAIT_SEC({}) + 1) * 1000;
  const forced = scoreConsistency(db, m, later, {});
  assert.equal(forced.ok, true, "past the deadline the call proceeds — a permanent wait would be a blackout");
  assert.equal(forced.forced, true, "…but it is flagged as forced, never passed off as consistent");
  assert.match(forced.reason, /VAR/, "and the note names the case that makes the deadline necessary");
  assert.equal(scoreTrustedForDisarm(forced), false,
    "G2: a forced read still may NOT disarm a stop — the two consumers fail in opposite directions on purpose");
});

test("G1: a match with no goals and no score is consistent, and a normal score is not held up", () => {
  const db = openDb(":memory:"); initSchema(db);
  const now = Date.parse("2026-07-27T16:42:00Z");
  const m0 = brann(db, 0, 0, []);
  assert.equal(scoreConsistency(db, m0, now, {}).ok, true, "0:0 with no goal events — nothing contradicts it");
  R.updateMatch(db, "m-brann", { score_home: 3, score_away: 1 });
  R.insertMatchEvent(db, { id: R.uid(), match_id: "m-brann", event_key: "g1", minute: 10, type: "goal", team: "SK Brann", text: "g", created_at: "t" });
  assert.equal(scoreConsistency(db, R.getMatch(db, "m-brann")!, now, {}).ok, true,
    "a scoreboard AHEAD of the feed is fine — the feed missing a goal never makes us hold a decision back");
});

// ── G5: measure the Draw canon before deciding anything about Draw ───────────────────────────────
function drawMatch(db: any, id: string) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertMatch(db, { id, competition_id: "c1", home: "A", away: "B", state: "live", lineup_out: true,
    kickoff_at: "2026-07-27T16:00:00Z", minute: 40, score_home: 0, score_away: 0, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
}

test("G5: the probe records what the canon WOULD pick and whether that book is simultaneously quarantined", () => {
  const db = openDb(":memory:"); initSchema(db);
  drawMatch(db, "m1");
  const markets = [{ label: "Draw — Yes" }, { label: "Draw — No" }, { label: "Draw (A vs. B) — Yes" }];
  const zombie = new Map<string, any>([["Draw — Yes", { code: "notation_desync", detail: "13¢" }]]);
  probeDrawCanon(db, "m1", markets, zombie, "2026-07-27T16:40:00Z", {});
  const rep = buildDrawCanonProbe(db);
  assert.equal(rep.observations, 1, "one observation recorded");
  assert.equal(rep.matches, 1);
  assert.equal(rep.mature, false, `one row is not ${PROBE_NEED_OBS}`);
  assert.match(rep.note, /Draw ни разу не предлагался, а не поломкой канона/,
    "the note carries WHY the logs were empty — the canon runs at the fill choke, and no Draw ever reached it");
});

test("G5: identical conditions across ticks collapse to ONE observation — otherwise the counter measures tick rate", () => {
  const db = openDb(":memory:"); initSchema(db);
  drawMatch(db, "m1");
  const markets = [{ label: "Draw — Yes" }, { label: "Draw — No" }];
  const zombie = new Map<string, any>([["Draw — Yes", { code: "notation_desync", detail: "13¢" }]]);
  for (let i = 0; i < 25; i++) probeDrawCanon(db, "m1", markets, zombie, `2026-07-27T16:${String(40 + i).padStart(2, "0")}:00Z`, {});
  assert.equal(buildDrawCanonProbe(db).observations, 1,
    "a market sitting in the same state for 25 ticks is one fact, not 25 — else the double-lock rate would just track tick frequency");
  // A CHANGE of condition is a new observation.
  probeDrawCanon(db, "m1", markets, new Map(), "2026-07-27T17:10:00Z", {});
  assert.equal(buildDrawCanonProbe(db).observations, 2, "quarantine lifting is a genuinely different observation");
});

test("G5: a match with no draw book produces no observation at all", () => {
  const db = openDb(":memory:"); initSchema(db);
  drawMatch(db, "m1");
  probeDrawCanon(db, "m1", [{ label: "Over 2.5" }, { label: "Under 2.5" }], new Map(), "2026-07-27T16:40:00Z", {});
  assert.equal(buildDrawCanonProbe(db).observations, 0, "nothing to say about a match that has no draw market");
});

// ── G3: trigger freshness — the St Louis case ────────────────────────────────────────────────────
// Red card on 12', entry on 45'+5: the LLM's own declared window was still open, so the existing window check
// passed it. What was bought was not a mispriced shock but a half-match melting option — the book had had 33
// minutes to re-price. −$251. Ratified at 3 minutes against a MEASURED distribution: median event→reassess
// latency 1', p75 2', p90 4'. The first proposal of 10 minutes was rejected on that evidence — it would have
// covered 98% of reactions and cut essentially nothing.
import { overreactionGate, OVR_TRIGGER_FRESH_MIN, OVR_TRIGGER_FLAG_MIN } from "../src/lib/reassessGate.js";

const SHEET = JSON.stringify({
  live_triggers_armed: [{ name: "buyback", condition: "ранний гол андердога", window: "до ~70'" }],
});

test("G3: a stale trigger is DETRIGGERED — no money and no LLM call", () => {
  // St Louis: red card 12', now 50' → 38 minutes stale, far past the 6' band.
  const g = overreactionGate(SHEET, { totalGoals: 0, minute: 50, triggerAgeMin: 38 });
  assert.equal(g.call, false, "a panic 38 minutes old is not a setup");
  assert.match((g as any).reason, /ovr_stale_detrigger/);
  assert.match((g as any).reason, /паника давно отыграна/);
});

test("G3: the 6–12′ band spends no money but is recorded, so the threshold can be re-argued from data", () => {
  const g = overreactionGate(SHEET, { totalGoals: 1, minute: 30, triggerAgeMin: 9 });
  assert.equal(g.call, false, "money does not go in the sensitivity band");
  assert.match((g as any).reason, /ovr_stale_flag/);
  assert.match((g as any).reason, /не слишком ли туг порог/, "the note says what the record is FOR");
  assert.equal(OVR_TRIGGER_FRESH_MIN({}), 6, "W6: перератифицировано в batch-12 — денежная линия 6′");
  assert.equal(OVR_TRIGGER_FLAG_MIN({}), 12, "W6: полоса flag-only 6–12′");
});

test("G3: a FRESH trigger still passes, and an unknown age fails OPEN", () => {
  assert.equal(overreactionGate(SHEET, { totalGoals: 1, minute: 26, triggerAgeMin: 2 }).call, true,
    "2' after the goal is exactly the setup this strategy exists for");
  assert.equal(overreactionGate(SHEET, { totalGoals: 1, minute: 26, triggerAgeMin: null }).call, true,
    "no measurable age → fail OPEN, never cut a real setup blind");
  assert.equal(overreactionGate(SHEET, { totalGoals: 1, minute: 26 }).call, true,
    "field absent entirely → also open (same rule as the other pre-filters)");
});

test("G3: freshness is checked BEFORE the declared-window rule — that rule is what St Louis passed", () => {
  // Window says «до ~70'» and we are on 50', so the old check is satisfied; only freshness rejects it.
  const g = overreactionGate(SHEET, { totalGoals: 1, minute: 50, triggerAgeMin: 38 });
  assert.equal(g.call, false);
  assert.match((g as any).reason, /триггер-событие/, "rejected on staleness, not on the window");
});

// ── Complement lookup: the condition-1 danger is settling one line against another ───────────────
import { complementKey, findComplementMarket, resolveComplement } from "../src/lib/complementMarket.js";
import { backfillComplementTokens, auditComplementVoids } from "../src/lib/complementBackfill.js";

test("complement: the pair is keyed on subject × EXACT line × inverted side — never a neighbouring total", () => {
  // The Falkenbergs catalogue is exactly the trap: both 1.5 and 3.5 lines are quoted.
  const cat = [
    { label: "Falkenbergs FF Under 1.5", external_ref: "t-u15" },
    { label: "Falkenbergs FF Over 1.5", external_ref: "t-o15" },
    { label: "Under 3.5", external_ref: "t-u35" },
    { label: "Over 3.5", external_ref: "t-o35" },
    { label: "Over 1.5", external_ref: "t-o15m" },
  ];
  assert.equal(findComplementMarket("Under 3.5", cat)?.token, "t-o35");
  assert.equal(findComplementMarket("Falkenbergs FF Under 1.5", cat)?.token, "t-o15",
    "the TEAM total pairs with the same team's own opposite side, not the match total");
  // The failure this test exists to prevent: Under 3.5 must never bind to Over 1.5.
  assert.notEqual(findComplementMarket("Under 3.5", cat)?.token, "t-o15m");
});

test("complement: no invertible side, or an ambiguous catalogue, yields NOTHING — fail-closed", () => {
  assert.equal(complementKey("SK Brann (-1.5)"), null, "a handicap has no side token to invert → no guess");
  assert.equal(complementKey("Under 3.5"), "over35");
  assert.equal(complementKey("Draw — Yes"), "drawno");
  // Duplicate notations of the same outcome: picking one arbitrarily is how a settle binds to the wrong book.
  const dupes = [
    { label: "Draw — Yes", external_ref: "a" },
    { label: "Draw — No", external_ref: "b" },
    { label: "Draw (A vs. B) — No", external_ref: "c" },
  ];
  assert.equal(findComplementMarket("Draw — Yes", dupes), null, "two candidates carry the complement key → refuse");
});

test("complement: a club whose NAME contains a side word is not corrupted mid-string", () => {
  const cat = [{ label: "Yesilyurt Under 1.5", external_ref: "u" }, { label: "Yesilyurt Over 1.5", external_ref: "o" }];
  assert.equal(findComplementMarket("Yesilyurt Under 1.5", cat)?.token, "o",
    "the swap is anchored at the END of the key, so 'Yes'ilyurt is never treated as a side token");
});

test("complement: a stored pointer always wins, and its provenance is reported", () => {
  const cat = [{ label: "Under 3.5", external_ref: "u" }, { label: "Over 3.5", external_ref: "o" }];
  assert.equal(resolveComplement("Under 3.5", "stored-tok", cat)?.via, "stored");
  assert.equal(resolveComplement("Under 3.5", "stored-tok", cat)?.token, "stored-tok");
  assert.equal(resolveComplement("Under 3.5", null, cat)?.via, "match");
});

test("condition 4: the backfill touches ONLY markets carrying open money, and never overwrites a pointer", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  for (const id of ["m-open", "m-quiet"]) {
    R.insertMatch(db, { id, competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t",
      minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as any);
    R.insertMarket(db, { id: R.uid(), match_id: id, label: "Under 3.5", price: 55, ai_prob: 0.6, liquidity: "900", external_ref: `u-${id}`, snapshot_at: "t", is_closing: false } as any);
    R.insertMarket(db, { id: R.uid(), match_id: id, label: "Over 3.5", price: 45, ai_prob: 0.4, liquidity: "900", external_ref: `o-${id}`, snapshot_at: "t", is_closing: false } as any);
  }
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,created_at) VALUES ('b1','m-open','prematch_value','max','Under 3.5','open',55,50,'t')`).run();
  const r = backfillComplementTokens(db, "2026-07-28T00:00:00Z");
  assert.equal(r.matches, 1, "only the match with an open position is visited");
  assert.equal(r.tokensWritten, 1);
  const got = db.prepare(`SELECT token_second FROM markets WHERE match_id='m-open' AND label='Under 3.5'`).get() as any;
  assert.equal(got.token_second, "o-m-open");
  const quiet = db.prepare(`SELECT token_second FROM markets WHERE match_id='m-quiet' AND label='Under 3.5'`).get() as any;
  assert.equal(quiet.token_second, null, "a match with no live money is left alone — the import path covers it");
});

test("condition 5: the retro-audit sweeps BOTH refund tags and reports before it rewrites anything", async () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t",
    minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Under 3.5", price: 99, ai_prob: 0.6, liquidity: "900", external_ref: "u", snapshot_at: "t", is_closing: false } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Over 3.5", price: 1, ai_prob: 0.4, liquidity: "900", external_ref: "o", snapshot_at: "t", is_closing: false } as any);
  // The exact shape the ratification pointed at — refunded with tag 'void' (NOT 'void_timeout'), because the
  // single-token path uses that tag. Auditing only void_timeout would have missed this entire population.
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,payout,settled_by,created_at)
              VALUES ('b1','m1','prematch_value','max','Under 3.5','settled_void',50,100,100,'void','t')`).run();
  const resolveTokens = async () => ({ u: { priceCents: 99, closed: true }, o: { priceCents: 1, closed: true } });

  const dry = await auditComplementVoids(db, { resolveTokens } as any, { apply: false });
  assert.equal(dry.reSettled, 1, "the refund was actually a WIN — the complement just was not stored");
  assert.equal(dry.won, 1);
  assert.match(dry.note, /сухой прогон/, "a dry run says so plainly");
  assert.equal((db.prepare(`SELECT status FROM bets WHERE id='b1'`).get() as any).status, "settled_void",
    "…and changes nothing until asked");

  const applied = await auditComplementVoids(db, { resolveTokens, now: () => "2026-07-28T00:00:00Z" } as any, { apply: true });
  assert.equal(applied.reSettled, 1);
  const after = db.prepare(`SELECT status, settled_via FROM bets WHERE id='b1'`).get() as any;
  assert.equal(after.status, "settled_won");
  assert.equal(after.settled_via, "match_complement_retro", "provenance says the row was rewritten by the audit");
});

test("condition 5: an unresolved or half-resolved pair leaves the refund alone", async () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t",
    minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Under 3.5", price: 60, ai_prob: 0.6, liquidity: "900", external_ref: "u", snapshot_at: "t", is_closing: false } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Over 3.5", price: 40, ai_prob: 0.4, liquidity: "900", external_ref: "o", snapshot_at: "t", is_closing: false } as any);
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,payout,settled_by,created_at)
              VALUES ('b1','m1','prematch_value','max','Under 3.5','settled_void',50,100,100,'void_timeout','t')`).run();
  const r = await auditComplementVoids(db, { resolveTokens: async () => ({ u: { priceCents: 60, closed: false }, o: { priceCents: 40, closed: false } }) } as any, { apply: true });
  assert.equal(r.complementFound, 1, "the complement is findable…");
  assert.equal(r.reSettled, 0, "…but 60/40 is not a resolving pair, so booked history is not rewritten on a guess");
  assert.equal((db.prepare(`SELECT status FROM bets WHERE id='b1'`).get() as any).status, "settled_void");
});

test("retro-audit: a locked row is DEFERRED, not counted and not fatal — the pass stays idempotent", async () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t",
    minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Under 3.5", price: 99, ai_prob: 0.6, liquidity: "900", external_ref: "u", snapshot_at: "t", is_closing: false } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Over 3.5", price: 1, ai_prob: 0.4, liquidity: "900", external_ref: "o", snapshot_at: "t", is_closing: false } as any);
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,payout,settled_by,created_at)
              VALUES ('b1','m1','prematch_value','max','Under 3.5','settled_void',50,100,100,'void','t')`).run();
  // Simulate the production failure: the write throws exactly as "database is locked" did.
  const realPrepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    if (/^UPDATE bets SET/.test(sql)) return { run: () => { throw new Error("database is locked"); } };
    return realPrepare(sql);
  };
  const r = await auditComplementVoids(db, { resolveTokens: async () => ({ u: { priceCents: 99, closed: true }, o: { priceCents: 1, closed: true } }) } as any, { apply: true });
  (db as any).prepare = realPrepare;
  assert.equal(r.deferred, 1, "the contended row is deferred");
  assert.equal(r.reSettled, 0, "…and NOT counted as re-settled — the first prod run would have over-reported");
  assert.equal(r.bankDeltaUsd, 0, "…nor added to the bank delta");
  assert.match(r.note, /НИЧЕГО НЕ ЗАПИСАНО/, "a fully-deferred run must not read as «the pairs were unclean» — opposite meanings");
  assert.match(r.note, /запустите ту же команду ещё раз/, "…and it tells the operator the pass is safe to repeat");
  assert.equal((db.prepare(`SELECT status FROM bets WHERE id='b1'`).get() as any).status, "settled_void",
    "the row is untouched, so a re-run picks it up again — that is what makes deferral safe");
});

// ── Ratified #1: the void rate is the sensor whose ABSENCE cost a month ──────────────────────────
import { buildVoidWatch, VOID_ALARM_PCT, VOID_WATCH_MIN_N } from "../src/lib/voidWatch.js";

function voidBed(db: any) {
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t",
    minute: null, score_home: 1, score_away: 1, final_score: "1-1", kickoff_time: null, end_time: "t", duration: null, end_note: null, external_ref: "m1" } as any);
}
// [четвёрка, п.1] Причина возврата сидит в settled_via — МАШИННОМ поле, которое пишет сам путь возврата.
// Раньше этот бед клал её в `rationale`, и тест сходился с кодом лишь потому, что оба делали одно и то же
// неверное допущение: продакшен в rationale причину возврата не пишет НИКОГДА (там причина входа).
const addBet = (db: any, id: string, status: string, settledAt: string, settledBy: string | null, settledVia: string | null = null) =>
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,payout,settled_by,settled_via,settled_at,created_at)
              VALUES (?,'m1','prematch_value','max','Under 2.5',?,50,100,100,?,?,?,'t')`).run(id, status, settledBy, settledVia, settledAt);

test("#1: a spike of refunds raises an ALARM, and names OUR failure separately from the exchange's", () => {
  const db = openDb(":memory:"); initSchema(db);
  voidBed(db);
  const now = Date.parse("2026-07-28T00:00:00Z");
  const at = "2026-07-27T20:00:00Z";
  for (let i = 0; i < 20; i++) addBet(db, `w${i}`, "settled_won", at, null);
  // Five refunds, of which four are the complement failure — the exact signature that hid 225 rows.
  for (let i = 0; i < 4; i++) addBet(db, `v${i}`, "settled_void", at, "void", "no_complement");
  addBet(db, "vm", "settled_void", at, "void", "market_void");
  const r = buildVoidWatch(db, 24, now, {});
  assert.equal(r.decided, 25);
  assert.equal(r.voids, 5);
  assert.equal(r.voidPct, 20);
  assert.equal(r.verdict, "ALARM", `20% is far past the ${VOID_ALARM_PCT({})}% threshold`);
  assert.equal(r.byReason["нет_комплемента"], 4, "OUR inability to verify is counted apart…");
  assert.equal(r.byReason["market_void"], 1, "…from the exchange's own void — same status, opposite meaning");
  assert.match(r.note, /НАША неспособность сверить/, "and the note points at the reason to start from");
});

test("#1: a normal day is quiet, and a tiny sample refuses to have an opinion", () => {
  const db = openDb(":memory:"); initSchema(db);
  voidBed(db);
  const now = Date.parse("2026-07-28T00:00:00Z");
  const at = "2026-07-27T20:00:00Z";
  for (let i = 0; i < 39; i++) addBet(db, `w${i}`, "settled_won", at, null);
  addBet(db, "v0", "settled_void", at, "void", "market_void");
  const ok = buildVoidWatch(db, 24, now, {});
  assert.equal(ok.verdict, "ok", "2.5% of refunds is ordinary — a sensor that cries every day is ignored by week two");

  const db2 = openDb(":memory:"); initSchema(db2);
  voidBed(db2);
  addBet(db2, "v0", "settled_void", at, "void", "нет комплемента");
  const thin = buildVoidWatch(db2, 24, now, {});
  assert.equal(thin.verdict, "insufficient", `1 decided bet is not ${VOID_WATCH_MIN_N}`);
  assert.match(thin.note, /ничего не значит/, "100% of one bet is theatre, and the note says so");
});

test("#1: bets settled OUTSIDE the window do not count — the rate is about now, not about history", () => {
  const db = openDb(":memory:"); initSchema(db);
  voidBed(db);
  const now = Date.parse("2026-07-28T00:00:00Z");
  for (let i = 0; i < 25; i++) addBet(db, `old${i}`, "settled_void", "2026-07-01T00:00:00Z", "void", "нет комплемента");
  const r = buildVoidWatch(db, 24, now, {});
  assert.equal(r.decided, 0);
  assert.equal(r.verdict, "insufficient", "a month-old pile of refunds must not keep the alarm ringing forever");
});

// ── The thesis cap must be AUDITABLE, not just correct ───────────────────────────────────────────
// A review round was spent unable to answer «did the cap ever act?»: the trade log recorded only outright
// blocks, so a silent clamp was indistinguishable from a disabled cap. The Brann stack ($80+$30+$166+$50 =
// $326 against a $250 cap) could not be diagnosed from the record — only guessed at.
import { matchThesisRoom, thesisCapUsd, bankUsd } from "../src/lib/thesisExposure.js";
import { correlationKey, sizePrematch } from "../src/lib/strategist.js";
import { DEFAULT_RISK_CONFIG } from "../src/lib/riskConfig.js";

test("cap: a 4-profile stack on ONE thesis is clamped at the cap, counting across profiles", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "SK Brann", away: "Vålerenga", state: "lineup", lineup_out: true,
    kickoff_at: "t", minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null,
    end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  const env = { THESIS_BANK_USD: "1000", THESIS_MATCH_CAP_FRAC: "0.25", THESIS_DAILY_CLUSTER_MULT: "2" };
  assert.equal(thesisCapUsd(env), 250, "1000 × 0.25 — the ratified cap");

  const key = correlationKey("Under 3.5", "SK Brann", "Vålerenga");
  assert.equal(key, "total:under", "a match Under keys into the low-total cluster — the cap is not skipped");

  // Fill the Brann stack profile by profile, exactly as autoEnter does: each fill commits `open` before the
  // next re-check, so the room shrinks as the stack grows.
  const fill = (id: string, prof: string, want: number) => {
    const room = matchThesisRoom(db, "m1", key!, "SK Brann", "Vålerenga", env, ["open"]);
    const got = Math.min(want, Math.max(0, room));
    if (got >= 1) db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,created_at)
                              VALUES (?,'m1','prematch_value',?,'Under 3.5','open',51,?,'t')`).run(id, prof, got);
    return got;
  };
  assert.equal(fill("b1", "aggressive", 80), 80);
  assert.equal(fill("b2", "conservative", 30), 30);
  assert.equal(fill("b3", "max", 166), 140, "the third leg is TRIMMED to the remaining room, not granted in full");
  assert.equal(fill("b4", "medium", 50), 0, "and the fourth gets nothing — the thesis is at its cap");

  const total = (db.prepare(`SELECT ROUND(SUM(stake),2) s FROM bets WHERE match_id='m1' AND status='open'`).get() as any).s;
  assert.equal(total, 250, "the whole stack lands exactly on the cap — never the $326 that was actually booked");
});

test("cap: with the env unset the cap is OFF and the same stack passes unclamped — the two states must be distinguishable", () => {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "A", away: "B", state: "lineup", lineup_out: true, kickoff_at: "t",
    minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  assert.equal(thesisCapUsd({}), 0, "no env → no cap");
  assert.equal(matchThesisRoom(db, "m1", "total:under", "A", "B", {}, ["open"]), Infinity,
    "…and infinite room, which is exactly why an empty cap log proves nothing on its own");
});

// ── sizing_insanity on the football path ─────────────────────────────────────────────────────────
// The $28,291 set_value bets of 17 July — IDENTICAL across all four profiles, on a $1,000 bank — were the
// signature of a corrupted budget input: profiles are supposed to size differently, so equal stakes mean the
// number did not come from per-profile sizing at all. The backstop built in response (sizing_insanity, 23 Jul)
// was wired into tennis only. Football kept sizing off `competitions.budget` — a DB row, i.e. exactly the
// corruptible input the guard exists for — with no absolute floor under it.
test("sizing_insanity: a corrupted competition budget cannot size a football stake past half the declared bank", () => {
  const cfg = DEFAULT_RISK_CONFIG;
  const inp = { ourProb: 0.62, priceCents: 45, implied: 0.45, calibration: 0.6, liquidity: 500_000,
    matchExposure: 0, compExposure: 0, cfg };

  // A competition budget of $1M (the poisoned-epoch shape) passes every budget-RELATIVE cap, because they are
  // all fractions OF the corrupted number.
  const unguarded = sizePrematch({ ...inp, budget: 1_000_000 });
  assert.equal(unguarded.status, "enter");
  assert.ok(unguarded.stake > 500, `without a bank ceiling the caps scale with the corruption: $${unguarded.stake}`);

  // With the declared bank passed, the same call is REJECTED — loudly, never silently trimmed to something
  // plausible-looking. A trim would have booked a wrong-but-sane stake and left no trace of the corruption.
  const guarded = sizePrematch({ ...inp, budget: 1_000_000, bankCeiling: 1000 });
  assert.equal(guarded.status, "flag");
  assert.equal(guarded.stake, 0);
  assert.match(guarded.reason, /sizing_insanity/);

  // And a HEALTHY budget is untouched by the ceiling — the guard must not cost a single legitimate entry.
  const healthy = sizePrematch({ ...inp, budget: 2000, bankCeiling: 1000 });
  assert.equal(healthy.status, "enter");
  assert.ok(healthy.stake > 0 && healthy.stake <= 500);
});

test("sizing_insanity: an undeclared bank leaves the guard inert — bankUsd(0) must not become a $0 ceiling", () => {
  // bankUsd returns 0 when THESIS_BANK_USD is unset, and the call sites pass `|| undefined`. If 0 leaked
  // through as a ceiling, `stake > 0 × 0.5` would be true for every bet and the guard would block the entire
  // book. Fail-closed is right for a settle; here it would be a silent trading halt.
  assert.equal(bankUsd({}), 0);
  assert.equal(bankUsd({ THESIS_BANK_USD: "1000" }), 1000);
  const r = sizePrematch({ ourProb: 0.62, priceCents: 45, implied: 0.45, calibration: 0.6, liquidity: 500_000,
    matchExposure: 0, compExposure: 0, cfg: DEFAULT_RISK_CONFIG, budget: 1000, bankCeiling: bankUsd({}) || undefined });
  assert.equal(r.status, "enter", "no declared bank → no ceiling → the book keeps trading as before");
});

// [четвёрка, п.1] Сторож, который делит возвраты на «наша вина» и «решение биржи», читал ПРОЗУ входа
// (b.rationale) — поле, куда причина возврата не пишется никогда. Регулярка не совпадала ни разу, и главная
// причина — «нет комплемента» — печаталась как market_void, то есть как решение биржи. Ровно наоборот.
test("#1: причина возврата берётся из МАШИННОГО поля, а не из прозы; неразмеченное не выдаётся за void биржи", () => {
  const db = openDb(":memory:"); initSchema(db);
  voidBed(db);
  const now = Date.parse("2026-07-28T00:00:00Z");
  const at = "2026-07-27T20:00:00Z";
  for (let i = 0; i < 20; i++) addBet(db, `w${i}`, "settled_won", at, null);
  addBet(db, "vt", "settled_void", at, "void_timeout", "timeout_not_closed");
  // Строка ДО фикса: settled_by='void' есть, машинной причины нет. Назвать её решением биржи нельзя —
  // именно так ошибка и пряталась.
  addBet(db, "vlegacy", "settled_void", at, "void", null);
  const r = buildVoidWatch(db, 24, now, {});
  assert.equal(r.byReason["void_timeout"], 1, "таймаут опознан по settled_via");
  assert.equal(r.byReason["market_void"], undefined, "неразмеченная строка НЕ засчитана как void биржи");
  assert.equal(r.byReason["не_размечено:void"], 1, "она честно уходит в отдельную корзину");
});

// ── РЕТРО-ПРОХОД: ЗАВИСИМОСТЬ ЗНАЕТ САМ МОДУЛЬ, ДЕЛЬТА ИЗМЕРЯЕТСЯ ИЗ БАЗЫ ─────────────────────────
// Прод 02.08: ежедневный вызов из цикла возвращал examined=43, complementFound=23, reSettled=0 с честным
// диагнозом «резолвер токенов не передан». Передавал его только скрипт — именной класс «скрипт умеет, код
// не умеет», тот же, что был у CLV. Лечение структурное: модуль сам подставляет зависимость, как pmResolution.

/** Мир для ретро-прохода: один возврат, у которого комплемент ЕСТЬ в каталоге матча. */
function retroWorld() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Football");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "F", budget: 8000, external_league: "nor.1", created_at: "t" } as any);
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: null, color: null, version: 1, prompt: "", prompt_live: null, params: null, model: null, model_live: null, created_at: "t" } as any);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true, kickoff_at: "t",
    minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Under 3.5", price: 99, ai_prob: 0.6, liquidity: "900", external_ref: "u", snapshot_at: "t", is_closing: false } as any);
  R.insertMarket(db, { id: R.uid(), match_id: "m1", label: "Over 3.5", price: 1, ai_prob: 0.4, liquidity: "900", external_ref: "o", snapshot_at: "t", is_closing: false } as any);
  db.prepare(`INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,entry_price,stake,payout,settled_by,created_at)
              VALUES ('b1','m1','prematch_value','max','Under 3.5','settled_void',50,100,100,'void','t')`).run();
  return db;
}

test("ретро БЕЗ явного резолвера больше не отказывается — модуль знает свою зависимость сам", async () => {
  const db = retroWorld();
  // Резолвер не передан вовсе. Раньше здесь был мгновенный отказ с note «не передан».
  const r = await auditComplementVoids(db, { now: () => "2026-07-28T00:00:00Z" } as any, { apply: false });
  assert.doesNotMatch(r.note, /резолвер токенов не передан/, "отказ по отсутствию зависимости снят");
  assert.ok(r.examined > 0, "проход дошёл до работы, а не встал на пороге");
});

test("Δ книги ИЗМЕРЯЕТСЯ из базы и сверяется с обещанием предиката", async () => {
  const db = retroWorld();
  const resolveTokens = async () => ({ u: { priceCents: 99, closed: true }, o: { priceCents: 1, closed: true } });
  const r = await auditComplementVoids(db, { resolveTokens, now: () => "2026-07-28T00:00:00Z" } as any, { apply: true });
  assert.ok(r.reSettled > 0, "прогон что-то записал — иначе сверять нечего");
  assert.ok(r.bookBefore && r.bookAfter, "книга снята ДО и ПОСЛЕ");
  assert.equal(r.deltaAgrees, true, "обещание предиката и факт из базы сошлись");
  assert.equal(r.bookMeasuredUsd, r.bankDeltaUsd, "два независимых пути к одному числу дали одно число");
  assert.doesNotMatch(r.note, /РАСХОЖДЕНИЕ/);
});

test("сухой прогон книгу не двигает — измеренная дельта ровно ноль", async () => {
  const db = retroWorld();
  const resolveTokens = async () => ({ u: { priceCents: 99, closed: true }, o: { priceCents: 1, closed: true } });
  const r = await auditComplementVoids(db, { resolveTokens } as any, { apply: false });
  assert.equal(r.bookMeasuredUsd, 0, "apply=false не пишет ничего");
  assert.ok(r.bankDeltaUsd !== 0, "но предикат честно показывает, СКОЛЬКО бы записал");
});
