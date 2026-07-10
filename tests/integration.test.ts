import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase, seedMinimal, migrateCanonicalPrompts, migrateStrategyRoster } from "../src/lib/seed.js";
import { seedRiskProfiles } from "../src/lib/riskConfig.js";
import * as R from "../src/lib/repo.js";
import {
  loadPolymarketConfig, getQuotes, fetchMidpointCents,
  normalizeEvent, eventToMarketSnapshots, titleMatchScore,
  findMatchEvent, fetchEventBySlug, listSportEvents,
  isNoiseMarket, matchMarketSnapshots, parseMatchTitle, discoverSportMatches,
} from "../src/lib/polymarket.js";
import {
  resolveModel, apiKeyFor, callLLM, generateStrategyName, heuristicName,
  effectiveEnv, providerEnabled,
} from "../src/lib/llm.js";
import { extractThresholds } from "../src/lib/thresholds.js";
import { analyzeMatch } from "../src/lib/analysis.js";
import { parseStatpalTennis, parseStatpalEsports, parseStatpalCricket, parseStatpalSoccer, StatpalSportsProvider, CompositeSportsProvider, loadSportsConfig as loadSportsCfg, EspnSportsProvider } from "../src/lib/sports.js";

// Mock an Anthropic response carrying a JSON assessment for assessMatchLLM.
function mockLLM(assessment: unknown) {
  return async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(assessment) }] }) }) as any;
}

test("assessMatchLLM is price-blind — analysis prompt carries labels, never Polymarket quotes", async () => {
  const { assessMatchLLM } = await import("../src/lib/llm.js");
  let sent = "";
  const fetchImpl = (async (_url: any, init: any) => {
    sent = init.body;
    return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ confidence: "средняя", short: "s", body: "b", verdict: "v", markets: [{ label: "Over 2.5", prob: 0.6 }] }) }] }) };
  }) as unknown as typeof fetch;
  await assessMatchLLM(
    { home: "A", away: "B", sport: "football", state: "lineup", analyticsPrompt: "оцени объективно", markets: [{ label: "Over 2.5" }, { label: "Both Teams to Score" }] },
    "Claude Opus 4.8", { fetchImpl, env: { ANTHROPIC_API_KEY: "k" } },
  );
  assert.match(sent, /Over 2\.5/, "market label present for the analyst to estimate");
  assert.ok(!/¢/.test(sent), "no price cents leak into the analysis prompt");
  assert.ok(!/рынок:\s*\d/.test(sent), "no market quote fed to the analyst (edge stays independent)");
});

// ---------------- DB + seed + repo (§2) ----------------
test("seed populates the full slice", () => {
  const db = openDb(":memory:");
  seedDatabase(db);

  assert.equal(R.getTreasury(db).total_balance, 5000);
  assert.equal(R.listCompetitions(db).length, 3); // football only (wc2026, ucl, youth)
  assert.equal(R.listStrategies(db).length, 3);   // edge, flat, kelly (tennis dropped)

  const m = R.getMatch(db, "m-lineup");
  assert.ok(m);
  assert.equal(m!.state, "lineup");
  assert.equal(R.latestMarkets(db, "m-lineup").length, 8);

  const edgeBets = R.betsForMatch(db, "m-lineup", "edge");
  assert.equal(edgeBets.length, 2);
  assert.ok(edgeBets.every((b) => b.status === "proposed"));

  // finished match has closing prices for CLV
  const closing = R.latestMarkets(db, "m-finished", true);
  assert.ok(closing.length >= 1 && closing.every((c) => c.is_closing));
});

test("analytics prompt = base sport + competition override (§2.4)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const p = R.analyticsPromptFor(db, "football", "youth");
  assert.match(p.body, /xG/); // base football
  assert.match(p.body, /Юниорский/); // youth override appended
  assert.equal(p.model, "Claude Opus 4.8");
});

test("strategy_shares: (strategy, profile) is the key — same strategy under two profiles coexists", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // legacy call without a profile defaults to medium
  R.setShare(db, { competition_id: "wc2026", strategy_id: "edge", pct: 40 } as any);
  // same strategy, a different profile → a SECOND allocation row, not an overwrite
  R.setShare(db, { competition_id: "wc2026", strategy_id: "edge", risk_profile_id: "aggressive", pct: 25 });
  const rows = R.sharesForComp(db, "wc2026").filter((s) => s.strategy_id === "edge");
  assert.equal(rows.length, 2, "two pairs for one strategy");
  assert.deepEqual(rows.map((r) => [r.risk_profile_id, r.pct]).sort(), [["aggressive", 25], ["medium", 40]]);
  // updating one pair doesn't touch the other
  R.setShare(db, { competition_id: "wc2026", strategy_id: "edge", risk_profile_id: "medium", pct: 10 });
  const med = R.sharesForComp(db, "wc2026").find((s) => s.strategy_id === "edge" && s.risk_profile_id === "medium")!;
  assert.equal(med.pct, 10);
});

test("analyzeMatch tags proposed bets with the pair's risk profile", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // reassign m-lineup's comp: edge strategy on the AGGRESSIVE profile
  R.clearShares(db, "wc2026");
  R.setShare(db, { competition_id: "wc2026", strategy_id: "edge", risk_profile_id: "aggressive", pct: 60 });
  const labels = R.latestMarkets(db, "m-lineup").map((m) => m.label);
  // high total xG → Over 2.5 well above its 53.5¢ price = real edge; picks for all labels.
  const analysis = { match_type: "group", match_type_reason: "ничья", core: { xg_home: 2.2, xg_away: 1.4, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.7, scenario_confidence: 0.6, sample_size: 12, notes: "" }, unknowns: [], picks: labels.map((l) => ({ label: l, conviction: "высокая", reason: "t" })), exits: [] };
  await analyzeMatch(db, "m-lineup", { fetchImpl: mockLLM(analysis), env: { ANTHROPIC_API_KEY: "k" } });
  const bets = R.betsForMatch(db, "m-lineup", "edge");
  assert.ok(bets.length > 0, "edge proposed at least one bet");
  assert.ok(bets.every((b) => b.risk_profile_id === "aggressive"), "every bet carries the pair's profile");
});

