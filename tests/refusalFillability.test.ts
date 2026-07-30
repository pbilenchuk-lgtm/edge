// ============================================================
// EDGE LAB — WOULD-BE ВХОД ПО ЦЕНЕ, КОТОРОЙ НЕ БЫЛО, ДОКАЗАТЕЛЬСТВОМ НЕ ЯВЛЯЕТСЯ
//
// refusal_shadow (R5) созрел с вердиктом screw_too_tight: win 39.9% против implied 18.2%, p=0, n=143.
// По протоколу это команда калибровать анти-фантомный порог. Но прод 30.07 показал, на КАКИХ досках
// эти отказы записывались: на четырёх живых матчах по 10 тоталов «с заявленным краем» уходили в
// would-be, а на самих досках 36 из 40, 32 из 36 и 30 из 34 рынков стояли у планки. implied 18.2%
// при win 39.9% — подпись нарисованных лонгшотов, а не нашей правоты.
//
// Определение would-be С САМОГО НАЧАЛА требовало исполнимости, просто она не проверялась. Поэтому
// фильтр — не новое условие когорты и не передвигание ворот: если бы вердикт смотрел в другую
// сторону, он требовался бы точно так же.
//
// Стандарт берётся ДОСЛОВНО из unfillable_edge через общий зонд: ≥$50 в ≤3¢ от цены сигнала по
// замороженному снимку глубины. Два одинаковых по замыслу порога, написанных дважды, у нас уже
// разъезжались (порог планки) — поэтому реализация одна.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildRefusalShadow, recordRefusalShadow } from "../src/lib/refusalShadow.js";
import { buildFillabilityProbe } from "../src/lib/unfillableEdge.js";

const AT = "2026-07-20T12:00:00.000Z";

function seedMatch(db: ReturnType<typeof openDb>, id: string) {
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "c1", sport_id: "football", name: "Conf", budget: 1000, external_league: "uefa.europa.conf", created_at: "t" });
  R.insertMatch(db, {
    id, competition_id: "c1", home: "A", away: "B", state: "finished", lineup_out: true,
    kickoff_at: AT, minute: null, score_home: 1, score_away: 1, final_score: "1:1",
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id,
  });
}

