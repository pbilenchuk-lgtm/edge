// ============================================================
// EDGE LAB — СТОРОЖ ЛОЖНЫХ СРЕЗОВ ПЛЕЙСХОЛДЕРА (#121)  [запись + дозревание + отчёт]
//
// ЧЕМ ЗАСЛУЖЕНО. Функция `falseCut` существовала с самого деплоя #121, была покрыта тестом — и НИГДЕ НЕ
// ВЫЗЫВАЛАСЬ. Сторож существовал как определение, а не как прибор: срез нигде не записывался, поздняя цена
// нигде не читалась, отчёта не было. На вопрос «покрывает ли сторож все три пути среза» честный ответ был
// «он не покрывает НИ ОДНОГО», и обнаружить это можно было только грепом по вызовам, потому что тест
// зелёный, а функция правильная.
//
// Это тот же класс, что O15: наличие детали не есть работающий конвейер. Тест на чистую функцию
// доказывает, что она посчитает верно, ЕСЛИ её позовут, и ничего не говорит о том, зовут ли.
//
// ПОЧЕМУ ПУТИ РАЗВЕДЕНЫ. `reason` два, но утверждений несколько, и ошибиться может каждое по отдельности.
// Разведение окупилось на ПЕРВОМ ЖЕ замере: `no_ask` дал 6 ложных из 36 (16.7%) на магистральных тоталах,
// а два других пути не срезали ничего. Будь они слиты в один счётчик, подозрение легло бы на правило
// целиком — и «подправим правило» без адреса выродилось бы в подгон вслепую.
//
// ЗАОДНО ЗАМЕР ОПРОВЕРГ КОММЕНТАРИЙ, СТОЯВШИЙ ЗДЕСЬ. Он утверждал: «отсутствие аска это факт котировки,
// спорить не с чем». Нет: это факт ПОЛНОТЫ НАШЕЙ ВЫГРУЗКИ, а не свойство биржи, и он бывает ложным.
// С 08.08 (ратифицировано) `no_ask` в одиночку не режет — нужна вторая улика.
//
// АВТООТКАТА НЕТ. Ложный срез только НАЗЫВАЕТСЯ. Правило, которое молча себя чинит, неотличимо от правила,
// которое право; кроме того, откат по одному наблюдению — ровно та тихая подстройка порогов, которую
// протокол коррекции запрещает (только улики сторожа + явная ратификация).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import type { Market } from "./types.js";
import { falseCut, FALSE_CUT_MIN_MOVE_CENTS, FLAT_TOL_CENTS, ML_SKEW_MIN_CENTS, UNQUOTED_SPREAD_CENTS,
  type PlaceholderVerdict, type PlaceholderPath } from "./placeholderStructural.js";

/** Сколько срез должен «отстояться», прежде чем его судить. Раньше этого поздняя цена — та же цена. */
export const MATURITY_MIN = 45;

/**
 * Сколько дозревших срезов нужно, чтобы вердикт «чисто» вообще прозвучал.
 *
 * [ПОПРАВКА 08.08] Первый прод-замер дал `checked=1, falseCuts=0` — и отчёт объявил «чисто». Это был
 * вердикт на выборке из ОДНОГО наблюдения: то же самое, за что мы наказываем гипотезы, только со знаком
 * оправдания. Хуже «немого нуля» тем, что выглядит как работающая проверка. Ниже порога сторож остаётся
 * `unmeasured` и печатает, сколько ещё надо, — а вот ОБВИНЕНИЕ порога не имеет: даже один ложный срез это
 * факт, который надо назвать сразу. Асимметрия намеренная: оправдание требует выборки, улика — нет.
 */
export const VERDICT_MIN_CHECKED = 20;

