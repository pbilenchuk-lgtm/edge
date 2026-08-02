// ============================================================
// EDGE LAB — «РАТИФИЦИРОВАНО, НО НЕ ДОЕХАЛО» ЛЕЧИТСЯ МИГРАЦИЕЙ, А НЕ ПАМЯТЬЮ
//
// Третий случай класса (после Z2 и quasi-locked): Фаза 1.3 сняла старый бар conservative 25.07, а прод
// входил по нему ещё неделю — посев профилей выходит на первой строке, если профили уже есть.
//
// Владелец ратифицировал подтяжку с тремя условиями, и тесты держат ИМЕННО их:
//   (а) один проход по ВСЕМ пресетам + снимок расхождения ДО записи (иначе «что было в базе за секунду
//       до миграции» перестаёт быть доказуемым ровно в тот момент, когда это важнее всего);
//   (б) эпоха тегом на дате переключения — когорта conservative-1.0 остаётся отличимой от 2.0;
//   (в) строка drift живёт вечно и от миграции не зависит (её держит profileDrift.test.ts).
//
// И отдельно — то, чего миграция делать НЕ должна: быть вечной. «Код всегда прав» молча затирал бы
// правки владельца через UI, то есть ровно то, от чего ранний выход посева и защищал.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { seedRiskProfiles, getProfileConfig } from "../src/lib/riskConfig.js";
import { migrateRiskPresetsToCode } from "../src/lib/riskPresetMigration.js";
import { buildProfileDrift, PRESET_EPOCH_CUT_KEY } from "../src/lib/profileDrift.js";
import { CODE_VERSION } from "../src/lib/betMeta.js";
import { epochNum, crossEpoch } from "../src/lib/codeEpoch.js";

const NOW = "2026-08-02T12:00:00.000Z";

/** Дословный прод-конфиг на 02.08: старый бар, который код снял неделей раньше. */
const CONSERVATIVE_1_0 = {
  config_version: "conservative-1.0",
  entry_thresholds: { min_edge: 0.07, min_edge_low_liquidity: 0.10, min_calibration: 0.55, min_market_liquidity: 2000 },
  sizing: { kelly_fraction_base: 0.12, calibration_ref: 0.6, kelly_fraction_clamp: [0.04, 0.20], max_position_pct: 0.03, max_match_exposure_pct: 0.06 },
  bankroll_limits: { daily_loss_limit_pct: 0.10, max_concurrent_exposure_pct: 0.20, max_concurrent_positions: 5 },
  safeguards: { global_drawdown_killswitch_pct: 0.25, absurd_edge_block: 0.25, max_quote_age_seconds: 30, prob_sum_tolerance: 0.02 },
  exits: { take_profit_pct: 0.35, hard_stop_pct: 0.40 },
};

function prodLike() {
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, NOW);
  R.upsertRiskProfile(db, { id: "conservative", name: "Консервативный", content: JSON.stringify(CONSERVATIVE_1_0), sort: 2, created_at: NOW });
  return db;
}

test("прод-случай: conservative подтянут к 2.0 — бар 0.55 больше не отказывает", () => {
  const db = prodLike();
  assert.equal(getProfileConfig(db, "conservative").entry_thresholds.min_calibration, 0.55);

  const r = migrateRiskPresetsToCode(db, NOW);
  assert.equal(r.ran, true);
  assert.deepEqual(r.synced.map((s) => s.id), ["conservative"]);
  assert.equal(r.synced[0].from, "conservative-1.0");
  assert.equal(r.synced[0].to, "conservative-2.0");

  const cfg = getProfileConfig(db, "conservative");
  assert.equal(cfg.entry_thresholds.min_calibration, 0.45);
  assert.equal(cfg.entry_thresholds.min_edge, 0.05);
  assert.equal(cfg.entry_thresholds.min_market_liquidity, 1000);
  assert.equal(buildProfileDrift(db, NOW).driftedFields, 0, "после миграции отчёт обязан замолчать");
});

test("(а) проход ОДИН и по всем пресетам: уехавший medium подтянут той же миграцией", () => {
  const db = prodLike();
  const bentMedium = { ...JSON.parse(JSON.stringify(CONSERVATIVE_1_0)), config_version: "medium-1.0" };
  R.upsertRiskProfile(db, { id: "medium", name: "Средний", content: JSON.stringify(bentMedium), sort: 1, created_at: NOW });

  const r = migrateRiskPresetsToCode(db, NOW);
  assert.deepEqual(r.synced.map((s) => s.id).sort(), ["conservative", "medium"],
    "ловим не только пойманный профиль — дрейфовать мог любой");
  assert.equal(getProfileConfig(db, "medium").entry_thresholds.min_calibration, 0.45);
});

