// ============================================================
// EDGE LAB — ПОИСК РАЗДЕЛЯЮЩЕГО ПРИЗНАКА ДЛЯ ЛОЖНЫХ СРЕЗОВ #121  [read-only]
//
// ЧЕМ ЗАСЛУЖЕНО. Доля ложных срезов ползёт вверх по мере накопления: 16.7% (36) → 17.2% (58) → 27% (74).
// Две правки порога уже выдвинуты и откачены — обе опирались на ОДИН признак (перекос манилайна), и замер
// показал, что он не разделяет: брак одинаков по обе его стороны, а корроборированные срезы вышли даже
// хуже (8 ложных из 12 = 66.7%). Третья правка вслепую повторила бы судьбу первых двух.
//
// Этот модуль НИЧЕГО НЕ МЕНЯЕТ и не предлагает порогов. Он берёт УЖЕ ЗАПИСАННЫЕ строки срезов и
// раскладывает их по признакам, которые можно получить БЕЗ новых колонок: семья пропа (из ярлыка),
// величина перекоса манилайна (не порог, а корзины), часы до старта (join к матчу) и вид спорта.
// Вопрос один: есть ли признак, по которому доля ложных РАЗЛИЧАЕТСЯ, — и если нет, честно сказать это.
//
// ═══ ТРИ ЗАЩИТЫ ОТ САМООБМАНА, БЕЗ КОТОРЫХ ЭТОТ ОТЧЁТ ВРЕДНЕЕ ОТСУТСТВИЯ ═══
//
// 1. КОРЗИНА БЕЗ РАЗМЕРА НЕ ПОЛУЧАЕТ ДОЛИ. Ниже MIN_BUCKET_N печатается «не измерено», а не процент:
//    2 ложных из 3 это 66.7%, и такое число обманывает сильнее, чем пустая клетка.
// 2. РАЗДЕЛЕНИЕ ОБЪЯВЛЯЕТСЯ ТОЛЬКО МЕЖДУ ДВУМЯ ДОСТАТОЧНЫМИ КОРЗИНАМИ. Сравнить измеренную корзину с
//    неизмеренной и назвать это разбросом — тот же дефект, что вердикт по ветке, которая не исполнялась.
// 3. МНОЖЕСТВЕННОЕ СРАВНЕНИЕ НАЗЫВАЕТСЯ ВСЛУХ. Перебирая несколько признаков по нескольким корзинам на
//    выборке в десятки строк, ПОБЕДИТЕЛЯ НАЙДЁШЬ ВСЕГДА — просто по случайности. Поэтому лучший признак
//    здесь называется КАНДИДАТОМ и сопровождается требованием перепроверки на СВЕЖИХ строках. Отчёт,
//    выдающий лучший из перебора за находку, — это подгонка с приборным лицом.
// ============================================================

import type { Database } from "./db.js";
import { marketFamily } from "./signals.js";

/** Меньше этого в корзине — доля НЕ печатается. Число названо до данных и одно для всех признаков. */
export const MIN_BUCKET_N = 8;
/** Разброс, начиная с которого признак вообще стоит обсуждать как кандидата (п.п. между корзинами). */
export const CANDIDATE_MIN_SPREAD_PP = 20;

