// ============================================================
// EDGE LAB — ПЕРЕ-СНИМОК ПОТРЕБИТЕЛЕЙ МЕТОК ОДНИМ ПРОХОДОМ
// [ратифицировано владельцем 02.08.2026, частичное снятие моратория: футбол — да, теннис — нет]
//
// Миграция pieceRelabel переставила 227 меток. Каждая ячейка, которая читает метку как ПРЕДСКАЗАНИЕ,
// обязана быть перечитана и КАЖДЫЙ сдвиг — подписан миграцией, а не оставлен на догадку читателя.
//
// КАК СЧИТАЕТСЯ «ДО». Не второй реализацией метрик — это был бы именной класс «два авторитета». Берётся
// ТОТ ЖЕ производственный код, но на наборе записей с ДОмиграционными метками: `preMigrationStatus()`
// (единственный источник ответа «какой была метка») переворачивает ровно те строки, что переворачивала
// миграция, и результат скармливается тем же функциям через `recsOverride`. База при этом НЕ ПИШЕТСЯ:
// отчёт остаётся read-only, как и требовалось от GET-путей после истории с pm_resolution.
//
// ЧЕГО ЭТОТ ПРОХОД НЕ ДЕЛАЕТ, И ЭТО НАЗВАНО, А НЕ ПОДРАЗУМЕВАЕТСЯ:
//   • ТЕННИС НЕ ПЕРЕЧИТЫВАЕТСЯ. 217 из 220 непроверяемых кусков — теннисные: у миграции не было чем
//     проверить исход, поэтому теннисные метки остались знаком P&L. Они получают постоянную пометку
//     `labels_unverified`, а не цифру: цифра здесь означала бы проверку, которой не было.
//   • ЦЕНОВЫЕ ЧАСТИ НЕ ЗАТРОНУТЫ ПО ПОСТРОЕНИЮ. CLV, слиппедж, стоимость исполнения, честность выхода в
//     части ЦЕНЫ считаются от entry/exit/closing — миграция их не касалась (payout вне UPDATE). Сдвиг там
//     искать НЕ НАДО, и шапка это говорит прямо, чтобы отсутствие сдвига не читалось как недосмотр.
//   • СЧЁТЧИК ЗРЕЛОСТИ ГЕЙТА от меток не зависит: миграция не меняет ни `settled_by`, ни сам факт расчёта,
//     только won/lost. Поэтому n остаётся тем же, а двигаться может только вердикт.
// ============================================================

import type { Database } from "./db.js";
import { betRecords, calibration, type BetRec, type CalibrationBlock } from "./profileAnalytics.js";
import { preMigrationStatus } from "./pieceRelabel.js";
import { signalCohort, marketFamily, type SignalCohort } from "./signals.js";
import { buildOverreactionGate } from "./overreactionGate.js";
import { familyVerdicts } from "./familyShadow.js";

/** Постоянная пометка на теннисных win-rate-ячейках — не временная, а до появления проверяемой когорты. */
export const TENNIS_LABEL_TAG = "labels_unverified";
export const TENNIS_LABEL_NOTE =
  "метки этой стратегии НЕ проверены исходом рынка: 217 из 220 непроверяемых кусков — теннисные, "
  + "и её win-rate остаётся ЗНАКОМ P&L, выдающим себя за точность прогноза. Путь вперёд открыт — счёт по "
  + "сетам пишется в карточку при финише, значит будущие куски станут проверяемыми; исторические честно "
  + "потеряны для верификации навсегда.";

/** Набор записей с ДОмиграционными метками. Ни одной записи в базу — только копия в памяти. */
export function preMigrationRecords(db: Database, recs: BetRec[]): BetRec[] {
  const was = preMigrationStatus(db);
  if (!was.size) return recs;
  return recs.map((r) => {
    const s = was.get(r.id);
    if (!s) return r;
    const outcome: BetRec["outcome"] = s === "settled_won" ? "won" : "lost";
    return { ...r, status: s, outcome, winsOnEvent: outcome === "won" };
  });
}

export interface CellShift {
  /** Порядковый номер по ратифицированному списку чтения — золотая ячейка первой. */
  order: number;
  cell: string;
  what: string;
  /** Метрика ДО и ПОСЛЕ. `null` там, где ячейка от меток не зависит (и это сказано в `note`). */
  before: number | null; after: number | null; delta: number | null;
  unit: string;
  /** Сколько строк когорты вообще переставила миграция — подпись сдвига. */
  flippedInCohort: number;
  note: string;
}

