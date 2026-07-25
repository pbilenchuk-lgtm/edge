// ============================================================
// EDGE LAB — DRAW-NOTATION CANONICALIZER  [SERVER-ONLY, read-only]
//
// Polymarket emits the SAME match's draw outcome under several notations that desync in price (the Vardar
// case: "Draw — Yes" at 20.5 / 38.5 / 50 simultaneously). notationSpreads/classifyZombie already FLAG the
// desync and quarantine the whole group; this module goes one step further and picks the ONE coherent book
// to treat as canonical, tagging the rest as a DIFFERENT CONTRACT (not the same draw at a wrong price).
//
// Two pieces, in the order they must run (Petro's ratified plan C→A):
//
//  1. buildDrawNotationEmpirics — the EMPIRICAL pass. Before trusting any canon, confirm the contract model:
//     is a draw notation always a 90-minute (full-time) draw, or do some books price a DIFFERENT condition
//     (e.g. a half-time draw)? We can't ask the price (circular) — we ask RESOLUTIONS. Every settled-by-
//     resolution draw bet is a datum: did it settle the way a 90'-draw contract MUST, given the final score?
//     All agree → draw notations are one contract, desync is pure noise, canon is safe. Any disagreement →
//     distinct-contract evidence; inspect, and never merge divergent notations. n<MIN → insufficient.
//
//  2. buildDrawCanon / canonicalizeDrawForMatch — the CANON. A draw candidate is canonical iff it is
//     internally consistent with the MARKET's own 1X2 sum: P1_market + Draw_candidate + P2_market ∈
//     [100−slack, 100+vig]. This is an intra-market invariant a mispriced/other-condition book breaks
//     arithmetically. It is deliberately NOT anchored on our derived draw probability — that would let the
//     MODEL judge market identity (circular, and biased by any δ-chain over-crest). Derived-draw is only a
//     2nd-order tie-break AFTER freshness and volume, among already sum-consistent candidates. Zero
//     sum-consistent candidates → quarantine (as today). Read-only; never writes.
// Exposed at GET /api/profiles?report=draw_empirics and ?report=draw_canon.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Market } from "./types.js";
import { outcomeKey } from "./zombieMarket.js";
import { isResolutionSettle } from "./settlement.js";

/** The draw-YES outcome keys (the P(draw) leg). "drawno" is the complement — not a leg we sum. */
export const DRAW_YES_KEYS = new Set(["draw", "drawyes"]);
// [P4 / batch-9] Master switch for enforcing the canon at the FILL CHOKE (report-only until ratified).
// Ratified 25.07 on model_confirmed empirics (6/6 settled draw bets resolved as the 90' contract, zero
// disagreements), so the default is ON; DRAW_CANON_ENFORCE=false reverts to report-only without a deploy.
export function drawCanonEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.DRAW_CANON_ENFORCE ?? "true").toLowerCase() !== "false";
}

export function drawCanonConfig(env: Record<string, string | undefined> = process.env): { vigCents: number; underSlackCents: number; minEmpirics: number } {
  const vig = Number(env.FOOTBALL_DRAW_CANON_VIG_CENTS);
  const slack = Number(env.FOOTBALL_DRAW_CANON_UNDER_SLACK_CENTS);
  const minE = Number(env.FOOTBALL_DRAW_EMPIRICS_MIN);
  return {
    vigCents: Number.isFinite(vig) && vig > 0 ? vig : 15,        // 3-way books run ~105–115% → 100..115
    underSlackCents: Number.isFinite(slack) && slack >= 0 ? slack : 3, // tolerate 2-way rounding just under 100
    minEmpirics: Number.isFinite(minE) && minE > 0 ? minE : 5,   // Petro's «меньше трёх-пяти → insufficient»
  };
}

