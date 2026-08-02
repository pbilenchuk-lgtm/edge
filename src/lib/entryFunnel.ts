// ============================================================
// EDGE LAB — ВОРОНКА ВХОДА С ЗАКОНОМ СОХРАНЕНИЯ  [O2 из ТЗ «Наблюдаемость решений»]
//
// Прямой ответ на «входов нет — где проблема?». 29.07 воронка дала 0 входов при живом календаре, и
// поиск причины занял дни: снаружи «анализ идёт, ставок нет» неотличимо от «анализ идёт, а сетап не
// совпал». Инцидент пресета выглядел ровно так же — и был бы виден в первый час строкой
//   «анализ 3 · входы 0 · причина: калибровка < 0.55 (18 из 24 отказов)».
//
// ЧТО ЗДЕСЬ СЧИТАЕТСЯ И ПОЧЕМУ ИМЕННО ТАК. Воронка НЕ инструментирует горячий путь новыми счётчиками:
// каждая её стадия уже оставляет след в `trade_log`/`bets`, и вторая система учёта рядом с первой — это
// ровно тот класс двух авторитетов, который мы весь день выкорчёвывали. Поэтому воронка ВОССТАНАВЛИВАЕТСЯ
// из тех же записей, по которым потом спорят.
//
// ЗАКОН СОХРАНЕНИЯ — ЧЕСТНЫЙ ВАРИАНТ. Утверждать «вход стадии = выход + отбраковка» здесь было бы враньём:
// причины читаются из ПРОЗЫ, а проза неполна по построению. Вместо равенства считается НЕВЯЗКА: сколько
// отказов не удалось отнести ни к одной причине словаря. Невязка — сама по себе алерт: она означает, что
// путь пишет причину, которой словарь не знает, то есть словарь отстал от кода. Ноль невязки не
// доказывает полноту, но НЕнулевая доказывает пробел — а это ровно то, что нужно ловить.
//
// СЛОВАРЬ, А НЕ FREE-TEXT (O5). Новая причина = явное добавление сюда. Утечка в `other` — немой ноль по
// построению, поэтому `other` здесь не корзина «прочее», а СЧЁТЧИК НЕВЯЗКИ с образцами строк.
// ============================================================

import type { Database } from "./db.js";

/** Стадии воронки. Порядок значим: каждая следующая — подмножество предыдущей. */
export type FunnelStage = "analysed" | "picked" | "proposed" | "entered";

/** Словарь причин отбраковки. `test` обязан совпадать с тем, что ПИШЕТ код (strategist.ts / analysis.ts),
 *  а не с тем, как о причине говорят люди — сторож, построенный против прозы, уже подводил дважды. */
export interface RejectReason { code: string; test: RegExp; what: string; stage: FunnelStage }

export const REJECT_REASONS: RejectReason[] = [
  // ── гейты профиля (strategist.sizePrematch) — сюда бьёт инцидент пресета
  { code: "below_calibration", test: /калибровка [\d.]+ < [\d.]+/, stage: "picked", what: "калибровка ниже порога профиля" },
  { code: "below_edge", test: /edge [\d.]+% < порога [\d.]+%/, stage: "picked", what: "край ниже порога профиля" },
  { code: "kelly_nonpositive", test: /Kelly-край по фактической цене ≤ 0/, stage: "picked", what: "Kelly по фактической цене неположителен" },
  { code: "liquidity_floor", test: /ликвидность \$[\d]+ < floor/, stage: "picked", what: "рынок ниже пола ликвидности" },
  { code: "rail_price_market", test: /цена у планки \([\d.]+¢\) — рынок фактически решён/, stage: "picked", what: "цена у планки — край фантомный" },
  // ── капы и бюджет
  { code: "cap_cluster", test: /исчерпан кэп коррелированной группы/, stage: "proposed", what: "кэп коррелированной группы" },
  { code: "cap_match", test: /исчерпан кэп экспозиции на матч/, stage: "proposed", what: "кэп экспозиции на матч" },
  { code: "budget_pair", test: /бюджет пары исчерпан|нет бюджета пары|нет бюджета на турнире/, stage: "proposed", what: "бюджет пары/турнира исчерпан" },
  { code: "dust", test: /размер округлился до нуля/, stage: "proposed", what: "размер округлился до нуля" },
  // ── предохранители (flag — блокировка, а не отказ по порогу)
  { code: "absurd_edge", test: /absurd_edge_block|live_absurd_cap/, stage: "picked", what: "абсурдный край — вероятный баг, вход заблокирован" },
  { code: "live_divergence", test: /live_divergence_block/, stage: "picked", what: "расхождение модели и рынка в live — вероятная ошибка данных" },
  { code: "sizing_insanity", test: /sizing_insanity/, stage: "proposed", what: "размер вне здравого смысла — вход заблокирован" },
  { code: "bad_input", test: /некорректная (цена\/вероятность|вероятность модели)/, stage: "picked", what: "негодные входные числа" },
  // ── решения стратега и доски (analysis.ts)
  { code: "strategist_zero_picks", test: /стратег вернул 0 picks/, stage: "analysed", what: "стратег сознательно отказался от матча целиком" },
  { code: "dead_board", test: /dead_board_llm_saved/, stage: "analysed", what: "доска мертва (планка/зеркала) — стратег не вызван" },
  { code: "self_refuted", test: /самоопроверг|self_refuted/, stage: "picked", what: "стратег опроверг собственный pick своими же числами" },
  { code: "unfillable", test: /unfillable|книга не держит|исполнимость/i, stage: "proposed", what: "книга не держит минимальный размер" },
];