test("module 3: the assigned risk profile gates entries + saves a battle_sheet (calibration differs)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // same strategy under TWO profiles: medium (min_calibration 0.45) and
  // conservative (0.55). Analysis calibration 0.50 → medium enters, conservative
  // is blocked purely by its profile threshold.
  R.clearShares(db, "wc2026");
  R.setShare(db, { competition_id: "wc2026", strategy_id: "edge", risk_profile_id: "medium", pct: 40 });
  R.setShare(db, { competition_id: "wc2026", strategy_id: "edge", risk_profile_id: "conservative", pct: 40 });
  const labels = R.latestMarkets(db, "m-lineup").map((m) => m.label);
  const analysis = { match_type: "group", match_type_reason: "ничья", core: { xg_home: 2.3, xg_away: 1.5, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.50, scenario_confidence: 0.5, sample_size: 10, notes: "" }, unknowns: [], picks: labels.map((l) => ({ label: l, conviction: "средняя", reason: "t" })), exits: [] };
  await analyzeMatch(db, "m-lineup", { fetchImpl: mockLLM(analysis), env: { ANTHROPIC_API_KEY: "k" } });

  const medBets = R.betsForMatch(db, "m-lineup", "edge").filter((b) => b.risk_profile_id === "medium" && b.status === "proposed");
  const conBets = R.betsForMatch(db, "m-lineup", "edge").filter((b) => b.risk_profile_id === "conservative" && b.status === "proposed");
  assert.ok(medBets.length > 0, "medium (min_calibration 0.45) enters at calibration 0.50");
  assert.equal(conBets.length, 0, "conservative (min_calibration 0.55) is blocked by its profile");

  // battle_sheet artifact saved per pair, carrying the code-side edges
  const arts = R.artifactsForMatch(db, "m-lineup").filter((x) => x.kind === "battle_sheet");
  assert.ok(arts.some((x) => x.label.includes("medium")) && arts.some((x) => x.label.includes("conservative")), "battle_sheet per pair");
  const med = JSON.parse(arts.find((x) => x.label.includes("medium"))!.content);
  assert.equal(med.profile, "medium");
  assert.ok(Array.isArray(med.positions) && med.positions.some((p: any) => typeof p.edge_pct === "number"), "battle_sheet carries computed edges");
});

test("seedMinimal seeds three two-phase strategists + three named risk profiles", () => {
  const db = openDb(":memory:");
  seedMinimal(db);
  const strats = R.listStrategies(db, "football");
  assert.deepEqual(strats.map((s) => s.id).sort(), ["live_xg", "overreaction", "prematch_value"]);
  for (const s of strats) {
    assert.ok(s.prompt && s.prompt.length > 50, `${s.id} has a prematch prompt`);
    assert.ok(s.prompt_live && s.prompt_live.length > 50, `${s.id} has a live prompt`);
  }
  const over = strats.find((s) => s.id === "overreaction")!;
  assert.match(over.prompt, /ПРЕДМАТЧ/);
  assert.match(over.prompt_live!, /LIVE/);
  // three named profiles seeded
  assert.deepEqual(R.listRiskProfiles(db).map((p) => p.id), ["aggressive", "medium", "conservative"]);
  // idempotent: seedMinimal on a populated DB is a no-op (doesn't duplicate)
  seedMinimal(db);
  assert.equal(R.listStrategies(db, "football").length, 3);
});

test("migrateStrategyRoster: retires legacy wc, assigns the trio (aggressive) to every comp, once", () => {
  const db = openDb(":memory:");
  seedRiskProfiles(db, "t");
  // simulate the pre-transition prod state: only the legacy strategy, funded comps
  R.upsertSport(db, "football", "Футбол");
  R.insertStrategy(db, { id: "wc", sport_id: "football", name: "Мундиаль", tag: null, color: "#e8a838", version: 1, model: null, prompt: "x", prompt_live: null, params: {}, created_at: "t" });
  for (const id of ["pm-a", "pm-b"]) {
    R.upsertCompetition(db, { id, sport_id: "football", name: id, budget: 100, external_league: null, created_at: "t" });
    R.setShare(db, { competition_id: id, strategy_id: "wc", pct: 100 });
  }

  migrateStrategyRoster(db, "t");

  // wc gone, three strategists present
  assert.equal(R.getStrategy(db, "wc"), null, "legacy strategy removed");
  assert.deepEqual(R.listStrategies(db, "football").map((s) => s.id).sort(), ["live_xg", "overreaction", "prematch_value"]);
  // every comp now carries the trio on the medium profile, summing to 100
  for (const id of ["pm-a", "pm-b"]) {
    const rows = R.sharesForComp(db, id);
    assert.equal(rows.length, 3, `${id} has three pairs`);
    assert.ok(rows.every((r) => r.risk_profile_id === "aggressive"), "all on aggressive");
    assert.equal(rows.reduce((a, r) => a + r.pct, 0), 100, "shares sum to 100");
    assert.ok(!rows.some((r) => r.strategy_id === "wc"), "no wc share");
  }
  // idempotent: re-run does nothing (wc already gone), doesn't re-clobber shares
  R.setShare(db, { competition_id: "pm-a", strategy_id: "overreaction", risk_profile_id: "aggressive", pct: 50 });
  migrateStrategyRoster(db, "t");
  assert.equal(R.sharesForComp(db, "pm-a").find((r) => r.strategy_id === "overreaction")!.pct, 50, "manual edit preserved after transition");
});

test("two-phase strategy: prompt_live persists through insert, version bump keeps it", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  R.insertStrategy(db, { id: "s2p", sport_id: "football", name: "Two-Phase", tag: null, color: "#fff", version: 1, model: null, prompt: "предматч тело", prompt_live: "live тело", params: {}, created_at: "t" });
  assert.equal(R.getStrategy(db, "s2p")!.prompt_live, "live тело");
  // editing the live prompt only
  R.updateStrategy(db, "s2p", { prompt_live: "новое live" });
  assert.equal(R.getStrategy(db, "s2p")!.prompt_live, "новое live");
  // version bump archives the current (incl. live) and keeps live on the row
  R.saveStrategyVersion(db, "s2p", "новый предматч", {}, "правка");
  assert.equal(R.getStrategy(db, "s2p")!.prompt, "новый предматч");
  assert.equal(R.getStrategy(db, "s2p")!.prompt_live, "новое live", "live prompt survives a prematch version bump");
});

test("migrateCanonicalPrompts brings stale football base + WC modifier current, once", () => {
  const db = openDb(":memory:");
  seedDatabase(db); // seeds the OLD demo football prompt (no "# БАЗОВЫЙ АНАЛИЗ" marker)
  // simulate a prod DB whose WC modifier is the pre-rewrite version
  R.upsertAnalyticsPrompt(db, "competition", "pm-soccer-fifwc", "КОНТЕКСТ ТУРНИРА — старый промпт ЧМ", null);
  assert.ok(!R.analyticsPromptRow(db, "sport", "football")!.body.startsWith("# БАЗОВЫЙ АНАЛИЗ"), "starts stale");

  migrateCanonicalPrompts(db);
  assert.ok(R.analyticsPromptRow(db, "sport", "football")!.body.startsWith("# БАЗОВЫЙ АНАЛИЗ"), "base brought to Layer-1");
  assert.ok(R.analyticsPromptRow(db, "competition", "pm-soccer-fifwc")!.body.startsWith("# МОДИФИКАТОР"), "WC modifier brought to Layer-2");

  assert.match(R.analyticsPromptRow(db, "sport", "football")!.body, /Слой 1 · v2/, "base is at the current version");

  // idempotent: a second run must NOT append another row (version already current)
  const countBefore = (db.prepare("SELECT COUNT(*) c FROM analytics_prompts WHERE scope='sport' AND scope_id='football'").get() as any).c;
  migrateCanonicalPrompts(db);
  const countAfter = (db.prepare("SELECT COUNT(*) c FROM analytics_prompts WHERE scope='sport' AND scope_id='football'").get() as any).c;
  assert.equal(countAfter, countBefore, "no duplicate insert on re-run");

  // version-aware: a prompt with the right HEADER but an OLD version tag is re-pushed
  R.upsertAnalyticsPrompt(db, "sport", "football", "# БАЗОВЫЙ АНАЛИЗ ФУТБОЛЬНОГО МАТЧА (Слой 1 · v1)\nстарое тело", "Claude Opus 4.8");
  assert.ok(!R.analyticsPromptRow(db, "sport", "football")!.body.includes("Слой 1 · v2"), "v1 in place");
  migrateCanonicalPrompts(db);
  assert.match(R.analyticsPromptRow(db, "sport", "football")!.body, /Слой 1 · v2/, "v1 upgraded to v2");
});

