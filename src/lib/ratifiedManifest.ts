// ============================================================
// EDGE LAB — МАНИФЕСТ РАТИФИЦИРОВАННЫХ ПРЕДОХРАНИТЕЛЕЙ  [решение владельца 02.08.2026]
//
// ПОЧЕМУ ОТ СПИСКА, А НЕ ОТ КОМПИЛЯТОРА. Мой откат прода 30.07 удалил 28 файлов — среди них инвариант
// «матч не может быть сыгран до кикоффа», настоящий расчёт CLV, охрану гонки счёт↔события, комплемент для
// сеттла, счётчик возвратов, перемаркировку кусков и — по иронии — сам ratifiedWatch, механизм для поимки
// мёртвых фич. Сборка при этом осталась ЗЕЛЁНОЙ, тесты прошли, прод поднялся. Удаления были
// самосогласованными: модуль вырезался вместе со всеми вызовами, и компилятору не на что было пожаловаться.
//
// Отсюда правило: компилятор проверяет СВЯЗНОСТЬ того, что есть, и не может проверить ОТСУТСТВИЕ того, что
// должно быть. Единственная защита от такого класса — внешний список обязательного. Счётчики ratifiedWatch
// ловят мёртвую фичу за три дня наблюдений; манифест ловит её за три секунды сборки.
//
// ЧТО ЗНАЧИТ «ЖИВОЙ». Наличия файла недостаточно: модуль, который никто не зовёт, мёртв ровно так же, как
// удалённый, — только выглядит живым. Поэтому каждая запись несёт ИМЯ и ФАЙЛЫ, которые обязаны его звать.
// Отсутствует файл или пропал вызывающий — сборка красная, с именем ратификации в тексте ошибки.
//
// ЧЕГО МАНИФЕСТ НЕ ДЕЛАЕТ. Он не проверяет, что модуль РАБОТАЕТ — это дело тестов, и они есть у каждой
// записи. Он проверяет ровно то, чего не проверяет никто другой: что предохранитель всё ещё подключён.
// Список ведётся руками — это осознанно: попадание в него есть решение владельца, а не следствие того,
// что файл однажды написали.
// ============================================================

export interface RatifiedEntry {
  /** Путь модуля от корня репозитория. */
  module: string;
  /** Короткое имя ратификации — оно попадёт в текст ошибки сборки. */
  ratification: string;
  /** Что именно защищает; одна строка, читаемая тем, кто увидит красную сборку через полгода. */
  guards: string;
  /** Файлы, обязанные импортировать модуль. Пусто быть не может: модуль без вызова мёртв. */
  callers: string[];
  /** Именной кейс, на котором держится регрессия — чтобы «что тут вообще проверяется» не пришлось искать. */
  namedCase?: string;
}

export const RATIFIED_MANIFEST: RatifiedEntry[] = [
  {
    module: "src/lib/futureFinished.ts",
    ratification: "F2 — матч не может быть сыгран до собственного кикоффа",
    guards: "химера чужой привязки: `finished` при кикоффе в будущем. Такой матч не входит в живую фазу и не торгуется ВООБЩЕ — каждая строка это пропущенный слейт целиком",
    callers: ["src/app/api/engine/route.ts", "scripts/future-finished.ts"],
    namedCase: "Sarpsborg 08 FF–Viking FK и NC Courage–Washington Spirit, кикофф 08.08 (02.08.2026)",
  },
  {
    module: "src/lib/clv.ts",
    ratification: "пункт 6 — CLV меряется по линии закрытия, а не по своей цене выхода",
    guards: "нога вердикта остаётся НЕЗАВИСИМОЙ от P&L: `closing_price` при досрочном выходе — наша же цена продажи, при резолюции — исход",
    callers: ["src/lib/overreactionGate.ts", "src/lib/profileAnalytics.ts", "src/lib/pmvOriginCut.ts"],
  },
  {
    module: "src/lib/scoreRace.ts",
    ratification: "G1/G2 — снимок не имеет права отставать от собственной ленты событий",
    guards: "переоценка НЕ вызывается на счёте, который старше гола, её запустившего: обоснованное неверное решение хуже позднего",
    callers: ["src/lib/lifecycle.ts"],
    namedCase: "Brann–Vålerenga: гол на 41', переоценка на 42' со счётом 0:1, выход −$263",
  },
  {
    module: "src/lib/complementMarket.ts",
    ratification: "batch-11 — комплемент ищется в матче, когда указатель не сохранён",
    guards: "сеттл по резолюции не сдаётся в void только потому, что `markets.token_second` пуст (37% строк)",
    callers: ["src/lib/pmResolution.ts", "src/lib/complementBackfill.ts"],
  },
  {
    module: "src/lib/complementBackfill.ts",
    ratification: "batch-11, условия 4 и 5 — адресный бэкфилл + ретро-аудит ложных возвратов",
    guards: "позиции с живыми деньгами получают указатель ПЕРВЫМИ; прошлые возвраты, оказавшиеся выигрышами и проигрышами, пересчитываются",
    callers: ["src/lib/lifecycle.ts", "scripts/complement-audit.ts"],
    namedCase: "225 ставок как «возврат» при разрешившихся рынках — книга польщена на ~$896",
  },
  {
    module: "src/lib/voidWatch.ts",
    ratification: "batch-11, follow-up #1 — доля возвратов есть сенсор класса «книга разошлась с реальностью»",
    guards: "молчание невозможно: возврат книжит P&L=0 и никогда не выглядит выбросом — считать его обязан отдельный счётчик, с разделением по ПРИЧИНЕ",
    callers: ["src/app/api/health/route.ts", "scripts/void-watch.ts"],
  },
  {
    module: "src/lib/pieceRelabel.ts",
    ratification: "W1 / Z2(а)(б) — метка куска есть исход РЫНКА, а судьба куска отдельным полем",
    guards: "торговый P&L не маскируется под точность прогноза: win-rate/Brier/калибровка едят `result`, а он ставился по знаку P&L куска",
    callers: ["src/lib/lifecycle.ts"],
    namedCase: "Cusco-класс: один рынок «разрешился в обе стороны» — lost@11.7¢ и won@54.8¢",
  },
  {
    module: "src/lib/ratifiedWatch.ts",
    ratification: "охранник ратифицированных фич — счётчик срабатываний за срок",
    guards: "фича, которая ни разу не сработала за отведённый срок, объявляет себя мёртвой сама, вместо того чтобы числиться работающей",
    callers: ["scripts/guard-check.ts"],
  },
  {
    module: "src/lib/staleProposalShadow.ts",
    ratification: "W5 — отказ по дрейфу цены замораживается would-be записью",
    guards: "«мы бы вошли, но цена ушла» — это ДАННЫЕ, а не спор: когорта резолвится по рынку и имеет порог зрелости",
    callers: ["src/lib/lifecycle.ts"],
  },
  {
    module: "src/lib/riskPresetMigration.ts",
    ratification: "решение владельца 02.08 — пресеты профилей доезжают до базы",
    guards: "ратифицированное изменение порогов входа не остаётся в коде на неделю, пока прод торгует по старым",
    callers: ["src/lib/db.ts"],
    namedCase: "conservative-1.0 в проде против conservative-2.0 в коде: 18 отказов у бара 0.55, снятого 25.07",
  },
  {
    module: "src/lib/profileDrift.ts",
    ratification: "класс «ратифицировано, но не доехало» для КОНФИГОВ",
    guards: "расхождение код↔база по пресетам называется поимённо и навсегда — молчаливых правок в коде, невидимых базе, больше не существует",
    callers: ["src/app/api/profiles/route.ts", "src/lib/riskPresetMigration.ts"],
  },
];

