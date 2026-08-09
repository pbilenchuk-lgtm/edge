// ============================================================
// РАЗБОР НЕРАЗРЕШЁННЫХ В PMV-SHADOW: «мало данных» ≠ «мы их не дочитываем»
//
// Замер 07.08: 144 из 314 сигналов (50.3%) висят unresolved, а вердикт «GO» стоит на второй половине.
// Отчёт СЧИТАЛ долю и НЕ НАЗЫВАЛ состав — при том что причина пишется построчно в `resolve_note` при
// самом разрешении. Классы лечатся ПРОТИВОПОЛОЖНО:
//   • фид не отдал детализацию / ручной финал — исхода нет В ПРИРОДЕ, ожиданием не лечится;
//   • резолвер не осилил ярлык — исход ЕСТЬ, мы его не читаем. Каждая строка это бесплатная единица
//     когорты, недоделанная кодом.
// Слитые в один процент они неразличимы, и «копим дальше» выглядит единственным вариантом.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildPmvShadowCalibration, probePmvShadowManual, parseCf, resolvePmvShadowSignals } from "../src/lib/tennisPmvShadow.js";

const NOW = "2026-08-07T00:00:00.000Z";
const db0 = () => { const db = openDb(":memory:"); initSchema(db); return db; };

function sig(db: ReturnType<typeof db0>, id: string, o: { status: string; note?: string | null; label?: string; family?: string; theo?: number; mid?: number }) {
  db.prepare(`INSERT INTO pmv_shadow_signals(id,match_id,market_label,family,side,first_is_p1,theo_cents,mid_cents,deviation,delta,book_usd,tour,surface,epoch,status,resolve_note,hits,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, `m-${id}`, o.label ?? `L-${id}`, o.family ?? "totals", "over", 1, o.theo ?? 60, o.mid ?? 50, 0.1, 0, 1000, "atp", "hard", "e1", o.status, o.note ?? null, 1, NOW);
}

test("ИМЕННОЙ ЗАМЕР: причины разведены по классам, восстановимое названо числом", () => {
  const db = db0();
  // Исхода нет в природе — ожиданием не лечится.
  sig(db, "a1", { status: "unresolved", note: "детализация по сетам не читается на финале" });
  sig(db, "a2", { status: "unresolved", note: "детализация по сетам не читается на финале" });
  sig(db, "a3", { status: "unresolved", note: "исход неизвестен (manual/нет детали финала)" });
  // Исход ЕСТЬ, но резолвер не осилил ярлык — вот это восстановимо кодом.
  sig(db, "b1", { status: "unresolved", note: "resolveTennisProp не смог разрешить проп", label: "Set 2 Over 10.5", family: "games" });
  sig(db, "b2", { status: "unresolved", note: "resolveTennisProp не смог разрешить проп", label: "Set 3 Under 9.5", family: "games" });
  sig(db, "b3", { status: "unresolved", note: "resolveTennisProp не смог разрешить проп", label: "Match Over 22.5", family: "match_games" });
  sig(db, "w1", { status: "won" }); sig(db, "l1", { status: "lost" });

  const c = buildPmvShadowCalibration(db);
  assert.equal(c.counts.unresolved, 6);
  const cls = Object.fromEntries(c.unresolvedBreakdown.map((x) => [x.cls, x.n]));
  assert.equal(cls.resolver_cannot, 3, "восстановимые отделены");
  assert.equal(cls.feed_no_detail, 2);
  assert.equal(cls.manual_finish, 1);
  assert.match(c.note, /восстановимых резолвером 3/);
  assert.match(c.note, /без единого нового матча/);
});

test("адресный список работы: пробелы резолвера сгруппированы по семье с примерами ярлыков", () => {
  const db = db0();
  sig(db, "b1", { status: "unresolved", note: "resolveTennisProp не смог разрешить проп", label: "Set 2 Over 10.5", family: "games" });
  sig(db, "b2", { status: "unresolved", note: "resolveTennisProp не смог разрешить проп", label: "Set 3 Under 9.5", family: "games" });
  sig(db, "b3", { status: "unresolved", note: "resolveTennisProp не смог разрешить проп", label: "Match Over 22.5", family: "match_games" });
  const g = buildPmvShadowCalibration(db).resolverGaps;
  assert.equal(g[0]!.family, "games");
  assert.equal(g[0]!.n, 2);
  assert.ok(g[0]!.sampleLabels.includes("Set 2 Over 10.5"), "ярлык назван — иначе список не адресный");
  assert.equal(g.length, 2);
});

test("в пробелы резолвера НЕ попадает то, у чего исхода нет в природе", () => {
  const db = db0();
  sig(db, "a1", { status: "unresolved", note: "детализация по сетам не читается на финале", family: "games" });
  assert.deepEqual(buildPmvShadowCalibration(db).resolverGaps, [], "фид без детали — не вина резолвера");
});

test("нет неразрешённых — строка восстановления МОЛЧИТ, а не печатает ложный ноль", () => {
  const db = db0();
  sig(db, "w1", { status: "won" });
  const c = buildPmvShadowCalibration(db);
  assert.deepEqual(c.unresolvedBreakdown, []);
  assert.ok(!/ВОССТАНОВИМЫХ/.test(c.note));
});

// ============================================================
// ПОПРАВКА ПО ЗАМЕРУ 07.08. Прод дал 144 из 144 в классе `manual_finish` и ПУСТОЙ `resolverGaps`, а
// заметка объявила «восстановимых 0 — остальное ожиданием не лечится». Утверждение было НЕОБОСНОВАННЫМ:
// `if (fin.manual)` стоит ПЕРВЫМ и уходит в unresolved ДО вызова finalSetsFromRaw/resolveTennisProp, так
// что ноль в последующих классах означал «туда не дошло ни одной строки», а не «там пусто». Сторож
// посчитал свой ПЕРВЫЙ гейт за весь конвейер и вынес вердикт о ветках, которые не исполнялись.
//
// Ниже держатся три свойства: (1) незондированное НЕ выдаётся за «не лечится»; (2) зонд не меняет
// статусов; (3) разрешимое на СПОРНОМ счёте не смешивается с безопасным.
// ============================================================

test("СТОРОЖ ЛОЖНОЙ УВЕРЕННОСТИ: пока зонд не прошёл, «ожиданием не лечится» НЕ утверждается", () => {
  const db = db0();
  sig(db, "a1", { status: "unresolved", note: "исход неизвестен (manual/нет детали финала)" });
  const c = buildPmvShadowCalibration(db);
  assert.equal(c.manualProbe.probed, 0);
  assert.equal(c.manualProbe.unprobed, 1);
  assert.ok(!/не лечится/.test(c.note), "вердикт о ветке, которая не исполнялась, не выносится");
  assert.match(c.note, /НЕ УСТАНОВЛЕНО/);
});

test("конвейер пройден ДО КОНЦА и разрешимых нет — только тогда «ожиданием не лечится»", () => {
  const db = db0();
  sig(db, "a1", { status: "unresolved", note: "исход неизвестен (manual/нет детали финала) [cf:would=unreadable_sets,mr=no_winner_no_score]" });
  const c = buildPmvShadowCalibration(db);
  assert.equal(c.manualProbe.probed, 1);
  assert.equal(c.manualProbe.wouldResolve, 0);
  assert.match(c.note, /ожиданием не лечится/);
});

test("ГЕЙТ ШИРЕ СМЫСЛА: проп, которому победитель матча не нужен, назван разрешимым", () => {
  const db = db0();
  sig(db, "a1", { status: "unresolved", label: "Total Sets: Under 2.5", note: "исход неизвестен (manual/нет детали финала) [cf:would=won,mr=no_winner_no_score]" });
  sig(db, "a2", { status: "unresolved", label: "Set 2 Winner", note: "исход неизвестен (manual/нет детали финала) [cf:would=lost,mr=retired_no_winner]" });
  const c = buildPmvShadowCalibration(db);
  assert.equal(c.manualProbe.wouldResolve, 2);
  assert.equal(c.manualProbe.wouldResolveSafe, 2, "счёт не оспорен ни в одной из двух причин");
  assert.equal(c.manualProbe.wouldResolveDisputed, 0);
  assert.match(c.note, /ГЕЙТ ШИРЕ СМЫСЛА: 2 пропов/);
});

test("спорный счёт НЕ выдаётся за восстановимое: winner_conflict считается отдельно", () => {
  const db = db0();
  sig(db, "a1", { status: "unresolved", note: "исход неизвестен (manual/нет детали финала) [cf:would=won,mr=winner_conflict]" });
  const c = buildPmvShadowCalibration(db);
  assert.equal(c.manualProbe.wouldResolve, 1);
  assert.equal(c.manualProbe.wouldResolveDisputed, 1, "event_winner противоречит счёту — разрешать на нём нельзя");
  assert.equal(c.manualProbe.wouldResolveSafe, 0);
  assert.ok(!/ГЕЙТ ШИРЕ СМЫСЛА/.test(c.note), "спорное не зовётся к разрешению");
});

test("причина не записана — это СВОЙ класс, а не молчаливое слияние с фидовым", () => {
  const db = db0();
  sig(db, "x1", { status: "unresolved", note: null });
  const b = buildPmvShadowCalibration(db).unresolvedBreakdown;
  assert.equal(b[0]!.cls, "other");
  assert.match(b[0]!.reason, /причина не записана/);
});

// Снимок ЗАВЕРШЁННОГО матча без event_winner и с равным счётом по сетам → manual (`no_winner_no_score`).
// Победитель матча неизвестен, но посетовая детализация ЧИТАЕТСЯ — а значит проп, которому победитель не
// нужен, разрешим. Ровно этот случай гейт и глотал.
function finishedSnap(db: ReturnType<typeof db0>, matchId: string, sets: [number, number][], opts: { winner?: string; status?: string } = {}) {
  const raw = JSON.stringify({
    event_winner: opts.winner ?? null,
    scores: sets.map(([a, b], i) => ({ score_set: String(i + 1), score_first: String(a), score_second: String(b) })),
  });
  const setsP1 = sets.filter(([a, b]) => a > b).length, setsP2 = sets.filter(([a, b]) => b > a).length;
  db.prepare(`INSERT INTO tennis_snapshots(id,event_key,provider,batch_at,p1,p2,live,status,sets_p1,sets_p2,pm_match_id,raw,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(R.uid(), `k-${matchId}`, "apitennis", NOW, "Player One", "Player Two", 0, opts.status ?? "Finished", setsP1, setsP2, matchId, raw, NOW);
}

test("ЗОНД НИЧЕГО НЕ РАЗРЕШАЕТ: статус остаётся unresolved, но известно, ЧТО БЫ вышло", () => {
  const db = db0();
  // 1-1 по сетам, победителя нет → manual. Проп «Total Sets: Under 2.5» победителя не требует.
  sig(db, "a1", { status: "unresolved", label: "Total Sets: Under 2.5", note: "исход неизвестен (manual/нет детали финала)" });
  finishedSnap(db, "m-a1", [[6, 4], [3, 6]]);
  const r = probePmvShadowManual(db);
  assert.equal(r.probed, 1);
  const row = db.prepare(`SELECT status, resolve_note n FROM pmv_shadow_signals WHERE id='a1'`).get() as { status: string; n: string };
  assert.equal(row.status, "unresolved", "зонд не разрешает — иначе он влил бы исход в базу Brier мимо решения");
  const cf = parseCf(row.n);
  assert.equal(cf?.mr, "no_winner_no_score");
  assert.ok(cf && cf.would !== "unreadable_sets", "детализация ЧИТАЕТСЯ — гейт остановил не фид, а нас самих");
  assert.match(row.n, /manual\/нет детали финала/, "исходная причина не затёрта");
});

test("зонд идемпотентен: второй прогон не переписывает и не удваивает", () => {
  const db = db0();
  sig(db, "a1", { status: "unresolved", label: "Total Sets: Under 2.5", note: "исход неизвестен (manual/нет детали финала)" });
  finishedSnap(db, "m-a1", [[6, 4], [3, 6]]);
  probePmvShadowManual(db);
  const first = (db.prepare(`SELECT resolve_note n FROM pmv_shadow_signals WHERE id='a1'`).get() as { n: string }).n;
  assert.equal(probePmvShadowManual(db).probed, 0, "уже зондированную строку не трогаем");
  assert.equal((db.prepare(`SELECT resolve_note n FROM pmv_shadow_signals WHERE id='a1'`).get() as { n: string }).n, first);
});

test("не-manual строку зонд не разрешает, но НАЗЫВАЕТ, почему пропустил", () => {
  const db = db0();
  sig(db, "a1", { status: "unresolved", note: "детализация по сетам не читается на финале" });
  finishedSnap(db, "m-a1", [[6, 4], [6, 3]], { winner: "First Player" }); // чистый финал → manual=false
  const r = probePmvShadowManual(db);
  assert.equal(r.probed, 0, "зонд не подменяет собой резолвер");
  assert.equal(r.skipped.not_manual, 1);
  // Первый прогон на проде дал probed=0 при 144 строках и МОЛЧАЛ о причине — «зонд ничего не нашёл» было
  // неотличимо от «зонду нечего было читать». Причина теперь пишется в ту же заметку.
  assert.equal(parseCf((db.prepare(`SELECT resolve_note n FROM pmv_shadow_signals WHERE id='a1'`).get() as { n: string }).n)?.would, "skip_not_manual");
  assert.equal((db.prepare(`SELECT status s FROM pmv_shadow_signals WHERE id='a1'`).get() as { s: string }).s, "unresolved");
});

test("СНИМКА НЕТ ≠ МАТЧ НЕ ДОИГРАН: prune-съеденный источник — свой диагноз", () => {
  const db = db0();
  sig(db, "gone", { status: "unresolved", note: "исход неизвестен (manual/нет детали финала)" });  // снимка нет вовсе
  sig(db, "young", { status: "unresolved", note: "исход неизвестен (manual/нет детали финала)" });
  finishedSnap(db, "m-young", [], { status: "Scheduled" });   // снимок есть, матч ещё НЕ начат
  const r = probePmvShadowManual(db);
  assert.equal(r.skipped.no_snapshot, 1, "источник стёрт — исход существовал, копии нет");
  assert.equal(r.skipped.not_finished, 1, "матч просто не доигран — строка ещё дозреет");
  // Незавершённый матч метку НЕ получает: он временный, и следующий прогон обязан его перечитать.
  assert.equal(parseCf((db.prepare(`SELECT resolve_note n FROM pmv_shadow_signals WHERE id='young'`).get() as { n: string }).n), null);
  assert.equal(parseCf((db.prepare(`SELECT resolve_note n FROM pmv_shadow_signals WHERE id='gone'`).get() as { n: string }).n)?.would, "skip_no_snapshot");
  // Отчёт не записывает объяснённое себе в актив: это НЕ пройденные зондом строки.
  const c = buildPmvShadowCalibration(db);
  assert.equal(c.manualProbe.probed, 0);
  assert.match(c.note, /причины: no_snapshot 1/);
});

// [08.08] НЕНАБЛЮДАЕМЫЙ ФИКС — ЭТО УТВЕРЖДЕНИЕ, А НЕ ПРОВЕРКА. Заморозка улики чинит утечку («144 из 144
// = снимка нет»), но сама по себе невидима: её результат проявится месяцами позже и только отрицательно.
// Счётчик покрытия существует затем, чтобы фикс можно было ОПРОВЕРГНУТЬ числом, а не принять на слово.
test("покрытие заморозки: улика морозится ДО ветвления, значит и у manual-строк тоже", () => {
  const db = db0();
  sig(db, "a1", { status: "pending", label: "Total Sets: Under 2.5" });
  finishedSnap(db, "m-a1", [[6, 4], [3, 6]]);   // 1-1, победителя нет → manual-ветка
  resolvePmvShadowSignals(db, { now: () => NOW });
  const row = db.prepare(`SELECT status, final_raw, final_frozen_at FROM pmv_shadow_signals WHERE id='a1'`).get() as { status: string; final_raw: string | null; final_frozen_at: string | null };
  assert.equal(row.status, "unresolved", "ветка та самая, что раньше не сохраняла ничего");
  assert.ok(row.final_raw, "улика заморожена ИМЕННО на manual-ветке");
  assert.equal(row.final_frozen_at, NOW);
  const fe = buildPmvShadowCalibration(db).frozenEvidence;
  assert.deepEqual({ t: fe.terminal, f: fe.frozen, u: fe.unfrozen }, { t: 1, f: 1, u: 0 });
  assert.match(fe.note, /прун их больше не достанет/);
});

test("ЗОНД ЧИТАЕТ ЗАМОРОЖЕННОЕ, когда живой снимок уже снесён пруном", () => {
  const db = db0();
  sig(db, "a1", { status: "pending", label: "Total Sets: Under 2.5" });
  finishedSnap(db, "m-a1", [[6, 4], [3, 6]]);
  resolvePmvShadowSignals(db, { now: () => NOW });
  db.prepare(`DELETE FROM tennis_snapshots`).run();          // ← прун
  const r = probePmvShadowManual(db);
  assert.equal(r.skipped.no_snapshot, 0, "замороженная копия пережила источник");
  assert.equal(r.probed, 1, "строка ПРОЙДЕНА зондом, а не потеряна");
});

test("дофиксовые строки НЕ выдаются за покрытые: недостача названа числом", () => {
  const db = db0();
  sig(db, "old", { status: "unresolved", note: "исход неизвестен (manual/нет детали финала)" }); // улики нет и не будет
  const fe = buildPmvShadowCalibration(db).frozenEvidence;
  assert.deepEqual({ t: fe.terminal, f: fe.frozen, u: fe.unfrozen }, { t: 1, f: 0, u: 1 });
  assert.match(fe.note, /БЕЗ УЛИКИ 1/);
  assert.ok(!/больше не достанет/.test(fe.note));
});