test("(а) снимок расхождения снят ДО записи и переживает миграцию", () => {
  const db = prodLike();
  migrateRiskPresetsToCode(db, NOW);
  const cut = JSON.parse(R.metaGet(db, PRESET_EPOCH_CUT_KEY)!);
  const c = cut.driftBefore.find((x: { id: string }) => x.id === "conservative");
  const by = new Map(c.fields.map((f: { path: string; prod: unknown }) => [f.path, f.prod]));
  assert.equal(by.get("entry_thresholds.min_calibration"), 0.55,
    "что стояло в базе за секунду до подтяжки — доказуемо и ПОСЛЕ неё");
  assert.equal(by.get("entry_thresholds.min_market_liquidity"), 2000);
});

test("(б) эпоха разрезает когорты: ставка до отметки и после — не одна выборка", () => {
  const db = prodLike();
  migrateRiskPresetsToCode(db, NOW);
  const cut = JSON.parse(R.metaGet(db, PRESET_EPOCH_CUT_KEY)!);
  assert.equal(cut.codeEpochAtCut, CODE_VERSION);
  assert.equal(CODE_VERSION, "e10", "эпоха поднята тем же деплоем — иначе разметки не существует");

  // Старая когорта conservative-1.0 (e9) и новая (e10) читаются как разные эпохи…
  assert.equal(epochNum("e9·m1"), 9);
  assert.equal(epochNum("e10·m1"), 10);
  assert.ok(epochNum("e10·m1") > epochNum("e9·m1"));
  // …а позиция, пережившая переключение, карантинится как двухрежимная.
  assert.equal(crossEpoch({ code_version: "e9·m1", exit_code_version: "e10·m1" }), true);
  assert.equal(crossEpoch({ code_version: "e10·m1", exit_code_version: "e10·m1" }), false);
});

test("миграция ОДНОРАЗОВАЯ: повторный запуск не трогает более позднюю правку владельца", () => {
  const db = prodLike();
  migrateRiskPresetsToCode(db, NOW);
  // Владелец после миграции руками поднял бар обратно — это его право, и код не имеет права спорить.
  const owner = { ...JSON.parse(JSON.stringify(CONSERVATIVE_1_0)), config_version: "conservative-2.0", entry_thresholds: { ...CONSERVATIVE_1_0.entry_thresholds, min_calibration: 0.60 } };
  R.upsertRiskProfile(db, { id: "conservative", name: "Консервативный", content: JSON.stringify(owner), sort: 2, created_at: NOW });

  const again = migrateRiskPresetsToCode(db, "2026-08-09T12:00:00.000Z");
  assert.equal(again.ran, false, "маркер держит: миграция чинит один зафиксированный разрыв, а не правит вечно");
  assert.equal(getProfileConfig(db, "conservative").entry_thresholds.min_calibration, 0.60,
    "правка владельца пережила второй запуск");
  assert.ok(buildProfileDrift(db, NOW).driftedFields > 0, "и она честно видна в drift-отчёте, а не затёрта");
});

test("профиль без пресета в коде (`max`) не мигрируется и не притворяется совпавшим", () => {
  const db = prodLike();
  const maxCfg = { ...JSON.parse(JSON.stringify(CONSERVATIVE_1_0)), config_version: "1.0" };
  R.upsertRiskProfile(db, { id: "max", name: "max", content: JSON.stringify(maxCfg), sort: 3, created_at: NOW });

  const r = migrateRiskPresetsToCode(db, NOW);
  assert.deepEqual(r.skippedNoCodePreset, ["max"]);
  assert.equal(getProfileConfig(db, "max").entry_thresholds.min_calibration, 0.55, "конфиг `max` не тронут");
  const row = buildProfileDrift(db, NOW).profiles.find((p) => p.id === "max")!;
  assert.equal(row.noCodePreset, true);
  assert.equal(row.fields.length, 0, "нет пресета в коде — сравнивать не с чем, а не «сорок расхождений»");
});

test("пустая база маркер не ставит — иначе реальный разрыв, возникший позже, остался бы незалеченным", () => {
  const db = openDb(":memory:"); initSchema(db);
  const r = migrateRiskPresetsToCode(db, NOW);
  assert.equal(r.ran, false);
  assert.ok(!R.metaGet(db, PRESET_EPOCH_CUT_KEY), "отметки разреза нет — разрезать нечего");

  seedRiskProfiles(db, NOW);
  R.upsertRiskProfile(db, { id: "conservative", name: "Консервативный", content: JSON.stringify(CONSERVATIVE_1_0), sort: 2, created_at: NOW });
  assert.equal(migrateRiskPresetsToCode(db, NOW).synced.length, 1, "на следующем старте разрыв всё-таки лечится");
});

test("совпавшая база: миграция отмечает разрез и ничего не переписывает", () => {
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, NOW);
  const before = R.getRiskProfileRow(db, "conservative")!.content;
  const r = migrateRiskPresetsToCode(db, NOW);
  assert.equal(r.ran, true);
  assert.equal(r.synced.length, 0);
  assert.ok(r.alreadyEqual.includes("conservative"));
  assert.equal(R.getRiskProfileRow(db, "conservative")!.content, before);
});