test("strategy versioning archives old and bumps version (§2.6, §3.5)", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const next = R.saveStrategyVersion(db, "edge", "Новый промт", { flatSize: 0.05 }, "средняя убыточна");
  assert.equal(next, 2);
  const cur = R.getStrategy(db, "edge");
  assert.equal(cur!.version, 2);
  assert.equal(cur!.prompt, "Новый промт");
});

// ---------------- Polymarket client fallback (§5.1, §6) ----------------
test("polymarket: disabled config serves snapshot", async () => {
  const cfg = loadPolymarketConfig({ POLYMARKET_ENABLED: "false" });
  assert.equal(cfg.enabled, false);
  const quotes = await getQuotes([{ tokenId: "t1", snapshotCents: 46.8 }], cfg);
  assert.equal(quotes[0].source, "disabled");
  assert.equal(quotes[0].priceCents, 46.8);
  assert.equal(quotes[0].stale, true);
});

test("polymarket: live fetch success and graceful error fallback", async () => {
  const cfg = loadPolymarketConfig({ POLYMARKET_ENABLED: "true" });

  const okFetch = (async () => ({ ok: true, json: async () => ({ mid: "0.55" }) })) as unknown as typeof fetch;
  assert.equal(await fetchMidpointCents("t1", cfg, { fetchImpl: okFetch }), 55);

  const live = await getQuotes([{ tokenId: "t1", snapshotCents: 46 }], cfg, { fetchImpl: okFetch });
  assert.equal(live[0].source, "live");
  assert.equal(live[0].priceCents, 55);

  const boom = (async () => { throw new Error("blocked by policy"); }) as unknown as typeof fetch;
  const fell = await getQuotes([{ tokenId: "t1", snapshotCents: 46 }], cfg, { fetchImpl: boom });
  assert.equal(fell[0].source, "error");
  assert.equal(fell[0].priceCents, 46); // fell back to snapshot
  assert.equal(fell[0].stale, true);
});

// ---------------- Polymarket discovery: match -> event -> markets ----------------
// Fixture mirrors the real Gamma shape (JSON-STRING fields, cents=prob*100).
const EVENT_FIXTURE = [{
  id: "42", slug: "atp-doig-gonzal-2026-07-04",
  title: "Wimbledon Juniors, Boys: Connor Doig vs Eudald Gonzalez",
  startDate: "2026-07-03T16:00:39Z",
  series: [{ title: "ATP", slug: "atp" }], // ATP tour → passes the tennis series gate

  markets: [
    { groupItemTitle: "", question: "Connor Doig vs Eudald Gonzalez",
      outcomes: '["Connor Doig","Eudald Gonzalez"]', outcomePrices: '["0.62","0.38"]',
      clobTokenIds: '["tok-a","tok-b"]', liquidity: "1234", conditionId: "0xabc" },
    { groupItemTitle: "Total Sets: O/U 2.5", question: "…O/U 2.5",
      outcomes: '["Over 2.5","Under 2.5"]', outcomePrices: '["0.45","0.55"]',
      clobTokenIds: '["tok-c","tok-d"]', liquidity: "500", conditionId: "0xdef" },
    { groupItemTitle: "No price yet", question: "x",
      outcomes: '["Yes","No"]', outcomePrices: "[]", clobTokenIds: "[]", liquidity: null },
  ],
}];
const eventsFetch = (async () => ({ ok: true, json: async () => EVENT_FIXTURE })) as unknown as typeof fetch;

test("polymarket: normalizeEvent parses Gamma JSON-string fields to cents", () => {
  const ev = normalizeEvent(EVENT_FIXTURE[0]);
  assert.equal(ev.markets.length, 3);
  assert.equal(ev.markets[0].label, "Connor Doig vs Eudald Gonzalez"); // falls back to question
  assert.deepEqual(ev.markets[0].outcomes, ["Connor Doig", "Eudald Gonzalez"]);
  assert.equal(ev.markets[0].priceCents, 62); // 0.62 -> 62¢
  assert.deepEqual(ev.markets[0].tokenIds, ["tok-a", "tok-b"]);
  assert.equal(ev.markets[2].priceCents, null); // no price
});

test("polymarket: eventToMarketSnapshots drops priceless markets", () => {
  const snaps = eventToMarketSnapshots(normalizeEvent(EVENT_FIXTURE[0]), "2026-07-03T00:00:00Z");
  const labels = snaps.map((s) => s.label);
  assert.equal(snaps.length, 3); // priceless dropped; the O/U total expands to BOTH sides
  assert.deepEqual(snaps.find((s) => s.label === "Connor Doig vs Eudald Gonzalez"), { label: "Connor Doig vs Eudald Gonzalez", price: 62, external_ref: "tok-a", liquidity: "1234" });
  assert.ok(labels.includes("Total Sets: Over 2.5") && labels.includes("Total Sets: Under 2.5")); // both sides of the total
});

test("polymarket: parseMatchTitle extracts competitors across formats", () => {
  assert.deepEqual(parseMatchTitle("Colombia vs. Ghana - More Markets", "football"), { home: "Colombia", away: "Ghana" });
  assert.deepEqual(parseMatchTitle("Henan FC vs. Qingdao Hainiu FC", "football"), { home: "Henan FC", away: "Qingdao Hainiu FC" });
  assert.deepEqual(parseMatchTitle("Colombia vs. Ghana - Player Props", "football"), { home: "Colombia", away: "Ghana" });
  assert.deepEqual(parseMatchTitle("ITF Skopje: Vladyslav Orlov vs Stefan Popovic Set 1 Winner", "tennis"), { home: "Vladyslav Orlov", away: "Stefan Popovic" });
  assert.deepEqual(parseMatchTitle("Wimbledon ATP: Taylor Fritz vs Lorenzo Sonego", "tennis"), { home: "Taylor Fritz", away: "Lorenzo Sonego" });
  // e-sports / cricket: strip "League:" prefix and "(BOx) - Stage" / "- Match Result (1x2)" tails
  assert.deepEqual(parseMatchTitle("LoL: T1 vs GAM Esports (BO1) - Esports World Cup Group C", "esports"), { home: "T1", away: "GAM Esports" });
  assert.deepEqual(parseMatchTitle("Dota 2: LGD Gaming vs Virtus.pro - Match Result (1x2)", "esports"), { home: "LGD Gaming", away: "Virtus.pro" });
  assert.deepEqual(parseMatchTitle("Major League Cricket: San Francisco Unicorns vs Mi New York", "cricket"), { home: "San Francisco Unicorns", away: "Mi New York" });
  assert.deepEqual(parseMatchTitle("Poland vs. Netherlands", "basketball"), { home: "Poland", away: "Netherlands" });
  assert.equal(parseMatchTitle("Bitcoin Up or Down July 5", "football"), null);
  assert.equal(parseMatchTitle("NHL: 2027 Champion", "hockey"), null); // futures, not a match
});

