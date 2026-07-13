// ============================================================
// EDGE LAB — MEASUREMENT SLICE: Overreaction latency cost ("недобранное дно паники").
//
// Answers ONE number from accumulated data: how much price does Overreaction leave on
// the table because of the lag event → detection → LLM → fill? That decides whether a
// fast deterministic execution path for armed triggers (a §9.6 carve-out) is worth
// building. Pure READ-ONLY analytics over historical Polymarket snapshots — zero
// money-path, zero runtime change.
//
// Per historical Overreaction live entry (armed-trigger buyback):
//   · T_event  = wall-clock of the trigger goal/red (match_events.created_at)
//   · window   = [T_event − 1m, T_event + 6m]
//   · price_floor = the MINIMUM REAL bid in the window (phantom/empty books filtered,
//                   mirroring the runtime exit guard) — the true panic bottom
//   · missed_cents = entry_price − price_floor   ← the headline metric (cost of the lag)
//   · panic_amplitude, recovery@1/2/3/5m         ← panic depth + cooling curve
//
// Decision thresholds are PRE-REGISTERED (below), before looking at the numbers.
//
// Honest limitations (see also the report footer):
//   · Snapshots store best bid/mid/ask but NOT order-book DEPTH, so "hard floor"
//     (floor with enough size to actually fill) uses the per-bet thinness proxy and is
//     flagged, not measured exactly.
//   · T_event is the DETECTION wall-clock (when the event landed in match_events), a
//     slight over-estimate of the real on-pitch moment.
//   · Pre-phantom-guard epochs (code_version e1) are flagged — their floor could be
//     phantom even after the hasRealOrderbook filter.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Bet } from "./types.js";
import { parseEntryMeta } from "./betMeta.js";

// ── Pre-registered decision thresholds (median missed_cents, hard floor) ──
export const MISSED_CLOSE_CENTS = 2; // ≤ this → bottleneck not worth a carve-out
export const MISSED_BUILD_CENTS = 5; // ≥ this → fast execution path justified
// (2–5¢ is the borderline band, weighed together with the invisible-setup count.)

// ── Window + filtering constants ──
const WIN_PRE_MIN = 1;
const WIN_POST_MIN = 6;
const RECOVERY_MIN = [1, 2, 3, 5];
// Phantom-bid filter — MIRRORS the runtime exit guard (lifecycle EXIT_PHANTOM_FLOOR/GAP):
// a bid ≤5¢ sitting ≥8¢ under the mid is a momentarily-broken book, not the real floor.
const PHANTOM_FLOOR = 5;
const PHANTOM_GAP = 8;
// A gap between consecutive in-window quotes longer than this (the ~20s cadence blew a
// beat — provider outage) makes the case low-confidence: the true floor may be unseen.
const SNAP_GAP_ALERT_SEC = 45;
// Recovery lookup tolerance around the target minute-from-floor.
const RECOVERY_TOL_SEC = 30;
// Phantom-exit / untradeable-gate guards landed at epoch e2; e1 bets predate them.
const PHANTOM_SAFE_EPOCH = 2;

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

/** The panic event a buyback responds to: the latest goal/red at or just before entry
 *  (small forward tolerance for a fill logged a beat before the event row). Null if none. */
export function findTriggerEvent(events: R.MatchEventRow[], entryMs: number): R.MatchEventRow | null {
  const FWD_TOL = 90_000; // a fill can be stamped up to ~90s before the event row settled
  const cands = events
    .filter((e) => GOAL_RED.test(`${e.type} ${e.text}`))
    .map((e) => ({ e, tMs: Date.parse(e.created_at) }))
    .filter((x) => Number.isFinite(x.tMs) && x.tMs <= entryMs + FWD_TOL)
    .sort((a, b) => b.tMs - a.tMs);
  return cands.length ? cands[0].e : null;
}

export interface LatencyCase {
  matchId: string; home: string; away: string; market: string;
  strategyProfile: string | null;
  eventType: string; eventText: string; tEventIso: string;
  panicAmplitudeCents: number | null; // pre-event bid − floor
  priceFloorCents: number | null;
  tFloorSec: number | null;           // floor time relative to T_event (+ = after)
  entryPriceCents: number | null;
  tEntrySec: number | null;           // fill time relative to T_event
  missedCents: number | null;         // entry − floor (headline)
  lagFloorToEntrySec: number | null;  // t_entry − t_floor
  recovery: Record<string, number | null>; // "1"/"2"/"3"/"5" min → bid − floor
  floorThinnessUsd: number | null;    // per-bet liquidity proxy (NOT floor depth)
  paperFloor: boolean | null;         // proxy: thinness < half the stake
  windowQuotes: number;               // real bids seen in window
  flags: string[];                    // low_confidence / snapshot_gap / phantom_era / no_snapshots …
}

