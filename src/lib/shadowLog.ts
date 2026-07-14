// ============================================================
// EDGE LAB — GLOBAL shadow-budget log. One document over ALL matches: how the
// single-bank allocator disposed of capital across every decision, so the whole
// history can be run through offline analytics and the caps/buffer optimised
// BEFORE real money rides on this layer. Read-only.
//
// The per-match log (matchLog.ts) shows one match's shadow section; this is the
// cross-match roll-up + the FULL ledger (not the 200-row UI cap). Served from the
// Бюджет page ("глобальный лог") and `npm run shadow:report`.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { loadShadowConfig, shadowAnalytics, shadowProject, buildReplayEntries, shadowPoolState, type ShadowConfig } from "./shadow.js";
import { summarizeFillCosts, groupFillCosts } from "./fillCosts.js";
import { budgetPosition } from "./budgetPosition.js";

const REASON_RU: Record<string, string> = {
  insufficient_free: "нет свободных средств", cash_reserve: "неснижаемый остаток",
  live_buffer: "буфер под live", cap_match: "потолок матча",
  cap_category: "потолок категории", cap_strategy: "потолок стратегии",
};
const r0 = (n: number) => Math.round(n);
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => (n < 0 ? `-$${r2(Math.abs(n))}` : `$${r2(n)}`);
const signed = (n: number) => (n < 0 ? `-$${r2(Math.abs(n))}` : `+$${r2(n)}`);
const pct = (n: number) => `${r0(n * 100)}%`;

/** Realised P&L attributable to a denied/trimmed decision (its real bet DID execute
 *  in the isolated sim), weighted by the UN-funded fraction. Positive = the deficit
 *  cost money; negative = it dodged a loss. */
function deniedPnlOf(db: Database, e: R.ShadowEventRow): number {
  if (e.verdict === "allowed" || !e.bet_id) return 0;
  const bet = R.getBet(db, e.bet_id);
  if (!bet || bet.payout == null || bet.stake == null) return 0;
  if (!R.isSettled(bet.status)) return 0;
  const unfunded = e.size_requested > 0 ? (e.size_requested - e.size_reserved) / e.size_requested : 0;
  return (bet.payout - bet.stake) * unfunded;
}

