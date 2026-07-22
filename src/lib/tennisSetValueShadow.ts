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

// T5: net-EV of a bin by the ACTUAL payout structure — the re-enable criterion is structural (the
// «take half / floor whole» asymmetry is IN the number), not a win% remark. All params measured; fees +
// fill-drift subtracted. Reported next to P(comeback) so the verdict reads mechanically.
export interface SvBinEv {
  entryMedianCents: number | null;   // median set-2 trigger price of the bin's SHADOW rows (EV basis)
  nEvBasis: number;                  // shadow rows with a trigger price (the EV is computed on these)
  pComeback: number | null;          // P(won set 2)
  pWinGivenComeback: number | null;  // P(won match | won set 2)
  takeCents: number; floorCents: number | null; feeCents: number; fillDriftCents: number;
  evPerShareCents: number | null;    // expected P&L per share (price units), net of fees + drift
  evReturnPct: number | null;        // evPerShare / entry — the margin the ≥3pp threshold reads
  verdict: "reenable" | "hold" | "insufficient";
}
export interface SvCohortBin {
  label: string; n: number;
  comebackSet2Pct: number | null;  // P(favourite won set 2 | lost set 1) — the thesis
  winMatchPct: number | null;      // P(favourite won the match) — the P&L terminal
  meanDrawdownCents: number | null; // mean of (trigger − min) — how far it fell before resolving
  meanTakeAvailCents: number | null;// mean of (max − trigger) — how much take was on the table
  ev?: SvBinEv | null;             // T5 net-EV (present on verdict bins that have a shadow entry basis)
}

// ── P1.1: RETRO cohort — reconstruct the comeback rate from EXISTING snapshot history ──────────────
// The shadow cohort (above) grows forward; this backfills the same measurement from tennis_snapshots we
// already have, because MARKS ARE PRICES, not decisions poisoned by the 0.5 constant. Per match: a
// verified pre-match favourite (≥55¢) who LOST set 1, with a readable set-2 / match outcome. Same two
// outcomes as the shadow resolve. Pure read.
export interface SvCohortRow { tour: string | null; eventType: string | null; prematchCents: number; set2: "won" | "lost" | null; match: "won" | "lost" | "void" | null; source: "retro" | "shadow" }

