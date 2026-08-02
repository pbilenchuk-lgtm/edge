// ============================================================
// EDGE LAB — РЕЕСТР РАТИФИКАЦИЙ  [O7, амендмент к ТЗ наблюдаемости; решение владельца 02.08.2026]
//
// ЧЕТЫРЕ ЭКЗЕМПЛЯРА ОДНОГО КЛАССА ЗА ОДНИ СУТКИ — это четыре слишком много:
//   1. Z2 (метка куска = исход рынка) — ратифицировано трижды, доехало на четвёртый раз;
//   2. quasi_locked_tail — доехал МЁРТВЫМ (сравнение с прозой вместо поля);
//   3. Фаза 1.3 (conservative-2.0) — неделю лежала в коде, прод торговал по 1.0;
//   4. P2-гигиена тенниса (счёт в карточку из терминального снапшота) — не доехало вовсе.
//
// ПОЧЕМУ МАНИФЕСТА НЕДОСТАТОЧНО. `ratifiedManifest` держит МОДУЛИ: файл есть, файл вызывается. Но
// ратификация — это не всегда модуль. «Пиши сеты в карточку при финише» — строка ТЗ; она не имеет файла,
// не имеет вызывающего пути и потому невидима для манифеста ПО ПОСТРОЕНИЮ. Четвёртый экземпляр вылез
// именно там, где механизм слеп, и это не совпадение: слепое пятно и есть место, где копится долг.
//
// ЧТО ДЕЛАЕТ РЕЕСТР. Каждая ратификация — строка со статусом. `pending` старше срока печатается той же
// строкой «ЗАВЕСТИ РАССЛЕДОВАНИЕ», что и мёртвая фича у ratifiedWatch: ноль движения по ратифицированному
// — сигнал, а не тишина.
//
// ЧЕГО РЕЕСТР НЕ ДЕЛАЕТ. Не является археологией всех прошлых ТЗ — это недели работы и не окупается.
// Наполнение ровно двумя путями: (а) известные экземпляры класса задним числом, для честности истории;
// (б) КАЖДАЯ НОВАЯ РАТИФИКАЦИЯ ИЗ ЧАТА — обязательная строка при взятии в работу. Второе важнее первого:
// реестр ценен не полнотой прошлого, а тем, что новое в него попадает без исключений.
// ============================================================

import type { Database } from "./db.js";

export interface Ratification {
  id: string;
  /** Дата ратификации (ISO-дата). От неё считается «сколько висит». */
  at: string;
  /** Откуда: номер ТЗ / батча / «чат». Чтобы формулировку можно было найти в первоисточнике. */
  source: string;
  /** Формулировка ОДНОЙ строкой — так, как её понял исполнитель. Расхождение с первоисточником видно сразу. */
  statement: string;
  status: "deployed" | "pending";
  /** Чем закрыто: PR/коммит. У `pending` — null по определению. */
  closedBy: string | null;
  /** Для честности истории: сколько эта ратификация ПРОЛЕЖАЛА, если доехала с опозданием. */
  lateDays?: number;
}

/** Срок, после которого `pending` перестаёт быть «в работе» и становится расследованием. */
export const RATIFICATION_PENDING_DAYS = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number(env.RATIFICATION_PENDING_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
};

export const RATIFICATIONS: Ratification[] = [
  // ── (а) Известные экземпляры класса, задним числом. История обязана быть честной, включая то,
  //        что мы узнали о ней поздно.
  {
    id: "z2-piece-label", at: "2026-07-24", source: "batch5 Z2(а), подтв. batch10 R6",
    statement: "метка куска = исход РЫНКА, а не знак P&L; судьба куска — отдельным полем piece_pnl",
    status: "deployed", closedBy: "#105 (восстановление pieceRelabel) + #108 (наблюдаемость)", lateDays: 9,
  },
  {
    id: "phase-1.3-conservative", at: "2026-07-25", source: "Audit Phase 1.3",
    statement: "conservative — тот же сигнал, меньший размер: пороги входа равны medium (5% / 0.45 / $1000)",
    status: "deployed", closedBy: "#103 (миграция пресетов, эпоха e10)", lateDays: 8,
  },
  {
    id: "tennis-p2-score-card", at: "2026-07-14", source: "первое теннисное ТЗ, P2-гигиена",
    statement: "счёт ?:? у finished при живом скауте — резолвить финальный счёт в карточку из терминального снапшота",
    status: "deployed", closedBy: "#110 (finishTennisMatches + backfillTennisScores)", lateDays: 19,
  },
  {
    id: "clv-closing-line", at: "2026-07-29", source: "batch12 пункт 6",
    statement: "CLV меряется по ЛИНИИ ЗАКРЫТИЯ из снимков, а не по bets.closing_price (там своя цена выхода)",
    status: "deployed", closedBy: "#104 (восстановление clv.ts после моего отката)", lateDays: 4,
  },

  // ── (б) Новые ратификации из чата. Строка заводится ПРИ ВЗЯТИИ В РАБОТУ, а не после.
  {
    id: "observability-o5-line", at: "2026-08-02", source: "ТЗ наблюдаемости, O5",
    statement: "строка = машиночитаемый префикс (точка/вердикт/код причины/config_hash) + человеческий хвост; причины из словаря",
    status: "deployed", closedBy: "#113 (logLine + reasonsOutsideDictionary; старые строки не переписываются массово)", lateDays: 0,
  },
  {
    id: "bound-no-score-chase", at: "2026-08-02", source: "чат, решение 1",
    statement: "счёт для bound_no_score добирается штатным score-sync через date-гейт; противоречие сеттлам → settle_suspect на группу, не тихая перезапись",
    status: "deployed", lateDays: 0,
    closedBy: "#114 (boundNoScoreChase: хранимая привязка ПЕРЕПРОВЕРЯЕТСЯ сегодняшними гейтами — sameTeams/date/ориентация теми же функциями, что и живой enrich; противоречие сеттлу → карантин на группу и НИ ОДНОЙ записи счёта; bound_no_score — код словаря)",
  },
  {
    id: "observability-o2-funnel", at: "2026-08-02", source: "ТЗ наблюдаемости, O2",
    statement: "воронка со законом сохранения: вход стадии = выход + отбраковка с причинами; расхождение — алерт",
    status: "deployed", closedBy: "#112 (entryFunnel: словарь причин, НЕВЯЗКА, базлайны против медианы 7д)", lateDays: 0,
  },
  {
    id: "observability-o3-loud-zero", at: "2026-08-02", source: "ТЗ наблюдаемости, O3",
    statement: "каждая периодическая джоба печатает строку завершения БЕЗУСЛОВНО + last_run_at в app_meta",
    status: "deployed", closedBy: "#112 (jobHeartbeat: запуск как ДАННЫЕ + одна сводная строка на цикл)", lateDays: 0,
  },
  {
    id: "observability-o4-heartbeat", at: "2026-08-02", source: "ТЗ наблюдаемости, O4",
    statement: "каждый манифестный гейт ведёт суточный счётчик evaluated/triggered; evaluated=0 при живой торговле → расследование",
    status: "deployed", closedBy: "#113 (gateHeartbeat; гейты БЕЗ знаменателя честно помечены «не измеряется», а не закрашены нулём)", lateDays: 0,
  },
  {
    id: "observability-o6-acceptance", at: "2026-08-02", source: "ТЗ наблюдаемости, O6",
    statement: "приёмка = симуляция инцидента: сдвиг порога ловится ТРЕМЯ независимыми сигналами (воронка, full_drift, базлайн)",
    status: "deployed", closedBy: "#113 (observabilityAcceptance: обе симуляции, три независимых источника)", lateDays: 0,
  },
];

