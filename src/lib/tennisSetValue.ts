// ============================================================
// EDGE LAB — TENNIS Set-Value: the SECOND tennis strategy (paper). Deterministic charge/gate
// + prompt text; the money-loop lives in tennisTrading (tennisSetValueTick / tennisExitTick).
//
// THESIS: in bo3 the market systematically OVER-sells a favourite who LOSES set 1 IF that set
// was competitive — the price drops deeper than P(win match) actually moves. Set-Value buys the
// favourite after the lost first set and HOLDS to resolution (horizon = the MATCH), unlike
// Overreaction (horizon = minutes, an intra-set break snapback).
//
// DIVORCE FROM OVERREACTION (hard rule, code): the "favourite lost set 1" trigger (Overreaction's
// old trigger #2) moves ENTIRELY here. Overreaction keeps ONLY intra-set breaks. One match holds
// at most ONE tennis buyback across BOTH strategies (cross-strategy block in the entry tick).
//
// §9.6: the LLM judges ONLY "competitive set vs blowout" (+ retire-risk); CODE decides
// side / price-band / size / exit. Armed numbers are INTERIM constants until the set_won
// calibration cut (≥40 setups) replaces them; do NOT hand-tune from the first bets (epoch
// discipline). Markov core is deliberately NOT built — the comeback probability is a constant.
// ============================================================

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export const SET_VALUE_STRATEGY = "tennis_set_value";

// INTERIM armed numbers (cents / probability). Replaced from the set_won calibration cut; env-tunable.
export const SET_VALUE_ARMED = {
  // Entry price band for the favourite's moneyline AFTER losing set 1 (was ≥60¢ pre-match).
  bandLowCents: num(process.env.TENNIS_SV_BAND_LOW, 30),
  bandHighCents: num(process.env.TENNIS_SV_BAND_HIGH, 45),
  // HARD floor: below this the market likely knows something we don't (injury / real level gap) — never enter.
  hardFloorCents: num(process.env.TENNIS_SV_HARD_FLOOR, 25),
  // Partial take: the favourite climbed back into this band → the comeback is priced, fix HALF, hold the rest.
  takeLowCents: num(process.env.TENNIS_SV_TAKE_LOW, 55),
  takeFraction: Math.min(1, Math.max(0.1, num(process.env.TENNIS_SV_TAKE_FRACTION, 0.5))),
  // Catastrophic floor (¢ below entry): a real collapse before the comeback, phantom-guarded backstop.
  floorBelowEntryCents: num(process.env.TENNIS_SV_FLOOR, 12),
  // thesis_stop: broken in set 2 and did NOT break back within this many receiving games → out.
  thesisStopReceiverGames: Math.max(1, Math.round(num(process.env.TENNIS_SV_THESIS_K, 2))),
  // Interim P(favourite comeback) for a COMPETITIVE lost set — the edge = this − price. Calibrated later.
  comebackProb: Math.min(0.95, Math.max(0.05, num(process.env.TENNIS_SV_COMEBACK_PROB, 0.5))),
};

// Armed-threshold epoch. INTERIM until ≥40 set_won setups accumulate on the moneyline; then "calibrated".
export const SET_VALUE_EPOCH = process.env.TENNIS_SV_EPOCH || "interim";

// Grand-Slam men's singles are best-of-FIVE (different comeback math) — Set-Value trades bo3 ONLY.
const GRAND_SLAM_RE = /australian open|roland garros|french open|wimbledon|us open|us\.? open/i;
/** Best-of-five ⇒ NOT tradeable by Set-Value (bo3 only). A Grand Slam men's singles is bo5; WTA
 *  (women bo3 even at slams) and doubles are not. Conservative: only a GS men's-singles reads bo5. */
