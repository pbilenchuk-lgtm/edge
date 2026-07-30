// ============================================================
// EDGE LAB — ОТКАЗ ПРОВАЙДЕРА ОБЯЗАН НАЗЫВАТЬСЯ ОТКАЗОМ
//
// 30.07.2026: ~40 теннисных матчей висели в «ЖДЁМ КОРТ» больше пяти часов после своего времени начала,
// последний снимок скаута был от 29.07 22:00. Скаут при этом ИСПРАВНО крутился каждый тик: ручной
// прогон POST /api/tennis-scout вернул {"ok":true,"written":0}. Причина не читалась НИОТКУДА, потому что
// `fetchTennisLivescores` схлопывала четыре разных исхода в один голый []:
//   HTTP 403 (квота) · конверт {"success":0,"result":{"error":...}} · таймаут · «в мире нет лайв-матчей».
// Сторож при этом печатал «провайдер отдаёт пусто/не мапится» — формально верно, чинить нечего.
// Хуже: обёртка в collectTennisSnapshots ловила ИСКЛЮЧЕНИЕ, чтобы записать маркер ошибки, а выборка
// не бросала никогда — маркер `tennis_scout_last_error` был мёртвой проводкой того же класса, что
// R1-хвост и Z2 (сторож ратифицированных фич).
//
// Эти тесты фиксируют: причина пустоты НАЗЫВАЕТСЯ, доезжает до маркера, доезжает до диагноза сторожа,
// и снимается сама, когда провайдер починился.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { fetchTennisLivescores, collectTennisSnapshots, tennisScoutHealth, tennisScoutSilence } from "../src/lib/tennisScout.js";
import { migrateTennisStrategy } from "../src/lib/seed.js";

const CFG = { enabled: true, key: "k", base: "https://x/", timeoutMs: 8000 } as any;
const jsonFetch = (body: unknown, ok = true, status = 200) =>
  (async () => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) })) as unknown as typeof fetch;

const ROW = {
  event_key: "E1", event_first_player: "A Player", event_second_player: "B Player",
  event_live: "1", event_status: "Set 1", tournament_name: "ATP Test", event_type_type: "Atp Singles",
  event_final_result: "0 - 0", scores: [{ score_set: 1, score_first: "2", score_second: "1" }], event_serve: "First Player",
};

test("fetchTennisLivescores: КАЖДАЯ причина пустоты названа, а не отдана голым []", async () => {
  // 1. HTTP-отказ (квота/ключ) — не «нет матчей», а http 403.
  const http = await fetchTennisLivescores(CFG, { fetchImpl: jsonFetch({}, false, 403) });
  assert.deepEqual(http.rows, []);
  assert.match(String(http.error), /http 403/);

  // 2. Конверт API-Tennis с success=0 — самый частый вид тихой слепоты (квота исчерпана).
  const envelope = await fetchTennisLivescores(CFG, { fetchImpl: jsonFetch({ success: 0, result: { error: "quota exceeded" } }) });
  assert.deepEqual(envelope.rows, []);
  assert.match(String(envelope.error), /quota exceeded/);

  // 3. success=0 ПРИ массиве-результате: раньше проходило как валидная пустота.
  const zeroOk = await fetchTennisLivescores(CFG, { fetchImpl: jsonFetch({ success: 0, result: [] }) });
  assert.match(String(zeroOk.error), /success=0/);

  // 4. Исключение в самом fetch (сеть) — тоже названо.
  const boom = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  assert.match(String((await fetchTennisLivescores(CFG, { fetchImpl: boom })).error), /exception: ECONNRESET/);

  // 5. И — ГЛАВНОЕ — честная пустота остаётся честной пустотой: успех + пустой список = НЕ ошибка.
  const empty = await fetchTennisLivescores(CFG, { fetchImpl: jsonFetch({ success: 1, result: [] }) });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.error, null, "успешный ответ с пустым списком — это не отказ провайдера");

  // 6. Нормальный ответ разбирается по-прежнему.
  const okRes = await fetchTennisLivescores(CFG, { fetchImpl: jsonFetch({ success: 1, result: [ROW] }) });
  assert.equal(okRes.error, null);
  assert.equal(okRes.rows.length, 1);
  assert.equal(okRes.rows[0].live, 1);
});

