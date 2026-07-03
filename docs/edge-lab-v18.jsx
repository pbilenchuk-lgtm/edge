import React, { useState } from "react";

// ============================================================
// EDGE LAB v9 — двухуровневые деньги + аналитический промт
//
// ДЕНЬГИ (два уровня):
//   1) Казна -> Турнир: бюджет турнира в $ (из общего баланса).
//   2) Турнир -> Стратегии: доли в % (сумма <=100%). Поля ввода %.
//      % пересчитывается в $ от бюджета турнира автоматически.
//      Меняешь бюджет турнира — доли те же, суммы пересчитались.
//
// АНАЛИТИКА: базовый промт НА СПОРТ + переопределение НА ТУРНИР.
//   Аналитический промт — отдельная сущность (аналитика != стратегия).
//
// СТРАТЕГИЯ: цельный промт (вход/переоценка/выход + ограничители словами),
//   движок парсит пороги. Может делать несколько ставок на матч.
// ============================================================

const SPORTS = [{ id: "football", label: "Футбол" }, { id: "tennis", label: "Теннис" }];

// Провайдеры и модели (репрезентативная заглушка — в реале список подтягивается из API)
const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", keyHint: "sk-ant-…", models: ["Claude Opus 4.8", "Claude Sonnet 5", "Claude Haiku 4.5", "Claude Fable 5"] },
  { id: "openai", name: "OpenAI", keyHint: "sk-…", models: ["GPT-5", "GPT-5 mini", "o4"] },
  { id: "google", name: "Google", keyHint: "AIza…", models: ["Gemini 2.5 Pro", "Gemini 2.5 Flash"] },
];
const seedKeys = { anthropic: "sk-ant-••••••••3f2a", openai: "", google: "" };
const COMPETITIONS = [
  { id: "wc2026", sport: "football", name: "ЧМ-2026", matches: ["m-upcoming", "m-lineup", "m-live", "m-finished"] },
  { id: "ucl", sport: "football", name: "Лига чемпионов", matches: ["m-ucl-live"] },
  { id: "youth", sport: "football", name: "Юниоры U-20", matches: [] },
  { id: "atp", sport: "tennis", name: "ATP Masters", matches: ["m-tennis"] },
];

// Аналитические промты: базовый на спорт + переопределения на турнир
const seedAnalysis = {
  modelBySport: { football: "Claude Opus 4.8", tennis: "Claude Sonnet 5" },
  bySport: {
    football: `Оцени матч объективно. Учитывай: силу составов (после объявления — приоритет), территориальное преимущество, xG-ожидания, форму, мотивацию, тактические установки (низкий/высокий блок), H2H.
Дай вероятности исходов (П1/Х/П2), тоталов и ключевых рынков. Отметь сюжет: что вероятно произойдёт и почему.
Выдай две версии: развёрнутую (для движка) и краткое саммари (2-3 предложения для человека).`,
    tennis: `Оцени матч объективно. Учитывай: покрытие и его соответствие стилю игроков, текущую форму, физическую готовность, H2H, усталость от предыдущих раундов.
Дай вероятность победы каждого игрока и ключевых рынков (тоталы геймов/сетов). Краткое саммари + развёрнутая версия.`,
  },
  byComp: {
    // переопределение для юниоров: меньше данных, выше роль индивидуального класса
    youth: `Юниорский футбол: статистики и xG мало, выше дисперсия. Опирайся на индивидуальный класс отдельных игроков, глубину состава и физическую готовность больше, чем на командные метрики. Будь осторожнее с уверенностью — помечай её ниже, чем во взрослом футболе.`,
  },
};

const seedCatalog = [
  { id: "edge", name: "Edge Tiered", tag: "лесенка", color: "#e8a838", version: 1, sport: "football", model: "Claude Opus 4.8",
    prompt: `Входи ТОЛЬКО при уверенности «высокая» и когда рынок не впитал информацию.
Размер по лесенке: edge>=10% -> 20%; 7-10% -> 15%; 5-7% -> 10%; 3-5% -> 5%.
Можно несколько ставок на матч. Переоценка на голах.
Ограничители: не более 20% на ставку, стоп -25%.`,
    params: { tiers: [[10,0.20],[7,0.15],[5,0.10],[3,0.05]], maxPerBet: 0.20, stop: -0.25 } },
  { id: "flat", name: "Flat", tag: "фикс 5%", color: "#5b9bd5", version: 1, sport: "football", model: "Claude Haiku 4.5",
    prompt: `Входи на любой edge >= 3%. Размер всегда 5%. Выход по финалу.
Ограничители: не более 5% на ставку.`,
    params: { flatSize: 0.05, minEdge: 3, maxPerBet: 0.05 } },
  { id: "kelly", name: "Kelly \u00bd", tag: "half-kelly", color: "#70b56a", version: 1, sport: "football", model: "Claude Sonnet 5",
    prompt: `Входи при edge >= 2%. Размер = 0.5*edge/(odds-1), максимум 25%.
Переоценка на голах. Ограничители: не более 25% на ставку, стоп -30%.`,
    params: { kellyFraction: 0.5, cap: 0.25, minEdge: 2, maxPerBet: 0.25, stop: -0.30 } },
  { id: "tn1", name: "Serve Edge", tag: "теннис", color: "#c98bdb", version: 1, sport: "tennis", model: "Claude Sonnet 5",
    prompt: `Входи при edge >= 4% и преимуществе на покрытии. Размер 8%. Переоценка после сета.
Ограничители: не более 10% на ставку.`,
    params: { flatSize: 0.08, minEdge: 4, maxPerBet: 0.10 } },
];

// Бюджет турнира ($) + доли стратегий (%)
const seedCompBudget = { wc2026: 1500, ucl: 400, youth: 0, atp: 400 };
const seedShares = {
  wc2026: { edge: 50, kelly: 30, flat: 20 },
  ucl: { flat: 100 },
  atp: { tn1: 100 },
};

const MATCH_DB = {
  "m-upcoming": { home: "Испания", away: "Германия", state: "upcoming", kickoff: "через 4 ч 20 мин", lineupOut: false,
    preLineup: { confidence: "низкая", short: "Близкий класс. Решает опорник Испании. Входов пока нет.", text: "Команды близкого класса. Ключевой фактор — опорник Испании: без него П1 переоценена. Рынок даёт П1 ~46%, оцениваю чуть ниже.", verdict: "Ждать состав." },
    postLineup: null,
    markets: [{ id: "u1", label: "П1 Испания", odds: 2.15, aiProb: 0.44 }, { id: "u2", label: "Ничья", odds: 3.30, aiProb: 0.28 }, { id: "u3", label: "П2 Германия", odds: 3.60, aiProb: 0.28 }],
    bets: { edge: [], flat: [], kelly: [] } },
  "m-lineup": { home: "Португалия", away: "Хорватия", state: "lineup", kickoff: "через 55 мин", lineupOut: true, oddsUpdated: "2 мин назад",
    preLineup: { confidence: "средняя", short: "Португалия фаворит выхода, зависит от ротации.", text: "До состава: Португалия фаворит по выходу, но многое зависит от ротации основы.", verdict: "Ждём состав." },
    postLineup: { confidence: "высокая", short: "Основа Португалии в старте, Хорватия осторожна. Team to Advance недооценён + ТМ 2.5.", text: "Основа Португалии в старте — созидание выше. Хорватия садится ниже. Жду контроль Португалии при умеренной результативности. Team to Advance (Португалия 72.5¢) выглядит справедливо, но есть край на Under 2.5 (46.8¢) из-за оборонительной установки и на Portugal -1.5 при раскрытии игры.", verdict: "Вход: Under 2.5 + точечно Portugal Advance." },
    // Polymarket-стиль: цены в центах (доля 0-1$), плюс ликвидность
    markets: [
      { id: "adv", label: "Team to Advance — Португалия", price: 72.5, aiProb: 0.70, liq: "1.1M" },
      { id: "ou25u", label: "Under 2.5", price: 46.8, aiProb: 0.55, liq: "2.5M" },
      { id: "ou25o", label: "Over 2.5", price: 53.5, aiProb: 0.45, liq: "2.5M" },
      { id: "btts", label: "Both Teams to Score — Yes", price: 58, aiProb: 0.52, liq: "978K" },
      { id: "p15", label: "Portugal -1.5", price: 32.8, aiProb: 0.30, liq: "663K" },
      { id: "ou15o", label: "Over 1.5", price: 79, aiProb: 0.80, liq: "153K" },
      { id: "1hou05", label: "1st Half Over 0.5", price: 69, aiProb: 0.72, liq: "61K" },
      { id: "ou35o", label: "Over 3.5", price: 30.8, aiProb: 0.26, liq: "399K" },
    ],
    bets: {
      edge: { rationale: "Состав вышел, рынок не впитал силу основы Португалии. Вижу два независимых края: Under 2.5 (Хорватия садится глубоко) и выход Португалии. Беру оба — по лесенке от размера края.", items: [{ market: "Under 2.5", price: 46.8, aiProb: 0.55, pct: 0.15, status: "proposed" }, { market: "Portugal Advance", price: 72.5, aiProb: 0.70, pct: 0.08, status: "proposed" }] },
      flat: { rationale: "Edge на Under 2.5 положительный, выше моего порога 3%. Вхожу фиксированным размером 5%, без разбора величины края — такова дисциплина Flat.", items: [{ market: "Under 2.5", price: 46.8, aiProb: 0.55, pct: 0.05, status: "proposed" }] },
      kelly: { rationale: "Under 2.5 даёт край выше 2% — порог Kelly пройден. Размер по половине Келли: край умеренный, поэтому и ставка скромная.", items: [{ market: "Under 2.5", price: 46.8, aiProb: 0.55, pct: 0.12, status: "proposed" }] },
    },
    reassessByStrat: {
      edge: [{ min: "-55'", text: "Состав вышел. Основа Португалии — созидание растёт, но Хорватия садится глубоко. Вижу край на Under 2.5 (модель 55% против рыночных 53.2%) и на выход Португалии. Готовлю два входа.", conf: "высокая" }],
      flat: [{ min: "-55'", text: "Edge на Under 2.5 положительный (+1.8%), выше порога 3%? Нет — на границе. Вхожу минимальным размером по правилу фикс-5%.", conf: "средняя" }],
      kelly: [{ min: "-55'", text: "Under 2.5: edge мал, но Kelly допускает вход от 2%. Размер скромный из-за низкого края.", conf: "средняя" }],
    } },
  "m-live": { home: "Бразилия", away: "Англия", state: "live", minute: 63, lineupOut: true, scoreHome: 1, scoreAway: 0, oddsUpdated: "18 сек назад",
    preLineup: { confidence: "средняя", short: "Бразилия умеренный фаворит.", text: "До состава Бразилия умеренный фаворит.", verdict: "Ждать состав." },
    postLineup: { confidence: "высокая", short: "Бразилия ведёт. Advance-цена выросла 55¢->78¢.", text: "Бразилия повела и контролирует. Цена выхода: 55¢ -> 78¢. По Edge частично фиксировать; Kelly держит.", verdict: "Edge — фиксация. Flat/Kelly держат." },
    markets: [
      { id: "adv", label: "Team to Advance — Бразилия", price: 78, aiProb: 0.82, liq: "1.2M" },
      { id: "ou15o", label: "Over 1.5", price: 62, aiProb: 0.66, liq: "154K" },
      { id: "btts", label: "Both Teams to Score — Yes", price: 41, aiProb: 0.36, liq: "500K" },
      { id: "ou25u", label: "Under 2.5", price: 55, aiProb: 0.60, liq: "800K" },
      { id: "b25", label: "Brazil -1.5", price: 44, aiProb: 0.40, liq: "200K" },
    ],
    bets: {
      edge: { rationale: "Вошёл до матча по составу. После гола край на Advance сузился — фиксирую половину (см. Переоценки), но Over 1.5 добавил по ходу: игра раскрылась, вероятность второго гола выросла.", items: [{ market: "Advance Бразилия", price: 78, aiProb: 0.82, stake: 112, entryPrice: 55, currentPrice: 78, status: "open", entered: "3'" }, { market: "Over 1.5", price: 62, aiProb: 0.66, stake: 60, entryPrice: 50, currentPrice: 62, status: "open", entered: "20' (добавлено)" }] },
      flat: { rationale: "Одна ставка фиксированным размером на входе. Переоценок не делаю — держу Advance до финала по дисциплине Flat.", items: [{ market: "Advance Бразилия", price: 78, aiProb: 0.82, stake: 15, entryPrice: 55, currentPrice: 78, status: "open", entered: "3'" }] },
      kelly: { rationale: "Вход по Kelly на старте. Держу, не добавляю: цена уже впитала часть эджа после гола, новых входов правило не даёт.", items: [{ market: "Advance Бразилия", price: 78, aiProb: 0.82, stake: 63, entryPrice: 55, currentPrice: 78, status: "open", entered: "3'" }] },
    },
    reassessByStrat: {
      edge: [
        { min: "41'", text: "Гол Бразилии 1:0. Цена выхода прыгнула 55¢->70¢. Позиция в хорошем плюсе, но модель всё ещё видит апсайд до 82%. Держу основную, добавляю Over 1.5 — игра раскроется.", conf: "высокая" },
        { min: "63'", text: "Цена дошла до 78¢, край сузился до ~4%. По правилу лесенки при edge<3% фиксирую половину Advance-позиции, хвост оставляю. Over 1.5 держу — там край ещё есть.", conf: "высокая" },
      ],
      flat: [{ min: "41'", text: "Гол. По правилу Flat переоценку не делаю — держу до финала независимо от движения цены.", conf: "—" }],
      kelly: [{ min: "41'", text: "Гол 1:0. Kelly-размер уже отработал, остаточный край сохраняется (модель 82% против 70¢). Держу, не добавляю — цена уже впитала часть эджа.", conf: "высокая" }],
    },
    logByStrat: { edge: [{ min: "3'", text: "Вход Advance @ 55¢ — $112", type: "enter" }, { min: "20'", text: "Добавлено Over 1.5 @ 50¢ — $60", type: "enter" }, { min: "63'", text: "Фиксация 50% Advance @ 78¢", type: "exit" }], flat: [{ min: "3'", text: "Вход Advance @ 55¢ — $15", type: "enter" }], kelly: [{ min: "3'", text: "Вход Advance @ 55¢ — $63", type: "enter" }] } },
  "m-finished": { home: "Франция", away: "Португалия", state: "finished", scoreHome: 2, scoreAway: 1, lineupOut: true,
    preLineup: { confidence: "средняя", short: "Франция небольшой фаворит.", text: "До состава Франция небольшой фаворит.", verdict: "Ждать состав." },
    postLineup: { confidence: "высокая", short: "Франция сильнее территориально.", text: "Франция реализовала перевес, 2-й гол — из недооценённого сценария.", verdict: "Вход Advance Франция." },
    markets: [], result: { edge: 126.0, flat: 8.2, kelly: 54.5 },
    finalScore: "2:1", settled: true, kickoffTime: "13:00", endTime: "14:52", duration: "1 ч 52 мин", endNote: "основное время",
    settledBets: {
      edge: [{ market: "Advance Франция", stake: 100, result: "won", payout: 182 }, { market: "Under 2.5", stake: 60, result: "won", payout: 104 }],
      flat: [{ market: "Advance Франция", stake: 50, result: "won", payout: 58.2 }],
      kelly: [{ market: "Advance Франция", stake: 95, result: "won", payout: 149.5 }],
    },
    conclusion: { text: "Edge выиграл за счёт мультиставки (Advance + Under обе сыграли). ROI: Edge +16.8%, Flat +4.1%, Kelly +12.1%.", lesson: "Мультиставка усиливает Edge при коррелированных краях. Применять после 20+ матчей." },
    reassessByStrat: {
      edge: [{ min: "28'", text: "Гол Франции 1:0. Advance-цена выросла, но модель видит апсайд. Держу, Under 2.5 тоже в игре.", conf: "высокая" }, { min: "67'", text: "Португалия 1:1. Край на Under сузился, фиксирую половину Under-позиции, Advance держу.", conf: "средняя" }, { min: "81'", text: "Гол Франции 2:1 (стандарт). Advance почти реализован, доводим до финала.", conf: "высокая" }],
      flat: [{ min: "финал", text: "Держал до конца по правилу. Advance сыграл.", conf: "—" }],
      kelly: [{ min: "28'", text: "Гол. Держу, край сохраняется.", conf: "высокая" }],
    },
    logByStrat: { edge: [{ min: "3'", text: "Вход Advance + Under", type: "enter" }, { min: "67'", text: "Фиксация 50% Under", type: "exit" }, { min: "финал", text: "+$126", type: "settle" }], flat: [{ min: "3'", text: "Вход Advance", type: "enter" }, { min: "финал", text: "+$8.20", type: "settle" }], kelly: [{ min: "3'", text: "Вход Advance", type: "enter" }, { min: "финал", text: "+$54.50", type: "settle" }] } },
  "m-ucl-live": { home: "Реал", away: "Ман Сити", state: "live", minute: 28, lineupOut: true, scoreHome: 0, scoreAway: 0,
    preLineup: { confidence: "средняя", short: "Равный топ-матч.", text: "До состава — равный топ-матч.", verdict: "Ждать состав." },
    postLineup: { confidence: "высокая", short: "Сити контролит, край на ТМ 2.5.", text: "Оба состава основные. Низкая результативность вероятна. ТМ 2.5 даёт край.", verdict: "Вход на ТМ 2.5." },
    markets: [{ id: "c1", label: "ТМ 2.5", odds: 1.90, aiProb: 0.58 }],
    bets: { flat: [{ market: "ТМ 2.5", odds: 1.90, aiProb: 0.58, stake: 20, entryOdds: 2.05, currentOdds: 1.90, status: "open" }] },
    logByStrat: { flat: [{ min: "1'", text: "Вход ТМ2.5 @ 2.05 — $20", type: "enter" }] } },
  "m-tennis": { home: "Алькарас", away: "Синнер", state: "lineup", kickoff: "через 30 мин", lineupOut: true,
    preLineup: { confidence: "высокая", short: "Оба здоровы, хард.", text: "Готовность/покрытие: оба здоровы, хард.", verdict: "Оценка готова." },
    postLineup: { confidence: "высокая", short: "Алькарас лучше на быстром харде.", text: "Алькарас лучше на быстром харде, Синнер стабильнее на приёме. Рынок близок к справедливому.", verdict: "Малый вход П1." },
    markets: [{ id: "t1", label: "П1 Алькарас", odds: 1.75, aiProb: 0.60 }],
    bets: { tn1: [{ market: "П1 Алькарас", odds: 1.75, aiProb: 0.60, pct: 0.08, status: "proposed" }] } },
};

