// ============================================================
// EDGE LAB — DRAW CANON PROBE  [G5, batch-11 ТЗ]
//
// Batch 11 showed 396 notation_desync quarantines on Draw books, four Draw notations per match cycling in and
// out of quarantine ~10 times each — and not one canon line in 53 logs. The tempting conclusion was a "double
// lock": the family gate demotes Draw to shadow AND the quarantine blocks the very book the canon would pick.
//
// Reading the code first killed half of that. The canon runs at the FILL CHOKE — it is reached only when a
// Draw bet arrives there, and in this batch none ever did (prematch_value trades totals only, overreaction
// declined Draw by itself). So zero canon lines is a CONSEQUENCE of never proposing a Draw, not evidence the
// canon is broken. The two are indistinguishable from the logs, which is exactly why the ТЗ asked to measure
// before deciding anything.
//
// This probe separates them. It runs the canon over live matches on its own schedule, touching no money and
// gating nothing, and records what it WOULD have chosen. That yields the one number the decision actually
// needs: how often the canon's chosen book is simultaneously under quarantine — the double-lock rate,
// measured rather than argued.
//
// Explicitly NOT decided here: whether to exempt the canon from notation_desync, whether to widen the family
// gate, whether the threshold is right. The ТЗ says a week of counter data first, and the last three times a
// plausible mechanism was acted on before measurement the data disagreed.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { canonicalizeDrawForMatch, drawCanonEnabled, DRAW_YES_KEYS } from "./drawCanon.js";
import { outcomeKey, type ZombieReason } from "./zombieMarket.js";

const PROBE_KEY = "draw_canon_probe";

export interface DrawCanonProbeRow {
  matchId: string; at: string;
  drawBooks: number;            // draw notations quoted on this match
  verdict: string;              // canon verdict, or why it produced nothing
  canonLabel: string | null;
  canonCents: number | null;
  mirrorsCut: number;
  canonQuarantined: string | null;   // zombie code blocking the CANON itself, if any
  quarantinedBooks: number;          // how many of this match's draw books were quarantined
}
export interface DrawCanonProbeState { rows: DrawCanonProbeRow[]; since: string }

const MAX_ROWS = 400; // bounded: this is a week-long counter, not an archive

/**
 * Observe (never enforce) what the canon would do for one match. Called from the live path where the zombie
 * map for this tick already exists, so the cross-tab costs nothing extra and — critically — compares the two
 * verdicts computed from the SAME snapshot. Comparing a canon from one tick against a quarantine from another
 * would manufacture disagreements that never co-existed.
 */
export function probeDrawCanon(
  db: Database, matchId: string, markets: { label: string }[],
  zombie: Map<string, ZombieReason>, now: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const drawBooks = markets.filter((mk) => DRAW_YES_KEYS.has(outcomeKey(mk.label)) || /draw|ничья/i.test(mk.label));
  if (!drawBooks.length) return;                       // nothing to say about a match with no draw book

  let verdict = "не вызван", canonLabel: string | null = null, canonCents: number | null = null, mirrorsCut = 0;
  if (!drawCanonEnabled(env)) verdict = "выключен (DRAW_CANON_ENFORCE=false)";
  else {
    try {
      const dc = canonicalizeDrawForMatch(db, matchId, env);
      if (!dc) verdict = "канон не построен (нет пригодных котировок/эмпирики)";
      else {
        verdict = dc.verdict;
        canonLabel = dc.canon?.label ?? null;
        canonCents = dc.canon?.priceCents ?? null;
        mirrorsCut = dc.mirrors?.length ?? 0;
      }
    } catch (e) { verdict = `ошибка: ${(e as Error).message.slice(0, 80)}`; }
  }

  const row: DrawCanonProbeRow = {
    matchId, at: now, drawBooks: drawBooks.length, verdict, canonLabel, canonCents, mirrorsCut,
    canonQuarantined: canonLabel ? ((zombie.get(canonLabel)?.code as string | undefined) ?? null) : null,
    quarantinedBooks: drawBooks.filter((mk) => zombie.has(mk.label)).length,
  };
  const st = readState(db);
  // One row per (match, verdict, canon, quarantine-state): a market sitting in the same condition for fifty
  // ticks is one observation, not fifty. Without this the double-lock rate would just measure tick frequency.
  const key = (r: DrawCanonProbeRow) => `${r.matchId}|${r.verdict}|${r.canonLabel}|${r.canonQuarantined}|${r.quarantinedBooks}`;
  if (st.rows.some((r) => key(r) === key(row))) return;
  st.rows.push(row);
  if (st.rows.length > MAX_ROWS) st.rows = st.rows.slice(-MAX_ROWS);
  try { R.metaSet(db, PROBE_KEY, JSON.stringify(st), now); } catch { /* observability must never break a tick */ }
}

function readState(db: Database): DrawCanonProbeState {
  try {
    const raw = R.metaGet(db, PROBE_KEY);
    if (raw) { const v = JSON.parse(raw); if (v && Array.isArray(v.rows)) return v as DrawCanonProbeState; }
  } catch { /* corrupt marker → start clean rather than crash a tick */ }
  return { rows: [], since: new Date().toISOString() };
}

export interface DrawCanonProbeReport {
  observations: number; matches: number;
  byVerdict: Record<string, number>;
  canonChosen: number; canonQuarantined: number; doubleLockPct: number | null;
  quarantineCodes: Record<string, number>;
  mature: boolean; note: string;
}
export const PROBE_NEED_OBS = 40;

/** The counter's read. Deliberately refuses a conclusion below n — the whole point was to stop deciding on a
 *  plausible story, and a small-n number is just a slower way of doing that. */
export function buildDrawCanonProbe(db: Database): DrawCanonProbeReport {
  const st = readState(db);
  const byVerdict: Record<string, number> = {}; const codes: Record<string, number> = {};
  let chosen = 0, blocked = 0;
  for (const r of st.rows) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    if (r.canonLabel) { chosen++; if (r.canonQuarantined) { blocked++; codes[r.canonQuarantined] = (codes[r.canonQuarantined] ?? 0) + 1; } }
  }
  const pct = chosen ? Math.round((1000 * blocked) / chosen) / 10 : null;
  const mature = st.rows.length >= PROBE_NEED_OBS;
  return {
    observations: st.rows.length, matches: new Set(st.rows.map((r) => r.matchId)).size,
    byVerdict, canonChosen: chosen, canonQuarantined: blocked, doubleLockPct: pct, quarantineCodes: codes,
    mature,
    note: !mature
      ? `копим: ${st.rows.length}/${PROBE_NEED_OBS} наблюдений. Решения по Draw (снимать ли карантин с канона, ` +
        `размораживать ли семью) — только после недели данных: ноль канон-строк в логах объяснялся тем, что ` +
        `Draw ни разу не предлагался, а не поломкой канона.`
      : chosen === 0
        ? `канон не выбрал книгу НИ РАЗУ за ${st.rows.length} наблюдений — вопрос не в карантине, а в самом ` +
          `построении канона; смотреть byVerdict.`
        : `ДВОЙНОЙ ЗАМОК: канон выбирал книгу ${chosen} раз, из них ${blocked} (${pct}%) выбранная книга ` +
          `одновременно стояла в карантине (${Object.entries(codes).map(([k, v]) => `${k}:${v}`).join(", ") || "—"}). ` +
          `Это измеренная величина, а не гипотеза — с ней можно идти к решению по Draw.`,
  };
}
