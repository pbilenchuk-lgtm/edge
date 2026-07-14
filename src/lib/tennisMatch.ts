// ============================================================
// EDGE LAB — TENNIS match mapping: API-Tennis ↔ Polymarket (the critical seam).
//
// A tennis match only trades once we're CONFIDENT the provider's live match is the same
// as the Polymarket market. Player names differ wildly across sources (transliteration,
// diacritics, initials, name order), so this is fuzzy — but the rule is hard: an unmapped
// or gray-zone match NEVER trades (honest skip + logged candidate scores), never a silent
// guess. The decision log is deliberate evidence for a future provenance review (the same
// discipline as the Draw-market provenance class in football).
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

// Auto-map at/above HIGH; gray zone [LOW, HIGH) → review (no trade); below LOW → skip.
export const MAP_AUTO = (() => { const n = Number(process.env.TENNIS_MAP_AUTO); return Number.isFinite(n) ? n : 0.82; })();
export const MAP_REVIEW = (() => { const n = Number(process.env.TENNIS_MAP_REVIEW); return Number.isFinite(n) ? n : 0.6; })();
const DATE_TOL_MS = 3 * 3600_000; // ±3h on start time

// Minimal Cyrillic→Latin transliteration (surnames that surface on Polymarket vs API-Tennis).
const CYR: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

/** Normalize a name to lowercase ASCII: strip diacritics, transliterate Cyrillic, drop punctuation. */
export function normName(raw: string): string {
  let s = String(raw ?? "").toLowerCase();
  s = s.split("").map((ch) => CYR[ch] ?? ch).join("");
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, ""); // strip combining diacritics (đ→d handled below)
  // Serbian Đ/đ → "dj" (English transliteration: "Đere" = "Djere"); ø→o, ł→l, ß→ss.
  s = s.replace(/đ/g, "dj").replace(/ø/g, "o").replace(/ł/g, "l").replace(/ß/g, "ss");
  return s.replace(/[^a-z\s.-]/g, " ").replace(/\s+/g, " ").trim();
}

/** Tokens of a name minus 1-letter initials, e.g. "N. Arseneault" → ["arseneault"]. */
function fullTokens(name: string): string[] {
  return normName(name).replace(/\./g, " ").split(/[\s-]+/).filter((t) => t.length > 1);
}
function initials(name: string): string[] {
  return normName(name).replace(/\./g, " ").split(/[\s-]+/).filter(Boolean).map((t) => t[0]);
}

/**
 * Similarity of two player names in [0,1]. Surnames (multi-letter tokens) must overlap; a
 * first-name/initial that is consistent (or an initial matching a full first name) adds
 * confidence. Handles "Bautista Agut" (2-word surname), "N. Arseneault" (initial), and
 * order swaps (token-set, order-independent).
 */
export function nameSimilarity(a: string, b: string): number {
  const fa = new Set(fullTokens(a)), fb = new Set(fullTokens(b));
  if (!fa.size || !fb.size) return 0;
  const inter = [...fa].filter((t) => fb.has(t));
  const overlap = inter.length / Math.min(fa.size, fb.size); // fraction of the shorter name's surnames matched
  if (overlap === 0) {
    // Fall back to initials only when NO full token matched (both sides abbreviated differently).
    const ia = new Set(initials(a)), ib = new Set(initials(b));
    const ii = [...ia].filter((t) => ib.has(t)).length;
    return ia.size && ib.size && ii === Math.min(ia.size, ib.size) ? 0.4 : 0;
  }
  // Bonus when the OTHER side's extra token is a consistent initial (e.g. "Arseneault" vs
  // "N. Arseneault" — surname matched, and there's no CONTRADICTING full first name).
  const ea = [...fa].filter((t) => !fb.has(t)), eb = [...fb].filter((t) => !fa.has(t));
  const contradiction = ea.length && eb.length && !ea.some((x) => eb.some((y) => x[0] === y[0]));
  return Math.min(1, overlap) * (contradiction ? 0.8 : 1);
}

export interface MapCandidate { matchId: string; home: string; away: string; nameScore: number; dateOk: boolean; score: number }
export type MapVerdict = "auto" | "review" | "skip";
export interface MapResult { verdict: MapVerdict; matchId: string | null; score: number; candidates: MapCandidate[] }

/** Score one API-Tennis match against every discovered ATP/WTA Polymarket match; pick the best. */
export function mapTennisMatch(
  db: Database,
  live: { p1: string; p2: string; startMs?: number | null; tour?: string | null },
): MapResult {
  const cands: MapCandidate[] = [];
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    for (const m of R.listMatches(db, c.id)) {
      // Both players must match (order-independent): min over the two pairings.
      const direct = Math.min(nameSimilarity(live.p1, m.home), nameSimilarity(live.p2, m.away));
      const swap = Math.min(nameSimilarity(live.p1, m.away), nameSimilarity(live.p2, m.home));
      const nameScore = Math.max(direct, swap);
      if (nameScore <= 0) continue;
      const koMs = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
      const dateOk = live.startMs != null && Number.isFinite(koMs) ? Math.abs(koMs - live.startMs) <= DATE_TOL_MS : false;
      // name is the backbone (0.8), date corroborates (0.2). Unknown date neither helps nor blocks.
      const score = Math.round((nameScore * 0.8 + (dateOk ? 0.2 : live.startMs == null ? 0.12 : 0)) * 100) / 100;
      cands.push({ matchId: m.id, home: m.home, away: m.away, nameScore: Math.round(nameScore * 100) / 100, dateOk, score });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const best = cands[0];
  if (!best) return { verdict: "skip", matchId: null, score: 0, candidates: [] };
  const verdict: MapVerdict = best.score >= MAP_AUTO ? "auto" : best.score >= MAP_REVIEW ? "review" : "skip";
  return { verdict, matchId: verdict === "auto" ? best.matchId : null, score: best.score, candidates: cands.slice(0, 4) };
}

/** Persist a mapping decision (evidence trail: every score + candidate). Best-effort. */
export function logMapDecision(db: Database, eventKey: string, live: { p1: string; p2: string }, res: MapResult, nowIso: string): void {
  try {
    R.insertTennisMapLog(db, {
      event_key: eventKey, players: `${live.p1} vs ${live.p2}`, verdict: res.verdict,
      match_id: res.matchId, score: res.score, candidates: JSON.stringify(res.candidates), created_at: nowIso,
    });
  } catch { /* logging is best-effort */ }
}