function analyzeEntry(
  bet: Bet, m: { home: string; away: string }, ev: R.MatchEventRow, series: Quote[],
): LatencyCase {
  const flags: string[] = [];
  const tEvent = Date.parse(ev.created_at);
  const entryMs = Date.parse(bet.created_at);
  const meta = parseEntryMeta(bet.entry_meta);
  const lo = tEvent - WIN_PRE_MIN * 60_000, hi = tEvent + WIN_POST_MIN * 60_000;
  const win = series.filter((q) => q.tMs >= lo && q.tMs <= hi && realBid(q) != null);
  const epoch = baseEpochNum(bet.code_version);
  if (epoch != null && epoch < PHANTOM_SAFE_EPOCH) flags.push("phantom_era");

  const base: LatencyCase = {
    matchId: bet.match_id, home: m.home, away: m.away, market: bet.market_label,
    strategyProfile: bet.risk_profile_id ?? null,
    eventType: ev.type, eventText: ev.text, tEventIso: ev.created_at,
    panicAmplitudeCents: null, priceFloorCents: null, tFloorSec: null,
    entryPriceCents: bet.entry_price, tEntrySec: Number.isFinite(entryMs) && Number.isFinite(tEvent) ? Math.round((entryMs - tEvent) / 1000) : null,
    missedCents: null, lagFloorToEntrySec: null,
    recovery: Object.fromEntries(RECOVERY_MIN.map((k) => [String(k), null])),
    floorThinnessUsd: meta?.marketThinnessUsd ?? null, paperFloor: null,
    windowQuotes: win.length, flags,
  };
  if (!win.length) { flags.push("no_snapshots"); return base; }

  // Floor = the minimum real bid in the window.
  let floorQ = win[0]; for (const q of win) if ((realBid(q) as number) < (realBid(floorQ) as number)) floorQ = q;
  const floor = realBid(floorQ) as number;
  base.priceFloorCents = r1(floor);
  base.tFloorSec = Math.round((floorQ.tMs - tEvent) / 1000);

  // Panic amplitude = last real bid BEFORE the event − floor.
  const pre = series.filter((q) => q.tMs < tEvent && realBid(q) != null);
  if (pre.length) base.panicAmplitudeCents = r1((realBid(pre[pre.length - 1]) as number) - floor);

  // Missed = entry − floor; lag = t_entry − t_floor.
  if (bet.entry_price != null) base.missedCents = r1(bet.entry_price - floor);
  if (base.tEntrySec != null && base.tFloorSec != null) base.lagFloorToEntrySec = base.tEntrySec - base.tFloorSec;

  // Recovery curve: bid at floor+k min − floor (nearest quote within tolerance, at/after floor).
  for (const k of RECOVERY_MIN) {
    const target = floorQ.tMs + k * 60_000;
    let best: Quote | null = null, bestD = Infinity;
    for (const q of win) { if (q.tMs < floorQ.tMs) continue; const d = Math.abs(q.tMs - target); if (d < bestD && d <= RECOVERY_TOL_SEC * 1000) { best = q; bestD = d; } }
    if (best) base.recovery[String(k)] = r1((realBid(best) as number) - floor);
  }

  // Confidence: a long hole between consecutive in-window quotes hides the true floor.
  let maxGap = 0;
  for (let i = 1; i < win.length; i++) maxGap = Math.max(maxGap, (win[i].tMs - win[i - 1].tMs) / 1000);
  if (maxGap > SNAP_GAP_ALERT_SEC) flags.push("snapshot_gap");
  if (floorQ.tMs >= hi - 20_000) flags.push("floor_at_window_edge"); // cooling may extend past the window
  if (flags.includes("snapshot_gap") || flags.includes("no_snapshots")) flags.push("low_confidence");

  // Paper-floor proxy (depth at the floor is NOT stored — this is per-bet thinness).
  if (meta?.marketThinnessUsd != null && bet.stake != null) base.paperFloor = meta.marketThinnessUsd < bet.stake * 0.5;

  return base;
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
  matchId: string; home: string; away: string;
  armedTarget: number; deepestDipMarket: string | null; deepestFloorCents: number | null;
  belowTargetCents: number | null; // target − floor (missed margin, CLV-ish); null if no dip below
  note: string;
}

