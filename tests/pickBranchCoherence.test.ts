import test from "node:test";
import assert from "node:assert/strict";
import { checkPickBranches, namedSideOf, BRANCH_MIN_RESOLVED } from "../src/lib/pickBranchCoherence.js";
import { complementLabel } from "../src/lib/complementMarket.js";
import { findSideConflicts, blockedByCoherence, blocksLabel } from "../src/lib/sideCoherence.js";

// ИМЕННОЙ КЕЙС N1(б) — дословный пик из лога UMF Breiðablik — Aqtöbe FK, 04.08 (стадия post_lineup).
// `label` и `marketId` согласованы между собой и оба указывают на Over 3.5; сломана СТОРОНА, и
// единственная машинная улика об этом — список веток самого пика.
const BREIDABLIK_OVER_BRANCHES = [
  "fav_clean", "draw_0_0", "dog_clean", "draw_scoring[1:1]",
  "часть fav_concedes[2:1]", "часть dog_concedes[1:2]",
];

test("N1(б) регрессия Breiðablik: «Over 3.5» со списком веток от Under — contradicts", () => {
  const c = checkPickBranches("Over 3.5", BREIDABLIK_OVER_BRANCHES);
  assert.equal(c.verdict, "contradicts");
  assert.equal(c.namedSide, "over");
  assert.equal(c.agree.length, 0);
  // Разрешились ровно те, что допустимы: draw_0_0 (ровно 0) + три с явными счетами (2, 3, 3).
  assert.equal(c.against.length, 4);
  assert.deepEqual(c.against.map((e) => e.branch).sort(), ["dog_concedes", "draw_0_0", "draw_scoring", "fav_concedes"]);
  // fav_clean/dog_clean НЕ обвиняют: их минимум 1 гол, верхней границы нет — 5:0 тоже fav_clean.
  assert.ok(!c.against.some((e) => e.branch === "fav_clean" || e.branch === "dog_clean"));
});

test("тот же список веток на «Under 3.5» — это ok, а не зеркальное обвинение", () => {
  const c = checkPickBranches("Under 3.5", BREIDABLIK_OVER_BRANCHES);
  assert.equal(c.verdict, "ok");
  assert.equal(c.against.length, 0);
  assert.equal(c.agree.length, 4);
});

test("законный Over 3.5 на concedes-ветках БЕЗ скобок не блокируется по score_cluster", () => {
  // Минимум fav_concedes/dog_concedes = 3 гола, что НИЖЕ линии 3.5 → доказать сторону нельзя,
  // и молчание здесь обязательно: обвинить по «тяжёлым счетам» ветки значило бы убить законный пик.
  const c = checkPickBranches("Over 3.5", ["fav_concedes", "dog_concedes", "draw_scoring"]);
  assert.equal(c.verdict, "unknown");
  assert.equal(c.resolved, 0);
});

test("минимум ветки доказывает ТОЛЬКО «выше линии»: Under 2.5 на concedes — contradicts", () => {
  // fav_concedes ≥ 3 гола по построению (победа при забивших обеих) — это строго выше 2.5.
  const c = checkPickBranches("Under 2.5", ["fav_concedes", "dog_concedes"]);
  assert.equal(c.verdict, "contradicts");
  assert.equal(c.against.length, 2);
  assert.ok(c.against.every((e) => e.via === "минимум ветки"));
});

test("одна разрешимая ветка не обвиняет — порог улик", () => {
  const c = checkPickBranches("Over 3.5", ["draw_0_0"]);
  assert.equal(c.verdict, "unknown");
  assert.equal(c.resolved, 1);
  assert.ok(c.resolved < BRANCH_MIN_RESOLVED);
});

test("смешанная картина не обвиняет — законный пик живёт лишь в части веток", () => {
  const c = checkPickBranches("Over 2.5", ["draw_0_0", "fav_concedes", "dog_concedes"]);
  assert.equal(c.verdict, "ok");
  assert.equal(c.agree.length, 2);   // оба concedes ≥3 → over
  assert.equal(c.against.length, 1); // draw_0_0 = 0 голов → under
});

