// ============================================================
// EDGE LAB — time helpers. Kickoffs are stored as ISO timestamps and shown in
// Europe/Warsaw (the user's timezone), with the weekday.
// ============================================================

const WARSAW = "Europe/Warsaw";

/** Is this string an ISO-8601 timestamp we can schedule/format on? */
export function isIso(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}T/.test(s) && !isNaN(Date.parse(s));
}

/** "пн, 20:45" — weekday + HH:MM in Warsaw. Passes non-ISO strings through. */
export function warsawLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  if (!isIso(iso)) return iso; // already a human string (e.g. ESPN "63'")
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("ru-RU", { timeZone: WARSAW, weekday: "short" }).format(d);
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone: WARSAW, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  const date = new Intl.DateTimeFormat("ru-RU", { timeZone: WARSAW, day: "2-digit", month: "2-digit" }).format(d);
  return `${day} ${date}, ${time}`; // "пн 07.07, 20:45"
}

/** "20:45" — compact HH:MM in Warsaw for log / reassessment timestamps. Passes
 *  non-ISO strings through as null (so the UI cleanly omits a non-timestamp). */
export function warsawClock(iso: string | null | undefined): string | null {
  if (!isIso(iso)) return null;
  const d = new Date(iso);
  return new Intl.DateTimeFormat("ru-RU", { timeZone: WARSAW, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

/** "1 ч 52 мин" from two ISO instants (kickoff → finish), or null when either isn't
 *  ISO, they're out of order, or the span is implausibly long (>6h — a bad kickoff). */
export function durationLabel(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  if (!isIso(startIso) || !isIso(endIso)) return null;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!(ms > 0) || ms > 6 * 3_600_000) return null;
  const mins = Math.round(ms / 60_000), h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

/** Warsaw finish-stamp fields for a match transitioning into "finished": the finish
 *  clock (HH:MM Warsaw), the kickoff clock, and the elapsed duration — so a card shows
 *  «завершён 22:01» / «20:00–22:01 · длительность 2 ч 01 мин» instead of a bare «финал».
 *  end_time is always set (nowIso is a real instant); kickoff_time/duration only when
 *  derivable. Apply on EVERY path that flips a match to finished (ESPN enrich, the poll,
 *  the clock auto-finish) — else covered matches finished via ESPN never get a time. */
export function finishStamp(
  kickoffAtIso: string | null | undefined, nowIso: string,
): { end_time: string | null; kickoff_time?: string; duration?: string } {
  const patch: { end_time: string | null; kickoff_time?: string; duration?: string } = { end_time: warsawClock(nowIso) };
  const kt = warsawClock(kickoffAtIso);
  if (kt) patch.kickoff_time = kt;
  const dur = durationLabel(kickoffAtIso, nowIso);
  if (dur) patch.duration = dur;
  return patch;
}

/** Hours from `nowMs` until the kickoff (negative if already started); null if unknown. */
export function hoursUntil(iso: string | null | undefined, nowMs: number): number | null {
  if (!isIso(iso)) return null;
  return (Date.parse(iso) - nowMs) / 3_600_000;
}
