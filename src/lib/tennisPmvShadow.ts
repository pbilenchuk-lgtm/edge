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
import { resolveTennisProp, finalSetsFromRaw, propFirstIsP1 } from "./tennisPmv.js";
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

export interface PmvShadowCalibration {
  criteria: string[];
  counts: { total: number; pending: number; won: number; lost: number; void: number; unresolved: number; repeats: number };
  scored: number;                 // won + lost — the Brier base
  unresolvedPct: number | null;   // pipeline diagnostic (of the reached-terminal rows)
  winPctActual: number | null;    // realized win% of scored props
  theoMeanPct: number | null;     // mean model prob on the same rows
  brierMarkov: number | null;
  brierImplied: number | null;    // implied from the FROZEN mid (same timestamp)
  criterion: { needN: number; haveN: number; matured: boolean; markovBeatsImplied: boolean | null };
  clv: string;
  verdict: "go" | "no_go" | "insufficient";
  note: string;
}

const NEED_N = 40; // 40–60 resolved cases before the Brier criterion is read

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

  const verdict: PmvShadowCalibration["verdict"] = !matured ? "insufficient" : markovBeatsImplied ? "go" : "no_go";
  const note = !matured
    ? `копим: ${scored}/${NEED_N} разрешённых кейсов (это НЕ «немой ноль» — данные теперь реально приходят). unresolved=${c.unresolved}${terminal ? ` (${Math.round(100 * c.unresolved / terminal)}% терминальных)` : ""} — следи за долей, это диагностика конвейера.`
    : markovBeatsImplied
      ? `GO: Brier марковских ${r3(brierMarkov)} ≤ implied ${r3(brierImplied)} на n=${scored} — модель бьёт рынок в тот же таймстемп.`
      : `NO_GO: Brier марковских ${r3(brierMarkov)} > implied ${r3(brierImplied)} на n=${scored} — модель НЕ бьёт рынок. Ядро не готово.`;

  return {
    criteria: [
      "Сигнал заморожен полем на момент входа (theo/mid/ориентация); разрешение ничего не пересчитывает из текущего состояния.",
      "Дедуп по правилу: одна запись на (матч, проп); повторы сигнала инкрементируют hits, не плодят строки.",
      "Разрешение — тем же resolveTennisProp, fail-closed: нет исхода → unresolved с причиной (считается), не тихий пропуск.",
      "Brier марковских ≤ Brier implied на n≥40; implied из ЗАМОРОЖЕННОГО mid того же снапшота (модель против рынка в один момент).",
      "CLV не считаем (нет closing-книги по shadow) — только win%-vs-theo и Brier. Часы критерия с деплоя; текстовые flag_only задним числом не парсим.",
    ],
    counts: c, scored,
    unresolvedPct: terminal ? Math.round(1000 * c.unresolved / terminal) / 10 : null,
    winPctActual: outcomes.length ? Math.round(1000 * (mean(outcomes) ?? 0)) / 10 : null,
    theoMeanPct: scored ? Math.round(1000 * (mean(scoredRows.map((r) => r.t / 100)) ?? 0)) / 10 : null,
    brierMarkov: r3(brierMarkov), brierImplied: r3(brierImplied),
    criterion: { needN: NEED_N, haveN: scored, matured, markovBeatsImplied },
    clv: "n/a — closing-книга по shadow не пишется; считаем только win%-vs-theo и Brier",
    verdict, note,
  };
}