test("polymarket: isNoiseMarket keeps settleable markets, drops props/niche", () => {
  for (const l of ["Over 2.5", "Under 2.5", "Both Teams to Score — Yes", "Colombia -1.5", "Draw", "Henan FC", "Match O/U 22.5", "Set 1 Winner"])
    assert.equal(isNoiseMarket(l), false, `should keep: ${l}`);
  for (const l of ["David Ospina: 4+ saves", "James Rodríguez: 1+ goals", "Total Corners Over 9.5", "Henan FC 3 - 3 Qingdao", "Halftime Result", "Exact Score 2-1", "First Team to Score"])
    assert.equal(isNoiseMarket(l), true, `should drop: ${l}`);
});

test("polymarket: matchMarketSnapshots aggregates events, drops noise, dedups, caps", () => {
  const mk = (label: string, price: string, tok: string, liq: string) => ({ groupItemTitle: label, question: label, outcomes: '["Yes","No"]', outcomePrices: `["${price}","0.5"]`, clobTokenIds: `["${tok}","z"]`, liquidity: liq, conditionId: "c" });
  const evA = normalizeEvent({ id: "1", slug: "a", title: "A vs B", markets: [mk("Over 2.5", "0.5", "t1", "900"), mk("James: 1+ goals", "0.3", "t2", "999")] });
  const evB = normalizeEvent({ id: "2", slug: "b", title: "A vs B - Corners", markets: [mk("Both Teams to Score", "0.6", "t3", "800"), mk("Total Corners Over 9.5", "0.4", "t4", "999"), mk("Over 2.5", "0.5", "t5", "700")] });
  const snaps = matchMarketSnapshots([evA, evB], "t", 10);
  const labels = snaps.map((s) => s.label);
  // BTTS is a yes/no question → BOTH sides surfaced; "Over 2.5" is directional → single.
  assert.ok(labels.includes("Over 2.5") && labels.includes("Both Teams to Score — Yes") && labels.includes("Both Teams to Score — No"));
  assert.ok(!labels.some((l) => /goals|corners/i.test(l)), "noise dropped");
  assert.equal(labels.filter((l) => l === "Over 2.5").length, 1, "deduped across events");
  const capped = matchMarketSnapshots([evA, evB], "t", 1);
  assert.equal(capped.length, 1); // most-liquid kept
});

test("polymarket: a generic 2-way market expands into BOTH sides (own tokens)", () => {
  // "Team to Advance" names neither team → show both, each with its token/price
  const evA = normalizeEvent({ id: "1", slug: "a", title: "Paraguay vs France", markets: [
    { groupItemTitle: "Team to Advance", question: "To advance", outcomes: '["Paraguay","France"]', outcomePrices: '["0.075","0.925"]', clobTokenIds: '["tk-par","tk-fra"]', liquidity: "5000", conditionId: "c" },
  ] });
  const snaps = matchMarketSnapshots([evA], "t", 10);
  const par = snaps.find((s) => s.label === "Team to Advance — Paraguay");
  const fra = snaps.find((s) => s.label === "Team to Advance — France");
  assert.ok(par && fra, "both sides present");
  assert.equal(par!.price, 7.5);
  assert.equal(fra!.price, 92.5);
  assert.equal(par!.external_ref, "tk-par");
  assert.equal(fra!.external_ref, "tk-fra"); // distinct tradeable tokens

  // a spread already names its side → stays a single row (PM lists the other side separately)
  const evB = normalizeEvent({ id: "2", slug: "b", title: "A vs B", markets: [
    { groupItemTitle: "Morocco (-1.5)", question: "Spread", outcomes: '["Morocco","Canada"]', outcomePrices: '["0.3","0.7"]', clobTokenIds: '["t1","t2"]', liquidity: "900", conditionId: "c" },
  ] });
  const s2 = matchMarketSnapshots([evB], "t", 10);
  assert.equal(s2.length, 1);
  assert.equal(s2[0].label, "Morocco (-1.5)");
});

test("polymarket: a yes/no market (BTTS) surfaces BOTH Yes and No, each with its own token", () => {
  const ev = normalizeEvent({ id: "1", slug: "a", title: "A vs B", markets: [
    { groupItemTitle: "Both Teams to Score", question: "BTTS", outcomes: '["Yes","No"]', outcomePrices: '["0.62","0.38"]', clobTokenIds: '["tk-yes","tk-no"]', liquidity: "800", conditionId: "c" },
  ] });
  const snaps = matchMarketSnapshots([ev], "t", 10);
  const yes = snaps.find((s) => s.label === "Both Teams to Score — Yes");
  const no = snaps.find((s) => s.label === "Both Teams to Score — No");
  assert.ok(yes && no, "both Yes and No present");
  assert.equal(yes!.price, 62); assert.equal(no!.price, 38);
  assert.equal(yes!.external_ref, "tk-yes");
  assert.equal(no!.external_ref, "tk-no"); // distinct tradeable tokens
});

test("discoverSportMatches returns the MOST-LIQUID matches first, then caps", async () => {
  const cfg = loadPolymarketConfig({ POLYMARKET_ENABLED: "true" });
  const mkEvent = (id: string, home: string, away: string, liq: number) => ({
    id, slug: id, title: `${home} vs ${away}`, startDate: "2026-07-06T12:00:00Z",
    markets: [{ groupItemTitle: "", question: `${home} vs ${away}`, outcomes: `["${home}","${away}"]`, outcomePrices: '["0.5","0.5"]', clobTokenIds: `["t${id}a","t${id}b"]`, liquidity: String(liq), conditionId: id }],
  });
  const events = [mkEvent("low", "Aaa", "Bbb", 100), mkEvent("hi", "Ccc", "Ddd", 9000), mkEvent("mid", "Eee", "Fff", 1000)];
  const fetchImpl = (async () => ({ ok: true, json: async () => events })) as unknown as typeof fetch;
  const out = await discoverSportMatches(cfg, "football", "2026-07-06T00:00:00Z", { fetchImpl }, { limit: 2, windowDays: 30, nowMs: Date.parse("2026-07-06T00:00:00Z") });
  assert.equal(out.length, 2, "capped to 2");
  assert.equal(out[0].home, "Ccc", "most-liquid (9000) first");
  assert.equal(out[1].home, "Eee", "second most-liquid (1000); the thin one (100) dropped by the cap");
});