export function isBestOfFive(eventType: string | null | undefined, tournament: string | null | undefined): boolean {
  const hay = `${eventType ?? ""} ${tournament ?? ""}`;
  if (!GRAND_SLAM_RE.test(tournament ?? "")) return false; // only Grand Slams are bo5
  if (/women|wta|\bgirls\b/i.test(hay)) return false;      // women play bo3 even at slams
  if (/doubles|\/|mixed/i.test(hay)) return false;         // doubles is out of scope anyway
  return true; // Grand Slam, men's singles ⇒ bo5
}

export type SetValueSkip = "no_favourite" | "thin_book" | "not_lost_set1" | "bo5" | "market_knows" | "no_panic" | "below_band" | "armed";
export interface SetValueGate { armed: boolean; skip: SetValueSkip; note: string; edge: number | null }

/**
 * DETERMINISTIC pre-LLM gate for Set-Value. Preconditions (all CODE):
 *   • a favourite exists (reuse Overreaction's favourite-ID, passed in via favSide/favPrice)
 *   • the match is a tradeable bo3 (not a Grand Slam men's bo5)
 *   • the favourite LOST set 1 (down exactly 0-1 sets, now in set 2)
 *   • the favourite's moneyline price sits in the armed band [bandLow, bandHigh]; below hardFloor
 *     the market knows more than us (skip), above bandHigh there's no panic to buy (skip).
 * Returns armed + the interim edge (comebackProb − price) for the sizer. LLM judges the rest.
 */
export function setValueGate(o: {
  favSide: "first" | "second" | null; tradeable: boolean;
  favPriceCents: number | null; favSetsWon: number; favSetsLost: number; setNum: number | null;
  eventType: string | null; tournament: string | null;
}): SetValueGate {
  const mk = (skip: SetValueSkip, note: string, edge: number | null = null): SetValueGate => ({ armed: skip === "armed", skip, note, edge });
  if (!o.favSide) return mk("no_favourite", "нет явного фаворита — сетапа нет");
  if (!o.tradeable) return mk("thin_book", "книга манилайна ниже порога");
  if (isBestOfFive(o.eventType, o.tournament)) return mk("bo5", "Grand Slam мужской сингл = bo5 — не наш формат");
  // "Lost set 1" (bo3): down EXACTLY 0-1 in sets, now in set 2. favSetsWon>0 → already levelled/ahead → not our setup.
  const lostSet1 = o.favSetsLost >= 1 && o.favSetsWon === 0;
  if (!lostSet1) return mk("not_lost_set1", `фаворит не проиграл ровно 1-й сет (выиграно ${o.favSetsWon}, проиграно ${o.favSetsLost})`);
  if (o.favPriceCents == null) return mk("below_band", "нет цены фаворита — не заряжаем");
  if (o.favPriceCents < SET_VALUE_ARMED.hardFloorCents) return mk("market_knows", `фаворит ${o.favPriceCents}¢ < ${SET_VALUE_ARMED.hardFloorCents}¢ — рынок знает больше (травма/уровень), не входим`);
  if (o.favPriceCents > SET_VALUE_ARMED.bandHighCents) return mk("no_panic", `фаворит ${o.favPriceCents}¢ > ${SET_VALUE_ARMED.bandHighCents}¢ — недостаточно перепродан (камбэк уже в цене)`);
  if (o.favPriceCents < SET_VALUE_ARMED.bandLowCents) return mk("below_band", `фаворит ${o.favPriceCents}¢ ниже полосы ${SET_VALUE_ARMED.bandLowCents}-${SET_VALUE_ARMED.bandHighCents}¢ (interim)`);
  const edge = SET_VALUE_ARMED.comebackProb - o.favPriceCents / 100;
  return mk("armed", `фаворит проиграл сет 1 @ ${o.favPriceCents}¢ (полоса ${SET_VALUE_ARMED.bandLowCents}-${SET_VALUE_ARMED.bandHighCents}¢), edge ${(edge * 100).toFixed(1)}%`, edge);
}

