// ============================================================
// EDGE LAB — ФОРЕНЗИК КАЛИБРОВКИ 02.08 НАШЁЛ НЕ КАЛИБРОВКУ, А РАСХОЖДЕНИЕ ПРАВИЛ
//
// Владелец: предматч-канал почти закрыт, стратег ссылается на «недостаточную калибровку» — проверь, не
// уехала ли калибровочная функция. Проверили: не уехала (все 40 входов «золотой ячейки» на момент входа
// лежали в 0.50–0.62, сегодняшний диапазон тот же). Уехало ДРУГОЕ: живая база держит `conservative-1.0`
// (edge 7% / кал 0.55 / ликв $2000), а код с 25.07 везёт `conservative-2.0` (5% / 0.45 / $1000).
//
// Механика молчания: `seedRiskProfiles` выходит на первой строке, если в базе есть хоть один профиль.
// Правильно для «не затирать владельца» — и означает, что изменение пресета НИКОГДА не доедет до прода.
// В логах прода это видно как 18 отказов «калибровка X < 0.55» у бара, отменённого неделю назад.
//
// Эти тесты держат ровно одно: расхождение обязано быть НАЗВАНО. Чинить его автоматически нельзя —
// правка владельца и невыехавший пресет в базе выглядят одинаково.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { RISK_PROFILE_DEFS, seedRiskProfiles } from "../src/lib/riskConfig.js";
import { buildProfileDrift, profileDriftLine } from "../src/lib/profileDrift.js";

const NOW = "2026-08-02T12:00:00.000Z";

function db0() { const db = openDb(":memory:"); initSchema(db); return db; }

/** Дословный `conservative-1.0` — то, что реально лежит в проде. */
const CONSERVATIVE_1_0 = {
  config_version: "conservative-1.0",
  entry_thresholds: { min_edge: 0.07, min_edge_low_liquidity: 0.10, min_calibration: 0.55, min_market_liquidity: 2000 },
  sizing: { kelly_fraction_base: 0.12, calibration_ref: 0.6, kelly_fraction_clamp: [0.04, 0.20], max_position_pct: 0.03, max_match_exposure_pct: 0.06 },
  bankroll_limits: { daily_loss_limit_pct: 0.10, max_concurrent_exposure_pct: 0.20, max_concurrent_positions: 5 },
  safeguards: { global_drawdown_killswitch_pct: 0.25, absurd_edge_block: 0.25, max_quote_age_seconds: 30, prob_sum_tolerance: 0.02 },
  exits: { take_profit_pct: 0.35, hard_stop_pct: 0.40 },
};

function putProd(db: ReturnType<typeof db0>, id: string, cfg: unknown, name = id) {
  R.upsertRiskProfile(db, { id, name, content: JSON.stringify(cfg), sort: 0, created_at: NOW });
}

test("свежепосеянная база расхождения не даёт — иначе отчёт кричал бы всегда", () => {
  const db = db0();
  seedRiskProfiles(db, NOW);
  const rep = buildProfileDrift(db, NOW);
  assert.equal(rep.driftedFields, 0, rep.note);
  assert.match(profileDriftLine(rep), /profile_drift: 0/);
});

test("прод-случай: conservative-1.0 против conservative-2.0 — расхождение названо поимённо", () => {
  const db = db0();
  seedRiskProfiles(db, NOW);
  putProd(db, "conservative", CONSERVATIVE_1_0, "Консервативный");

  const rep = buildProfileDrift(db, NOW);
  const c = rep.profiles.find((p) => p.id === "conservative")!;
  assert.equal(c.prodVersion, "conservative-1.0");
  assert.equal(c.codeVersion, "conservative-2.0");

  const by = new Map(c.fields.map((f) => [f.path, f]));
  assert.deepEqual(by.get("entry_thresholds.min_calibration")!.prod, 0.55);
  assert.deepEqual(by.get("entry_thresholds.min_calibration")!.code, 0.45);
  assert.deepEqual(by.get("entry_thresholds.min_edge")!.prod, 0.07);
  assert.deepEqual(by.get("entry_thresholds.min_market_liquidity")!.prod, 2000);
});

test("направление расхождения названо: по этим полям ПРОД СТРОЖЕ кода", () => {
  const db = db0();
  seedRiskProfiles(db, NOW);
  putProd(db, "conservative", CONSERVATIVE_1_0, "Консервативный");
  const rep = buildProfileDrift(db, NOW);
  const c = rep.profiles.find((p) => p.id === "conservative")!;
  for (const path of ["entry_thresholds.min_edge", "entry_thresholds.min_calibration", "entry_thresholds.min_market_liquidity"]) {
    assert.equal(c.fields.find((f) => f.path === path)!.prodStricter, true, path);
  }
  assert.match(profileDriftLine(rep), /ПРОД СТРОЖЕ КОДА: conservative/);
});

test("мягче кода — тоже расхождение, но строгостью не помечается", () => {
  const db = db0();
  seedRiskProfiles(db, NOW);
  const loose = JSON.parse(JSON.stringify(RISK_PROFILE_DEFS.find((d) => d.id === "medium")!.values));
  loose.entry_thresholds.min_calibration = 0.10;
  putProd(db, "medium", loose, "Средний");
  const f = buildProfileDrift(db, NOW).profiles.find((p) => p.id === "medium")!
    .fields.find((x) => x.path === "entry_thresholds.min_calibration")!;
  assert.equal(f.prod, 0.10);
  assert.equal(f.prodStricter, false);
});

test("отчёт НИЧЕГО не пишет — база после него та же", () => {
  const db = db0();
  seedRiskProfiles(db, NOW);
  putProd(db, "conservative", CONSERVATIVE_1_0, "Консервативный");
  const before = R.getRiskProfileRow(db, "conservative")!.content;
  buildProfileDrift(db, NOW);
  assert.equal(R.getRiskProfileRow(db, "conservative")!.content, before,
    "автоподтяжка запрещена: правка владельца и невыехавший пресет в базе неразличимы");
});

test("отсутствующий профиль — это missing, а не сорок расхождений по полям", () => {
  const db = db0();
  seedRiskProfiles(db, NOW);
  db.prepare(`DELETE FROM risk_profiles WHERE id='aggressive'`).run();
  const a = buildProfileDrift(db, NOW).profiles.find((p) => p.id === "aggressive")!;
  assert.equal(a.missing, true);
  assert.equal(a.fields.length, 0);
});

test("посев в НЕпустую базу молчит — это и есть причина, по которой пресет не доезжает", () => {
  const db = db0();
  putProd(db, "conservative", CONSERVATIVE_1_0, "Консервативный");
  seedRiskProfiles(db, NOW);                       // ← выйдет на первой строке: профиль уже есть
  const stored = JSON.parse(R.getRiskProfileRow(db, "conservative")!.content);
  assert.equal(stored.entry_thresholds.min_calibration, 0.55,
    "посев не переписал старый пресет — расхождение живёт, пока его не назовут");
  assert.ok(buildProfileDrift(db, NOW).driftedFields > 0);
});
