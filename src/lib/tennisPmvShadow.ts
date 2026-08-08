// ============================================================
// EDGE LAB — PMV flag-only SHADOW SCORING  [SERVER-ONLY]
//
// The «немой ноль» fix: PMV flag-only logged the SIGNAL (theo vs mid) but produced no OUTCOME, so the
// Brier criterion was blind by construction — verdict:insufficient masking verdict:unmeasurable. This
// gives flag-only a real, scoreable dataset with ZERO money movement (no bet, no portfolio, no treasury):
//
//   1. RECORD — freeze the would-be entry at signal time: theo/mid/orientation captured as FIELDS, never
//      re-inferred at resolution. Dedup by rule: first per (match, prop) is frozen; repeats bump `hits`.
//   2. RESOLVE — post-match, via the SAME prop settlement code (resolveTennisProp), fail-closed and loud:
//      no result / unreadable detail / resolver throws → `unresolved` with a reason (a counted diagnostic),
//      never a silent skip.
//   3. SCORE — Brier(markov) vs Brier(implied) on the SAME frozen mid (one timestamp), win%-vs-theo, and
//      the unresolved share. CLV is NOT computed (no closing book for shadow) — stated honestly.
//
// Criterion clock starts at deploy: only rows recorded here count. Legacy text `flag_only` lines are NOT
// reconstructed (no frozen outcome/orientation — the inferred_backfill category, worse).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { resolveTennisProp, finalSetsFromRaw, propFirstIsP1, PMV_STRATEGY, PMV_PAPER_EPOCH } from "./tennisPmv.js";
import { tennisFinalResult } from "./tennisTrading.js";

export const PMV_SHADOW_EPOCH = "shadow-s1"; // bump when the shadow-scoring logic changes

export interface PmvShadowInput {
  matchId: string; label: string; family: string; side: string; firstIsP1: boolean | null;
  theoCents: number; midCents: number; deviation: number; delta: number; bookUsd: number;
  tour: string | null; surface: string | null; epoch: string; at: string;
}

/** Freeze a would-be PMV entry. Dedup by rule: the FIRST signal per (match, prop) is frozen; every repeat
 *  while the deviation holds only bumps `hits` — one persistent signal never inflates into many rows. */
export function recordPmvShadowSignal(db: Database, s: PmvShadowInput): void {
  db.prepare(
    `INSERT INTO pmv_shadow_signals
       (id, match_id, market_label, family, side, first_is_p1, theo_cents, mid_cents, deviation, delta, book_usd, tour, surface, epoch, hits, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'pending',?)
     ON CONFLICT(match_id, market_label) DO UPDATE SET hits = hits + 1`,
  ).run(R.uid(), s.matchId, s.label, s.family, s.side, s.firstIsP1 == null ? null : s.firstIsP1 ? 1 : 0,
    s.theoCents, s.midCents, s.deviation, s.delta, s.bookUsd, s.tour, s.surface, s.epoch, s.at);
}

/** Resolve pending shadow signals against finished matches — same settlement code as real PMV bets.
 *  Fail-closed: anything that can't resolve becomes `unresolved` WITH a reason, never a silent skip. */
