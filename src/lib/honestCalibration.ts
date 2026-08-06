// ============================================================
// EDGE LAB — T6: КАЛИБРОВКА ЧИТАЕТ ТОЛЬКО ЦЕНУ МОМЕНТА РЕШЕНИЯ  [read-only]
//
// ЧЕМ ЗАСЛУЖЕНО — МОЕЙ СОБСТВЕННОЙ ОШИБКОЙ. Теневая калибровка на 282 футбольных рынках дала
// «Brier наш 0.134 против рынка 0.062 — рынок вдвое лучше нас». Вывод НЕВЕРЕН: цены брались из
// отчётной секции «Рынки», а это ТЕКУЩИЕ котировки на момент генерации отчёта; у завершённого матча
// они уже равны исходу. Проверка: цена «угадала» исход в 259 из 282 случаев (92%), 37% строк стояли
// у планки. То есть предматчевый прогноз сравнивался с ценой УРЕГУЛИРОВАНИЯ.
//
// Это ровно класс O11 («два факта в одной строке обязаны быть из одного момента»), который в тот же
// день дважды чинился в коде — и был допущен в анализе тем, кто правило и формулировал. Значит
// дисциплина здесь не работает как защита, и запрет обязан быть КОНСТРУКЦИЕЙ.
//
// КОНСТРУКЦИЯ. Этот модуль не импортирует ни `latestMarkets`, ни репозиторий рынков вообще: у него
// физически нет доступа к текущим котировкам. Единственный источник — `decision_prices`, куда цена
// пишется В МОМЕНТ РЕШЕНИЯ и больше не переписывается. Тест держит это свойство исходником.
//
// n=13 честных тезисов на 07.08 — НАЧАЛО РЯДА, а не приговор. Модуль обязан отказывать, пока ряд мал,
// и говорить это словами: «недостаточно» и «мы хуже рынка» лечатся противоположно.
// ============================================================

import type { Database } from "./db.js";
import { decisionPrices, decisionPriceCount, type DecisionPriceRow } from "./repo.js";

/** Ниже этого числа наблюдений вердикт не выносится. Названо ДО данных: 30 — минимум, при котором
 *  разница Brier в 0.05 перестаёт быть неотличимой от монетки на глаз. Не подгонялось под выборку. */
export const CALIB_MIN_N = 30;