test("polymarket: titleMatchScore matches on surnames", () => {
  const t = "Wimbledon Juniors, Boys: Connor Doig vs Eudald Gonzalez";
  assert.equal(titleMatchScore(t, "Connor Doig", "Eudald Gonzalez"), 2);
  assert.equal(titleMatchScore(t, "Doig", "Gonzalez"), 2);
  assert.equal(titleMatchScore(t, "Alcaraz", "Sinner"), 0);
  // full first+surname still matches when the title carries only the surname
  assert.equal(titleMatchScore("ATP Final: Alcaraz vs Sinner", "Carlos Alcaraz", "Jannik Sinner"), 2);
  // and a shared-word near-miss no longer false-positives (was a substring bug)
  assert.ok(titleMatchScore("Real Sociedad vs Barcelona B", "Real Madrid", "Barcelona") < 2);
  // same-city / shared-suffix clubs must NOT collide on the bare key: "Real
  // Madrid" and "Atlético Madrid" both reduce to "madrid", "Man United"/"Man
  // City" both to "manchester" — the qualifier has to agree too.
  assert.equal(titleMatchScore("Atlético Madrid vs Sevilla", "Real Madrid", "Sevilla"), 1); // Madrid mismatch → only Sevilla
  assert.equal(titleMatchScore("Real Madrid vs Sevilla", "Real Madrid", "Sevilla"), 2);     // exact → both
  assert.equal(titleMatchScore("Manchester City vs Arsenal", "Manchester United", "Arsenal"), 1); // United ≠ City
  assert.equal(titleMatchScore("Manchester United vs Arsenal", "Manchester United", "Arsenal"), 2);
  // suffix-only distinction still resolves the right side
  assert.equal(titleMatchScore("Manchester United vs Manchester City", "Manchester City", "Newcastle United"), 1); // City present, Newcastle absent
});

test("polymarket: findMatchEvent / bySlug / listSportEvents via mocked Gamma", async () => {
  const cfg = loadPolymarketConfig({ POLYMARKET_ENABLED: "true" });
  const ev = await findMatchEvent(cfg, { sport: "football", home: "Connor Doig", away: "Eudald Gonzalez" }, { fetchImpl: eventsFetch });
  assert.ok(ev);
  assert.equal(ev!.slug, "atp-doig-gonzal-2026-07-04");

  // wrong names -> no confident match
  assert.equal(await findMatchEvent(cfg, { sport: "football", home: "Nadal", away: "Federer" }, { fetchImpl: eventsFetch }), null);
  // unknown sport -> null without any fetch
  assert.equal(await findMatchEvent(cfg, { sport: "curling", home: "a", away: "b" }, { fetchImpl: eventsFetch }), null);

  const bySlug = await fetchEventBySlug(cfg, "atp-doig-gonzal-2026-07-04", { fetchImpl: eventsFetch });
  assert.equal(bySlug!.title, EVENT_FIXTURE[0].title);

  assert.deepEqual(await listSportEvents(cfg, "curling", 10, { fetchImpl: eventsFetch }), []);
  assert.equal((await listSportEvents(cfg, "football", 10, { fetchImpl: eventsFetch })).length, 1);
});

test("importPolymarketMatches: football imports only ESPN-covered leagues; uncovered + thin skipped", async () => {
  const { importPolymarketMatches } = await import("../src/lib/engine.js");
  const base = loadPolymarketConfig({ POLYMARKET_ENABLED: "true" });
  const now = "2026-07-03T12:00:00Z";

  // Uncovered series ("atp" → no ESPN FOOTBALL league) → NOT imported, even liquid.
  const db0 = openDb(":memory:");
  seedDatabase(db0);
  const uncovered = await importPolymarketMatches(db0, "football",
    { fetchImpl: eventsFetch, polymarket: { ...base, minLiquidity: 250 }, now: () => now });
  assert.equal(uncovered.length, 0, "football w/o ESPN coverage is skipped (can't be live-traded)");

  // A football fixture whose series maps to ESPN (EPL → eng.1) → imported.
  const eplFixture = [{
    id: "77", slug: "epl-arsenal-chelsea-2026-07-04",
    title: "Premier League: Arsenal vs Chelsea", startDate: "2026-07-03T16:00:00Z",
    series: [{ title: "Premier League", slug: "soccer-epl" }],
    markets: [
      { groupItemTitle: "", question: "Arsenal vs Chelsea", outcomes: '["Arsenal","Chelsea"]', outcomePrices: '["0.55","0.45"]', clobTokenIds: '["t-a","t-b"]', liquidity: "1500", conditionId: "0x1" },
      { groupItemTitle: "Total: O/U 2.5", question: "…O/U 2.5", outcomes: '["Over 2.5","Under 2.5"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["t-c","t-d"]', liquidity: "900", conditionId: "0x2" },
    ],
  }];
  const eplFetch = (async () => ({ ok: true, json: async () => eplFixture })) as unknown as typeof fetch;
  const db = openDb(":memory:");
  seedDatabase(db);
  const items = await importPolymarketMatches(db, "football",
    { fetchImpl: eplFetch, polymarket: { ...base, minLiquidity: 250 }, now: () => now });
  assert.equal(items.length, 1, "covered EPL fixture imported");
  const comp = R.listCompetitions(db).find((c) => R.listMatches(db, c.id).length > 0)!;
  assert.equal(comp.external_league, "eng.1", "routed into the ESPN-mapped category");

  // Covered but sub-threshold liquidity → still skipped.
  const db2 = openDb(":memory:");
  seedDatabase(db2);
  const none = await importPolymarketMatches(db2, "football",
    { fetchImpl: eplFetch, polymarket: { ...base, minLiquidity: 100000 }, now: () => now });
  assert.equal(none.length, 0, "sub-threshold liquidity → not imported");
});

// ---------------- LLM abstraction graceful (§5.3, §6, §9.9) ----------------
test("llm: model resolution and key handling", () => {
  assert.deepEqual(resolveModel("Claude Opus 4.8"), { provider: "anthropic", apiId: "claude-opus-4-8" });
  assert.equal(resolveModel("gpt-5")!.provider, "openai");
  assert.equal(resolveModel("gemini-2.5-pro")!.provider, "google");
  assert.equal(resolveModel("nope"), null);

  assert.equal(apiKeyFor("anthropic", { ANTHROPIC_API_KEY: "" }), undefined);
  assert.equal(apiKeyFor("anthropic", { ANTHROPIC_API_KEY: "sk-ant-x" }), "sk-ant-x");
});

test("llm: callLLM without a key fails gracefully", async () => {
  const res = await callLLM({ model: "Claude Opus 4.8", prompt: "hi" }, { env: {} });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /нет ключа/);
});

test("llm: callLLM success via mocked provider", async () => {
  const okFetch = (async () => ({ ok: true, json: async () => ({ content: [{ text: "готово" }] }) })) as unknown as typeof fetch;
  const res = await callLLM(
    { model: "Claude Opus 4.8", prompt: "hi" },
    { env: { ANTHROPIC_API_KEY: "sk-ant-x" }, fetchImpl: okFetch },
  );
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.text, "готово");
});