test("collectTennisSnapshots: отказ провайдера доезжает до маркера, а чистый прогон его СНИМАЕТ", async () => {
  const db = openDb(":memory:");
  const deps = { env: { API_TENNIS_KEY: "k", API_TENNIS_BASE: "https://x/" }, now: () => "2026-07-30T11:45:00.000Z" } as any;

  const written = await collectTennisSnapshots(db, { ...deps, fetchImpl: jsonFetch({ success: 0, result: { error: "quota exceeded" } }) });
  assert.equal(written, 0);
  const bad = tennisScoutHealth(db, Date.parse("2026-07-30T11:45:00.000Z"));
  assert.match(String(bad.error), /quota exceeded/, "причина отказа записана и читается снаружи");
  assert.equal(bad.rawRows, 0);

  // Провайдер починился → маркер обязан сняться, иначе старая ошибка липнет навсегда и врёт.
  await collectTennisSnapshots(db, { ...deps, now: () => "2026-07-30T11:46:00.000Z", fetchImpl: jsonFetch({ success: 1, result: [ROW] }) });
  const good = tennisScoutHealth(db, Date.parse("2026-07-30T11:46:00.000Z"));
  assert.equal(good.error, null, "чистый прогон снимает маркер отказа");
  assert.equal(good.rawRows, 1);
  assert.equal(good.liveRows, 1);
  assert.equal(good.written, 1);
});

test("collectTennisSnapshots: провайдер вернул строки, но НИ ОДНОЙ in-play — это отличается от нуля строк", async () => {
  const db = openDb(":memory:");
  const deps = { env: { API_TENNIS_KEY: "k", API_TENNIS_BASE: "https://x/" }, now: () => "2026-07-30T11:45:00.000Z" } as any;
  // Расписание есть, матчи не начались: 3 строки, live=0, статус не терминальный.
  const scheduled = [1, 2, 3].map((i) => ({ ...ROW, event_key: `S${i}`, event_live: "0", event_status: "" }));
  await collectTennisSnapshots(db, { ...deps, fetchImpl: jsonFetch({ success: 1, result: scheduled }) });
  const h = tennisScoutHealth(db, Date.parse("2026-07-30T11:45:00.000Z"));
  assert.equal(h.error, null, "провайдер ответил успехом — это НЕ его отказ");
  assert.equal(h.rawRows, 3);
  assert.equal(h.liveRows, 0, "строки есть, in-play нет — отдельная поломка, отдельное число");
  assert.equal(h.written, 0);
});

test("tennisScoutSilence: отказ провайдера НАЗЫВАЕТСЯ, а не маскируется под «луп жив, отдаёт пусто»", async () => {
  const db = openDb(":memory:");
  migrateTennisStrategy(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
  const nowMs = Date.parse("2026-07-30T11:45:00.000Z");
  // Матч по расписанию давно должен идти — внешняя опора, которая не умирает вместе со скаутом.
  R.insertMatch(db, {
    id: R.uid(), competition_id: "pm-atp", home: "A Player", away: "B Player", state: "lineup", lineup_out: true,
    kickoff_at: "2026-07-30T09:00:00Z", minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: "m1",
  });
  const deps = { env: { API_TENNIS_KEY: "k", API_TENNIS_BASE: "https://x/" }, now: () => "2026-07-30T11:45:00.000Z" } as any;
  await collectTennisSnapshots(db, { ...deps, fetchImpl: jsonFetch({}, false, 403) });

  const s = tennisScoutSilence(db, deps);
  assert.equal(s.silent, true, "снимков нет, а матч по расписанию идёт — молчание");
  assert.match(s.note, /ПРОВАЙДЕР ОТКАЗАЛ/, "диагноз называет отказ");
  assert.match(s.note, /http 403/, "и цитирует провайдера дословно");
  assert.doesNotMatch(s.note, /H2/, "ветка «луп жив, отдаёт пусто» больше не выигрывает у реальной причины");

  // А вот когда провайдер отвечает успехом и пустым списком — диагноз H2 законен и остаётся.
  await collectTennisSnapshots(db, { ...deps, fetchImpl: jsonFetch({ success: 1, result: [] }) });
  const s2 = tennisScoutSilence(db, deps);
  assert.equal(s2.silent, true);
  assert.match(s2.note, /H2/, "успех + пустота — это по-прежнему слепой скаут, а не отказ");
  assert.match(s2.note, /строк 0/, "и говорит, СКОЛЬКО строк вернул провайдер");
});
