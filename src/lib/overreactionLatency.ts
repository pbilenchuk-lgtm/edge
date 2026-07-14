// ============================================================
// EDGE LAB — MEASUREMENT SLICE: Overreaction latency cost ("недобранное дно паники").
//
// Answers ONE number: how much price does Overreaction leave on the table because of the
// lag event → detection → LLM → fill? That decides whether a fast deterministic execution
// path for armed triggers (a §9.6 carve-out) is worth building.
//
// ROLLING design: the retro pass over historical snapshots returned nConfident=0 —
// snapshot retention had already dropped the windows. So metrics are now computed AT
// SETTLE, while the snapshots are still hot, and stored PERMANENTLY in
// comeback_latency_metrics. The report READS that table; snapshot retention no longer
// matters. The methodology (window, real bid, floor, missed, panic, recovery, thinness)
// is unchanged — only the call point + persistence + report source moved.
//
// Read-only to money-path: the compute runs after settle and is fully guarded — a failure
// is caught and logged, it NEVER blocks match settlement.
//
// Honest limitations (report footer):
//   · Snapshots store best bid/mid/ask but NOT order-book DEPTH → "hard floor" uses the
//     per-bet thinness proxy, flagged, not measured exactly.
//   · T_event = detection wall-clock (match_events.created_at), slight over-estimate.
//   · Pre-phantom-guard epochs (e1) flagged — floor could be phantom.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Bet, Match } from "./types.js";
import { parseEntryMeta } from "./betMeta.js";
import { effectiveCodeVersion } from "./codeEpoch.js";

// ── Pre-registered decision thresholds (median missed_cents, hard floor) ──
export const MISSED_CLOSE_CENTS = 2; // ≤ this → bottleneck not worth a carve-out
export const MISSED_BUILD_CENTS = 5; // ≥ this → fast execution path justified
// Apply the criterion only once enough confident cases have accrued.
export const DECISION_MIN_N = 10;
export const TARGET_CONFIDENT = 12;

// ── Window + filtering constants (methodology — unchanged) ──
const WIN_PRE_MIN = 1;
const WIN_POST_MIN = 6;
const RECOVERY_MIN = [1, 2, 3, 5];
// Phantom-bid filter — MIRRORS the runtime exit guard (lifecycle EXIT_PHANTOM_FLOOR/GAP).
const PHANTOM_FLOOR = 5;
const PHANTOM_GAP = 8;
const SNAP_GAP_ALERT_SEC = 45;
const RECOVERY_TOL_SEC = 30;
const PHANTOM_SAFE_EPOCH = 2; // phantom-exit/untradeable guards landed at e2
// A non-entry event is only recorded as a comeback candidate if some market actually
// PANICKED (real bid dropped ≥ this vs the pre-event bid) — else it isn't an overreaction.
const NONENTRY_PANIC_MIN = 3;

const CLM_DONE = "clm_done:"; // per-match "computed once" marker (app_meta)

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const numOrNull = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r1 = (n: number) => Math.round(n * 10) / 10;

interface Quote { tMs: number; bid: number | null; mid: number | null; ask: number | null }

/** A real, executable bid — not empty and not a phantom low-ball far under the mid. */
function realBid(q: Quote): number | null {
  if (q.bid == null || q.bid <= 0) return null;
  if (q.bid <= PHANTOM_FLOOR && q.mid != null && (q.mid - q.bid) >= PHANTOM_GAP) return null;
  return q.bid;
}

