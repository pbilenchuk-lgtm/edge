// ============================================================
// EDGE LAB — ПУЛЬС ГЕЙТОВ: «ФАЙЛ ЖИВ» → «ПУТЬ РАБОТАЕТ»  [O4 из ТЗ наблюдаемости]
//
// Манифест доказывает, что модуль есть и его кто-то импортирует. Этого мало: импорт может стоять в ветке,
// куда поток не заходит месяцами. quasi_locked_tail именно так и доехал МЁРТВЫМ — вызов был, срабатываний
// не было, и никто этого не видел, пока не начали считать.
//
// ЧЕСТНАЯ ГРАНИЦА, КОТОРУЮ Я ОБЯЗАН НАЗВАТЬ. `triggered` (гейт сработал) считается по уликам, которые путь
// УЖЕ пишет — это ratifiedWatch и он работает. `evaluated` (гейт был спрошен) в общем случае следа не
// оставляет: спросить предохранитель и получить «нет» — это событие без записи по построению. Считать его
// можно ровно там, где у пути ЕСТЬ СВОЙ ЗНАМЕНАТЕЛЬ, который он и так возвращает: pieceRelabel знает
// `scanned`, voidWatch — `decided`, clv — покрытие, пере-сеттл — размер карантина.
//
// Поэтому здесь НЕ заводится вторая система учёта (тот самый класс двух авторитетов). Гейты ПУБЛИКУЮТ свой
// уже существующий знаменатель, а те, у кого его нет, получают `evaluated: null` и статус «не измеряется».
// Это слабее, чем «каждый гейт ведёт счётчик», и я предпочитаю назвать разрыв, а не закрасить его нулём:
// ноль означал бы «спрашивали и всегда получали нет», то есть ЛОЖНУЮ тревогу вместо честного «не знаем».
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

const KEY = (key: string, day: string) => `gate:${key}:${day}`;

export interface GatePulse { evaluated: number | null; triggered: number }

/** Зафиксировать дневной пульс гейта. Суммируется в пределах дня: тик добавляет к тому, что уже есть. */
export function recordGatePulse(db: Database, key: string, pulse: GatePulse, nowIso: string): void {
  const day = nowIso.slice(0, 10);
  try {
    const prev = readGatePulse(db, key, day);
    const merged: GatePulse = {
      evaluated: pulse.evaluated == null && prev?.evaluated == null ? null : (prev?.evaluated ?? 0) + (pulse.evaluated ?? 0),
      triggered: (prev?.triggered ?? 0) + pulse.triggered,
    };
    R.metaSet(db, KEY(key, day), JSON.stringify(merged), nowIso);
  } catch { /* учёт не роняет то, что учитывает */ }
}

export function readGatePulse(db: Database, key: string, day: string): GatePulse | null {
  try { const raw = R.metaGet(db, KEY(key, day)); return raw ? (JSON.parse(raw) as GatePulse) : null; } catch { return null; }
}

/** Гейты, у которых знаменатель ЕСТЬ, и откуда он берётся. Список явный — «гейта нет в пульсе» иначе
 *  неотличимо от «мы про него забыли», ровно как с перечнем джоб. */
export interface GateSpec {
  key: string;
  /** Модуль в манифесте — связь «предохранитель ↔ его пульс» должна быть проверяемой. */
  module: string;
  /** Откуда берётся знаменатель; `null` = у пути его нет, и мы говорим это вслух. */
  evaluatedFrom: string | null;
  what: string;
}

export const GATE_SPECS: GateSpec[] = [
  { key: "piece_relabel", module: "src/lib/pieceRelabel.ts", evaluatedFrom: "scanned (куски, закрытые досрочно)", what: "метка куска переставлена по исходу рынка" },
  { key: "resettle_suspect", module: "src/lib/suspectBreakdown.ts", evaluatedFrom: "размер карантина на входе прохода", what: "карантинная ставка снята с флага" },
  { key: "future_finished", module: "src/lib/futureFinished.ts", evaluatedFrom: "scanned (просмотренные матчи)", what: "матч, «сыгранный» до кикоффа, сброшен" },
  { key: "tennis_score_card", module: "src/lib/tennisTrading.ts", evaluatedFrom: "scanned (теннис-финалы)", what: "счёт по сетам записан в карточку" },
  { key: "clv_leg", module: "src/lib/clv.ts", evaluatedFrom: "покрытие (все ноги когорты)", what: "CLV посчитан по реальной линии закрытия" },
  { key: "void_watch", module: "src/lib/voidWatch.ts", evaluatedFrom: "decided (решённые ставки окна)", what: "возврат замечен счётчиком" },
  // Знаменателя нет и не будет: спросить предохранитель и получить «нет» следа не оставляет.
  { key: "score_race", module: "src/lib/scoreRace.ts", evaluatedFrom: null, what: "переоценка отложена: снимок отстал от своей ленты событий" },
  { key: "sizing_insanity", module: "src/lib/strategist.ts", evaluatedFrom: null, what: "размер вне здравого смысла заблокирован" },
];

