// ============================================================
// EDGE LAB — 23 УДАЛЁННЫХ ФАЙЛА НЕ СЛОМАЛИ СБОРКУ, И ЭТО САМОЕ ВАЖНОЕ, ЧТО О НИХ ИЗВЕСТНО
//
// Откат 30.07 (24f1dc7) вырезал 28 файлов ВМЕСТЕ с их вызовами. Дерево осталось самосогласованным:
// tsc зелёный, тесты зелёные, прод поднялся. Неделю в проде не было инварианта «матч не может быть сыгран
// до кикоффа», настоящего CLV, охраны гонки счёт↔события, комплемента для сеттла, счётчика возвратов,
// перемаркировки кусков — и, по иронии, самого ratifiedWatch, механизма для поимки мёртвых фич.
//
// Компилятор проверяет СВЯЗНОСТЬ написанного и структурно не способен проверить ОТСУТСТВИЕ должного.
// Поэтому проверка идёт от списка обязательного. Эти тесты держат два её свойства, и оба существенны:
//   • удалённый модуль ловится;
//   • ОСТАВЛЕННЫЙ, но никем не вызываемый — ловится тоже. Файл без вызова мёртв ровно так же, просто
//     выглядит живым, и именно этот вариант список без проверки вызовов пропустил бы.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { RATIFIED_MANIFEST, checkRatifiedManifest, manifestReport, type RatifiedEntry } from "../src/lib/ratifiedManifest.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realIo = { exists: (p: string) => existsSync(join(root, p)), readText: (p: string) => readFileSync(join(root, p), "utf8") };

/** Виртуальное дерево: путь → содержимое. Отсутствие ключа = файла нет. */
const io = (files: Record<string, string>) => ({
  exists: (p: string) => p in files,
  readText: (p: string) => files[p] ?? "",
});

const ENTRY: RatifiedEntry = {
  module: "src/lib/scoreRace.ts",
  ratification: "G1/G2 — снимок не имеет права отставать от своей ленты событий",
  guards: "переоценка не вызывается на счёте старше гола, её запустившего",
  callers: ["src/lib/lifecycle.ts"],
};

test("ЖИВОЙ ПРОД: все записи манифеста на месте и подключены", () => {
  const v = checkRatifiedManifest(realIo);
  assert.deepEqual(v, [], manifestReport(v));
  assert.ok(RATIFIED_MANIFEST.length >= 10, "манифест не должен усохнуть незаметно");
});

test("удалённый модуль красит сборку — ровно тот случай, что прошёл 30.07 незамеченным", () => {
  const v = checkRatifiedManifest(io({ "src/lib/lifecycle.ts": `import { scoreConsistency } from "./scoreRace.js";` }), [ENTRY]);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "missing_module");
  assert.match(v[0].detail, /Ратификация «G1\/G2/);
});

test("файл на месте, но НИКТО не зовёт — тоже красит: мёртв так же, как удалённый", () => {
  const v = checkRatifiedManifest(io({
    "src/lib/scoreRace.ts": "export function scoreConsistency() {}",
    "src/lib/lifecycle.ts": "// вызов вырезан, файл остался лежать",
  }), [ENTRY]);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "not_called");
  assert.match(v[0].detail, /НИКТО не зовёт/);
});

test("удалён сам вызывающий файл — это тоже пропавший путь, а не «ну и ладно»", () => {
  const v = checkRatifiedManifest(io({ "src/lib/scoreRace.ts": "export {}" }), [ENTRY]);
  assert.equal(v[0].kind, "not_called");
  assert.match(v[0].detail, /lifecycle/);
});

test("часть путей жива, часть пропала — сообщается как частичная потеря, а не молча", () => {
  const two: RatifiedEntry = { ...ENTRY, callers: ["a.ts", "b.ts"] };
  const v = checkRatifiedManifest(io({
    "src/lib/scoreRace.ts": "export {}",
    "a.ts": `import x from "./scoreRace.js";`,
    "b.ts": "// импорт вырезан",
  }), [two]);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "missing_caller");
  assert.match(v[0].detail, /b\.ts \(импорта нет\)/);
  assert.match(v[0].detail, /живые: a\.ts/);
});

test("формы импорта распознаются все три — иначе проверка врала бы на живом коде", () => {
  for (const imp of [
    `import { s } from "./scoreRace.js";`,
    `const m = await import("@/lib/scoreRace");`,
    `import { s } from "../src/lib/scoreRace.js";`,
  ]) {
    const v = checkRatifiedManifest(io({ "src/lib/scoreRace.ts": "export {}", "src/lib/lifecycle.ts": imp }), [ENTRY]);
    assert.deepEqual(v, [], imp);
  }
});

test("похожее имя не засчитывается за вызов — «scoreRaceOld» не оживляет «scoreRace»", () => {
  const v = checkRatifiedManifest(io({
    "src/lib/scoreRace.ts": "export {}",
    "src/lib/lifecycle.ts": `import { x } from "./scoreRaceOld.js";`,
  }), [ENTRY]);
  assert.equal(v[0].kind, "not_called");
});

test("отчёт называет ратификацию и то, ЧТО она защищала — красную сборку читают через полгода", () => {
  const rep = manifestReport(checkRatifiedManifest(io({}), [ENTRY]));
  assert.match(rep, /G1\/G2/);
  assert.match(rep, /переоценка не вызывается на счёте старше гола/);
  assert.match(rep, /Восстановить или снять с манифеста ЯВНО/);
  assert.equal(manifestReport([]), "", "нет нарушений — нет шума");
});

test("каждая запись манифеста несёт вызывающие пути: запись без них не проверяет ничего", () => {
  for (const e of RATIFIED_MANIFEST) {
    assert.ok(e.callers.length > 0, `${e.module}: нет вызывающих путей`);
    assert.ok(e.ratification.trim() && e.guards.trim(), `${e.module}: ратификация/защита не описаны`);
  }
});