export interface FunnelDay {
  day: string;
  /** Матчи, по которым в этот день была хоть одна запись анализа. */
  analysed: number;
  /** Записи входа (ставки), созданные в этот день. */
  entered: number;
  /** Отказы по причинам словаря. */
  byReason: Record<string, number>;
  /** НЕВЯЗКА: строки-отказы, не отнесённые ни к одной причине. Сама по себе алерт. */
  unattributed: number;
  /** Образцы неотнесённых строк — чтобы словарь можно было дополнить, а не гадать. */
  unattributedSamples: string[];
  /** Топ-3 причины дня. */
  top: { code: string; n: number; what: string }[];
}

export interface FunnelBaseline {
  metric: "entered" | "analysed";
  today: number;
  /** Медиана предыдущих 7 дней — медиана, а не среднее: один выброс не должен двигать базу. */
  median7: number;
  dropPct: number | null;
  alert: boolean;
  note: string;
}

export interface EntryFunnelReport {
  days: FunnelDay[];
  baselines: FunnelBaseline[];
  investigate: string[];
  note: string;
}

/** Падение относительно базы, при котором заводится расследование. Фиксировано до данных. */
export const FUNNEL_DROP_ALERT_PCT = 60;

const dayOf = (iso: string | null | undefined) => String(iso ?? "").slice(0, 10);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10;
}

/**
 * Воронка за последние `days` дней. Только чтение.
 *
 * Знаменатель «analysed» берётся по МАТЧАМ с записью анализа, а не по строкам лога: один матч с двадцатью
 * отказами — это один разобранный матч, а не двадцать. Иначе «разобрано» надувалось бы отказами, и падение
 * входов выглядело бы падением конверсии, а не падением потока.
 */
