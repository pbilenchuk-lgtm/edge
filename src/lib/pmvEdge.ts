// ============================================================
// EDGE LAB — ЕСТЬ ЛИ У PMV КРАЙ  [READ-ONLY ИССЛЕДОВАНИЕ, гипотеза объявлена до данных]
//
// ПОЧЕМУ ЭТО НЕ «ПОЧИНКА ГЕЙТА». 13 бумажных решений дали −$1006, и первым побуждением было чинить net-EV
// гейт: он «не связал ни разу». Проверка сказала обратное — гейт стоит ровно в денежном пути (tennisPmv,
// между отбором кандидатов и сайзингом), а ноль срабатываний объясняется тем, что ветка flag_only делает
// `continue` РАНЬШЕ и до гейта управление не доходит, пока деньги остановлены. Чинить в нём нечего.
//
// Хуже: прогон тех же 13 решений по всем маржам показал, что НИ ОДИН порог не улучшает результат, кроме
// того, который режет почти всё. Гейт — фильтр НАД сигналом. Если у сигнала нет края, никакой порог его не
// создаст. Значит вопрос не про гейт, а про то, есть ли край вообще.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ УЖЕ СУЩЕСТВУЮЩЕГО BRIER-КРИТЕРИЯ (buildPmvShadowCalibration).
// Brier измеряет КАЛИБРОВКУ на ВСЕХ сигналах: насколько хорошо theo предсказывает исход в среднем. Край в
// торговле — другое: мы входим только там, где theo далеко ушла от mid, то есть на ОТОБРАННОМ хвосте.
// Модель может быть прекрасно калибрована в среднем и терять именно на хвосте (и наоборот). Brier на это
// не отвечает и не может — он не знает, какие сигналы стали бы ставками.
//
// Поэтому здесь считается то, чего в отчётах нет: КОНТРФАКТИЧЕСКИЙ P&L. «Если бы мы поставили $1 на каждый
// shadow-сигнал по замороженному mid — сколько бы вышло?» Исход у сигнала уже есть (won/lost), цена
// заморожена в тот же таймстемп, что и theo, денег не двигалось. Это прямая проверка края, а не прокси.
//
// И ОБЯЗАТЕЛЬНО — ПОСЛЕ ИЗДЕРЖЕК. Реальный вход платит taker fee. Край до комиссии и край после — разные
// утверждения, и торгуемо только второе. Разница между ними и есть цена исполнения, ради которой net-EV
// гейт вообще писался.
// ============================================================

import type { Database } from "./db.js";

/** ГИПОТЕЗЫ, объявленные ДО чтения данных — чтобы «край» нельзя было найти post-hoc подбором среза. */
export const PMV_EDGE_HYPOTHESIS = {
  h0: "H0: у PMV края нет — замороженный mid и есть лучшая оценка, а отклонение theo от mid не несёт информации об исходе. Ожидание P&L на $1/сигнал ≈ 0 до комиссии и < 0 после неё.",
  h1: "H1: край есть — на сигналах, которые мы бы торговали, реализованная частота исходов лучше, чем предполагает mid, и разница переживает комиссию.",
  criterion: "Край признаётся ТОЛЬКО при: (1) n ≥ 40 разрешённых сигналов; (2) нижняя граница 95% бутстрап-интервала нетто-P&L СТРОГО выше нуля. Одного положительного среднего недостаточно — на выборке в десятки случаев оно возникает из дисперсии.",
  antiPeek: "Разбивка по бакетам отклонения — ОПИСАТЕЛЬНАЯ. Выбрать по ней «лучший бакет» и объявить край там значит подогнать порог под шум: чем мельче бакет, тем легче в нём случайный плюс. Бакет может только породить гипотезу для СЛЕДУЮЩЕЙ, независимой выборки.",
} as const;

export const PMV_EDGE_NEED_N = 40;      // тот же порог, что уже стоит у Brier-критерия — не занижаем под данные
const BOOT_ITERS = 2000;
const CI_LO_PCT = 2.5, CI_HI_PCT = 97.5;

/** Детерминированный ГПСЧ: отчёт обязан воспроизводиться числом в число, иначе его нельзя перечитать. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export interface PmvEdgeRow { deviation: number; midCents: number; theoCents: number; won: boolean; family: string; side: string }
export interface PmvEdgeBucket { label: string; n: number; winPct: number; midMeanPct: number; grossPerDollar: number; netPerDollar: number }
export interface PmvEdgeReport {
  hypothesis: typeof PMV_EDGE_HYPOTHESIS;
  feeRate: number;
  counts: { total: number; pending: number; resolved: number; void: number; unresolved: number };
  n: number;
  matured: boolean;
  /** Средний P&L на $1 ставки по замороженному mid, до комиссии. */
  grossPerDollar: number | null;
  /** То же после taker fee — единственное число, по которому решается «торговать или нет». */
  netPerDollar: number | null;
  ci: { lo: number; hi: number } | null;
  buckets: PmvEdgeBucket[];
  verdict: "insufficient" | "край_не_подтверждён" | "край_подтверждён";
  note: string;
}

/**
 * P&L покупки за $1 по цене `mid` центов при исходе `won`. Бинарный контракт: выигрыш платит $1 за долю,
 * доля стоит mid/100, значит на $1 приходится 100/mid долей.
 */
export function unitPnl(midCents: number, won: boolean, feeRate: number): number {
  if (!(midCents > 0) || midCents >= 100) return 0;          // вырожденная цена — не ставка
  const gross = won ? 100 / midCents - 1 : -1;
  // Комиссия берётся с оборота входа, как у тейкера на бирже: она списывается независимо от исхода.
  return gross - feeRate;
}

