// ============================================================
// EDGE LAB — N3(1): ГЕЙТ, КОТОРЫЙ НЕЛЬЗЯ ПРОВЕРИТЬ, ПОКА ОН ВЫКЛЮЧЕН
//
// УСЛОВИЕ R2-СТОП-КРАНА: paper-режим не включается, пока `net_ev_cut` не подтверждён ЖИВЫМ
// срабатыванием. Условие стоит с самого стоп-крана и не выполнено до сих пор — и разбор показал,
// почему оно НЕ МОГЛО быть выполнено: net-EV гейт и M21-haircut стоят в коде ПОСЛЕ ветки `flag_only`.
// При включённом флаге управление до них не доходит вообще. «Подтверди живым срабатыванием то, что
// живёт только после снятия блокировки, которую это подтверждение и должно снять» — самозапечатывающийся
// гейт ровно того же класса, что T3-конвенция и лестница продвижения.
//
// ЛЕЧЕНИЕ — КОНСТРУКЦИЯ, А НЕ ФЛИП ФЛАГА. Гейт считается и в тени: на КАЖДОМ реальном кандидате, на
// настоящих theo/mid/книге, с тем же haircut — но без единой ставки. Это даёт ровно то, чего требовал
// стоп-кран: живое срабатывание на живых данных. И даёт бесплатно второе — ЦЕНУ ВКЛЮЧЕНИЯ, известную
// ДО включения: сколько сигналов гейт срезал бы и на какой марже.
//
// ЧЕГО ЗДЕСЬ НЕТ. Здесь нет решения о деньгах и нет флипа флага: `TENNIS_PMV_FLAG_ONLY` эта запись не
// читает и не пишет. Гейт наблюдается — включает его владелец, по этим числам.
//
// ЕДИНИЦА — КАНДИДАТ (проп×матч). Один матч даёт несколько пропов, и складывать их в «матчи» значило бы
// повторить подмену единицы, которая уже трижды била по проекту.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ФИКС 05.08: ПРИБОР ГАС РОВНО ТОГДА, КОГДА ОБЪЕКТ НАБЛЮДЕНИЯ ВКЛЮЧАЛСЯ.
//
// Первая версия записывала гейт ТОЛЬКО из ветки `flag_only`. Пока флаг стоял, счётчик рос и доказал
// условие R2. Владелец снял флаг — и `evaluated` замер навсегда: реальная ветка тот же гейт считает, но
// в наблюдение не кладёт. То есть вахта «первых 20 paper-сигналов», ради которой флаг и снимался,
// читала бы ЗАМЁРЗШЕЕ число и не отличила бы «гейт больше не зовётся» от «сканов не было».
//
// Это тот же класс, что самозапечатывающийся гейт, только зеркальный: там проверка была невозможна ДО
// включения, здесь — ПОСЛЕ. Прибор обязан переживать включение того, что он измеряет, поэтому запись
// идёт с ОБЕИХ веток и несёт `live`: тень и живой режим считаются раздельно, но ни один не молчит.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

const KEY = "pmv_net_ev_shadow";

export interface NetEvShadowEntry {
  at: string; label: string; family: string; side: string;
  grossCents: number; haircutCents: number; feeCents: number; driftCents: number;
  marginCents: number; netCents: number; pass: boolean;
  /** true — гейт считался на ЖИВОМ пути (флаг снят, за решением идут деньги); false/absent — тень. */
  live?: boolean;
}
export interface NetEvShadowState {
  evaluated: number; wouldPass: number; wouldCut: number;
  /** Раздельные счётчики живого пути: «гейт работал в тени» и «гейт режет деньги» — разные факты. */
  liveEvaluated: number; liveCut: number; liveLastAt: string | null;
  firstAt: string | null; lastAt: string | null;
  /** Последние срабатывания — чтобы «гейт живой» можно было ПРОЧИТАТЬ, а не поверить на слово. */
  recent: NetEvShadowEntry[];
}
const EMPTY: NetEvShadowState = { evaluated: 0, wouldPass: 0, wouldCut: 0, liveEvaluated: 0, liveCut: 0, liveLastAt: null, firstAt: null, lastAt: null, recent: [] };
const RECENT_KEEP = 20;