export function buildEntryFunnel(db: Database, opts: { days?: number; nowMs?: number } = {}): EntryFunnelReport {
  const days = Math.max(2, opts.days ?? 14);
  const nowMs = opts.nowMs ?? Date.now();
  const fromIso = new Date(nowMs - days * 86_400_000).toISOString();

  const logs = db.prepare(
    `SELECT t.created_at AS at, t.text AS text, t.match_id AS mid, t.type AS type
       FROM trade_log t WHERE t.created_at >= ? AND t.type IN ('skip','flag')`,
  ).all(fromIso) as { at: string; text: string; mid: string; type: string }[];

  const analysedRows = db.prepare(
    `SELECT DISTINCT substr(created_at,1,10) AS d, match_id AS mid FROM trade_log WHERE created_at >= ?`,
  ).all(fromIso) as { d: string; mid: string }[];

  const bets = db.prepare(
    `SELECT substr(created_at,1,10) AS d, COUNT(*) n FROM bets WHERE created_at >= ? GROUP BY d`,
  ).all(fromIso) as { d: string; n: number }[];

  const byDay = new Map<string, FunnelDay>();
  const dayRec = (d: string): FunnelDay => {
    let x = byDay.get(d);
    if (!x) { x = { day: d, analysed: 0, entered: 0, byReason: {}, unattributed: 0, unattributedSamples: [], top: [] }; byDay.set(d, x); }
    return x;
  };

  const seen = new Map<string, Set<string>>();
  for (const r of analysedRows) {
    const s = seen.get(r.d) ?? new Set<string>(); s.add(r.mid); seen.set(r.d, s);
  }
  for (const [d, s] of seen) dayRec(d).analysed = s.size;
  for (const b of bets) dayRec(b.d).entered = Number(b.n) || 0;

  for (const l of logs) {
    const d = dayOf(l.at);
    const rec = dayRec(d);
    const hit = REJECT_REASONS.find((x) => x.test.test(l.text));
    if (hit) rec.byReason[hit.code] = (rec.byReason[hit.code] ?? 0) + 1;
    else {
      rec.unattributed++;
      if (rec.unattributedSamples.length < 5) rec.unattributedSamples.push(l.text.slice(0, 160));
    }
  }

  const out = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const d of out) {
    d.top = Object.entries(d.byReason)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([code, n]) => ({ code, n, what: REJECT_REASONS.find((r) => r.code === code)?.what ?? code }));
  }

  // ── БАЗЛАЙНЫ. База — медиана ПРЕДЫДУЩИХ дней, сегодняшний в неё не входит (иначе провал сам себя
  //    и оправдает). Алерт только при живом знаменателе: ноль входов при нуле разобранных матчей —
  //    не деградация, а выходной, и путать их значит приучить владельца игнорировать сигнал.
  const today = out[0];
  const prior = out.slice(1, 8);
  const baselines: FunnelBaseline[] = (["entered", "analysed"] as const).map((metric) => {
    const cur = today ? today[metric] : 0;
    const med = median(prior.map((d) => d[metric]));
    const dropPct = med > 0 ? Math.round(((med - cur) / med) * 1000) / 10 : null;
    const liveCalendar = (today?.analysed ?? 0) > 0;
    const alert = med > 0 && dropPct != null && dropPct >= FUNNEL_DROP_ALERT_PCT && (metric === "analysed" || liveCalendar);
    return {
      metric, today: cur, median7: med, dropPct, alert,
      note: med === 0 ? `базы нет (медиана 7д = 0) — сравнивать не с чем`
        : !alert ? `${cur} против медианы ${med}${dropPct != null ? ` (${dropPct > 0 ? "−" : "+"}${Math.abs(dropPct)}%)` : ""} — в пределах`
        : `${cur} против медианы ${med} — падение ${dropPct}% ≥ ${FUNNEL_DROP_ALERT_PCT}% ПРИ ЖИВОМ КАЛЕНДАРЕ (разобрано ${today?.analysed ?? 0}) → ЗАВЕСТИ РАССЛЕДОВАНИЕ`,
    };
  });

  const investigate: string[] = [];
  for (const b of baselines) if (b.alert) investigate.push(`${b.metric}: ${b.note}`);
  if (today && today.unattributed > 0) {
    investigate.push(
      `НЕВЯЗКА словаря: ${today.unattributed} отказ(ов) не отнесены ни к одной причине — путь пишет причину, `
      + `которой словарь не знает. Образцы: ${today.unattributedSamples.map((s) => `«${s}»`).join(" · ")}`,
    );
  }

  return {
    days: out, baselines, investigate,
    note: investigate.length
      ? `⚠ воронка требует расследования (${investigate.length}): ` + investigate.join(" || ")
      : today
        ? `сегодня: разобрано ${today.analysed} · входов ${today.entered}` + (today.top.length ? ` · топ отказов: ${today.top.map((t) => `${t.code}×${t.n}`).join(", ")}` : " · отказов нет")
        : "данных за окно нет",
  };
}

/** Одна строка для еженедельника/самоотчёта. */
export function funnelLine(rep: EntryFunnelReport): string {
  const t = rep.days[0];
  if (!t) return "funnel: данных нет";
  return `funnel: разобрано ${t.analysed} · входов ${t.entered}`
    + (t.top.length ? ` · топ-3 отказа: ${t.top.map((x) => `${x.code}×${x.n}`).join(", ")}` : "")
    + (t.unattributed ? ` · НЕВЯЗКА ${t.unattributed}` : "")
    + (rep.investigate.length ? ` · ⚠ РАССЛЕДОВАТЬ (${rep.investigate.length})` : "");
}