export interface OverreactionLatencyReport {
  cases: LatencyCase[];
  aggregates: LatencyAggregates;
  invisibleSetups: InvisibleSetup[];
  decision: { medianForDecision: number | null; verdict: string };
  thresholds: { closeCents: number; buildCents: number };
  generatedForBets: number;
  limitations: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const HIST_BUCKETS: [string, (x: number) => boolean][] = [
  ["<0 (вошёл НИЖЕ дна)", (x) => x < 0],
  ["0–1", (x) => x >= 0 && x < 1],
  ["1–2", (x) => x >= 1 && x < 2],
  ["2–3", (x) => x >= 2 && x < 3],
  ["3–5", (x) => x >= 3 && x < 5],
  ["5–8", (x) => x >= 5 && x < 8],
  ["8+", (x) => x >= 8],
];

/** Is this bet a live Overreaction armed-trigger entry that actually filled? */
function isOverreactionLiveEntry(b: Bet): boolean {
  if (b.strategy_id !== "overreaction") return false;
  if (b.entry_price == null) return false; // never filled → nothing to measure
  if (b.status === "proposed" || b.status === "not_filled") return false;
  const meta = parseEntryMeta(b.entry_meta);
  if (meta?.phase === "live") return true;
  if (meta?.phase === "prematch") return false;
  // Legacy rows without meta: fall back to the entry-minute label (prematch entries are tagged so).
  return !/пред|prematch/i.test(b.entered_minute ?? "");
}

/** Best-effort "invisible missed setups": matches that ARMED an overreaction buyback but
 *  placed NO overreaction bet, where a goal/red happened and some market's window-floor
 *  dipped below the armed target. Heuristic (market-mapping is fuzzy) → flagged low-confidence. */
function invisibleSetups(db: Database, executedMatchIds: Set<string>): InvisibleSetup[] {
  const out: InvisibleSetup[] = [];
  for (const c of R.listCompetitions(db)) {
    for (const m of R.listMatches(db, c.id)) {
      if (executedMatchIds.has(m.id)) continue; // it DID enter → not invisible
      const sheets = R.artifactsForMatch(db, m.id).filter((a) => a.kind === "battle_sheet" && /overreaction/i.test(a.label));
      if (!sheets.length) continue;
      // Collect numeric armed buyback targets.
      const targets: number[] = [];
      for (const s of sheets) {
        try {
          const bs = JSON.parse(s.content);
          const arr = bs?.live_triggers_armed ?? bs?.strategist_plan?.live_triggers_armed;
          for (const t of Array.isArray(arr) ? arr : []) {
            const v = numOrNull(t?.buyback_target) ?? numOrNull(t?.price_trigger);
            if (v != null && v > 0 && v < 100) targets.push(v);
          }
        } catch { /* free-text plan → skip */ }
      }
      if (!targets.length) continue;
      const events = R.eventsForMatch(db, m.id).filter((e) => GOAL_RED.test(`${e.type} ${e.text}`));
      if (!events.length) continue; // no panic event → no setup could have fired
      const snaps = R.snapshotMetaForMatch(db, m.id, 6000);
      const target = Math.max(...targets); // most permissive armed target
      // Deepest window-floor across all this match's markets, around any goal/red.
      let deepest: number | null = null, deepestMk: string | null = null;
      for (const mk of R.latestMarkets(db, m.id)) {
        const series = polymarketSeries(snaps, mk.label);
        for (const ev of events) {
          const tE = Date.parse(ev.created_at);
          const win = series.filter((q) => q.tMs >= tE - WIN_PRE_MIN * 60_000 && q.tMs <= tE + WIN_POST_MIN * 60_000 && realBid(q) != null);
          for (const q of win) { const b = realBid(q) as number; if (deepest == null || b < deepest) { deepest = b; deepestMk = mk.label; } }
        }
      }
      if (deepest == null) continue;
      const below = deepest < target ? r1(target - deepest) : null;
      out.push({
        matchId: m.id, home: m.home, away: m.away, armedTarget: target,
        deepestDipMarket: deepestMk, deepestFloorCents: r1(deepest), belowTargetCents: below,
        note: below != null ? "дно опускалось НИЖЕ армед-таргета, но входа не было — кандидат в упущенный сетап (ручная проверка рынка)" : "дно не доходило до армед-таргета — вероятно корректное воздержание",
      });
    }
  }
  return out;
}

export function buildOverreactionLatencyReport(db: Database): OverreactionLatencyReport {
  const bets = R.allBets(db).filter(isOverreactionLiveEntry);
  const cases: LatencyCase[] = [];
  const executedMatchIds = new Set<string>();
  // Cache per-match snapshots + events + match row.
  const snapCache = new Map<string, ReturnType<typeof R.snapshotMetaForMatch>>();
  const evCache = new Map<string, R.MatchEventRow[]>();
  for (const b of bets) {
    executedMatchIds.add(b.match_id);
    const m = R.getMatch(db, b.match_id);
    if (!m) continue;
    const events = evCache.get(b.match_id) ?? (evCache.set(b.match_id, R.eventsForMatch(db, b.match_id)), evCache.get(b.match_id)!);
    const ev = findTriggerEvent(events, Date.parse(b.created_at));
    const snaps = snapCache.get(b.match_id) ?? (snapCache.set(b.match_id, R.snapshotMetaForMatch(db, b.match_id, 6000)), snapCache.get(b.match_id)!);
    if (!ev) {
      cases.push({
        matchId: b.match_id, home: m.home, away: m.away, market: b.market_label, strategyProfile: b.risk_profile_id ?? null,
        eventType: "?", eventText: "нет события-триггера в ленте", tEventIso: b.created_at,
        panicAmplitudeCents: null, priceFloorCents: null, tFloorSec: null, entryPriceCents: b.entry_price,
        tEntrySec: null, missedCents: null, lagFloorToEntrySec: null,
        recovery: Object.fromEntries(RECOVERY_MIN.map((k) => [String(k), null])),
        floorThinnessUsd: parseEntryMeta(b.entry_meta)?.marketThinnessUsd ?? null, paperFloor: null,
        windowQuotes: 0, flags: ["no_trigger_event", "low_confidence"],
      });
      continue;
    }
    cases.push(analyzeEntry(b, m, ev, polymarketSeries(snaps, b.market_label)));
  }

  // Aggregates over CONFIDENT, measurable cases.
  const measurable = cases.filter((c) => c.missedCents != null && !c.flags.includes("low_confidence"));
  const missed = measurable.map((c) => c.missedCents as number);
  const hardFloor = measurable.filter((c) => c.paperFloor === false).map((c) => c.missedCents as number);
  const lags = cases.map((c) => c.lagFloorToEntrySec).filter((x): x is number => x != null);
  const aggregates: LatencyAggregates = {
    n: cases.length, nConfident: measurable.length,
    meanMissed: missed.length ? r1(mean(missed) as number) : null,
    medianMissed: missed.length ? r1(median(missed) as number) : null,
    medianMissedHardFloor: hardFloor.length ? r1(median(hardFloor) as number) : null,
    nHardFloor: hardFloor.length,
    meanLagFloorToEntrySec: lags.length ? Math.round(mean(lags) as number) : null,
    histogram: HIST_BUCKETS.map(([bucket, pred]) => ({ bucket, n: missed.filter(pred).length })),
    cooldown: RECOVERY_MIN.map((k) => {
      const rs = measurable.map((c) => c.recovery[String(k)]).filter((x): x is number => x != null);
      return { minute: k, meanRecovery: rs.length ? r1(mean(rs) as number) : null, n: rs.length };
    }),
  };

  // Decision: prefer the hard-floor median (per spec); fall back to all measurable if too few.
  const medianForDecision = aggregates.medianMissedHardFloor ?? aggregates.medianMissed;
  let verdict: string;
  if (medianForDecision == null) verdict = "недостаточно данных — нет измеримых кейсов (нужны снапшоты, покрывающие окно события)";
  else if (medianForDecision <= MISSED_CLOSE_CENTS) verdict = `медианный missed ${medianForDecision}¢ ≤ ${MISSED_CLOSE_CENTS}¢ → горлышко НЕ стоит carve-out, вопрос закрыт`;
  else if (medianForDecision >= MISSED_BUILD_CENTS) verdict = `медианный missed ${medianForDecision}¢ ≥ ${MISSED_BUILD_CENTS}¢ → быстрый детерминированный путь ОПРАВДАН, проектируем carve-out`;
  else verdict = `медианный missed ${medianForDecision}¢ в пограничной зоне ${MISSED_CLOSE_CENTS}–${MISSED_BUILD_CENTS}¢ → решаем с учётом «невидимых сетапов» (${invisibleSetups(db, executedMatchIds).filter((s) => s.belowTargetCents != null).length} кандидатов)`;

  return {
    cases, aggregates, invisibleSetups: invisibleSetups(db, executedMatchIds),
    decision: { medianForDecision, verdict },
    thresholds: { closeCents: MISSED_CLOSE_CENTS, buildCents: MISSED_BUILD_CENTS },
    generatedForBets: bets.length,
    limitations: [
      "глубина стакана НЕ сохраняется в снапшотах → «твёрдое дно» оценено по per-bet thinness-прокси (marketThinnessUsd), а не по реальному объёму на дне",
      "T_event = момент ДЕТЕКЦИИ события (match_events.created_at), лёгкий сдвиг вперёд относительно реального гола",
      "кейсы эпохи e1 (до phantom-exit/untradeable гарда) помечены phantom_era — дно могло быть фантомным даже после фильтра",
      "невидимые сетапы — эвристика (маппинг армед-триггер→рынок неточный), помечены low-confidence, требуют ручной проверки",
    ],
  };
}

// ── Renderers ──────────────────────────────────────────────
const cell = (v: unknown) => (v == null ? "—" : String(v));

export function latencyReportMarkdown(rep: OverreactionLatencyReport): string {
  const L: string[] = [];
  L.push("# Overreaction latency cost — замер «недобранного дна»");
  L.push(`\nВходов Overreaction (live, филлованных): **${rep.generatedForBets}** · измеримых кейсов: **${rep.aggregates.nConfident}**`);
  const a = rep.aggregates;
  L.push("\n## Агрегаты");
  L.push(`- **missed_cents**: медиана **${cell(a.medianMissed)}¢**, среднее ${cell(a.meanMissed)}¢`);
  L.push(`- **missed по твёрдому дну** (thinness-прокси): медиана **${cell(a.medianMissedHardFloor)}¢** (${a.nHardFloor} кейс.)`);
  L.push(`- средний лаг дно→вход: **${cell(a.meanLagFloorToEntrySec)} сек**`);
  L.push("- гистограмма missed_cents: " + a.histogram.map((h) => `${h.bucket}=${h.n}`).join(" · "));
  L.push("- кривая остывания (средн. отскок от дна): " + a.cooldown.map((c) => `${c.minute}м=${cell(c.meanRecovery)}¢(n${c.n})`).join(" · "));
  L.push("\n## РЕШЕНИЕ (критерий записан ДО данных)");
  L.push(`- порог: ≤${rep.thresholds.closeCents}¢ закрыто · ≥${rep.thresholds.buildCents}¢ строим carve-out`);
  L.push(`- **вердикт: ${rep.decision.verdict}**`);
  L.push("\n## Кейсы");
  L.push("матч | событие | panic | floor | t_floor | entry | t_entry | **missed** | thin$ | флаги");
  L.push("---|---|---|---|---|---|---|---|---|---");
  for (const c of rep.cases) {
    L.push([`${c.home}–${c.away} «${c.market}»`, `${c.eventType}`, cell(c.panicAmplitudeCents), cell(c.priceFloorCents),
      c.tFloorSec == null ? "—" : `${c.tFloorSec}с`, cell(c.entryPriceCents), c.tEntrySec == null ? "—" : `${c.tEntrySec}с`,
      c.missedCents == null ? "—" : `**${c.missedCents}¢**`, cell(c.floorThinnessUsd), c.flags.join(",") || "—"].join(" | "));
  }
  const inv = rep.invisibleSetups.filter((s) => s.belowTargetCents != null);
  L.push(`\n## Невидимые упущенные сетапы (best-effort, ${inv.length} кандидат.)`);
  if (!inv.length) L.push("(нет восстановимых кандидатов — армед-триггеры не парсятся или дно не опускалось ниже таргета)");
  for (const s of inv) L.push(`- ${s.home}–${s.away}: армед-таргет ${s.armedTarget}¢, дно «${cell(s.deepestDipMarket)}» ${cell(s.deepestFloorCents)}¢ (ниже на ${cell(s.belowTargetCents)}¢) — ${s.note}`);
  L.push("\n## Ограничения");
  for (const lim of rep.limitations) L.push(`- ${lim}`);
  return L.join("\n");
}

const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function latencyCasesCsv(rep: OverreactionLatencyReport): string {
  const head = ["match", "market", "event_type", "t_event", "panic_amplitude_cents", "price_floor_cents", "t_floor_sec",
    "entry_price_cents", "t_entry_sec", "missed_cents", "lag_floor_to_entry_sec",
    "recovery_1m", "recovery_2m", "recovery_3m", "recovery_5m", "floor_thinness_usd", "paper_floor", "window_quotes", "flags"];
  const rows = rep.cases.map((c) => [
    `${c.home}–${c.away}`, c.market, c.eventType, c.tEventIso, c.panicAmplitudeCents, c.priceFloorCents, c.tFloorSec,
    c.entryPriceCents, c.tEntrySec, c.missedCents, c.lagFloorToEntrySec,
    c.recovery["1"], c.recovery["2"], c.recovery["3"], c.recovery["5"], c.floorThinnessUsd, c.paperFloor, c.windowQuotes, c.flags.join(";"),
  ].map(csvCell).join(","));
  return [head.join(","), ...rows].join("\n");
}
