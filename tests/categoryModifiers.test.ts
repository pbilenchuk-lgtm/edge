import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { categoryForCompetition, migrateCategoryModifiers, CATEGORY_MODIFIER_BODIES, CATEGORY_MODIFIER_VERSION } from "../src/lib/categoryModifiers.js";
import { PROMPT_WC_CONTEXT } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";

test("categoryForCompetition: maps by ESPN league, name, and disambiguates look-alikes", () => {
  const m = (id: string, name: string, league: string | null) => categoryForCompetition({ id, name, external_league: league });
  // ESPN league code is the strongest signal
  assert.equal(m("pm-x", "x", "uefa.champions"), "ucl");
  assert.equal(m("pm-x", "x", "uefa.europa"), "uel");
  assert.equal(m("pm-x", "x", "uefa.europa.conf"), "conference", "conference wins over uel");
  assert.equal(m("pm-x", "x", "bra.1"), "br_serie_a");
  assert.equal(m("pm-x", "x", "bra.2"), "br_serie_b");
  assert.equal(m("pm-x", "x", "usa.1"), "mls");
  assert.equal(m("pm-x", "NWSL", "usa.nwsl"), "nwsl", "nwsl not confused with mls");
  assert.equal(m("pm-x", "x", "mex.1"), "liga_mx");
  assert.equal(m("pm-x", "x", "per.1"), "peru_liga1");
  assert.equal(m("pm-x", "x", "nor.1"), "norway");
  assert.equal(m("pm-x", "x", "swe.1"), "sweden");
  assert.equal(m("pm-x", "x", "aus.cup"), "aus_cup");
  // name-only fallback (no league code)
  assert.equal(m("pm-soccer-ucl", "Лига чемпионов", null), "ucl");
  assert.equal(m("pm-conference", "Conference League", null), "conference");
  assert.equal(m("pm-botola", "Morocco Botola Pro", null), "morocco");
  assert.equal(m("pm-kleague", "K-League", null), "kleague");
  // Italy Serie A must NOT map to Brazil Serie A
  assert.equal(m("pm-seriea", "Серия A", "ita.1"), null, "Italy Serie A is not a Brazil category");
  // an unmapped league → null (untouched)
  assert.equal(m("pm-soccer-epl", "АПЛ", "eng.1"), null);
});

test("migrateCategoryModifiers: assigns the matching modifier, self-heals, never clobbers user/WC", () => {
  const db = openDb(":memory:");
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "pm-soccer-ucl", sport_id: "football", name: "Лига чемпионов", budget: 0, external_league: "uefa.champions", created_at: "t" });
  R.upsertCompetition(db, { id: "pm-liga-mx", sport_id: "football", name: "Liga MX", budget: 0, external_league: "mex.1", created_at: "t" });
  R.upsertCompetition(db, { id: "pm-soccer-fifwc", sport_id: "football", name: "ЧМ-2026", budget: 0, external_league: "fifa.world", created_at: "t" });
  R.upsertCompetition(db, { id: "pm-soccer-epl", sport_id: "football", name: "АПЛ", budget: 0, external_league: "eng.1", created_at: "t" });
  // pre-existing prompts that must survive
  R.upsertAnalyticsPrompt(db, "competition", "pm-soccer-fifwc", PROMPT_WC_CONTEXT, null);
  R.upsertAnalyticsPrompt(db, "competition", "pm-liga-mx", "МОЙ РУЧНОЙ ПРОМПТ без маркера", "Claude Opus 4.8");

  migrateCategoryModifiers(db, "t");

  // UCL got its modifier; carries the version marker
  const ucl = R.analyticsPromptRow(db, "competition", "pm-soccer-ucl");
  assert.ok(ucl?.body.includes(CATEGORY_MODIFIER_VERSION) && ucl.body.includes("UEFA CHAMPIONS LEAGUE"), "UCL modifier seeded");
  assert.equal(ucl!.body, CATEGORY_MODIFIER_BODIES["ucl"]);
  // WC modifier untouched (not one of ours)
  assert.equal(R.analyticsPromptRow(db, "competition", "pm-soccer-fifwc")!.body, PROMPT_WC_CONTEXT, "World Cup prompt preserved");
  // user-edited Liga MX prompt NOT clobbered (no version marker → left alone)
  assert.equal(R.analyticsPromptRow(db, "competition", "pm-liga-mx")!.body, "МОЙ РУЧНОЙ ПРОМПТ без маркера", "hand-edited prompt preserved");
  // unmapped EPL gets nothing
  assert.equal(R.analyticsPromptRow(db, "competition", "pm-soccer-epl"), null);

  // idempotent: a second run changes nothing for the already-seeded UCL
  const before = R.analyticsPromptRow(db, "competition", "pm-soccer-ucl")!.body;
  migrateCategoryModifiers(db, "t2");
  assert.equal(R.analyticsPromptRow(db, "competition", "pm-soccer-ucl")!.body, before);
});
