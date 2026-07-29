// ============================================================
// EDGE LAB — PHASE-F READINESS GATE  [SERVER-ONLY, read-only]
//
// "Is the dry-run contour healthy enough to trust with real money on ONE strategy?" This is the
// mechanical go/hold gate before flipping REAL_TRADING dry_run → exits_only/on. It does NOT re-audit
// the CODE (that was the batch-1 audit) — it audits the accumulated dry-run DATA and asserts the
// runtime invariants that MUST hold, screaming on any breach:
//
//   • mode is actually dry_run and nothing is stuck in an auto-pause / orphan alert
//   • the target strategy is whitelisted + enabled (else nothing mirrors to real)
//   • the funnel reached a real end-to-end dry fill (dry_fill_watch verdict)
//   • twin-link integrity: no real order without a paper twin; every fill has a position
//   • accounting: dry exposure never exceeds the bank; no over-fill (filled > requested)
//   • lifecycle: nothing stuck non-terminal for hours; no rejects in dry
//   • entry slippage is bounded (a dry fill at/through the limit should not slip POSITIVE)
//
// Each check is pass / warn / fail with the number behind it. verdict = hold on ANY fail, review on
// warns-only, go when clean. Read-only. Exposed at GET /api/real?report=phase_f_readiness[&strategy=].
// ============================================================

import type { Database } from "../db.js";
import * as RR from "../realRepo.js";
import { effectiveTradingMode, type TradingMode } from "./safety.js";
import { realVsPaperReport } from "./realVsPaper.js";
import { buildDryFillWatch } from "./dryFillWatch.js";
import { realBankUsd } from "./whitelist.js";

export type CheckStatus = "pass" | "warn" | "fail";
export interface ReadinessCheck { id: string; label: string; status: CheckStatus; detail: string }
export interface PhaseFReadiness {
  targetStrategy: string;
  mode: TradingMode;
  envMode: TradingMode;
  checks: ReadinessCheck[];
  counts: { pass: number; warn: number; fail: number };
  verdict: "go" | "review" | "hold";
  note: string;
}

const STUCK_HOURS = 6;              // a dry order still 'created'/'placed' after this is a stuck-lifecycle bug
const SLIP_WARN_CENTS = 2;          // dry fills at/through limit shouldn't slip POSITIVE beyond this

