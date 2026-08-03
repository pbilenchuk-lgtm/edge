// ============================================================
// EDGE LAB — D3(а): ДЕТЕКТОР ЛИГОВОГО СЛОМА. ТОЛЬКО ИЗМЕРЕНИЕ.
// [батч-13 D3, решение владельца 02.08.2026: «детектор строю, интервенцию — нет»]
//
// ПОЧЕМУ ПОЛОВИНА, А НЕ ЦЕЛОЕ. Августовская просадка MLS/LigaMX/CSL оказалась НЕзначимой, как только
// значимость посчитали на правильной единице: девять сигналов, пять поражений — обычный разброс
// (p=0.160 на 9 сигналах против p=0.0033 на 64 записях, которые я посчитал ошибочно). Строить защитный
// режим на пяти проигранных монетках — значит закрепить шум механизмом.
//
// Но МЕРИТЬ можно всегда, и это принципиально дешевле, чем вмешиваться: детектор не двигает ни одной
// ставки, он только называет число. Если августовский слом настоящий, детектор догонит его за пару
// недель честным способом — набрав сигналы. Если это был шум, мы не построили механизм на монетках.
//
// ЧТО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ, И ЭТО ГЛАВНОЕ. Он НЕ вмешивается: ни min-edge, ни паузы входов, ни единой
// записи в торговый путь. Интервенция остаётся `pending` в реестре ратификаций и армится ДВУМЯ ключами
// сразу — созревшим сигнальным критерием И словом владельца. Модуль, который «на всякий случай» умеет
// вмешаться, рано или поздно вмешается: поэтому этой способности здесь нет вовсе, а не выключена флагом.
//
// ЕДИНИЦА ИЗМЕРЕНИЯ — СИГНАЛЫ, И ТОЛЬКО ЧЕРЕЗ ПРОИЗВОДСТВЕННЫЙ `collapseToSignals`. Своя копия ключа
// схлопывания была бы четвёртым экземпляром того же класса; здесь зовётся ровно та функция, которой
// пользуются вердикты. Каждое p печатается с единицей (`pWithUnit`) — ратифицированное правило класса.
// ============================================================

import type { Database } from "./db.js";
import { betRecords } from "./profileAnalytics.js";
import { collapseToSignals, signalKey, pWithUnit, type Signal } from "./signals.js";
import { leagueGroup } from "./anomalyForensic.js";

/** Пороги ЗАФИКСИРОВАНЫ ДО включения — как требует ратификация. Меняются решением, а не подгонкой. */
export const GROUP_BIAS_WINDOW_SIGNALS = 30;   // скользящее окно последних решённых СИГНАЛОВ группы
export const GROUP_BIAS_P = 0.01;              // порог значимости просадки
export const GROUP_BIAS_MIN_BASE = 20;         // сигналов истории, без которых базе группы верить нельзя

export type GroupBiasVerdict = "нет базы" | "копим окно" | "в коридоре" | "ПРОСАДКА ЗНАЧИМА";

export interface GroupBiasRow {
  group: string;
  /** История группы ДО окна — база, против которой меряется просадка. Окно в базу не входит: иначе
   *  просадка размывала бы собственный эталон и тест бы сам себя гасил. */
  baseSignals: number; baseWinPct: number | null;
  windowSignals: number; windowWon: number; windowWinPct: number | null;
  p: number | null; verdict: GroupBiasVerdict; note: string;
}
export interface GroupBiasReport {
  windowSignals: number; pThreshold: number;
  rows: GroupBiasRow[];
  flagged: GroupBiasRow[];
  /** Прямое напоминание в самом отчёте: измерение НЕ включает режим. */
  intervention: "НЕ АРМИРОВАНА — интервенция pending до созревшего критерия И слова владельца";
  note: string;
}

const logChoose = (n: number, k: number): number => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; };
/** Точный односторонний НИЖНИЙ хвост P(X ≤ k | n, p) — «просадка не меньше наблюдаемой». */
export function binomLowerTail(k: number, n: number, p: number): number {
  if (n <= 0) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let s = 0;
  for (let i = 0; i <= Math.min(k, n); i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, Math.max(0, s));
}

