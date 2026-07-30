// ============================================================
// EDGE LAB — P2: `unfillable_edge` DIAGNOSTIC  [SERVER-ONLY, READ-ONLY]
//
// The football thesis is "the model is fine, the BOOKS are the problem": real edges on minor leagues sit on
// empty / thin / zombie books you can't actually buy. A price you couldn't fill never validates the model, so
// this report measures execution reality directly and drives the coverage tiers.
//
// It answers, over a window, for the two football entry strategies (prematch_value in its prematch window,
// Overreaction on armed triggers): how many EDGE SIGNALS fired, how many were FILLABLE, and — for the ones
// that weren't — WHY, cut by league × strategy × reason, with the potential stake left on the table.
//
//   Edge signal   = a sized entry the engine actually attempted: a filled bet (open/settled) OR a not_filled
//                   proposal (the strategy found+sized an edge; execution refused it).
//   Fillable       = at signal time the book held ≥ the min profile size within ≤3¢ of the signal price. Read
//                   from the FROZEN book-depth snapshot nearest the signal (book_depth_snapshots — this report
//                   is that capture's first consumer). A filled bet is fillable by definition. No snapshot in
//                   window → fillability "unknown" (honest: snapshots accrue from deploy, they can't backfill).
//   Coverage rule  = a league stays ACTIVE if fillable-share ≥ 30% OR ≥ 2 fillable signals/week; else PASSIVE
//                   (analysis off to save LLM; catalog kept for cheap liquidity monitoring). REPORT-ONLY: the
//                   July off-season makes the verdict preliminary (mandatory caveat), so nothing is auto-off.
//   F3 side-check  = win-rate of FILLED, NON-ZOMBIE settled signals — the first honest "is the model good?"
//                   read (a fill on a zombie book is excluded; its outcome can't validate the model).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

const FOOTBALL_STRATS = new Set(["prematch_value", "overreaction"]);
export type UnfillReason =
  | "empty_book" | "depth_floor" | "clamp" | "zombie_resolved" | "zombie_notation" | "zombie_stale" | "zombie_rail"
  | "untradeable" | "stale_proposal" | "incoherent_book" | "no_market" | "risk_block" | "other";

/** Map a not_filled bet's rationale to a canonical unfillable reason (the spec's reason vocabulary). */
export function classifyReason(rationale: string | null | undefined): UnfillReason {
  const s = String(rationale ?? "").toLowerCase();
  if (/zombie_quarantine:rail_price|zombie_quarantine:rail_unexplained/.test(s)) return "zombie_rail";
  if (/zombie_quarantine:resolved_price/.test(s)) return "zombie_resolved";
  if (/zombie_quarantine:notation_desync/.test(s)) return "zombie_notation";
  if (/zombie_quarantine:stale_book/.test(s)) return "zombie_stale";
  if (/depth_floor_skip|глубины нет|depth_floor/.test(s)) return "depth_floor";
  if (/stale_proposal|цена ушла|фил.*далеко|исполнение не соответствует/.test(s)) return "stale_proposal";
  if (/prob_sum_block|несогласованн|сумма пары/.test(s)) return "incoherent_book";
  if (/плейсхолдер|placeholder|пусто|нет реальной книги|нет живого бида|нет книги|untradeable/.test(s)) return "untradeable";
  if (/урезан|clamp|глубин/.test(s)) return "clamp";
  if (/нет рынка|нет оценки|no_market/.test(s)) return "no_market";
  if (/martingale|мартингейл|стоп|edge|мало|кулдаун|cooldown/.test(s)) return "risk_block";
  if (/пуст(ая|ой)? книг|нет аск|no ask|empty/.test(s)) return "empty_book";
  return "other";
}

const isZombieReason = (r: UnfillReason) => r === "zombie_resolved" || r === "zombie_notation" || r === "zombie_stale" || r === "zombie_rail";

interface DepthSnap { label: string | null; token_id: string; asks_json: string | null; best_ask_cents: number | null; ask_depth_usd: number | null; at: string }