/** Перцентиль по отсортированной копии — без внешних зависимостей и без сюрпризов с интерполяцией. */
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** Бутстрап среднего: единственный способ отличить «край» от «повезло семь раз подряд» на такой выборке. */
export function bootstrapMeanCi(xs: number[], iters = BOOT_ITERS, seed = 20260727): { lo: number; hi: number } | null {
  if (xs.length < 2) return null;
  const rnd = lcg(seed);
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let k = 0; k < xs.length; k++) s += xs[(rnd() * xs.length) | 0];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return { lo: Math.round(pct(means, CI_LO_PCT) * 10000) / 10000, hi: Math.round(pct(means, CI_HI_PCT) * 10000) / 10000 };
}

const BUCKETS: [string, number, number][] = [
  ["откл. < 5¢", -Infinity, 5],
  ["откл. 5–10¢", 5, 10],
  ["откл. 10–15¢", 10, 15],
  ["откл. 15–20¢", 15, 20],
  ["откл. ≥ 20¢", 20, Infinity],
];

export function buildPmvEdgeReport(db: Database, env: Record<string, string | undefined> = process.env): PmvEdgeReport {
  const feeRate = (() => { const n = Number(env.POLYMARKET_TAKER_FEE_RATE); return Number.isFinite(n) && n >= 0 ? n : 0.02; })();

  const all = db.prepare(`SELECT status FROM pmv_shadow_signals`).all() as { status: string }[];
  const counts = { total: all.length, pending: 0, resolved: 0, void: 0, unresolved: 0 };
  for (const r of all) {
    if (r.status === "won" || r.status === "lost") counts.resolved++;
    else if (r.status === "void") counts.void++;
    else if (r.status === "unresolved") counts.unresolved++;
    else counts.pending++;
  }

  const raw = db.prepare(
    `SELECT deviation, mid_cents, theo_cents, status, family, side
       FROM pmv_shadow_signals WHERE status IN ('won','lost')`,
  ).all() as any[];
  // Вырожденные цены выбрасываются ЯВНО: ставка по 0¢ или 100¢ не существует, а в среднем она бы дала
  // бесконечный или нулевой край и утащила бы весь вывод за собой.
  const rows: PmvEdgeRow[] = raw
    .filter((r) => r.mid_cents > 0 && r.mid_cents < 100)
    .map((r) => ({ deviation: r.deviation ?? 0, midCents: r.mid_cents, theoCents: r.theo_cents, won: r.status === "won", family: r.family ?? "—", side: r.side ?? "—" }));

  const n = rows.length;
  const matured = n >= PMV_EDGE_NEED_N;
  const nets = rows.map((r) => unitPnl(r.midCents, r.won, feeRate));
  const grosses = rows.map((r) => unitPnl(r.midCents, r.won, 0));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const r4 = (x: number | null) => (x == null ? null : Math.round(x * 10000) / 10000);
  const netPerDollar = r4(mean(nets));
  const grossPerDollar = r4(mean(grosses));
  const ci = bootstrapMeanCi(nets);

  const buckets: PmvEdgeBucket[] = BUCKETS.map(([label, lo, hi]) => {
    const sub = rows.filter((r) => r.deviation >= lo && r.deviation < hi);
    return {
      label, n: sub.length,
      winPct: sub.length ? Math.round((1000 * sub.filter((r) => r.won).length) / sub.length) / 10 : 0,
      midMeanPct: sub.length ? Math.round((10 * sub.reduce((s, r) => s + r.midCents, 0)) / sub.length) / 10 : 0,
      grossPerDollar: sub.length ? Math.round(10000 * (mean(sub.map((r) => unitPnl(r.midCents, r.won, 0))) ?? 0)) / 10000 : 0,
      netPerDollar: sub.length ? Math.round(10000 * (mean(sub.map((r) => unitPnl(r.midCents, r.won, feeRate))) ?? 0)) / 10000 : 0,
    };
  }).filter((b) => b.n > 0);

  const verdict: PmvEdgeReport["verdict"] = !matured
    ? "insufficient"
    : ci && ci.lo > 0 ? "край_подтверждён" : "край_не_подтверждён";

  const note = !matured
    ? `КОПИМ: ${n}/${PMV_EDGE_NEED_N} разрешённых сигналов. Читать напечатанный P&L как ответ НЕЛЬЗЯ — на такой выборке ` +
      `он колеблется сильнее, чем любой край, который мы ищем. Деньги стоят (flag_only), копить ничего не стоит.`
    : verdict === "край_подтверждён"
      ? `КРАЙ ПОДТВЕРЖДЁН: нетто $${netPerDollar} на $1 ставки, 95% интервал [${ci!.lo}; ${ci!.hi}] целиком выше нуля при n=${n}. ` +
        `Это основание обсуждать возврат денег — но не сам возврат: решение за владельцем, и лестница промоушена не отменяется.`
      : `КРАЙ НЕ ПОДТВЕРЖДЁН: нетто $${netPerDollar} на $1 ставки, 95% интервал [${ci?.lo ?? "—"}; ${ci?.hi ?? "—"}] ` +
        `накрывает ноль при n=${n}. Это НЕ доказательство отсутствия края — это отсутствие доказательства его наличия. ` +
        `При таком исходе правильное действие — оставить деньги остановленными и продолжать копить, а не крутить пороги.`;

  return { hypothesis: PMV_EDGE_HYPOTHESIS, feeRate, counts, n, matured, grossPerDollar, netPerDollar, ci, buckets, verdict, note };
}
