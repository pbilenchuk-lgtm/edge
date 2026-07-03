// ============================================================
// EDGE LAB — seed data (from the reference mockup edge-lab-v18.jsx)
// Populates a full slice: treasury, competitions, strategies, shares,
// analytics prompts, and football matches across all four states with
// markets (Polymarket-style cents), assessments, bets, reassessments and
// closing prices. Enough to drive the smoke run and the future UI.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { extractThresholdsHeuristic } from "./thresholds.js";
import type { Bet, Market } from "./types.js";

const T = "2026-07-03T12:00:00.000Z"; // deterministic seed timestamp

/** cents price from decimal odds (implied probability * 100) */
const oddsToCents = (odds: number) => Math.round((1 / odds) * 100);

export function seedDatabase(db: Database): void {
  // idempotent: wipe in FK-safe order
  for (const t of [
    "trade_log", "reassessments", "bets", "markets", "assessments", "analysis_jobs",
    "quality_metrics", "strategy_versions", "strategy_shares", "matches",
    "strategies", "analytics_prompts", "competitions", "sports", "treasury",
  ]) db.exec(`DELETE FROM ${t};`);

  // --- treasury (§2.3) ---
  R.setTreasury(db, 5000);

  // --- sports ---
  R.upsertSport(db, "football", "Футбол");
  R.upsertSport(db, "tennis", "Теннис");

  // --- competitions (§2.2) with budgets + ESPN league (категоризация/авто-импорт) ---
  // ЧМ-2026 — ядро (fifa.world). Остальные — дополнения с их лигами.
  const comps: [string, string, string, number, string | null][] = [
    ["wc2026", "football", "ЧМ-2026", 1500, "fifa.world"],
    ["ucl", "football", "Лига чемпионов", 400, "uefa.champions"],
    ["youth", "football", "Юниоры U-20", 0, null],
    ["atp", "tennis", "ATP Masters", 400, "atp"],
  ];
  for (const [id, sport, name, budget, league] of comps)
    R.upsertCompetition(db, { id, sport_id: sport, name, budget, external_league: league, created_at: T });

  // --- analytics prompts (§2.4): base per sport + comp override ---
  R.upsertAnalyticsPrompt(db, "sport", "football",
    "Оцени матч объективно. Учитывай силу составов (после объявления — приоритет), территориальное преимущество, xG, форму, мотивацию, тактику, H2H. Дай вероятности П1/Х/П2 и ключевых рынков. Две версии: развёрнутая и краткое саммари.",
    "Claude Opus 4.8");
  R.upsertAnalyticsPrompt(db, "sport", "tennis",
    "Оцени матч объективно. Покрытие и его соответствие стилю, форма, физика, H2H, усталость. Вероятность победы каждого игрока и ключевых рынков. Краткое саммари + развёрнутая версия.",
    "Claude Sonnet 5");
  R.upsertAnalyticsPrompt(db, "competition", "youth",
    "Юниорский футбол: мало статистики, выше дисперсия. Опирайся на индивидуальный класс и физику больше, чем на командные метрики. Помечай уверенность ниже.",
    null);

  // --- strategies (§2.5) with params re-extracted from the prompt (§3.2) ---
  const strats: Array<Omit<Parameters<typeof R.insertStrategy>[1], "params">> = [
    { id: "edge", sport_id: "football", name: "Edge Tiered", tag: "лесенка", color: "#e8a838", version: 1, model: "Claude Opus 4.8", created_at: T,
      prompt: "Входи ТОЛЬКО при уверенности «высокая» и когда рынок не впитал информацию.\nРазмер по лесенке: edge>=10% -> 20%; 7-10% -> 15%; 5-7% -> 10%; 3-5% -> 5%.\nМожно несколько ставок на матч. Переоценка на голах.\nОграничители: не более 20% на ставку, стоп -25%." },
    { id: "flat", sport_id: "football", name: "Flat", tag: "фикс 5%", color: "#5b9bd5", version: 1, model: "Claude Haiku 4.5", created_at: T,
      prompt: "Входи на любой edge >= 3%. Размер всегда 5%. Выход по финалу.\nОграничители: не более 5% на ставку." },
    { id: "kelly", sport_id: "football", name: "Kelly ½", tag: "half-kelly", color: "#70b56a", version: 1, model: "Claude Sonnet 5", created_at: T,
      prompt: "Входи при edge >= 2%. Размер = 0.5*edge/(odds-1), максимум 25%.\nПереоценка на голах. Ограничители: не более 25% на ставку, стоп -30%." },
    { id: "tn1", sport_id: "tennis", name: "Serve Edge", tag: "теннис", color: "#c98bdb", version: 1, model: "Claude Sonnet 5", created_at: T,
      prompt: "Входи при edge >= 4% и преимуществе на покрытии. Размер 8%. Переоценка после сета.\nОграничители: не более 10% на ставку." },
  ];
  for (const s of strats)
    R.insertStrategy(db, { ...s, params: extractThresholdsHeuristic(s.prompt) });

  // --- shares (§2.7) ---
  const shares: Record<string, Record<string, number>> = {
    wc2026: { edge: 50, kelly: 30, flat: 20 },
    ucl: { flat: 100 },
    atp: { tn1: 100 },
  };
  for (const [comp, m] of Object.entries(shares))
    for (const [strat, pct] of Object.entries(m))
      R.setShare(db, { competition_id: comp, strategy_id: strat, pct });

  // ============================================================
  // Matches
  // ============================================================

  // m-upcoming: Испания–Германия (odds-based markets)
  R.insertMatch(db, base("m-upcoming", "wc2026", "Испания", "Германия", "upcoming", { lineup_out: false, kickoff_at: "через 4 ч 20 мин" }));
  R.upsertAssessment(db, assess("m-upcoming", "pre_lineup", "низкая",
    "Близкий класс. Решает опорник Испании. Входов пока нет.",
    "Команды близкого класса. Ключевой фактор — опорник Испании: без него П1 переоценена.",
    "Ждать состав."));
  addMarkets(db, "m-upcoming", [
    ["П1 Испания", oddsToCents(2.15), 0.44, null],
    ["Ничья", oddsToCents(3.3), 0.28, null],
    ["П2 Германия", oddsToCents(3.6), 0.28, null],
  ]);

  // m-lineup: Португалия–Хорватия (Polymarket cents; proposed bets)
  R.insertMatch(db, base("m-lineup", "wc2026", "Португалия", "Хорватия", "lineup", { lineup_out: true, kickoff_at: "через 55 мин" }));
  R.upsertAssessment(db, assess("m-lineup", "pre_lineup", "средняя",
    "Португалия фаворит выхода, зависит от ротации.",
    "До состава: Португалия фаворит по выходу, но многое зависит от ротации основы.", "Ждём состав."));
  R.upsertAssessment(db, assess("m-lineup", "post_lineup", "высокая",
    "Основа Португалии в старте, Хорватия осторожна. Team to Advance недооценён + ТМ 2.5.",
    "Основа Португалии в старте — созидание выше. Хорватия садится ниже. Team to Advance справедлив, но есть край на Under 2.5 и Portugal -1.5.",
    "Вход: Under 2.5 + точечно Portugal Advance."));
  addMarkets(db, "m-lineup", [
    ["Team to Advance — Португалия", 72.5, 0.70, "1.1M"],
    ["Under 2.5", 46.8, 0.55, "2.5M"],
    ["Over 2.5", 53.5, 0.45, "2.5M"],
    ["Both Teams to Score — Yes", 58, 0.52, "978K"],
    ["Portugal -1.5", 32.8, 0.30, "663K"],
    ["Over 1.5", 79, 0.80, "153K"],
    ["1st Half Over 0.5", 69, 0.72, "61K"],
    ["Over 3.5", 30.8, 0.26, "399K"],
  ]);
  addBets(db, "m-lineup", "edge", [
    prop("Under 2.5", 46.8, 0.55, 15, "Состав вышел, рынок не впитал силу основы. Беру Under 2.5 и выход Португалии — по лесенке."),
    prop("Portugal Advance", 72.5, 0.70, 8, "Второй независимый край — выход Португалии."),
  ]);
  addBets(db, "m-lineup", "flat", [prop("Under 2.5", 46.8, 0.55, 5, "Edge выше порога 3%. Вхожу фиксированным 5%.")]);
  addBets(db, "m-lineup", "kelly", [prop("Under 2.5", 46.8, 0.55, 12, "Край выше 2% — порог Kelly пройден. Размер скромный.")]);
  R.insertReassessment(db, reassess("m-lineup", "edge", "-55'", "Состав вышел. Вижу край на Under 2.5 и на выход Португалии. Готовлю два входа.", "высокая", "time"));

  // m-live: Бразилия–Англия (open positions, mark-to-market)
  R.insertMatch(db, base("m-live", "wc2026", "Бразилия", "Англия", "live", { lineup_out: true, minute: 63, score_home: 1, score_away: 0 }));
  R.upsertAssessment(db, assess("m-live", "post_lineup", "высокая",
    "Бразилия ведёт. Advance-цена выросла 55¢->78¢.",
    "Бразилия повела и контролирует. По Edge частично фиксировать; Kelly держит.",
    "Edge — фиксация. Flat/Kelly держат."));
  addMarkets(db, "m-live", [
    ["Team to Advance — Бразилия", 78, 0.82, "1.2M"],
    ["Over 1.5", 62, 0.66, "154K"],
    ["Both Teams to Score — Yes", 41, 0.36, "500K"],
    ["Under 2.5", 55, 0.60, "800K"],
    ["Brazil -1.5", 44, 0.40, "200K"],
  ]);
  addBets(db, "m-live", "edge", [
    open("Advance Бразилия", 55, 78, 0.82, 112, "3'", "Вошёл до матча. После гола фиксирую половину, но Over 1.5 добавил по ходу."),
    open("Over 1.5", 50, 62, 0.66, 60, "20' (добавлено)", "Игра раскрылась — вероятность второго гола выросла."),
  ]);
  addBets(db, "m-live", "flat", [open("Advance Бразилия", 55, 78, 0.82, 15, "3'", "Держу Advance до финала по дисциплине Flat.")]);
  addBets(db, "m-live", "kelly", [open("Advance Бразилия", 55, 78, 0.82, 63, "3'", "Держу, не добавляю: цена впитала часть эджа.")]);
  R.insertReassessment(db, reassess("m-live", "edge", "41'", "Гол Бразилии 1:0. Цена 55¢->70¢. Держу основную, добавляю Over 1.5.", "высокая", "goal"));
  R.insertReassessment(db, reassess("m-live", "edge", "63'", "Цена 78¢, край сузился до ~4%. Фиксирую половину Advance, хвост оставляю.", "высокая", "price_move"));
  R.insertTradeLog(db, tlog("m-live", "edge", "3'", "enter", "Вход Advance @ 55¢ — $112"));
  R.insertTradeLog(db, tlog("m-live", "edge", "20'", "enter", "Добавлено Over 1.5 @ 50¢ — $60"));
  R.insertTradeLog(db, tlog("m-live", "edge", "63'", "exit", "Фиксация 50% Advance @ 78¢"));

  // m-finished: Франция–Португалия (settled + closing prices for CLV)
  R.insertMatch(db, base("m-finished", "wc2026", "Франция", "Португалия", "finished", {
    lineup_out: true, score_home: 2, score_away: 1, final_score: "2:1",
    kickoff_time: "13:00", end_time: "14:52", duration: "1 ч 52 мин", end_note: "основное время",
  }));
  R.upsertAssessment(db, assess("m-finished", "post_lineup", "высокая",
    "Франция сильнее территориально.",
    "Франция реализовала перевес, 2-й гол — из недооценённого сценария.", "Вход Advance Франция."));
  // closing prices (is_closing) for CLV
  addMarkets(db, "m-finished", [["Advance Франция", 92, 0.85, "1.4M"], ["Under 2.5", 40, 0.55, "900K"]], true);
  addBets(db, "m-finished", "edge", [
    settled("Advance Франция", 55, 92, 0.85, 100, "won", 182),
    settled("Under 2.5", 58, 40, 0.55, 60, "won", 104),
  ]);
  addBets(db, "m-finished", "flat", [settled("Advance Франция", 55, 92, 0.85, 50, "won", 58.2)]);
  addBets(db, "m-finished", "kelly", [settled("Advance Франция", 55, 92, 0.85, 95, "won", 149.5)]);
  R.insertTradeLog(db, tlog("m-finished", "edge", "финал", "settle", "+$126"));

  // m-ucl-live: Реал–Ман Сити
  R.insertMatch(db, base("m-ucl-live", "ucl", "Реал", "Ман Сити", "live", { lineup_out: true, minute: 28, score_home: 0, score_away: 0 }));
  R.upsertAssessment(db, assess("m-ucl-live", "post_lineup", "высокая", "Сити контролит, край на ТМ 2.5.",
    "Оба состава основные. Низкая результативность вероятна. ТМ 2.5 даёт край.", "Вход на ТМ 2.5."));
  addMarkets(db, "m-ucl-live", [["Under 2.5", oddsToCents(1.9), 0.58, "300K"]]);
  addBets(db, "m-ucl-live", "flat", [open("Under 2.5", 51, 53, 0.58, 20, "1'", "Вход ТМ2.5 по дисциплине Flat.")]);

  // m-tennis: Алькарас–Синнер
  R.insertMatch(db, base("m-tennis", "atp", "Алькарас", "Синнер", "lineup", { lineup_out: true, kickoff_at: "через 30 мин" }));
  R.upsertAssessment(db, assess("m-tennis", "post_lineup", "высокая", "Алькарас лучше на быстром харде.",
    "Алькарас лучше на быстром харде, Синнер стабильнее на приёме. Рынок близок к справедливому.", "Малый вход П1."));
  addMarkets(db, "m-tennis", [["П1 Алькарас", oddsToCents(1.75), 0.60, "120K"]]);
  addBets(db, "m-tennis", "tn1", [prop("П1 Алькарас", oddsToCents(1.75), 0.60, 8, "Малый край на покрытии — точечный вход 8%.")]);

  // --- quality_metrics (§2.14): demo values from the reference mockup ---
  const quality: Record<string, { brier: number; clv: number; samples: number; calib: Array<[string, number, number]> }> = {
    edge: { brier: 0.182, clv: 3.4, samples: 24, calib: [["50-60%", 55, 53], ["60-70%", 65, 67], ["70-80%", 75, 72], ["80%+", 85, 88]] },
    flat: { brier: 0.213, clv: 0.8, samples: 24, calib: [["50-60%", 55, 51], ["60-70%", 65, 64], ["70-80%", 75, 70], ["80%+", 85, 79]] },
    kelly: { brier: 0.195, clv: 2.1, samples: 18, calib: [["50-60%", 55, 56], ["60-70%", 65, 63], ["70-80%", 75, 74], ["80%+", 85, 83]] },
    tn1: { brier: 0.24, clv: -0.5, samples: 6, calib: [["50-60%", 55, 52], ["60-70%", 65, 61]] },
  };
  for (const [sid, q] of Object.entries(quality))
    R.upsertQuality(db, {
      strategy_id: sid, samples: q.samples, brier: q.brier, clv: q.clv,
      calibration: q.calib.map(([bucket, predicted, actual]) => ({ bucket, predicted, actual })),
      updated_at: T,
    });
}