const STATE_META = {
  upcoming: { label: "СКОРО", color: "#8b95a5", bg: "#232a35" },
  lineup: { label: "СОСТАВ", color: "#e8a838", bg: "#2e2a1a" },
  live: { label: "LIVE", color: "#ff6b6b", bg: "#2e1f22" },
  finished: { label: "ЗАВЕРШЁН", color: "#70b56a", bg: "#1f2a22" },
};
const FAKE_STATS = {
  edge: { matches: 24, roi: 16.8, wins: 15, losses: 9, note: "Сильна при edge>=8% и на мультиставках." },
  flat: { matches: 24, roi: 4.1, wins: 14, losses: 10, note: "Стабильна, недобирает при большом крае." },
  kelly: { matches: 18, roi: 12.1, wins: 11, losses: 7, note: "Близка к Edge. Нет частичной фиксации." },
};
const PALETTE = ["#e8a838", "#5b9bd5", "#70b56a", "#c98bdb", "#e07a5f", "#4fc3c7"];

// Глобальная лента событий — хронология по всем матчам/стратегиям
const EVENT_FEED = [
  { t: "14:41", type: "settle", sport: "Футбол", match: "Франция–Португалия", strat: "Edge Tiered", color: "#e8a838", text: "Расчёт: Advance + Under сыграли. +$126 (ROI +16.8%)", pnl: 126 },
  { t: "14:41", type: "settle", sport: "Футбол", match: "Франция–Португалия", strat: "Kelly ½", color: "#70b56a", text: "Расчёт: Advance сыграл. +$54.50 (ROI +12.1%)", pnl: 54.5 },
  { t: "14:41", type: "settle", sport: "Футбол", match: "Франция–Португалия", strat: "Flat", color: "#5b9bd5", text: "Расчёт: Advance сыграл. +$8.20 (ROI +4.1%)", pnl: 8.2 },
  { t: "14:38", type: "goal", sport: "Футбол", match: "Бразилия–Англия", text: "⚽ Гол Бразилии — 1:0 (63')" },
  { t: "14:38", type: "reassess", sport: "Футбол", match: "Бразилия–Англия", strat: "Edge Tiered", color: "#e8a838", text: "Переоценка: край сузился до 4%, рекомендация — фиксировать половину Advance" },
  { t: "14:35", type: "enter", sport: "Футбол", match: "Реал–Ман Сити", strat: "Flat", color: "#5b9bd5", text: "Вход: Under 2.5 @ 55¢ — $20" },
  { t: "14:32", type: "enter", sport: "Футбол", match: "Бразилия–Англия", strat: "Edge Tiered", color: "#e8a838", text: "Добавлено: Over 1.5 @ 50¢ — $60 (мультиставка)" },
  { t: "14:20", type: "lineup", sport: "Футбол", match: "Португалия–Хорватия", text: "📋 Составы объявлены — оценка обновлена (приоритетная)" },
  { t: "14:18", type: "enter", sport: "Футбол", match: "Бразилия–Англия", strat: "Kelly ½", color: "#70b56a", text: "Вход: Advance @ 55¢ — $63" },
  { t: "14:15", type: "skip", sport: "Теннис", match: "Алькарас–Синнер", strat: "Serve Edge", text: "Пропуск: край недостаточен (+1.2%), вход не оправдан" },
];

// Метрики качества стратегий (калибровка, CLV, Brier)
const QUALITY = {
  edge:  { brier: 0.182, clv: 3.4, calib: [{ bucket: "50-60%", predicted: 55, actual: 53 }, { bucket: "60-70%", predicted: 65, actual: 67 }, { bucket: "70-80%", predicted: 75, actual: 72 }, { bucket: "80%+", predicted: 85, actual: 88 }], samples: 24 },
  flat:  { brier: 0.213, clv: 0.8, calib: [{ bucket: "50-60%", predicted: 55, actual: 51 }, { bucket: "60-70%", predicted: 65, actual: 64 }, { bucket: "70-80%", predicted: 75, actual: 70 }, { bucket: "80%+", predicted: 85, actual: 79 }], samples: 24 },
  kelly: { brier: 0.195, clv: 2.1, calib: [{ bucket: "50-60%", predicted: 55, actual: 56 }, { bucket: "60-70%", predicted: 65, actual: 63 }, { bucket: "70-80%", predicted: 75, actual: 74 }, { bucket: "80%+", predicted: 85, actual: 83 }], samples: 18 },
  tn1:   { brier: 0.24, clv: -0.5, calib: [{ bucket: "50-60%", predicted: 55, actual: 52 }, { bucket: "60-70%", predicted: 65, actual: 61 }], samples: 6 },
};
const impliedProb = (o) => (o > 1 ? 1 / o : 0);
const fmtMoney = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
const fmtMoney0 = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(0);

// $ бюджет стратегии = бюджет турнира * доля%
function stratBudget(compBudget, compId, shares, stratId) {
  const pct = shares[compId]?.[stratId] || 0;
  return Math.round((compBudget[compId] || 0) * pct / 100);
}
// Нормализует bets к массиву позиций (поддержка старого плоского и нового {rationale, items})
function betItems(raw) {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : (raw.items || []);
}
// Человекочитаемое описание распознанного порога
function describeParam(k, v) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  switch (k) {
    case "maxPerBet": return { label: "макс. на одну ставку", value: pct(v) };
    case "stop": return { label: "стоп-лосс портфеля", value: `${Math.round(v * 100)}%` };
    case "minEdge": return { label: "мин. край для входа", value: `${v}%` };
    case "flatSize": return { label: "фикс. размер ставки", value: pct(v) };
    case "kellyFraction": return { label: "доля Келли", value: `${v}×` };
    case "cap": return { label: "потолок размера", value: pct(v) };
    case "minConfidence": return { label: "мин. уверенность", value: v === "high" ? "высокая" : String(v) };
    case "tiers": return { label: "лесенка размеров (край → доля)", value: (Array.isArray(v) ? v.map(([e, s]) => `≥${e}% → ${Math.round(s * 100)}%`).join(",  ") : String(v)) };
    case "note": return { label: "примечание", value: String(v) };
    default: return { label: k, value: Array.isArray(v) ? JSON.stringify(v) : String(v) };
  }
}
function stratEquityOnComp(comp, stratId, budget) {
  let realized = 0, unreal = 0;
  for (const mid of comp.matches) {
    const m = MATCH_DB[mid];
    if (m.state === "finished" && m.result?.[stratId] != null) realized += m.result[stratId];
    for (const b of betItems(m.bets?.[stratId])) {
      if (b.status === "open") {
        // цена в центах = вероятность*100. P&L = stake * (текущая/вход - 1)
        if (b.currentPrice != null && b.entryPrice != null) unreal += b.stake * (b.currentPrice / b.entryPrice) - b.stake;
        else if (b.currentOdds != null && b.entryOdds != null) unreal += b.stake * (impliedProb(b.entryOdds) / impliedProb(b.currentOdds)) - b.stake;
      }
    }
  }
  return { equity: budget + realized + unreal, realized, unreal };
}

// Общая доходность стратегии = средний ROI по турнирам, где у неё есть бюджет.
// Плюс суммарно заработано/потеряно в $ по всем турнирам.
function stratOverall(stratId, sportId, compBudget, shares) {
  const comps = COMPETITIONS.filter((c) => c.sport === sportId);
  let sumPnl = 0, sumBudget = 0, roiList = [];
  for (const c of comps) {
    const pct = shares[c.id]?.[stratId] || 0;
    if (pct <= 0 || (compBudget[c.id] || 0) <= 0) continue;
    const budget = Math.round((compBudget[c.id]) * pct / 100);
    const e = stratEquityOnComp(c, stratId, budget);
    const pnl = e.equity - budget;
    sumPnl += pnl;
    sumBudget += budget;
    if (budget > 0) roiList.push((pnl / budget) * 100);
  }
  const avgRoi = roiList.length ? roiList.reduce((a, b) => a + b, 0) / roiList.length : 0;
  return { avgRoi, pnl: sumPnl, budget: sumBudget, active: roiList.length };
}

// Все ОТКРЫТЫЕ позиции по всем спортам/турнирам/стратегиям — для экрана Портфель
function collectPortfolio(catalog, compBudget, shares) {
  const positions = [];
  for (const comp of COMPETITIONS) {
    for (const mid of comp.matches) {
      const m = MATCH_DB[mid];
      if (m.state !== "live") continue;
      for (const st of catalog) {
        if (st.sport !== comp.sport) continue;
        if ((shares[comp.id]?.[st.id] || 0) <= 0 || (compBudget[comp.id] || 0) <= 0) continue;
        const budget = Math.round(compBudget[comp.id] * shares[comp.id][st.id] / 100);
        for (const b of betItems(m.bets?.[st.id])) {
          if (b.status !== "open") continue;
          const live = b.currentPrice != null && b.entryPrice != null ? b.stake * (b.currentPrice / b.entryPrice) - b.stake : 0;
          positions.push({
            sport: comp.sport, compName: comp.name, compId: comp.id,
            match: `${m.home}–${m.away}`, minute: m.minute,
            strat: st.name, stratColor: st.color, stratId: st.id,
            market: b.market, stake: b.stake, entryPrice: b.entryPrice, currentPrice: b.currentPrice,
            live, entered: b.entered,
          });
        }
      }
    }
  }
  return positions;
}