export interface ManifestViolation {
  module: string;
  ratification: string;
  kind: "missing_module" | "missing_caller" | "not_called";
  detail: string;
}

/**
 * Проверить манифест против дерева исходников.
 *
 * `exists` и `readText` инжектируются, чтобы проверка была чистой функцией и покрывалась тестом без
 * обращения к диску: тест обязан уметь смоделировать «файл удалён» и «вызов вырезан», не удаляя файлов.
 */
export function checkRatifiedManifest(
  io: { exists: (path: string) => boolean; readText: (path: string) => string },
  manifest: RatifiedEntry[] = RATIFIED_MANIFEST,
): ManifestViolation[] {
  const out: ManifestViolation[] = [];
  for (const e of manifest) {
    if (!io.exists(e.module)) {
      out.push({ module: e.module, ratification: e.ratification, kind: "missing_module",
        detail: `модуль отсутствует в дереве. Ратификация «${e.ratification}» защищает: ${e.guards}` });
      continue;                                    // без файла спрашивать про вызовы бессмысленно
    }
    // Имя модуля в импорте: "./scoreRace.js" / "@/lib/scoreRace" / "../src/lib/scoreRace.js".
    const base = e.module.replace(/^.*\//, "").replace(/\.ts$/, "");
    const alive: string[] = [], dead: string[] = [];
    for (const c of e.callers) {
      if (!io.exists(c)) { dead.push(`${c} (файла нет)`); continue; }
      const src = io.readText(c);
      const called = new RegExp(`["'\`][^"'\`]*(?:/|^)${base}(?:\\.js)?["'\`]`).test(src);
      if (called) alive.push(c); else dead.push(`${c} (импорта нет)`);
    }
    if (alive.length === 0) {
      out.push({ module: e.module, ratification: e.ratification, kind: "not_called",
        detail: `файл на месте, но его НИКТО не зовёт — мёртв так же, как удалённый. Ожидались вызовы из: ${e.callers.join(", ")}. Ратификация защищает: ${e.guards}` });
    } else if (dead.length) {
      out.push({ module: e.module, ratification: e.ratification, kind: "missing_caller",
        detail: `часть вызывающих путей пропала: ${dead.join(", ")} (живые: ${alive.join(", ")})` });
    }
  }
  return out;
}

/** Человеческий отчёт для красной сборки. Пустая строка = нарушений нет. */
export function manifestReport(violations: ManifestViolation[]): string {
  if (!violations.length) return "";
  const lines = [`МАНИФЕСТ РАТИФИЦИРОВАННЫХ ПРЕДОХРАНИТЕЛЕЙ: нарушений ${violations.length}`, ""];
  for (const v of violations) lines.push(`✗ ${v.module}\n    ратификация: ${v.ratification}\n    ${v.detail}`);
  lines.push("", "Это не стилистическая придирка: каждая строка выше — предохранитель, который был",
    "ратифицирован владельцем и сейчас не подключён. Восстановить или снять с манифеста ЯВНО.");
  return lines.join("\n");
}