export interface RatificationRow extends Ratification {
  ageDays: number;
  verdict: "закрыта" | "в работе" | "РАССЛЕДОВАТЬ";
  note: string;
}
export interface RatificationRegistry {
  total: number; deployed: number; pending: number;
  investigate: RatificationRow[];
  rows: RatificationRow[];
  /** Средняя задержка доехавших — цена класса в днях, а не в ощущениях. */
  meanLateDays: number | null;
  note: string;
}

/**
 * `list` подставляется ТОЛЬКО тестами сторожа и по одной причине: пустой backlog — это ХОРОШЕЕ состояние,
 * и оно не имеет права ломать проверку самого сторожа. Когда 02.08 закрылась последняя pending-строка,
 * три теста «зависшее обязано кричать» упали — не потому что сторож сломался, а потому что были написаны
 * против ЖИВОГО списка. Сторож проверяется на своём поведении, а не на текущем содержимом долга.
 */
export function buildRatificationRegistry(
  _db: Database, nowMs = Date.now(), env: Record<string, string | undefined> = process.env,
  list: readonly Ratification[] = RATIFICATIONS,
): RatificationRegistry {
  const limit = RATIFICATION_PENDING_DAYS(env);
  const rows: RatificationRow[] = list.map((r) => {
    const ageDays = Math.floor((nowMs - Date.parse(r.at)) / 86_400_000);
    const verdict: RatificationRow["verdict"] = r.status === "deployed" ? "закрыта"
      : ageDays >= limit ? "РАССЛЕДОВАТЬ" : "в работе";
    return {
      ...r, ageDays, verdict,
      note: verdict === "закрыта"
        ? `закрыта ${r.closedBy ?? "?"}${r.lateDays ? ` · пролежала ${r.lateDays}д` : ""}`
        : verdict === "в работе" ? `${ageDays}д из ${limit} — срок не вышел`
        : `${ageDays}д ≥ ${limit} БЕЗ движения — ратифицировано и не доехало, ЗАВЕСТИ РАССЛЕДОВАНИЕ: ${r.statement}`,
    };
  });
  const late = RATIFICATIONS.filter((r) => typeof r.lateDays === "number").map((r) => r.lateDays!);
  const investigate = rows.filter((r) => r.verdict === "РАССЛЕДОВАТЬ");
  return {
    total: rows.length,
    deployed: rows.filter((r) => r.status === "deployed").length,
    pending: rows.filter((r) => r.status === "pending").length,
    investigate, rows,
    meanLateDays: late.length ? Math.round((late.reduce((a, b) => a + b, 0) / late.length) * 10) / 10 : null,
    note: investigate.length
      ? `⚠ ${investigate.length} ратификац. висят ≥${limit}д без движения — ЗАВЕСТИ РАССЛЕДОВАНИЕ по каждой. `
        + `Класс уже стоил нам четырёх экземпляров${late.length ? ` со средней задержкой ${Math.round((late.reduce((a, b) => a + b, 0) / late.length) * 10) / 10}д` : ""}.`
      : `движение есть по всем ратификациям в сроке${late.length ? ` · средняя историческая задержка доехавших: ${Math.round((late.reduce((a, b) => a + b, 0) / late.length) * 10) / 10}д` : ""}.`,
  };
}

/** Одна строка для еженедельника — «объявись сам», тем же тоном, что ratifiedWatch. */
export function ratificationLine(reg: RatificationRegistry): string {
  return reg.investigate.length
    ? `ratifications: ${reg.pending} в работе, из них ${reg.investigate.length} ЗАВИСЛИ — ${reg.investigate.map((r) => r.id).join(", ")}`
    : `ratifications: ${reg.deployed} закрыто, ${reg.pending} в работе, зависших нет`;
}
