// ============================================================
// EDGE LAB — O1: ЭФФЕКТИВНАЯ КОНФИГУРАЦИЯ ЕСТЬ ДАННЫЕ, А НЕ ПАМЯТЬ  [ТЗ наблюдаемости]
//
// Инцидент, породивший ТЗ: прод неделю входил по conservative-1.0, пока код вёз 2.0. Расхождение было
// невидимо — ни одна запись решения не несла того, ПОД КАКИМИ порогами она принята, и «что было
// настроено в тот вторник» решалось археологией по датам деплоя.
//
// Приёмка O1 здесь — не «функция вызывается», а ТРИ свойства, каждое из которых инцидент бы поймало:
//   1. хэш РЕАГИРУЕТ на решающие поля и НЕ реагирует на посторонние (иначе разрез когорты — шум);
//   2. ставка несёт хэш эпохи, под которой принята → «под какими порогами» становится JOIN-ом;
//   3. смена эпохи — СОБЫТИЕ в журнале, на которое можно наложить график метрики.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { seedRiskProfiles } from "../src/lib/riskConfig.js";
import {
  effectiveConfig, configHash, canonicalJson, fnv1a, recordConfigEpoch, recordSystemEvent,
  listSystemEvents, configEpochByHash, currentConfigHash, invalidateConfigHash, bootEcho,
  CONFIG_BOOT_SNAPSHOT_KEY, DECISION_ENV_KEYS,
} from "../src/lib/configEpoch.js";

const NOW = "2026-08-02T12:00:00.000Z";

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  seedRiskProfiles(db, NOW);
  invalidateConfigHash();
  return db;
}

test("канонический JSON не зависит от порядка вставки — иначе разрез когорты поедет на ровном месте", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ x: { q: 1, p: 2 } }), canonicalJson({ x: { p: 2, q: 1 } }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  assert.equal(fnv1a("abc"), fnv1a("abc"), "хэш детерминирован");
  assert.notEqual(fnv1a("abc"), fnv1a("abd"));
});

test("хэш РЕАГИРУЕТ на порог входа — ровно то, что инцидент пресета сделал невидимым", () => {
  const db = seed();
  const before = configHash(effectiveConfig(db));
  const cfg = JSON.parse(R.getRiskProfileRow(db, "conservative")!.content);
  cfg.entry_thresholds.min_calibration = 0.55;                      // откат к 1.0-бару
  R.upsertRiskProfile(db, { id: "conservative", name: "К", content: JSON.stringify(cfg), sort: 2, created_at: NOW });
  assert.notEqual(configHash(effectiveConfig(db)), before, "сдвиг порога ОБЯЗАН менять эпоху");
});

test("хэш реагирует на смену промпта и на решающий env — и НЕ реагирует на посторонний", () => {
  const db = seed();
  R.upsertSport(db, "football", "Футбол");
  const base = configHash(effectiveConfig(db, {}));

  // промпт
  R.insertStrategy(db, { id: "s1", sport_id: "football", name: "S", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: NOW, prompt: "A", prompt_live: null, params: {} } as never);
  const withPrompt = configHash(effectiveConfig(db, {}));
  assert.notEqual(withPrompt, base);
  db.prepare(`UPDATE strategies SET prompt='B' WHERE id='s1'`).run();
  assert.notEqual(configHash(effectiveConfig(db, {})), withPrompt, "смена промпта — смена эпохи");

  // решающий env vs посторонний
  const k = DECISION_ENV_KEYS[0];
  assert.notEqual(configHash(effectiveConfig(db, { [k]: "0.9" })), configHash(effectiveConfig(db, {})));
  assert.equal(
    configHash(effectiveConfig(db, { PORT: "3000" })), configHash(effectiveConfig(db, { PORT: "8080" })),
    "хэш, реагирующий на порт, обесценивает себя первым же ложным разрезом",
  );
});