test("пустой/отсутствующий список веток — улик нет, обвинения нет", () => {
  assert.equal(checkPickBranches("Over 3.5", []).verdict, "unknown");
  assert.equal(checkPickBranches("Over 3.5", null).verdict, "unknown");
  assert.equal(checkPickBranches("Over 3.5", undefined).verdict, "unknown");
});

test("BTTS: ветка однородна по BTTS по построению — улика точная для всех шести", () => {
  const bad = checkPickBranches("Both Teams to Score — Yes", ["fav_clean", "draw_0_0", "dog_clean"]);
  assert.equal(bad.verdict, "contradicts");
  assert.equal(bad.against.length, 3);
  const good = checkPickBranches("Both Teams to Score — Yes", ["fav_concedes", "draw_scoring"]);
  assert.equal(good.verdict, "ok");
});

test("граница покрытия названа честно: 1X2/форы/командные тоталы → unknown", () => {
  assert.equal(namedSideOf("FC Drita"), null);
  assert.equal(namedSideOf("Larne FC (-1.5)"), null);
  assert.equal(namedSideOf("Home Over 1.5"), null);          // командный тотал — дерево про финальный счёт
  assert.equal(namedSideOf("1st Half Over 0.5"), null);      // таймовый тотал — тоже вне дерева
  assert.equal(checkPickBranches("FC Drita", ["fav_clean", "fav_concedes"]).verdict, "unknown");
});

test("нераспознанная нотация веток молчит, а не обвиняет", () => {
  const c = checkPickBranches("Over 3.5", ["какая-то своя ветка", "ещё одна"]);
  assert.equal(c.verdict, "unknown");
  assert.equal(c.resolved, 0);
});

test("русская нотация тотала читается наравне с английской", () => {
  assert.deepEqual(namedSideOf("Больше 2.5"), { family: "total", side: "over", line: 2.5 });
  assert.deepEqual(namedSideOf("ТМ 3.5"), { family: "total", side: "under", line: 3.5 });
});

// ---- N1(б): дыра в парном инварианте, закрытая complementLabel ----

test("complementLabel инвертирует сторону по СЛОВУ и переживает филлер", () => {
  assert.equal(complementLabel("Under 3.5 goals"), "Over 3.5 goals");
  assert.equal(complementLabel("Over 2.5"), "Under 2.5");
  assert.equal(complementLabel("Both Teams to Score — Yes"), "Both Teams to Score — No");
  assert.equal(complementLabel("Larne FC (-1.5)"), null);       // стороны нет — честный null
  assert.equal(complementLabel("Torino"), null);                 // «no» внутри слова не сторона
});

test("парный инвариант больше не защищается филлером (регрессия к дыре complementKey)", () => {
  // Прежняя реализация сворачивала «Under 3.5 goals» → "under35goals", end-anchored свап не подходил,
  // ключ был null → конфликт НЕ находился, и обе стороны входили. При этом исполнение эти две подписи
  // считает ОДНИМ рынком, то есть дыра была ровно в один филлер.
  const conflicts = findSideConflicts([
    { label: "Under 3.5 goals", prob: 0.64 },
    { label: "Over 3.5", prob: 0.64 },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(Math.round(conflicts[0].sum * 100), 128);
});

test("blocksLabel сверяет подпись рынка с блок-листом пиков через тот же авторитет, что исполнение", () => {
  const { blocked } = blockedByCoherence([
    { label: "Under 3.5", prob: 0.64 },
    { label: "Over 3.5", prob: 0.64 },
  ]);
  assert.ok(blocksLabel(blocked, "Under 3.5"));
  assert.ok(blocksLabel(blocked, "Over 3.5 goals"));   // перифраз рынка — тот же рынок
  assert.ok(!blocksLabel(blocked, "Over 2.5"));        // другая линия — не наш блок
});

test("когерентная пара (сумма ≤ 100% + допуск) конфликтом не считается", () => {
  assert.equal(findSideConflicts([{ label: "Under 3.5", prob: 0.64 }, { label: "Over 3.5", prob: 0.36 }]).length, 0);
});