export function buildShadowLog(db: Database, opts: { now?: string; config?: ShadowConfig } = {}): string {
  const cfg = opts.config ?? loadShadowConfig(db);
  const nowIso = opts.now ?? new Date().toISOString();
  const events = R.allShadowEvents(db).slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const an = shadowAnalytics(db, cfg);
  const proj = shadowProject(buildReplayEntries(db), cfg);
  const pool = shadowPoolState(db, cfg, nowIso);

  // Label maps.
  const catName: Record<string, string> = {}; for (const c of R.listCompetitions(db)) catName[c.id] = c.name;
  const stratName: Record<string, string> = {}; for (const s of R.listStrategies(db)) stratName[s.id] = s.name;
  const matchName: Record<string, string> = {};
  for (const c of R.listCompetitions(db)) for (const m of R.listMatches(db, c.id)) matchName[m.id] = `${m.home} — ${m.away}`;

  const L: string[] = [];
  L.push(`# Глобальный лог теневого бюджета`);
  L.push(`- Сформирован: ${nowIso}`);
  L.push(`- Аллокатор: **${cfg.enabled ? "включён" : "выключен"}** · банк $${r0(cfg.bankTotal)}`);
  L.push(`- Решений в реестре: **${events.length}**`);

  L.push(`\n## Настройки (что было в силе при съёме)`);
  L.push(`- банк: $${r0(cfg.bankTotal)}`);
  L.push(`- неснижаемый остаток: ${pct(cfg.cashReservePct)} · буфер под live: ${pct(cfg.liveBufferPct)}`);
  L.push(`- потолки: матч ${pct(cfg.capMatchPct)} · категория ${pct(cfg.capCategoryPct)} · стратегия ${pct(cfg.capStrategyPct)}`);
  L.push(`- лаг резолва: ${cfg.settlementLagMin} мин`);

  const mp = budgetPosition(db, nowIso);
  L.push(`\n## Наш бюджет для ставок (реальный банк $${r0(mp.bank)})`);
  L.push(`- **Баланс** $${r0(mp.balance)} (банк $${r0(mp.bank)} ${mp.netRealized >= 0 ? "+" : "−"} реализованное ${money(Math.abs(mp.netRealized))}) · капитал сейчас (с нереализованным) $${r0(mp.equity)}`);
  L.push(`- **Свободно** $${r0(mp.free)} · **заинвестировано** $${r0(mp.invested)} в ${mp.openCount} открытых${mp.settling > 0 ? ` · $${r0(mp.settling)} в резолве` : ""}`);
  L.push(`- **Заработано** ${money(mp.earned)} · **потеряно** ${money(mp.lostMoney)} · итог **${signed(mp.netRealized)}** (${mp.settled} расчётов: ${mp.won} побед / ${mp.lost} поражений)`);
  L.push(`- **В процессе** (открытые, mark-to-market): нереализованный P&L **${signed(mp.openPnl)}** · ${mp.openPlus} в плюсе (${signed(mp.openPlusPnl)}) / ${mp.openMinus} в минусе (${signed(mp.openMinusPnl)})`);
  L.push(`- Издержки на банк (масштаб. к вкладу): всего ${money(mp.costTotal)} (комиссии ${money(mp.fees)} · слиппедж ${money(mp.slippage)})`);
  L.push(`  _(суммы — доля реального банка $${r0(mp.bank)} в каждой позиции, не изолированные бюджеты симуляций стратегий)_`);

  L.push(`\n## Текущий пул`);
  L.push(`- свободно $${r0(pool.free)} · зарезервировано $${r0(pool.reserved)} · в резолве $${r0(pool.settling)}`);
  L.push(`- буфер live: занято $${r0(pool.liveBufferUsed)} из $${r0(pool.liveBufferTotal)} · свободный буфер $${r0(pool.liveBufferFree)}`);

  L.push(`\n## Итог по всем решениям (как было размещено на самом деле)`);
  L.push(`- всего ${an.total} · принято ${an.allowed} · заблокировано ${an.blocked} (${an.blockedPct}%) · урезано ${an.trimmed} (${an.trimmedPct}%)`);
  L.push(`- P&L входов, которым пул отказал/урезал: **${signed(an.missedPnl)}** (плюс = дефицит стоил денег; минус = уберёг от убытка)`);
  L.push(`- решений в конкуренции за пул: ${an.contentionEvents}`);
  if (Object.keys(an.byReason).length) {
    L.push(`- причины отказа/урезания: ${Object.entries(an.byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${REASON_RU[r] ?? r}=${n}`).join(" · ")}`);
  }

  const ps = proj.summary;
  L.push(`\n## Проекция «единый банк с нуля» (worst-case пере-сайзинг от банка)`);
  L.push(`- всего ${ps.total} · с данными для сайзинга ${ps.covered} (без данных ${ps.noData}) · профинансировано ${ps.funded} · заблокировано ${ps.blocked} (${ps.blockedPct}% от covered)`);
  L.push(`- упущенный P&L по проекции: **${signed(ps.missedPnl)}** · спроецировано всего $${r0(ps.totalProjected)}`);
  L.push(`- утилизация банка: пик ${ps.peakUtilPct}% · средняя ${ps.avgUtilPct}%`);

  // Breakdowns computed once over the ledger.
  type Agg = { n: number; req: number; res: number; blocked: number; trimmed: number; denied: number };
  const fresh = (): Agg => ({ n: 0, req: 0, res: 0, blocked: 0, trimmed: 0, denied: 0 });
  const byCat = new Map<string, Agg>(), byStrat = new Map<string, Agg>(), byPhase = new Map<string, Agg>();
  const bump = (map: Map<string, Agg>, key: string, e: R.ShadowEventRow) => {
    const a = map.get(key) ?? fresh();
    a.n++; a.req += e.size_requested; a.res += e.size_reserved;
    if (e.verdict === "blocked") a.blocked++; else if (e.verdict === "trimmed") a.trimmed++;
    a.denied += deniedPnlOf(db, e);
    map.set(key, a);
  };
  for (const e of events) {
    bump(byCat, e.competition_id, e);
    bump(byStrat, e.strategy_id, e);
    bump(byPhase, e.is_live ? "live" : "предматч", e);
  }
  const dumpAgg = (title: string, map: Map<string, Agg>, name: (k: string) => string) => {
    if (!map.size) return;
    L.push(`\n## ${title}`);
    for (const [k, a] of [...map.entries()].sort((x, y) => y[1].req - x[1].req)) {
      L.push(`- **${name(k)}**: ${a.n} решений · запрошено $${r0(a.req)} → размещено $${r0(a.res)} · заблок. ${a.blocked} · урезано ${a.trimmed} · P&L отказов ${signed(a.denied)}`);
    }
  };
  dumpAgg("По категориям", byCat, (k) => catName[k] ?? k);
  dumpAgg("По стратегиям", byStrat, (k) => stratName[k] ?? k);
  dumpAgg("По фазе входа", byPhase, (k) => k);

  // ── Execution costs (fees + slippage) — the real-money leak, aggregated globally ──
  const fills = R.allFillCosts(db);
  L.push(`\n## Издержки исполнения (комиссии + слиппедж)`);
  if (!fills.length) {
    L.push("(нет исполнений с книгой — пока нечего агрегировать)");
  } else {
    const fc = summarizeFillCosts(fills);
    L.push(`- ${fc.fills} исполнений (${fc.buys} вход / ${fc.sells} выход) · оборот $${r0(fc.notionalUsd)}`);
    L.push(`- комиссии **${money(fc.feeUsd)}** (вход ${money(fc.feeBuyUsd)} · выход ${money(fc.feeSellUsd)})`);
    L.push(`- слиппедж **${money(fc.slipUsd)}** (вход ${money(fc.slipBuyUsd)} · выход ${money(fc.slipSellUsd)}) · средний ${fc.avgSlipCents}¢/шт`);
    L.push(`- ВСЕГО издержек **${money(fc.totalUsd)}** = ${fc.costPctOfNotional}% оборота${fc.modelledFills ? ` · ${fc.modelledFills} по модели` : ""}`);
    const dumpCost = (title: string, map: Map<string, ReturnType<typeof summarizeFillCosts>>, name: (k: string) => string) => {
      if (!map.size) return;
      L.push(`\n### ${title}`);
      for (const [k, s] of [...map.entries()].sort((x, y) => y[1].totalUsd - x[1].totalUsd)) {
        L.push(`- **${name(k)}**: издержки ${money(s.totalUsd)} (комиссии ${money(s.feeUsd)} · слип ${money(s.slipUsd)}) на обороте $${r0(s.notionalUsd)} = ${s.costPctOfNotional}%`);
      }
    };
    dumpCost("По категориям", groupFillCosts(fills, (f) => f.competition_id), (k) => catName[k] ?? k);
    dumpCost("По стратегиям", groupFillCosts(fills, (f) => f.strategy_id), (k) => stratName[k] ?? k);
  }

  L.push(`\n## Полный реестр решений (${events.length}, по времени)`);
  L.push(`_время · матч · категория · стратегия/профиль · фаза · запрос→резерв · вердикт · причина · edge · конкуренция · проекция_`);
  const projById = new Map<string, { size: number; verdict: string }>();
  R.allShadowEvents(db).forEach((e, i) => { const rr = proj.results[i]; if (rr) projById.set(e.id, rr); });
  for (const e of events) {
    const v = e.verdict === "allowed" ? "принят" : e.verdict === "trimmed" ? "урезан" : "отказ";
    const why = e.reason ? ` · ${REASON_RU[e.reason] ?? e.reason}` : "";
    const pj = projById.get(e.id);
    const pjTxt = pj ? ` · проекция $${r0(pj.size)}/${pj.verdict}` : "";
    L.push(`- ${e.created_at} · ${matchName[e.match_id] ?? e.match_id} · ${catName[e.competition_id] ?? e.competition_id} · ${stratName[e.strategy_id] ?? e.strategy_id}/${e.profile_id} · ${e.is_live ? "live" : "предматч"} · $${r0(e.size_requested)}→$${r0(e.size_reserved)} · **${v}**${why} · edge ${(e.edge * 100).toFixed(1)}%${e.contention ? " · ⚔" : ""}${pjTxt}`);
  }
  if (!events.length) L.push("(реестр пуст — аллокатор ещё не принимал решений)");

  return L.join("\n");
}