/** USD available to BUY within ≤3¢ of the signal price, from a frozen snapshot's ask levels. */
function fillableUsdWithin(snap: DepthSnap, signalCents: number, bandCents: number): number {
  let usd = 0;
  try {
    const asks = JSON.parse(snap.asks_json ?? "[]") as [number, number][]; // [[priceCents, shares], …]
    for (const [priceC, shares] of asks) {
      if (!Number.isFinite(priceC) || !Number.isFinite(shares)) continue;
      if (priceC <= signalCents + bandCents) usd += shares * (priceC / 100);
    }
  } catch { /* fall back to the aggregate below */ }
  // No parseable levels but a top-of-book within band → use the aggregate ask depth (coarser, still measured).
  if (usd === 0 && snap.best_ask_cents != null && snap.best_ask_cents <= signalCents + bandCents) usd = snap.ask_depth_usd ?? 0;
  return usd;
}

/**
 * ИСПОЛНИМОСТЬ — ОДНА РЕАЛИЗАЦИЯ НА ВЕСЬ ПРОЕКТ.
 *
 * «Fillable» = на момент сигнала книга держала мин-размер профиля в ≤3¢ от цены сигнала, по ЗАМОРОЖЕННОМУ
 * снимку глубины. Это определение уже было здесь, но жило внутри одного отчёта — а второму потребителю
 * (refusal_shadow) оно нужно дословно то же. Два одинаковых по замыслу порога, написанных дважды, у нас уже
 * разъезжались (порог планки), поэтому зонд вынесен наружу, а не скопирован.
 *
 * `null` — снимка в окне нет. Честный третий ответ: снимки копятся с деплоя и не бэкфиллятся, поэтому
 * «не знаем» обязано отличаться от «не исполнимо».
 */
export interface FillabilityProbe {
  (matchId: string, label: string, signalCents: number, atIso: string): boolean | null;
  params: { minSizeUsd: number; bandCents: number; snapshotWindowMin: number };
  /** Сколько снимков вообще попало в окно — без этого доля fillable нечитаема (нулевое покрытие
   *  выглядит как «ничего не исполнимо», а это разные вещи). */
  coverage: { snapshots: number; matches: number; earliestAt: string | null; latestAt: string | null };
}

export function buildFillabilityProbe(
  db: Database, opts: { fromMs: number; env?: Record<string, string | undefined> },
): FillabilityProbe {
  const env = opts.env ?? process.env;
  const minSizeUsd = Math.max(1, Number(env.FOOTBALL_MIN_DEPTH_USD ?? 50));
  const bandCents = Math.max(0, Number(env.UNFILLABLE_BAND_CENTS ?? 3));
  const snapWinMin = Math.max(1, Number(env.UNFILLABLE_SNAPSHOT_WIN_MIN ?? 12));
  const snapRows = db.prepare(
    `SELECT match_id, label, token_id, asks_json, best_ask_cents, ask_depth_usd, at FROM book_depth_snapshots WHERE at >= ?`,
  ).all(new Date(opts.fromMs - snapWinMin * 60_000).toISOString()) as (DepthSnap & { match_id: string })[];
  const byMatch = new Map<string, (DepthSnap & { match_id: string })[]>();
  for (const s of snapRows) (byMatch.get(s.match_id) ?? byMatch.set(s.match_id, []).get(s.match_id)!).push(s);
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const ats = snapRows.map((s) => s.at).filter(Boolean).sort();
  const fn = ((matchId: string, label: string, signalCents: number, atIso: string): boolean | null => {
    const arr = byMatch.get(matchId); if (!arr) return null;
    const t = Date.parse(atIso); if (!Number.isFinite(t)) return null;
    let best: DepthSnap | null = null, bestDt = Infinity;
    for (const s of arr) {
      if (s.label && norm(s.label) !== norm(label)) continue;
      const dt = Math.abs(Date.parse(s.at) - t);
      if (dt < bestDt && dt <= snapWinMin * 60_000) { best = s; bestDt = dt; }
    }
    if (!best) return null;
    return fillableUsdWithin(best, signalCents, bandCents) >= minSizeUsd;
  }) as FillabilityProbe;
  fn.params = { minSizeUsd, bandCents, snapshotWindowMin: snapWinMin };
  fn.coverage = { snapshots: snapRows.length, matches: byMatch.size, earliestAt: ats[0] ?? null, latestAt: ats[ats.length - 1] ?? null };
  return fn;
}

