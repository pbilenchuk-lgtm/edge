// ============================================================
// EDGE LAB — TENNIS Overreaction (§5): prompts + deterministic charge + pre-LLM gate.
//
// Transfer of the football Overreaction v2 to tennis. The edge: a FAVOURITE loses a service
// game (a break) early / after dropping set 1 → the winner market over-reacts → buy the
// favourite back cheap, exit on the recovery. Iron border (like football): an entry is ONLY
// the execution of an ARMED trigger whose deterministic preconditions are met. No open_new
// outside a trigger. The LLM judges only real_shift vs overreaction (context of games/points);
// the CODE decides side/window/price and sizing (§9.6).
//
// This module is the DETERMINISTIC half (charge + gate + interim armed prices) + the prompt
// text. Wiring it into the paper money-loop is §6 (pending §4 panic calibration). Armed prices
// here are INTERIM constants (tagged thresholds:"interim") — replaced from tennis_break_marks.
// ============================================================

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// Armed prices (cents). INTERIM constants: the 105 §4 break marks that once "validated" these were
// measured on PROP prices, not the moneyline (BACKLOG "price layer = the MONEYLINE"), so they're
// discarded. The moneyline panic amplitude is almost certainly LARGER than a game-total prop's, so
// these bands will likely widen once ~100 marks re-accumulate on the moneyline. Env-tunable.
export const TENNIS_ARMED = {
  // A side priced ≤ this (¢) is the clear UNDERDOG ⇒ the other side is the favourite we buy back.
  favUnderdogMax: num(process.env.TENNIS_FAV_UNDERDOG_MAX, 40),
  // Trigger #1 — favourite broken in set 1 / early set 2: buy the favourite's winner if it dipped ≤ this.
  earlyBreakBuyMax: num(process.env.TENNIS_EARLY_BREAK_BUY_MAX, 55),
  // Trigger #2 — favourite LOST set 1 (bo3): panic is deepest; buy if ≤ this.
  lostFirstSetBuyMax: num(process.env.TENNIS_LOST_SET_BUY_MAX, 45),
  // Fail-open price buffer around the armed buyback before we bother the LLM.
  nearBuffer: num(process.env.TENNIS_NEAR_BUFFER, 10),
};

// NOTE: "lost_first_set" (the old trigger #2) has moved ENTIRELY to the Set-Value strategy
// (tennisSetValue.ts). Overreaction now arms ONLY the intra-set break (snapback horizon = minutes).
export type TennisTriggerId = "early_break";
export interface ArmedTennisTrigger { id: TennisTriggerId; favSide: "first" | "second"; buybackMaxCents: number; window: string; thresholds: "interim" | "calibrated" }
export interface TennisCharge { favSide: "first" | "second" | null; favPriceCents: number | null; triggers: ArmedTennisTrigger[]; note: string }

/**
 * DETERMINISTIC pre-match charge (minimal Layer-1, NO Markov): identify the favourite by
 * Polymarket winner prices and arm the two buyback triggers with INTERIM prices. A favourite
 * exists only when one side is a clear underdog (≤ favUnderdogMax); otherwise (a coin-flip
 * match) there is no overreaction setup and nothing is armed.
 */
export function chargeTennisTriggers(winner: { p1Cents: number | null; p2Cents: number | null }): TennisCharge {
  const { p1Cents, p2Cents } = winner;
  if (p1Cents == null || p2Cents == null) return { favSide: null, favPriceCents: null, triggers: [], note: "нет winner-цен — не заряжаем" };
  let favSide: "first" | "second" | null = null;
  if (p2Cents <= TENNIS_ARMED.favUnderdogMax && p1Cents > p2Cents) favSide = "first";
  else if (p1Cents <= TENNIS_ARMED.favUnderdogMax && p2Cents > p1Cents) favSide = "second";
  if (!favSide) return { favSide: null, favPriceCents: null, triggers: [], note: "нет явного фаворита (обе стороны > порога андердога) — сетапа нет" };
  const favPriceCents = favSide === "first" ? p1Cents : p2Cents;
  return {
    favSide, favPriceCents,
    // ONLY the intra-set break (snapback). "Lost set 1" is Set-Value's trigger now (см. развод).
    triggers: [
      { id: "early_break", favSide, buybackMaxCents: TENNIS_ARMED.earlyBreakBuyMax, window: "сет 1 / начало сета 2", thresholds: "interim" },
    ],
    note: `фаворит = ${favSide} @ ${favPriceCents}¢; заряжен триггер early_break (interim)`,
  };
}

export interface TennisBreakSignal { brokenSide: "first" | "second"; setNum: number; favSetsLost: number; favPriceCents: number | null }

/**
 * Pre-LLM gate (port of reassessGate): the strategist is called ONLY when a break plausibly
 * executes an armed trigger. Deterministic preconditions — the FAVOURITE was broken (not the
 * underdog), inside an armed window (early break, or after losing set 1), and the favourite's
 * winner price is near/below the armed buyback. Fail-OPEN on unknown price (don't silently
 * skip a real setup); definitive non-setups (no favourite, underdog broken, wrong window) skip.
 */