// ── shared classification ────────────────────────────────────────────────────
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9а-я]+/gu, "");
/** Does the label name this team? Full normalized name, or a distinctive token (≥4 chars). */
function mentions(label: string, team: string): boolean {
  const l = norm(label), t = norm(team);
  if (t.length >= 4 && l.includes(t)) return true;
  for (const tok of team.toLowerCase().split(/[^a-zа-я0-9]+/u)) if (tok.length >= 4 && l.includes(norm(tok))) return true;
  return false;
}
/** Is this label a clean 1X2 moneyline leg (home / away / draw-yes), not a total/handicap/BTTS/double-chance? */
function moneylineSide(label: string, home: string, away: string): "home" | "away" | "draw" | null {
  const l = label.toLowerCase();
  if (/over|under|больше|меньше|(?<![a-z])tb(?![a-z])|(?<![a-z])мб(?![a-z])|btts|обе\s|both teams|[+-]\s?\d|double chance|двойной|(?<![a-z])or(?![a-z])|(?<![a-zа-я])или(?![a-zа-я])|1x|x2|dnb|no bet/u.test(l)) return null;
  const k = outcomeKey(label);
  if (DRAW_YES_KEYS.has(k)) return "draw";
  if (k === "drawno") return null;
  const h = mentions(label, home), a = mentions(label, away);
  if (h && !a) return "home";
  if (a && !h) return "away";
  return null;
}
/** Parse Polymarket liquidity strings: "2000", "663K", "1.2M" → number. Null/garbage → 0. */
function liq(s: string | null | undefined): number {
  if (!s) return 0;
  const m = /([\d.]+)\s*([km])?/i.exec(String(s));
  if (!m) return 0;
  const n = Number(m[1]); if (!Number.isFinite(n)) return 0;
  const mult = m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1;
  return n * mult;
}
/** Model-derived P(90' draw) from the stored distribution artifact — tie-break ONLY, never an anchor. */
function derivedDraw(db: Database, matchId: string): number | null {
  try {
    const art = R.artifactsForMatch(db, matchId).find((x) => x.kind === "distribution");
    if (!art) return null;
    const d = JSON.parse(art.content)?.derived?.outcome_90?.draw;
    return Number.isFinite(d) ? Number(d) : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1) EMPIRICAL PASS — confirm/refute the "draw notation = 90' draw" contract model
// ═══════════════════════════════════════════════════════════════════════════════
export interface DrawEmpirics {
  settledDrawBets: number;         // settled-by-resolution draw bets on scored football matches
  onDupeMatches: number;           // of those, ones whose match carried ≥2 draw notations (true dupes)
  agree: number;                   // settled as a 90'-draw contract MUST, given the final score + polarity
  disagree: number;                // settled OTHERWISE — distinct-contract (e.g. HT-draw) or polarity signal
  disagreements: { match: string; score: string; label: string; polarity: "yes" | "no"; expectedWin: boolean; actualWin: boolean }[];
  verdict: "insufficient" | "model_confirmed" | "distinct_contracts";
  note: string;
}

export function buildDrawNotationEmpirics(db: Database, env: Record<string, string | undefined> = process.env): DrawEmpirics {
  const { minEmpirics } = drawCanonConfig(env);
  const sport = new Map(R.listCompetitions(db).map((c) => [c.id, c.sport_id]));
  // matches (football, finished, scored) that carried ≥2 draw notations — for the dupe subset count.
  const dupeMatch = new Set<string>();
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "football") continue;
    for (const m of R.listMatches(db, c.id)) {
      if (m.score_home == null || m.score_away == null) continue;
      const draws = R.latestMarkets(db, m.id).filter((x) => DRAW_YES_KEYS.has(outcomeKey(x.label)));
      if (draws.length >= 2) dupeMatch.add(m.id);
    }
  }

  let agree = 0, disagree = 0, onDupeMatches = 0;
  const disagreements: DrawEmpirics["disagreements"] = [];
  for (const b of R.allBets(db)) {
    if (b.status !== "settled_won" && b.status !== "settled_lost") continue;
    if (!isResolutionSettle(b.settled_by)) continue; // cash-outs carry no verdict
    const k = outcomeKey(b.market_label);
    const isYes = DRAW_YES_KEYS.has(k), isNo = k === "drawno";
    if (!isYes && !isNo) continue;
    const m = R.getMatch(db, b.match_id);
    if (!m || sport.get(m.competition_id) !== "football" || m.score_home == null || m.score_away == null) continue;
    const actual90Draw = m.score_home === m.score_away;
    const expectedWin = isYes ? actual90Draw : !actual90Draw; // a 90'-draw contract's REQUIRED outcome
    const actualWin = b.status === "settled_won";
    if (dupeMatch.has(b.match_id)) onDupeMatches++;
    if (expectedWin === actualWin) { agree++; continue; }
    disagree++;
    if (disagreements.length < 40) disagreements.push({ match: `${m.home}—${m.away}`, score: `${m.score_home}:${m.score_away}`, label: b.market_label, polarity: isYes ? "yes" : "no", expectedWin, actualWin });
  }

  const n = agree + disagree;
  const verdict: DrawEmpirics["verdict"] = n < minEmpirics ? "insufficient" : disagree > 0 ? "distinct_contracts" : "model_confirmed";
  const note = verdict === "insufficient"
    ? `недостаточно данных: ${n} settled draw-ставок по резолюции (порог ${minEmpirics}) — модель контракта не подтверждена; канон строим на СТРУКТУРНОМ инварианте суммы 1X2 (он безопасен и без подтверждения), но «HT vs 90'» остаётся неразобранным`
    : verdict === "distinct_contracts"
      ? `⚠️ ${disagree} из ${n} draw-ставок разрешились НЕ как 90'-контракт (при данном счёте+полярности) — есть признак РАЗНЫХ контрактов (напр. ничья к перерыву) ИЛИ бага полярности; РАЗБЕРИ disagreements. Канон НЕ должен сливать расходящиеся нотации (якорь суммы это и обеспечивает)`
      : `✅ модель подтверждена: все ${n} settled draw-ставок разрешились ровно как 90'-контракт — рассинхрон нотаций это ЦЕНОВОЙ шум одного контракта; канонизация по сумме 1X2 безопасна`;
  return { settledDrawBets: n, onDupeMatches, agree, disagree, disagreements, verdict, note };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2) CANONICALIZER — pick the sum-consistent draw book; tag the rest "different condition"
