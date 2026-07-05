import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import {
  loadPolymarketConfig, getQuotes, fetchMidpointCents,
  normalizeEvent, eventToMarketSnapshots, titleMatchScore,
  findMatchEvent, fetchEventBySlug, listSportEvents,
  isNoiseMarket, matchMarketSnapshots, parseMatchTitle,
} from "../src/lib/polymarket.js";
import {
  resolveModel, apiKeyFor, callLLM, generateStrategyName, heuristicName,
  effectiveEnv, providerEnabled,
} from "../src/lib/llm.js";
import { extractThresholds } from "../src/lib/thresholds.js";
import { analyzeMatch } from "../src/lib/analysis.js";

// Mock an Anthropic response carrying a JSON assessment for assessMatchLLM.
function mockLLM(assessment: unknown) {
  return async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(assessment) }] }) }) as any;
}

// ---------------- DB + seed + repo (§2) ----------------
test("seed populates the full slice", () => {
  const db = openDb(":memory:");
  seedDatabase(db);

  assert.equal(R.getTreasury(db).total_balance, 5000);
  assert.equal(R.listCompetitions(db).length, 4);
  assert.equal(R.listStrategies(db).length, 4);

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
  assert.equal(snaps.length, 2); // the priceless one is dropped
  assert.deepEqual(snaps[0], { label: "Connor Doig vs Eudald Gonzalez", price: 62, external_ref: "tok-a", liquidity: "1234" });
  assert.equal(snaps[1].label, "Total Sets: Over 2.5"); // O/U clarified to the priced side (outcomes[0])
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
  assert.ok(labels.includes("Over 2.5") && labels.includes("Both Teams to Score"));
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
  const ev = await findMatchEvent(cfg, { sport: "tennis", home: "Connor Doig", away: "Eudald Gonzalez" }, { fetchImpl: eventsFetch });
  assert.ok(ev);
  assert.equal(ev!.slug, "atp-doig-gonzal-2026-07-04");

  // wrong names -> no confident match
  assert.equal(await findMatchEvent(cfg, { sport: "tennis", home: "Nadal", away: "Federer" }, { fetchImpl: eventsFetch }), null);
  // unknown sport -> null without any fetch
  assert.equal(await findMatchEvent(cfg, { sport: "curling", home: "a", away: "b" }, { fetchImpl: eventsFetch }), null);

  const bySlug = await fetchEventBySlug(cfg, "atp-doig-gonzal-2026-07-04", { fetchImpl: eventsFetch });
  assert.equal(bySlug!.title, EVENT_FIXTURE[0].title);

  assert.deepEqual(await listSportEvents(cfg, "curling", 10, { fetchImpl: eventsFetch }), []);
  assert.equal((await listSportEvents(cfg, "football", 10, { fetchImpl: eventsFetch })).length, 1);
});

test("importPolymarketMatches: liquid match imported even w/o ESPN coverage; thin one skipped", async () => {
  const { importPolymarketMatches } = await import("../src/lib/engine.js");
  const base = loadPolymarketConfig({ POLYMARKET_ENABLED: "true" });
  const now = "2026-07-03T12:00:00Z";
  // The tennis fixture is a Wimbledon Juniors match — ESPN doesn't cover it, so
  // the old ESPN-only gate skipped it. With liquidity 1234+500 it now imports.
  const db = openDb(":memory:");
  seedDatabase(db);
  const items = await importPolymarketMatches(db, "tennis",
    { fetchImpl: eventsFetch, polymarket: { ...base, minLiquidity: 250 }, now: () => now });
  assert.equal(items.length, 1, "liquid uncovered match imported");
  assert.equal(items[0].created, true);
  const m = R.matchByExternalRef(db, "pm:tennis:connordoig-eudaldgonzalez");
  assert.ok(m, "match row created under a pm-* tennis category");
  assert.ok(R.latestMarkets(db, m!.id).length >= 2, "settleable markets attached");
  assert.ok(db.prepare("SELECT 1 FROM sports WHERE id='tennis'").get(), "sport row present (FK target)");

  // Same fixture, threshold above its liquidity → skipped entirely.
  const db2 = openDb(":memory:");
  seedDatabase(db2);
  const none = await importPolymarketMatches(db2, "tennis",
    { fetchImpl: eventsFetch, polymarket: { ...base, minLiquidity: 100000 }, now: () => now });
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

test("analyzeMatch: fuzzy label mapping survives model paraphrase", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const labels = R.latestMarkets(db, "m-lineup").map((m) => m.label);
  // model paraphrases "Over 2.5" -> "Over 2.5 goals"; all others verbatim.
  const assessment = {
    confidence: "высокая", short: "s", body: "b", verdict: "v",
    markets: labels.map((l) => ({ label: l === "Over 2.5" ? "Over 2.5 goals" : l, prob: 0.5 })),
  };
  const r = await analyzeMatch(db, "m-lineup", { fetchImpl: mockLLM(assessment), env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r.ok, true);
  const over25 = R.latestMarkets(db, "m-lineup").find((m) => m.label === "Over 2.5")!;
  assert.equal(over25.ai_prob, 0.5); // fuzzy-matched despite the "goals" drift
});

test("analyzeMatch: portfolio stop-loss halts a strategy's entries", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  const labels = R.latestMarkets(db, "m-lineup").map((m) => m.label);
  // mock carries both assessment fields and strategist picks (one static JSON
  // answers both LLM calls); the strategist picks every market so bets flow.
  const assessment = { confidence: "высокая", short: "s", body: "b", verdict: "v", markets: labels.map((l) => ({ label: l, prob: 0.99 })), picks: labels.map((l) => ({ label: l, conviction: "высокая", reason: "t" })), exits: [] };
  const deps = { fetchImpl: mockLLM(assessment), env: { ANTHROPIC_API_KEY: "k" } };

  // baseline: strong edges => at least one strategy proposes bets
  await analyzeMatch(db, "m-lineup", deps);
  const baseline = R.betsForMatch(db, "m-lineup").filter((b) => b.status === "proposed");
  assert.ok(baseline.length > 0, "baseline should propose bets");
  const strat = baseline[0].strategy_id;

  // give that strategy a stop-loss and blow it with a big settled loss on
  // another match of the same competition, then re-analyze.
  const s = R.getStrategy(db, strat)!;
  R.updateStrategy(db, strat, { params: { ...s.params, stop: -0.1, minEdge: 1 } });
  R.insertBet(db, {
    id: R.uid(), match_id: "m-finished", strategy_id: strat, market_label: "x",
    status: "settled_lost", proposed_price: 50, entry_price: 50, current_price: 50,
    closing_price: 50, ai_prob: 0.5, stake: 100000, rationale: "blown", entered_minute: null,
    result: "lost", payout: 0, created_at: "t",
  });
  await analyzeMatch(db, "m-lineup", deps);
  const after = R.betsForMatch(db, "m-lineup").filter((b) => b.status === "proposed" && b.strategy_id === strat);
  assert.equal(after.length, 0, "stopped-out strategy proposes nothing");
});