export function resolvePmvShadowSignals(db: Database, deps: EngineDeps = {}): { resolved: number; unresolved: number } {
  const now = deps.now?.() ?? new Date().toISOString();
  let resolved = 0, unresolved = 0;
  const pend = db.prepare(`SELECT id, match_id, market_label, first_is_p1 FROM pmv_shadow_signals WHERE status='pending'`).all() as { id: string; match_id: string; market_label: string; first_is_p1: number | null }[];
  for (const s of pend) {
    const fin = tennisFinalResult(db, s.match_id);
    if (!fin || !fin.finished) continue; // match not over → stay pending (not a failure)
    let status: string, note: string | null = null;
    if (fin.manual) { status = "unresolved"; note = "исход неизвестен (manual/нет детали финала)"; }
    else {
      const row = db.prepare(`SELECT raw FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(s.match_id) as { raw?: string } | undefined;
      const fs = finalSetsFromRaw(row?.raw ?? null);
      if (!fs) { status = "unresolved"; note = "детализация по сетам не читается на финале"; }
      else {
        const firstIsP1 = s.first_is_p1 == null ? (propFirstIsP1(s.market_label, { p1: fin.p1, p2: fin.p2 }) ?? true) : s.first_is_p1 === 1;
        let won: boolean | null | undefined;
        try { won = resolveTennisProp(s.market_label, fs, { retired: fin.retired, canceled: fin.canceled, firstIsP1 }); }
        catch { won = undefined; }
        if (won === undefined) { status = "unresolved"; note = "resolveTennisProp не смог разрешить проп"; }
        else if (won == null) { status = "void"; note = "void-клауза (ретайр/отмена/недоигран)"; }
        else status = won ? "won" : "lost";
      }
    }
    db.prepare(`UPDATE pmv_shadow_signals SET status=?, resolve_note=?, resolved_at=? WHERE id=?`).run(status, note, now, s.id);
    if (status === "unresolved") unresolved++; else resolved++;
  }
  return { resolved, unresolved };
}

// ============================================================================
// [07.08] КОНТРФАКТИЧЕСКИЙ ЗОНД ПО «manual»-ветке.
//
// Замер разбора неразрешённых дал 144 из 144 в ОДНОМ классе `manual_finish`, а `resolverGaps` — пусто.
// Прочитать это как «восстановимых нет» НЕЛЬЗЯ: `if (fin.manual)` стоит ПЕРВЫМ и уходит в `unresolved`
// ДО того, как хоть раз вызваны `finalSetsFromRaw` и `resolveTennisProp`. Ноль в двух последующих классах
// означает не «там пусто», а «туда не дошло НИ ОДНОЙ строки». Вердикт о ветках, которые не исполнялись, —
// ровно тот класс, за который мы наказываем гипотезы; сторож посчитал СВОЙ первый гейт за весь конвейер.
//
// Хуже того, гейт заведомо ШИРЕ своего смысла: `manual` = «неизвестно, КТО ПРОШЁЛ ДАЛЬШЕ». Пропу
// «Set 1 Over 8.5», «Set 2 Winner» или «Total Sets: Under 2.5» проходящий не нужен ВООБЩЕ — а именно эти
// три ярлыка и стоят в примерах прода.
//
// Зонд НИЧЕГО НЕ РАЗРЕШАЕТ. Он считает, ЧТО БЫ вышло, и дописывает это в заметку машинным тегом. Статус
// остаётся `unresolved`. Разрешать на этом же деплое было бы нельзя: при `winner_conflict` под сомнением
// сам СЧЁТ, и такие строки влили бы неверные исходы в базу Brier, на которой стоит вердикт «GO».
// ============================================================================

/** Машинный тег контрфактического зонда в `resolve_note`. Идемпотентен: строка с тегом не перепроверяется. */
const CF_TAG = "[cf:";
export type CfWould = "won" | "lost" | "void" | "unreadable_sets" | "resolver_cannot"
  | "skip_no_snapshot" | "skip_not_manual";

/**
 * ПОЧЕМУ ЗОНД ПРОПУСТИЛ СТРОКУ. Первый прогон на проде дал `probed=0` при 144 неразрешённых — и это был
 * ФАКТ (шаг отработал, пульс подтвердил), а не отсутствие запуска. Но `probeOne` возвращал один `null` на
 * три РАЗНЫЕ причины, и «зонд ничего не нашёл» оказалось неотличимо от «зонду нечего было читать».
 * Ровно тот дефект, который зонд и создавался лечить, — на уровень ниже, в самом зонде.
 *
 * Причины лечатся по-разному и это разные диагнозы:
 *   • `no_snapshot` — снимка матча БОЛЬШЕ НЕТ (prune съел источник, переживший архив). Исход существовал,
 *     мы стёрли свою копию — это не «фид не отдал» и не «резолвер не умеет»;
 *   • `not_finished` — матч ещё не финализирован нашим финишером: строка просто рано;
 *   • `not_manual` — финал читается чисто, значит `manual`-гейт эту строку не глотал, и unresolved у неё
 *     от другой причины.
 */
export type ProbeSkip = "no_snapshot" | "not_finished" | "not_manual";

/** Что БЫ вышло по одной неразрешённой строке, если бы `manual`-гейт её не проглотил. Ничего не пишет. */
export function probeOne(db: Database, matchId: string, label: string, firstIsP1Col: number | null): { would: CfWould; mr: string } | { skip: ProbeSkip } {
  const fin = tennisFinalResult(db, matchId);
  // `tennisFinalResult` возвращает null и когда снимка нет вовсе, и когда он есть, но матч не финал.
  // Различаем по наличию строки: молчание источника и незавершённость — не одно и то же.
  if (!fin) {
    const has = db.prepare(`SELECT 1 FROM tennis_snapshots WHERE pm_match_id=? LIMIT 1`).get(matchId);
    return { skip: has ? "not_finished" : "no_snapshot" };
  }
  if (!fin.finished) return { skip: "not_finished" };
  if (!fin.manual) return { skip: "not_manual" };   // зонд только по manual-ветке
  const mr = fin.manualReason ?? "unknown";
  const row = db.prepare(`SELECT raw FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(matchId) as { raw?: string } | undefined;
  const fs = finalSetsFromRaw(row?.raw ?? null);
  if (!fs) return { would: "unreadable_sets", mr };
  const firstIsP1 = firstIsP1Col == null ? (propFirstIsP1(label, { p1: fin.p1, p2: fin.p2 }) ?? true) : firstIsP1Col === 1;
  let won: boolean | null | undefined;
  try { won = resolveTennisProp(label, fs, { retired: fin.retired, canceled: fin.canceled, firstIsP1 }); }
  catch { won = undefined; }
  if (won === undefined) return { would: "resolver_cannot", mr };
  if (won == null) return { would: "void", mr };
  return { would: won ? "won" : "lost", mr };
}

/** Прогон зонда по уже накопленным `unresolved`. Статусы не трогает — дописывает тег в заметку. */
export function probePmvShadowManual(db: Database, _deps: EngineDeps = {}): {
  probed: number; wouldResolve: number; skipped: Record<ProbeSkip | "already_tagged", number>;
} {
  let probed = 0, wouldResolve = 0;
  const skipped: Record<ProbeSkip | "already_tagged", number> = { no_snapshot: 0, not_finished: 0, not_manual: 0, already_tagged: 0 };
  const rows = db.prepare(
    `SELECT id, match_id, market_label, first_is_p1, resolve_note FROM pmv_shadow_signals WHERE status='unresolved'`,
  ).all() as { id: string; match_id: string; market_label: string; first_is_p1: number | null; resolve_note: string | null }[];
  for (const s of rows) {
    if (s.resolve_note && s.resolve_note.includes(CF_TAG)) { skipped.already_tagged++; continue; }
    const p = probeOne(db, s.match_id, s.market_label, s.first_is_p1);
    // ПРИЧИНА ПРОПУСКА ЗАПИСЫВАЕТСЯ В ТУ ЖЕ ЗАМЕТКУ. Иначе следующий прогон снова читает 144 строки и
    // снова молча их бросает, а отчёт снова печатает «зонд не прошёл» — при том что он прошёл трижды.
    if ("skip" in p) {
      skipped[p.skip]++;
      // `not_finished` — состояние ВРЕМЕННОЕ: матч дозреет, и строку надо перечитать. Метку не ставим.
      if (p.skip !== "not_finished") {
        const note = `${s.resolve_note ?? ""} ${CF_TAG}would=skip_${p.skip},mr=none]`.trim();
        db.prepare(`UPDATE pmv_shadow_signals SET resolve_note=? WHERE id=?`).run(note, s.id);
      }
      continue;
    }
    probed++;
    if (p.would === "won" || p.would === "lost" || p.would === "void") wouldResolve++;
    const note = `${s.resolve_note ?? ""} ${CF_TAG}would=${p.would},mr=${p.mr}]`.trim();
    db.prepare(`UPDATE pmv_shadow_signals SET resolve_note=? WHERE id=?`).run(note, s.id);
  }
  return { probed, wouldResolve, skipped };
}

/** Разбор тега обратно. Отсутствие тега — СВОЙ случай, а не «зонд ничего не нашёл». */
export function parseCf(note: string | null): { would: CfWould; mr: string } | null {
  const m = /\[cf:would=([a-z_]+),mr=([a-z_]+)\]/.exec(note ?? "");
  return m ? { would: m[1] as CfWould, mr: m[2]! } : null;
}

export interface PmvShadowCalibration {
  criteria: string[];
  counts: { total: number; pending: number; won: number; lost: number; void: number; unresolved: number; repeats: number };
  scored: number;                 // won + lost — the Brier base
  unresolvedPct: number | null;   // pipeline diagnostic (of the reached-terminal rows)
  /**
   * [07.08] РАЗБОР 144 НЕРАЗРЕШЁННЫХ. Отчёт СЧИТАЛ их долю и НЕ НАЗЫВАЛ причин — а классы лечатся
   * ПРОТИВОПОЛОЖНО, и слитые в один процент они неразличимы:
   *   • `feed_no_detail` / `manual_finish` — исхода нет В ПРИРОДЕ данных (провайдер не отдал детализацию
   *     по сетам, финал проставлен вручную). Правильный отказ; лечится только покрытием фида;
   *   • `resolver_cannot` — ярлык НЕ РАЗБИРАЕТСЯ нашим резолвером. Это НЕ отсутствие исхода: исход есть,
   *     мы не умеем его прочитать. Каждая такая строка — бесплатная единица когорты, недоделанная кодом.
   * Половина корпуса (50.3%) висит здесь, и вердикт «GO» стоит на второй половине. Пока классы не
   * разведены, «данных мало» неотличимо от «мы их не дочитываем».
   */
  unresolvedBreakdown: { reason: string; cls: "feed_no_detail" | "manual_finish" | "resolver_cannot" | "other"; n: number; sampleLabels: string[] }[];
  /** Ярлыки, которые резолвер не осилил, сгруппированные по семье — адресный список работы. */
  resolverGaps: { family: string; n: number; sampleLabels: string[] }[];
  /**
   * [07.08, ПОПРАВКА ПО ЗАМЕРУ] Первый замер разбора дал 144/144 в `manual_finish` и ПУСТОЙ `resolverGaps`,
   * а заметка объявила «восстановимых 0 — остальное ожиданием не лечится». Это было НЕОБОСНОВАННО: гейт
   * `if (fin.manual)` стоит первым и уходит в `unresolved` ДО вызова `finalSetsFromRaw`/`resolveTennisProp`.
   * Ноль в последующих классах означал «туда не дошло ни одной строки», а не «там пусто» — вердикт о
   * ветках, которые не исполнялись. Здесь конвейер измеряется ДО КОНЦА: контрфактический зонд считает,
   * что БЫ вышло, ничего не разрешая.
   * `wouldResolveSafe` — строки, где счёт НЕ оспорен (`retired_no_winner` / `no_winner_no_score`): их можно
   * разрешать. `wouldResolveDisputed` — `winner_conflict`: под сомнением сам счёт, разрешать НЕЛЬЗЯ.
   */
  manualProbe: {
    probed: number; unprobed: number;
    wouldResolve: number; wouldResolveSafe: number; wouldResolveDisputed: number;
    byWould: { would: string; n: number; sampleLabels: string[] }[];
    byReason: { manualReason: string; n: number; wouldResolve: number }[];
    note: string;
  };
  winPctActual: number | null;    // realized win% of scored props
  theoMeanPct: number | null;     // mean model prob on the same rows
  brierMarkov: number | null;
  brierImplied: number | null;    // implied from the FROZEN mid (same timestamp)
  criterion: { needN: number; haveN: number; matured: boolean; markovBeatsImplied: boolean | null };
  clv: string;
  // C (batch-8 follow-up): per family×side realized-vs-theo, to MEASURE the OVER-lean the uniformity guard
  // only flags heuristically. optimismPp = mean theo − realized win% (positive = model overpriced that side).
  sideBias: { family: string; side: string; n: number; winPctActual: number; theoMeanPct: number; optimismPp: number }[];
  biasFlags: string[];             // (family,side) with n≥BIAS_MIN_N and optimismPp ≥ BIAS_FLAG_PP — a measured, sized lean
  verdict: "go" | "no_go" | "insufficient";
  note: string;
}

const NEED_N = 40; // 40–60 resolved cases before the Brier criterion is read
const BIAS_MIN_N = 10;             // per-side sample floor before a lean is reportable
const BIAS_FLAG_PP = 8;            // theo−actual gap (pp) that marks a side as systematically over-priced

/** Score the resolved shadow signals: Brier(markov) vs Brier(implied@frozen-mid), win%-vs-theo, unresolved
 *  share. No CLV (no shadow closing book). verdict is mechanical from the criteria; insufficient until n≥40. */
export function buildPmvShadowCalibration(db: Database): PmvShadowCalibration {
  const rows = db.prepare(`SELECT theo_cents t, mid_cents m, status, hits FROM pmv_shadow_signals`).all() as { t: number; m: number; status: string; hits: number }[];
  const c = { total: rows.length, pending: 0, won: 0, lost: 0, void: 0, unresolved: 0, repeats: 0 };
  for (const r of rows) { (c as any)[r.status]++; c.repeats += Math.max(0, (r.hits ?? 1) - 1); }
  const scoredRows = rows.filter((r) => r.status === "won" || r.status === "lost");
  const scored = scoredRows.length;
  const terminal = scored + c.void + c.unresolved;

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const r3 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);
  const outcomes = scoredRows.map((r) => (r.status === "won" ? 1 : 0));
  const brierMarkov = scored ? mean(scoredRows.map((r) => ((r.t / 100) - (r.status === "won" ? 1 : 0)) ** 2)) : null;
  const brierImplied = scored ? mean(scoredRows.map((r) => ((r.m / 100) - (r.status === "won" ? 1 : 0)) ** 2)) : null;
  const matured = scored >= NEED_N;
  const markovBeatsImplied = brierMarkov != null && brierImplied != null ? brierMarkov <= brierImplied : null;

  // C: per family×side realized win% vs the model's mean theo — a MEASUREMENT of the OVER-lean
  // (the uniformity guard stops a family in-slate but never records whether the lean is a real bias).
  const bRows = db.prepare(`SELECT family, side, theo_cents t, status FROM pmv_shadow_signals WHERE status IN ('won','lost')`).all() as { family: string; side: string; t: number; status: string }[];
  const grp = new Map<string, { family: string; side: string; n: number; won: number; theoSum: number }>();
  for (const r of bRows) { const k = `${r.family}·${r.side}`; const g = grp.get(k) ?? { family: r.family, side: r.side, n: 0, won: 0, theoSum: 0 }; g.n++; if (r.status === "won") g.won++; g.theoSum += r.t / 100; grp.set(k, g); }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const sideBias = [...grp.values()].map((g) => { const actual = (g.won / g.n) * 100, theo = (g.theoSum / g.n) * 100; return { family: g.family, side: g.side, n: g.n, winPctActual: r1(actual), theoMeanPct: r1(theo), optimismPp: r1(theo - actual) }; }).sort((a, b) => b.n - a.n);
  const biasFlags = sideBias.filter((b) => b.n >= BIAS_MIN_N && b.optimismPp >= BIAS_FLAG_PP).map((b) => `${b.family}·${b.side}: модель ${b.theoMeanPct}% vs факт ${b.winPctActual}% (переоценка +${b.optimismPp}пп, n=${b.n}) — систематический крен, срезать theo этой стороны`);

  // ── РАЗБОР НЕРАЗРЕШЁННЫХ ПО ПРИЧИНЕ. Причина уже пишется построчно в `resolve_note` при разрешении —
  // её просто никто не агрегировал. Считать долю и не называть состав это ровно «немой процент».
  const unrRows = db.prepare(
    `SELECT resolve_note note, market_label label, family FROM pmv_shadow_signals WHERE status='unresolved'`,
  ).all() as { note: string | null; label: string; family: string | null }[];
  const clsOf = (note: string | null): PmvShadowCalibration["unresolvedBreakdown"][number]["cls"] =>
    !note ? "other"
      : note.includes("resolveTennisProp") ? "resolver_cannot"
        : note.includes("детализация по сетам") ? "feed_no_detail"
          : note.includes("manual") ? "manual_finish" : "other";
  const byReason = new Map<string, { reason: string; cls: ReturnType<typeof clsOf>; n: number; sampleLabels: string[] }>();
  const byFamily = new Map<string, { family: string; n: number; sampleLabels: string[] }>();
  for (const r of unrRows) {
    const reason = r.note ?? "(причина не записана)";
    const g = byReason.get(reason) ?? { reason, cls: clsOf(r.note), n: 0, sampleLabels: [] };
    g.n++; if (g.sampleLabels.length < 4) g.sampleLabels.push(r.label);
    byReason.set(reason, g);
    if (clsOf(r.note) === "resolver_cannot") {
      const fam = r.family ?? "(без семьи)";
      const f = byFamily.get(fam) ?? { family: fam, n: 0, sampleLabels: [] };
      f.n++; if (f.sampleLabels.length < 4) f.sampleLabels.push(r.label);
      byFamily.set(fam, f);
    }
  }
  const unresolvedBreakdown = [...byReason.values()].sort((a, b) => b.n - a.n);
  const resolverGaps = [...byFamily.values()].sort((a, b) => b.n - a.n);
  const recoverable = unresolvedBreakdown.filter((x) => x.cls === "resolver_cannot").reduce((s, x) => s + x.n, 0);

  // ── КОНТРФАКТИЧЕСКИЙ ЗОНД: конвейер меряется ДО КОНЦА, а не по первому гейту.
  const wouldOf = new Map<string, { would: string; n: number; sampleLabels: string[] }>();
  const mrOf = new Map<string, { manualReason: string; n: number; wouldResolve: number }>();
  let probed = 0, unprobed = 0, wouldResolve = 0, wouldResolveSafe = 0, wouldResolveDisputed = 0;
  for (const r of unrRows) {
    const cf = parseCf(r.note);
    if (!cf) { unprobed++; continue; }
    // Строка, помеченная ПРИЧИНОЙ ПРОПУСКА, зондом не пройдена — она объяснена. Считать её «зондированной»
    // значило бы записать себе в актив то, что мы как раз НЕ прочитали.
    if (cf.would.startsWith("skip_")) {
      const w = wouldOf.get(cf.would) ?? { would: cf.would, n: 0, sampleLabels: [] };
      w.n++; if (w.sampleLabels.length < 4) w.sampleLabels.push(r.label);
      wouldOf.set(cf.would, w);
      unprobed++; continue;
    }
    probed++;
    const w = wouldOf.get(cf.would) ?? { would: cf.would, n: 0, sampleLabels: [] };
    w.n++; if (w.sampleLabels.length < 4) w.sampleLabels.push(r.label);
    wouldOf.set(cf.would, w);
    const m = mrOf.get(cf.mr) ?? { manualReason: cf.mr, n: 0, wouldResolve: 0 };
    m.n++;
    if (cf.would === "won" || cf.would === "lost" || cf.would === "void") {
      m.wouldResolve++; wouldResolve++;
      // Счёт оспорен ТОЛЬКО при winner_conflict: там event_winner противоречит счёту по сетам, поэтому
      // разрешать проп на этом счёте значило бы влить в базу Brier исход, которому мы сами не верим.
      if (cf.mr === "winner_conflict") wouldResolveDisputed++; else wouldResolveSafe++;
    }
    mrOf.set(cf.mr, m);
  }
  // СОСТАВ НЕПРОЙДЕННОГО НАЗЫВАЕТСЯ. «Зонд не прошёл» без причин — та же немота, что и «144 unresolved».
  const skipNote = [...wouldOf.values()].filter((w) => w.would.startsWith("skip_"))
    .sort((a, b) => b.n - a.n)
    .map((w) => `${w.would.replace("skip_", "")} ${w.n}`).join(", ");
  const manualProbe: PmvShadowCalibration["manualProbe"] = {
    probed, unprobed, wouldResolve, wouldResolveSafe, wouldResolveDisputed,
    byWould: [...wouldOf.values()].sort((a, b) => b.n - a.n),
    byReason: [...mrOf.values()].sort((a, b) => b.n - a.n),
    note: !probed
      ? (unprobed ? `зонд не прочитал ни одной из ${unprobed} строк — «восстановимых нет» пока НЕ УСТАНОВЛЕНО`
          + (skipNote ? ` · причины: ${skipNote}` : " · причина пока не записана — следующий прогон её назовёт")
        : "неразрешённых нет")
      : `зонд по ${probed} строкам: разрешилось бы ${wouldResolve}`
        + (wouldResolve ? ` (из них БЕЗОПАСНО ${wouldResolveSafe} — счёт не оспорен; ${wouldResolveDisputed} на спорном счёте, разрешать нельзя)` : "")
        + (unprobed ? ` · не зондировано ${unprobed}` : ""),
  };

  const verdict: PmvShadowCalibration["verdict"] = !matured ? "insufficient" : markovBeatsImplied ? "go" : "no_go";
  const note = !matured
    ? `копим: ${scored}/${NEED_N} разрешённых кейсов (это НЕ «немой ноль» — данные теперь реально приходят). unresolved=${c.unresolved}${terminal ? ` (${Math.round(100 * c.unresolved / terminal)}% терминальных)` : ""} — следи за долей, это диагностика конвейера.`
    : markovBeatsImplied
      ? `GO: Brier марковских ${r3(brierMarkov)} ≤ implied ${r3(brierImplied)} на n=${scored} — модель бьёт рынок в тот же таймстемп.`
      : `NO_GO: Brier марковских ${r3(brierMarkov)} > implied ${r3(brierImplied)} на n=${scored} — модель НЕ бьёт рынок. Ядро не готово.`;
  // ВОССТАНОВИМОЕ НАЗЫВАЕТСЯ ЧИСЛОМ. «Данных мало» и «мы их не дочитываем» — разные диагнозы, и второй
  // чинится кодом за один прогон, а не ожиданием новых матчей.
  // [ПОПРАВКА 07.08] Прежняя строка при recoverable=0 печатала «все остальные это отсутствие исхода в
  // фиде, ожиданием не лечится». Это утверждение о ветках, которые НЕ ИСПОЛНЯЛИСЬ: `manual`-гейт стоит
  // первым и глотает строку до резолвера, поэтому ноль в классе `resolver_cannot` не является
  // свидетельством об отсутствии восстановимых. Теперь «не лечится» говорится ТОЛЬКО когда зонд реально
  // дошёл до конца конвейера и не нашёл разрешимых; иначе строка честно называет незнание.
  const recoveryNote = c.unresolved === 0 ? ""
    : ` · неразрешённых ${c.unresolved}, из них восстановимых резолвером ${recoverable}`
      + (recoverable > 0 ? `: +${recoverable} к когорте без единого нового матча` : "")
      + ` · ${manualProbe.note}`
      + (manualProbe.wouldResolveSafe > 0
        ? ` — ГЕЙТ ШИРЕ СМЫСЛА: ${manualProbe.wouldResolveSafe} пропов не нуждаются в победителе матча и разрешимы кодом`
        : manualProbe.probed && !manualProbe.wouldResolve ? " — конвейер пройден до конца: исхода нет в фиде, ожиданием не лечится" : "");

  return {
    criteria: [
      "Сигнал заморожен полем на момент входа (theo/mid/ориентация); разрешение ничего не пересчитывает из текущего состояния.",
      "Дедуп по правилу: одна запись на (матч, проп); повторы сигнала инкрементируют hits, не плодят строки.",
      "Разрешение — тем же resolveTennisProp, fail-closed: нет исхода → unresolved с причиной (считается), не тихий пропуск.",
      "Brier марковских ≤ Brier implied на n≥40; implied из ЗАМОРОЖЕННОГО mid того же снапшота (модель против рынка в один момент).",
      "CLV не считаем (нет closing-книги по shadow) — только win%-vs-theo и Brier. Часы критерия с деплоя; текстовые flag_only задним числом не парсим.",
    ],
    counts: c, scored, unresolvedBreakdown, resolverGaps, manualProbe,
    unresolvedPct: terminal ? Math.round(1000 * c.unresolved / terminal) / 10 : null,
    winPctActual: outcomes.length ? Math.round(1000 * (mean(outcomes) ?? 0)) / 10 : null,
    theoMeanPct: scored ? Math.round(1000 * (mean(scoredRows.map((r) => r.t / 100)) ?? 0)) / 10 : null,
    brierMarkov: r3(brierMarkov), brierImplied: r3(brierImplied),
    criterion: { needN: NEED_N, haveN: scored, matured, markovBeatsImplied },
    clv: "n/a — closing-книга по shadow не пишется; считаем только win%-vs-theo и Brier",
    sideBias, biasFlags,
    verdict, note: note + recoveryNote,
  };
}

// [Phase 4.2 / M21] LIVE side-quarantine haircut. From the measured sideBias, return every (family·side)
// the model systematically OVER-prices (n≥BIAS_MIN_N and optimismPp≥BIAS_FLAG_PP) → the cents to shave off
// that side's theo before the entry gate. Auto-tracks the sign: only over-optimistic sides get a haircut
// (a pessimistic side would MANUFACTURE edge if inflated, so it never produces one). Data-driven — whichever
// side the cohort proves biased is quarantined, replacing the hardcoded "under" binary block.
export function pmvSideBiasHaircut(cal: PmvShadowCalibration): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of cal.sideBias)
    if (b.n >= BIAS_MIN_N && b.optimismPp >= BIAS_FLAG_PP) m.set(`${b.family}·${b.side}`, b.optimismPp);
  return m;
}