export interface CalibBucket { lo: number; hi: number; n: number; ourBrier: number; mktBrier: number; weCloser: number }
export interface HonestCalibration {
  rowsTotal: number; rowsGraded: number;
  n: number; stage: string;
  hitRate: number; ourBrier: number | null; mktBrier: number | null; baseBrier: number | null;
  /** Разрез по величине спора с ценой: настоящий край растёт там, где мы спорим ГРОМЧЕ. */
  byDisagreement: CalibBucket[];
  /** Доля наблюдений, где край мерился по МИДУ, а не по исполнимому аску (#120) — они слабее. */
  midFallbackShare: number;
  verdict: "НЕ СОЗРЕЛО" | "МЫ ЛУЧШЕ ЦЕНЫ" | "ЦЕНА ЛУЧШЕ НАС" | "НЕОТЛИЧИМО";
  note: string;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const brier = (rows: { p: number; y: number }[]) => rows.length ? rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length : null;

/**
 * Калибровка по строкам решения. `stage` разделяет предматч и лайв: это разные вопросы, и слитая
 * цифра отвечает ни на один из них.
 *
 * ЦЕНА РЫНКА БЕРЁТСЯ ИСПОЛНИМАЯ (аск), когда она есть: с #120 край считается от неё, и сравнивать
 * нашу вероятность с мидом значило бы судить решение не по той цене, по которой оно принималось.
 */
export function buildHonestCalibration(db: Database, stage: "prematch" | "live" | "all" = "prematch"): HonestCalibration {
  const total = decisionPriceCount(db);
  const all = decisionPrices(db, { withOutcome: true });
  const rows = all.filter((r) => stage === "all" || (r.stage ?? "prematch") === stage);
  const pts = rows.map((r: DecisionPriceRow) => ({
    ours: r.our_prob,
    mkt: r.implied_prob != null ? r.implied_prob : (r.ask_cents ?? r.mid_cents) / 100,
    y: r.outcome === 1 ? 1 : 0,
    mid: r.edge_source === "mid_fallback",
  }));
  const n = pts.length;
  const hit = n ? pts.reduce((s, p) => s + p.y, 0) / n : 0;
  const ourB = brier(pts.map((p) => ({ p: p.ours, y: p.y })));
  const mktB = brier(pts.map((p) => ({ p: p.mkt, y: p.y })));
  const baseB = n ? brier(pts.map((p) => ({ p: hit, y: p.y }))) : null;
  const buckets: CalibBucket[] = [];
  for (const [lo, hi] of [[0, 0.05], [0.05, 0.1], [0.1, 0.2], [0.2, 1]] as const) {
    const s = pts.filter((p) => { const d = Math.abs(p.ours - p.mkt); return d >= lo && d < hi; });
    if (!s.length) continue;
    buckets.push({ lo, hi, n: s.length,
      ourBrier: r3(brier(s.map((p) => ({ p: p.ours, y: p.y })))!),
      mktBrier: r3(brier(s.map((p) => ({ p: p.mkt, y: p.y })))!),
      weCloser: s.filter((p) => Math.abs(p.ours - p.y) < Math.abs(p.mkt - p.y)).length });
  }
  const midShare = n ? Math.round((pts.filter((p) => p.mid).length / n) * 1000) / 10 : 0;

  let verdict: HonestCalibration["verdict"] = "НЕ СОЗРЕЛО", note: string;
  if (n < CALIB_MIN_N) {
    note = `честных наблюдений ${n} при нужных ${CALIB_MIN_N} — ОТСУТСТВИЕ ЗАМЕРА, а не «мы плохи».`
      + ` В журнале решений всего ${total} строк, с известным исходом ${all.length}.`
      + ` Ряд начат 07.08 и растёт с каждым анализом; секция «Рынки» для калибровки недоступна КОНСТРУКЦИЕЙ, а не правилом.`;
  } else {
    const d = (mktB as number) - (ourB as number);
    // Порог «неотличимо» назван до данных: 0.01 Brier — меньше, чем сдвигает одно наблюдение из 30.
    verdict = Math.abs(d) < 0.01 ? "НЕОТЛИЧИМО" : d > 0 ? "МЫ ЛУЧШЕ ЦЕНЫ" : "ЦЕНА ЛУЧШЕ НАС";
    note = `n=${n} (${stage}): Brier наш ${r3(ourB as number)} против цены ${r3(mktB as number)}, база ${r3(baseB as number)} · сбылось ${Math.round(hit * 100)}%`
      + ` · край по миду (не по аску) у ${midShare}% строк — эти слабее по построению`
      + ` · ${verdict}`;
  }
  return {
    rowsTotal: total, rowsGraded: all.length, n, stage, hitRate: r3(hit),
    ourBrier: ourB == null ? null : r3(ourB), mktBrier: mktB == null ? null : r3(mktB), baseBrier: baseB == null ? null : r3(baseB),
    byDisagreement: buckets, midFallbackShare: midShare, verdict, note,
  };
}

/** Строка еженедельника. Ноль наблюдений печатается словами — «ряд не начат» и «мы хуже» разные факты. */
export function honestCalibrationLine(c: HonestCalibration): string {
  return `калибровка (цена момента решения): n=${c.n}/${CALIB_MIN_N}`
    + (c.ourBrier == null ? " — ряд пуст" : ` · Brier наш ${c.ourBrier} vs цена ${c.mktBrier}`)
    + ` · ${c.verdict} · строк решения в журнале ${c.rowsTotal}`;
}