export default function EdgeLabV9() {
  const [screen, setScreen] = useState("matches");
  const [catalog, setCatalog] = useState(seedCatalog);
  const [compBudget, setCompBudget] = useState(seedCompBudget);
  const [shares, setShares] = useState(seedShares);
  const [analysis, setAnalysis] = useState(seedAnalysis);
  const [apiKeys, setApiKeys] = useState(seedKeys);
  const TOTAL_BALANCE = 5000;
  const [sportId, setSportId] = useState("football");
  const sportComps = COMPETITIONS.filter((c) => c.sport === sportId);
  const [compId, setCompId] = useState(sportComps[0].id);
  const comp = COMPETITIONS.find((c) => c.id === compId) || sportComps[0];
  const [compModal, setCompModal] = useState(null); // compId — бюджет турнира
  const [shareModal, setShareModal] = useState(null); // compId — доли стратегий

  const onSport = (id) => { setSportId(id); setCompId(COMPETITIONS.find((c) => c.sport === id).id); };

  const allocatedSum = Object.values(compBudget).reduce((a, b) => a + b, 0);
  const freeBalance = TOTAL_BALANCE - allocatedSum;

  const setBudget = (cid, amt) => { setCompBudget((p) => ({ ...p, [cid]: amt })); setCompModal(null); };
  const saveShares = (cid, newShares) => { setShares((p) => ({ ...p, [cid]: newShares })); setShareModal(null); };

  const sportStrats = catalog.filter((s) => s.sport === sportId);
  const compStrats = sportStrats.filter((s) => (shares[comp.id]?.[s.id] || 0) > 0 && compBudget[comp.id] > 0);

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      <div style={S.treasury}>
        <div style={S.trBrand}><span style={S.mark}>&#9670;</span><span style={S.trBrandTxt}>EDGE LAB</span></div>
        <div style={S.trCell}><div style={S.trLbl}>Общий баланс</div><div style={S.trVal}>{fmtMoney0(TOTAL_BALANCE)}</div></div>
        <div style={S.trDiv} />
        <div style={S.trCell}><div style={S.trLbl}>Распределено</div><div style={{ ...S.trVal, color: "#e8a838" }}>{fmtMoney0(allocatedSum)}</div></div>
        <div style={S.trDiv} />
        <div style={S.trCell}><div style={S.trLbl}>Свободно</div><div style={{ ...S.trVal, color: freeBalance >= 0 ? "#5fd08a" : "#ff6b6b" }}>{fmtMoney0(freeBalance)}</div></div>
      </div>

      <div style={S.screenSwitch} className="el-screen-switch">
        {[["matches","Матчи"],["feed","Лента"],["portfolio","Портфель"],["metrics","Метрики"],["strategies","Стратегии"],["models","Модели"]].map(([k,lbl]) => (
          <button key={k} onClick={() => setScreen(k)} style={{ ...S.screenBtn, ...(screen === k ? S.screenOn : {}) }}>{lbl}</button>
        ))}
      </div>

      {(screen === "matches" || screen === "strategies") && (
        <nav style={S.sportTabs}>
          {SPORTS.map((s) => <button key={s.id} onClick={() => onSport(s.id)} style={{ ...S.sportTab, ...(sportId === s.id ? S.sportTabOn : {}) }}>{s.label}</button>)}
        </nav>
      )}

      {screen === "matches" ? (
        <>
          <div style={S.compRow}>
            {sportComps.map((c) => {
              const budget = compBudget[c.id] || 0;
              const cStrats = sportStrats.filter((s) => (shares[c.id]?.[s.id] || 0) > 0);
              const eq = cStrats.reduce((a, s) => a + stratEquityOnComp(c, s.id, stratBudget(compBudget, c.id, shares, s.id)).equity, 0);
              const delta = eq - budget;
              return (
                <div key={c.id} style={{ ...S.compCard, ...(c.id === comp.id ? S.compOn : {}) }}>
                  <button style={S.compMain} onClick={() => setCompId(c.id)}>
                    <div style={S.compName}>{c.name}</div>
                    {budget > 0 ? <>
                      <div style={S.compBudget}>{fmtMoney0(eq)} <span style={{ color: MUTE }}>из {fmtMoney0(budget)}</span></div>
                      <div style={{ ...S.compDelta, color: delta >= 0 ? "#5fd08a" : "#ff6b6b" }}>{delta >= 0 ? "+" : ""}{fmtMoney(delta)} <span style={S.compRoi}>({delta >= 0 ? "+" : ""}{((delta / budget) * 100).toFixed(1)}%)</span></div>
                    </> : <div style={S.compUnalloc}>{c.matches.length ? "нет бюджета" : "нет матчей"}</div>}
                  </button>
                  <button style={S.allocIcon} title="Бюджет турнира" onClick={() => setCompModal(c.id)}>$</button>
                </div>
              );
            })}
          </div>

          {/* Полоса стратегий турнира: % + $ + кнопка распределения долей */}
          <div style={S.stratStripHead}>
            <span style={S.stratStripTitle}>Стратегии на «{comp.name}»</span>
            {compBudget[comp.id] > 0 && <button style={S.shareBtn} onClick={() => setShareModal(comp.id)}>⚙ Распределить доли %</button>}
          </div>
          <div style={S.bankStrip}>
            {(compBudget[comp.id] || 0) === 0 && <div style={S.noStrat}>У «{comp.name}» нет бюджета. Нажми $ на плашке турнира.</div>}
            {compBudget[comp.id] > 0 && compStrats.length === 0 && <div style={S.noStrat}>Бюджет есть, но доли стратегий не заданы. Нажми «Распределить доли %».</div>}
            {compBudget[comp.id] > 0 && compStrats.map((st) => {
              const pct = shares[comp.id][st.id];
              const budget = stratBudget(compBudget, comp.id, shares, st.id);
              const e = stratEquityOnComp(comp, st.id, budget);
              const d = e.equity - budget;
              return (
                <div key={st.id} style={S.bankCell}>
                  <span style={{ ...S.dot, background: st.color }} />
                  <div style={S.bankInfo}><span style={S.bankNm}>{st.name}</span><span style={S.bankBudget}>{pct}% · {fmtMoney0(budget)}</span></div>
                  <div style={S.bankNums}><span style={S.bankEq}>{fmtMoney(e.equity)}</span><span style={{ ...S.bankD, color: d >= 0 ? "#5fd08a" : "#ff6b6b" }}>{d >= 0 ? "▲" : "▼"}{fmtMoney(d)} ({d >= 0 ? "+" : ""}{((d / budget) * 100).toFixed(1)}%)</span></div>
                </div>
              );
            })}
          </div>

          <main style={S.main}>
            {comp.matches.length === 0 && <div style={S.empty}>В этом турнире пока нет матчей.</div>}
            {comp.matches.map((mid) => <MatchCard key={mid} match={MATCH_DB[mid]} catalog={catalog} comp={comp} compBudget={compBudget} shares={shares} />)}
          </main>
        </>
      ) : screen === "strategies" ? (
        <StrategyScreen sportId={sportId} sportLabel={SPORTS.find((s) => s.id === sportId).label} catalog={catalog} setCatalog={setCatalog}
          compBudget={compBudget} shares={shares} apiKeys={apiKeys}
          analysis={analysis} setAnalysis={setAnalysis} onGoModels={() => setScreen("models")} />
      ) : screen === "portfolio" ? (
        <PortfolioScreen positions={collectPortfolio(catalog, compBudget, shares)} onGoMatches={() => setScreen("matches")} />
      ) : screen === "feed" ? (
        <FeedScreen />
      ) : screen === "metrics" ? (
        <MetricsScreen catalog={catalog} />
      ) : (
        <ModelsScreen apiKeys={apiKeys} setApiKeys={setApiKeys} />
      )}

      {compModal && <BudgetModal comp={COMPETITIONS.find((c) => c.id === compModal)} current={compBudget[compModal] || 0} free={freeBalance} onClose={() => setCompModal(null)} onSave={(amt) => setBudget(compModal, amt)} />}
      {shareModal && <SharesModal comp={COMPETITIONS.find((c) => c.id === shareModal)} strats={catalog.filter((s) => s.sport === COMPETITIONS.find((c) => c.id === shareModal).sport)} budget={compBudget[shareModal]} current={shares[shareModal] || {}} onClose={() => setShareModal(null)} onSave={(sh) => saveShares(shareModal, sh)} />}

      <footer style={S.footer}>
        Два уровня денег: казна→турнир ($), турнир→стратегии (%). Аналитический промт — на спорт, с переопределением на турнир. Стратегия = промт + мультиставки.
      </footer>
    </div>
  );
}