/**
 * Пути, ПРОИЗВОДИМЫЕ правилом сегодня.
 *
 * `no_ask` в этот список НЕ входит — с 08.08 он больше не режет в одиночку. Но в таблице лежат 42 его
 * среза, из которых 6 ложных, и ИМЕННО ОНИ послужили уликой для правки. Выкинуть их из отчёта значило бы
 * стереть основание собственного решения: через месяц «правило поменяли» стало бы неотличимо от «правило
 * всегда было таким». История append-only и здесь — путь помечен УСТАРЕВШИМ, а не удалён.
 */
export const PATHS: PlaceholderPath[] = ["no_book", "no_ask_ml", "wide_spread", "moneyline_contradicts"];
export const LEGACY_PATHS = ["no_ask"] as const;
const ALL_PATHS = [...PATHS, ...LEGACY_PATHS] as readonly string[];

/** Запись среза в момент среза. Цена ЗАМОРАЖИВАЕТСЯ: сторож, пересчитывающий вход из текущего состояния,
 *  судил бы себя по собственному следствию. Первый срез на (матч, рынок) побеждает. */
export function recordPlaceholderCuts(
  db: Database, matchId: string, verdicts: PlaceholderVerdict[], markets: Market[], mlCents: number | null, nowIso: string,
): number {
  if (!verdicts.length) return 0;
  const byLabel = new Map(markets.map((m) => [m.label, m]));
  let n = 0;
  for (const v of verdicts) {
    const m = byLabel.get(v.label);
    if (!m) continue;
    try {
      db.prepare(
        `INSERT INTO placeholder_cuts (id, match_id, market_label, reason, path, cut_cents, ask_cents, spread_cents, ml_cents, cut_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id, market_label) DO NOTHING`,
      ).run(R.uid(), matchId, v.label, v.reason, v.path, Number(m.price),
        m.ask_cents == null ? null : Number(m.ask_cents), m.spread_cents == null ? null : Number(m.spread_cents),
        mlCents, nowIso);
      n++;
    } catch { /* улика не имеет права ломать анализ */ }
  }
  return n;
}

/** Дозревание: читает ТЕКУЩУЮ цену того же рынка и судит срез. Идемпотентно — судится один раз. */
export function checkPlaceholderFalseCuts(db: Database, deps: EngineDeps = {}, maxRows = 400): { checked: number; falseCuts: number } {
  const now = deps.now?.() ?? new Date().toISOString();
  const cutoff = new Date(Date.parse(now) - MATURITY_MIN * 60_000).toISOString();
  let rows: { id: string; match_id: string; market_label: string; cut_cents: number }[] = [];
  try {
    rows = db.prepare(
      `SELECT id, match_id, market_label, cut_cents FROM placeholder_cuts
       WHERE false_cut IS NULL AND cut_at <= ? ORDER BY cut_at LIMIT ?`,
    ).all(cutoff, maxRows) as typeof rows;
  } catch { return { checked: 0, falseCuts: 0 }; }
  let checked = 0, falseCuts = 0;
  const cache = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let byLabel = cache.get(r.match_id);
    if (!byLabel) {
      byLabel = new Map<string, number>();
      try { for (const m of R.latestMarkets(db, r.match_id)) if (m.price != null) byLabel.set(m.label, Number(m.price)); } catch { /* нет доски — не судим */ }
      cache.set(r.match_id, byLabel);
    }
    const later = byLabel.get(r.market_label);
    // Рынок исчез с доски — это НЕ «срез верен». Неизвестное остаётся неизвестным: строка ждёт дальше.
    if (later == null) continue;
    const bad = falseCut(Number(r.cut_cents), later);
    db.prepare(`UPDATE placeholder_cuts SET later_cents=?, later_at=?, false_cut=? WHERE id=?`).run(later, now, bad ? 1 : 0, r.id);
    checked++; if (bad) falseCuts++;
  }
  return { checked, falseCuts };
}

/** Путь в ОТЧЁТЕ шире, чем путь в правиле: отчёт обязан показывать и снятые пути, иначе улика,
 *  по которой правило меняли, исчезает вместе с правилом. */
export type ReportedPath = PlaceholderPath | (typeof LEGACY_PATHS)[number];