export interface GateRow extends GateSpec {
  evaluated: number | null; triggered: number; days: number;
  verdict: "работает" | "НЕ ИЗМЕРЯЕТСЯ" | "РАССЛЕДОВАТЬ" | "нет потока";
  note: string;
}
export interface GateHeartbeatReport {
  windowDays: number; tradedInWindow: number;
  rows: GateRow[]; investigate: GateRow[]; note: string;
}

/** Сколько дней подряд `evaluated>0` при `triggered=0` терпится, прежде чем это станет расследованием. */
export const GATE_SILENT_DAYS = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number(env.GATE_SILENT_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 3;
};

export function buildGateHeartbeat(
  db: Database, nowMs = Date.now(), env: Record<string, string | undefined> = process.env,
): GateHeartbeatReport {
  const windowDays = GATE_SILENT_DAYS(env);
  const days: string[] = [];
  for (let i = 0; i < windowDays; i++) days.push(new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10));
  const fromIso = new Date(nowMs - windowDays * 86_400_000).toISOString();
  const traded = Number((db.prepare(`SELECT COUNT(*) n FROM bets WHERE created_at >= ?`).get(fromIso) as any)?.n ?? 0);

  const rows: GateRow[] = GATE_SPECS.map((g) => {
    let evaluated: number | null = null, triggered = 0, anyEval = false;
    for (const d of days) {
      const p = readGatePulse(db, g.key, d);
      if (!p) continue;
      triggered += p.triggered;
      if (p.evaluated != null) { evaluated = (evaluated ?? 0) + p.evaluated; anyEval = true; }
    }
    const verdict: GateRow["verdict"] =
      g.evaluatedFrom == null ? (triggered > 0 ? "работает" : "НЕ ИЗМЕРЯЕТСЯ")
      : triggered > 0 ? "работает"
      : !anyEval || (evaluated ?? 0) === 0 ? "нет потока"
      : traded === 0 ? "нет потока"
      : "РАССЛЕДОВАТЬ";
    return {
      ...g, evaluated, triggered, days: windowDays, verdict,
      note: verdict === "работает" ? `сработал ${triggered} раз(а) за ${windowDays}д${evaluated != null ? ` из ${evaluated} проверок` : ""}`
        : verdict === "НЕ ИЗМЕРЯЕТСЯ" ? `знаменателя у пути НЕТ (спросить предохранитель и получить «нет» следа не оставляет) — ноль здесь не доказывает ни работы, ни смерти`
        : verdict === "нет потока" ? `проверок ${evaluated ?? 0} за ${windowDays}д — поток не шёл, ноль ничего не доказывает`
        : `${evaluated} проверок за ${windowDays}д и НИ ОДНОГО срабатывания при живой торговле (${traded} ставок) — подозрение на мёртвую ветку: ${g.what}`,
    };
  });

  const investigate = rows.filter((r) => r.verdict === "РАССЛЕДОВАТЬ");
  const unmeasured = rows.filter((r) => r.verdict === "НЕ ИЗМЕРЯЕТСЯ").length;
  return {
    windowDays, tradedInWindow: traded, rows, investigate,
    note: investigate.length
      ? `⚠ ${investigate.length} гейт(ов) спрашивались и ни разу не сработали за ${windowDays}д при живой торговле — ЗАВЕСТИ РАССЛЕДОВАНИЕ`
      : `гейты: срабатывают либо не имели потока${unmeasured ? ` · ${unmeasured} без знаменателя (честно не измеряются)` : ""}`,
  };
}

/** Строка для еженедельника. */
export function gateLine(rep: GateHeartbeatReport): string {
  const work = rep.rows.filter((r) => r.verdict === "работает").length;
  return `gate_pulse: работают ${work}/${rep.rows.length}`
    + (rep.investigate.length ? ` · ⚠ РАССЛЕДОВАТЬ: ${rep.investigate.map((r) => r.key).join(", ")}` : "")
    + ` · без знаменателя ${rep.rows.filter((r) => r.verdict === "НЕ ИЗМЕРЯЕТСЯ").length}`;
}