export interface LabelEpochSnapshot {
  at: string;
  flipsTotal: number;
  cells: CellShift[];
  /** Вердикт гейта e5 до и после — отдельно, потому что это не число, а решение. */
  gate: { before: string; after: string; changed: boolean; note: string };
  tennis: { tag: string; strategies: string[]; note: string };
  priceSideNote: string;
  note: string;
}

const pp = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
const winPct = (recs: BetRec[]) => {
  const w = recs.filter((r) => r.outcome === "won").length;
  const l = recs.filter((r) => r.outcome === "lost").length;
  return w + l ? Math.round((1000 * w) / (w + l)) / 10 : null;
};

export function buildLabelEpochSnapshot(db: Database, nowIso = new Date().toISOString()): LabelEpochSnapshot {
  const now = betRecords(db);
  const was = preMigrationStatus(db);
  const pre = preMigrationRecords(db, now);
  const flippedIds = was;
  const cells: CellShift[] = [];
  const countFlipped = (rs: BetRec[]) => rs.filter((r) => flippedIds.has(r.id)).length;

  // ── 1. ЗОЛОТАЯ ЯЧЕЙКА: prematch_value × totals. Читается первой — она держит S7.
  const goldSel = (rs: BetRec[]) => rs.filter((r) => r.strategyId === "prematch_value" && marketFamily(r.market) === "totals");
  const goldNow: SignalCohort = signalCohort(goldSel(now), { strategyId: "prematch_value", family: "totals" });
  const goldPre: SignalCohort = signalCohort(goldSel(pre), { strategyId: "prematch_value", family: "totals" });
  cells.push({
    order: 1, cell: "golden:prematch_value×totals", what: "доля выигранных сигналов золотой ячейки",
    before: pp(goldPre.winVsImplied.winPct), after: pp(goldNow.winVsImplied.winPct),
    delta: pp((goldNow.winVsImplied.winPct ?? 0) - (goldPre.winVsImplied.winPct ?? 0)),
    unit: "пп", flippedInCohort: countFlipped(goldSel(now)),
    note: `сигналов ${goldNow.nSignals} (решено ${goldNow.nDecided}) — n от меток не зависит; сдвиг ПОДПИСАН миграцией меток кусков`
      + ` · вердикт ячейки «${goldPre.verdict}» → «${goldNow.verdict}»${goldPre.verdict !== goldNow.verdict ? " — СМЕНИЛСЯ" : ""}`,
  });
  cells.push({
    order: 1, cell: "golden:binomP", what: "значимость против имплайд-вероятности",
    before: goldPre.winVsImplied.binomP, after: goldNow.winVsImplied.binomP,
    delta: goldNow.winVsImplied.binomP != null && goldPre.winVsImplied.binomP != null
      ? Math.round((goldNow.winVsImplied.binomP - goldPre.winVsImplied.binomP) * 1000) / 1000 : null,
    unit: "p", flippedInCohort: countFlipped(goldSel(now)),
    note: "p-значение считается ТЕМ ЖЕ signalCohort на ДОмиграционных метках, а не второй формулой",
  });

  // ── 3. ФУТБОЛЬНЫЕ Brier / КАЛИБРОВКА (теннис исключён — см. tennis ниже).
  const fbSel = (rs: BetRec[]) => rs.filter((r) => !r.strategyId.startsWith("tennis"));
  const calNow: CalibrationBlock = calibration(fbSel(now));
  const calPre: CalibrationBlock = calibration(fbSel(pre));
  cells.push({
    order: 3, cell: "football:brier", what: "Brier по футбольным решённым (ниже = точнее)",
    before: calPre.brier ?? null, after: calNow.brier ?? null,
    delta: calNow.brier != null && calPre.brier != null ? Math.round((calNow.brier - calPre.brier) * 10000) / 10000 : null,
    unit: "Brier", flippedInCohort: countFlipped(fbSel(now)),
    note: "исход в (p−o)² берётся из МЕТКИ — поэтому Brier обязан двигаться; рост здесь означает, что "
      + "прежняя точность была завышена меткой, а не что модель стала хуже",
  });
  cells.push({
    order: 3, cell: "football:winrate", what: "win-rate футбольных решённых",
    before: winPct(fbSel(pre)), after: winPct(fbSel(now)),
    delta: pp((winPct(fbSel(now)) ?? 0) - (winPct(fbSel(pre)) ?? 0)),
    unit: "пп", flippedInCohort: countFlipped(fbSel(now)),
    note: "линейка перестала льстить: это СНЯТИЕ ИСКАЖЕНИЯ при Δ книги $0.00 внутри прохода",
  });

  // ── 3b. FAMILY_SHADOW: вердикты по семьям рынков (BTTS-счётчики в их числе).
  const famNow = familyVerdicts(db, now), famPre = familyVerdicts(db, pre);
  const famChanged = famNow.filter((f) => {
    const p = famPre.find((x) => x.strategyId === f.strategyId && x.family === f.family);
    return p && p.cohort.verdict !== f.cohort.verdict;
  });
  cells.push({
    order: 3, cell: "family_shadow:verdicts", what: "сколько семейных вердиктов сменилось",
    before: famPre.length, after: famNow.length, delta: famChanged.length, unit: "вердиктов",
    flippedInCohort: countFlipped(now),
    note: famChanged.length
      ? `СМЕНИЛИСЬ: ${famChanged.map((f) => `${f.strategyId}×${f.family}`).join(", ")} — читать по новым меткам`
      : "ни один семейный вердикт не сменился — метки двигали числа, но не пересекали пороги",
  });

  // ── 4. exit_honesty / F4: ЦЕНОВАЯ часть от меток не зависит, ярлычная — зависит.
  const earlySel = (rs: BetRec[]) => rs.filter((r) => r.settledBy === "early" || r.settledBy === "partial");
  cells.push({
    order: 4, cell: "exit_honesty:label_side", what: "win-rate досрочно закрытых кусков",
    before: winPct(earlySel(pre)), after: winPct(earlySel(now)),
    delta: pp((winPct(earlySel(now)) ?? 0) - (winPct(earlySel(pre)) ?? 0)),
    unit: "пп", flippedInCohort: countFlipped(earlySel(now)),
    note: "это ЯРЛЫЧНАЯ сторона среза — именно она и мигрировала",
  });
  cells.push({
    order: 4, cell: "exit_honesty:price_side", what: "ценовые части (CLV, слиппедж, стоимость выхода)",
    before: null, after: null, delta: null, unit: "—", flippedInCohort: 0,
    note: "ОТ МЕТОК НЕ ЗАВИСЯТ ПО ПОСТРОЕНИЮ: считаются от entry/exit/closing, а payout миграция не трогала. "
      + "Сдвига здесь нет и искать его не надо — отсутствие сдвига тут ФАКТ, а не недосмотр",
  });

  // ── 2. ГЕЙТ e5 — не число, а решение, поэтому отдельным блоком.
  const gNow = buildOverreactionGate(db, 30, 5, now);
  const gPre = buildOverreactionGate(db, 30, 5, pre);
  const gate = {
    before: gPre.verdict, after: gNow.verdict, changed: gPre.verdict !== gNow.verdict,
    note: gPre.verdict !== gNow.verdict
      ? `вердикт СМЕНИЛСЯ «${gPre.verdict}» → «${gNow.verdict}». Ослабление здесь — САМЫЙ ИНФОРМАТИВНЫЙ исход: `
        + `overreaction оказался самым искажённым (31.2% переворотов), и честное «нет» дороже удобного «может быть»`
      : `вердикт не изменился («${gNow.verdict}»): метки двигали ноги вердикта, но порог не пересекли`,
  };

  const tennisStrategies = [...new Set(now.filter((r) => r.strategyId.startsWith("tennis")).map((r) => r.strategyId))].sort();

  return {
    at: nowIso, flipsTotal: was.size, cells: cells.sort((a, b) => a.order - b.order), gate,
    tennis: { tag: TENNIS_LABEL_TAG, strategies: tennisStrategies, note: TENNIS_LABEL_NOTE },
    priceSideNote: "ценовые части срезов от меток не зависят по построению — отсутствие сдвига там ожидаемо",
    note: `пере-снимок потребителей меток: ${was.size} переворотов, ${cells.length} ячеек перечитано ТЕМ ЖЕ кодом `
      + `на ДОмиграционном наборе (база не писалась). Гейт e5: ${gate.changed ? "ВЕРДИКТ СМЕНИЛСЯ" : "вердикт прежний"}. `
      + `Теннис в проход НЕ входит и несёт постоянную пометку ${TENNIS_LABEL_TAG}.`,
  };
}

/** Строка для еженедельника. */
export function labelEpochLine(s: LabelEpochSnapshot): string {
  const gold = s.cells.find((c) => c.cell === "golden:prematch_value×totals");
  return `label_epoch: ${s.flipsTotal} переворотов · золотая ${gold?.before ?? "н/д"}%→${gold?.after ?? "н/д"}%`
    + ` · гейт e5 ${s.gate.changed ? `${s.gate.before}→${s.gate.after}` : s.gate.after}`
    + ` · теннис ${TENNIS_LABEL_TAG}`;
}
