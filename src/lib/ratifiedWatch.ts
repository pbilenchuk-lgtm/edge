// ============================================================
// EDGE LAB — РАТИФИЦИРОВАННАЯ ФИЧА ОБЯЗАНА ДОКАЗАТЬ ПЕРВОЕ СРАБАТЫВАНИЕ  [Поправка 1, batch-12]
//
// Второй случай класса «ратифицировано и не работает». Z2 (метка куска) не доезжал ТРИЖДЫ. R1 (quasi-locked
// хвост) доехал МЁРТВЫМ: `d.reason === "take_profit"` сравнивал машинный дискриминатор с человеческой прозой
// и не совпадал никогда. Оба раза счётчик честно печатал ноль, и оба раза правило «0 = путь не проверен»
// два батча подряд никого не заставило копнуть — потому что строка в отчёте не является действием.
//
// Отсюда правило: у каждой ратифицированной фичи есть СРОК. Ноль срабатываний дольше RATIFIED_ZERO_DAYS
// (по умолчанию 3) при живой торговле — это не «мало данных», а подозрение на мёртвую проводку, и оно
// поднимается как ЗАДАЧА-РАССЛЕДОВАНИЕ, а не как строка. Фича, не доказавшая ни одного срабатывания,
// ратификацией не является — она литература.
//
// ВАЖНО: срок отсчитывается от деплоя фичи И требует, чтобы торговля в окне вообще шла. Иначе ноль означает
// пустой слейт, а не мёртвый код — ровно та ошибка знаменателя, на которой мы уже спотыкались дважды
// (воронка 166→10 и «ноль блокировок sizing_insanity»).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

export const RATIFIED_ZERO_DAYS = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.RATIFIED_ZERO_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 3;
};

/** Ратифицированная фича + УЛИКА её срабатывания. Улика обязана быть машинной: подстрока, которую пишет
 *  сам путь фичи, а не слово из человеческого текста — иначе сторож повторит баг, который он ловит. */
export interface RatifiedFeature {
  key: string;                 // как называть в отчёте
  marker: string;              // подстрока-улика, которую пишет ТОЛЬКО этот путь
  /** ГДЕ живёт улика. Сторож искал её только в trade_log — и на первом же проде выдал ЛОЖНУЮ тревогу по
   *  dust_floor, который пишет причину в `bets.rationale`. Сторож, построенный против мёртвой проводки,
   *  сам оказался разведён мимо. Место улики — часть её описания, а не допущение. */
  where: "trade_log" | "bet_rationale";
  ratifiedAt: string;          // ISO даты ратификации/деплоя — от неё считается срок
  what: string;                // что именно означает срабатывание (для расследования)
}

/** Реестр. Добавление фичи сюда — часть её ратификации, а не опция. */
export const RATIFIED: RatifiedFeature[] = [
  { key: "quasi_locked_tail", marker: "quasi_locked_tail", where: "trade_log", ratifiedAt: "2026-07-24",
    what: "тейк подавлен, потому что счёт математически запер рынок — хвост досиживается до резолюции (R1)" },
  { key: "thesis_cap_clamp", marker: "thesis_cap_clamp", where: "trade_log", ratifiedAt: "2026-07-27",
    what: "тезисный кэп подрезал заливку (не заблокировал целиком)" },
  { key: "ft_blind_placeholder", marker: "ft_blind_placeholder", where: "trade_log", ratifiedAt: "2026-07-28",
    what: "слепой вход отклонён по mid-плейсхолдеру (W2)" },
  { key: "ft_blind_min_stake", marker: "ft_blind_min_stake", where: "trade_log", ratifiedAt: "2026-07-28",
    what: "слепой вход отклонён как пыль < $5 (W2)" },
  { key: "ft_blind_late_fill", marker: "ft_blind_late_fill", where: "trade_log", ratifiedAt: "2026-07-29",
    what: "слепой вход отклонён, потому что филл пришёлся на идущий матч, а не на грейс от старта (п.5)" },
  { key: "piece_relabel", marker: "piece_relabel", where: "trade_log", ratifiedAt: "2026-07-28",
    what: "метка куска переставлена по исходу РЫНКА (W1/Z2)" },
  { key: "dust_floor", marker: "dust_floor", where: "bet_rationale", ratifiedAt: "2026-07-26",
    what: "остаток дешевле собственного выхода закрыт целиком (R6)" },
];

export interface RatifiedRow {
  key: string; what: string; hits: number; lastHit: string | null;
  daysSinceRatified: number; verdict: "работает" | "РАССЛЕДОВАТЬ" | "ждём" | "нет торговли";
  note: string;
}
export interface RatifiedWatchReport {
  tradedInWindow: number; investigate: RatifiedRow[]; rows: RatifiedRow[]; note: string;
}

export function buildRatifiedWatch(
  db: Database, nowMs = Date.now(), env: Record<string, string | undefined> = process.env,
): RatifiedWatchReport {
  const days = RATIFIED_ZERO_DAYS(env);
  const now = new Date(nowMs).toISOString();
  // Знаменатель: шла ли торговля с момента самой ранней ратификации. Без него ноль неотличим от пустого слейта.
  const earliest = RATIFIED.reduce((a, f) => (f.ratifiedAt < a ? f.ratifiedAt : a), now);
  const traded = Number((db.prepare(`SELECT COUNT(*) n FROM bets WHERE created_at >= ?`).get(earliest) as any)?.n ?? 0);

  const rows: RatifiedRow[] = RATIFIED.map((f) => {
    const r = db.prepare(
      f.where === "bet_rationale"
        ? `SELECT COUNT(*) n, MAX(settled_at) last FROM bets WHERE rationale LIKE ? AND settled_at >= ?`
        : `SELECT COUNT(*) n, MAX(created_at) last FROM trade_log WHERE text LIKE ? AND created_at >= ?`,
    ).get(`%${f.marker}%`, f.ratifiedAt) as any;
    const hits = Number(r?.n ?? 0);
    const dsr = Math.floor((nowMs - Date.parse(f.ratifiedAt)) / 86_400_000);
    const verdict: RatifiedRow["verdict"] = hits > 0 ? "работает"
      : traded === 0 ? "нет торговли"
      : dsr >= days ? "РАССЛЕДОВАТЬ" : "ждём";
    return {
      key: f.key, what: f.what, hits, lastHit: r?.last ?? null, daysSinceRatified: dsr, verdict,
      note: verdict === "работает" ? `${hits} срабатыв., последнее ${r.last}`
        : verdict === "нет торговли" ? `торговли с ${f.ratifiedAt} не было — ноль ничего не доказывает`
        : verdict === "ждём" ? `${dsr}д из ${days} — срок не вышел`
        : `${dsr}д ≥ ${days} БЕЗ единого срабатывания при живой торговле (${traded} ставок) — подозрение на мёртвую проводку: ${f.what}`,
    };
  });
  const investigate = rows.filter((x) => x.verdict === "РАССЛЕДОВАТЬ");
  return {
    tradedInWindow: traded, investigate, rows,
    note: investigate.length
      ? `⚠ ${investigate.length} ратифицированных фич(и) не сработали ни разу за ${days}+ дней при живой торговле — ЗАВЕСТИ РАССЛЕДОВАНИЕ по каждой. Так уже было дважды: Z2 не доезжал трижды, R1-хвост доехал мёртвым (сравнение с прозой вместо поля).`
      : `все ратифицированные фичи либо доказали срабатывание, либо ещё в сроке.`,
  };
}
