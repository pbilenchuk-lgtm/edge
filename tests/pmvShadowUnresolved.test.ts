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
import { buildPmvShadowCalibration } from "../src/lib/tennisPmvShadow.js";

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
  assert.match(c.note, /ВОССТАНОВИМЫХ \(резолвер не осилил ярлык\) 3/);
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

test("все неразрешённые — из фида: сказано ПРЯМО, что ожиданием не лечится", () => {
  const db = db0();
  sig(db, "a1", { status: "unresolved", note: "детализация по сетам не читается на финале" });
  assert.match(buildPmvShadowCalibration(db).note, /ожиданием не лечится/);
});

test("причина не записана — это СВОЙ класс, а не молчаливое слияние с фидовым", () => {
  const db = db0();
  sig(db, "x1", { status: "unresolved", note: null });
  const b = buildPmvShadowCalibration(db).unresolvedBreakdown;
  assert.equal(b[0]!.cls, "other");
  assert.match(b[0]!.reason, /причина не записана/);
});