/** Bid/mid/ask time series for one market from a match's Polymarket snapshots, ascending. */
export function polymarketSeries(rows: { provider: string; batch_at: string; extracted: string | null }[], marketLabel: string): Quote[] {
  const key = norm(marketLabel);
  const out: Quote[] = [];
  for (const rw of rows) {
    if (rw.provider !== "polymarket" || !rw.extracted) continue;
    let ext: any; try { ext = JSON.parse(rw.extracted); } catch { continue; }
    const mk = Array.isArray(ext?.markets) ? ext.markets.find((m: any) => norm(String(m?.label ?? "")) === key) : null;
    if (!mk) continue;
    const tMs = Date.parse(rw.batch_at);
    if (!Number.isFinite(tMs)) continue;
    out.push({ tMs, bid: numOrNull(mk.bidCents), mid: numOrNull(mk.midCents), ask: numOrNull(mk.askCents) });
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

/** Leading integer epoch of a code_version label ("e5·m1·opus48" → 5); null if unparseable. */
export function baseEpochNum(codeVersion: string | null | undefined): number | null {
  const m = String(codeVersion ?? "").match(/^e(\d+)/i);
  return m ? Number(m[1]) : null;
}

const GOAL_RED = /goal|гол|red|красн|удал|penalty|пеналь/i;

/** The panic event a buyback responds to: the latest goal/red at or just before entry. */
export function findTriggerEvent(events: R.MatchEventRow[], entryMs: number): R.MatchEventRow | null {
  const FWD_TOL = 90_000;
  const cands = events
    .filter((e) => GOAL_RED.test(`${e.type} ${e.text}`))
    .map((e) => ({ e, tMs: Date.parse(e.created_at) }))
    .filter((x) => Number.isFinite(x.tMs) && x.tMs <= entryMs + FWD_TOL)
    .sort((a, b) => b.tMs - a.tMs);
  return cands.length ? cands[0].e : null;
}

interface EntryInfo { priceCents: number | null; atMs: number; thinnessUsd: number | null; stake: number | null }
interface WindowMetrics {
  priceFloorCents: number | null; tFloorSec: number | null; panicAmplitudeCents: number | null;
  entryPriceCents: number | null; tEntrySec: number | null; missedCents: number | null; lagFloorToEntrySec: number | null;
  recovery: Record<string, number | null>; floorThinnessUsd: number | null; paperFloor: boolean | null;
  windowQuotes: number; flags: string[];
}

/** THE methodology — unchanged. Given a market's bid series, the event wall-clock, and
 *  (optionally) an entry, compute floor / panic / recovery / missed / thinness + flags. */
export function computeWindowMetrics(series: Quote[], tEventMs: number, entry?: EntryInfo, codeVersion?: string | null): WindowMetrics {
  const flags: string[] = [];
  const lo = tEventMs - WIN_PRE_MIN * 60_000, hi = tEventMs + WIN_POST_MIN * 60_000;
  const win = series.filter((q) => q.tMs >= lo && q.tMs <= hi && realBid(q) != null);
  const epoch = baseEpochNum(codeVersion);
  if (epoch != null && epoch < PHANTOM_SAFE_EPOCH) flags.push("phantom_era");
  const rec: Record<string, number | null> = Object.fromEntries(RECOVERY_MIN.map((k) => [String(k), null]));
  const base: WindowMetrics = {
    priceFloorCents: null, tFloorSec: null, panicAmplitudeCents: null,
    entryPriceCents: entry?.priceCents ?? null,
    tEntrySec: entry && Number.isFinite(entry.atMs) && Number.isFinite(tEventMs) ? Math.round((entry.atMs - tEventMs) / 1000) : null,
    missedCents: null, lagFloorToEntrySec: null, recovery: rec,
    floorThinnessUsd: entry?.thinnessUsd ?? null, paperFloor: null, windowQuotes: win.length, flags,
  };
  if (!win.length) { flags.push("no_snapshots", "low_confidence"); return base; }

  let floorQ = win[0]; for (const q of win) if ((realBid(q) as number) < (realBid(floorQ) as number)) floorQ = q;
  const floor = realBid(floorQ) as number;
  base.priceFloorCents = r1(floor);
  base.tFloorSec = Math.round((floorQ.tMs - tEventMs) / 1000);

  const pre = series.filter((q) => q.tMs < tEventMs && realBid(q) != null);
  if (pre.length) base.panicAmplitudeCents = r1((realBid(pre[pre.length - 1]) as number) - floor);

  if (entry?.priceCents != null) base.missedCents = r1(entry.priceCents - floor);
  if (base.tEntrySec != null && base.tFloorSec != null) base.lagFloorToEntrySec = base.tEntrySec - base.tFloorSec;

  for (const k of RECOVERY_MIN) {
    const target = floorQ.tMs + k * 60_000;
    let best: Quote | null = null, bestD = Infinity;
    for (const q of win) { if (q.tMs < floorQ.tMs) continue; const d = Math.abs(q.tMs - target); if (d < bestD && d <= RECOVERY_TOL_SEC * 1000) { best = q; bestD = d; } }
    if (best) rec[String(k)] = r1((realBid(best) as number) - floor);
  }

  let maxGap = 0;
  for (let i = 1; i < win.length; i++) maxGap = Math.max(maxGap, (win[i].tMs - win[i - 1].tMs) / 1000);
  if (maxGap > SNAP_GAP_ALERT_SEC) flags.push("snapshot_gap", "low_confidence");
  if (floorQ.tMs >= hi - 20_000) flags.push("floor_at_window_edge");

  if (entry?.thinnessUsd != null && entry.stake != null) base.paperFloor = entry.thinnessUsd < entry.stake * 0.5;
  return base;
}

/** Is this bet a live Overreaction armed-trigger entry that actually filled? */
export function isOverreactionLiveEntry(b: Bet): boolean {
  if (b.strategy_id !== "overreaction") return false;
  if (b.entry_price == null) return false;
  if (b.status === "proposed" || b.status === "not_filled") return false;
  const meta = parseEntryMeta(b.entry_meta);
  if (meta?.phase === "live") return true;
  if (meta?.phase === "prematch") return false;
  return !/пред|prematch/i.test(b.entered_minute ?? "");
}

/** Numeric armed buyback targets (buyback_target/price_trigger) from a match's Overreaction battle sheets. */
function overreactionArmedTargets(db: Database, matchId: string): number[] {
  const out: number[] = [];
  for (const a of R.artifactsForMatch(db, matchId)) {
    if (a.kind !== "battle_sheet" || !/overreaction/i.test(a.label)) continue;
    try {
      const bs = JSON.parse(a.content);
      const arr = bs?.live_triggers_armed ?? bs?.strategist_plan?.live_triggers_armed;
      for (const t of Array.isArray(arr) ? arr : []) {
        const v = numOrNull(t?.buyback_target) ?? numOrNull(t?.price_trigger);
        if (v != null && v > 0 && v < 100) out.push(v);
      }
    } catch { /* free-text plan → skip */ }
  }
  return out;
}

/** The market that PANICKED most around an event (largest pre-event→floor drop). Null if none dipped. */
function deepestPanicMarket(db: Database, matchId: string, snaps: { provider: string; batch_at: string; extracted: string | null }[], evMs: number):
  { label: string; token: string | null; metrics: WindowMetrics } | null {
  let best: { label: string; token: string | null; metrics: WindowMetrics } | null = null;
  for (const mk of R.latestMarkets(db, matchId)) {
    const m = computeWindowMetrics(polymarketSeries(snaps, mk.label), evMs);
    if (m.priceFloorCents == null || m.panicAmplitudeCents == null) continue;
    if (m.panicAmplitudeCents < NONENTRY_PANIC_MIN) continue; // no real drop → not an overreaction
    if (!best || (m.panicAmplitudeCents as number) > (best.metrics.panicAmplitudeCents as number)) best = { label: mk.label, token: mk.external_ref ?? null, metrics: m };
  }
  return best;
}

const tokenFor = (db: Database, matchId: string, label: string): string | null =>
  R.latestMarkets(db, matchId).find((m) => norm(m.label) === norm(label))?.external_ref ?? null;

function toRow(
  db: Database, match: Match, caseType: string, market: string, token: string | null,
  ev: R.MatchEventRow, m: WindowMetrics, trig: { trigger: number | null; floorBelow: number | null }, codeVersion: string | null, now: string,
): R.ComebackLatencyRow {
  return {
    id: R.uid(), match_id: match.id, competition_id: match.competition_id, case_type: caseType,
    market_label: market, token, event_type: ev.type, event_text: ev.text, t_event: ev.created_at, event_minute: ev.minute,
    panic_amplitude_cents: m.panicAmplitudeCents, price_floor_cents: m.priceFloorCents, t_floor_sec: m.tFloorSec,
    entry_price_cents: m.entryPriceCents, t_entry_sec: m.tEntrySec, missed_cents: m.missedCents, lag_floor_to_entry_sec: m.lagFloorToEntrySec,
    recovery_1: m.recovery["1"], recovery_2: m.recovery["2"], recovery_3: m.recovery["3"], recovery_5: m.recovery["5"],
    floor_thinness_usd: m.floorThinnessUsd, paper_floor: m.paperFloor == null ? null : m.paperFloor ? 1 : 0,
    price_trigger_cents: trig.trigger, floor_below_trigger_cents: trig.floorBelow,
    window_quotes: m.windowQuotes, confidence_flags: m.flags.length ? m.flags.join(",") : null, code_version: codeVersion, created_at: now,
  };
}

/**
 * COMPUTE-AT-SETTLE: after a match is final, compute + persist its comeback latency cases
 * from the still-hot snapshots. Idempotent (a per-match marker) so repeated settle calls
 * don't duplicate. Returns rows written. Callers wrap this in try/catch — it must NEVER
 * throw into the settle path. Only runs on a finished match with a known score, and only
 * when Overreaction was actually involved (had a bet or armed a trigger on this match).
 */
export function recordComebackLatency(db: Database, match: Match, deps: { now?: () => string } = {}): number {
  const now = deps.now?.() ?? new Date().toISOString();
  if (R.metaGet(db, CLM_DONE + match.id)) return 0;                 // computed once already
  if (match.state !== "finished" || match.score_home == null || match.score_away == null) return 0;

  const ovrBets = R.betsForMatch(db, match.id, "overreaction").filter(isOverreactionLiveEntry);
  const armedTargets = overreactionArmedTargets(db, match.id);
  if (!ovrBets.length && !armedTargets.length) { R.metaSet(db, CLM_DONE + match.id, "1", now); return 0; } // overreaction not involved

  const snaps = R.snapshotMetaForMatch(db, match.id, 8000);
  const events = R.eventsForMatch(db, match.id).filter((e) => GOAL_RED.test(`${e.type} ${e.text}`));
  const enteredMk = new Set(ovrBets.map((b) => norm(b.market_label)));
  const rows: R.ComebackLatencyRow[] = [];

  // ENTRY cases — the precise ones: the bet gives the exact market + fill price.
  for (const b of ovrBets) {
    const ev = findTriggerEvent(events, Date.parse(b.created_at));
    const meta = parseEntryMeta(b.entry_meta);
    const entry: EntryInfo = { priceCents: b.entry_price, atMs: Date.parse(b.created_at), thinnessUsd: meta?.marketThinnessUsd ?? null, stake: b.stake ?? null };
    if (!ev) {
      // No trigger event in the feed — record the entry as low-confidence (T_event unknown).
      rows.push(toRow(db, match, "entry", b.market_label, tokenFor(db, match.id, b.market_label),
        { id: "", match_id: match.id, event_key: "", minute: null, type: "?", team: null, text: "нет события-триггера в ленте", created_at: b.created_at },
        { ...computeWindowMetrics([], Date.parse(b.created_at), entry, b.code_version), flags: ["no_trigger_event", "low_confidence"] },
        { trigger: null, floorBelow: null }, b.code_version ?? null, now));
      continue;
    }
    const m = computeWindowMetrics(polymarketSeries(snaps, b.market_label), Date.parse(ev.created_at), entry, b.code_version);
    rows.push(toRow(db, match, "entry", b.market_label, tokenFor(db, match.id, b.market_label), ev, m, { trigger: null, floorBelow: null }, b.code_version ?? null, now));
  }

  // NON-ENTRY cases — a panic event with no Overreaction entry on the panicked market:
  // trigger_no_entry (an armed target exists → measure floor vs trigger) or event_only.
  const codeVer = effectiveCodeVersion(db);
  const trigger = armedTargets.length ? Math.max(...armedTargets) : null;
  for (const ev of events) {
    const dip = deepestPanicMarket(db, match.id, snaps, Date.parse(ev.created_at));
    if (!dip) continue;                              // no market dipped → no overreaction here
    if (enteredMk.has(norm(dip.label))) continue;    // that market IS an entry case above
    const floorBelow = (trigger != null && dip.metrics.priceFloorCents != null && dip.metrics.priceFloorCents < trigger)
      ? r1(trigger - dip.metrics.priceFloorCents) : null;
    rows.push(toRow(db, match, trigger != null ? "trigger_no_entry" : "event_only", dip.label, dip.token, ev, dip.metrics, { trigger, floorBelow }, codeVer, now));
  }

  for (const row of rows) R.insertComebackLatencyMetric(db, row);
  R.metaSet(db, CLM_DONE + match.id, "1", now);
  return rows.length;
}

// ── ROLLING REPORT (reads the persisted table, never recomputes from snapshots) ──

export interface LatencyCase {
  matchId: string; home: string; away: string; market: string; caseType: string;
  eventType: string; tEventIso: string;
  panicAmplitudeCents: number | null; priceFloorCents: number | null; tFloorSec: number | null;
  entryPriceCents: number | null; tEntrySec: number | null; missedCents: number | null; lagFloorToEntrySec: number | null;
  recovery: Record<string, number | null>; floorThinnessUsd: number | null; paperFloor: boolean | null;
  priceTriggerCents: number | null; floorBelowTriggerCents: number | null; windowQuotes: number; flags: string[];
}
export interface LatencyAggregates {
  n: number; nConfident: number;
  meanMissed: number | null; medianMissed: number | null;
  medianMissedHardFloor: number | null; nHardFloor: number;
  meanLagFloorToEntrySec: number | null;
  histogram: { bucket: string; n: number }[];
  cooldown: { minute: number; meanRecovery: number | null; n: number }[];
}
export interface InvisibleSetup {
  matchId: string; home: string; away: string; caseType: string;
  market: string; priceTriggerCents: number; priceFloorCents: number | null; floorBelowTriggerCents: number; note: string;
}
export interface OverreactionLatencyReport {
  cases: LatencyCase[]; aggregates: LatencyAggregates; invisibleSetups: InvisibleSetup[];
  decision: { medianForDecision: number | null; verdict: string };
  status: string; thresholds: { closeCents: number; buildCents: number }; totalRows: number; limitations: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const HIST_BUCKETS: [string, (x: number) => boolean][] = [
  ["<0 (вошёл НИЖЕ дна)", (x) => x < 0], ["0–1", (x) => x >= 0 && x < 1], ["1–2", (x) => x >= 1 && x < 2],
  ["2–3", (x) => x >= 2 && x < 3], ["3–5", (x) => x >= 3 && x < 5], ["5–8", (x) => x >= 5 && x < 8], ["8+", (x) => x >= 8],
];

function rowToCase(db: Database, r: R.ComebackLatencyRow): LatencyCase {
  const m = R.getMatch(db, r.match_id);
  return {
    matchId: r.match_id, home: m?.home ?? "?", away: m?.away ?? "?", market: r.market_label, caseType: r.case_type,
    eventType: r.event_type, tEventIso: r.t_event,
    panicAmplitudeCents: r.panic_amplitude_cents, priceFloorCents: r.price_floor_cents, tFloorSec: r.t_floor_sec,
    entryPriceCents: r.entry_price_cents, tEntrySec: r.t_entry_sec, missedCents: r.missed_cents, lagFloorToEntrySec: r.lag_floor_to_entry_sec,
    recovery: { "1": r.recovery_1, "2": r.recovery_2, "3": r.recovery_3, "5": r.recovery_5 },
    floorThinnessUsd: r.floor_thinness_usd, paperFloor: r.paper_floor == null ? null : r.paper_floor === 1,
    priceTriggerCents: r.price_trigger_cents, floorBelowTriggerCents: r.floor_below_trigger_cents,
    windowQuotes: r.window_quotes, flags: r.confidence_flags ? r.confidence_flags.split(",") : [],
  };
}

/** ROLLING report — reads comeback_latency_metrics. Aggregates ONLY confident entry cases. */
export function buildOverreactionLatencyReport(db: Database): OverreactionLatencyReport {
  const rows = R.listComebackLatencyMetrics(db);
  const cases = rows.map((r) => rowToCase(db, r));
  const entries = cases.filter((c) => c.caseType === "entry");
  // Confident = a measurable entry (has missed) whose window wasn't flagged low-confidence.
  const confident = entries.filter((c) => c.missedCents != null && !c.flags.includes("low_confidence"));
  const missed = confident.map((c) => c.missedCents as number);
  const hardFloor = confident.filter((c) => c.paperFloor === false).map((c) => c.missedCents as number);
  const lags = confident.map((c) => c.lagFloorToEntrySec).filter((x): x is number => x != null);

  const aggregates: LatencyAggregates = {
    n: entries.length, nConfident: confident.length,
    meanMissed: missed.length ? r1(mean(missed) as number) : null,
    medianMissed: missed.length ? r1(median(missed) as number) : null,
    medianMissedHardFloor: hardFloor.length ? r1(median(hardFloor) as number) : null,
    nHardFloor: hardFloor.length,
    meanLagFloorToEntrySec: lags.length ? Math.round(mean(lags) as number) : null,
    histogram: HIST_BUCKETS.map(([bucket, pred]) => ({ bucket, n: missed.filter(pred).length })),
    cooldown: RECOVERY_MIN.map((k) => {
      const rs = confident.map((c) => c.recovery[String(k)]).filter((x): x is number => x != null);
      return { minute: k, meanRecovery: rs.length ? r1(mean(rs) as number) : null, n: rs.length };
    }),
  };

  // Invisible setups — now MEASURED: non-entry cases where the floor dipped below the armed target.
  const invisibleSetups: InvisibleSetup[] = cases
    .filter((c) => (c.caseType === "trigger_no_entry" || c.caseType === "event_only") && c.floorBelowTriggerCents != null)
    .map((c) => ({
      matchId: c.matchId, home: c.home, away: c.away, caseType: c.caseType, market: c.market,
      priceTriggerCents: c.priceTriggerCents as number, priceFloorCents: c.priceFloorCents,
      floorBelowTriggerCents: c.floorBelowTriggerCents as number,
      note: "дно опустилось НИЖЕ армед-таргета, но входа не было — упущенный сетап (измерено, не эвристика)",
    }));

  const medianForDecision = aggregates.medianMissedHardFloor ?? aggregates.medianMissed;
  const nConf = aggregates.nConfident;
  let verdict: string;
  if (nConf < DECISION_MIN_N) verdict = `накоплено ${nConf}/${TARGET_CONFIDENT} confident-кейсов (нужно ≥${DECISION_MIN_N}) — решение по критерию ОТЛОЖЕНО, копим`;
  else if (medianForDecision == null) verdict = "нет измеримого дна в confident-кейсах — проверь покрытие снапшотов";
  else if (medianForDecision <= MISSED_CLOSE_CENTS) verdict = `медианный missed ${medianForDecision}¢ ≤ ${MISSED_CLOSE_CENTS}¢ → горлышко НЕ стоит carve-out, вопрос закрыт`;
  else if (medianForDecision >= MISSED_BUILD_CENTS) verdict = `медианный missed ${medianForDecision}¢ ≥ ${MISSED_BUILD_CENTS}¢ → быстрый детерминированный путь ОПРАВДАН, проектируем carve-out`;
  else verdict = `медианный missed ${medianForDecision}¢ в пограничной зоне ${MISSED_CLOSE_CENTS}–${MISSED_BUILD_CENTS}¢ → решаем с учётом невидимых сетапов (${invisibleSetups.length})`;

  const status = `кейсов накоплено ${nConf} из ~${TARGET_CONFIDENT} целевых (всего записей ${rows.length}); решение по критерию: ${nConf >= DECISION_MIN_N ? "можно применять" : "ждём"}`;

  return {
    cases, aggregates, invisibleSetups, decision: { medianForDecision, verdict }, status,
    thresholds: { closeCents: MISSED_CLOSE_CENTS, buildCents: MISSED_BUILD_CENTS }, totalRows: rows.length,
    limitations: [
      "глубина стакана НЕ сохраняется в снапшотах → «твёрдое дно» оценено по per-bet thinness-прокси (marketThinnessUsd), а не по объёму на дне",
      "T_event = момент ДЕТЕКЦИИ события (match_events.created_at), лёгкий сдвиг вперёд относительно реального гола",
      "кейсы эпохи e1 (до phantom-exit/untradeable гарда) помечены phantom_era",
      "агрегаты считаются ТОЛЬКО по confident-кейсам (missed есть, окно без snapshot_gap); иначе null — без артефактов",
    ],
  };
}

// ── Renderers ──────────────────────────────────────────────
const cell = (v: unknown) => (v == null ? "—" : String(v));

export function latencyReportMarkdown(rep: OverreactionLatencyReport): string {
  const L: string[] = [];
  const a = rep.aggregates;
  L.push("# Overreaction latency cost — замер «недобранного дна» (rolling)");
  L.push(`\n**${rep.status}**`);
  L.push(`\nВсего кейсов: ${a.n} entry (${a.nConfident} confident) · записей в таблице: ${rep.totalRows}`);
  L.push("\n## Агрегаты (только confident-кейсы)");
  L.push(`- **missed_cents**: медиана **${cell(a.medianMissed)}¢**, среднее ${cell(a.meanMissed)}¢`);
  L.push(`- **missed по твёрдому дну** (thinness-прокси): медиана **${cell(a.medianMissedHardFloor)}¢** (${a.nHardFloor} кейс.)`);
  L.push(`- средний лаг дно→вход: **${cell(a.meanLagFloorToEntrySec)} сек**`);
  L.push("- гистограмма missed_cents: " + a.histogram.map((h) => `${h.bucket}=${h.n}`).join(" · "));
  L.push("- кривая остывания (средн. отскок от дна): " + a.cooldown.map((c) => `${c.minute}м=${cell(c.meanRecovery)}¢(n${c.n})`).join(" · "));
  L.push("\n## РЕШЕНИЕ (критерий записан ДО данных)");
  L.push(`- порог: ≤${rep.thresholds.closeCents}¢ закрыто · ≥${rep.thresholds.buildCents}¢ строим carve-out · применять при N≥${DECISION_MIN_N}`);
  L.push(`- **вердикт: ${rep.decision.verdict}**`);
  L.push("\n## Кейсы");
  L.push("матч | тип | событие | panic | floor | t_floor | entry | t_entry | **missed** | trigger | flags");
  L.push("---|---|---|---|---|---|---|---|---|---|---");
  for (const c of rep.cases) {
    L.push([`${c.home}–${c.away} «${c.market}»`, c.caseType, c.eventType, cell(c.panicAmplitudeCents), cell(c.priceFloorCents),
      c.tFloorSec == null ? "—" : `${c.tFloorSec}с`, cell(c.entryPriceCents), c.tEntrySec == null ? "—" : `${c.tEntrySec}с`,
      c.missedCents == null ? "—" : `**${c.missedCents}¢**`, cell(c.priceTriggerCents), c.flags.join(",") || "—"].join(" | "));
  }
  L.push(`\n## Невидимые упущенные сетапы (измерено, ${rep.invisibleSetups.length})`);
  if (!rep.invisibleSetups.length) L.push("(нет — дно не опускалось ниже армед-таргета там, где не было входа)");
  for (const s of rep.invisibleSetups) L.push(`- ${s.home}–${s.away} «${s.market}» [${s.caseType}]: таргет ${s.priceTriggerCents}¢, дно ${cell(s.priceFloorCents)}¢ (ниже на **${s.floorBelowTriggerCents}¢**)`);
  L.push("\n## Ограничения");
  for (const lim of rep.limitations) L.push(`- ${lim}`);
  return L.join("\n");
}

const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function latencyCasesCsv(rep: OverreactionLatencyReport): string {
  const head = ["match", "case_type", "market", "event_type", "t_event", "panic_amplitude_cents", "price_floor_cents", "t_floor_sec",
    "entry_price_cents", "t_entry_sec", "missed_cents", "lag_floor_to_entry_sec", "recovery_1m", "recovery_2m", "recovery_3m", "recovery_5m",
    "floor_thinness_usd", "paper_floor", "price_trigger_cents", "floor_below_trigger_cents", "window_quotes", "flags"];
  const rows = rep.cases.map((c) => [
    `${c.home}–${c.away}`, c.caseType, c.market, c.eventType, c.tEventIso, c.panicAmplitudeCents, c.priceFloorCents, c.tFloorSec,
    c.entryPriceCents, c.tEntrySec, c.missedCents, c.lagFloorToEntrySec, c.recovery["1"], c.recovery["2"], c.recovery["3"], c.recovery["5"],
    c.floorThinnessUsd, c.paperFloor, c.priceTriggerCents, c.floorBelowTriggerCents, c.windowQuotes, c.flags.join(";"),
  ].map(csvCell).join(","));
  return [head.join(","), ...rows].join("\n");
}
