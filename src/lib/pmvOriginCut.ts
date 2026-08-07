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

import { clvLeg } from "./clv.js";
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
export const STOP_FIX_CUTOFF_DEFAULT = "2026-07-17T01:08:00Z";
const STOP_FIX_CUTOFF = process.env.STOP_FIX_CUTOFF_ISO || STOP_FIX_CUTOFF_DEFAULT;

/**
 * [07.08] ОТСЕЧКА СПОРНА — И СПОР РАЗРЕШАЕТСЯ ЗАМЕРОМ, А НЕ ПАМЯТЬЮ.
 *
 * Владелец помнит деплой a3ac8e4 как «~01:40 UTC»; в коде выведено 01:08 (старт деплоя 01:06:07 + сборка
 * 1м53с) и сверено по трём именным PMV-«победам» 00:55/01:02/01:03, которые обязаны падать в pre_fix.
 * Проверка их НЕ различает: обе версии позже 01:03.
 *
 * Двигать вердикт-релевантную константу по воспоминанию нельзя В ОБЕ СТОРОНЫ: сдвиг вперёд загоняет
 * честные пост-фиксовые строки в грязную эпоху, сдвиг назад тащит грязь в чистую. Поэтому вместо выбора
 * отчёт получает (а) ПРОВЕНАНС отсечки — откуда взялось это число, (б) what-if через параметр, (в) список
 * строк У САМОЙ ГРАНИЦЫ. Если в спорном окне нет ни одной строки, спор пуст, и это видно одним запросом.
 */
export const BOUNDARY_WINDOW_H = 3;

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
export interface PmvBoundaryRow {
  settledAt: string; family: PmvFamily; origin: string | null; source: string;
  outcome: "won" | "lost" | "void" | "open"; pnl: number | null; epoch: "pre_fix" | "post_fix" | "open";
}

export interface PmvOriginCut {
  criteria: string[];
  stopFixCutoff: string;
  /** ОТКУДА взялась отсечка. Число без источника — это мнение, а вердикт на мнении не стоит. */
  cutoffSource: "code_default" | "env" | "query_whatif";
  cutoffProvenance: string;
  /** Строки, чья эпоха зависит от ТОЧНОЙ минуты отсечки. Пустой список = спор о минуте пуст. */
  boundaryWindowHours: number;
  boundaryRows: PmvBoundaryRow[];
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

export function buildPmvOriginCut(db: Database, opts: { cutoff?: string | null } = {}): PmvOriginCut {
  const whatIf = opts.cutoff && /^\d{4}-\d\d-\d\dT/.test(opts.cutoff) ? opts.cutoff : null;
  const cutoff = whatIf ?? STOP_FIX_CUTOFF;
  const cutoffSource: PmvOriginCut["cutoffSource"] = whatIf ? "query_whatif"
    : process.env.STOP_FIX_CUTOFF_ISO ? "env" : "code_default";
  const cutMs = Date.parse(cutoff) || 0;
  const boundary: PmvOriginCut["boundaryRows"] = [];
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
    // [пункт 6] CLV — по линии закрытия из снимков, а не по `closing_price` (при досрочном выходе там наша
    // цена выхода, при расчёте — цена разрешения; см. clv.ts). Нет линии → нет числа, а не суррогат.
    const mm = R.getMatch(db, b.match_id);
    const clv = mm ? clvLeg(db, mm, { market_label: b.market_label, entry_price: b.entry_price, entry_meta: b.entry_meta ?? null }).clvCents : null;
    const outcome: Row["outcome"] = !settled ? "open" : b.result === "won" ? "won" : b.result === "lost" ? "lost" : "void";
    const pnl = settled && b.payout != null ? Math.round((b.payout - (b.stake ?? 0)) * 100) / 100 : null;
    const settledAt = (b as any).settled_at as string | null;
    const stamp = settledAt ?? b.created_at;
    const epoch: Row["epoch"] = !settled ? "open" : stamp >= cutoff ? "post_fix" : "pre_fix";
    // Строки У ГРАНИЦЫ: те, чья эпоха зависит от точной минуты отсечки. Пустой список — доказательство,
    // что спор о минуте ни на что не влияет; непустой — поимённый счёт того, что стоит на кону.
    const stampMs = Date.parse(stamp) || 0;
    if (settled && cutMs && Math.abs(stampMs - cutMs) <= BOUNDARY_WINDOW_H * 3_600_000
        && src != null && VERDICT_SOURCES.has(src)) {
      boundary.push({ settledAt: stamp, family: pmvFamily(b.market_label), origin: (b as any).origin ?? null,
        source: src, outcome: !settled ? "open" : b.result === "won" ? "won" : b.result === "lost" ? "lost" : "void",
        pnl: b.payout != null ? Math.round((b.payout - (b.stake ?? 0)) * 100) / 100 : null, epoch });
    }
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
    stopFixCutoff: cutoff,
    cutoffSource,
    cutoffProvenance: cutoffSource === "code_default"
      ? `выведена из деплоя a3ac8e4: старт 2026-07-17T01:06:07Z + сборка 1м53с → Live 01:08; сверена по трём PMV-«победам» 00:55/01:02/01:03, падающим в pre_fix`
      : cutoffSource === "env" ? "переопределена переменной окружения STOP_FIX_CUTOFF_ISO"
        : "what-if из параметра запроса — НЕ действующая отсечка, только пересчёт «а если бы»",
    boundaryWindowHours: BOUNDARY_WINDOW_H,
    boundaryRows: boundary.sort((x, y) => x.settledAt.localeCompare(y.settledAt)),
    originSourceCounts,
    dataHealth: { total: bets.length, originNull, unknownSource, valid },
    verdictCells, diagnosticInferredCells, note,
  };
}
