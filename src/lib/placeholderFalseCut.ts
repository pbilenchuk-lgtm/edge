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
// ПОЧЕМУ ТРИ ПУТИ, А НЕ ДВА. `reason` два, но `ML_SKEW_MIN_CENTS`, `UNQUOTED_SPREAD_CENTS` и «аска нет
// вовсе» — три РАЗНЫХ утверждения, и ошибиться может любое по отдельности. Отсутствие аска это факт
// котировки (спорить не с чем), а 20¢ и 15¢ — НАШИ числа. Сторож, считающий срезы одной кучей, не сможет
// сказать, какой порог виноват, и «подправим правило» выродится в подгон вслепую.
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

export const PATHS: PlaceholderPath[] = ["no_ask", "wide_spread", "moneyline_contradicts"];

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

export interface FalseCutPathRow {
  path: PlaceholderPath; threshold: string;
  cuts: number; checked: number; falseCuts: number;
  falseCutPct: number | null;   // null = НЕ ПРОВЕРЕНО, а не «ноль ложных»
  sampleLabels: string[];
  note: string;
}
export interface FalseCutReport {
  at: string; maturityMin: number; minMoveCents: number;
  paths: FalseCutPathRow[];
  totals: { cuts: number; checked: number; falseCuts: number; unchecked: number };
  verdict: "clean" | "suspect" | "unmeasured";
  note: string;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** Порог, за который отвечает путь — чтобы подозрение адресовалось ЧИСЛУ, а не «правилу вообще». */
const THRESHOLD_OF: Record<PlaceholderPath, string> = {
  no_ask: "аска нет (факт котировки, нашего числа здесь нет)",
  wide_spread: `UNQUOTED_SPREAD_CENTS = ${UNQUOTED_SPREAD_CENTS}¢`,
  moneyline_contradicts: `ML_SKEW_MIN_CENTS = ${ML_SKEW_MIN_CENTS}¢`,
};

export function buildFalseCutReport(db: Database, nowIso: string): FalseCutReport {
  let rows: { path: string; market_label: string; false_cut: number | null }[] = [];
  try {
    rows = db.prepare(`SELECT path, market_label, false_cut FROM placeholder_cuts`).all() as typeof rows;
  } catch { rows = []; }
  const paths: FalseCutPathRow[] = PATHS.map((p) => {
    const mine = rows.filter((r) => r.path === p);
    const checkedRows = mine.filter((r) => r.false_cut != null);
    const bad = mine.filter((r) => r.false_cut === 1);
    // ДОЛЯ НЕ ПЕЧАТАЕТСЯ БЕЗ ЗНАМЕНАТЕЛЯ. Ноль проверенных даёт null, а не 0% — иначе непроверенный путь
    // выглядел бы чище проверенного, и сторож награждал бы собственную слепоту (тот же дефект, что O15).
    const falseCutPct = checkedRows.length ? pct(bad.length, checkedRows.length) : null;
    return {
      path: p, threshold: THRESHOLD_OF[p],
      cuts: mine.length, checked: checkedRows.length, falseCuts: bad.length, falseCutPct,
      sampleLabels: bad.slice(0, 4).map((r) => r.market_label),
      note: !mine.length ? "срезов по этому пути не было"
        : !checkedRows.length ? `срезано ${mine.length}, проверено 0 — доля ложных НЕ ИЗМЕРЕНА (не «ноль»)`
          : `срезано ${mine.length}, проверено ${checkedRows.length}, ложных ${bad.length} (${falseCutPct}%) · отвечает порог: ${THRESHOLD_OF[p]}`,
    };
  });
  const totals = {
    cuts: rows.length,
    checked: rows.filter((r) => r.false_cut != null).length,
    falseCuts: rows.filter((r) => r.false_cut === 1).length,
    unchecked: rows.filter((r) => r.false_cut == null).length,
  };
  // Вердикт «чисто» имеет право прозвучать ТОЛЬКО когда проверено хоть что-то. Пустой сторож обязан
  // называть себя неизмеренным, а не оправдывать правило.
  const verdict: FalseCutReport["verdict"] = totals.falseCuts ? "suspect"
    : totals.checked >= VERDICT_MIN_CHECKED ? "clean" : "unmeasured";
  const worst = [...paths].filter((p) => p.falseCutPct != null).sort((a, b) => (b.falseCutPct ?? 0) - (a.falseCutPct ?? 0))[0];
  return {
    at: nowIso, maturityMin: MATURITY_MIN, minMoveCents: FALSE_CUT_MIN_MOVE_CENTS,
    paths, totals, verdict,
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
    + r.paths.map((p) => `${p.path} ${p.falseCuts}/${p.checked || "—"} из ${p.cuts}`).join(" · ")
    + ` · не дозрело ${r.totals.unchecked} · ${r.verdict}`;
}