export function svRetroCohort(db: Database): SvCohortRow[] {
  const ids = db.prepare(`SELECT DISTINCT pm_match_id id FROM tennis_snapshots WHERE pm_match_id IS NOT NULL`).all() as { id: string }[];
  const out: SvCohortRow[] = [];
  for (const { id } of ids) {
    const snaps = db.prepare(`SELECT sets_p1, sets_p2, pm_p1_cents, pm_p2_cents, tournament, event_type, live, status FROM tennis_snapshots WHERE pm_match_id=? AND sets_p1 IS NOT NULL ORDER BY batch_at`).all(id) as any[];
    if (snaps.length < 3) continue;
    const firstPriced = snaps.find((s) => s.pm_p1_cents != null && s.pm_p2_cents != null);
    if (!firstPriced) continue;
    const favSide: "first" | "second" = firstPriced.pm_p1_cents >= firstPriced.pm_p2_cents ? "first" : "second";
    const prematch = favSide === "first" ? firstPriced.pm_p1_cents : firstPriced.pm_p2_cents;
    if (prematch == null || prematch < 55) continue;                      // not a real pre-match favourite
    const afterSet1 = snaps.find((s) => (s.sets_p1 ?? 0) + (s.sets_p2 ?? 0) >= 1);
    if (!afterSet1) continue;
    const favSet1 = favSide === "first" ? afterSet1.sets_p1 : afterSet1.sets_p2;
    if (favSet1 !== 0) continue;                                          // favourite did NOT lose set 1
    const last = snaps[snaps.length - 1];
    const finished = last.live === 0 || /finish|retir|walk|cancel|def|w[/.]o/i.test(String(last.status ?? ""));
    if (!finished) continue;
    const row = { tour: firstPriced.tournament ?? null, eventType: firstPriced.event_type ?? null, prematchCents: prematch, source: "retro" as const };
    if (/cancel|walkover/i.test(String(last.status ?? ""))) { out.push({ ...row, set2: null, match: "void" }); continue; }
    const favFinal = favSide === "first" ? last.sets_p1 : last.sets_p2;
    const oppFinal = favSide === "first" ? last.sets_p2 : last.sets_p1;
    if (favFinal == null || oppFinal == null) continue;
    const set2: "won" | "lost" = favFinal >= 1 ? "won" : "lost";
    const match = favFinal >= 2 ? "won" : oppFinal >= 2 ? "lost" : null;
    if (match == null) continue;                                         // no decisive set outcome
    out.push({ ...row, set2, match });
  }
  return out;
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

export interface SvCohort {
  criteria: string[];
  sources: { retro: number; shadow: number };
  bins: SvCohortBin[];        // strength × tour, VERDICT bins (60-70/70-80/80+) only
  quarantine: SvCohortBin | null; // the 55-60 «<60» sensitivity band, kept apart from the verdict
  overall: SvCohortBin | null;
  constComebackProb: number;
  criterion: { verdictBinN: number; totalN: number; verdictBinMet: boolean; totalMet: boolean };
  verdict: "insufficient" | "measured";
  note: string;
}

/** P1.1: the combined cohort — retro (backfilled from snapshot history) + shadow (frozen forward). Both are
 *  prices, not decisions, so retro is not poisoned by the 0.5 constant. Measured P(comeback set 2) and
 *  P(win match) per frozen favourite-strength bin × ATP/WTA — the number that replaces 0.5 at re-enable. */
// T5 net-EV of a bin, in PRICE units (cents/share), by the real set_value payout structure:
//   EV = P·[takeFrac·(take−e) + (1−takeFrac)·EV_rem] + (1−P)·(floor−e),  EV_rem = pWin·(1−e) − (1−pWin)·e,
// remainder held to settlement (win→1, loss→0). Net of round-trip taker fees + a fill-drift haircut.
export function svComputeEv(
  entryMedianCents: number | null, nEvBasis: number, pComebackPct: number | null, pWinGivenComebackPct: number | null,
  env: Record<string, string | undefined> = process.env,
): SvBinEv {
  const takeCents = Math.max(1, Number(env.TENNIS_SV_TAKE_LOW_CENTS ?? 55));
  const floorBelow = Math.max(0, Number(env.TENNIS_SV_FLOOR_BELOW_CENTS ?? 12));
  const feeRate = Math.max(0, Number(env.POLYMARKET_TAKER_FEE_RATE ?? 0.02));
  const fillDriftCents = Math.max(0, Number(env.SV_EV_FILL_DRIFT_CENTS ?? 0)); // flag-only → no fills yet; T4 logs feed this later
  const takeFrac = Math.min(1, Math.max(0.1, Number(env.TENNIS_SV_TAKE_FRACTION ?? 0.5)));
  const base: SvBinEv = { entryMedianCents, nEvBasis, pComeback: pComebackPct == null ? null : pComebackPct / 100, pWinGivenComeback: pWinGivenComebackPct == null ? null : pWinGivenComebackPct / 100, takeCents, floorCents: entryMedianCents == null ? null : Math.round((entryMedianCents - floorBelow) * 10) / 10, feeCents: 0, fillDriftCents, evPerShareCents: null, evReturnPct: null, verdict: "insufficient" };
  if (entryMedianCents == null || pComebackPct == null || pWinGivenComebackPct == null) return base;
  const e = entryMedianCents / 100, take = takeCents / 100, floor = (entryMedianCents - floorBelow) / 100;
  const P = pComebackPct / 100, pw = pWinGivenComebackPct / 100;
  const evRem = pw * (1 - e) - (1 - pw) * e;                 // remainder held to settle
  const perShare = P * (takeFrac * (take - e) + (1 - takeFrac) * evRem) + (1 - P) * (floor - e);
  const feeCents = Math.round(2 * feeRate * entryMedianCents * 10) / 10; // round-trip taker, in cents
  const perShareNet = perShare - feeCents / 100 - fillDriftCents / 100;
  const evReturnPct = e > 0 ? Math.round((perShareNet / e) * 1000) / 10 : null;
  const marginPp = Math.max(0, Number(env.SV_EV_MARGIN_PP ?? 3));
  const verdict: SvBinEv["verdict"] = nEvBasis < VERDICT_BIN_N ? "insufficient" : (evReturnPct != null && evReturnPct >= marginPp ? "reenable" : "hold");
  return { ...base, feeCents, evPerShareCents: Math.round(perShareNet * 1000) / 10, evReturnPct, verdict };
}

export function buildSvCohort(db: Database, env: Record<string, string | undefined> = process.env): SvCohort {
  const retro = svRetroCohort(db);
  const shadowRows = db.prepare(`SELECT tour, event_type, prematch_ml_cents pm, set2_outcome s2, match_outcome mo FROM sv_shadow_signals WHERE status='resolved'`).all() as any[];
  // T5: shadow rows WITH the set-2 trigger (entry) price — the EV basis (retro rows have no set-2 entry).
  const evShadow = db.prepare(`SELECT tour, event_type, prematch_ml_cents pm, trigger_cents trig, set2_outcome s2, match_outcome mo FROM sv_shadow_signals WHERE status='resolved' AND set2_outcome IN ('won','lost') AND trigger_cents IS NOT NULL AND prematch_ml_cents >= 60`).all() as any[];
  const shadow: SvCohortRow[] = shadowRows.map((r) => ({ tour: r.tour, eventType: r.event_type, prematchCents: r.pm ?? 0, set2: r.s2 ?? null, match: r.mo ?? null, source: "shadow" as const }));
  const all = [...retro, ...shadow].filter((r) => r.set2 === "won" || r.set2 === "lost"); // scoreable rows only

  const isWta = (r: SvCohortRow) => /wta|women|itf.*w|\bw\b/i.test(`${r.tour ?? ""} ${r.eventType ?? ""}`);
  const strengthBin = (pm: number): string => (pm >= 80 ? "80+" : pm >= 70 ? "70-80" : pm >= 60 ? "60-70" : "<60");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pct = (xs: number[]) => (xs.length ? Math.round(1000 * (mean(xs) ?? 0)) / 10 : null);
  const bin = (label: string, rs: SvCohortRow[]): SvCohortBin => ({
    label, n: rs.length,
    comebackSet2Pct: pct(rs.map((r) => (r.set2 === "won" ? 1 : 0))),
    winMatchPct: pct(rs.map((r) => (r.match === "won" ? 1 : 0))),
    meanDrawdownCents: null, meanTakeAvailCents: null, // price path is shadow-only (retro doesn't re-walk it)
  });

  const verdictRows = all.filter((r) => r.prematchCents >= 60);
  // T5 EV plumbing: median entry + P(win|comeback) per bin, from the shadow subset that carries a trigger.
  const isWtaR = (r: any) => /wta|women|itf.*w|\bw\b/i.test(`${r.tour ?? ""} ${r.event_type ?? ""}`);
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);
  const attachEv = (b: SvCohortBin, rs: SvCohortRow[], evRs: any[]): SvCohortBin => {
    const trigs = evRs.map((r) => r.trig).filter((x: number) => Number.isFinite(x));
    const comeback = rs.filter((r) => r.set2 === "won");
    const pWinGivenComeback = comeback.length ? Math.round((1000 * comeback.filter((r) => r.match === "won").length) / comeback.length) / 10 : null;
    b.ev = svComputeEv(median(trigs), trigs.length, b.comebackSet2Pct, pWinGivenComeback, env);
    return b;
  };
  const bins: SvCohortBin[] = [];
  for (const tourKey of ["ATP", "WTA"]) {
    const tr = verdictRows.filter((r) => (tourKey === "WTA") === isWta(r));
    for (const sb of ["60-70", "70-80", "80+"]) {
      const rs = tr.filter((r) => strengthBin(r.prematchCents) === sb);
      if (rs.length) bins.push(attachEv(bin(`${tourKey} · фаворит ${sb}¢`, rs), rs, evShadow.filter((r) => (tourKey === "WTA") === isWtaR(r) && strengthBin(r.pm) === sb)));
    }
  }
  const quar = all.filter((r) => r.prematchCents < 60);
  const quarantine = quar.length ? bin("Чувствительная полоса 55-60¢ (не в вердикте)", quar) : null;
  const overall = verdictRows.length ? attachEv(bin("Всего (вердиктные, ≥60¢)", verdictRows), verdictRows, evShadow) : null;
  const reenable = bins.filter((b) => b.ev?.verdict === "reenable").map((b) => b.label);

  const biggest = bins.reduce<SvCohortBin | null>((a, b) => (a && a.n >= b.n ? a : b), null);
  const verdictBinMet = (biggest?.n ?? 0) >= VERDICT_BIN_N;
  const totalMet = verdictRows.length >= TOTAL_N;
  const verdict: SvCohort["verdict"] = verdictBinMet && totalMet ? "measured" : "insufficient";
  const evNote = reenable.length
    ? ` T5 net-EV: бин(ы) под ре-включение (EV ≥ ${Math.max(0, Number(env.SV_EV_MARGIN_PP ?? 3))}пп, n≥${VERDICT_BIN_N}): ${reenable.join("; ")}.`
    : ` T5 net-EV: ни один бин пока не проходит (EV ≥ ${Math.max(0, Number(env.SV_EV_MARGIN_PP ?? 3))}пп при n≥${VERDICT_BIN_N}) — держим flag-only.`;
  const note = (verdict === "measured"
    ? `ИЗМЕРЕНО (retro ${retro.length} + shadow ${shadow.length}): заменяй 0.5 на P(камбэк) по бину. Крупнейший «${biggest?.label}» n=${biggest?.n} P=${biggest?.comebackSet2Pct}% vs константа 50%.`
    : `копим: крупнейший бин ${biggest?.n ?? 0}/${VERDICT_BIN_N}, всего вердиктных ${verdictRows.length}/${TOTAL_N} (retro ${retro.length} + shadow ${shadow.length}). Retro даёт мгновенный n из истории марок; shadow растёт вперёд.`) + evNote;

  return {
    criteria: [
      "Ретро-когорта восстановлена из tennis_snapshots (марки — ЦЕНЫ, не решения под константой 0.5): верифицированный предматч-фаворит ≥55¢, проиграл 1-й сет, читаемый исход сет2/матча.",
      "Shadow-когорта — замороженные вперёд would-be входы (те же два исхода).",
      "Вердиктные бины — только ≥60¢ (60-70/70-80/80+) × ATP/WTA; полоса 55-60¢ в карантине, не в вердикте.",
      "Достаточность (до данных): n≥40 в вердиктном бине И n≥80 суммарно вердиктных.",
      "P(камбэк-сет2) — тезис; P(win-match) — терминал P&L. Оба на бин.",
    ],
    sources: { retro: retro.length, shadow: shadow.length },
    bins, quarantine, overall,
    constComebackProb: 0.5,
    criterion: { verdictBinN: VERDICT_BIN_N, totalN: TOTAL_N, verdictBinMet, totalMet },
    verdict, note,
  };
}
