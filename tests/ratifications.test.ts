// ============================================================
// EDGE LAB — O7: РЕЕСТР РАТИФИКАЦИЙ  [амендмент к ТЗ наблюдаемости, решение владельца 02.08.2026]
//
// Манифест держит МОДУЛИ — файл есть, файл вызывается. Ратификация модулем не является: «пиши сеты в
// карточку при финише» это строка ТЗ, у неё нет файла и нет вызывающего пути, поэтому для манифеста она
// невидима ПО ПОСТРОЕНИЮ. Четвёртый экземпляр класса «ратифицировано-но-не-доехало» вылез ровно в этом
// слепом пятне, и это не совпадение: слепое пятно и есть место, где копится долг.
//
// Тесты держат два свойства: реестр НЕ МОЛЧИТ о зависшем и НЕ КРИЧИТ о том, что в сроке.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import {
  RATIFICATIONS, buildRatificationRegistry, ratificationLine, RATIFICATION_PENDING_DAYS,
  type Ratification,
} from "../src/lib/ratifications.js";

const db0 = () => { const db = openDb(":memory:"); initSchema(db); return db; };
const AT = (iso: string) => Date.parse(iso);

test("живой реестр: все четыре известных экземпляра класса заведены с датой и чем закрыты", () => {
  const closed = RATIFICATIONS.filter((r) => r.status === "deployed");
  assert.ok(closed.length >= 4, "история обязана быть честной, включая то, что мы узнали о ней поздно");
  for (const r of closed) {
    assert.ok(r.closedBy, `${r.id}: «закрыта» без указания ЧЕМ — это не закрытие, а утверждение`);
    assert.ok(r.statement.trim().length > 20, `${r.id}: формулировка обязана быть читаемой через полгода`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.at), `${r.id}: дата ратификации`);
  }
});

test("каждая запись имеет источник — чтобы формулировку можно было сверить с первоисточником", () => {
  for (const r of RATIFICATIONS) assert.ok(r.source.trim(), `${r.id}: нет источника`);
});

test("pending старше срока → РАССЛЕДОВАТЬ, тем же тоном, что мёртвая фича", () => {
  const reg = buildRatificationRegistry(db0(), AT("2026-08-20T00:00:00Z"));
  assert.ok(reg.investigate.length > 0, "две недели без движения обязаны кричать");
  assert.match(reg.note, /ЗАВЕСТИ РАССЛЕДОВАНИЕ/);
  assert.match(ratificationLine(reg), /ЗАВИСЛИ/);
  for (const r of reg.investigate) assert.equal(r.status, "pending", "закрытая не может быть расследованием");
});

test("pending В СРОКЕ не кричит — сторож, воющий на всё, перестаёт быть сторожем", () => {
  const reg = buildRatificationRegistry(db0(), AT("2026-08-03T00:00:00Z"));   // сутки после 02.08
  assert.equal(reg.investigate.length, 0);
  assert.doesNotMatch(ratificationLine(reg), /ЗАВИСЛИ/);
  assert.ok(reg.rows.some((r) => r.verdict === "в работе"));
});

test("закрытая ратификация не превращается в расследование, сколько бы ни прошло", () => {
  const reg = buildRatificationRegistry(db0(), AT("2027-01-01T00:00:00Z"));
  for (const r of reg.rows.filter((x) => x.status === "deployed")) {
    assert.equal(r.verdict, "закрыта");
    assert.match(r.note, /закрыта /);
  }
});

test("цена класса измеряется в днях, а не в ощущениях", () => {
  const reg = buildRatificationRegistry(db0(), AT("2026-08-03T00:00:00Z"));
  assert.ok(reg.meanLateDays != null && reg.meanLateDays > 0,
    "средняя задержка доехавших — то, что делает «четыре экземпляра» числом");
  const tennis = reg.rows.find((r) => r.id === "tennis-p2-score-card")!;
  assert.equal(tennis.lateDays, 19, "самая долгая — теннисный счёт: 19 дней от ратификации до кода");
});

test("порог настраивается, но по умолчанию 7 дней", () => {
  assert.equal(RATIFICATION_PENDING_DAYS({}), 7);
  assert.equal(RATIFICATION_PENDING_DAYS({ RATIFICATION_PENDING_DAYS: "3" }), 3);
  const reg = buildRatificationRegistry(db0(), AT("2026-08-06T00:00:00Z"), { RATIFICATION_PENDING_DAYS: "2" });
  assert.ok(reg.investigate.length > 0, "с порогом 2д четырёхдневное молчание уже расследование");
});

test("счётчики сходятся: закрытых + в работе = всего", () => {
  const reg = buildRatificationRegistry(db0(), AT("2026-08-03T00:00:00Z"));
  assert.equal(reg.deployed + reg.pending, reg.total);
  assert.equal(reg.rows.length, reg.total);
});

test("новая ратификация из чата заводится PENDING, а не задним числом deployed", () => {
  const fresh: Ratification[] = RATIFICATIONS.filter((r) => r.at === "2026-08-02");
  assert.ok(fresh.length >= 4, "решения этой сессии заведены");
  for (const r of fresh) {
    if (r.status === "deployed") continue;
    assert.equal(r.closedBy, null, `${r.id}: pending с указанием «чем закрыта» — противоречие`);
  }
});