export function buildPhaseFReadiness(
  db: Database, env: Record<string, string | undefined> = process.env, nowMs = Date.now(), targetStrategy = "prematch_value",
): PhaseFReadiness {
  const checks: ReadinessCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });

  // ── mode & guards ──────────────────────────────────────────────────────────
  const mode = effectiveTradingMode(db, env);
  const envMode = (["on", "dry_run", "exits_only"].includes((env.REAL_TRADING ?? "off").toLowerCase()) ? (env.REAL_TRADING as string).toLowerCase() : "off") as TradingMode;
  add("mode", "Режим = dry_run", mode === "dry_run" ? "pass" : "warn",
    mode === "dry_run" ? "контур в симуляции — данные копятся корректно" : `эффективный режим «${mode}» (env «${envMode}») — dry-данные могут быть неполными/устаревшими`);
  const pause = RR.getRealAutoPause(db);
  add("auto_pause", "Нет авто-паузы", pause ? "warn" : "pass", pause ? `авто-пауза активна: ${pause.reason} (${pause.at})` : "нет залипшей паузы");
  const orphan = RR.getRealOrphanAlert(db);
  add("orphan_alert", "Нет orphan-алерта", orphan ? "fail" : "pass", orphan ? `⛔ orphan: ${orphan.message} (${orphan.at})` : "реконсиляция чиста");

  // ── whitelist: the target strategy must be enabled or nothing mirrors ────────
  const wl = RR.listWhitelist(db, true).filter((r) => r.strategy_id === targetStrategy);
  add("whitelist_target", `Whitelist: ${targetStrategy} включён`, wl.length ? "pass" : "fail",
    wl.length ? `включён (${wl.length} правил, cat=${wl.map((r) => r.categories).join("|").slice(0, 60)}, макс $${Math.max(...wl.map((r) => r.max_order_usd))})` : `⛔ ${targetStrategy} НЕ в whitelist — реальный контур его не зеркалит`);

  // ── funnel: reached a real end-to-end dry fill ───────────────────────────────
  const watch = buildDryFillWatch(db, env, nowMs);
  add("dry_fill", "Есть end-to-end dry-fill", watch.dryFillsAllTime > 0 ? "pass" : "fail",
    watch.dryFillsAllTime > 0 ? `${watch.dryFillsAllTime} dry-филлов всего, ${watch.dryFillsInWindow} за окно ($${Math.round(watch.dryFilledUsdInWindow)}); вердикт ${watch.verdict}` : `⛔ ни одного dry-филла — вердикт ${watch.verdict}: ${watch.note}`);
  const rej = watch.orders.gateRejected;
  add("gate_rejects", "Нет отказов гейта", rej > 0 ? "warn" : "pass", rej > 0 ? `${rej} ордеров отклонены гейтом (кэп/режим/conform) — проверить настройку` : "гейт не режет мимо TIF/книги");

  // ── twin-link integrity ──────────────────────────────────────────────────────
  const orphanOrders = (db.prepare(
    `SELECT COUNT(*) n FROM real_orders o LEFT JOIN bets b ON b.decision_id=o.decision_id WHERE b.id IS NULL`,
  ).get() as any).n as number;
  add("twin_orphan_orders", "Нет реальных ордеров без бумажного двойника", orphanOrders === 0 ? "pass" : "fail",
    orphanOrders === 0 ? "каждый real-ордер имеет paper-twin по decision_id" : `⛔ ${orphanOrders} real-ордеров без paper-двойника (broken twin-link)`);
  // every filled/partial entry order must have a real_position row (dry)
  const filledNoPos = (db.prepare(
    `SELECT COUNT(*) n FROM real_orders o
      WHERE o.leg='entry' AND o.status IN ('filled','partial')
        AND NOT EXISTS (SELECT 1 FROM real_positions p WHERE p.decision_id=o.decision_id)`,
  ).get() as any).n as number;
  add("filled_has_position", "Каждый филл → позиция", filledNoPos === 0 ? "pass" : "fail",
    filledNoPos === 0 ? "все исполненные ордера отражены позицией" : `⛔ ${filledNoPos} исполненных ордеров без позиции (учёт разъехался)`);

  // ── accounting ───────────────────────────────────────────────────────────────
  const bank = realBankUsd(env), open = Math.round(RR.openDryExposureUsd(db) * 100) / 100;
  add("exposure_le_bank", "Экспозиция ≤ банка", open <= bank + 1e-6 ? "pass" : "fail",
    open <= bank + 1e-6 ? `в игре $${Math.round(open)} ≤ банк $${Math.round(bank)}` : `⛔ dry-экспозиция $${Math.round(open)} > банк $${Math.round(bank)} — перелив бюджета`);
  const overfill = (db.prepare(`SELECT COUNT(*) n FROM real_orders WHERE filled_size_usd > size_usd + 0.01`).get() as any).n as number;
  add("no_overfill", "Нет пере-исполнения", overfill === 0 ? "pass" : "fail",
    overfill === 0 ? "ни один ордер не исполнен больше запрошенного" : `⛔ ${overfill} ордеров с filled > size (невозможный филл)`);

  // ── lifecycle ────────────────────────────────────────────────────────────────
  const stuckCutoff = new Date(nowMs - STUCK_HOURS * 3_600_000).toISOString();
  const stuck = (db.prepare(
    `SELECT COUNT(*) n FROM real_orders WHERE status IN ('created','placed') AND created_at < ?`,
  ).get(stuckCutoff) as any).n as number;
  add("no_stuck_orders", `Нет залипших ордеров (>${STUCK_HOURS}ч)`, stuck === 0 ? "pass" : "warn",
    stuck === 0 ? "все ордера дошли до терминального статуса" : `${stuck} ордеров висят в created/placed >${STUCK_HOURS}ч — dry должен заполнять/истекать мгновенно`);
  const rejected = (db.prepare(`SELECT COUNT(*) n FROM real_orders WHERE status='rejected'`).get() as any).n as number;
  add("no_rejected", "Нет rejected-ордеров", rejected === 0 ? "pass" : "warn",
    rejected === 0 ? "нет отклонённых ордеров" : `${rejected} ордеров rejected — в dry это сигнал бага сборки ордера`);

  // ── fidelity: entry slippage should not run POSITIVE on dry fills ────────────
  const rvp = realVsPaperReport(db);
  const slip = rvp.slippage.entryMeanCents;
  add("entry_slippage", "Слиппедж входа ограничен", slip == null ? "warn" : slip > SLIP_WARN_CENTS ? "warn" : "pass",
    slip == null ? "нет заполненных входов для замера слиппеджа" : `средний слиппедж входа ${slip >= 0 ? "+" : ""}${slip}¢ (n=${rvp.slippage.n}); медиана ${rvp.slippage.entryMedianCents}¢`);

  // target-strategy coverage: did the dry-run actually EXERCISE the strategy we want to go real with?
  const tgtOrders = (db.prepare(`SELECT COUNT(*) n FROM real_orders WHERE strategy_id=? AND leg='entry'`).get(targetStrategy) as any).n as number;
  const tgtFills = (db.prepare(`SELECT COUNT(*) n FROM real_orders WHERE strategy_id=? AND leg='entry' AND status IN ('filled','partial')`).get(targetStrategy) as any).n as number;
  add("target_exercised", `${targetStrategy} реально прогнан в dry`, tgtFills > 0 ? "pass" : tgtOrders > 0 ? "warn" : "fail",
    tgtFills > 0 ? `${tgtFills} dry-филлов из ${tgtOrders} ордеров по целевой стратегии` : tgtOrders > 0 ? `${tgtOrders} ордеров, но 0 филлов — целевая стратегия не дошла до книги` : `⛔ 0 ордеров по ${targetStrategy} — нечего оценивать для реала`);

  // ── [пункт 7] ПАРА ИСПОЛНЕНИЯ: два блокера, которые обязаны стоять здесь явно ──────────────────
  //
  // (1) ВЕЕР ПО ЛИКВИДНОСТИ. Книга ордеров кэшируется на цикл, и несколько ставок (профили одной
  // стратегии, а то и разные стратегии) исполняются об ОДИН И ТОТ ЖЕ стакан, НЕ съедая его: каждая
  // получает полную глубину, как будто пришла первой. На бумаге это бесплатно, на реальных деньгах —
  // нет: второй ордер идёт по худшей цене или не проходит вовсе. Значит ВСЯ статистика исполнения
  // систематически оптимистична, и любой вывод о ВМЕСТИМОСТИ, снятый с неё, завышен. Это не «замечание
  // к отчёту»: пока веер есть, число «сколько мы можем поставить» не является измерением. Гейт держит
  // Phase F до тех пор, пока веер по ЦЕЛЕВОЙ стратегии не устранён или честно не отнесён владельцем.
  const fanRows = db.prepare(
    `SELECT b.strategy_id AS sid, SUM(f.notional_usd) AS usd, COUNT(*) AS n
       FROM fill_costs f JOIN bets b ON b.id = f.bet_id
      WHERE f.side='buy' AND f.from_book=1
      GROUP BY f.match_id, b.market_label, f.created_at, b.strategy_id
     HAVING COUNT(*) > 1`,
  ).all() as { sid: string; usd: number; n: number }[];
  const allBuy = ((db.prepare(`SELECT COALESCE(SUM(notional_usd),0) AS x, COUNT(*) AS n FROM fill_costs WHERE side='buy' AND from_book=1`).get() as any) ?? { x: 0, n: 0 });
  const tgtFan = fanRows.filter((r) => r.sid === targetStrategy);
  const tgtFanUsd = Math.round(tgtFan.reduce((a, r) => a + (r.usd ?? 0), 0));
  const allFanUsd = Math.round(fanRows.reduce((a, r) => a + (r.usd ?? 0), 0));
  const fanPct = allBuy.x > 0 ? Math.round((1000 * allFanUsd) / allBuy.x) / 10 : null;
  add("liquidity_fanout", "Нет веера по ликвидности у целевой стратегии",
    Number(allBuy.n) === 0 ? "warn" : tgtFanUsd > 0 ? "fail" : allFanUsd > 0 ? "warn" : "pass",
    Number(allBuy.n) === 0
      ? "книжных филлов ещё нет — веер не измерен, и это значит «неизвестно», а не «нет»"
      : tgtFanUsd > 0
        ? `⛔ $${tgtFanUsd} входов ${targetStrategy} исполнены об ОДИН стакан в один момент (${tgtFan.length} случаев) — глубина не съедалась, статистика исполнения завышена. Вывод о вместимости на этих числах строить нельзя, пока веер не устранён или не отнесён явно.`
        : allFanUsd > 0
          ? `у ${targetStrategy} веера нет, но по остальным стратегиям $${allFanUsd} (${fanPct}% книжного объёма) — их числа вместимости завышены`
          : `каждый книжный филл единственный на свой стакан — глубина не переиспользована`);

  // (2) ПРЕДОХРАНИТЕЛЬ-БЕРСЕРК СЧИТАЛ СИМУЛЯЦИЮ ЗА РЕАЛЬНЫЕ ДЕНЬГИ. В real_orders не было признака
  // сухого прогона, и лимит «N ордеров/час» складывал оба контура: в dry он молча подрезал сухую воронку
  // (а причина не называлась), а в момент перехода на реал первые же настоящие ордера могли быть
  // отклонены квотой, потраченной симуляцией. Колонка `dry` и раздельный счёт это чинят; проверка стоит
  // здесь, потому что доверять сухой статистике можно только зная, что её не подрезал чужой лимит.
  const dryCol = (db.prepare(`SELECT COUNT(*) n FROM pragma_table_info('real_orders') WHERE name='dry'`).get() as any).n as number;
  const mixed = dryCol ? ((db.prepare(`SELECT COUNT(*) n FROM real_orders WHERE dry NOT IN (0,1)`).get() as any).n as number) : -1;
  add("berserk_scope", "Предохранитель считает свой контур", dryCol === 0 ? "fail" : mixed > 0 ? "fail" : "pass",
    dryCol === 0 ? "⛔ у real_orders нет признака dry — предохранитель ордеров/час считает симуляцию наравне с реальными деньгами"
      : mixed > 0 ? `⛔ ${mixed} ордеров с неопределённым режимом — счётчик контура неоднозначен`
      : "сухие и реальные ордера считаются раздельно — квота симуляции не расходует реальную");

  const counts = { pass: checks.filter((c) => c.status === "pass").length, warn: checks.filter((c) => c.status === "warn").length, fail: checks.filter((c) => c.status === "fail").length };
  const verdict: PhaseFReadiness["verdict"] = counts.fail > 0 ? "hold" : counts.warn > 0 ? "review" : "go";
  const note = verdict === "hold"
    ? `⛔ HOLD: ${counts.fail} провал(ов) инвариантов — Phase F нельзя, пока не закрыты. Реальные деньги не двигать.`
    : verdict === "review"
      ? `⚠ REVIEW: жёстких провалов нет, но ${counts.warn} предупреждение(й) — просмотреть перед Phase F.`
      : `✅ GO: все инварианты держатся. Dry-контур готов к переходу на реал по ${targetStrategy} (следующий шаг — REAL_TRADING=exits_only или узкий on с малым кэпом).`;

  return { targetStrategy, mode, envMode, checks, counts, verdict, note };
}