function MatchCard({ match, catalog, comp, compBudget, shares }) {
  const meta = STATE_META[match.state];
  const hasLog = match.state === "live" || match.state === "finished";
  const compStrats = catalog.filter((s) => s.sport === comp.sport && (shares[comp.id]?.[s.id] || 0) > 0 && compBudget[comp.id] > 0);
  const tabs = [];
  if (match.preLineup || match.postLineup) tabs.push({ id: "analysis", label: "Анализ" });
  tabs.push({ id: "strat", label: "Ставки стратегий" });
  if (match.reassessByStrat) tabs.push({ id: "reassess", label: "Переоценки" });
  if (match.settledBets) tabs.push({ id: "settle", label: "Расчёт" });
  if (hasLog) tabs.push({ id: "log", label: "Лог" });
  if (match.conclusion) tabs.push({ id: "concl", label: "Вывод" });
  const defaultTab = match.state === "finished" ? "concl" : (match.preLineup || match.postLineup) ? "analysis" : "strat";
  const [tab, setTab] = useState(defaultTab);
  const [logStrat, setLogStrat] = useState(compStrats[0]?.id);

  return (
    <section style={{ ...S.card, borderColor: meta.color + "55" }}>
      <div style={S.cardHead}>
        <div>
          <div style={S.matchup}>{match.home}{match.state === "live" || match.state === "finished" ? <span style={S.score}> {match.scoreHome}:{match.scoreAway} </span> : <span style={S.vs}> — </span>}{match.away}</div>
          <div style={S.timing}>{(match.state === "upcoming" || match.state === "lineup") && match.kickoff}{match.state === "live" && `LIVE · ${match.minute}'`}{match.state === "finished" && (match.endTime ? `завершён ${match.endTime}` : "финал")}{"  ·  "}<span style={{ color: match.lineupOut ? "#70b56a" : "#8b95a5" }}>{match.lineupOut ? "✓ состав" : "○ без состава"}</span></div>
          {match.state === "finished" && match.duration && <div style={S.finishTiming}>{match.kickoffTime}–{match.endTime} · длительность {match.duration}{match.endNote && ` · ${match.endNote}`}</div>}
        </div>
        <div style={{ ...S.stateBadge, background: meta.bg, color: meta.color }}>{match.state === "live" && <span style={S.pulse} />}{meta.label}</div>
      </div>

      {/* итоги показываются в правой колонке */}

      <div style={S.matchBody} className="el-match-body">
        <div style={S.matchLeft}>
          <div style={S.tabBar} className="el-tab-buttons">{tabs.map((t) => <button key={t.id} onClick={() => setTab(t.id)} style={{ ...S.tabBtn, ...(tab === t.id ? S.tabBtnOn : {}) }}>{t.label}</button>)}</div>
          <select style={S.tabSelect} className="el-tab-select" value={tab} onChange={(e) => setTab(e.target.value)}>
            {tabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <div style={S.tabBody}>
        {tab === "analysis" && (
          <div style={S.analysisFlow}>
            {match.preLineup && (
              <div style={S.analysisStage}>
                <div style={S.analysisStageLabel}><span style={S.stageNum}>1</span> До состава</div>
                <Assessment a={match.preLineup} priority={false} />
              </div>
            )}
            {match.postLineup && (
              <div style={S.analysisStage}>
                <div style={S.analysisStageLabel}><span style={{ ...S.stageNum, background: "#e8a838", color: "#12161d" }}>2</span> После состава <span style={S.stagePriority}>приоритетная</span></div>
                <Assessment a={match.postLineup} priority={true} />
              </div>
            )}
            {!match.postLineup && <div style={S.analysisPending}>Оценка после состава появится, когда объявят составы.</div>}
            {compStrats.length > 0 && compStrats.some((st) => { const r = match.bets?.[st.id]; return r && !Array.isArray(r) && r.rationale; }) && (
              <div style={S.analysisStage}>
                <div style={S.analysisStageLabel}><span style={{ ...S.stageNum, background: "#5b9bd5", color: "#12161d" }}>3</span> Решения стратегий</div>
                <div style={S.decisionList}>
                  {compStrats.map((st) => {
                    const raw = match.bets?.[st.id];
                    const rationale = raw && !Array.isArray(raw) ? raw.rationale : null;
                    const items = betItems(raw);
                    return (
                      <div key={st.id} style={S.decisionItem}>
                        <div style={S.decisionHead}>
                          <span style={{ ...S.dot, background: st.color }} />
                          <span style={S.decisionName}>{st.name}</span>
                          <span style={S.decisionVerdict}>{items.length === 0 ? "пропуск" : `${items.length} ${items.length === 1 ? "ставка" : "ставки"}`}</span>
                        </div>
                        <p style={S.decisionText}>{rationale || (items.length === 0 ? "Край недостаточен — стратегия воздерживается от входа." : "—")}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
        {tab === "strat" && (
          <div style={S.stratListGrid} className="el-strat-grid">
            {compStrats.length === 0 && <div style={S.noPos}>Нет стратегий с долей на этом турнире.</div>}
            {compStrats.map((st) => {
              const budget = stratBudget(compBudget, comp.id, shares, st.id);
              const raw = match.bets?.[st.id];
              // нормализация: старый формат — массив; новый — {rationale, items}
              const betData = Array.isArray(raw) ? { rationale: null, items: raw } : (raw || { rationale: null, items: [] });
              const items = betData.items || [];
              return (
                <div key={st.id} style={S.stratBlock}>
                  <div style={S.stratBlockHead}><span style={{ ...S.dot, background: st.color }} /><span style={S.stratName}>{st.name}</span><span style={S.stratBudgetChip}>{shares[comp.id][st.id]}% · {fmtMoney0(budget)}</span></div>
                  {items.length === 0 ? <div style={S.noBets}>ставок нет — край недостаточен, стратегия пропускает матч</div> : (
                    <div style={S.betList}>
                      {items.map((b, i) => {
                        const impl = b.price != null ? b.price / 100 : impliedProb(b.odds);
                        const edge = (b.aiProb - impl) * 100;
                        const stake = b.stake != null ? b.stake : Math.round(budget * (b.pct || 0));
                        const isOpen = b.status === "open";
                        const live = isOpen && b.currentPrice != null && b.entryPrice != null ? b.stake * (b.currentPrice / b.entryPrice) - b.stake : null;
                        const entryDisp = b.entryPrice != null ? `${b.entryPrice}¢` : (b.price != null ? `${b.price}¢` : (b.odds || "").toString());
                        return (
                          <div key={i} style={S.betRow}>
                            <div style={S.betMain}><span style={S.betMarket}>{b.market}</span><span style={S.betOdds}>@ {entryDisp}</span></div>
                            <div style={S.betMeta}>
                              <span style={{ ...S.betEdge, color: edge >= 5 ? "#5fd08a" : edge >= 3 ? "#e8a838" : "#9aa4b2" }}>edge {edge >= 0 ? "+" : ""}{edge.toFixed(1)}%</span>
                              <span style={S.betStake}>{fmtMoney(stake)}</span>
                              {isOpen && live != null && <span style={{ ...S.betLive, color: live >= 0 ? "#5fd08a" : "#ff6b6b" }}>{live >= 0 ? "▲" : "▼"}{fmtMoney(live)}</span>}
                              {b.status === "proposed" && <span style={S.betProposed}>предлагается</span>}
                            </div>
                            {b.entered && <div style={S.betEntered}>вход: {b.entered}</div>}
                          </div>
                        );
                      })}
                      <div style={S.betTotal}>задействовано {fmtMoney(items.reduce((a, b) => a + (b.stake != null ? b.stake : Math.round(budget * (b.pct || 0))), 0))} из {fmtMoney0(budget)}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {tab === "reassess" && match.reassessByStrat && (
          <div>
            <div style={S.reassessTop}>
              <span style={S.reassessHint}>Развёрнутые переоценки ИИ по ходу матча (в отличие от сухого лога сделок).</span>
              {match.state === "live" && <button style={S.reassessBtn}>↻ Сделать переоценку</button>}
            </div>
            <div style={S.logStratBar}>{compStrats.map((st) => <button key={st.id} onClick={() => setLogStrat(st.id)} style={{ ...S.logStratBtn, ...(logStrat === st.id ? { background: st.color + "22", color: st.color, borderColor: st.color + "66" } : {}) }}>{st.name}</button>)}</div>
            <div style={S.reassessList}>
              {(match.reassessByStrat?.[logStrat] || []).length === 0 && <div style={S.noPos}>переоценок пока нет</div>}
              {(match.reassessByStrat?.[logStrat] || []).map((r, i) => (
                <div key={i} style={S.reassessItem}>
                  <div style={S.reassessItemHead}><span style={S.reassessMin}>{r.min}</span>{r.conf && r.conf !== "—" && <span style={S.reassessConf}>уверенность: {r.conf}</span>}</div>
                  <p style={S.reassessText}>{r.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === "settle" && match.settledBets && (
          <div>
            <div style={S.settleHead}>Финальный счёт <b style={{ color: "#e8a838" }}>{match.finalScore}</b> — ставки рассчитаны</div>
            {compStrats.filter((st) => match.settledBets[st.id]).map((st) => (
              <div key={st.id} style={S.settleStrat}>
                <div style={S.settleStratHead}><span style={{ ...S.dot, background: st.color }} /><span style={S.stratName}>{st.name}</span></div>
                {match.settledBets[st.id].map((b, i) => (
                  <div key={i} style={S.settleBet}>
                    <span style={S.settleMarket}>{b.market}</span>
                    <span style={S.settleStake}>{fmtMoney(b.stake)}</span>
                    <span style={{ ...S.settleResult, color: b.result === "won" ? "#5fd08a" : "#ff6b6b" }}>{b.result === "won" ? "✓ выиграла" : "✕ проиграла"}</span>
                    <span style={{ ...S.settlePayout, color: b.result === "won" ? "#5fd08a" : "#ff6b6b" }}>{b.result === "won" ? `→ ${fmtMoney(b.payout)}` : "→ $0"}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {tab === "log" && hasLog && (
          <div>
            <div style={S.logStratBar}>{compStrats.map((st) => <button key={st.id} onClick={() => setLogStrat(st.id)} style={{ ...S.logStratBtn, ...(logStrat === st.id ? { background: st.color + "22", color: st.color, borderColor: st.color + "66" } : {}) }}>{st.name}</button>)}</div>
            <div style={S.logList}>
              {(match.logByStrat?.[logStrat] || []).length === 0 && <div style={S.noPos}>действий пока нет</div>}
              {(match.logByStrat?.[logStrat] || []).map((e, i) => <div key={i} style={S.logEntry}><span style={S.logMin}>{e.min}</span><span style={{ ...S.logType, ...logTypeStyle(e.type) }}>{e.type}</span><span style={S.logText}>{e.text}</span></div>)}
            </div>
          </div>
        )}
        {tab === "concl" && match.conclusion && <div><p style={S.conclText}>{match.conclusion.text}</p><div style={S.lesson}><span style={S.lessonTag}>урок → стратегия</span>{match.conclusion.lesson}</div></div>}
          </div>
        </div>

        {match.state === "finished" ? (
          <aside style={S.oddsCol} className="el-odds-col">
            <div style={S.oddsColLabel}>Итог стратегий</div>
            <div style={S.oddsColSub}>как отработала каждая</div>
            <div style={S.oddsScroll}>
              {compStrats.filter((st) => match.result?.[st.id] != null).map((st) => {
                const budget = stratBudget(compBudget, comp.id, shares, st.id);
                const roi = budget ? (match.result[st.id] / budget) * 100 : 0;
                return (
                  <div key={st.id} style={S.finishCell}>
                    <div style={S.finishTop}><span style={{ ...S.dot, background: st.color }} /><span style={S.finishNm}>{st.name}</span></div>
                    <div style={{ ...S.finishVal, color: match.result[st.id] >= 0 ? "#5fd08a" : "#ff6b6b" }}>{fmtMoney(match.result[st.id])}</div>
                    <div style={{ ...S.finishRoi, color: roi >= 0 ? "#5fd08a" : "#ff6b6b" }}>ROI {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%</div>
                  </div>
                );
              })}
            </div>
          </aside>
        ) : match.markets && match.markets.length > 0 && (
          <aside style={S.oddsCol} className="el-odds-col">
            <div style={S.oddsColHead}>
              <div><div style={S.oddsColLabel}>Котировки</div><div style={S.oddsColSub}>Polymarket · цена в ¢</div></div>
              <button style={S.oddsRefresh} title="Обновить котировки">↻</button>
            </div>
            {match.oddsUpdated && <div style={S.oddsUpdated}>обновлено {match.oddsUpdated}</div>}
            <div style={S.oddsScroll}>
              {match.markets.map((mk) => {
                const impl = mk.price != null ? mk.price / 100 : impliedProb(mk.odds);
                const edge = (mk.aiProb - impl) * 100;
                const priceDisp = mk.price != null ? `${mk.price}¢` : mk.odds.toFixed(2);
                return (
                  <div key={mk.id} style={S.oddsRow}>
                    <div style={S.oddsTop}><span style={S.oddsLabel}>{mk.label}</span><span style={S.oddsVal}>{priceDisp}</span></div>
                    <div style={S.oddsBot}>
                      <span style={S.oddsAi}>ИИ {(mk.aiProb * 100).toFixed(0)}%</span>
                      {mk.liq && <span style={S.oddsLiq}>${mk.liq}</span>}
                      <span style={{ ...S.oddsEdge, color: edge >= 5 ? "#5fd08a" : edge >= 3 ? "#e8a838" : edge > 0 ? "#9aa4b2" : "#ff6b6b" }}>{edge >= 0 ? "+" : ""}{edge.toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}

function Assessment({ a, priority }) {
  if (!a) return <div style={S.noPos}>нет данных</div>;
  const [full, setFull] = useState(false);
  return (
    <div>
      <div style={S.assessTop}><span style={S.confChip}>уверенность: {a.confidence}</span><button onClick={() => setFull(!full)} style={S.fullToggle}>{full ? "кратко" : "подробно"}</button></div>
      <p style={S.assessText}>{full ? a.text : a.short}</p>
      {a.verdict && <div style={S.verdict}><span style={{ color: "#e8a838" }}>&#9656;</span> {a.verdict}</div>}
    </div>
  );
}

function StrategyScreen({ sportId, sportLabel, catalog, setCatalog, compBudget, shares, apiKeys, analysis, setAnalysis, onGoModels }) {
  const [modal, setModal] = useState(null);
  const sportStrats = catalog.filter((s) => s.sport === sportId);
  const sportComps = COMPETITIONS.filter((c) => c.sport === sportId);
  // мастер-детейл аналитики: выбранный "лист" — base или comp id
  const [anSel, setAnSel] = useState("base");
  const [saved, setSaved] = useState(true);

  const availableModels = PROVIDERS.filter((p) => apiKeys[p.id]).flatMap((p) => p.models);

  const addStrategy = (draft) => { const id = "s" + Date.now(); setCatalog((c) => [...c, { ...draft, id, version: 1, sport: sportId, color: PALETTE[c.length % PALETTE.length] }]); setModal(null); };
  const updateStrategy = (id, patch) => setCatalog((c) => c.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const acceptImprovement = (id, p, params) => { setCatalog((c) => c.map((s) => (s.id === id ? { ...s, prompt: p, params, version: s.version + 1 } : s))); setModal(null); };

  const anValue = anSel === "base" ? analysis.bySport[sportId] : (analysis.byComp[anSel] || "");
  const setAnValue = (txt) => setAnalysis((p) => anSel === "base" ? { ...p, bySport: { ...p.bySport, [sportId]: txt } } : { ...p, byComp: { ...p.byComp, [anSel]: txt } });
  const anModel = analysis.modelBySport?.[sportId] || "—";
  const setAnModel = (m) => setAnalysis((p) => ({ ...p, modelBySport: { ...p.modelBySport, [sportId]: m } }));

  return (
    <main style={S.main}>
      {/* Аналитика: мастер-детейл (слева список, справа контент) */}
      <div style={S.analysisCard}>
        <div style={S.analysisCardHead}>
          <div style={S.analysisTitle}>Аналитический промт · {sportLabel}</div>
          <div style={S.analysisModelPick}>
            <span style={S.analysisModelLbl}>модель:</span>
            <ModelSelect value={anModel} models={availableModels} onChange={setAnModel} onGoModels={onGoModels} />
          </div>
        </div>
        <div style={S.masterDetail} className="el-master-detail">
          <div style={S.mdList}>
            <button style={{ ...S.mdItem, ...(anSel === "base" ? S.mdItemOn : {}) }} onClick={() => setAnSel("base")}>
              <span style={S.mdItemName}>Базовый ({sportLabel})</span>
              <span style={S.mdItemTag}>применяется везде</span>
            </button>
            {sportComps.map((c) => (
              <button key={c.id} style={{ ...S.mdItem, ...(anSel === c.id ? S.mdItemOn : {}) }} onClick={() => setAnSel(c.id)}>
                <span style={S.mdItemName}>{c.name}</span>
                <span style={{ ...S.mdItemTag, color: analysis.byComp[c.id] ? "#70b56a" : MUTE }}>{analysis.byComp[c.id] ? "✓ переопределено" : "наследует базовый"}</span>
              </button>
            ))}
          </div>
          <div style={S.mdContent}>
            {anSel !== "base" && <div style={S.mdHint}>Дополнение к базовому промту, только для «{sportComps.find((c) => c.id === anSel)?.name}». Пусто — используется базовый.</div>}
            <textarea style={S.mdTextarea} value={anValue} onChange={(e) => { setAnValue(e.target.value); setSaved(false); setTimeout(() => setSaved(true), 400); }} placeholder={anSel === "base" ? "Как ИИ оценивает матчи этого спорта…" : "Особенности оценки для этого турнира (или пусто)…"} />
            <div style={S.saveIndicator}>{saved ? <span style={{ color: "#70b56a" }}>✓ сохранено автоматически</span> : <span style={{ color: "#e8a838" }}>сохранение…</span>}</div>
          </div>
        </div>
      </div>

      <div style={S.stratIntro}>
        <div style={S.stratIntroTop}><div><div style={S.stratIntroTitle}>Стратегии · {sportLabel}</div><div style={S.stratIntroSub}>Бюджет и доли — на экране «Матчи». Модель выбирается для каждой стратегии.</div></div><button style={S.addBtn} onClick={() => setModal({ type: "new" })}>+ Новая</button></div>
        <div style={S.howto}>Опиши стратегию <b>словами</b>: вход, размер, переоценка, выход, ограничители. Движок вытащит числа. Выбери модель, на которой стратегия думает.</div>
      </div>

      {sportStrats.length === 0 && <div style={S.empty}>В категории «{sportLabel}» пока нет стратегий.</div>}
      {sportStrats.map((st) => <StrategyCard key={st.id} st={st} overall={stratOverall(st.id, sportId, compBudget, shares)} availableModels={availableModels} onSetModel={(m) => updateStrategy(st.id, { model: m })} onGoModels={onGoModels} onEdit={() => setModal({ type: "edit", stratId: st.id })} onImprove={() => setModal({ type: "improve", stratId: st.id })} />)}

      {modal?.type === "new" && <PromptModal title={`Новая стратегия · ${sportLabel}`} availableModels={availableModels} onGoModels={onGoModels} onClose={() => setModal(null)} onSave={addStrategy} />}
      {modal?.type === "edit" && <PromptModal title="Редактировать" strat={catalog.find((s) => s.id === modal.stratId)} availableModels={availableModels} onGoModels={onGoModels} onClose={() => setModal(null)} onSave={(d) => { updateStrategy(modal.stratId, d); setModal(null); }} />}
      {modal?.type === "improve" && <ImproveModal strat={catalog.find((s) => s.id === modal.stratId)} onClose={() => setModal(null)} onAccept={(p, params) => acceptImprovement(modal.stratId, p, params)} />}
    </main>
  );
}

// Компактный селектор модели
function ModelSelect({ value, models, onChange, onGoModels }) {
  if (!models || models.length === 0) {
    return <button style={S.modelSelectEmpty} onClick={onGoModels}>нет ключей — добавить →</button>;
  }
  return (
    <select style={S.modelSelect} value={value} onChange={(e) => e.target.value === "__add" ? onGoModels() : onChange(e.target.value)}>
      {!models.includes(value) && <option value={value}>{value}</option>}
      {models.map((m) => <option key={m} value={m}>{m}</option>)}
      <option value="__add">+ управлять моделями…</option>
    </select>
  );
}

function FeedScreen() {
  const [filter, setFilter] = useState("all");
  const types = [
    ["all", "Всё"], ["enter", "Входы"], ["reassess", "Переоценки"], ["settle", "Расчёты"], ["goal", "События матча"], ["skip", "Пропуски"],
  ];
  const shown = filter === "all" ? EVENT_FEED : EVENT_FEED.filter((e) => e.type === filter || (filter === "goal" && (e.type === "goal" || e.type === "lineup")));

  return (
    <main style={S.main}>
      <div style={S.feedHead}>
        <div><div style={S.feedTitle}>Лента событий</div><div style={S.feedSub}>Хронология по всем матчам, спортам и стратегиям в одном потоке.</div></div>
      </div>
      <div style={S.feedFilters}>
        {types.map(([k, lbl]) => <button key={k} onClick={() => setFilter(k)} style={{ ...S.feedFilterBtn, ...(filter === k ? S.feedFilterOn : {}) }}>{lbl}</button>)}
      </div>
      <div style={S.feedList}>
        {shown.map((e, i) => (
          <div key={i} style={S.feedItem}>
            <div style={S.feedTime}>{e.t}</div>
            <div style={{ ...S.feedIcon, ...feedIconStyle(e.type) }}>{feedIconChar(e.type)}</div>
            <div style={S.feedBody}>
              <div style={S.feedItemTop}>
                {e.strat && <span style={{ ...S.feedStrat, color: e.color || "#8b95a5" }}>{e.strat}</span>}
                <span style={S.feedMatch}>{e.sport} · {e.match}</span>
              </div>
              <div style={S.feedText}>{e.text}</div>
            </div>
            {e.pnl != null && <div style={{ ...S.feedPnl, color: e.pnl >= 0 ? "#5fd08a" : "#ff6b6b" }}>{e.pnl >= 0 ? "+" : ""}{fmtMoney(e.pnl)}</div>}
          </div>
        ))}
      </div>
    </main>
  );
}

function feedIconChar(t) { return { enter: "→", reassess: "↻", settle: "✓", goal: "⚽", lineup: "📋", skip: "—" }[t] || "•"; }
function feedIconStyle(t) {
  const map = { enter: { color: "#70b56a", borderColor: "#70b56a55" }, reassess: { color: "#5b9bd5", borderColor: "#5b9bd555" }, settle: { color: "#c98bdb", borderColor: "#c98bdb55" }, goal: { color: "#e8a838", borderColor: "#e8a83855" }, lineup: { color: "#e8a838", borderColor: "#e8a83855" }, skip: { color: "#8b95a5", borderColor: "#2c3543" } };
  return map[t] || {};
}

function MetricsScreen({ catalog }) {
  const rows = catalog.filter((s) => QUALITY[s.id]).map((s) => ({ ...s, q: QUALITY[s.id] }));
  return (
    <main style={S.main}>
      <div style={S.feedHead}>
        <div><div style={S.feedTitle}>Метрики качества</div><div style={S.feedSub}>ROI на малой выборке врёт. Эти метрики показывают, реален ли эдж или это везение.</div></div>
      </div>

      <div style={S.metricExplain}>
        <div style={S.metricExplainItem}><b style={{ color: "#7fb4e8" }}>Brier</b> — точность вероятностей (ниже = лучше). Насколько «70%» ИИ реально значит 70%.</div>
        <div style={S.metricExplainItem}><b style={{ color: "#70b56a" }}>CLV</b> — closing line value. Двигался ли рынок в твою сторону после входа. Лучший ранний признак реального эджа.</div>
        <div style={S.metricExplainItem}><b style={{ color: "#e8a838" }}>Калибровка</b> — совпадают ли предсказанные вероятности с фактической частотой исходов.</div>
      </div>

      {rows.map((s) => {
        const q = s.q;
        const enough = q.samples >= 20;
        return (
          <section key={s.id} style={{ ...S.card, borderColor: s.color + "55" }}>
            <div style={S.metricHead}>
              <span style={{ ...S.dot, background: s.color }} />
              <span style={S.metricName}>{s.name}</span>
              <span style={S.metricSamples}>{q.samples} матчей {!enough && <span style={{ color: "#e8a838" }}>· мало данных</span>}</span>
            </div>
            <div style={S.metricNums}>
              <div style={S.metricNumCell}><div style={S.metricNumLbl}>Brier</div><div style={{ ...S.metricNumVal, color: q.brier <= 0.19 ? "#5fd08a" : q.brier <= 0.22 ? "#e8a838" : "#ff6b6b" }}>{q.brier.toFixed(3)}</div></div>
              <div style={S.metricNumCell}><div style={S.metricNumLbl}>CLV</div><div style={{ ...S.metricNumVal, color: q.clv > 0 ? "#5fd08a" : "#ff6b6b" }}>{q.clv >= 0 ? "+" : ""}{q.clv.toFixed(1)}%</div></div>
              <div style={S.metricNumCell}><div style={S.metricNumLbl}>вердикт</div><div style={{ ...S.metricVerdict, color: q.clv > 1 && q.brier < 0.2 ? "#5fd08a" : q.clv < 0 ? "#ff6b6b" : "#e8a838" }}>{q.clv > 1 && q.brier < 0.2 ? "эдж реален" : q.clv < 0 ? "эджа нет" : "неясно"}</div></div>
            </div>
            <div style={S.calibLabel}>Калибровка (предсказано → факт)</div>
            <div style={S.calibRows}>
              {q.calib.map((c, i) => {
                const diff = c.actual - c.predicted;
                return (
                  <div key={i} style={S.calibRow}>
                    <span style={S.calibBucket}>{c.bucket}</span>
                    <div style={S.calibBar}>
                      <div style={{ ...S.calibBarPred, width: `${c.predicted}%` }} />
                      <div style={{ ...S.calibDot, left: `${c.actual}%` }} />
                    </div>
                    <span style={{ ...S.calibDiff, color: Math.abs(diff) <= 3 ? "#5fd08a" : Math.abs(diff) <= 6 ? "#e8a838" : "#ff6b6b" }}>{diff >= 0 ? "+" : ""}{diff}</span>
                  </div>
                );
              })}
            </div>
            {!enough && <div style={S.metricWarn}>Выборка мала ({q.samples}) — метрики шумны, не доверяй им до 20+ матчей.</div>}
          </section>
        );
      })}
    </main>
  );
}

function PortfolioScreen({ positions, onGoMatches }) {
  const [groupBy, setGroupBy] = useState("strat"); // strat | comp
  const totalStake = positions.reduce((a, p) => a + p.stake, 0);
  const totalLive = positions.reduce((a, p) => a + p.live, 0);
  const winners = positions.filter((p) => p.live >= 0).length;

  // группировка
  const groups = {};
  for (const p of positions) {
    const key = groupBy === "strat" ? p.strat : p.compName;
    (groups[key] = groups[key] || { items: [], color: p.stratColor, stake: 0, live: 0 }).items.push(p);
    groups[key].stake += p.stake;
    groups[key].live += p.live;
  }

  return (
    <main style={S.main}>
      <div style={S.pfHeader}>
        <div><div style={S.pfTitle}>Портфель — открытые позиции</div><div style={S.pfSub}>Всё, что сейчас в игре, по всем спортам и турнирам. Mark-to-market в реальном времени.</div></div>
      </div>

      {/* Агрегаты */}
      <div style={S.pfAgg}>
        <div style={S.pfAggCell}><div style={S.pfAggLbl}>Открытых позиций</div><div style={S.pfAggVal}>{positions.length}</div></div>
        <div style={S.pfAggDiv} />
        <div style={S.pfAggCell}><div style={S.pfAggLbl}>В игре (экспозиция)</div><div style={S.pfAggVal}>{fmtMoney(totalStake)}</div></div>
        <div style={S.pfAggDiv} />
        <div style={S.pfAggCell}><div style={S.pfAggLbl}>Unrealized P&L</div><div style={{ ...S.pfAggVal, color: totalLive >= 0 ? "#5fd08a" : "#ff6b6b" }}>{totalLive >= 0 ? "+" : ""}{fmtMoney(totalLive)}</div></div>
        <div style={S.pfAggDiv} />
        <div style={S.pfAggCell}><div style={S.pfAggLbl}>В плюсе / всего</div><div style={S.pfAggVal}>{winners}/{positions.length}</div></div>
      </div>

      {positions.length === 0 ? (
        <div style={S.pfEmpty}>Сейчас нет открытых позиций. Они появятся, когда стратегии войдут в live-матчах. <button style={S.pfEmptyBtn} onClick={onGoMatches}>К матчам →</button></div>
      ) : (
        <>
          <div style={S.pfGroupToggle}>
            <span style={S.pfGroupLbl}>группировать:</span>
            <button style={{ ...S.pfGroupBtn, ...(groupBy === "strat" ? S.pfGroupOn : {}) }} onClick={() => setGroupBy("strat")}>по стратегии</button>
            <button style={{ ...S.pfGroupBtn, ...(groupBy === "comp" ? S.pfGroupOn : {}) }} onClick={() => setGroupBy("comp")}>по турниру</button>
          </div>

          {Object.entries(groups).map(([key, g]) => (
            <div key={key} style={S.pfGroup}>
              <div style={S.pfGroupHead}>
                {groupBy === "strat" && <span style={{ ...S.dot, background: g.color }} />}
                <span style={S.pfGroupName}>{key}</span>
                <span style={S.pfGroupStake}>{fmtMoney(g.stake)} в игре</span>
                <span style={{ ...S.pfGroupLive, color: g.live >= 0 ? "#5fd08a" : "#ff6b6b" }}>{g.live >= 0 ? "▲" : "▼"}{fmtMoney(g.live)}</span>
              </div>
              <div style={S.pfPosList}>
                {g.items.map((p, i) => (
                  <div key={i} style={S.pfPos}>
                    <div style={S.pfPosLeft}>
                      <div style={S.pfPosMarket}>{p.market}</div>
                      <div style={S.pfPosMeta}>
                        {groupBy === "strat" ? p.compName : <span style={{ color: p.stratColor }}>{p.strat}</span>}
                        {" · "}{p.match} · {p.minute}'
                        {p.entered && <span style={S.pfPosEntered}> · вход {p.entered}</span>}
                      </div>
                    </div>
                    <div style={S.pfPosRight}>
                      <div style={S.pfPosStake}>{fmtMoney(p.stake)} @ {p.entryPrice}¢</div>
                      <div style={S.pfPosLiveWrap}>
                        <span style={S.pfPosNow}>{p.currentPrice}¢</span>
                        <span style={{ ...S.pfPosLive, color: p.live >= 0 ? "#5fd08a" : "#ff6b6b" }}>{p.live >= 0 ? "▲" : "▼"}{fmtMoney(p.live)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </main>
  );
}

function ModelsScreen({ apiKeys, setApiKeys }) {
  const [reveal, setReveal] = useState({});
  return (
    <main style={S.main}>
      <div style={S.modelsIntro}>
        <div style={S.modelsTitle}>Модели и ключи</div>
        <div style={S.modelsSub}>Добавь API-ключи провайдеров. После этого их модели можно выбирать для аналитики и для каждой стратегии. Ключи нужны только сами по себе — строка вида {PROVIDERS[0].keyHint}.</div>
      </div>
      {PROVIDERS.map((p) => {
        const has = !!apiKeys[p.id];
        return (
          <section key={p.id} style={{ ...S.card, borderColor: has ? "#70b56a55" : LINE }}>
            <div style={S.providerHead}>
              <div style={S.providerName}>{p.name}</div>
              <span style={{ ...S.providerStatus, color: has ? "#70b56a" : MUTE, borderColor: has ? "#70b56a55" : LINE }}>{has ? "✓ подключён" : "нет ключа"}</span>
            </div>
            <div style={S.keyRow}>
              <input style={S.keyInput} type={reveal[p.id] ? "text" : "password"} value={apiKeys[p.id]} placeholder={p.keyHint}
                onChange={(e) => setApiKeys((k) => ({ ...k, [p.id]: e.target.value }))} />
              <button style={S.keyReveal} onClick={() => setReveal((r) => ({ ...r, [p.id]: !r[p.id] }))}>{reveal[p.id] ? "скрыть" : "показать"}</button>
              {has && <button style={S.keyClear} onClick={() => setApiKeys((k) => ({ ...k, [p.id]: "" }))}>удалить</button>}
            </div>
            <div style={S.modelChips}>
              <span style={S.modelChipsLabel}>Модели:</span>
              {p.models.map((m) => <span key={m} style={{ ...S.modelChip, opacity: has ? 1 : 0.4 }}>{m}</span>)}
            </div>
          </section>
        );
      })}
      <div style={S.modelsNote}>Заглушка макета: список моделей репрезентативный. В боевой версии он подтягивается от провайдера, а ключи хранятся безопасно на бэкенде, не в браузере.</div>
    </main>
  );
}

function StrategyCard({ st, overall, availableModels, onSetModel, onGoModels, onEdit, onImprove }) {
  const [open, setOpen] = useState(false);
  return (
    <section style={{ ...S.card, borderColor: st.color + "55" }}>
      <button style={S.stratHeadBtn} onClick={() => setOpen(!open)}><span style={{ ...S.dot, background: st.color }} /><span style={S.stratBigName}>{st.name}</span><span style={S.verBadge}>v{st.version}</span><span style={S.stratTag}>{st.tag}</span><span style={S.modelBadge}>{st.model || "модель?"}</span><span style={S.chev}>{open ? "▾" : "▸"}</span></button>
      <div style={S.overallRow}>
        {overall.active === 0 ? <span style={S.overallNone}>нет активных бюджетов — доходность не считается</span> : <>
          <div style={S.overallMetric}><span style={S.overallLbl}>доходность (ср. ROI)</span><span style={{ ...S.overallRoi, color: overall.avgRoi >= 0 ? "#5fd08a" : "#ff6b6b" }}>{overall.avgRoi >= 0 ? "+" : ""}{overall.avgRoi.toFixed(1)}%</span></div>
          <div style={S.overallDiv} />
          <div style={S.overallMetric}><span style={S.overallLbl}>P&L всего</span><span style={{ ...S.overallPnl, color: overall.pnl >= 0 ? "#5fd08a" : "#ff6b6b" }}>{overall.pnl >= 0 ? "+" : ""}{fmtMoney(overall.pnl)}</span></div>
          <div style={S.overallDiv} />
          <div style={S.overallMetric}><span style={S.overallLbl}>в игре</span><span style={S.overallBudget}>{fmtMoney0(overall.budget)} · {overall.active} турн.</span></div>
        </>}
      </div>
      {open && (
        <div style={S.stratDetail}>
          <div style={S.modelPickRow}>
            <span style={S.modelPickLbl}>Модель стратегии:</span>
            <ModelSelect value={st.model || ""} models={availableModels} onChange={onSetModel} onGoModels={onGoModels} />
          </div>
          <div style={S.promptLabel}>Промт стратегии</div>
          <pre style={S.promptBox}>{st.prompt}</pre>
          <div style={S.paramLabel}>Пороги, распознанные движком</div>
          <div style={S.paramList}>{Object.entries(st.params).map(([k, v]) => { const d = describeParam(k, v); return <div key={k} style={S.paramItem}><span style={S.paramItemLabel}>{d.label}</span><span style={S.paramItemValue}>{d.value}</span></div>; })}</div>
          <div style={S.stratEditRow}><button style={S.editBtn} onClick={onEdit}>Редактировать промт</button><button style={S.improveBtn} onClick={onImprove}>↻ Улучшить по данным</button></div>
        </div>
      )}
    </section>
  );
}

function BudgetModal({ comp, current, free, onClose, onSave }) {
  const [amount, setAmount] = useState(current);
  const maxAvail = free + current;
  const invalid = amount < 0 || amount > maxAvail;
  const quick = [500, 1000, 1500, maxAvail];
  return (
    <Modal title={`Бюджет турнира · ${comp.name}`} onClose={onClose}>
      <div style={S.allocInfo}>
        <div style={S.allocInfoRow}><span>Сейчас на турнире</span><b>{fmtMoney0(current)}</b></div>
        <div style={S.allocInfoRow}><span>Свободно в казне</span><b style={{ color: "#5fd08a" }}>{fmtMoney0(free)}</b></div>
        <div style={S.allocInfoRow}><span>Можно назначить до</span><b style={{ color: "#e8a838" }}>{fmtMoney0(maxAvail)}</b></div>
      </div>
      <label style={S.fieldLabel}>Бюджет турнира ($)</label>
      <div style={S.allocInputRow}><span style={S.allocDollar}>$</span><input style={S.allocInput} type="number" min="0" max={maxAvail} value={amount} onChange={(e) => setAmount(Math.round(+e.target.value))} /></div>
      <div style={S.quickRow}>{quick.map((q, i) => <button key={i} style={S.quickBtn} onClick={() => setAmount(Math.round(q))}>{i === 3 ? "макс" : fmtMoney0(q)}</button>)}</div>
      <div style={S.allocNote}>Это общий бюджет турнира. Внутри стратегии делят его в процентах (кнопка «Распределить доли %»).</div>
      {invalid && <div style={S.warnBox}>Сумма от $0 до {fmtMoney0(maxAvail)}.</div>}
      <div style={S.modalActions}><button style={S.cancelBtn} onClick={onClose}>Отмена</button><button style={{ ...S.saveBtn, opacity: invalid ? 0.4 : 1 }} disabled={invalid} onClick={() => onSave(amount)}>Сохранить</button></div>
    </Modal>
  );
}

function SharesModal({ comp, strats, budget, current, onClose, onSave }) {
  const [sh, setSh] = useState(() => Object.fromEntries(strats.map((s) => [s.id, current[s.id] || 0])));
  const total = Object.values(sh).reduce((a, b) => a + b, 0);
  const over = total > 100;
  const setPct = (id, v) => setSh((p) => ({ ...p, [id]: Math.max(0, Math.min(100, Math.round(v))) }));
  return (
    <Modal title={`Доли стратегий · ${comp.name}`} onClose={onClose}>
      <div style={S.sharesHead}><span>Бюджет турнира: <b>{fmtMoney0(budget)}</b></span><span style={{ color: over ? "#ff6b6b" : total === 100 ? "#5fd08a" : "#e8a838" }}>распределено {total}% {over ? "(перебор!)" : `· свободно ${100 - total}%`}</span></div>
      {strats.map((s) => (
        <div key={s.id} style={S.shareRow}>
          <span style={{ ...S.dot, background: s.color }} />
          <span style={S.shareName}>{s.name}</span>
          <input type="range" min="0" max="100" value={sh[s.id]} onChange={(e) => setPct(s.id, +e.target.value)} style={S.shareRange} />
          <div style={S.sharePctBox}><input type="number" min="0" max="100" value={sh[s.id]} onChange={(e) => setPct(s.id, +e.target.value)} style={S.sharePctInput} /><span style={S.sharePctSign}>%</span></div>
          <span style={S.shareDollar}>{fmtMoney0(Math.round(budget * sh[s.id] / 100))}</span>
        </div>
      ))}
      <div style={S.allocNote}>Проверенной стратегии — больше %, тестовой — меньше. Сумма не обязана быть 100%: свободный % просто не используется.</div>
      {over && <div style={S.warnBox}>Сумма долей превышает 100%. Уменьши.</div>}
      <div style={S.modalActions}><button style={S.cancelBtn} onClick={onClose}>Отмена</button><button style={{ ...S.saveBtn, opacity: over ? 0.4 : 1 }} disabled={over} onClick={() => onSave(Object.fromEntries(Object.entries(sh).filter(([, v]) => v > 0)))}>Сохранить</button></div>
    </Modal>
  );
}

function PromptModal({ title, strat, availableModels, onGoModels, onClose, onSave }) {
  const [name, setName] = useState(strat?.name || "");
  const [prompt, setPrompt] = useState(strat?.prompt || "");
  const [model, setModel] = useState(strat?.model || (availableModels[0] || ""));
  const [parsed, setParsed] = useState(strat?.params || null);
  const [parsing, setParsing] = useState(false);
  const [gen, setGen] = useState(false);
  const runParse = () => {
    setParsing(true);
    setTimeout(() => {
      const p = {};
      const mx = prompt.match(/не более (\d+)%/i); if (mx) p.maxPerBet = +mx[1] / 100;
      const st = prompt.match(/стоп[^-]*(-\d+)%/i); if (st) p.stop = +st[1] / 100;
      const ed = prompt.match(/edge ?>?=? ?(\d+)%/i); if (ed) p.minEdge = +ed[1];
      const fl = prompt.match(/размер (?:всегда )?(\d+)%/i); if (fl) p.flatSize = +fl[1] / 100;
      if (Object.keys(p).length === 0) p.note = "пороги не распознаны";
      setParsed(p); setParsing(false);
    }, 500);
  };
  // Генерация короткого названия (1-2 слова) из промта — заглушка (в реале зовёт LLM)
  const genName = () => {
    setGen(true);
    setTimeout(() => {
      const low = prompt.toLowerCase();
      let n = "Custom";
      if (low.includes("келли") || low.includes("kelly")) n = "Kelly Edge";
      else if (low.includes("лесен") || low.includes("ступен")) n = "Tiered Edge";
      else if (low.includes("фикс") || low.includes("всегда")) n = "Flat Bet";
      else if (low.includes("плей-офф") || low.includes("playoff")) n = "Playoff Guard";
      else if (low.includes("покрыт") || low.includes("сет")) n = "Surface Edge";
      else if (low.includes("высок")) n = "High Conviction";
      else if (low.includes("стоп")) n = "Guarded";
      setName(n); setGen(false);
    }, 600);
  };
  const canSave = name.trim() && prompt.trim() && parsed;
  return (
    <Modal title={title} onClose={onClose}>
      <label style={S.fieldLabel}>Название</label>
      <div style={S.nameRow}>
        <input style={{ ...S.input, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Playoff Guard" />
        <button style={S.genNameBtn} onClick={genName} disabled={!prompt.trim() || gen} title="Придумать короткое название из промта">{gen ? "…" : "✨ придумать"}</button>
      </div>
      {!prompt.trim() && <div style={S.genHint}>сначала опиши промт — из него сгенерируется название</div>}
      <label style={S.fieldLabel}>Модель, на которой думает стратегия</label>
      <ModelSelect value={model} models={availableModels} onChange={setModel} onGoModels={onGoModels} />
      <label style={S.fieldLabel}>Промт (вход, размер, переоценка, выход, ограничители — словами)</label>
      <textarea style={S.textarea} value={prompt} onChange={(e) => { setPrompt(e.target.value); setParsed(null); }} placeholder={"Входи при edge >= 4% и высокой уверенности.\nМожно несколько ставок на матч.\nОграничители: не более 12% на ставку, стоп -20%."} />
      <button style={S.parseBtn} onClick={runParse} disabled={!prompt.trim() || parsing}>{parsing ? "движок парсит…" : "→ Распознать пороги движком"}</button>
      {parsed && <div style={S.parsedBox}><div style={S.parsedLabel}>Движок распознал пороги:</div><div style={S.paramList}>{Object.entries(parsed).map(([k, v]) => { const d = describeParam(k, v); return <div key={k} style={{ ...S.paramItem, ...(k === "note" ? { borderColor: "#e8a83866" } : {}) }}><span style={S.paramItemLabel}>{d.label}</span><span style={{ ...S.paramItemValue, ...(k === "note" ? { color: "#e8a838" } : {}) }}>{d.value}</span></div>; })}</div></div>}
      <div style={S.modalActions}><button style={S.cancelBtn} onClick={onClose}>Отмена</button><button style={{ ...S.saveBtn, opacity: canSave ? 1 : 0.4 }} disabled={!canSave} onClick={() => onSave({ name, prompt, model, params: parsed, tag: "custom" })}>Сохранить</button></div>
    </Modal>
  );
}

function ImproveModal({ strat, onClose, onAccept }) {
  const [stage, setStage] = useState("stats");
  const stats = FAKE_STATS[strat.id] || { matches: 6, roi: 2.0, wins: 4, losses: 2, note: "мало данных" };
  const enough = stats.matches >= 20;
  const improvedPrompt = strat.prompt.replace(/Входи[^\n]*/, "Входи ТОЛЬКО при уверенности «высокая» (входы на «средней» отключены — убыточны).");
  const improvedParams = { ...strat.params, minConfidence: "high" };
  return (
    <Modal title={`Улучшить: ${strat.name} v${strat.version}`} onClose={onClose}>
      {stage === "stats" ? <>
        <div style={S.statsGrid}><Stat label="Матчей" value={stats.matches} /><Stat label="ROI" value={`${stats.roi >= 0 ? "+" : ""}${stats.roi}%`} color={stats.roi >= 0 ? "#5fd08a" : "#ff6b6b"} /><Stat label="W / L" value={`${stats.wins} / ${stats.losses}`} /></div>
        <div style={S.dataProgress}>
          <div style={S.dataProgressTop}><span>данные для улучшения</span><span style={{ color: enough ? "#70b56a" : "#e8a838" }}>{stats.matches} / 20 матчей</span></div>
          <div style={S.dataBar}><div style={{ ...S.dataBarFill, width: `${Math.min(100, (stats.matches / 20) * 100)}%`, background: enough ? "#70b56a" : "#e8a838" }} /></div>
        </div>
        <div style={S.statNote}>{stats.note}</div>
        {enough ? <div style={S.okBox}>✓ Рекомендуется: данных достаточно ({stats.matches} матчей). Улучшение опирается на статистику, а не на шум.</div> : <div style={S.warnBox}>✕ Рано улучшать: только {stats.matches} матчей, нужно 20+. Сейчас изменение подгонит стратегию под случайность. Собери ещё {20 - stats.matches}.</div>}
        <div style={S.modalActions}><button style={S.cancelBtn} onClick={onClose}>Закрыть</button><button style={{ ...S.saveBtn, opacity: enough ? 1 : 0.4 }} disabled={!enough} onClick={() => setStage("proposal")}>→ Запросить у ИИ</button></div>
      </> : <>
        <div style={S.diffLabel}>ИИ предлагает (diff)</div>
        <div style={S.diffBox}><div style={S.diffRemoved}>− Входи при любой уверенности…</div><div style={S.diffAdded}>+ Входи ТОЛЬКО при «высокой» (средняя убыточна)</div></div>
        <div style={S.reasonBox}><b>Обоснование:</b> входы при средней уверенности дали отрицательный вклад.</div>
        <div style={S.newVerNote}>Принятие создаст <b>v{strat.version + 1}</b>.</div>
        <div style={S.modalActions}><button style={S.cancelBtn} onClick={() => setStage("stats")}>← Назад</button><button style={S.saveBtn} onClick={() => onAccept(improvedPrompt, improvedParams)}>Принять v{strat.version + 1}</button></div>
      </>}
    </Modal>
  );
}

function Stat({ label, value, color }) { return <div style={S.statCell}><div style={S.statLbl}>{label}</div><div style={{ ...S.statVal, color: color || TEXT }}>{value}</div></div>; }
function Modal({ title, children, onClose }) { return <div style={S.overlay} onClick={onClose}><div style={S.modal} onClick={(e) => e.stopPropagation()}><div style={S.modalHead}><span style={S.modalTitle}>{title}</span><button style={S.closeX} onClick={onClose}>✕</button></div><div style={S.modalBody}>{children}</div></div></div>; }
function logTypeStyle(type) { const m = { enter: { color: "#70b56a" }, exit: { color: "#e8a838" }, reassess: { color: "#5b9bd5" }, settle: { color: "#c98bdb" } }; return m[type] || { color: "#8b95a5" }; }

const INK = "#12161d", PANEL = "#1a2029", PANEL2 = "#212936", LINE = "#2c3543", TEXT = "#e6e9ef", MUTE = "#8b95a5";
const CSS = `* { box-sizing: border-box; } button { font-family: inherit; } button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #e8a838; outline-offset: 2px; } p { margin: 0; } pre { margin: 0; } textarea, input, select { font-family: inherit; } input[type=range]{ accent-color: #e8a838; }
.el-tab-select { display: none; }
@media (min-width: 760px) {
  .el-match-body { display: grid !important; grid-template-columns: 1fr 280px; gap: 16px; align-items: start; }
  .el-strat-grid { display: grid !important; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
  .el-odds-col { position: sticky; top: 12px; }
  .el-master-detail { display: grid !important; grid-template-columns: 220px 1fr; gap: 12px; align-items: start; }
}
@media (max-width: 759px) {
  .el-odds-col { margin-top: 14px; }
  .el-tab-buttons { display: none !important; }
  .el-tab-select { display: block !important; }
}`;

const S = {
  root: { fontFamily: "'Inter', system-ui, sans-serif", background: INK, color: TEXT, minHeight: "100vh", padding: 20, maxWidth: 1120, margin: "0 auto" },
  treasury: { display: "flex", alignItems: "center", gap: 4, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: "10px 12px", marginBottom: 12, flexWrap: "wrap" },
  trBrand: { display: "flex", alignItems: "center", gap: 6, paddingRight: 10, flexShrink: 0 },
  mark: { fontSize: 18, color: "#e8a838" },
  trBrandTxt: { fontSize: 14, fontWeight: 800, letterSpacing: "0.1em" },
  trCell: { flex: 1, textAlign: "center", minWidth: 90 },
  trLbl: { fontSize: 9.5, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" },
  trVal: { fontSize: 17, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginTop: 2 },
  trDiv: { width: 1, height: 30, background: LINE },
  screenSwitch: { display: "flex", gap: 2, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 4, marginBottom: 12, overflowX: "auto" },
  screenBtn: { background: "transparent", border: "none", color: MUTE, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", borderRadius: 7, whiteSpace: "nowrap", flexShrink: 0 },
  screenOn: { background: PANEL2, color: TEXT },
  sportTabs: { display: "flex", gap: 4, marginBottom: 12, borderBottom: `1px solid ${LINE}` },
  sportTab: { background: "transparent", border: "none", borderBottom: "2px solid transparent", color: MUTE, padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  sportTabOn: { color: TEXT, borderBottomColor: "#e8a838" },
  compRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 },
  compCard: { display: "flex", alignItems: "stretch", background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, minWidth: 150, overflow: "hidden" },
  compMain: { textAlign: "left", background: "transparent", border: "none", padding: "8px 10px 8px 12px", cursor: "pointer", flex: 1, color: TEXT },
  compOn: { borderColor: "#e8a838", background: PANEL2 },
  compName: { fontSize: 13, fontWeight: 700, color: TEXT },
  compBudget: { fontSize: 12, color: TEXT, fontFamily: "'JetBrains Mono', monospace", marginTop: 3, fontWeight: 700 },
  compDelta: { fontSize: 11, fontFamily: "'JetBrains Mono', monospace", marginTop: 1 },
  compRoi: { fontSize: 10, opacity: 0.85 },
  compUnalloc: { fontSize: 10, color: "#e8a838", marginTop: 3, fontStyle: "italic" },
  allocIcon: { background: "transparent", border: "none", borderLeft: `1px solid ${LINE}`, color: "#e8a838", fontSize: 17, fontWeight: 800, cursor: "pointer", padding: "0 12px" },
  stratStripHead: { display: "flex", alignItems: "center", marginBottom: 8 },
  stratStripTitle: { fontSize: 12, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 },
  shareBtn: { marginLeft: "auto", background: "transparent", border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 },
  bankStrip: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 },
  noStrat: { fontSize: 12.5, color: "#e8a838", background: "#2e2a1a", borderRadius: 8, padding: "10px 14px" },
  bankCell: { display: "flex", alignItems: "center", gap: 10, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 12px" },
  dot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  bankInfo: { display: "flex", flexDirection: "column" },
  bankNm: { fontSize: 13, fontWeight: 600 },
  bankBudget: { fontSize: 10.5, color: MUTE, fontFamily: "'JetBrains Mono', monospace" },
  bankNums: { marginLeft: "auto", textAlign: "right" },
  bankEq: { fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", display: "block" },
  bankD: { fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
  main: { display: "flex", flexDirection: "column", gap: 12 },
  empty: { color: MUTE, padding: 30, textAlign: "center" },
  card: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, padding: 14 },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  matchup: { fontSize: 17, fontWeight: 700 },
  score: { fontFamily: "'JetBrains Mono', monospace", color: "#e8a838", fontWeight: 800 },
  vs: { color: MUTE, fontWeight: 400 },
  timing: { fontSize: 12, color: MUTE, marginTop: 2 },
  stateBadge: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", padding: "5px 10px", borderRadius: 20, whiteSpace: "nowrap" },
  pulse: { width: 6, height: 6, borderRadius: "50%", background: "#ff6b6b", animation: "pulse 1.3s infinite" },
  resultStrip: { display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  resultCell: { display: "flex", alignItems: "center", gap: 6, background: "#1c2620", border: "1px solid #2f5140", borderRadius: 8, padding: "8px 12px", flex: 1, minWidth: 170 },
  resultNm: { fontSize: 12, color: MUTE },
  resultVal: { fontSize: 15, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginLeft: "auto" },
  resultRoi: { fontSize: 10.5, color: "#8b95a5", fontFamily: "'JetBrains Mono', monospace", width: "100%", textAlign: "right" },
  tabBar: { display: "flex", gap: 2, background: INK, borderRadius: 8, padding: 3, marginBottom: 12, flexWrap: "wrap" },
  tabBtn: { flex: 1, background: "transparent", border: "none", color: MUTE, padding: "7px 10px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", borderRadius: 6, minWidth: 90 },
  tabBtnOn: { background: PANEL2, color: TEXT },
  tabBody: { minHeight: 60 },
  matchBody: { display: "block" },
  matchLeft: { minWidth: 0 },
  oddsCol: { background: INK, border: `1px solid ${LINE}`, borderRadius: 10, padding: 10, alignSelf: "start" },
  oddsColHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  oddsColLabel: { fontSize: 11, color: "#e8a838", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 },
  oddsColSub: { fontSize: 10, color: MUTE, marginTop: 2, marginBottom: 8 },
  oddsRefresh: { background: PANEL2, border: `1px solid ${LINE}`, color: "#e8a838", borderRadius: 6, width: 28, height: 28, fontSize: 15, cursor: "pointer", flexShrink: 0 },
  oddsUpdated: { fontSize: 9.5, color: MUTE, marginBottom: 8, fontFamily: "'JetBrains Mono', monospace" },
  oddsScroll: { maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 2 },
  oddsRow: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "7px 9px" },
  oddsTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 },
  oddsLabel: { fontSize: 12, fontWeight: 600, lineHeight: 1.3 },
  oddsVal: { fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 14, color: "#e8a838", flexShrink: 0 },
  oddsBot: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4, gap: 6 },
  oddsAi: { fontSize: 10.5, color: MUTE, fontFamily: "'JetBrains Mono', monospace" },
  oddsLiq: { fontSize: 10, color: "#6b7686", fontFamily: "'JetBrains Mono', monospace" },
  oddsEdge: { fontSize: 11.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  finishCell: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 10px" },
  finishTop: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  finishNm: { fontSize: 12.5, fontWeight: 600 },
  finishVal: { fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" },
  finishRoi: { fontSize: 11, fontFamily: "'JetBrains Mono', monospace", marginTop: 1 },
  betEntered: { fontSize: 10, color: MUTE, marginTop: 4, fontFamily: "'JetBrains Mono', monospace" },
  reassessTop: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" },
  reassessHint: { fontSize: 11.5, color: MUTE, lineHeight: 1.4, flex: 1, minWidth: 180 },
  reassessBtn: { background: "transparent", border: `1px solid #5b9bd566`, color: "#7fb4e8", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" },
  reassessList: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 },
  reassessItem: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 12px" },
  reassessItemHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 5 },
  reassessMin: { fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#e8a838", fontWeight: 700 },
  reassessConf: { fontSize: 10.5, color: MUTE },
  reassessText: { fontSize: 13, lineHeight: 1.55, color: "#d3d8e0" },
  assessTop: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 },
  analysisFlow: { display: "flex", flexDirection: "column", gap: 14, maxHeight: 520, overflowY: "auto", paddingRight: 4 },
  analysisStage: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 },
  analysisStageLabel: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, marginBottom: 10, color: TEXT },
  stageNum: { width: 20, height: 20, borderRadius: "50%", background: LINE, color: TEXT, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0 },
  stagePriority: { fontSize: 10, color: "#e8a838", background: "#2e2a1a", borderRadius: 20, padding: "2px 8px", marginLeft: "auto", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" },
  analysisPending: { fontSize: 12, color: MUTE, fontStyle: "italic", padding: "10px 12px", background: PANEL2, borderRadius: 10, border: `1px dashed ${LINE}` },
  betRationale: { fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.5, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 11px", marginBottom: 10 },
  betRationaleLabel: { display: "block", fontSize: 9.5, color: "#e8a838", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 4 },
  decisionList: { display: "flex", flexDirection: "column", gap: 8 },
  decisionItem: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px" },
  decisionHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 5 },
  decisionName: { fontSize: 13, fontWeight: 700 },
  decisionVerdict: { marginLeft: "auto", fontSize: 10.5, color: "#7fb4e8", background: "#1e2836", borderRadius: 20, padding: "2px 10px", fontFamily: "'JetBrains Mono', monospace" },
  decisionText: { fontSize: 12.5, color: "#d3d8e0", lineHeight: 1.55 },
  finishTiming: { fontSize: 11, color: "#6b7686", marginTop: 3, fontFamily: "'JetBrains Mono', monospace" },
  priBadge: { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", padding: "3px 8px", borderRadius: 5 },
  confChip: { fontSize: 11, color: MUTE },
  fullToggle: { marginLeft: "auto", background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 20, padding: "3px 10px", fontSize: 11, cursor: "pointer" },
  assessText: { fontSize: 13.5, lineHeight: 1.55, color: "#d3d8e0" },
  verdict: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${LINE}`, fontSize: 13, fontWeight: 600, color: TEXT },
  markets: { display: "flex", flexDirection: "column", gap: 2, marginTop: 12 },
  marketsVert: { marginTop: 12 },
  marketsVertLabel: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontWeight: 700, columnSpan: "all" },
  mktVertRow: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 10px", marginBottom: 6, breakInside: "avoid" },
  mktVertTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline" },
  mktVertBot: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 },
  mktRow: { display: "grid", gridTemplateColumns: "1.8fr 0.7fr 0.9fr 0.8fr", gap: 8, alignItems: "center", padding: "7px 4px", borderBottom: `1px solid ${LINE}`, fontSize: 13 },
  mktLabel: { fontWeight: 500, fontSize: 13 },
  mktOdds: { fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 },
  mktAi: { fontFamily: "'JetBrains Mono', monospace", color: MUTE, fontSize: 12 },
  mktEdge: { fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 },
  stratList: { display: "flex", flexDirection: "column", gap: 10 },
  stratListGrid: { display: "flex", flexDirection: "column", gap: 10 },
  stratBlock: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 },
  stratBlockHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  stratName: { fontSize: 13.5, fontWeight: 700 },
  stratBudgetChip: { marginLeft: "auto", fontSize: 10.5, color: "#e8a838", fontFamily: "'JetBrains Mono', monospace", background: "#2e2a1a", borderRadius: 20, padding: "2px 10px" },
  noBets: { fontSize: 12, color: MUTE, fontStyle: "italic" },
  betList: { display: "flex", flexDirection: "column", gap: 6 },
  betRow: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 10px" },
  betMain: { display: "flex", alignItems: "baseline", gap: 8 },
  betMarket: { fontSize: 13, fontWeight: 600 },
  betOdds: { fontSize: 12, color: MUTE, fontFamily: "'JetBrains Mono', monospace" },
  betMeta: { display: "flex", alignItems: "center", gap: 10, marginTop: 5, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 },
  betEdge: { fontWeight: 700 },
  betStake: { color: TEXT, fontWeight: 700 },
  betLive: { fontWeight: 700 },
  betProposed: { color: "#8b95a5", fontStyle: "italic", fontFamily: "'Inter', sans-serif" },
  betTotal: { fontSize: 11, color: MUTE, fontFamily: "'JetBrains Mono', monospace", marginTop: 4, paddingTop: 6, borderTop: `1px solid ${LINE}` },
  logStratBar: { display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" },
  logStratBtn: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 20, padding: "4px 12px", fontSize: 12, cursor: "pointer" },
  logList: { display: "flex", flexDirection: "column", gap: 7 },
  noPos: { fontSize: 12, color: MUTE, fontStyle: "italic", padding: "8px 0" },
  logEntry: { display: "grid", gridTemplateColumns: "48px 72px 1fr", gap: 8, fontSize: 12, alignItems: "baseline" },
  logMin: { fontFamily: "'JetBrains Mono', monospace", color: MUTE, fontSize: 11 },
  logType: { fontSize: 10, fontWeight: 700, textTransform: "uppercase" },
  logText: { color: "#c3c9d3", lineHeight: 1.4 },
  conclText: { fontSize: 13, lineHeight: 1.55, color: "#d3d8e0" },
  lesson: { marginTop: 10, fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.5, display: "flex", flexDirection: "column", gap: 4 },
  lessonTag: { fontSize: 10, color: "#e8a838", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 },
  analysisCard: { background: PANEL, border: `1px solid #5b9bd555`, borderRadius: 14, padding: 14 },
  analysisTop: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 },
  analysisTitle: { fontSize: 15, fontWeight: 700, color: "#7fb4e8" },
  analysisSub: { fontSize: 11.5, color: MUTE, marginTop: 3 },
  analysisEditBtn: { marginLeft: "auto", background: "transparent", border: `1px solid #5b9bd566`, color: "#7fb4e8", borderRadius: 8, padding: "7px 14px", fontSize: 12.5, cursor: "pointer", whiteSpace: "nowrap" },
  analysisPreview: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: 10, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.5, color: MUTE, whiteSpace: "pre-wrap", marginBottom: 10 },
  analysisComps: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" },
  analysisCompsLabel: { fontSize: 11, color: MUTE, width: "100%", marginBottom: 2 },
  analysisCompBtn: { background: INK, border: `1px solid ${LINE}`, borderRadius: 20, padding: "4px 12px", fontSize: 11.5, cursor: "pointer", color: MUTE },
  analysisCompOn: { borderColor: "#5b9bd5", color: "#7fb4e8" },
  stratIntro: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, padding: 14 },
  stratIntroTop: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 },
  stratIntroTitle: { fontSize: 15, fontWeight: 700 },
  stratIntroSub: { fontSize: 11.5, color: MUTE, marginTop: 3 },
  addBtn: { marginLeft: "auto", background: "#e8a838", border: "none", color: "#12161d", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  howto: { fontSize: 12, lineHeight: 1.55, color: "#c3c9d3", background: PANEL2, borderRadius: 8, padding: "9px 12px" },
  stratHeadBtn: { width: "100%", background: "transparent", border: "none", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: 0 },
  overallRow: { display: "flex", alignItems: "center", gap: 12, marginTop: 12, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 12px", flexWrap: "wrap" },
  overallNone: { fontSize: 11.5, color: MUTE, fontStyle: "italic" },
  overallMetric: { display: "flex", flexDirection: "column", gap: 2 },
  overallLbl: { fontSize: 9.5, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" },
  overallRoi: { fontSize: 17, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" },
  overallPnl: { fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  overallBudget: { fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: "#c3c9d3" },
  overallDiv: { width: 1, height: 28, background: LINE },
  stratBigName: { fontSize: 16, fontWeight: 700, color: TEXT },
  verBadge: { fontSize: 10, background: LINE, color: TEXT, borderRadius: 20, padding: "1px 7px", fontFamily: "'JetBrains Mono', monospace" },
  stratTag: { fontSize: 10, color: MUTE },
  chev: { marginLeft: "auto", color: MUTE },
  stratDetail: { marginTop: 12, paddingTop: 12, borderTop: `1px solid ${LINE}` },
  promptLabel: { fontSize: 10, color: "#e8a838", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, marginBottom: 6 },
  promptBox: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: 12, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12, lineHeight: 1.6, color: "#d3d8e0", whiteSpace: "pre-wrap", marginBottom: 14 },
  paramLabel: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 8 },
  paramChips: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 },
  paramList: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 },
  paramItem: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 12px" },
  paramItemLabel: { fontSize: 12.5, color: "#c3c9d3" },
  paramItemValue: { fontSize: 12.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: TEXT, textAlign: "right" },
  nameRow: { display: "flex", gap: 6, alignItems: "center" },
  genNameBtn: { background: "transparent", border: `1px solid #c98bdb66`, color: "#c98bdb", borderRadius: 8, padding: "9px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 },
  genHint: { fontSize: 11, color: MUTE, fontStyle: "italic", marginTop: 4 },
  saveIndicator: { fontSize: 11, marginTop: 6, fontFamily: "'JetBrains Mono', monospace", textAlign: "right" },
  paramChip: { fontSize: 11.5, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 6, padding: "4px 10px", fontFamily: "'JetBrains Mono', monospace", color: "#c3c9d3" },
  stratEditRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  editBtn: { background: "transparent", border: `1px solid ${LINE}`, color: TEXT, borderRadius: 8, padding: "7px 14px", fontSize: 12.5, cursor: "pointer" },
  improveBtn: { background: "transparent", border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "7px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600 },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 20, overflowY: "auto", zIndex: 100 },
  modal: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, width: "100%", maxWidth: 560, marginTop: 40 },
  modalHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: `1px solid ${LINE}` },
  modalTitle: { fontSize: 15, fontWeight: 700 },
  closeX: { background: "transparent", border: "none", color: MUTE, fontSize: 16, cursor: "pointer" },
  modalBody: { padding: 16 },
  fieldLabel: { display: "block", fontSize: 11.5, color: MUTE, marginBottom: 6, marginTop: 12 },
  input: { width: "100%", background: INK, border: `1px solid ${LINE}`, borderRadius: 8, color: TEXT, padding: "9px 12px", fontSize: 13 },
  textarea: { width: "100%", minHeight: 120, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, color: TEXT, padding: "10px 12px", fontSize: 13, lineHeight: 1.55, resize: "vertical" },
  parseBtn: { marginTop: 10, width: "100%", background: PANEL2, border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "9px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  parsedBox: { marginTop: 12, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: 12 },
  parsedLabel: { fontSize: 11, color: "#70b56a", marginBottom: 8, fontWeight: 600 },
  modalActions: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 },
  cancelBtn: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 8, padding: "9px 16px", fontSize: 13, cursor: "pointer" },
  saveBtn: { background: "#e8a838", border: "none", color: "#12161d", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  allocInfo: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 6 },
  allocInfoRow: { display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#c3c9d3", padding: "3px 0", fontFamily: "'JetBrains Mono', monospace" },
  allocInputRow: { display: "flex", alignItems: "center", background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "4px 12px", marginTop: 6 },
  allocDollar: { color: MUTE, fontSize: 18, fontFamily: "'JetBrains Mono', monospace" },
  allocInput: { flex: 1, background: "transparent", border: "none", color: TEXT, padding: "8px 8px", fontSize: 20, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, outline: "none" },
  quickRow: { display: "flex", gap: 6, marginTop: 8 },
  quickBtn: { flex: 1, background: PANEL2, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 6, padding: "6px", fontSize: 12, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" },
  allocNote: { fontSize: 11.5, color: MUTE, lineHeight: 1.5, marginTop: 10 },
  sharesHead: { display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#c3c9d3", marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" },
  shareRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  shareName: { fontSize: 13, fontWeight: 600, width: 90, flexShrink: 0 },
  shareRange: { flex: 1 },
  sharePctBox: { display: "flex", alignItems: "center", background: INK, border: `1px solid ${LINE}`, borderRadius: 6, padding: "2px 6px", width: 62 },
  sharePctInput: { width: 34, background: "transparent", border: "none", color: TEXT, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", textAlign: "right", outline: "none" },
  sharePctSign: { fontSize: 12, color: MUTE },
  shareDollar: { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "#e8a838", width: 56, textAlign: "right", flexShrink: 0 },
  analysisModalHint: { fontSize: 12, color: "#c3c9d3", background: PANEL2, borderRadius: 8, padding: "9px 12px", lineHeight: 1.5, marginBottom: 6 },
  statsGrid: { display: "flex", gap: 8, marginTop: 6 },
  statCell: { flex: 1, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", textAlign: "center" },
  statLbl: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em" },
  statVal: { fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginTop: 4 },
  statNote: { fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.55, marginTop: 12, background: PANEL2, borderRadius: 8, padding: "10px 12px" },
  warnBox: { fontSize: 12, color: "#e8a838", background: "#2e2a1a", borderRadius: 8, padding: "10px 12px", marginTop: 10, lineHeight: 1.5 },
  okBox: { fontSize: 12, color: "#70b56a", background: "#1c2620", borderRadius: 8, padding: "10px 12px", marginTop: 10, lineHeight: 1.5 },
  diffLabel: { fontSize: 11, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 8 },
  diffBox: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: 12, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.6 },
  diffRemoved: { color: "#ff6b6b", background: "#2e1f22", borderRadius: 4, padding: "2px 6px", marginBottom: 4 },
  diffAdded: { color: "#5fd08a", background: "#1c2620", borderRadius: 4, padding: "2px 6px" },
  reasonBox: { fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.55, marginTop: 12, background: PANEL2, borderRadius: 8, padding: "10px 12px" },
  newVerNote: { fontSize: 12, color: MUTE, marginTop: 10 },
  footer: { marginTop: 22, paddingTop: 14, borderTop: `1px solid ${LINE}`, fontSize: 12, color: MUTE, lineHeight: 1.5 },
  feedHead: { marginBottom: 4 },
  feedTitle: { fontSize: 17, fontWeight: 700 },
  feedSub: { fontSize: 12, color: MUTE, marginTop: 3 },
  feedFilters: { display: "flex", gap: 6, flexWrap: "wrap" },
  feedFilterBtn: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 20, padding: "5px 12px", fontSize: 12.5, cursor: "pointer" },
  feedFilterOn: { background: PANEL2, color: TEXT, borderColor: "#e8a83855" },
  feedList: { display: "flex", flexDirection: "column", gap: 6 },
  feedItem: { display: "flex", alignItems: "flex-start", gap: 10, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 12px" },
  feedTime: { fontSize: 11, color: MUTE, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, width: 38, paddingTop: 3 },
  feedIcon: { width: 26, height: 26, borderRadius: 7, border: "1px solid", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 },
  feedBody: { flex: 1, minWidth: 0 },
  feedItemTop: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" },
  feedStrat: { fontSize: 12, fontWeight: 700 },
  feedMatch: { fontSize: 11, color: MUTE },
  feedText: { fontSize: 13, color: "#d3d8e0", marginTop: 2, lineHeight: 1.4 },
  feedPnl: { fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, paddingTop: 2 },
  metricExplain: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 8 },
  metricExplainItem: { fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.5 },
  metricHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 },
  metricName: { fontSize: 15, fontWeight: 700 },
  metricSamples: { fontSize: 11.5, color: MUTE, marginLeft: "auto", fontFamily: "'JetBrains Mono', monospace" },
  metricNums: { display: "flex", gap: 8, marginBottom: 14 },
  metricNumCell: { flex: 1, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", textAlign: "center" },
  metricNumLbl: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" },
  metricNumVal: { fontSize: 20, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginTop: 3 },
  metricVerdict: { fontSize: 13, fontWeight: 700, marginTop: 6 },
  calibLabel: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 8 },
  calibRows: { display: "flex", flexDirection: "column", gap: 8 },
  calibRow: { display: "flex", alignItems: "center", gap: 10 },
  calibBucket: { fontSize: 11, color: MUTE, fontFamily: "'JetBrains Mono', monospace", width: 56, flexShrink: 0 },
  calibBar: { flex: 1, height: 16, background: INK, borderRadius: 4, position: "relative", border: `1px solid ${LINE}` },
  calibBarPred: { position: "absolute", left: 0, top: 0, bottom: 0, background: "#5b9bd533", borderRight: "2px solid #5b9bd5", borderRadius: "4px 0 0 4px" },
  calibDot: { position: "absolute", top: "50%", width: 8, height: 8, borderRadius: "50%", background: "#e8a838", transform: "translate(-50%, -50%)", boxShadow: "0 0 0 2px #12161d" },
  calibDiff: { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, width: 32, textAlign: "right", flexShrink: 0 },
  metricWarn: { fontSize: 11.5, color: "#e8a838", background: "#2e2a1a", borderRadius: 8, padding: "8px 12px", marginTop: 12, lineHeight: 1.5 },
  settleHead: { fontSize: 13, color: "#d3d8e0", marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${LINE}` },
  settleStrat: { marginBottom: 12 },
  settleStratHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  settleBet: { display: "flex", alignItems: "center", gap: 10, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 12px", marginBottom: 4, flexWrap: "wrap" },
  settleMarket: { fontSize: 13, fontWeight: 600, flex: 1, minWidth: 100 },
  settleStake: { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: MUTE },
  settleResult: { fontSize: 12, fontWeight: 700 },
  settlePayout: { fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  pfHeader: { marginBottom: 4 },
  pfTitle: { fontSize: 17, fontWeight: 700 },
  pfSub: { fontSize: 12, color: MUTE, marginTop: 3 },
  pfAgg: { display: "flex", alignItems: "center", background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: "12px 8px", flexWrap: "wrap", gap: 8 },
  pfAggCell: { flex: 1, textAlign: "center", minWidth: 110 },
  pfAggLbl: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" },
  pfAggVal: { fontSize: 20, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginTop: 3 },
  pfAggDiv: { width: 1, height: 34, background: LINE },
  pfEmpty: { color: MUTE, padding: 40, textAlign: "center", fontSize: 13, lineHeight: 1.6 },
  pfEmptyBtn: { background: "transparent", border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, cursor: "pointer", marginLeft: 8 },
  pfGroupToggle: { display: "flex", alignItems: "center", gap: 6 },
  pfGroupLbl: { fontSize: 12, color: MUTE, marginRight: 4 },
  pfGroupBtn: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 20, padding: "5px 14px", fontSize: 12.5, cursor: "pointer" },
  pfGroupOn: { background: PANEL2, color: TEXT, borderColor: "#e8a83855" },
  pfGroup: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14 },
  pfGroupHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${LINE}` },
  pfGroupName: { fontSize: 14, fontWeight: 700 },
  pfGroupStake: { fontSize: 11.5, color: MUTE, fontFamily: "'JetBrains Mono', monospace", marginLeft: "auto" },
  pfGroupLive: { fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  pfPosList: { display: "flex", flexDirection: "column", gap: 6 },
  pfPos: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 12px" },
  pfPosLeft: { minWidth: 0, flex: 1 },
  pfPosMarket: { fontSize: 13.5, fontWeight: 600 },
  pfPosMeta: { fontSize: 11, color: MUTE, marginTop: 2 },
  pfPosEntered: { color: "#6b7686" },
  pfPosRight: { textAlign: "right", flexShrink: 0 },
  pfPosStake: { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "#c3c9d3" },
  pfPosLiveWrap: { display: "flex", gap: 8, alignItems: "baseline", justifyContent: "flex-end", marginTop: 2 },
  pfPosNow: { fontSize: 11, color: "#e8a838", fontFamily: "'JetBrains Mono', monospace" },
  pfPosLive: { fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  tabSelect: { width: "100%", background: PANEL2, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 8, padding: "9px 12px", fontSize: 13, fontWeight: 600, marginBottom: 12 },
  modelBadge: { fontSize: 10, color: "#7fb4e8", background: "#1e2836", border: "1px solid #5b9bd544", borderRadius: 20, padding: "2px 9px", fontFamily: "'JetBrains Mono', monospace" },
  modelSelect: { background: INK, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 8, padding: "7px 10px", fontSize: 12.5, cursor: "pointer", maxWidth: "100%" },
  modelSelectEmpty: { background: "transparent", border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "7px 12px", fontSize: 12, cursor: "pointer" },
  modelPickRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  modelPickLbl: { fontSize: 12, color: MUTE, fontWeight: 600 },
  analysisCard: { background: PANEL, border: `1px solid #5b9bd555`, borderRadius: 14, padding: 14 },
  analysisCardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" },
  analysisTitle: { fontSize: 15, fontWeight: 700, color: "#7fb4e8" },
  analysisModelPick: { display: "flex", alignItems: "center", gap: 8 },
  analysisModelLbl: { fontSize: 12, color: MUTE },
  masterDetail: { display: "block" },
  mdList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 },
  mdItem: { textAlign: "left", background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 12px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 2 },
  mdItemOn: { borderColor: "#5b9bd5", background: "#1a2430" },
  mdItemName: { fontSize: 13, fontWeight: 600, color: TEXT },
  mdItemTag: { fontSize: 10.5 },
  mdContent: { minWidth: 0 },
  mdHint: { fontSize: 11.5, color: "#c3c9d3", background: PANEL2, borderRadius: 8, padding: "8px 12px", lineHeight: 1.5, marginBottom: 8 },
  mdTextarea: { width: "100%", minHeight: 200, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, color: TEXT, padding: "10px 12px", fontSize: 13, lineHeight: 1.55, resize: "vertical", fontFamily: "'JetBrains Mono', monospace" },
  modelsIntro: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, padding: 16 },
  modelsTitle: { fontSize: 16, fontWeight: 700 },
  modelsSub: { fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.55, marginTop: 6 },
  providerHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  providerName: { fontSize: 15, fontWeight: 700 },
  providerStatus: { fontSize: 11, border: "1px solid", borderRadius: 20, padding: "2px 10px", fontWeight: 600 },
  keyRow: { display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" },
  keyInput: { flex: 1, minWidth: 180, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, color: TEXT, padding: "9px 12px", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" },
  keyReveal: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 8, padding: "9px 12px", fontSize: 12, cursor: "pointer" },
  keyClear: { background: "transparent", border: `1px solid #ff6b6b44`, color: "#ff6b6b", borderRadius: 8, padding: "9px 12px", fontSize: 12, cursor: "pointer" },
  modelChips: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" },
  modelChipsLabel: { fontSize: 11, color: MUTE },
  modelChip: { fontSize: 11.5, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 20, padding: "3px 10px", color: "#c3c9d3", fontFamily: "'JetBrains Mono', monospace" },
  modelsNote: { fontSize: 11.5, color: MUTE, lineHeight: 1.5, background: "#2e2a1a", borderRadius: 8, padding: "10px 12px", borderLeft: "2px solid #e8a838" },
  dataProgress: { marginTop: 12, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px" },
  dataProgressTop: { display: "flex", justifyContent: "space-between", fontSize: 11.5, color: MUTE, marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" },
  dataBar: { height: 6, background: PANEL2, borderRadius: 3, overflow: "hidden" },
  dataBarFill: { height: "100%", borderRadius: 3 },
};