test("llm: name generation and threshold extraction fall back without a key", async () => {
  const name = await generateStrategyName("использую келли и стоп", "Claude Opus 4.8", { env: {} });
  assert.equal(name, "Kelly Edge");
  assert.equal(heuristicName("фикс размер всегда"), "Flat Bet");

  // extractThresholds with a throwing LLM extractor -> heuristic result
  const params = await extractThresholds(
    "Размер всегда 5%. edge >= 3%. Не более 5% на ставку.",
    async () => { throw new Error("no key"); },
  );
  assert.equal(params.flatSize, 0.05);
  assert.equal(params.minEdge, 3);
});

test("deleteStrategy removes the strategy and all its dependent rows", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const st = R.listStrategies(db)[0];
  R.insertBet(db, { id: R.uid(), match_id: "m-lineup", strategy_id: st.id, market_label: "x", status: "proposed", proposed_price: 50, entry_price: null, current_price: null, closing_price: null, ai_prob: 0.5, stake: 10, rationale: "r", entered_minute: null, result: null, payout: null, created_at: "t" });
  R.deleteStrategy(db, st.id);
  assert.equal(R.getStrategy(db, st.id), null);
  assert.equal(R.betsForMatch(db, "m-lineup", st.id).length, 0);
  assert.ok(R.listStrategies(db).every((s) => s.id !== st.id));
});

test("provider keys: DB key enables a provider; env still wins", () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  assert.deepEqual(R.getProviderKeys(db), {});
  R.setProviderKey(db, "anthropic", "sk-ant-from-ui", "t");
  assert.equal(R.getProviderKeys(db).anthropic, "sk-ant-from-ui");

  // no env key -> the UI/DB key fills it
  const env1 = effectiveEnv(R.getProviderKeys(db), {});
  assert.equal(providerEnabled("anthropic", env1), true);
  assert.equal(apiKeyFor("anthropic", env1), "sk-ant-from-ui");
  // env key present -> it wins, DB key does not override
  const env2 = effectiveEnv(R.getProviderKeys(db), { ANTHROPIC_API_KEY: "sk-ant-from-env" });
  assert.equal(apiKeyFor("anthropic", env2), "sk-ant-from-env");

  R.deleteProviderKey(db, "anthropic");
  assert.equal(providerEnabled("anthropic", effectiveEnv(R.getProviderKeys(db), {})), false);
});

test("analyzeMatch (football): structured CORE → Poisson-derived ai_prob on real labels", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // Layer 1: the model returns only CORE + scenarios (NO per-market probs, NO
  // quotes); the engine derives every market by Poisson and maps it to the labels.
  const analysis = {
    match_type: "group", match_type_reason: "есть трёхисходный рынок с ничьёй",
    core: { xg_home: 1.6, xg_away: 1.0, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 },
    overrides: [], drivers: [],
    scenarios: [{ trigger: "ранний гол фаворита", prob: 0.3, shifts: { outcome_90: { home: 0.72, draw: 0.18, away: 0.1 }, xg_remaining_home: 1.2, xg_remaining_away: 0.9, note: "рынок переоценит фаворита" } }],
    calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 8, notes: "мало матчей текущим составом" }, unknowns: [],
  };
  const r = await analyzeMatch(db, "m-lineup", { fetchImpl: mockLLM(analysis), env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r.ok, true);
  const mkts = R.latestMarkets(db, "m-lineup");
  assert.ok(mkts.some((m) => m.ai_prob != null), "derived probs landed on real market labels");
  const under = mkts.find((m) => /under 2\.5/i.test(m.label));
  if (under) assert.ok(under.ai_prob != null && under.ai_prob > 0 && under.ai_prob < 1, "Under 2.5 got a derived prob");
  // the assessment carries the Poisson headline + scenario tree for live management
  const asmt = R.assessmentsForMatch(db, "m-lineup").find((a) => a.status === "ok")!;
  assert.match(asmt.verdict ?? "", /xG .*П1/);
  assert.match(asmt.body ?? "", /Сценарии/);
});

