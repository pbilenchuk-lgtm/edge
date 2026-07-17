// ============================================================
// EDGE LAB — pmv_origin_cut  [SERVER-ONLY, read-only]
//
// Judge FOOTBALL Pre-match Value (PMV) as its own strategy, cut by ORIGIN (prematch vs live) × FAMILY
// (totals / btts / handicap / outcome) × EPOCH (pre / post stop-fix). Metrics CLV / win% / P&L kept
// SEPARATE, with each metric's validity flagged per epoch. The verdict is mechanical from the header
// criteria — no interpretation needed.
//
// Trust hierarchy (Petro): verdict metrics come ONLY from origin_source ∈ {decision, meta_backfill}
// (both are the decision-time field); 'inferred_backfill' is a lower-trust reconstruction of legacy
// rows → a SEPARATE diagnostic block, never a verdict.
//
// Epoch: the stop-bug poisoned EXITS (dumped winning Unders), so a bet whose exit ran under the buggy
// code has garbage win%/P&L but INTACT CLV (entry-vs-close, untouched by the exit). Pre-fix → CLV only;
// post-fix → all three. Split by the bet's settle time vs STOP_FIX_CUTOFF.
//
// SELF-VALIDATING: the header counts origin_source and refuses to be silent on a broken column — if any
// PMV row has origin IS NULL or an unknown source, `valid=false` and the note screams. The report is its
// own precondition check, so "is the column confirmed?" is answered mechanically, not by remembering order.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

const PMV = "prematch_value";
const KNOWN_SOURCES = new Set(["decision", "meta_backfill", "inferred_backfill"]);
const VERDICT_SOURCES = new Set(["decision", "meta_backfill"]);
// The stop-fix (circuit-break + Under-stop suppression, commit a3ac8e4) deploy boundary — a bet whose
// EXIT ran after this had un-poisoned win%/P&L. Pinned to the real Render deploy time: a3ac8e4 went
// Live 2026-07-17 01:08 UTC (deploy start 01:06:07 + 1m53s build). Verified against settled_at: three
// PMV "wins" at 00:55/01:02/01:03 UTC settled under the BUGGY exit and correctly fall to pre_fix.
// Env-overridable for what-if re-cuts.
const STOP_FIX_CUTOFF = process.env.STOP_FIX_CUTOFF_ISO || "2026-07-17T01:08:00Z";

export type PmvFamily = "totals" | "btts" | "handicap" | "outcome" | "other";
export function pmvFamily(label: string): PmvFamily {
  const l = label.toLowerCase();
  if (/both teams to score|\bbtts\b/.test(l)) return "btts";
  if (/\bover\b|\bunder\b|o\/u/.test(l)) return "totals";
  if (/[+-]\s*\d/.test(l)) return "handicap";
  if (/\bdraw\b|ничья|\bhome\b|\baway\b|to win|1x2|double chance|no bet|\bdnb\b|or draw/.test(l)) return "outcome";
  return "other";
}

export interface PmvCell { origin: string; family: PmvFamily; epoch: "pre_fix" | "post_fix"; n: number; clvMean: number | null; winPct: number | null; pnlSum: number; winPnlValid: boolean }
export interface PmvOriginCut {
  criteria: string[];
  stopFixCutoff: string;
  originSourceCounts: Record<string, number>;
  dataHealth: { total: number; originNull: number; unknownSource: number; valid: boolean };
  verdictCells: PmvCell[];        // origin_source ∈ {decision, meta_backfill}
  diagnosticInferredCells: PmvCell[]; // origin_source = inferred_backfill (never a verdict)
  note: string;
}

interface Row { origin: string | null; source: string | null; family: PmvFamily; epoch: "pre_fix" | "post_fix" | "open"; clv: number | null; outcome: "won" | "lost" | "void" | "open"; pnl: number | null }