export function buildGroupBiasDetector(db: Database, nowIso = new Date().toISOString()): GroupBiasReport {
  const recs = betRecords(db);
  // Момент сигнала берём из его записей: kickoff (иначе создание) последней ноги.
  const when = new Map<string, string>();
  const groupOf = new Map<string, string>();
  for (const r of recs) {
    // КЛЮЧ БЕРЁТСЯ У ПРОИЗВОДСТВЕННОГО `signalKey`, А НЕ СОБИРАЕТСЯ РУКАМИ. Первая версия этой строки
    // склеивала ключ сама — и разошлась с `collapseToSignals` на `canonicalMarket`: карта не находила
    // ни одного сигнала, все падали в «прочее». Третий экземпляр одного класса за сессию, и на этот раз
    // его поймал тест, написанный ровно про этот класс. Ключ схлопывания — ОДИН, и живёт он в signals.ts.
    const k = signalKey(r);
    const t = r.kickoffAt ?? r.createdAt ?? "";
    if (!when.has(k) || t > (when.get(k) as string)) when.set(k, t);
    if (!groupOf.has(k)) groupOf.set(k, leagueGroup(r.category, r.competitionId));
  }
  const decided = collapseToSignals(recs)
    .filter((s: Signal) => s.settled && (s.outcome === "won" || s.outcome === "lost"))
    .map((s) => ({ s, at: when.get(s.key) ?? "", group: groupOf.get(s.key) ?? "прочее" }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const byGroup = new Map<string, typeof decided>();
  for (const d of decided) (byGroup.get(d.group) ?? byGroup.set(d.group, []).get(d.group)!).push(d);

  const rows: GroupBiasRow[] = [...byGroup.entries()].map(([group, list]) => {
    const win = list.slice(-GROUP_BIAS_WINDOW_SIGNALS);
    const base = list.slice(0, Math.max(0, list.length - win.length));
    const baseWon = base.filter((d) => d.s.outcome === "won").length;
    const baseRate = base.length ? baseWon / base.length : null;
    const windowWon = win.filter((d) => d.s.outcome === "won").length;
    const pct = (w: number, n: number) => (n ? Math.round((1000 * w) / n) / 10 : null);
    let verdict: GroupBiasVerdict, p: number | null = null;
    if (base.length < GROUP_BIAS_MIN_BASE || baseRate == null) verdict = "нет базы";
    else if (win.length < GROUP_BIAS_WINDOW_SIGNALS) verdict = "копим окно";
    else {
      p = binomLowerTail(windowWon, win.length, baseRate);
      verdict = p < GROUP_BIAS_P ? "ПРОСАДКА ЗНАЧИМА" : "в коридоре";
    }
    const note =
      verdict === "нет базы" ? `истории всего ${base.length} сигнал(ов) при нужных ${GROUP_BIAS_MIN_BASE} — база не построена, сравнивать НЕ С ЧЕМ (это отсутствие замера, а не «всё в порядке»)`
      : verdict === "копим окно" ? `окно ${win.length}/${GROUP_BIAS_WINDOW_SIGNALS} сигналов — до порога не добрали, вердикт не выносится`
      : verdict === "ПРОСАДКА ЗНАЧИМА" ? `${windowWon}/${win.length} против базы ${Math.round((baseRate as number) * 1000) / 10}% на ${base.length} сигналах: ${pWithUnit(p, win.length)} < ${GROUP_BIAS_P} — просадка НЕ объясняется разбросом. ИЗМЕРЕНИЕ, не команда: интервенция армится отдельно`
      : `${windowWon}/${win.length} против базы ${Math.round((baseRate as number) * 1000) / 10}%: ${pWithUnit(p, win.length)} — в коридоре разброса`;
    return {
      group, baseSignals: base.length, baseWinPct: pct(baseWon, base.length),
      windowSignals: win.length, windowWon, windowWinPct: pct(windowWon, win.length),
      p: p == null ? null : Math.round(p * 10000) / 10000, verdict, note,
    };
  }).sort((a, b) => (a.p ?? 1) - (b.p ?? 1));

  const flagged = rows.filter((r) => r.verdict === "ПРОСАДКА ЗНАЧИМА");
  return {
    windowSignals: GROUP_BIAS_WINDOW_SIGNALS, pThreshold: GROUP_BIAS_P, rows, flagged,
    intervention: "НЕ АРМИРОВАНА — интервенция pending до созревшего критерия И слова владельца",
    note: flagged.length
      ? `⚠ ${flagged.length} групп(а) со значимой просадкой: ${flagged.map((r) => `${r.group} (${pWithUnit(r.p, r.windowSignals)})`).join(", ")}. Это ИЗМЕРЕНИЕ — режим НЕ включён.`
      : rows.length
        ? `лиговых групп ${rows.length}: значимых просадок нет${rows.some((r) => r.verdict !== "в коридоре") ? ` · ${rows.filter((r) => r.verdict !== "в коридоре").length} ещё не измеряются (нет базы / копим окно)` : ""}`
        : "решённых сигналов нет — измерять нечего",
  };
}

/** Строка для еженедельника. Каждое p с единицей — ратифицированное правило класса. */
export function groupBiasLine(r: GroupBiasReport): string {
  const meas = r.rows.filter((x) => x.verdict === "в коридоре" || x.verdict === "ПРОСАДКА ЗНАЧИМА").length;
  return `group_bias: измеряются ${meas}/${r.rows.length} групп(ы)`
    + (r.flagged.length ? ` · ⚠ ЗНАЧИМАЯ ПРОСАДКА: ${r.flagged.map((x) => `${x.group} ${pWithUnit(x.p, x.windowSignals)}`).join(", ")}` : " · значимых просадок нет")
    + " · интервенция НЕ армирована";
}