// ---------- small builders ----------
function base(id: string, comp: string, home: string, away: string, state: any, extra: Partial<any> = {}) {
  return {
    id, competition_id: comp, home, away, state,
    lineup_out: false, kickoff_at: null, minute: null, score_home: null, score_away: null,
    final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null,
    external_ref: null, ...extra,
  };
}
function assess(matchId: string, stage: any, confidence: any, short: string, body: string, verdict: string) {
  return { id: R.uid(), match_id: matchId, stage, confidence, short, body, verdict, model: "Claude Opus 4.8", status: "ok" as const, created_at: T };
}
function addMarkets(db: Database, matchId: string, rows: Array<[string, number, number, string | null]>, closing = false) {
  for (const [label, price, aiProb, liq] of rows) {
    const m: Market = {
      id: R.uid(), match_id: matchId, label, price, ai_prob: aiProb, liquidity: liq ? `$${liq}` : null,
      external_ref: `pm-${matchId}-${slug(label)}`, snapshot_at: T, is_closing: closing,
    };
    R.insertMarket(db, m);
  }
}
function addBets(db: Database, matchId: string, strat: string, bets: Partial<Bet>[]) {
  for (const b of bets)
    R.insertBet(db, { ...(b as Bet), id: R.uid(), match_id: matchId, strategy_id: strat, created_at: T });
}
const prop = (market: string, price: number, aiProb: number, stake: number, rationale: string): Partial<Bet> =>
  ({ market_label: market, status: "proposed", proposed_price: price, entry_price: null, current_price: null, closing_price: null, ai_prob: aiProb, stake, rationale, entered_minute: null, result: null, payout: null });
const open = (market: string, entry: number, current: number, aiProb: number, stake: number, minute: string, rationale: string): Partial<Bet> =>
  ({ market_label: market, status: "open", proposed_price: entry, entry_price: entry, current_price: current, closing_price: null, ai_prob: aiProb, stake, rationale, entered_minute: minute, result: null, payout: null });
const settled = (market: string, entry: number, closing: number, aiProb: number, stake: number, result: "won" | "lost", payout: number): Partial<Bet> =>
  ({ market_label: market, status: result === "won" ? "settled_won" : "settled_lost", proposed_price: entry, entry_price: entry, current_price: closing, closing_price: closing, ai_prob: aiProb, stake, rationale: null, entered_minute: "3'", result, payout });
const reassess = (matchId: string, strat: string, minute: string, body: string, conf: string, trigger: any) =>
  ({ id: R.uid(), match_id: matchId, strategy_id: strat, minute, body, confidence: conf, trigger, created_at: T });
const tlog = (matchId: string, strat: string, minute: string, type: any, text: string) =>
  ({ id: R.uid(), match_id: matchId, strategy_id: strat, minute, type, text, created_at: T });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9а-я]+/gi, "-").slice(0, 24);