test("analyzeMatch (football): Layer-2 category modifier folds into the analysis", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // give wc2026 a category MODIFIER prompt → analyzeMatch runs base + Layer 2.
  R.upsertAnalyticsPrompt(db, "competition", "wc2026", "модификатор ЧМ (специфика сборных/высота)", null);
  // one static JSON answers BOTH LLM calls: base (core…) + category (core_adjustments…).
  const mock = mockLLM({
    match_type: "group", match_type_reason: "ничья есть",
    core: { xg_home: 1.6, xg_away: 1.2, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 },
    overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 10, notes: "" }, unknowns: [],
    core_adjustments: [{ target: "xg_away", op: "multiply", value: 0.8, reason: "Мехико, высота — падение интенсивности" }],
    new_drivers: [{ factor: "высота Мехико", direction: "оба вниз", magnitude: "small", confidence: 0.5, reason: "2240 м" }],
    new_scenarios: [], override_adjustments: [], confidence_adjustments: { xg_confidence_delta: -0.1, scenario_confidence_delta: 0, reason: "несыгранность сборных" }, notes: "ЧМ-специфика применена",
  });
  const r = await analyzeMatch(db, "m-lineup", { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r.ok, true);
  const asmt = R.assessmentsForMatch(db, "m-lineup").find((a) => a.status === "ok")!;
  assert.match(asmt.body ?? "", /Категория.*ЧМ-специфика применена/, "category notes merged into the body");
  assert.match(asmt.body ?? "", /высота Мехико/, "category driver merged");
  assert.ok(R.latestMarkets(db, "m-lineup").some((m) => m.ai_prob != null), "derived probs (post-modifier) landed on markets");
  // raw artifacts recorded for review: base + category + distribution (filled schema)
  const arts = R.artifactsForMatch(db, "m-lineup");
  const kinds = new Set(arts.map((a) => a.kind));
  assert.ok(kinds.has("base") && kinds.has("category") && kinds.has("distribution"), "base+category+distribution artifacts stored");
  const base = arts.find((a) => a.kind === "base")!;
  assert.ok(JSON.parse(base.content).core.xg_home === 1.6, "base artifact is the raw filled schema");
  const dist = arts.find((a) => a.kind === "distribution")!;
  assert.ok(JSON.parse(dist.content).derived.outcome_90, "distribution artifact carries the derived markets");
  // re-running REPLACES, not appends (one current artifact per kind)
  await analyzeMatch(db, "m-lineup", { fetchImpl: mock, env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(R.artifactsForMatch(db, "m-lineup").filter((a) => a.kind === "base").length, 1, "base artifact replaced, not duplicated");
});

test("analyzeMatch (football): refuses to analyze until the real lineup is out", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  // m-lineup carries real lineups (seed) → analysis runs. Strip the lineup data
  // (keep the coverage marker row) and it must refuse: без составов не анализируем.
  R.upsertMatchLive(db, { match_id: "m-lineup", espn_event_id: "seed-lineup", league: "fifa.world", home_lineup: null, away_lineup: null, stats: null, updated_at: "2026-07-06T00:00:00Z" });
  let called = false;
  const spyFetch: typeof fetch = (async () => { called = true; return mockLLM({ core: { xg_home: 1, xg_away: 1, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 } })(); }) as unknown as typeof fetch;
  const r = await analyzeMatch(db, "m-lineup", { fetchImpl: spyFetch, env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r.ok, false, "no lineup → no analysis");
  assert.match(r.error ?? "", /состав/i, "message points at the missing lineup");
  assert.equal(called, false, "the model is never even called");
  assert.equal(R.assessmentsForMatch(db, "m-lineup").filter((a) => a.status === "failed").length, 0, "a missing lineup is not recorded as a failed run");
  // A bare COVERAGE-marker row (non-null JSON but EMPTY starters) must NOT count
  // as «состав есть» — this is the Switzerland–Colombia false positive.
  R.upsertMatchLive(db, { match_id: "m-lineup", espn_event_id: "seed-lineup", league: "fifa.world", home_lineup: JSON.stringify({ team: "Switzerland", formation: null, starters: [] }), away_lineup: JSON.stringify({ team: "Colombia", formation: null, starters: [] }), stats: null, updated_at: "2026-07-06T00:00:00Z" });
  assert.equal(R.hasLineups(db, "m-lineup"), false, "empty starters ≠ lineup out");
  assert.equal((await analyzeMatch(db, "m-lineup", { fetchImpl: spyFetch, env: { ANTHROPIC_API_KEY: "k" } })).ok, false, "empty coverage marker still refuses analysis");
  // once the lineup lands, the same match analyzes fine.
  R.upsertMatchLive(db, { match_id: "m-lineup", espn_event_id: "seed-lineup", league: "fifa.world", home_lineup: JSON.stringify({ team: "Португалия", formation: "4-3-3", starters: ["Rúben Dias"] }), away_lineup: JSON.stringify({ team: "Хорватия", formation: "4-1-4-1", starters: ["Modrić"] }), stats: null, updated_at: "2026-07-06T00:00:00Z" });
  const r2 = await analyzeMatch(db, "m-lineup", { fetchImpl: mockLLM({ match_type: "group", match_type_reason: "ничья есть", core: { xg_home: 1.6, xg_away: 1.0, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.6, scenario_confidence: 0.5, sample_size: 8, notes: "" }, unknowns: [] }), env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r2.ok, true, "lineup present → analysis proceeds");
});

test("analyzeMatch: a prior loss no longer halts entries (portfolio stop-loss removed)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const labels = R.latestMarkets(db, "m-lineup").map((m) => m.label);
  // One static JSON answers both LLM calls: CORE for the football analysis (total
  // xG ~3.2 → Over 2.5 ≈ 62% vs the 53.5¢ market = real edge) + strategist picks.
  const assessment = { match_type: "group", match_type_reason: "ничья есть", core: { xg_home: 1.8, xg_away: 1.4, home_share_1h: 0.44, away_share_1h: 0.44, poisson_correction: 0 }, overrides: [], drivers: [], scenarios: [], calibration: { xg_confidence: 0.7, scenario_confidence: 0.5, sample_size: 10, notes: "" }, unknowns: [], picks: labels.map((l) => ({ label: l, conviction: "высокая", reason: "t" })), exits: [] };
  const deps = { fetchImpl: mockLLM(assessment), env: { ANTHROPIC_API_KEY: "k" } };

  // baseline: strong edges => at least one strategy proposes bets
  await analyzeMatch(db, "m-lineup", deps);
  const baseline = R.betsForMatch(db, "m-lineup").filter((b) => b.status === "proposed");
  assert.ok(baseline.length > 0, "baseline should propose bets");
  const strat = baseline[0].strategy_id;

  // settle a ~30% drawdown on another match of the same competition (deep enough
  // to have tripped the old -10%/-25% portfolio stop, but leaving bankroll room),
  // then re-analyze: with the stop removed, a real edge still proposes bets.
  const s = R.getStrategy(db, strat)!;
  R.updateStrategy(db, strat, { params: { ...s.params, minEdge: 1 } });
  const comp = R.listCompetitions(db).find((c) => R.listMatches(db, c.id).some((m) => m.id === "m-lineup"))!;
  const pct = R.sharesForComp(db, comp.id).find((x) => x.strategy_id === strat)?.pct ?? 100;
  const stratBudget = Math.round((comp.budget * pct) / 100);
  R.insertBet(db, {
    id: R.uid(), match_id: "m-finished", strategy_id: strat, market_label: "x",
    status: "settled_lost", proposed_price: 50, entry_price: 50, current_price: 50,
    closing_price: 50, ai_prob: 0.5, stake: Math.round(stratBudget * 0.3), rationale: "drawdown", entered_minute: null,
    result: "lost", payout: 0, created_at: "t",
  });
  await analyzeMatch(db, "m-lineup", deps);
  const after = R.betsForMatch(db, "m-lineup").filter((b) => b.status === "proposed" && b.strategy_id === strat);
  assert.ok(after.length > 0, "still proposes on a real edge despite a drawdown that used to trip the stop");
});

// ---------------- StatPal provider (tennis / esports / cricket) ----------------
test("parseStatpalTennis: sets score, finished vs live, object-collapsed arrays", () => {
  const json = { livescores: { sport: "tennis", tournament: [
    { id: "1", name: "ATP Wimbledon", match: [
      { id: "m1", status: "Finished", player: [
        { name: "R. Safiullin", totalscore: "1", winner: "False" },
        { name: "N. Djokovic", totalscore: "3", winner: "True" },
      ] },
      // in-play match: status isn't finished/scheduled -> live
      { id: "m2", status: "Set 3", player: [
        { name: "C. Alcaraz", totalscore: "1" }, { name: "J. Sinner", totalscore: "1" },
      ] },
    ] },
    // XML collapse: a tournament with ONE match arrives as an OBJECT, not array
    { id: "2", name: "WTA", match: { id: "m3", status: "12:30", player: [
      { name: "A", totalscore: "0" }, { name: "B", totalscore: "0" },
    ] } },
  ] } };
  const rows = parseStatpalTennis(json);
  assert.equal(rows.length, 3);
  const m1 = rows.find((r) => r.externalRef === "m1")!;
  assert.equal(m1.state, "finished"); assert.equal(m1.final, true);
  assert.equal(m1.scoreHome, 1); assert.equal(m1.scoreAway, 3);
  assert.equal(rows.find((r) => r.externalRef === "m2")!.state, "live");
  assert.equal(rows.find((r) => r.externalRef === "m3")!.state, "upcoming"); // "12:30" = scheduled time
});

test("StatPal parsers never default an unrecognized/terminal status to live", () => {
  // esports: cancelled / postponed / abandoned / empty must NOT be "live"
  const es = parseStatpalEsports({ scores: { match: [
    { id: "c", status: "Cancelled", home: { name: "A", score: "0" }, away: { name: "B", score: "0" } },
    { id: "p", status: "Postponed", home: { name: "A", score: "0" }, away: { name: "B", score: "0" } },
    { id: "a", status: "Abandoned", home: { name: "A", score: "0" }, away: { name: "B", score: "0" } },
    { id: "e", status: "", home: { name: "A", score: "0" }, away: { name: "B", score: "0" } },
    { id: "live", status: "Started", home: { name: "A", score: "1" }, away: { name: "B", score: "0" } },
  ] } });
  assert.equal(es.find((r) => r.externalRef === "c")!.state, "finished");
  assert.equal(es.find((r) => r.externalRef === "p")!.state, "upcoming");
  assert.equal(es.find((r) => r.externalRef === "a")!.state, "finished");
  assert.equal(es.find((r) => r.externalRef === "e")!.state, "upcoming");
  assert.equal(es.find((r) => r.externalRef === "live")!.state, "live", "genuine in-play still live");
  // soccer: "Canc." must be finished, not a phantom live 0-0
  const sc = parseStatpalSoccer({ live_matches: { league: [{ name: "X", match: [
    { main_id: "canc", status: "Canc.", home: { name: "A", goals: "0" }, away: { name: "B", goals: "0" } },
    { main_id: "min", status: "63", home: { name: "A", goals: "1" }, away: { name: "B", goals: "0" } },
  ] }] } });
  assert.equal(sc.find((r) => r.externalRef === "canc")!.state, "finished");
  assert.equal(sc.find((r) => r.externalRef === "min")!.state, "live");
});

test("normalizeEvent: an empty outcome price becomes null, not a phantom 0¢", () => {
  const ev = normalizeEvent({ id: "1", slug: "s", title: "A vs B", markets: [
    { groupItemTitle: "M", outcomes: '["A","B"]', outcomePrices: '["",""]', clobTokenIds: '["t1","t2"]', liquidity: "500" },
  ] });
  assert.equal(ev.markets[0].priceCents, null, "empty string price → null (Number(\"\")===0 trap guarded)");
});

test("parseStatpalEsports: Started=live, Not Started=upcoming, Finished=final", () => {
  const json = { scores: { sport: "esports", match: [
    { id: "e1", status: "Started", type: "League Of Legends", home: { name: "T1", score: "1" }, away: { name: "GenG", score: "0" } },
    { id: "e2", status: "Not Started", type: "Dota 2", home: { name: "OG", score: "0" }, away: { name: "VP", score: "0" } },
    { id: "e3", status: "Finished", type: "CS GO", home: { name: "NAVI", score: "2" }, away: { name: "FaZe", score: "1" } },
  ] } };
  const rows = parseStatpalEsports(json);
  assert.deepEqual(rows.map((r) => r.state), ["live", "upcoming", "finished"]);
  assert.equal(rows[0].scoreHome, 1); assert.equal(rows[2].final, true);
  assert.equal(rows[0].home, "T1"); assert.equal(rows[0].detail, "League Of Legends");
});

test("parseStatpalCricket: winner/comment => finished; match as object; runs as score", () => {
  const json = { scores: { sport: "cricket", category: [
    { id: "c", name: "MLC", match: { id: "k1", status: "Stumps",
      home: { name: "Sri Lanka A", totalscore: "366", winner: "False" },
      away: { name: "India A", totalscore: "543", winner: "True" },
      comment: { post: "India A won by 10 wickets" } } },
    { id: "c2", name: "T20", match: { id: "k2", status: "Not Started",
      home: { name: "X", totalscore: "" }, away: { name: "Y", totalscore: "" } } },
    // live T20: score is "runs/wickets" — take the runs
    { id: "c3", name: "MLC", match: { id: "k3", status: "In Progress",
      home: { name: "Seattle Orcas", totalscore: "108/9" }, away: { name: "Texas Super Kings", totalscore: "" } } },
  ] } };
  const rows = parseStatpalCricket(json);
  const k1 = rows.find((r) => r.externalRef === "k1")!;
  assert.equal(k1.state, "finished", "winner flag / 'won by' => finished despite 'Stumps' status");
  assert.equal(k1.scoreHome, 366); assert.equal(k1.scoreAway, 543);
  assert.equal(rows.find((r) => r.externalRef === "k2")!.state, "upcoming");
  const k3 = rows.find((r) => r.externalRef === "k3")!;
  assert.equal(k3.state, "live"); assert.equal(k3.scoreHome, 108, "runs parsed from '108/9'");
});

test("parseStatpalSoccer: minute-status=live, FT=finished, clock-time=upcoming (Morocco covered)", () => {
  const json = { live_matches: { league: [
    { name: "Morocco: Botola Pro", country: "morocco", match: [
      { main_id: "s1", status: "63", minute: "63", home: { name: "Difaa El Jadidi", goals: "1" }, away: { name: "Berkane", goals: "3" } },
    ] },
    // XML collapse: single match arrives as an object
    { name: "England: Premier League", country: "england", match: {
      main_id: "s2", status: "FT", home: { name: "Arsenal", goals: "2" }, away: { name: "Chelsea", goals: "0" } } },
    { name: "Spain: LaLiga", country: "spain", match: {
      main_id: "s3", status: "20:00", home: { name: "A", goals: "" }, away: { name: "B", goals: "" } } },
  ] } };
  const rows = parseStatpalSoccer(json);
  const s1 = rows.find((r) => r.externalRef === "s1")!;
  assert.equal(s1.state, "live"); assert.equal(s1.minute, 63);
  assert.equal(s1.scoreHome, 1); assert.equal(s1.scoreAway, 3);
  assert.equal(rows.find((r) => r.externalRef === "s2")!.state, "finished");
  assert.equal(rows.find((r) => r.externalRef === "s3")!.state, "upcoming"); // "20:00" clock = scheduled
});

test("CompositeSportsProvider routes by league tag (statpal gaps + football, espn majors)", async () => {
  const cfg = loadSportsCfg({ SPORTS_ENABLED: "true", STATPAL_KEY: "k" });
  const statpal = new StatpalSportsProvider(cfg);
  const espn = new EspnSportsProvider(cfg);
  const comp = new CompositeSportsProvider(statpal, espn, new Set(["tennis", "esports", "cricket", "football"]));
  assert.deepEqual(comp.leaguesFor("tennis"), ["sp:tennis"]);          // -> statpal only
  assert.deepEqual(comp.leaguesFor("basketball"), ["nba", "wnba"]);    // -> espn only
  assert.deepEqual(comp.leaguesFor("football"), ["sp:football"]);      // -> statpal feed + ESPN linked leagues (added by enrich)
  // an "sp:*" league routes to StatPal; a real slug routes to ESPN
  const espnMark = { async scoreboard(s: string, l: string) { return [{ externalRef: "espn:" + l }] as any; }, name: "e", leaguesFor: () => [] };
  const spMark = { async scoreboard() { return [{ externalRef: "statpal" }] as any; }, name: "s", leaguesFor: () => [] };
  const c2 = new CompositeSportsProvider(spMark as any, espnMark as any, new Set(["football"]));
  assert.equal((await c2.scoreboard("football", "sp:football"))[0].externalRef, "statpal");
  assert.equal((await c2.scoreboard("football", "eng.1"))[0].externalRef, "espn:eng.1");
});