export interface FalseCutPathRow {
  path: ReportedPath; threshold: string;
  cuts: number; checked: number; falseCuts: number;
  falseCutPct: number | null;   // null = НЕ ПРОВЕРЕНО, а не «ноль ложных»
  sampleLabels: string[];
  note: string;
}
/**
 * РЕТРО-ПРОВЕРКА ПРАВКИ НА ТОЙ САМОЙ УЛИКЕ, ЧТО ЕЁ ВЫЗВАЛА.
 *
 * Правку «`no_ask` один не режет» нельзя принимать на слово: у неё ДВЕ стороны, и обе измеримы прямо
 * сейчас, потому что `placeholder_cuts` хранит аск, спред и манилайн КАЖДОГО среза.
 *   • `avoidedFalse` — ложные срезы, которых новое правило НЕ сделало бы. Ради этого правку и делали;
 *   • `lostTrue` — ВЕРНЫЕ срезы, которых новое правило тоже не сделает. Это ЦЕНА, и она обязана стоять
 *     рядом с выгодой. Правка, показывающая только спасённое, — реклама, а не замер.
 * Если `lostTrue` сопоставим с `keptTrue`, значит правило выключено целиком, а не сужено: фантом променян
 * на потерю, ровно та подмена, от которой предостерегает обоснование порогов.
 */
export interface FalseCutRetro {
  rows: number; stillCut: number; nowKept: number;
  avoidedFalse: number; lostTrue: number; keptTrue: number; keptFalse: number;
  note: string;
}