// ── Prompt pair (seeded as the tennis_set_value strategy) ──
export const STRAT_SET_VALUE_PREMATCH = `# [ОКНО: ПРЕДМАТЧ] ТЕННИС — SET-VALUE (v1, interim)

Ты готовишь стоимостную покупку фаворита ПОСЛЕ проигранного 1-го сета (bo3, ATP/WTA синглы).
Горизонт — МАТЧ (не минуты): рынок перевешивает проигранный сет и недооценивает класс фаворита.

## ЧТО ТАКОЕ ТВОЙ EDGE
Фаворит проигрывает 1-й сет → winner-рынок роняет его цену ГЛУБЖЕ, чем реально сдвинулась
P(выиграть матч), ЕСЛИ сет был конкурентным (6-4/7-5/7-6, ровная статистика). Покупаешь фаворита
в полосе 30-45¢ и держишь до разрешения тезиса финалом (частичная фиксация на возврате).

## ЗАРЯДКА (минимум, без марковского ядра)
- Фаворит определяется ЦЕНОЙ Polymarket (та же армед-логика, что у Overreaction).
- Формат bo3. Grand Slam мужской сингл (bo5) — НЕ торгуем.
- Триггер: фаворит проиграл 1-й сет, цена в полосе 30-45¢ (ниже 25¢ — не входим, рынок знает больше).

## ВЫХОД (battle_sheet) — строгий JSON
\`\`\`
{ "strategist": "tennis_set_value", "phase": "prematch",
  "favourite": "first|second|none", "favourite_price_cents": ,
  "armed": { "trigger": "lost_first_set", "band_cents": "30-45", "hard_floor_cents": 25, "thresholds": "interim" },
  "notes": "" }
\`\`\``;

export const STRAT_SET_VALUE_LIVE = `# [ОКНО: LIVE] ТЕННИС — SET-VALUE (v1, interim)

Исполняешь заряженный триггер «фаворит проиграл 1-й сет». Не строишь стратегию заново.

## ЖЕЛЕЗНАЯ ГРАНИЦА ВХОДА (нарушать нельзя)
Вход разрешён ТОЛЬКО как исполнение триггера, у которого ОДНОВРЕМЕННО:
(1) фаворит ПРОИГРАЛ 1-й сет (bo3, счёт по сетам 0-1), (2) цена winner фаворита в полосе 30-45¢.
open_new вне триггера запрещён.

## ГЛАВНОЕ СУЖДЕНИЕ — КОНКУРЕНТНЫЙ СЕТ vs РАЗГРОМ (тут ты и нужен)
Конкурентный сет (6-4 / 7-5 / 7-6, равная статистика геймов, брейки взаимны) = тезис ВАЛИДЕН,
рынок перепродал, ПОКУПАЕМ. Разгром (6-1 / 6-2 или серия брейков подряд, фаворит физически не
тянет) = фаворит РЕАЛЬНО не в порядке, СКИП. Судишь по счёту 1-го сета и брейк-паттерну.

## РЕТАЙР-РИСК
Упоминание medical timeout в статусе / паттерн отдаваемых геймов «под ноль» → СКИП (осторожность).

## ВЫХОД (дисциплина, детерминированный код исполнит)
- Частичная фиксация 50% при возврате фаворита к 55-60¢ (камбэк оценён), остаток — до финала.
- thesis_stop: сломан во 2-м сете и НЕ вернул брейк за 2 приёмных гейма → выход полностью.
- catastrophic_floor: вход − 12¢ (реальный бид). retire/финал — сеттл.

## ВЫХОД (actions) — строгий JSON
\`\`\`
{ "strategist": "tennis_set_value", "phase": "live",
  "set_context": { "lost_set": 1, "set_score": "6-4|7-5|7-6|6-1|6-2|…", "fav_price_cents": },
  "competitive_check": { "verdict": "competitive|blowout", "reason": "как проигран сет 1" },
  "retire_risk": { "flag": true|false, "reason": "" },
  "actions": [ { "market": , "action": "open_new|hold", "side": , "price": , "size_pct": ,
                 "reason": , "armed_trigger": "lost_first_set" } ],
  "notes": "" }
\`\`\``;