export interface UnfillableEdgeReport {
  generatedAt: string;
  window: { days: number; fromMs: number; toMs: number };
  params: { minSizeUsd: number; bandCents: number; snapshotWindowMin: number; activeShareMin: number; activePerWeekMin: number };
  seasonalCaveat: string;
  totals: { signals: number; filled: number; unfilled: number; fillable: number; unfillable: number; unknownFillability: number; potentialStakeUsd: number };
  byLeagueStrategyReason: { league: string; strategy: string; reason: UnfillReason; count: number; stakeUsd: number }[];
  coverage: { league: string; signals: number; fillable: number; fillableShare: number; fillablePerWeek: number; tier: "active" | "passive"; why: string }[];
  f3Check: { filledNonZombieSettled: number; won: number; winRate: number | null; note: string };
  notes: string[];
}

/** Build the read-only P2 report. `nowMs`/`windowDays` overridable for tests. */
export function buildUnfillableEdge(db: Database, opts: { nowMs?: number; windowDays?: number; env?: Record<string, string | undefined> } = {}): UnfillableEdgeReport {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();
  const windowDays = opts.windowDays ?? 14;
  const fromMs = nowMs - windowDays * 86_400_000;
  const minSizeUsd = Math.max(1, Number(env.FOOTBALL_MIN_DEPTH_USD ?? 50));
  const bandCents = Math.max(0, Number(env.UNFILLABLE_BAND_CENTS ?? 3));
  const snapWinMin = Math.max(1, Number(env.UNFILLABLE_SNAPSHOT_WIN_MIN ?? 12));

  // league + sport per match, via competition.
  const comps = new Map(R.listCompetitions(db).map((c) => [c.id, c]));
  const leagueOf = (matchId: string): { league: string; sport: string } | null => {
    const m = R.getMatch(db, matchId); if (!m) return null;
    const c = comps.get(m.competition_id); if (!c) return null;
    return { league: String(c.external_league ?? c.name ?? "—"), sport: c.sport_id };
  };

  // Один общий зонд исполнимости (см. buildFillabilityProbe) — та же реализация, что читает refusal_shadow.
  const fillableAt = buildFillabilityProbe(db, { fromMs, env });

  // Collect edge signals: every football prematch_value/overreaction bet the engine sized in the window.
  const aggr = new Map<string, { league: string; strategy: string; reason: UnfillReason; count: number; stakeUsd: number }>();
  const leagueTally = new Map<string, { signals: number; fillable: number }>();
  const totals = { signals: 0, filled: 0, unfilled: 0, fillable: 0, unfillable: 0, unknownFillability: 0, potentialStakeUsd: 0 };
  let f3Settled = 0, f3Won = 0;

  for (const b of R.allBets(db)) {
    if (!FOOTBALL_STRATS.has(b.strategy_id)) continue;
    const createdMs = Date.parse(b.created_at); if (!Number.isFinite(createdMs) || createdMs < fromMs || createdMs > nowMs) continue;
    const loc = leagueOf(b.match_id); if (!loc || loc.sport !== "football") continue;
    const league = loc.league;
    const filled = b.status === "open" || b.status.startsWith("settled");
    totals.signals++;
    const lt = leagueTally.get(league) ?? leagueTally.set(league, { signals: 0, fillable: 0 }).get(league)!;
    lt.signals++;

    if (filled) {
      totals.filled++; totals.fillable++; lt.fillable++;
      // F3 side-check: filled, NON-zombie, settled → outcome vs model (win-rate proxy).
      if (b.status === "settled_won" || b.status === "settled_lost") {
        f3Settled++; if (b.status === "settled_won") f3Won++;
      }
      continue;
    }
    if (b.status !== "not_filled") continue; // proposed (still pending) / other → not a resolved signal yet
    totals.unfilled++;
    const reason = classifyReason(b.rationale);
    const stake = Number(b.stake ?? 0) || 0;
    totals.potentialStakeUsd += stake;
    const key = `${league}||${b.strategy_id}||${reason}`;
    const row = aggr.get(key) ?? aggr.set(key, { league, strategy: b.strategy_id, reason, count: 0, stakeUsd: 0 }).get(key)!;
    row.count++; row.stakeUsd += stake;
    // Fillability from the frozen snapshot. A zombie book is unfillable by definition (don't probe the book).
    let fb: boolean | null;
    if (isZombieReason(reason)) fb = false;
    else fb = fillableAt(b.match_id, b.market_label, b.proposed_price ?? 0, b.created_at);
    if (fb === null) totals.unknownFillability++;
    else if (fb) { totals.fillable++; lt.fillable++; }
    else totals.unfillable++;
  }

  const byLeagueStrategyReason = [...aggr.values()].sort((a, b) => b.count - a.count || b.stakeUsd - a.stakeUsd);
  const weeks = Math.max(1 / 7, windowDays / 7);
  const activeShareMin = 0.30, activePerWeekMin = 2;
  const coverage = [...leagueTally.entries()].map(([league, t]) => {
    const share = t.signals ? t.fillable / t.signals : 0;
    const perWeek = t.fillable / weeks;
    const active = share >= activeShareMin || perWeek >= activePerWeekMin;
    return {
      league, signals: t.signals, fillable: t.fillable, fillableShare: Math.round(share * 1000) / 1000,
      fillablePerWeek: Math.round(perWeek * 100) / 100, tier: (active ? "active" : "passive") as "active" | "passive",
      why: active ? `fillable-доля ${Math.round(share * 100)}% ≥ 30% или ${(Math.round(perWeek * 100) / 100)}/нед ≥ 2` : `fillable-доля ${Math.round(share * 100)}% < 30% и ${(Math.round(perWeek * 100) / 100)}/нед < 2`,
    };
  }).sort((a, b) => b.signals - a.signals);

  const month = new Date(nowMs).getUTCMonth() + 1; // 1..12
  const offSeason = month === 6 || month === 7;
  const seasonalCaveat = offSeason
    ? `СЕЗОННАЯ ПОПРАВКА: сейчас межсезонье топ-5 (месяц ${month}) — текущая диета из минорки частично календарная. Вердикт по покрытию ПРЕДВАРИТЕЛЬНЫЙ до старта больших лиг (конец августа); отчёт гоняется еженедельно и правило перерешивает tier'ы по тем же порогам. Passive-tier НЕ применяется автоматически в межсезонье.`
    : `СЕЗОННАЯ ПОПРАВКА: топ-5 в сезоне (месяц ${month}). Вердикт по покрытию действителен; отчёт гоняется еженедельно и правило перерешивает tier'ы по тем же порогам.`;

  const notes: string[] = [];
  if (totals.unknownFillability > 0) notes.push(`${totals.unknownFillability} сигнал(ов) без снапшота книги в окне ±${snapWinMin}м — исполнимость неизвестна (снапшоты копятся с деплоя, историю не восстановить; это НЕ «неисполнимо»).`);
  notes.push(`Fillable = книга держала ≥ $${minSizeUsd} в пределах ≤${bandCents}¢ от цены сигнала на замороженном снапшоте. Зомби-книги считаются неисполнимыми по построению.`);
  notes.push(`Покрытие — рекомендация, не автопереключение: passive-tier выключил бы анализ лиги, но в межсезонье вердикт предварительный.`);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    window: { days: windowDays, fromMs, toMs: nowMs },
    params: { minSizeUsd, bandCents, snapshotWindowMin: snapWinMin, activeShareMin, activePerWeekMin },
    seasonalCaveat,
    totals: { ...totals, potentialStakeUsd: Math.round(totals.potentialStakeUsd * 100) / 100 },
    byLeagueStrategyReason,
    coverage,
    f3Check: {
      filledNonZombieSettled: f3Settled, won: f3Won,
      winRate: f3Settled ? Math.round((f3Won / f3Settled) * 1000) / 1000 : null,
      note: "Доля выигравших среди ИСПОЛНЕННЫХ, НЕзомби, сеттлнутых сигналов — первая честная проверка F3 «модель хорошая». Мал n в межсезонье → читать как сигнал, не вердикт.",
    },
    notes,
  };
}