function cellsFrom(rows: Row[]): PmvCell[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.epoch === "open" || r.origin == null) continue; // unsettled or origin-less → not a cell
    const k = `${r.origin}|${r.family}|${r.epoch}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: PmvCell[] = [];
  for (const [k, rs] of groups) {
    const [origin, family, epoch] = k.split("|") as [string, PmvFamily, "pre_fix" | "post_fix"];
    const clvs = rs.map((r) => r.clv).filter((x): x is number => x != null);
    const won = rs.filter((r) => r.outcome === "won").length, lost = rs.filter((r) => r.outcome === "lost").length;
    const pnlSum = Math.round(rs.reduce((s, r) => s + (r.pnl ?? 0), 0) * 100) / 100;
    out.push({
      origin, family, epoch, n: rs.length,
      clvMean: clvs.length ? Math.round(clvs.reduce((a, b) => a + b, 0) / clvs.length * 10) / 10 : null,
      winPct: won + lost > 0 ? Math.round(won / (won + lost) * 1000) / 1000 : null,
      pnlSum,
      winPnlValid: epoch === "post_fix", // pre-fix win%/P&L are poisoned by the exit bug → CLV only
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

export function buildPmvOriginCut(db: Database): PmvOriginCut {
  const bets = R.allBets(db).filter((b) => b.strategy_id === PMV);
  const originSourceCounts: Record<string, number> = {};
  let originNull = 0, unknownSource = 0;
  const rows: Row[] = [];
  for (const b of bets) {
    const src = (b as any).origin_source ?? null;
    originSourceCounts[src ?? "(null)"] = (originSourceCounts[src ?? "(null)"] ?? 0) + 1;
    if ((b as any).origin == null) originNull++;
    if (src != null && !KNOWN_SOURCES.has(src)) unknownSource++;
    const settled = R.isSettled(b.status);
    const entry = b.entry_price, closing = b.closing_price;
    const clv = entry != null && closing != null ? Math.round((closing - entry) * 10) / 10 : null;
    const outcome: Row["outcome"] = !settled ? "open" : b.result === "won" ? "won" : b.result === "lost" ? "lost" : "void";
    const pnl = settled && b.payout != null ? Math.round((b.payout - (b.stake ?? 0)) * 100) / 100 : null;
    const settledAt = (b as any).settled_at as string | null;
    const epoch: Row["epoch"] = !settled ? "open" : (settledAt ?? b.created_at) >= STOP_FIX_CUTOFF ? "post_fix" : "pre_fix";
    rows.push({ origin: (b as any).origin ?? null, source: src, family: pmvFamily(b.market_label), epoch, clv, outcome, pnl });
  }
  const valid = originNull === 0 && unknownSource === 0;
  const verdictCells = cellsFrom(rows.filter((r) => r.source != null && VERDICT_SOURCES.has(r.source)));
  const diagnosticInferredCells = cellsFrom(rows.filter((r) => r.source === "inferred_backfill"));

  const note = !valid
    ? `⛔ КОЛОНКА НЕ ПОДТВЕРЖДЕНА: origin IS NULL у ${originNull}, неизвестный source у ${unknownSource} из ${bets.length} PMV-ставок — прогнать миграцию (migrateBetOrigin) до чтения вердикта. Отчёт отказывается судить на кривой базе.`
    : bets.length === 0 ? "PMV-ставок нет — нечего резать"
      : `база чиста (0 null / 0 unknown). Вердиктные срезы — по origin_source∈{decision,meta_backfill}; inferred_backfill — отдельно, диагностика. Судить пост-фиксовую эпоху по согласию CLV+win%+P&L при n≥порога; до-фиксовую — только CLV.`;

  return {
    criteria: [
      "Вердиктные метрики ТОЛЬКО по origin_source ∈ {decision, meta_backfill}; inferred_backfill — диагностика, не вердикт.",
      "До-фиксовая эпоха (exit < cutoff): валиден ТОЛЬКО CLV (вход vs close, не тронут стоп-багом); win%/P&L — мусор (winPnlValid=false).",
      "Пост-фиксовая эпоха: все три метрики валидны (winPnlValid=true).",
      "Вердикт по семье — только при n≥20 в ней; live-PMV предварительный n≥30, устойчивый n≥50.",
      "Вердикт — ТОЛЬКО при согласии CLV + win% + P&L на чистой (пост-фиксовой) эпохе. Расхождение = вопрос, не вердикт.",
      "Симметрично: prematch × totals пост-фикс — тот же срез пересуживает сброшенный вердикт предматч-тоталов (−$1030), когда n дозреет.",
    ],
    stopFixCutoff: STOP_FIX_CUTOFF,
    originSourceCounts,
    dataHealth: { total: bets.length, originNull, unknownSource, valid },
    verdictCells, diagnosticInferredCells, note,
  };
}
