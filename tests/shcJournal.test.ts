// ============================================================
// EDGE LAB — ЖУРНАЛ НАБЛЮДЕНИЙ: ВЕРДИКТ ПЕРЕЖИВАЕТ ИСТОЧНИК
//
// Свойство, ради которого журнал существует: сверка двух прогонов 04.08 показала, что 11 из 12
// наблюдений исчезли за часы — источник кэпнут (20k строк при ~20 записях/20с). Здесь доказывается,
// что после материализации вердикт СТОИТ, даже когда снимков не осталось ни одного.
//
// И три условия ратификации: провенанс полями, версия гипотез полем, предсказания ЗАМОРОЖЕНЫ (строка
// судится тем правилом, при котором записана, а не сегодняшним кодом).
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { recordShcObservations } from "../src/lib/shcJournal.js";
import { buildSetHandicapConvention, SHC_HYPO_VERSION, PRIOR_VERDICT } from "../src/lib/setHandicapConvention.js";

const P1 = "Carlos Alcaraz", P2 = "Jannik Sinner";
const ML = `Canadian Open: ${P1} vs ${P2}`;
const HCAP = `Canadian Open: ${P1} vs ${P2} Set Handicap +/-1.5`;

function world() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 1000, external_league: null, created_at: "2026-07-01" } as never);
  return db;
}
function played(db: ReturnType<typeof world>, i: number, o: { favP1: boolean; setsP1: number; setsP2: number; mlPrice: number; hcapPrice?: number; outcomeFirst?: string | null }) {
  const id = `m${i}`;
  const day = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10);
  R.insertMatch(db, { id, competition_id: "atp", home: P1, away: P2, state: "finished", lineup_out: false, kickoff_at: `${day}T10:00:00Z`, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id } as never);
  const snap = (at: string, p1c: number | null, s1: number, s2: number) => R.insertTennisSnapshot(db, {
    event_key: `ek${i}-${at}`, provider: "apitennis", batch_at: at, p1: P1, p2: P2, tournament: "ATP",
    event_type: "ATP Singles", live: 1, status: "Set 1", sets_p1: s1, sets_p2: s2, set_num: 1,
    games_p1: 0, games_p2: 0, game_points: null, server: null, pm_match_id: id,
    pm_mid_cents: p1c, pm_p1_cents: p1c, pm_p2_cents: p1c == null ? null : 100 - p1c, raw: null,
  });
  snap(`${day}T10:00:00Z`, o.favP1 ? 70 : 30, 0, 0);
  snap(`${day}T13:00:00Z`, null, o.setsP1, o.setsP2);
  // `outcome_first` — имя исхода, чью вероятность несёт цена. Здесь это ПЕРВЫЙ в подписи: фикстуры
  // моделируют «нормальный» листинг, а переворот проверяется отдельным тестом.
  R.insertMarket(db, { id: `mk${i}ml`, match_id: id, label: ML, price: o.mlPrice, ai_prob: null, liquidity: 3000, external_ref: null, outcome_first: o.outcomeFirst ?? P1, outcome_second: P2, snapshot_at: `${day}T14:00:00Z`, is_closing: false } as never);
  if (o.hcapPrice != null) R.insertMarket(db, { id: `mk${i}h`, match_id: id, label: HCAP, price: o.hcapPrice, ai_prob: null, liquidity: 3000, external_ref: null, outcome_first: o.outcomeFirst ?? P1, outcome_second: P2, snapshot_at: `${day}T14:00:00Z`, is_closing: false } as never);
}

test("ВЕРДИКТ ПЕРЕЖИВАЕТ ИСТОЧНИК: снимки стёрты — журнал держит", () => {
  const db = world();
  for (let i = 0; i < 10; i++) played(db, i, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 97 });
  const rec = recordShcObservations(db, "2026-08-04T12:00:00Z");
  assert.ok(rec.written >= 20, `заморожены и контроль, и тест (записано ${rec.written})`);
  const before = buildSetHandicapConvention(db);
  assert.equal(before.testMatches, 10);

  // Кэп сработал: снимков не осталось НИ ОДНОГО — ровно то, что случилось на проде за часы.
  db.prepare(`DELETE FROM tennis_snapshots`).run();
  const after = buildSetHandicapConvention(db);
  assert.equal(after.testMatches, 10, "вердикт стоит на журнале, а не на испарившемся источнике");
  assert.equal(after.controlChecked, before.controlChecked);
  assert.equal(after.verdict, before.verdict);
  assert.ok(after.journalRows > 0);
});