test("ставка несёт хэш эпохи, под которой принята — «под какими порогами» становится JOIN-ом", () => {
  const db = seed();
  const rec = recordConfigEpoch(db, NOW);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "MLS", budget: 100, external_league: "usa.1", created_at: NOW });
  R.insertStrategy(db, { id: "pv", sport_id: "football", name: "PV", tag: "t", color: null, version: 1, model: "m", model_live: "m", created_at: NOW, prompt: "p", prompt_live: null, params: {} } as never);
  R.insertMatch(db, { id: "m1", competition_id: "c1", home: "H", away: "A", state: "finished", lineup_out: true, kickoff_at: NOW, minute: null, score_home: 1, score_away: 0, final_score: "1:0", kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1" } as never);
  R.insertBet(db, { id: "b1", match_id: "m1", strategy_id: "pv", risk_profile_id: "medium", market_label: "Over 1.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 10, rationale: "r", entered_minute: "предматч", result: null, payout: null, created_at: NOW } as never);

  const stamped = (db.prepare(`SELECT config_hash h FROM bets WHERE id='b1'`).get() as { h: string }).h;
  assert.equal(stamped, rec.hash, "штамп ставки = эпоха, зафиксированная при старте");
  const epoch = configEpochByHash(db, stamped)!;
  assert.ok(epoch, "по хэшу достаются ПОЛНЫЕ значения — это и есть JOIN вместо археологии");
  assert.match(epoch.content, /min_calibration/);
});

test("смена эпохи — СОБЫТИЕ в журнале; неизменный конфиг события не рождает", () => {
  const db = seed();
  recordConfigEpoch(db, NOW);
  assert.equal(listSystemEvents(db).filter((e) => e.kind === "config_epoch").length, 0, "первая фиксация — не «смена»");

  recordConfigEpoch(db, "2026-08-02T12:05:00.000Z");
  assert.equal(listSystemEvents(db).filter((e) => e.kind === "config_epoch").length, 0, "тот же конфиг — тишина по делу");

  const cfg = JSON.parse(R.getRiskProfileRow(db, "medium")!.content);
  cfg.entry_thresholds.min_edge = 0.09;
  R.upsertRiskProfile(db, { id: "medium", name: "С", content: JSON.stringify(cfg), sort: 1, created_at: NOW });
  const r = recordConfigEpoch(db, "2026-08-02T12:10:00.000Z");
  assert.equal(r.changed, true);
  const ev = listSystemEvents(db).filter((e) => e.kind === "config_epoch");
  assert.equal(ev.length, 1, "СМЕНА порогов обязана оставить вертикальную линию на графике");
  assert.match(ev[0].detail, new RegExp(r.hash));
});

test("повторная фиксация той же эпохи двигает last_seen, а не плодит строки", () => {
  const db = seed();
  recordConfigEpoch(db, NOW);
  recordConfigEpoch(db, "2026-08-03T00:00:00.000Z");
  const rows = db.prepare(`SELECT hash, first_seen, last_seen FROM config_epochs`).all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first_seen, NOW);
  assert.equal(rows[0].last_seen, "2026-08-03T00:00:00.000Z");
});

test("boot-echo кладёт снимок в app_meta и пишет событие старта — «что стояло» перестаёт быть вопросом", () => {
  const db = seed();
  const rec = bootEcho(db, NOW);
  const snap = JSON.parse(R.metaGet(db, CONFIG_BOOT_SNAPSHOT_KEY)!);
  assert.equal(snap.hash, rec.hash);
  assert.ok(snap.cfg.profiles.conservative, "снимок несёт ПОЛНЫЕ пороги, а не только хэш");
  assert.equal(listSystemEvents(db).filter((e) => e.kind === "boot").length, 1);
});

test("кэш хэша сбрасывается явно — иначе процесс штамповал бы устаревшую эпоху после миграции", () => {
  const db = seed();
  const first = currentConfigHash(db);
  const cfg = JSON.parse(R.getRiskProfileRow(db, "aggressive")!.content);
  cfg.entry_thresholds.min_edge = 0.11;
  R.upsertRiskProfile(db, { id: "aggressive", name: "А", content: JSON.stringify(cfg), sort: 0, created_at: NOW });
  assert.equal(currentConfigHash(db), first, "кэш держится — пересчёт на каждой ставке был бы дорог и бессмыслен");
  invalidateConfigHash();
  assert.notEqual(currentConfigHash(db), first, "после явного сброса эпоха новая");
});

test("журнал не роняет то, что наблюдает: битая запись события не бросает", () => {
  const db = seed();
  assert.doesNotThrow(() => recordSystemEvent(db, "boot", NOW, { circular: undefined }));
});
