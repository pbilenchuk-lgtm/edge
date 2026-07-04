import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import {
  loadPolymarketConfig, getQuotes, fetchMidpointCents,
  normalizeEvent, eventToMarketSnapshots, titleMatchScore,
  findMatchEvent, fetchEventBySlug, listSportEvents,
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
  assert.equal(snaps[1].label, "Total Sets: O/U 2.5");
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
  const assessment = { confidence: "высокая", short: "s", body: "b", verdict: "v", markets: labels.map((l) => ({ label: l, prob: 0.99 })) };
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