// ═══════════════════════════════════════════════════════════════════════════════
export interface DrawCandidate { label: string; priceCents: number; sumCents: number | null; consistent: boolean; liquidity: number; snapshotAt: string }
export interface DrawCanonMatch {
  matchId: string; match: string;
  p1Cents: number | null; p2Cents: number | null; anchorOk: boolean;
  candidates: DrawCandidate[];
  canon: { label: string; priceCents: number } | null;
  mirrors: string[];            // sum-inconsistent notations — a DIFFERENT condition, not tradeable as this draw
  verdict: "canon" | "quarantine";
  reason: string;
}

/** Canonicalize the draw group for ONE match. Pure read. Returns null when there is no draw desync to resolve
 *  (0 or 1 draw notation) — nothing to canonicalize. */
export function canonicalizeDrawForMatch(db: Database, matchId: string, env: Record<string, string | undefined> = process.env): DrawCanonMatch | null {
  const { vigCents, underSlackCents } = drawCanonConfig(env);
  const m = R.getMatch(db, matchId);
  if (!m) return null;
  const mkts = R.latestMarkets(db, matchId);
  const draws = mkts.filter((x) => DRAW_YES_KEYS.has(outcomeKey(x.label)) && Number.isFinite(x.price));
  if (draws.length < 2) return null; // no desync to resolve

  // MARKET 1X2 anchor — the newest home-leg and away-leg prices (NOT our derived draw).
  const legPrice = (side: "home" | "away"): { price: number; at: string } | null => {
    const legs = mkts.filter((x) => moneylineSide(x.label, m.home, m.away) === side && Number.isFinite(x.price))
      .sort((a, b) => (b.snapshot_at ?? "").localeCompare(a.snapshot_at ?? ""));
    return legs.length ? { price: legs[0].price, at: legs[0].snapshot_at } : null;
  };
  const p1 = legPrice("home"), p2 = legPrice("away");
  const anchorOk = !!(p1 && p2);

  const candidates: DrawCandidate[] = draws.map((d) => {
    const sum = anchorOk ? Math.round((p1!.price + d.price + p2!.price) * 10) / 10 : null;
    const consistent = sum != null && sum >= 100 - underSlackCents && sum <= 100 + vigCents;
    return { label: d.label, priceCents: d.price, sumCents: sum, consistent, liquidity: liq(d.liquidity), snapshotAt: d.snapshot_at };
  });

  const consistent = candidates.filter((c) => c.consistent);
  if (!anchorOk) {
    return { matchId, match: `${m.home}—${m.away}`, p1Cents: p1?.price ?? null, p2Cents: p2?.price ?? null, anchorOk,
      candidates, canon: null, mirrors: candidates.map((c) => c.label), verdict: "quarantine",
      reason: `нет рыночного якоря 1X2 (${p1 ? "" : "нет home-лега "}${p2 ? "" : "нет away-лега"}) — консистентность не с чем сверить; карантин группы` };
  }
  if (consistent.length === 0) {
    return { matchId, match: `${m.home}—${m.away}`, p1Cents: p1!.price, p2Cents: p2!.price, anchorOk,
      candidates, canon: null, mirrors: candidates.map((c) => c.label), verdict: "quarantine",
      reason: `ни одна нотация не сумма-консистентна (P1 ${p1!.price}¢ + draw + P2 ${p2!.price}¢ вне [${100 - underSlackCents},${100 + vigCents}]) — весь draw-контур некогерентен; карантин` };
  }

  // Rank among sum-consistent: freshness → volume → derived-draw closeness (2nd-order tie-break only).
  const dDraw = derivedDraw(db, matchId);
  const ranked = [...consistent].sort((a, b) => {
    const f = (b.snapshotAt ?? "").localeCompare(a.snapshotAt ?? ""); if (f) return f;
    if (b.liquidity !== a.liquidity) return b.liquidity - a.liquidity;
    if (dDraw != null) return Math.abs(a.priceCents / 100 - dDraw) - Math.abs(b.priceCents / 100 - dDraw);
    return 0;
  });
  const canon = ranked[0];
  const mirrors = candidates.filter((c) => c.label !== canon.label).map((c) => c.label);
  return { matchId, match: `${m.home}—${m.away}`, p1Cents: p1!.price, p2Cents: p2!.price, anchorOk,
    candidates, canon: { label: canon.label, priceCents: canon.priceCents }, mirrors, verdict: "canon",
    reason: `канон «${canon.label}» ${canon.priceCents}¢ (сумма ${canon.sumCents}¢ ∈ [${100 - underSlackCents},${100 + vigCents}]); ${mirrors.length} зеркал помечены «другое условие», не торгуются как эта ничья${consistent.length > 1 ? ` (выбор: свежесть→объём${dDraw != null ? "→derived" : ""})` : ""}` };
}

export interface DrawCanonReport {
  scanned: number;              // matches carrying a draw desync (≥2 notations)
  canonated: number; quarantined: number;
  byReason: Record<string, number>;
  matches: DrawCanonMatch[];
}

/** Run the canonicalizer over every football match with a draw desync. Read-only report. */
export function buildDrawCanon(db: Database, env: Record<string, string | undefined> = process.env): DrawCanonReport {
  const out: DrawCanonMatch[] = [];
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "football") continue;
    for (const m of R.listMatches(db, c.id)) {
      const res = canonicalizeDrawForMatch(db, m.id, env);
      if (res) out.push(res);
    }
  }
  const byReason: Record<string, number> = {};
  for (const r of out) { const key = r.verdict === "canon" ? "canon" : r.anchorOk ? "quarantine_incoherent" : "quarantine_no_anchor"; byReason[key] = (byReason[key] ?? 0) + 1; }
  return {
    scanned: out.length,
    canonated: out.filter((r) => r.verdict === "canon").length,
    quarantined: out.filter((r) => r.verdict === "quarantine").length,
    byReason,
    matches: out.slice(0, 100),
  };
}