export interface Bucket { bucket: string; n: number; falseCuts: number; falseCutPct: number | null; note: string }
export interface FeatureRow {
  feature: string;
  buckets: Bucket[];
  /** Разброс между КРАЙНИМИ ДОСТАТОЧНЫМИ корзинами, п.п. Null — сравнивать нечего. */
  spreadPp: number | null;
  measuredBuckets: number;
  note: string;
}
export interface FeatureSweep {
  at: string; rows: number; falseCuts: number; baseRatePct: number | null;
  minBucketN: number;
  features: FeatureRow[];
  /** Лучший по разбросу — КАНДИДАТ, а не находка. Null, если ни один признак не измерен как следует. */
  candidate: { feature: string; spreadPp: number; note: string } | null;
  note: string;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

interface CutRow {
  market_label: string; ml_cents: number | null; cut_at: string; false_cut: number;
  kickoff_at: string | null; sport_id: string | null;
}

/** Корзина перекоса манилайна — КОРЗИНЫ, а не порог: порог мы уже проверили и он не разделял. */
function mlBucket(ml: number | null): string {
  if (ml == null) return "манилайна нет";
  const d = Math.abs(Number(ml) - 50);
  if (d < 5) return "перекос <5¢";
  if (d < 15) return "перекос 5–15¢";
  if (d < 25) return "перекос 15–25¢";
  return "перекос ≥25¢";
}

/** Часы от среза до старта матча. Отрицательные (срез уже в игре) — своя корзина, а не свалка в «0–2». */
function kickoffBucket(cutAt: string, kickoffAt: string | null): string {
  if (!kickoffAt) return "старт неизвестен";
  const h = (Date.parse(kickoffAt) - Date.parse(cutAt)) / 3_600_000;
  if (!Number.isFinite(h)) return "старт неизвестен";
  if (h < 0) return "уже в игре";
  if (h < 2) return "<2ч до старта";
  if (h < 12) return "2–12ч";
  if (h < 48) return "12–48ч";
  return "≥48ч";
}

function bucketize(rows: CutRow[], keyOf: (r: CutRow) => string, feature: string): FeatureRow {
  const by = new Map<string, { n: number; f: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = by.get(k) ?? { n: 0, f: 0 };
    g.n++; if (r.false_cut === 1) g.f++;
    by.set(k, g);
  }
  const buckets: Bucket[] = [...by.entries()].map(([bucket, g]) => ({
    bucket, n: g.n, falseCuts: g.f,
    // ДОЛЯ ТОЛЬКО ПРИ ДОСТАТОЧНОМ ЗНАМЕНАТЕЛЕ. «2 из 3 = 66.7%» обманывает сильнее пустой клетки.
    falseCutPct: g.n >= MIN_BUCKET_N ? pct(g.f, g.n) : null,
    note: g.n >= MIN_BUCKET_N ? `${g.f} ложных из ${g.n}` : `${g.f} из ${g.n} — не измерено (нужно ≥${MIN_BUCKET_N})`,
  })).sort((a, b) => b.n - a.n);
  const measured = buckets.filter((b) => b.falseCutPct != null);
  // РАЗБРОС СЧИТАЕТСЯ ТОЛЬКО МЕЖДУ ДВУМЯ ДОСТАТОЧНЫМИ. Одна корзина против неизмеренной — не разброс.
  const spreadPp = measured.length >= 2
    ? Math.round((Math.max(...measured.map((b) => b.falseCutPct!)) - Math.min(...measured.map((b) => b.falseCutPct!))) * 10) / 10
    : null;
  return {
    feature, buckets, spreadPp, measuredBuckets: measured.length,
    note: measured.length < 2
      ? `измеренных корзин ${measured.length} — РАЗДЕЛЕНИЕ НЕ ПРОВЕРЕНО (нужно две по ≥${MIN_BUCKET_N})`
      : `разброс ${spreadPp} п.п. между ${measured.length} измеренными корзинами`,
  };
}

export function buildFeatureSweep(db: Database, nowIso: string): FeatureSweep {
  let rows: CutRow[] = [];
  try {
    rows = db.prepare(
      `SELECT c.market_label, c.ml_cents, c.cut_at, c.false_cut, m.kickoff_at, comp.sport_id
         FROM placeholder_cuts c
         LEFT JOIN matches m ON m.id = c.match_id
         LEFT JOIN competitions comp ON comp.id = m.competition_id
        WHERE c.false_cut IS NOT NULL`,
    ).all() as CutRow[];
  } catch { rows = []; }

  const falseCuts = rows.filter((r) => r.false_cut === 1).length;
  const features: FeatureRow[] = rows.length ? [
    bucketize(rows, (r) => marketFamily(r.market_label), "семья пропа"),
    bucketize(rows, (r) => mlBucket(r.ml_cents), "перекос манилайна"),
    bucketize(rows, (r) => kickoffBucket(r.cut_at, r.kickoff_at), "часы до старта"),
    bucketize(rows, (r) => r.sport_id ?? "спорт неизвестен", "вид спорта"),
  ] : [];

  const ranked = features.filter((f) => f.spreadPp != null).sort((a, b) => (b.spreadPp ?? 0) - (a.spreadPp ?? 0));
  const top = ranked[0];
  const candidate = top && (top.spreadPp ?? 0) >= CANDIDATE_MIN_SPREAD_PP
    ? { feature: top.feature, spreadPp: top.spreadPp!,
        // Кандидат, а не находка: см. защиту №3 в шапке.
        note: `КАНДИДАТ, не находка: перебраны ${features.length} признака, и лучший из перебора на выборке ${rows.length}`
          + ` находится ВСЕГДА — просто по случайности. Прежде чем менять правило, число обязано повториться`
          + ` на СВЕЖИХ строках, накопленных после этого замера.` }
    : null;

  return {
    at: nowIso, rows: rows.length, falseCuts,
    baseRatePct: rows.length ? pct(falseCuts, rows.length) : null,
    minBucketN: MIN_BUCKET_N, features, candidate,
    note: !rows.length ? "дозревших срезов нет — раскладывать нечего"
      : !ranked.length ? `база ${falseCuts}/${rows.length} — НИ ОДИН признак не набрал двух корзин по ≥${MIN_BUCKET_N}: разделение не проверено ни по одному`
        : candidate ? `база ${falseCuts}/${rows.length} · кандидат «${candidate.feature}» (разброс ${candidate.spreadPp} п.п.) — требует перепроверки на свежих строках`
          : `база ${falseCuts}/${rows.length} · ни один признак не дал разброса ≥${CANDIDATE_MIN_SPREAD_PP} п.п. — РАЗДЕЛЯЮЩЕГО ПРИЗНАКА СРЕДИ ПРОВЕРЕННЫХ НЕТ`
            + ` (лучший «${top!.feature}», ${top!.spreadPp} п.п.). Менять правило не на чем.`,
  };
}

/** Строка еженедельника: база и вердикт о поиске, без победителя-по-случайности. */
export function featureSweepLine(s: FeatureSweep): string {
  return `поиск разделяющего признака: база ${s.falseCuts}/${s.rows}`
    + (s.baseRatePct != null ? ` (${s.baseRatePct}%)` : "")
    + ` · ` + (s.candidate ? `кандидат «${s.candidate.feature}» ${s.candidate.spreadPp}п.п. (НЕ подтверждён)` : `кандидата нет`);
}