// [Phase 4.1 / M20] Measured calibration factor for sizePrematch, replacing the 0.6 hardcode. Until the
// Brier criterion matures (n≥40) we keep the 0.6 prior; once matured, GO (model beats market) earns more
// trust (0.65), NO_GO (it doesn't) earns less (0.5). A pure function of the cohort verdict — no free params.
export function pmvMeasuredCalibration(cal: PmvShadowCalibration): number {
  if (!cal.criterion.matured) return 0.6;
  return cal.verdict === "go" ? 0.65 : 0.5;
}

// [Phase 4.4] PROMOTION LADDER — the formal shadow→paper→real progression with a gate at each transition.
// The real leg is HARD-PINNED football-only (whitelist WHITELIST_SPORT + the mirror sport gate), so tennis
// can NEVER auto-promote to real: this reports WHERE tennis-PMV stands and WHAT the paper cohort must prove
// before an owner ratification is even eligible to be considered. Triple agreement = three independent
// confirmations the edge is real: (1) shadow Brier beats implied (model > market at freeze), (2) no
// UNHANDLED systematic side-lean (biasFlags empty — every measured lean is compensated by a haircut),
// (3) paper cohort book-P&L ≥ 0. Plus a sample floor of n≥25 matured paper signals. All measured, no dials.
const PMV_PROMO_NEED_SIGNALS = 25;
export interface PmvPromotion {
  stage: "shadow" | "paper";       // real is unreachable for tennis this era (football-only whitelist)
  paperSignals: number;
  needSignals: number;
  paperPnlUsd: number;
  agreements: { brierGo: boolean; sideBiasClear: boolean; paperPositive: boolean };
  tripleAgreement: boolean;
  realEligible: boolean;           // ALWAYS false for tennis — a separate owner ratification is mandatory
  ladder: string[];
  note: string;
}
export function buildPmvPromotion(db: Database, env: Record<string, string | undefined> = process.env): PmvPromotion {
  const flagOnly = (env.TENNIS_PMV_FLAG_ONLY ?? "") !== "false";
  const cal = buildPmvShadowCalibration(db);
  // Distinct matured PAPER signals (one per match×market), and the cohort's realized book-P&L.
  const paperSignals = (db.prepare(
    `SELECT COUNT(*) n FROM (SELECT DISTINCT match_id, market_label FROM bets WHERE strategy_id=? AND code_version LIKE ? AND status LIKE 'settled%')`,
  ).get(PMV_STRATEGY, `%${PMV_PAPER_EPOCH}%`) as { n: number }).n;
  const pnlRow = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN payout IS NOT NULL THEN payout - stake ELSE 0 END),0) pnl
       FROM bets WHERE strategy_id=? AND code_version LIKE ? AND status LIKE 'settled%'`,
  ).get(PMV_STRATEGY, `%${PMV_PAPER_EPOCH}%`) as { pnl: number };
  const paperPnlUsd = Math.round((pnlRow.pnl ?? 0) * 100) / 100;
  const agreements = {
    brierGo: cal.verdict === "go",
    sideBiasClear: cal.biasFlags.length === 0,
    paperPositive: paperPnlUsd >= 0 && paperSignals > 0,
  };
  const tripleAgreement = agreements.brierGo && agreements.sideBiasClear && agreements.paperPositive && paperSignals >= PMV_PROMO_NEED_SIGNALS;
  const stage: PmvPromotion["stage"] = flagOnly ? "shadow" : "paper";
  const ladder = [
    `shadow (flag-only): свободный контроль — сигнал заморожен, деньги ноль. ${flagOnly ? "◄ ТЕКУЩАЯ" : "пройдено"}`,
    `paper (микро-кэп): деньги в sim, net-EV гейт + haircut. ${flagOnly ? "заблокировано (flag-only)" : "◄ ТЕКУЩАЯ"}`,
    `real: ТОЛЬКО football (whitelist пришпилен). tennis-PMV → real невозможен до отдельной ратификации владельца.`,
  ];
  const note = flagOnly
    ? `shadow-стадия: копим ${cal.scored} разрешённых shadow-кейсов (нужно ${cal.criterion.needN} для Brier-вердикта). Деньги не двигаются.`
    : tripleAgreement
      ? `paper-когорта СОЗРЕЛА для рассмотрения: n=${paperSignals}≥${PMV_PROMO_NEED_SIGNALS}, тройное согласие ✓ (Brier-GO, крен-чист, P&L $${paperPnlUsd}). Реал всё равно требует ЯВНОЙ ратификации владельца — авто-промоушена нет.`
      : `paper-стадия: n=${paperSignals}/${PMV_PROMO_NEED_SIGNALS} сигналов; согласие Brier-GO=${agreements.brierGo}, крен-чист=${agreements.sideBiasClear}, P&L≥0=${agreements.paperPositive} ($${paperPnlUsd}). Реал недоступен (football-only) до созревания + ратификации.`;
  return { stage, paperSignals, needSignals: PMV_PROMO_NEED_SIGNALS, paperPnlUsd, agreements, tripleAgreement, realEligible: false, ladder, note };
}