export function tennisReassessShouldCall(charge: TennisCharge, s: TennisBreakSignal): boolean {
  if (!charge.favSide) return false;                 // no favourite armed → no entry possible
  if (s.brokenSide !== charge.favSide) return false; // the UNDERDOG was broken → not our setup
  // ONLY the intra-set EARLY break (set 1 / start of set 2, no set yet lost). After the favourite
  // has LOST a set the setup belongs to Set-Value (longer horizon) — Overreaction stays out.
  const earlyWindow = s.setNum <= 1 || (s.setNum === 2 && s.favSetsLost === 0);
  if (!earlyWindow) return false;                    // outside the early-break window (or a set already lost)
  if (s.favPriceCents == null) return true;          // can't verify price → call (fail-open)
  return s.favPriceCents <= TENNIS_ARMED.earlyBreakBuyMax + TENNIS_ARMED.nearBuffer; // near/below the armed buyback
}

// ── Prompt pair (ready for §6 to seed as the tennis_overreaction strategy) ──
export const STRAT_TENNIS_OVR_PREMATCH = `# [ОКНО: ПРЕДМАТЧ] ТЕННИС — OVERREACTION (v1, interim)

Ты готовишь выкуп переоценки в теннисе (bo3, ATP/WTA синглы). Задача предматча — НЕ набрать
позиции, а ЗАРЯДИТЬ триггеры выкупа фаворита в live. Основной капитал разворачивается в live.

## ЧТО ТАКОЕ ТВОЙ EDGE
Фаворита ЛОМАЮТ на подаче рано (сет 1 / начало сета 2) → winner-рынок переоценивает падение →
выкупаешь фаворита дёшево → выходишь на возврате за минуты (снапбек). Узкий, редкий edge.
(Проигранный 1-й сет — это уже ДРУГАЯ стратегия, Set-Value, с горизонтом в матч; сюда не входит.)

## ЗАРЯДКА (минимум, без марковского ядра)
- Фаворит определяется ЦЕНОЙ Polymarket: сторона с ценой ≤ порога андердога делает другую фаворитом.
  Нет явного фаворита (обе близко к 50¢) → сетапа нет, не заряжай.
- Формат bo3.
- Армед-цены — ВРЕМЕННЫЕ КОНСТАНТЫ (thresholds=interim), заменяются калибровкой из разметки брейков.
- Триггер (единственный): фаворит теряет подачу в сете 1 / начале сета 2 → выкуп winner фаворита ниже армед-X.

## ВЫХОД (battle_sheet) — строгий JSON
\`\`\`
{ "strategist": "tennis_overreaction", "phase": "prematch",
  "favourite": "first|second|none", "favourite_price_cents": ,
  "live_triggers_armed": [
    { "id": "early_break", "buyback_target_cents": , "window": "сет1/нач.сета2", "thresholds": "interim" } ],
  "notes": "" }
\`\`\``;

export const STRAT_TENNIS_OVR_LIVE = `# [ОКНО: LIVE] ТЕННИС — OVERREACTION (v1, interim)

Исполняешь заряженные триггеры выкупа фаворита. Не строишь стратегию заново.

## ЖЕЛЕЗНАЯ ГРАНИЦА ВХОДА (нарушать нельзя)
Вход разрешён ТОЛЬКО как исполнение заряженного триггера, у которого ОДНОВРЕМЕННО:
(1) сломали ФАВОРИТА (не андердога), (2) в окне триггера (ранний брейк / после проигранного сета 1),
(3) цена winner фаворита дошла до buyback_target. Нет — входов НЕТ. open_new вне триггера запрещён.

## ФИЛЬТР real_shift (главное суждение — тут ты и нужен)
Брейк «из ниоткуда» при ровной игре (фаворит держался на приёме, очки близкие) = ПЕРЕОЦЕНКА, выкуп ВАЛИДЕН.
Брейк на фоне тотального провала фаворита (сыпется на подаче, проигрывает приём всухую, физически не тянет)
= РЕАЛЬНЫЙ СДВИГ, НЕ выкупать. Судишь по контексту счёта геймов/очков, не по одному брейку.

## MISSED-WINDOW GUARD
Цена уже вернулась к предбрейковой (паника отыграна) → НЕ догонять. Выкуп имеет смысл только пока цена в панике.

## ВЫХОД (дисциплина)
Ловишь ВОЗВРАТ: тейк около цены ДО брейка минус запас; не держишь до конца матча.
thesis_stop: второй брейк подряд (фаворит реально сыпется) / признаки ретайра → немедленный выход.

## ВЫХОД (actions) — строгий JSON
\`\`\`
{ "strategist": "tennis_overreaction", "phase": "live",
  "break_context": { "broken": "first|second", "set": , "fav_sets_lost": , "fav_price_cents": },
  "real_shift_check": { "verdict": "overreaction|real_shift", "reason": "чем набран брейк" },
  "actions": [ { "market": , "action": "open_new|add|reduce|close|hold", "side": , "price": , "size_pct": ,
                 "reason": , "armed_trigger": "early_break|lost_first_set — чем выполнены side/window/price" } ],
  "notes": "" }
\`\`\``;
