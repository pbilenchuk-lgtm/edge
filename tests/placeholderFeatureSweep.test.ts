// ============================================================
// ПОИСК РАЗДЕЛЯЮЩЕГО ПРИЗНАКА — И ТРИ ЗАЩИТЫ ОТ САМООБМАНА
//
// Две правки порога #121 уже выдвинуты и откачены: обе стояли на ОДНОМ признаке (перекос манилайна), и
// замер показал, что он брак не разделяет. Этот отчёт ищет признак, который разделяет, — и потому опаснее
// прочих: перебирая признаки по корзинам на выборке в десятки строк, победителя найдёшь ВСЕГДА.
//
// Здесь держатся ровно те свойства, без которых отчёт вреднее отсутствия:
//   1. корзина без размера не получает доли (2 из 3 = 66.7% обманывает сильнее пустой клетки);
//   2. разброс считается только между ДВУМЯ достаточными корзинами;
//   3. лучший из перебора называется КАНДИДАТОМ с требованием перепроверки, а не находкой.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildFeatureSweep, featureSweepLine, MIN_BUCKET_N, CANDIDATE_MIN_SPREAD_PP } from "../src/lib/placeholderFeatureSweep.js";

const T0 = "2026-08-08T10:00:00.000Z";
const KICK = "2026-08-08T20:00:00.000Z";   // +10ч → корзина «2–12ч»

function db0() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: T0 } as never);
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "upcoming", lineup_out: false,
    kickoff_at: KICK, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null,
    end_time: null, duration: null, end_note: null, external_ref: "m1" } as never);
  return db;
}

let seq = 0;
const cut = (db: ReturnType<typeof db0>, o: { label: string; ml?: number | null; wasFalse: boolean }) =>
  db.prepare(`INSERT INTO placeholder_cuts(id,match_id,market_label,reason,path,cut_cents,ask_cents,spread_cents,ml_cents,cut_at,later_cents,later_at,false_cut)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(R.uid(), "m1", `${o.label} #${++seq}`, "unquoted_book", "no_book", 50, null, null,
      o.ml === undefined ? 50 : o.ml, T0, o.wasFalse ? 72 : 51, T0, o.wasFalse ? 1 : 0);

test("нет дозревших — раскладывать нечего, и это СКАЗАНО, а не показано нулями", () => {
  const s = buildFeatureSweep(db0(), T0);
  assert.equal(s.rows, 0);
  assert.deepEqual(s.features, []);
  assert.equal(s.candidate, null);
  assert.match(s.note, /раскладывать нечего/);
});

test("ЗАЩИТА 1: корзина меньше порога НЕ получает доли — «2 из 3» не превращается в 66.7%", () => {
  const db = db0();
  cut(db, { label: "Under 3.5", wasFalse: true });
  cut(db, { label: "Under 3.5", wasFalse: true });
  cut(db, { label: "Under 3.5", wasFalse: false });
  const fam = buildFeatureSweep(db, T0).features.find((f) => f.feature === "семья пропа")!;
  const b = fam.buckets.find((x) => x.bucket === "totals")!;
  assert.equal(b.n, 3);
  assert.equal(b.falseCutPct, null, "доля без размера не печатается");
  assert.match(b.note, new RegExp(`не измерено \\(нужно ≥${MIN_BUCKET_N}\\)`));
});

test("ЗАЩИТА 2: разброс требует ДВУХ достаточных корзин — одна против неизмеренной не считается", () => {
  const db = db0();
  for (let i = 0; i < MIN_BUCKET_N; i++) cut(db, { label: "Under 3.5", wasFalse: i < 2 });  // totals, достаточна
  cut(db, { label: "BTTS Yes", wasFalse: true });                                            // btts, мала
  const fam = buildFeatureSweep(db, T0).features.find((f) => f.feature === "семья пропа")!;
  assert.equal(fam.measuredBuckets, 1);
  assert.equal(fam.spreadPp, null);
  assert.match(fam.note, /РАЗДЕЛЕНИЕ НЕ ПРОВЕРЕНО/);
});

test("разделения нет — сказано прямо: «менять правило не на чем»", () => {
  const db = db0();
  // Две достаточные корзины с ОДИНАКОВОЙ долей: признак не разделяет.
  for (let i = 0; i < MIN_BUCKET_N; i++) cut(db, { label: "Under 3.5", wasFalse: i < 2 });
  for (let i = 0; i < MIN_BUCKET_N; i++) cut(db, { label: "BTTS Yes", wasFalse: i < 2 });
  const s = buildFeatureSweep(db, T0);
  const fam = s.features.find((f) => f.feature === "семья пропа")!;
  assert.equal(fam.measuredBuckets, 2);
  assert.equal(fam.spreadPp, 0);
  assert.equal(s.candidate, null);
  assert.match(s.note, /РАЗДЕЛЯЮЩЕГО ПРИЗНАКА СРЕДИ ПРОВЕРЕННЫХ НЕТ/);
  assert.match(s.note, /Менять правило не на чем/);
});

test("ЗАЩИТА 3: разброс есть — но это КАНДИДАТ, и множественное сравнение названо вслух", () => {
  const db = db0();
  for (let i = 0; i < MIN_BUCKET_N; i++) cut(db, { label: "Under 3.5", wasFalse: true });    // totals: 100%
  for (let i = 0; i < MIN_BUCKET_N; i++) cut(db, { label: "BTTS Yes", wasFalse: false });    // btts: 0%
  const s = buildFeatureSweep(db, T0);
  assert.equal(s.candidate?.feature, "семья пропа");
  assert.equal(s.candidate?.spreadPp, 100);
  assert.ok((s.candidate!.spreadPp) >= CANDIDATE_MIN_SPREAD_PP);
  assert.match(s.candidate!.note, /КАНДИДАТ, не находка/);
  assert.match(s.candidate!.note, /находится ВСЕГДА — просто по случайности/);
  assert.match(s.candidate!.note, /на СВЕЖИХ строках/);
  assert.match(featureSweepLine(s), /НЕ подтверждён/);
});

test("перекос манилайна разложен КОРЗИНАМИ, а не порогом: порог мы уже проверили", () => {
  const db = db0();
  cut(db, { label: "Under 3.5", ml: 50, wasFalse: false });
  cut(db, { label: "Under 3.5", ml: 58, wasFalse: false });
  cut(db, { label: "Under 3.5", ml: 68, wasFalse: true });
  cut(db, { label: "Under 3.5", ml: 88, wasFalse: true });
  cut(db, { label: "Under 3.5", ml: null, wasFalse: false });
  const ml = buildFeatureSweep(db, T0).features.find((f) => f.feature === "перекос манилайна")!;
  // Сравниваем МНОЖЕСТВОМ: порядок корзин задаётся размером, а не алфавитом, и пинить его — значит
  // ловить сортировку вместо свойства.
  assert.deepEqual(new Set(ml.buckets.map((b) => b.bucket)),
    new Set(["перекос <5¢", "перекос 5–15¢", "перекос 15–25¢", "перекос ≥25¢", "манилайна нет"]));
});

test("часы до старта: срез уже в игре — СВОЯ корзина, а не свалка в «<2ч»", () => {
  const db = db0();
  cut(db, { label: "Under 3.5", wasFalse: false });                       // за 10ч до старта
  db.prepare(`UPDATE placeholder_cuts SET cut_at=? WHERE rowid=1`).run("2026-08-08T21:00:00.000Z"); // после старта
  const k = buildFeatureSweep(db, T0).features.find((f) => f.feature === "часы до старта")!;
  assert.deepEqual(k.buckets.map((b) => b.bucket), ["уже в игре"]);
});