function depthSnap(db: ReturnType<typeof openDb>, matchId: string, label: string, asks: [number, number][]) {
  db.prepare(
    `INSERT INTO book_depth_snapshots (id, match_id, label, token_id, asks_json, best_ask_cents, ask_depth_usd, at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(R.uid(), matchId, label, "tok-" + label, JSON.stringify(asks), asks[0]?.[0] ?? null, null, AT);
}

test("покрытие читается ПЕРВЫМ: без снимков вердикт объявляется НЕЧИТАЕМЫМ, а не выносится на дырявых данных", () => {
  const db = openDb(":memory:");
  seedMatch(db, "m1");
  // Двадцать выигравших отказов — по голой когорте это выглядело бы как громкий screw_too_tight.
  for (let i = 0; i < 20; i++) {
    recordRefusalShadow(db, {
      matchId: "m1", strategyId: "prematch_value", marketLabel: `Over ${i}.5`, family: "totals",
      ourProb: 0.6, implied: 0.18, edge: 0.42, entryCents: 18, kickoffAt: AT, codeVersion: null, note: null, at: AT,
    });
  }
  db.prepare(`UPDATE refusal_shadow_signals SET status='won'`).run();

  const rep = buildRefusalShadow(db, {});
  assert.equal(rep.fillability.snapshots, 0, "снимков нет");
  assert.equal(rep.verdict, "insufficient", "вердикт НЕ выносится");
  assert.match(rep.note, /НЕЧИТАЕМ/, "и это сказано прямо, а не спрятано за «мало данных»");
  assert.match(rep.note, /копим вперёд УЖЕ С ФИЛЬТРОМ/i);
});

test("неисполнимые would-be выбрасываются из вердикта, а не засчитываются как правота", () => {
  const db = openDb(":memory:");
  seedMatch(db, "m1");
  // Два сигнала: у одного книга держит $50 в ≤3¢, у другого — жалкие $2 (доска у планки, покупать нечего).
  recordRefusalShadow(db, { matchId: "m1", strategyId: "s", marketLabel: "Over 2.5", family: "totals", ourProb: 0.6, implied: 0.4, edge: 0.2, entryCents: 40, kickoffAt: AT, codeVersion: null, note: null, at: AT });
  recordRefusalShadow(db, { matchId: "m1", strategyId: "s", marketLabel: "Over 5.5", family: "totals", ourProb: 0.6, implied: 0.02, edge: 0.58, entryCents: 2, kickoffAt: AT, codeVersion: null, note: null, at: AT });
  db.prepare(`UPDATE refusal_shadow_signals SET status='won'`).run();
  depthSnap(db, "m1", "Over 2.5", [[41, 200]]);   // $82 в пределах полосы → исполним
  depthSnap(db, "m1", "Over 5.5", [[3, 60]]);     // $1.8 → НЕ исполним, ровно тот фантомный лонгшот

  const rep = buildRefusalShadow(db, {});
  assert.equal(rep.fillability.scoredTotal, 2);
  assert.equal(rep.fillability.fillable, 1);
  assert.equal(rep.fillability.unfillable, 1, "лонгшот на пустой книге отсеян");
  assert.equal(rep.scored, 1, "в вердикт идёт только подтверждённо исполнимый");
  assert.equal(rep.fillability.fillablePct, 50);
});

test("«снимка нет» — третий ответ, а не «исполнимо»: презумпция исполнимости и была исходной ошибкой", () => {
  const db = openDb(":memory:");
  seedMatch(db, "m1");
  recordRefusalShadow(db, { matchId: "m1", strategyId: "s", marketLabel: "Over 2.5", family: "totals", ourProb: 0.6, implied: 0.4, edge: 0.2, entryCents: 40, kickoffAt: AT, codeVersion: null, note: null, at: AT });
  recordRefusalShadow(db, { matchId: "m1", strategyId: "s", marketLabel: "Over 3.5", family: "totals", ourProb: 0.6, implied: 0.3, edge: 0.3, entryCents: 30, kickoffAt: AT, codeVersion: null, note: null, at: AT });
  db.prepare(`UPDATE refusal_shadow_signals SET status='won'`).run();
  depthSnap(db, "m1", "Over 2.5", [[41, 200]]);   // снимок есть только у одного

  const rep = buildRefusalShadow(db, {});
  assert.equal(rep.fillability.fillable, 1);
  assert.equal(rep.fillability.unknown, 1, "без снимка — «неизвестно», не «исполнимо»");
  assert.equal(rep.scored, 1, "неизвестное не идёт в вердикт ни в одну сторону");
});

test("зонд исполнимости — одна реализация: те же числа, что в unfillable_edge", () => {
  const db = openDb(":memory:");
  seedMatch(db, "m1");
  depthSnap(db, "m1", "Over 2.5", [[41, 200]]);
  const probe = buildFillabilityProbe(db, { fromMs: Date.parse(AT) - 86_400_000, env: {} });
  assert.deepEqual(probe.params, { minSizeUsd: 50, bandCents: 3, snapshotWindowMin: 12 });
  assert.equal(probe("m1", "Over 2.5", 40, AT), true);
  // Снимок ЕСТЬ, но глубины в полосе нет → false («неисполнимо»), а не null («не знаем»). Три ответа, не два.
  assert.equal(probe("m1", "Over 2.5", 20, AT), false, "книга видна, но в ≤3¢ от 20¢ покупать нечего");
  assert.equal(probe("m1", "Нет такого", 40, AT), null);
  assert.equal(probe.coverage.snapshots, 1);
});
