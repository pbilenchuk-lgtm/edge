// ============================================================
// EDGE LAB — deterministic PRE-LLM gate for the live strategist reassessment.
//
// The costliest inefficiency on a quiet match: the periodic heartbeat re-runs the
// live strategist on EVERY timepoint even when there is provably nothing to do —
// a 0:0 match with no open position and no live setup that could fire. That is the
// live twin of the pre-match "Model B" waste. §9.6 stays intact: this gate never
// makes a MONEY decision — it only answers a deterministic yes/no ("could this
// strategist possibly act right now?") and, when the answer is provably no, skips
// the LLM call. It FAILS OPEN: any ambiguity → call the strategist as before.
//
//  · prematch_value (live role = defend open positions): empty portfolio → skip.
//  · overreaction   (entries ONLY via an armed buyback trigger): call only when at
//    least one armed trigger's deterministic preconditions (depth/event, time
//    window) are met or near. No live trigger → skip.
//  · live_xg        (enters off the live-xG feed — needs LLM judgment): NEVER gated.
//
// The gate is applied ONLY on a PERIODIC (time heartbeat) tick. A real event — goal,
// red card, price move — always runs the strategist untouched (that is exactly when
// a buyback fires or the rare PMV exception applies).
// ============================================================

/** Upper time bound (minute) parsed from a trigger's window text, if any. */
function parseMinuteCap(txt: string): number | null {
  let cap: number | null = null;
  // Any minute-looking number ("до ~30'", "30 мин", "первые 25") — take the LARGEST as
  // the window's upper bound (a range like "20–30'" ⇒ 30). Ignore implausible values.
  for (const mtch of txt.matchAll(/(\d{1,3})\s*(?:['′’]|мин|min|m\b)?/gi)) {
    const n = Number(mtch[1]);
    if (Number.isFinite(n) && n > 0 && n <= 130 && (cap == null || n > cap)) cap = n;
  }
  return cap;
}

/** Join a trigger object's stringy fields into one lowercased blob for keyword tests. */
function triggerBlob(t: unknown): string {
  if (t == null) return "";
  if (typeof t === "string") return t.toLowerCase();
  if (typeof t !== "object") return String(t).toLowerCase();
  const parts: string[] = [];
  for (const v of Object.values(t as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number") parts.push(String(v));
  }
  return parts.join(" · ").toLowerCase();
}

/** Time-window text of a single armed trigger (best-effort field lookup). */
function windowText(t: unknown): string {
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    for (const k of ["time_window", "time", "window", "time_condition"]) {
      const v = o[k];
      if (typeof v === "string") return v;
    }
  }
  return "";
}

export type ArmedResult =
  | { kind: "triggers"; list: unknown[] } // parsed plan WITH armed triggers
  | { kind: "none" }                      // no battle sheet / parsed plan, but zero armed triggers
  | { kind: "unparsed" };                 // battle sheet present but not JSON we understand

/** Extract the armed-trigger list from a battle-sheet artifact's JSON content. */
export function armedTriggers(battleSheet: string | null | undefined): ArmedResult {
  if (battleSheet == null || battleSheet.trim() === "") return { kind: "none" };
  let bs: any;
  try { bs = JSON.parse(battleSheet); } catch { return { kind: "unparsed" }; }
  const arr = Array.isArray(bs?.live_triggers_armed) ? bs.live_triggers_armed
    : Array.isArray(bs?.strategist_plan?.live_triggers_armed) ? bs.strategist_plan.live_triggers_armed
    : null;
  if (arr == null) return { kind: "none" }; // a real, parsed plan that armed nothing → no entry basis
  return { kind: "triggers", list: arr };
}

const TIME_BUFFER_MIN = 10; // generous slack past a window before we treat a trigger as dead

export interface LiveState {
  totalGoals: number;   // score_home + score_away
  minute: number | null; // provider minute, else the timer estimate; null when unknown
  // [P5 / batch-9] Deterministic cost pre-filter inputs. Batch 9: overreaction produced ZERO entries across 18
  // football matches while arming ~80 buyback triggers — every armed-and-in-window tick still woke the LLM.
  // Freezing the strategy was REJECTED (a gate matures only through cycles; a freeze buries it without a
  // verdict), so instead the call must also clear two measurable pre-conditions that any real buyback needs:
  // a panic actually deep enough to buy back, and a book deep enough to fill. Both undefined → fail OPEN.
  panicDropCents?: number | null;   // biggest adverse move (¢) on a tracked market since its pre-panic anchor
  bookUsd?: number | null;          // depth of the deepest tracked market ($)
}
// Env-tunable floors; defaults are deliberately permissive so the filter cuts cost, never a real setup.
const ovrNum = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
export const OVR_MIN_PANIC_CENTS = () => ovrNum(process.env.OVR_MIN_PANIC_CENTS, 6);
export const OVR_MIN_BOOK_USD = () => ovrNum(process.env.OVR_MIN_BOOK_USD, 500);

/**
 * Should the OVERREACTION live strategist be CALLED on a periodic tick, given its armed
 * triggers and the current live state? Fails OPEN — any ambiguity returns true.
 *
 * Deterministic reasoning (mirrors the strategy's own iron rule "entries ONLY via an armed
 * buyback trigger with depth+price+time all met"):
 *  · no armed triggers at all  → no entry is possible → skip (false)
 *  · a battle sheet we can't parse → can't prove there's no setup → call (true)
 *  · else, a trigger is "live" when it is not clearly past its time window AND its
 *    triggering EVENT could have happened. The overreaction edge is a comeback buyback
 *    after an early underdog GOAL or RED CARD; at 0:0 with no red-card-keyed trigger there
 *    is, by definition, no panic to buy back → those triggers are dormant. Any single live
 *    trigger → call; every trigger dormant/expired → skip.
 */
export type GateDecision = { call: true } | { call: false; reason: string };

/**
 * Reasoned form of overreactionShouldCall (P0.4): returns WHY the strategist is being skipped so the
 * deterministic disarm is visible in the trade log. A trigger is DISARMED IN CODE the moment its window
 * passes OR its event precondition is contradicted by the live state — a disarmed trigger never wakes the
 * LLM. Fails OPEN (call:true) on any ambiguity.
 */
export function overreactionGate(battleSheet: string | null | undefined, live: LiveState): GateDecision {
  const a = armedTriggers(battleSheet);
  if (a.kind === "unparsed") return { call: true }; // can't verify → don't risk skipping a real setup
  if (a.kind === "none") return { call: false, reason: "нет заряженных buyback-триггеров — вход невозможен" };
  let expired = 0, dormant = 0;
  for (const t of a.list) {
    const blob = triggerBlob(t);
    const cap = parseMinuteCap(windowText(t));
    const withinWindow = cap == null || live.minute == null || live.minute <= cap + TIME_BUFFER_MIN;
    if (!withinWindow) { expired++; continue; } // window has passed → this trigger can no longer fire
    // Event precondition: a goal-panic buyback needs a goal on the board. At 0:0 only a
    // red-card-keyed trigger can be live (and red cards aren't in the score → fail open on them).
    if (live.totalGoals === 0) {
      const redCardKeyed = /удал|красн|red[\s_-]?card/i.test(blob);
      if (!redCardKeyed) { dormant++; continue; } // goal-keyed trigger, but no goal yet → dormant
    }
    // [P5] An armed, in-window, event-matched trigger is necessary but no longer SUFFICIENT to pay for an LLM
    // call. A buyback needs something to buy back (a real panic) on a book that can fill it. Both readings are
    // optional: when either is absent we fail OPEN exactly as before, so nothing real is ever cut blind.
    const panic = live.panicDropCents, book = live.bookUsd;
    if (panic != null && panic < OVR_MIN_PANIC_CENTS()) {
      return { call: false, reason: `триггер заряжен и в окне, но паника всего ${Math.round(panic)}¢ < порога ${OVR_MIN_PANIC_CENTS()}¢ — выкупать нечего (пре-фильтр стоимости)` };
    }
    if (book != null && book < OVR_MIN_BOOK_USD()) {
      return { call: false, reason: `триггер заряжен и в окне, но книга $${Math.round(book)} < пола $${OVR_MIN_BOOK_USD()} — выкуп неисполним (пре-фильтр стоимости)` };
    }
    return { call: true }; // armed + in-window + event matched + panic/book clear the floors → let the strategist judge
  }
  // Every armed trigger is expired or not yet triggerable → deterministic skip (all disarmed by code).
  const n = a.list.length;
  const why = expired && dormant ? `окно истекло у ${expired}, событие не наступило у ${dormant}`
    : expired ? `окно истекло (мин ${live.minute ?? "?"})`
    : `нет матчащего события при счёте ${live.totalGoals}:0-типа`;
  return { call: false, reason: `все ${n} заряженных триггер(ов) разоружены: ${why}` };
}

export function overreactionShouldCall(battleSheet: string | null | undefined, live: LiveState): boolean {
  return overreactionGate(battleSheet, live).call;
}
