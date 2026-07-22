// ============================================================
// EDGE LAB — SET-VALUE flag-only SHADOW COHORT  [SERVER-ONLY]
//
// set_value was ratified to flag-only: its edge was `comebackProb(0.5) − price`, a HARDCODED constant, and
// the cohort review (10 logs, net ≈ −$415/day) showed the phantom edge is biggest exactly where the
// favourite is most broken (cheapest entry → largest "edge" → largest stake → full collapse). Instead of
// paying to learn that again, every would-be entry is FROZEN here with ZERO money movement, so the REAL
// comeback rate can be measured and replace the constant (P1.1). Mirror of tennisPmvShadow:
//
//   1. RECORD — freeze at the trigger: prematch favourite moneyline (P0.3), trigger price, set-1 game score
//      FROM SNAPSHOTS (P0.4 — never inferred from price move), tour/type, token+orientation. Dedup: one row
//      per match (the lost-set-1 event is singular); repeats bump `hits`.
//   2. RESOLVE — post-match, from the SAME final-sets read: BOTH outcomes (won set 2 = the comeback thesis;
//      won the match = the P&L terminal) + the price PATH over set 2 (min = drawdown for own-cohort floor
//      calibration; max = the take that was actually available). Fail-closed + loud: no score → unresolved.
//   3. REPORT — P(comeback set 2) and P(win match) binned by FROZEN favourite strength (60-70/70-80/80+)
//      and ATP/WTA, n per bin. Verdict bin needs n≥40, total n≥80 (criterion fixed BEFORE data).
//
// Epoch clock starts at deploy; legacy money bets under the 0.5 constant are diagnostic, not calibration.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { tennisFinalResult } from "./tennisTrading.js";

export const SV_SHADOW_EPOCH = "sv-shadow-m1"; // bump when the shadow-record/resolve logic changes

export interface SvShadowInput {
  matchId: string; tour: string | null; eventType: string | null;
  favSide: "first" | "second"; favToken: string | null; firstIsP1: boolean | null;
  prematchMlCents: number | null; prematchSrc: string;      // P0.3 frozen favourite strength + its source tag
  triggerCents: number; set1GamesFav: number | null; set1GamesOpp: number | null; setNum: number | null;
  edgeConst: number; epoch: string; at: string;
}

/** Freeze a would-be Set-Value entry. Dedup: FIRST per match is frozen; repeats bump `hits` (a persistent
 *  armed trigger never inflates into many rows). Zero money movement — no bet, no reserve, no treasury. */
export function recordSvShadowSignal(db: Database, s: SvShadowInput): void {
  db.prepare(
    `INSERT INTO sv_shadow_signals
       (id, match_id, tour, event_type, fav_side, fav_token, first_is_p1, prematch_ml_cents, prematch_src,
        trigger_cents, set1_games_fav, set1_games_opp, set_num, edge_const, epoch, hits, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'pending',?)
     ON CONFLICT(match_id) DO UPDATE SET hits = hits + 1`,
  ).run(R.uid(), s.matchId, s.tour, s.eventType, s.favSide, s.favToken,
    s.firstIsP1 == null ? null : s.firstIsP1 ? 1 : 0, s.prematchMlCents, s.prematchSrc,
    s.triggerCents, s.set1GamesFav, s.set1GamesOpp, s.setNum, s.edgeConst, s.epoch, s.at);
}

/** Favourite's PM price path (min→drawdown, max→take) over set 2, from the trigger onward. Snapshots only —
 *  bounded to set ≤ 2 so it measures the SET-2 horizon (where the take target lives), not the whole match. */
function pricePath(db: Database, matchId: string, favSide: "first" | "second", sinceIso: string): { min: number | null; max: number | null } {
  const col = favSide === "first" ? "pm_p1_cents" : "pm_p2_cents";
  const rows = db.prepare(
    `SELECT ${col} c FROM tennis_snapshots WHERE pm_match_id=? AND batch_at>=? AND ${col} IS NOT NULL AND (set_num IS NULL OR set_num<=2)`,
  ).all(matchId, sinceIso) as { c: number }[];
  if (!rows.length) return { min: null, max: null };
  let min = Infinity, max = -Infinity;
  for (const r of rows) { if (r.c < min) min = r.c; if (r.c > max) max = r.c; }
  return { min, max };
}

/** Resolve pending Set-Value shadow signals against finished matches. BOTH outcomes from the final sets;
 *  fail-closed: no readable score / manual finish → `unresolved` WITH a reason (counted), never silent. */