export function readNetEvShadow(db: Database): NetEvShadowState {
  try { const raw = R.metaGet(db, KEY); return raw ? { ...EMPTY, ...(JSON.parse(raw) as NetEvShadowState) } : { ...EMPTY }; }
  catch { return { ...EMPTY }; }
}

/** Зафиксировать ОДНО теневое срабатывание гейта. Пишется всегда — и pass, и cut: «гейт ничего не
 *  срезал» и «гейт не звался» это разные факты, и различать их обязан положительный отпечаток. */
export function recordNetEvShadow(db: Database, e: NetEvShadowEntry): void {
  try {
    const s = readNetEvShadow(db);
    s.evaluated++; if (e.pass) s.wouldPass++; else s.wouldCut++;
    if (e.live) { s.liveEvaluated++; if (!e.pass) s.liveCut++; s.liveLastAt = e.at; }
    s.firstAt = s.firstAt ?? e.at; s.lastAt = e.at;
    s.recent = [e, ...s.recent].slice(0, RECENT_KEEP);
    R.metaSet(db, KEY, JSON.stringify(s), e.at);
  } catch { /* наблюдение не роняет то, что наблюдает */ }
}

export type NetEvVerdict = "ЖИВОЙ — срабатывания есть" | "ЗВАЛСЯ, НО НЕ СРЕЗАЛ НИ РАЗУ" | "НЕ ЗВАЛСЯ НИ РАЗУ";
export interface NetEvShadowReport extends NetEvShadowState {
  verdict: NetEvVerdict;
  /** Условие R2 выполнено ⟺ гейт хотя бы раз СРЕЗАЛ на живом кандидате: срабатывание, а не вызов. */
  r2ConditionMet: boolean;
  cutPct: number | null;
  note: string;
}

export function buildNetEvShadow(db: Database): NetEvShadowReport {
  const s = readNetEvShadow(db);
  const verdict: NetEvVerdict = s.evaluated === 0 ? "НЕ ЗВАЛСЯ НИ РАЗУ"
    : s.wouldCut === 0 ? "ЗВАЛСЯ, НО НЕ СРЕЗАЛ НИ РАЗУ" : "ЖИВОЙ — срабатывания есть";
  const cutPct = s.evaluated ? Math.round((1000 * s.wouldCut) / s.evaluated) / 10 : null;
  return {
    ...s, verdict, r2ConditionMet: s.wouldCut > 0, cutPct,
    note: (s.evaluated === 0
      ? "гейт не оценивался ни разу — это ОТСУТСТВИЕ ЗАМЕРА, а не «нечего резать». Условие R2 НЕ выполнено"
      : s.wouldCut === 0
        ? `гейт оценён на ${s.evaluated} кандидат(ах), не срезал НИ ОДНОГО. Вызов — это ещё не срабатывание: условие R2 требует живого СРЕЗА, и оно НЕ выполнено`
        : `гейт ЖИВОЙ: срезал бы ${s.wouldCut} из ${s.evaluated} кандидатов (${cutPct}%), окно ${s.firstAt?.slice(0, 10) ?? "?"}…${s.lastAt?.slice(0, 10) ?? "?"}.`
          + ` Условие R2 выполнено — цена включения известна ДО включения. Флаг поднимает ВЛАДЕЛЕЦ, не отчёт`)
      + (s.liveEvaluated
        ? ` · ЖИВОЙ ПУТЬ: гейт оценил ${s.liveEvaluated}, срезал ${s.liveCut} (последний ${s.liveLastAt ?? "—"}) — за этими решениями идут деньги`
        : ` · живой путь: гейт на нём ещё не звался (флаг снят? сканов не было?) — счётчик отдельный, чтобы «замерла тень» не читалось как «замер гейт»`),
  };
}

/** Строка пульса — ровно то, чего требовал стоп-кран («+ строка в пульсе»). */
export function netEvShadowLine(r: NetEvShadowReport): string {
  return `pmv_net_ev: ${r.verdict}`
    + (r.evaluated ? ` · срез ${r.wouldCut}/${r.evaluated}${r.cutPct != null ? ` (${r.cutPct}%)` : ""}` : "")
    + ` · условие R2 ${r.r2ConditionMet ? "ВЫПОЛНЕНО" : "НЕ выполнено"}`;
}