test("идемпотентность: повторный проход НЕ плодит строк и не переписывает замороженное", () => {
  const db = world();
  played(db, 0, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 97 });
  const a = recordShcObservations(db, "2026-08-04T12:00:00Z");
  const b = recordShcObservations(db, "2026-08-04T12:30:00Z");
  assert.ok(a.written > 0);
  assert.equal(b.written, 0, "второй проход не пишет ничего");
  assert.equal(b.total, a.total);
});

test("ПРОВЕНАНС и ВЕРСИЯ ГИПОТЕЗ — полями: строка объясняет саму себя", () => {
  const db = world();
  played(db, 0, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 97 });
  recordShcObservations(db, "2026-08-04T12:00:00Z");
  const row = R.shcObservations(db).find((x) => x.kind === "test")!;
  assert.equal(row.hypo_version, SHC_HYPO_VERSION);
  assert.match(row.score_src, /^scout_snapshot@2026-07-01T13:00:00Z$/);
  assert.match(row.price_src, /^markets@2026-07-01T14:00:00Z$/);
  assert.match(row.fav_src, /^first_priced_snapshot@2026-07-01T10:00:00Z$/);
  assert.equal(row.kickoff_at, "2026-07-01T10:00:00Z", "день матча — им отделяются НОВЫЕ наблюдения");
});

test("предсказания ЗАМОРОЖЕНЫ: строка судится своим правилом, а не сегодняшним кодом", () => {
  const db = world();
  played(db, 0, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 97 });
  recordShcObservations(db, "2026-08-04T12:00:00Z");
  const row = R.shcObservations(db).find((x) => x.kind === "test")!;
  assert.equal(row.pred_favourite, 1);
  assert.equal(row.pred_label_first, 1);
  assert.equal(row.discriminating, 0, "фаворит первый в подписи ⇒ гипотезы согласны");
  // Подменяем замороженное предсказание — вердикт обязан читать ЕГО, а не пересчитывать.
  db.prepare(`UPDATE shc_observations SET pred_favourite=0 WHERE id=?`).run(row.id);
  const r = buildSetHandicapConvention(db);
  assert.equal(r.testMismatch, 1, "вердикт взял предсказание ИЗ СТРОКИ");
});

test("не разрешившееся и не доигранное в журнал НЕ идут, и это посчитано", () => {
  const db = world();
  played(db, 0, { favP1: true, setsP1: 2, setsP2: 0, mlPrice: 99, hcapPrice: 55 });  // цена в середине
  played(db, 1, { favP1: true, setsP1: 1, setsP2: 0, mlPrice: 99, hcapPrice: 97 });  // никто не набрал 2
  const rec = recordShcObservations(db, "2026-08-04T12:00:00Z");
  assert.equal(rec.skippedUndecided, 1, "цена 55¢ — исхода нет");
  // [T3-фикс 05.08] Недоигранный матч теперь выбрасывается из ОБЕИХ групп: замер прода показал, что
  // манилайн при ретайре разрешается НЕ нормально — двое из четырёх контрольных расхождений были ровно
  // такими. Поэтому у матча 1:0 не пишется ни гандикап, ни манилайн — отсюда 2, а не 1.
  assert.equal(rec.skippedIncomplete, 2, "1:0 — ретайр: ни ±1.5, ни манилайн не судятся");
  assert.equal(R.shcObservations(db).filter((x) => x.kind === "test").length, 0);
  assert.match(rec.note, /заморожено новых/);
});

test("ПРЕЖНИЕ вердикты помечены unverified — невоспроизводимый вывод не держит решение о деньгах", () => {
  const db = world();
  const r = buildSetHandicapConvention(db);
  assert.equal(r.priors.length, 2, "их уже два, и оба пали от дефекта ИНСТРУМЕНТА, а не от новых данных");
  assert.ok(r.priors.every((p) => p.status === "unverified" && p.verdict === "ОПРОВЕРГНУТА"));
  assert.match(r.priors[0]!.why, /11 из 12 наблюдений исчезли/);
  assert.match(r.priors[1]!.why, /ДОПУЩЕНИЕ «цена всегда про первого в подписи»/);
  assert.equal(PRIOR_VERDICT.status, "unverified");
  assert.equal(r.verdict, "НЕ СОЗРЕЛО", "пустой журнал = отсутствие замера, T3 остаётся fail-closed");
});
