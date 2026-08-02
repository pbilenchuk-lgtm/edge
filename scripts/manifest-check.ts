// ============================================================
// EDGE LAB — ПРОВЕРКА МАНИФЕСТА РАТИФИЦИРОВАННЫХ ПРЕДОХРАНИТЕЛЕЙ  [красит сборку]
//
// Запускается перед сборкой и в postdeploy. Ненулевой код выхода = красная сборка.
//
//   npm run manifest:check
//
// Смысл — в том, чего не умеет компилятор: он проверяет связность НАПИСАННОГО и слеп к отсутствию того,
// что должно быть. Мой откат 30.07 удалил 28 файлов вместе со всеми их вызовами; дерево осталось
// самосогласованным, сборка зелёной, тесты зелёными. Проверка от СПИСКА ОБЯЗАТЕЛЬНОГО — единственный
// способ поймать такой класс до прода, а не через неделю по косвенным признакам.
// ============================================================
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { RATIFIED_MANIFEST, checkRatifiedManifest, manifestReport } from "../src/lib/ratifiedManifest.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abs = (p: string) => join(root, p);

const violations = checkRatifiedManifest({
  exists: (p) => existsSync(abs(p)),
  readText: (p) => readFileSync(abs(p), "utf8"),
});

if (!violations.length) {
  console.log(`манифест: ${RATIFIED_MANIFEST.length} ратифицированных предохранителей на месте и подключены`);
  process.exit(0);
}
console.error(manifestReport(violations));
process.exit(1);