export function resolveSvShadowSignals(db: Database, deps: EngineDeps = {}): { resolved: number; unresolved: number } {
  const now = deps.now?.() ?? new Date().toISOString();
  let resolved = 0, unresolved = 0;
  const pend = db.prepare(
    `SELECT id, match_id, fav_side, created_at FROM sv_shadow_signals WHERE status='pending'`,
  ).all() as { id: string; match_id: string; fav_side: "first" | "second"; created_at: string }[];
  for (const s of pend) {
    const fin = tennisFinalResult(db, s.match_id);
    if (!fin || !fin.finished) continue; // not over → stay pending (not a failure)
    const path = pricePath(db, s.match_id, s.fav_side, s.created_at);
    let status = "resolved", note: string | null = null;
    let set2: string | null = null, match: string | null = null;

    if (fin.canceled) { status = "void"; note = "void (walkover/отмена)"; match = "void"; }
    else {
      // Final set counts from the newest snapshot (same source tennisFinalResult reads).
      const row = db.prepare(`SELECT sets_p1, sets_p2 FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(s.match_id) as { sets_p1: number | null; sets_p2: number | null } | undefined;
      const favSets = row ? (s.fav_side === "first" ? row.sets_p1 : row.sets_p2) : null;
      const oppSets = row ? (s.fav_side === "first" ? row.sets_p2 : row.sets_p1) : null;
      if (fin.manual || fin.advancing == null && favSets == null) { status = "unresolved"; note = "исход неизвестен (manual / нет счёта по сетам)"; }
      else if (favSets == null || oppSets == null) { status = "unresolved"; note = "счёт по сетам не читается на финале"; }
      else {
        // The favourite started set 2 down 0-1; reaching ≥1 set means they WON set 2 (the comeback thesis).
        set2 = favSets >= 1 ? "won" : "lost";
        if (fin.retired && fin.advancing != null) match = fin.advancing === s.fav_side ? "won" : "lost";
        else if (favSets >= 2) match = "won";
        else if (oppSets >= 2) match = "lost";
        else { status = "unresolved"; note = "финал без решающего счёта по сетам"; }
      }
    }
    db.prepare(
      `UPDATE sv_shadow_signals SET status=?, set2_outcome=?, match_outcome=?, min_cents=?, max_cents=?, resolve_note=?, resolved_at=? WHERE id=?`,
    ).run(status, set2, match, path.min, path.max, note, now, s.id);
    if (status === "unresolved") unresolved++; else resolved++;
  }
  return { resolved, unresolved };
}

export interface SvCohortBin {
  label: string; n: number;
  comebackSet2Pct: number | null;  // P(favourite won set 2 | lost set 1) — the thesis
  winMatchPct: number | null;      // P(favourite won the match) — the P&L terminal
  meanDrawdownCents: number | null; // mean of (trigger − min) — how far it fell before resolving
  meanTakeAvailCents: number | null;// mean of (max − trigger) — how much take was on the table
}

export interface SvShadowCalibration {
  criteria: string[];
  counts: { total: number; pending: number; resolved: number; void: number; unresolved: number; repeats: number };
  bins: SvCohortBin[];                 // by frozen favourite strength × tour
  overall: SvCohortBin | null;
  constComebackProb: number;           // the hardcoded 0.5 being replaced — shown against measured
  criterion: { verdictBinN: number; totalN: number; verdictBinMet: boolean; totalMet: boolean };
  verdict: "insufficient" | "measured";
  note: string;
}

const VERDICT_BIN_N = 40, TOTAL_N = 80;

/** Cohort report: measured P(comeback) vs the 0.5 constant, binned by FROZEN favourite strength and tour.
 *  Mechanical verdict — `measured` only when a verdict bin has n≥40 AND total n≥80 (criterion fixed here,
 *  before the data). This is what replaces the constant at re-enable (§P1.1). */
export function buildSvShadowCalibration(db: Database): SvShadowCalibration {
  const rows = db.prepare(
    `SELECT tour, event_type, prematch_ml_cents pm, trigger_cents trig, set2_outcome s2, match_outcome mo, min_cents mn, max_cents mx, status, hits FROM sv_shadow_signals`,
  ).all() as { tour: string | null; event_type: string | null; pm: number | null; trig: number; s2: string | null; mo: string | null; mn: number | null; mx: number | null; status: string; hits: number }[];

  const counts = { total: rows.length, pending: 0, resolved: 0, void: 0, unresolved: 0, repeats: 0 };
  for (const r of rows) { (counts as any)[r.status] = ((counts as any)[r.status] ?? 0) + 1; counts.repeats += Math.max(0, (r.hits ?? 1) - 1); }

  // Only rows with a real set-2 outcome feed the comeback rate.
  const scored = rows.filter((r) => r.status === "resolved" && (r.s2 === "won" || r.s2 === "lost"));
  const isWta = (r: { tour: string | null; event_type: string | null }) => /wta|women|itf.*w|\bw\b/i.test(`${r.tour ?? ""} ${r.event_type ?? ""}`);
  const strengthBin = (pm: number | null): string | null => (pm == null ? null : pm >= 80 ? "80+" : pm >= 70 ? "70-80" : pm >= 60 ? "60-70" : "<60");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pct = (xs: number[]) => (xs.length ? Math.round(1000 * (mean(xs) ?? 0)) / 10 : null);
  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

  const bin = (label: string, rs: typeof scored): SvCohortBin => ({
    label, n: rs.length,
    comebackSet2Pct: pct(rs.map((r) => (r.s2 === "won" ? 1 : 0))),
    winMatchPct: pct(rs.map((r) => (r.mo === "won" ? 1 : 0))),
    meanDrawdownCents: r1(mean(rs.filter((r) => r.mn != null).map((r) => r.trig - (r.mn as number)))),
    meanTakeAvailCents: r1(mean(rs.filter((r) => r.mx != null).map((r) => (r.mx as number) - r.trig))),
  });

  const bins: SvCohortBin[] = [];
  for (const tourKey of ["ATP", "WTA"]) {
    const tourRows = scored.filter((r) => (tourKey === "WTA") === isWta(r));
    for (const sb of ["60-70", "70-80", "80+", "<60"]) {
      const rs = tourRows.filter((r) => strengthBin(r.pm) === sb);
      if (rs.length) bins.push(bin(`${tourKey} · фаворит ${sb}¢`, rs));
    }
  }
  const overall = scored.length ? bin("Всего (разрешённые)", scored) : null;

  // The verdict bin = the largest strength bin; matured when it reaches n≥40 AND total scored ≥80.
  const biggest = bins.reduce<SvCohortBin | null>((a, b) => (a && a.n >= b.n ? a : b), null);
  const verdictBinMet = (biggest?.n ?? 0) >= VERDICT_BIN_N;
  const totalMet = scored.length >= TOTAL_N;
  const verdict: SvShadowCalibration["verdict"] = verdictBinMet && totalMet ? "measured" : "insufficient";
  const note = verdict === "measured"
    ? `ИЗМЕРЕНО: замени 0.5 на P(камбэк-сет2) по бину силы фаворита. Крупнейший бин «${biggest?.label}» n=${biggest?.n}, P(камбэк)=${biggest?.comebackSet2Pct}% против константы 50%.`
    : `копим: крупнейший бин ${biggest?.n ?? 0}/${VERDICT_BIN_N}, всего ${scored.length}/${TOTAL_N} разрешённых. Это НЕ немой ноль — данные идут; деньги стоят (flag-only). unresolved=${counts.unresolved} — следи, это диагностика привязки скаута/резолва.`;

  return {
    criteria: [
      "Сигнал заморожен полем на триггере: предматч-ML фаворита (P0.3), цена триггера, счёт 1-го сета ИЗ СНАПШОТОВ (P0.4), токен+ориентация. Резолв ничего не пересчитывает из инференса.",
      "Дедуп: одна строка на матч (событие «проиграл сет 1» единично); повторы бампят hits.",
      "Резолв — оба исхода из финального счёта по сетам: выиграл сет 2 (тезис камбэка) и выиграл матч (терминал P&L). Fail-closed: нет счёта / manual → unresolved с причиной (считается).",
      "Путь цены за сет 2: min (просадка — калибровка floor из СВОЕЙ когорты) и max (доступный тейк).",
      "Вердикт только при n≥40 в вердиктном бине И n≥80 суммарно; бины — сила фаворита (60-70/70-80/80+) × ATP/WTA. Часы критерия с деплоя; денежные ставки под 0.5 — диагностика, не калибровка.",
    ],
    counts, bins, overall,
    constComebackProb: 0.5,
    criterion: { verdictBinN: VERDICT_BIN_N, totalN: TOTAL_N, verdictBinMet, totalMet },
    verdict, note,
  };
}
