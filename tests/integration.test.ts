import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import {
  loadPolymarketConfig, getQuotes, fetchMidpointCents,
} from "../src/lib/polymarket.js";
import {
  resolveModel, apiKeyFor, callLLM, generateStrategyName, heuristicName,
} from "../src/lib/llm.js";
import { extractThresholds } from "../src/lib/thresholds.js";

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