export interface FalseCutReport {
  at: string; maturityMin: number; minMoveCents: number;
  paths: FalseCutPathRow[];
  totals: { cuts: number; checked: number; falseCuts: number; unchecked: number; legacyCuts: number; legacyFalseCuts: number };
  verdict: "clean" | "suspect" | "unmeasured";
  /** Что новое правило сделало БЫ с уже записанными срезами. Null, если считать не на чем. */
  retro: FalseCutRetro | null;
  note: string;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** Порог, за который отвечает путь — чтобы подозрение адресовалось ЧИСЛУ, а не «правилу вообще». */
const THRESHOLD_OF: Record<string, string> = {
  // УСТАРЕВШИЙ путь: строки остаются видимыми как основание правки 08.08.
  no_ask: "УСТАРЕЛ 08.08 — резал в одиночку, дал 16.7% ложных; заменён на no_book + no_ask_ml",
  // [08.08] Прежняя формулировка гласила «факт котировки, нашего числа здесь нет». Сторож её опроверг:
  // 6 ложных из 36. Отсутствие аска — утверждение о полноте НАШЕЙ выгрузки, и оно бывает неверным.
  no_book: "книги нет НИ ПО ОДНОМУ полю — единственный случай, где одного молчания книги достаточно (сам под наблюдением)",
  no_ask_ml: `аска нет ПЛЮС перекос манилайна ≥ ${ML_SKEW_MIN_CENTS}¢ — одного отсутствия аска мало (16.7% ложных на замере 08.08)`,
  wide_spread: `UNQUOTED_SPREAD_CENTS = ${UNQUOTED_SPREAD_CENTS}¢`,
  moneyline_contradicts: `ML_SKEW_MIN_CENTS = ${ML_SKEW_MIN_CENTS}¢`,
};

/** Срезало ли БЫ действующее правило эту строку — по ЗАМОРОЖЕННЫМ полям среза, а не по текущим. */
export function wouldCutUnderCurrentRule(r: { ask_cents: number | null; spread_cents: number | null; ml_cents: number | null }): boolean {
  const noAsk = r.ask_cents == null;
  const spread = r.spread_cents == null ? null : Number(r.spread_cents);
  const mlSkewed = r.ml_cents != null && Math.abs(Number(r.ml_cents) - 50) >= ML_SKEW_MIN_CENTS;
  if (noAsk && spread == null) return true;                       // no_book
  if (spread != null && spread >= UNQUOTED_SPREAD_CENTS) return true; // wide_spread
  return mlSkewed;                                                 // no_ask_ml либо moneyline_contradicts
}

export function buildFalseCutReport(db: Database, nowIso: string): FalseCutReport {
  let rows: { path: string; market_label: string; false_cut: number | null }[] = [];
  try {
    rows = db.prepare(`SELECT path, market_label, false_cut FROM placeholder_cuts`).all() as typeof rows;
  } catch { rows = []; }
  // ── РЕТРО: правка проверяется на той улике, что её вызвала. Считаем только по ДОЗРЕВШИМ строкам —
  // у недозревшей неизвестно, был ли срез ложным, и включать её значило бы судить по неизвестному.
  let retro: FalseCutRetro | null = null;
  try {
    const judged = db.prepare(
      `SELECT ask_cents, spread_cents, ml_cents, false_cut FROM placeholder_cuts WHERE false_cut IS NOT NULL`,
    ).all() as { ask_cents: number | null; spread_cents: number | null; ml_cents: number | null; false_cut: number }[];
    if (judged.length) {
      let stillCut = 0, nowKept = 0, avoidedFalse = 0, lostTrue = 0, keptTrue = 0, keptFalse = 0;
      for (const r of judged) {
        const cut = wouldCutUnderCurrentRule(r), wasFalse = r.false_cut === 1;
        if (cut) { stillCut++; wasFalse ? keptFalse++ : keptTrue++; }
        else { nowKept++; wasFalse ? avoidedFalse++ : lostTrue++; }
      }
      const wasFalseTotal = avoidedFalse + keptFalse;
      retro = { rows: judged.length, stillCut, nowKept, avoidedFalse, lostTrue, keptTrue, keptFalse,
        note: `на ${judged.length} дозревших срезах новое правило срезало бы ${stillCut}, пропустило ${nowKept}`
          + ` · ИЗБЕЖАЛО ложных ${avoidedFalse} из ${wasFalseTotal}`
          + ` · ЦЕНА: потеряно верных срезов ${lostTrue} (сохранено ${keptTrue})`
          + (keptTrue === 0 && lostTrue > 0
            ? ` — ПРАВИЛО ВЫКЛЮЧЕНО ЦЕЛИКОМ, а не сужено: ни один верный срез не выжил. Фантом променян на потерю.`
            : lostTrue > keptTrue ? ` — сужение вышло АГРЕССИВНЫМ: верных срезов потеряно больше, чем сохранено.` : ``) };
    }
  } catch { retro = null; }
  const paths: FalseCutPathRow[] = ALL_PATHS.map((p) => {
    const mine = rows.filter((r) => r.path === p);
    const checkedRows = mine.filter((r) => r.false_cut != null);
    const bad = mine.filter((r) => r.false_cut === 1);
    // ДОЛЯ НЕ ПЕЧАТАЕТСЯ БЕЗ ЗНАМЕНАТЕЛЯ. Ноль проверенных даёт null, а не 0% — иначе непроверенный путь
    // выглядел бы чище проверенного, и сторож награждал бы собственную слепоту (тот же дефект, что O15).
    const falseCutPct = checkedRows.length ? pct(bad.length, checkedRows.length) : null;
    return {
      path: p as ReportedPath, threshold: THRESHOLD_OF[p] ?? "путь УСТАРЕЛ — правилом больше не производится",
      cuts: mine.length, checked: checkedRows.length, falseCuts: bad.length, falseCutPct,
      sampleLabels: bad.slice(0, 4).map((r) => r.market_label),
      note: !mine.length ? "срезов по этому пути не было"
        : !checkedRows.length ? `срезано ${mine.length}, проверено 0 — доля ложных НЕ ИЗМЕРЕНА (не «ноль»)`
          : `срезано ${mine.length}, проверено ${checkedRows.length}, ложных ${bad.length} (${falseCutPct}%) · отвечает порог: ${THRESHOLD_OF[p]}`,
    };
  });
  // ВЕРДИКТ СЧИТАЕТСЯ ПО ДЕЙСТВУЮЩИМ ПУТЯМ. Устаревший `no_ask` держал бы `suspect` вечно — правило,
  // которого уже нет, обвиняло бы правило, которое есть, и сторож перестал бы отвечать на свой вопрос.
  // Но и молчать о нём нельзя: его строки печатаются в `paths` и суммируются в `legacy`.
  const live = rows.filter((r) => (PATHS as readonly string[]).includes(r.path));
  const totals = {
    cuts: live.length,
    checked: live.filter((r) => r.false_cut != null).length,
    falseCuts: live.filter((r) => r.false_cut === 1).length,
    unchecked: live.filter((r) => r.false_cut == null).length,
    legacyCuts: rows.length - live.length,
    legacyFalseCuts: rows.filter((r) => !(PATHS as readonly string[]).includes(r.path) && r.false_cut === 1).length,
  };
  // Вердикт «чисто» имеет право прозвучать ТОЛЬКО когда проверено хоть что-то. Пустой сторож обязан
  // называть себя неизмеренным, а не оправдывать правило.
  const verdict: FalseCutReport["verdict"] = totals.falseCuts ? "suspect"
    : totals.checked >= VERDICT_MIN_CHECKED ? "clean" : "unmeasured";
  const worst = [...paths].filter((p) => p.falseCutPct != null).sort((a, b) => (b.falseCutPct ?? 0) - (a.falseCutPct ?? 0))[0];
  return {
    at: nowIso, maturityMin: MATURITY_MIN, minMoveCents: FALSE_CUT_MIN_MOVE_CENTS,
    paths, totals, verdict, retro,
    note: verdict === "unmeasured"
      ? `НЕ ИЗМЕРЕНО: срезов ${totals.cuts}, дозрело ${totals.checked} из нужных ${VERDICT_MIN_CHECKED}`
        + ` — сторож пока ничего не утверждает о правиле #121 (ложных среди дозревших пока нет, но это НЕ вердикт)`
      : verdict === "clean"
        ? `чисто: ${totals.checked} срезов дозрело, ни один рынок не ожил (порог оживления ${FALSE_CUT_MIN_MOVE_CENTS}¢ от 50¢, допуск плоскости ${FLAT_TOL_CENTS}¢)`
        : `ЛОЖНЫЕ СРЕЗЫ ЕСТЬ: ${totals.falseCuts} из ${totals.checked} проверенных — хуже всех «${worst?.path}» (${worst?.falseCutPct}%), отвечает ${worst?.threshold}.`
          + ` Автооткат НЕ делается: изменение порога идёт только через явную ратификацию.`,
  };
}

/** Строка еженедельника: три пути, каждый своим числом; непроверенное печатается словом, а не нулём. */
export function falseCutLine(r: FalseCutReport): string {
  return `сторож ложных срезов #121: `
    + r.paths.filter((p) => p.cuts > 0 || !LEGACY.has(p.path)).map((p) => `${p.path} ${p.falseCuts}/${p.checked || "—"} из ${p.cuts}`).join(" · ")
    + ` · не дозрело ${r.totals.unchecked} · ${r.verdict}`
    // Устаревший путь печатается ОТДЕЛЬНО и всегда, когда его строки есть: он основание правки 08.08,
    // и молчание о нём сделало бы «правило поменяли» неотличимым от «правило всегда было таким».
    + (r.totals.legacyCuts ? ` · [устар. no_ask: ${r.totals.legacyFalseCuts} ложных из ${r.totals.legacyCuts} — улика, по которой правило правили]` : "")
    // Ретро печатается ВСЕГДА, когда есть на чём считать: выгода правки без её цены — реклама, не замер.
    + (r.retro ? ` · ретро: избежали ${r.retro.avoidedFalse} ложных ценой ${r.retro.lostTrue} верных` : "");
}
const LEGACY = new Set<string>(LEGACY_PATHS);
