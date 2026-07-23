// ============================================================
// EDGE LAB — TENNIS provider scouting (Stage 0)  [SERVER-ONLY]
//
// PARALLEL, observe-only stream — does NOT touch football or any money-path. Polls a
// tennis score provider (API-Tennis, chosen in docs/tennis_provider_scouting.md) for LIVE
// matches and stores raw+parsed snapshots so break detection + lag can be measured offline
// while snapshots are hot. A "break" = the SERVER loses their service game — which is only
// detectable because API-Tennis exposes `event_serve` (the field ESPN lacked).
//
// Gated on API_TENNIS_KEY: no key → inert (returns 0), exactly like the football providers.
// ============================================================

import "./http.js";
import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { loadPolymarketConfig, fetchMidpointCents } from "./polymarket.js";
import { mapTennisMatch, logMapDecision, normName, MAP_AUTO, MAP_REVIEW } from "./tennisMatch.js";
import { parseEntryMeta } from "./betMeta.js";
import { computeWindowMetrics, polymarketSeries } from "./overreactionLatency.js";
import { effectiveCodeVersion } from "./codeEpoch.js";

const nowFn = (d: EngineDeps) => d.now ?? (() => new Date().toISOString());

// TOUR SCOPE (single source of truth, shared by every tennis strategy): ATP/WTA SINGLES only.
// ITF / Challenger have different hold rates + thinner, jumpier books, and doubles is a different
// chain entirely — the favourite-mean-reversion and competitive-set theses (Overreaction, Set-Value)
// and the base_hold constants (PMV) are all measured/valid ONLY on ATP/WTA singles. A comp outside
// scope returns null → the strategy skips it. Kept in the scout (leaf) so trading + PMV share it
// without an import cycle.
export function tennisTourOf(c: { id: string; name: string; external_league?: string | null }): "atp" | "wta" | null {
  const hay = `${c.id} ${c.name} ${c.external_league ?? ""}`.toLowerCase();
  // Out-of-scope, lower-tier / non-main-draw events. NOTE the asymmetry that a name-literal filter
  // MUST cover explicitly: the men's second tier carries the word "challenger", but the WOMEN's
  // equivalent is named by prize level — "WTA 125" — with no such token, so it must be listed by
  // number (\b125\b) or it leaks in as "wta". Qualifying draws are thinner/jumpier → out too.
  // (A string filter breaks on every new tour naming; if the provider ever exposes a tier LEVEL
  // field on the comp, gate on that and keep this regex as the fallback.)
  if (/doubles|itf|challenger|wta ?125|atp ?125|\b125\b|\bqualif/.test(hay)) return null;
  if (/\bwta\b/.test(hay)) return "wta";
  if (/\batp\b/.test(hay)) return "atp";
  return null;
}

export interface TennisConfig { enabled: boolean; key: string; base: string; timeoutMs: number }
export function loadTennisConfig(env: Record<string, string | undefined> = process.env): TennisConfig {
  const key = (env.API_TENNIS_KEY ?? env.APITENNIS_KEY ?? "").trim();
  return { enabled: !!key, key, base: env.API_TENNIS_BASE ?? "https://api.api-tennis.com/tennis/", timeoutMs: Number(env.API_TENNIS_TIMEOUT_MS ?? 8000) };
}

// ── Field parsing (confirmed against the live feed) ──
/** "First Player"/"Second Player" → 'first'/'second'; anything else → null. */
export function serverSide(eventServe: unknown): "first" | "second" | null {
  const s = String(eventServe ?? "").toLowerCase();
  if (s.includes("first")) return "first";
  if (s.includes("second")) return "second";
  return null;
}
/** "1 - 0" → [1, 0]; unparseable → [null, null]. */
export function parsePair(s: unknown): [number | null, number | null] {
  const m = String(s ?? "").match(/(\d+)\s*[-:]\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}
/** From the API-Tennis `scores` array, the CURRENT set number + games in it. */
export function currentSet(scores: unknown): { setNum: number | null; gamesP1: number | null; gamesP2: number | null } {
  if (!Array.isArray(scores) || !scores.length) return { setNum: null, gamesP1: null, gamesP2: null };
  let best: any = null, bestN = -1;
  for (const s of scores) { const n = Number(s?.score_set); if (Number.isFinite(n) && n > bestN) { bestN = n; best = s; } }
  if (!best) return { setNum: null, gamesP1: null, gamesP2: null };
  return { setNum: bestN, gamesP1: intGames(best.score_first), gamesP2: intGames(best.score_second) };
}

// P1.4: GAMES ARE ALWAYS WHOLE. During a tiebreak api-tennis encodes the tiebreak-point score as a DECIMAL
// («6.3» = 6 games, 3 tiebreak points → the «геймы 6.3-7.7» in the logs). The break detector tolerates it
// (a fractional delta fails the unit-game check and is skipped), but the ===6 tiebreak guard misses a
// «6.3-6.6» state and the recorded set-1 game score is polluted. Truncate to integer games here so every
// downstream consumer (break/hold/tiebreak_set detection, K-count stop, set_value's set-1 score) sees whole
// games; the tiebreak-point detail stays recoverable from the stored raw JSON.
function intGames(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export interface TennisLive {
  eventKey: string; p1: string; p2: string; tournament: string | null; eventType: string | null;
  live: number; status: string | null; setsP1: number | null; setsP2: number | null;
  setNum: number | null; gamesP1: number | null; gamesP2: number | null; gamePoints: string | null;
  server: "first" | "second" | null; raw: unknown;
}
export function normalizeLive(m: any): TennisLive | null {
  if (!m?.event_key) return null;
  const [sp1, sp2] = parsePair(m.event_final_result);
  const cs = currentSet(m.scores);
  return {
    eventKey: String(m.event_key), p1: String(m.event_first_player ?? ""), p2: String(m.event_second_player ?? ""),
    tournament: m.tournament_name ?? null, eventType: m.event_type_type ?? null,
    live: Number(m.event_live) === 1 ? 1 : 0, status: m.event_status ?? null,
    setsP1: sp1, setsP2: sp2, setNum: cs.setNum, gamesP1: cs.gamesP1, gamesP2: cs.gamesP2,
    gamePoints: m.event_game_result ?? null, server: serverSide(m.event_serve), raw: m,
  };
}

/** Fetch live tennis matches from API-Tennis. Never throws — returns [] on failure. */
export async function fetchTennisLivescores(cfg: TennisConfig, deps: EngineDeps = {}): Promise<TennisLive[]> {
  if (!cfg.enabled) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const doFetch = deps.fetchImpl ?? fetch;
    const url = `${cfg.base}?method=get_livescore&APIkey=${encodeURIComponent(cfg.key)}`;
    const res = await doFetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const j = (await res.json()) as { success?: number; result?: unknown };
    const rows = Array.isArray(j?.result) ? j.result : [];
    return rows.map(normalizeLive).filter((x): x is TennisLive => x != null);
  } catch { return []; }
  finally { clearTimeout(timer); }
}

// A terminal API-Tennis status — the match is OVER (any resolution family). The live feed drops a
// match once it ends, so a match that completes NORMALLY never yields a terminal live-feed row; the
// authoritative terminal signal comes from get_fixtures/get_results (fetchTennisFixtures + the poller).
export const TENNIS_TERMINAL_RE = /finish|retir|\bret\.?\b|walkover|w[\/.]?o|cancel|abandon|default|disqualif|\bdsq\b/i;

// OOM guard: get_fixtures returns the WHOLE worldwide tennis schedule for the date range — several MB
// of JSON. On a 512MB box, JSON.parse of a multi-MB payload (×2-5 in live objects) can OOM the whole
// process. Read the body as TEXT, bail if it's over this cap BEFORE parsing, and retain only the rows
// we actually asked for. Env-tunable.
const TENNIS_FIXTURES_MAX_BYTES = (() => { const n = Number(process.env.TENNIS_FIXTURES_MAX_BYTES); return Number.isFinite(n) && n > 0 ? n : 6_000_000; })();
/**
 * Fetch fixtures (finished + scheduled) for a date range from API-Tennis get_fixtures. Unlike
 * get_livescore, this returns COMPLETED matches carrying `event_winner` + final `scores` — the
 * only authoritative way to settle a tennis match that ended normally (and just vanished from the
 * live feed). `wantedKeys` (if given) filters to just those event_keys BEFORE building any objects,
 * so retained memory is bounded to the handful of matches we care about. Never throws — returns []
 * on failure or an over-cap payload. date* are YYYY-MM-DD.
 */
export async function fetchTennisFixtures(cfg: TennisConfig, dateStart: string, dateStop: string, deps: EngineDeps = {}, wantedKeys?: Set<string>): Promise<TennisLive[]> {
  if (!cfg.enabled) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const doFetch = deps.fetchImpl ?? fetch;
    const url = `${cfg.base}?method=get_fixtures&date_start=${encodeURIComponent(dateStart)}&date_stop=${encodeURIComponent(dateStop)}&APIkey=${encodeURIComponent(cfg.key)}`;
    const res = await doFetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const text = await res.text();
    if (text.length > TENNIS_FIXTURES_MAX_BYTES) return []; // too big to parse safely → skip (availability over settlement)
    const j = JSON.parse(text) as { success?: number; result?: unknown };
    const rows = Array.isArray(j?.result) ? j.result : [];
    const wanted = wantedKeys ? rows.filter((r: any) => wantedKeys.has(String(r?.event_key))) : rows;
    return wanted.map(normalizeLive).filter((x): x is TennisLive => x != null);
  } catch { return []; }
  finally { clearTimeout(timer); }
}

/** Strip the heavy arrays (pointbypoint / statistics) from a stored raw row — not needed for
 *  Stage-1 break detection, and they blow up the persistent disk at 20s cadence. */
export function trimRaw(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null;
  const { pointbypoint, statistics, ...rest } = raw;
  try { return JSON.stringify(rest); } catch { return null; }
}

// Prop-market keywords. A tennis MONEYLINE is the ONLY market carrying NONE of these; every prop
// (Match/Set totals O/U, handicaps, Set-N winners) does. Do NOT surname-match — every tennis label
// is "Tournament: A vs B <suffix>" and contains BOTH surnames (BACKLOG: tennis price layer).
const TENNIS_PROP_RE = /\b(over|under|handicap|winner|games?|odd|even|tie\s*break|total\s*sets?|set\s*\d|completed)\b|[+-]\s*\d/i;
const nameToks = (s: string) => normName(s).replace(/\./g, " ").split(/\s+/).filter((t) => t.length > 1);
const surnamesOverlap = (a: string, b: string) => { const A = new Set(nameToks(a)); return nameToks(b).some((t) => A.has(t)); };

export interface TennisMoneyline { p1Cents: number; p2Cents: number; label: string; token: string | null; tokenSecond: string | null; liquidity: number; firstIsP1: boolean }

/**
 * The CLOB token of the FAVOURITE's winner side (token-fix-m1). `favSide` names the favourite in
 * SCOUT order (first=p1 / second=p2); `firstIsP1` says whether scout-p1 is the moneyline's first
 * outcome. The favourite is the moneyline's FIRST outcome iff those agree — then it's `token`
 * (external_ref, = outcomes[0]); otherwise it's the SECOND outcome → `tokenSecond`. Returns null when
 * that token isn't persisted yet (market imported before token_second existed) — the caller then
 * HONEST-SKIPS rather than transact the wrong side (fail-closed until re-discovery backfills it).
 */
export function favTokenOf(ml: TennisMoneyline, favSide: "first" | "second"): string | null {
  const favIsFirstOutcome = (favSide === "first") === ml.firstIsP1;
  return favIsFirstOutcome ? ml.token : ml.tokenSecond;
}
/**
 * Resolve a match's MONEYLINE (match-winner) price per player from the stored markets. The moneyline
 * is the SINGLE non-prop market ("Tournament: A vs B", stored price = P(first-named player); the
 * second player = 100 − that). Its "A vs B" is aligned to the match's players by surname. Returns
 * null — an HONEST SKIP — on 0 or >1 non-prop markets, or a label that can't be aligned; NEVER the
 * closest prop (that garbage-in bug is exactly what this replaces). Same discipline as player mapping.
 */
export function tennisMoneyline(db: Database, matchId: string, players: { p1: string; p2: string }): TennisMoneyline | null {
  // A moneyline is structurally "Tournament: A vs B". Require the " vs " title BEFORE counting, so
  // stray non-prop markets that carry no prop keyword yet aren't head-to-head titles ("Completed
  // Match — Yes/No", "Will the match finish?") can't inflate the count and force an honest-skip null.
  const nonProp = R.latestMarkets(db, matchId).filter((m) => m.label && !TENNIS_PROP_RE.test(m.label) && /\bvs\.?\s/i.test(m.label));
  if (nonProp.length !== 1) return null; // 0 = no moneyline listed; >1 = ambiguous → skip loudly (caller logs)
  const mk = nonProp[0];
  const pFirst = mk.price; // stored = P(first-named player = gamma outcomes[0])
  const core = mk.label.replace(/^[^:]+:\s*/, ""); // strip "Tournament: "
  const vs = /^(.+?)\s+vs\.?\s+(.+)$/i.exec(core);
  if (!vs) return null; // not an "A vs B" title → can't be the moneyline
  const p1IsA = surnamesOverlap(players.p1, vs[1]), p1IsB = surnamesOverlap(players.p1, vs[2]);
  let p1Cents: number;
  if (p1IsA && !p1IsB) p1Cents = pFirst;            // players.p1 = A (first outcome)
  else if (p1IsB && !p1IsA) p1Cents = 100 - pFirst; // players.p1 = B (second outcome)
  else return null; // ambiguous / unalignable → honest skip
  return { p1Cents: Math.round(p1Cents * 10) / 10, p2Cents: Math.round((100 - p1Cents) * 10) / 10, label: mk.label, token: mk.external_ref, tokenSecond: mk.token_second ?? null, liquidity: Number(mk.liquidity ?? 0) || 0, firstIsP1: p1IsA && !p1IsB };
}

// ── Tennis PMV — Stage-0 Gate 0.1: prop LIQUIDITY survey (build-vs-park decision) ──
// The PMV consistency-scan can only trade props with a real book. This surveys the stored prop
// markets by FAMILY (Total Games / Set Handicap / Set N Winner / Total Sets) and asks: what share
// of ATP/WTA matches carry at least one prop above the book gate? CRITERION (written before data):
// <15% → PMV parks (nothing to trade); ≥15% → build, trading only props above the gate.
//
// CAVEAT (honest): the stored `liquidity` is gamma's single POOL number, not the two-sided CLOB
// order-book depth the spec ultimately wants. It's the accessible proxy for the park/build call; if
// this passes or lands borderline, a live two-sided CLOB probe on a prop sample is the confirmatory
// step before wiring real sizing. If it decisively fails, PMV parks regardless — the proxy only ever
// OVER-states depth (a pool ≥ $X does not guarantee $X on each side), so a fail here is a hard fail.
const PMV_PROP_BOOK_MIN = (() => { const n = Number(process.env.TENNIS_PMV_BOOK_MIN); return Number.isFinite(n) && n > 0 ? n : 500; })();
const PMV_GATE_PCT = (() => { const n = Number(process.env.TENNIS_PMV_GATE_PCT); return Number.isFinite(n) && n > 0 ? n : 0.15; })();

export type PropFamily = "total_games" | "set_handicap" | "set_winner" | "total_sets" | "other";
/** Classify a prop label into a PMV family (priority order matters — "Total Sets: Under 2.5" is a
 *  total_sets line, not a total_games one). Returns null for the moneyline (no prop keyword). */
export function propFamily(label: string): PropFamily | null {
  if (!label || !TENNIS_PROP_RE.test(label)) return null; // the moneyline itself
  if (/total\s*sets/i.test(label)) return "total_sets";
  if (/set\s*\d+\s*winner|\bwinner\b/i.test(label) && /set\s*\d/i.test(label)) return "set_winner";
  if (/handicap|spread/i.test(label)) return "set_handicap";
  if (/\b(over|under)\b|[+-]\s*\d|total\s*games/i.test(label)) return "total_games";
  return "other";
}

export interface PropLiquidityFamily { family: PropFamily; props: number; withBook: number; medianLiquidity: number; maxLiquidity: number }
export interface PropLiquidityReport {
  scope: string; bookGateUsd: number; gatePct: number;
  matches: number; matchesWithProps: number; matchesQualifying: number; qualifyingPct: number;
  totalProps: number; families: PropLiquidityFamily[];
  verdict: "build" | "park" | "insufficient_data"; note: string; caveat: string;
}
const medianLiq = (xs: number[]): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100; };

/** Gate 0.1 survey over the stored ATP/WTA prop markets. Pure read; scope = which comps to include. */
export function buildTennisPropLiquidity(db: Database, scopeComps: string[] = ["pm-atp", "pm-wta"]): PropLiquidityReport {
  const scopeSet = new Set(scopeComps);
  const comps = R.listCompetitions(db).filter((c) => c.sport_id === "tennis" && (scopeSet.has(c.id) || scopeSet.has(c.external_league ?? "")));
  const byFam = new Map<PropFamily, number[]>();
  let matches = 0, matchesWithProps = 0, matchesQualifying = 0, totalProps = 0;
  for (const c of comps) {
    for (const m of R.listMatches(db, c.id)) {
      matches++;
      const props = R.latestMarkets(db, m.id).map((mk) => ({ fam: propFamily(mk.label), liq: Number(mk.liquidity ?? 0) || 0 })).filter((p): p is { fam: PropFamily; liq: number } => p.fam != null);
      if (!props.length) continue;
      matchesWithProps++;
      totalProps += props.length;
      let qualifies = false;
      for (const p of props) { (byFam.get(p.fam) ?? byFam.set(p.fam, []).get(p.fam)!).push(p.liq); if (p.liq >= PMV_PROP_BOOK_MIN) qualifies = true; }
      if (qualifies) matchesQualifying++;
    }
  }
  const families: PropLiquidityFamily[] = [...byFam.entries()].map(([family, liqs]) => ({
    family, props: liqs.length, withBook: liqs.filter((l) => l >= PMV_PROP_BOOK_MIN).length,
    medianLiquidity: medianLiq(liqs), maxLiquidity: Math.max(0, ...liqs),
  })).sort((a, b) => b.withBook - a.withBook);
  const denom = matchesWithProps; // the gate is over matches that actually list props
  const qualifyingPct = denom > 0 ? Math.round((matchesQualifying / denom) * 1000) / 1000 : 0;
  const verdict: PropLiquidityReport["verdict"] = denom < 10 ? "insufficient_data" : qualifyingPct >= PMV_GATE_PCT ? "build" : "park";
  const note = verdict === "insufficient_data"
    ? `недостаточно данных (${denom} матчей с пропами < 10) — прогнать позже, когда накопятся снапшоты`
    : verdict === "build"
      ? `${(qualifyingPct * 100).toFixed(1)}% матчей несут проп с книгой ≥$${PMV_PROP_BOOK_MIN} (порог ${(PMV_GATE_PCT * 100).toFixed(0)}%) — гейт ПРОЙДЕН, строим ядро (только пропы выше гейта)`
      : `лишь ${(qualifyingPct * 100).toFixed(1)}% матчей несут проп с книгой ≥$${PMV_PROP_BOOK_MIN} (порог ${(PMV_GATE_PCT * 100).toFixed(0)}%) — торговать нечего, PMV ПАРКУЕТСЯ`;
  return {
    scope: [...scopeSet].join("+"), bookGateUsd: PMV_PROP_BOOK_MIN, gatePct: PMV_GATE_PCT,
    matches, matchesWithProps, matchesQualifying, qualifyingPct, totalProps, families, verdict, note,
    caveat: "liquidity = gamma POOL-число (не двусторонняя CLOB-глубина); проксирует depth и лишь ЗАВЫШАЕт её. Fail здесь = твёрдый fail; pass/borderline → нужен живой CLOB-замер до сайзинга.",
  };
}

export function tennisPropLiquidityMarkdown(r: PropLiquidityReport): string {
  const L: string[] = [];
  L.push(`# Tennis PMV — Gate 0.1: ликвидность пропов (${r.scope})`);
  L.push(`**Вердикт: ${r.verdict.toUpperCase()}** — ${r.note}`);
  L.push(`\nматчей ${r.matches} · с пропами ${r.matchesWithProps} · проходят гейт книги ${r.matchesQualifying} (${(r.qualifyingPct * 100).toFixed(1)}%) · всего пропов ${r.totalProps}`);
  L.push(`гейт книги $${r.bookGateUsd} · порог доли ${(r.gatePct * 100).toFixed(0)}%`);
  L.push(`\n## По семьям пропов`);
  L.push(`| семья | пропов | с книгой ≥$${r.bookGateUsd} | медиана liq | макс liq |`);
  L.push(`|---|---|---|---|---|`);
  for (const f of r.families) L.push(`| ${f.family} | ${f.props} | ${f.withBook} | $${f.medianLiquidity} | $${f.maxLiquidity} |`);
  L.push(`\n> ⚠ ${r.caveat}`);
  return L.join("\n");
}

/**
 * Collect one poll of live tennis into tennis_snapshots. Observe-only; never throws into
 * the caller (the collector is wrapped). Optionally captures the linked Polymarket match's
 * mid so break-vs-market lag is measurable. Returns rows written.
 */
export async function collectTennisSnapshots(db: Database, deps: EngineDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cfg = loadTennisConfig(env);
  if (!cfg.enabled) return 0;
  const batchAt = nowFn(deps)();
  const nowMs = Date.parse(batchAt) || Date.now();
  // (b) Unwrap the provider fetch: a failure here used to propagate as a bare swallowed step-error
  // (a stdout line that scrolls away). Record a QUERYABLE breadcrumb + re-throw so the step log still
  // fires. The OWN liveness stamp below stays stale (we didn't complete), so the watchdog can tell a
  // provider that THROWS apart from a loop that never ran (H2 vs H1) — the self-concealing death the
  // scout had no signal for. (The Fable lesson in a third form: graceful degradation hid the failure.)
  let raw: Awaited<ReturnType<typeof fetchTennisLivescores>>;
  try { raw = await fetchTennisLivescores(cfg, deps); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try { R.metaSet(db, TENNIS_SCOUT_ERR_KEY, `${nowMs}|${msg.slice(0, 200)}`, batchAt); } catch { /* never block on a marker */ }
    console.error(`[tennisScout] ПРОВАЙДЕР УПАЛ (снапшотов в этот тик нет): ${msg}`);
    throw e;
  }
  // Keep in-play rows AND any TERMINAL transition row the feed happens to emit (live=0 + "Finished"/
  // "Retired"): that row carries the final result and MUST be persisted — dropping it was why a
  // normally-finished match never settled. (The primary terminal path is the get_fixtures poller,
  // since a match usually just vanishes from the live feed; this keeps the row when the feed does send it.)
  const live = raw.filter((m) => m.live === 1 || TENNIS_TERMINAL_RE.test(m.status ?? ""));
  const poly = deps.polymarket ?? loadPolymarketConfig(env);
  let written = 0, tierSkipped = 0, finishedSkipped = 0;
  const seenLog = new Set<string>(); // log a match's mapping verdict once per collection pass
  // P1.3 scout hygiene. OUT-OF-SCOPE tiers (ITF / WTA 125 / Challenger / doubles) are never traded — apply
  // the B3 scope decision to the SCOUT so we don't pay a per-tick CLOB midpoint call on them (the snapshot
  // is still written cheaply; only the priced refresh is skipped).
  const OUT_OF_SCOPE_TIER = /\bitf\b|challenger|\b125\b|doubles|\bdbl\b|\bmixed\b/i;
  for (const m of live) {
    const isTerminal = TENNIS_TERMINAL_RE.test(m.status ?? "") || m.live === 0;
    // STOP-POLL a finished match: once ≥3 snapshots already carry this exact terminal status for the match,
    // the final result is captured — stop re-writing the identical «Finished» row every tick (the logs had
    // 12+). Cheap COUNT, keyed on the same terminal status so a real state change still writes.
    if (isTerminal) {
      const done = (db.prepare(`SELECT COUNT(*) n FROM tennis_snapshots WHERE event_key=? AND status=?`).get(m.eventKey, m.status ?? "") as { n: number }).n;
      if (done >= 3) { finishedSkipped++; continue; }
    }
    const outOfScope = OUT_OF_SCOPE_TIER.test(`${m.eventType ?? ""} ${m.tournament ?? ""}`);
    let pmMatchId: string | null = null, pmMid: number | null = null, p1c: number | null = null, p2c: number | null = null;
    try {
      // PROPER fuzzy mapping (translit/diacritics/initials) — only an AUTO verdict links + trades.
      const res = mapTennisMatch(db, { p1: m.p1, p2: m.p2, startMs: null });
      if (!seenLog.has(m.eventKey)) { logMapDecision(db, m.eventKey, { p1: m.p1, p2: m.p2 }, res, batchAt); seenLog.add(m.eventKey); }
      if (res.verdict === "auto" && res.matchId) {
        pmMatchId = res.matchId;
        // Price off the MONEYLINE (winner market), NOT a surname-matched prop. The stored moneyline
        // gives P per player; a live CLOB midpoint on its token refines it (the token backs the
        // LABEL's first outcome, so align by firstIsP1). No moneyline → prices stay null (honest).
        const ml = tennisMoneyline(db, res.matchId, { p1: m.p1, p2: m.p2 });
        if (ml) {
          let liveFirst: number | null = null;
          // P1.3 tier filter: out-of-scope tiers use the stored moneyline, NOT a fresh per-tick CLOB call.
          if (poly.enabled && ml.token && !outOfScope) liveFirst = await fetchMidpointCents(ml.token, poly, { fetchImpl: deps.fetchImpl }).catch(() => null);
          else if (outOfScope && poly.enabled && ml.token) tierSkipped++;
          if (liveFirst != null) { p1c = ml.firstIsP1 ? liveFirst : Math.round((100 - liveFirst) * 10) / 10; p2c = Math.round((100 - p1c) * 10) / 10; }
          else { p1c = ml.p1Cents; p2c = ml.p2Cents; } // fall back to the stored discovery moneyline
          pmMid = p1c;
        }
      }
    } catch { /* mapping/pricing is best-effort, never blocks the snapshot */ }
    R.insertTennisSnapshot(db, {
      event_key: m.eventKey, provider: "apitennis", batch_at: batchAt, p1: m.p1, p2: m.p2,
      tournament: m.tournament, event_type: m.eventType, live: m.live, status: m.status,
      sets_p1: m.setsP1, sets_p2: m.setsP2, set_num: m.setNum, games_p1: m.gamesP1, games_p2: m.gamesP2,
      game_points: m.gamePoints, server: m.server, pm_match_id: pmMatchId, pm_mid_cents: pmMid, pm_p1_cents: p1c, pm_p2_cents: p2c,
      raw: trimRaw(m.raw),
    });
    written++;
  }
  // (a) OWN liveness signal — stamped on EVERY completed run, independent of match.state (which is
  // scout-derived and dies WITH the scout). `written=0` while the schedule says a match should be
  // live is the "provider returned empty / nothing mapped" signature (a blind loop, not a dead one).
  try { R.metaSet(db, TENNIS_SCOUT_OK_KEY, `${nowMs}|${written}`, batchAt); } catch { /* never block on a marker */ }
  // P1.3: make the savings legible (skipped CLOB fetches / redundant finished writes this pass).
  try { R.metaSet(db, "tennis_scout_savings", JSON.stringify({ tierSkipped, finishedSkipped, written, at: batchAt }), batchAt); } catch { /* ignore */ }
  return written;
}

// Scout observability markers (app_meta). OK = last COMPLETED collect ("ms|written"); ERR = last
// provider fetch failure ("ms|message"). Read by tennisScoutSilence to classify a silence H1 vs H2.
const TENNIS_SCOUT_OK_KEY = "tennis_scout_last_ok";
const TENNIS_SCOUT_ERR_KEY = "tennis_scout_last_error";
// A tennis match whose scheduled kickoff is within this many minutes in the past SHOULD still be
// generating scout data (an upper bound on match length). Schedule is EXTERNAL — it doesn't die with
// the scout, so it's a safe liveness reference (match.state is NOT — the scout drives it). Env-tunable.
const TENNIS_PLAY_CEILING_MIN = (() => { const n = Number(process.env.TENNIS_PLAY_CEILING_MIN); return Number.isFinite(n) && n > 0 ? n : 300; })();
// Scout is "silent" if no snapshot has been WRITTEN in this many minutes while a match is due-live. Env-tunable.
const TENNIS_SCOUT_SILENT_MIN = (() => { const n = Number(process.env.TENNIS_SCOUT_SILENT_MIN); return Number.isFinite(n) && n > 0 ? n : 15; })();

/**
 * SCOUT WATCHDOG (the signal the scout never had). Compares the scout's data-freshness to the EXTERNAL
 * schedule (match kickoff times, which don't die with the scout — unlike match.state, which the scout
 * itself drives). Returns silent=true when ≥1 tennis match should be live per its kickoff yet no
 * snapshot has landed in TENNIS_SCOUT_SILENT_MIN, with an H1/H2 cause hint from the OK/ERR markers:
 *   • OK stamp fresh, writes stale  → loop ALIVE, provider blind/empty (H2)
 *   • recent ERR marker             → provider is throwing
 *   • OK stamp stale                → scout not being called at all — loop/process down (H1)
 * Pure read; the caller alerts (throttled). No due-live match → not silent (a genuinely quiet slate).
 */
export function tennisScoutSilence(db: Database, deps: EngineDeps = {}): { silent: boolean; note: string } {
  const nowMs = Date.parse(nowFn(deps)()) || Date.now();
  // Only IN-SCOPE (ATP/WTA singles) matches count as "due-live that matters": ITF/Challenger/doubles
  // aren't traded and may not even be streamed by the provider, so a quiet ITF-only window is NOT a scout
  // failure — counting them would make the watchdog cry wolf on every low-activity ITF slate.
  const due = R.listCompetitions(db).filter((c) => c.sport_id === "tennis" && tennisTourOf(c) != null)
    .flatMap((c) => R.listMatches(db, c.id))
    .filter((m) => m.state !== "finished" && m.kickoff_at != null)
    .filter((m) => { const k = Date.parse(m.kickoff_at as string) || 0; return k > 0 && k <= nowMs && nowMs - k <= TENNIS_PLAY_CEILING_MIN * 60_000; });
  if (!due.length) return { silent: false, note: "" };
  const lastWrite = (db.prepare(`SELECT MAX(batch_at) b FROM tennis_snapshots`).get() as { b?: string } | undefined)?.b;
  const writeAgeMin = lastWrite ? (nowMs - (Date.parse(lastWrite) || 0)) / 60_000 : Infinity;
  if (writeAgeMin <= TENNIS_SCOUT_SILENT_MIN) return { silent: false, note: "" };
  const okRaw = R.metaGet(db, TENNIS_SCOUT_OK_KEY);
  const okMs = okRaw ? Number(okRaw.split("|")[0]) || 0 : 0;
  const errRaw = R.metaGet(db, TENNIS_SCOUT_ERR_KEY);
  const errMs = errRaw ? Number(errRaw.split("|")[0]) || 0 : 0;
  const recentErr = errMs > nowMs - TENNIS_SCOUT_SILENT_MIN * 60_000;
  const cause = okMs > nowMs - TENNIS_SCOUT_SILENT_MIN * 60_000
    ? "луп ЖИВ, но провайдер отдаёт пусто/не мапится (H2 — слепой скаут)"
    : recentErr ? `провайдер падает: ${errRaw!.split("|").slice(1).join("|")}`
    : "скаут не вызывался — луп/процесс его не крутит (H1)";
  const ageTxt = Number.isFinite(writeAgeMin) ? `${Math.round(writeAgeMin)} мин` : "никогда";
  return { silent: true, note: `⚠ СКАУТ МОЛЧИТ (${ageTxt}) при ${due.length} матч(ах), которые по расписанию должны быть live — ${cause}` };
}

// ── §4 Passive break marker: the panic window on the broken player's winner market ──
const MARK_DELAY_MS = 6 * 60_000; // a break is markable once its +6min window is complete
const BREAK_R = [1, 2, 3, 5];

/**
 * Persist a panic-window mark for every confirmed break on a MAPPED match, once the break's
 * +6min window has elapsed. Idempotent (skip already-marked). Reuses the football window math
 * (overreactionLatency.computeWindowMetrics) over the broken player's winner-price series
 * captured in tennis_snapshots. Read-only; never throws into the caller.
 */
export function recordTennisBreakMarks(db: Database, deps: EngineDeps = {}): number {
  const now = nowFn(deps)();
  const nowMs = Date.parse(now) || Date.now();
  const codeVer = effectiveCodeVersion(db);
  let written = 0;
  for (const key of R.tennisSnapshotEventKeys(db)) {
    const rows = R.tennisSnapshotsForEvent(db, key);
    const breaks = detectBreaks(rows);
    if (!breaks.length) continue;
    const already = R.tennisBreakMarkCountForEvent(db, key);
    if (already >= breaks.length) continue; // all marked
    // Build the broken player's winner-price series (bid unavailable → mid as the quote).
    const marked = already; // simple high-water mark: only add breaks beyond the count we stored
    let idx = 0;
    for (const br of breaks) {
      idx++;
      if (idx <= marked) continue;                 // already persisted this break (ordered, idempotent)
      const at = Date.parse(br.batchAt);
      if (nowMs - at < MARK_DELAY_MS) continue;    // window not complete yet
      const first = rows[0];
      const pmMatchId = rows.find((r) => r.pm_match_id)?.pm_match_id ?? null;
      // The broken side's winner price. Winner markets are complementary, so if only the OTHER
      // side's market was matched, derive the broken side's price as 100 − other (robustness:
      // a break marks whichever side we can price).
      const priceOf = (r: R.TennisSnapshotRow) => {
        const own = br.server === "first" ? r.pm_p1_cents : r.pm_p2_cents;
        if (own != null) return own;
        const other = br.server === "first" ? r.pm_p2_cents : r.pm_p1_cents;
        return other != null ? Math.round((100 - other) * 10) / 10 : null;
      };
      const series = rows.filter((r) => priceOf(r) != null).map((r) => ({ provider: "polymarket", batch_at: r.batch_at, extracted: JSON.stringify({ markets: [{ label: "win", bidCents: priceOf(r), midCents: priceOf(r) }] }) }));
      const wm = computeWindowMetrics(polymarketSeries(series, "win"), at, undefined, codeVer);
      // Further-collapse metric (floor calibration, read later): from the break (≈ where the
      // buyback enters) FORWARD over the full available series — the LOWEST favourite price and
      // time to it. Unlike floor_cents (bounded to the ±window), this sees a LATE collapse
      // (injury/cascade past the recovery window); how far it falls below entry is what a
      // data-driven catastrophic floor needs, which the panic-amplitude columns can't set.
      let postMinCents: number | null = null, postMinSec: number | null = null;
      for (const r of rows) {
        const t = Date.parse(r.batch_at), p = priceOf(r);
        if (p == null || !(t >= at)) continue;
        if (postMinCents == null || p < postMinCents) { postMinCents = p; postMinSec = Math.round((t - at) / 1000); }
      }
      const setNum = br.setNum;
      const broke_early = setNum != null && setNum <= 1 ? 1 : (setNum === 2 && (first?.sets_p1 ?? 0) + (first?.sets_p2 ?? 0) <= 1 ? 1 : 0);
      R.insertTennisBreakMark(db, {
        event_key: key, match_id: pmMatchId, players: `${first?.p1 ?? "?"} vs ${first?.p2 ?? "?"}`,
        tournament: first?.tournament ?? null, event_type: first?.event_type ?? null, set_num: setNum,
        broken_side: br.server, broke_early, t_event: br.batchAt,
        pre_cents: wm.panicAmplitudeCents != null && wm.priceFloorCents != null ? Math.round((wm.priceFloorCents + wm.panicAmplitudeCents) * 10) / 10 : null,
        floor_cents: wm.priceFloorCents, t_floor_sec: wm.tFloorSec, panic_cents: wm.panicAmplitudeCents,
        recovery_1: wm.recovery["1"], recovery_2: wm.recovery["2"], recovery_3: wm.recovery["3"], recovery_5: wm.recovery["5"],
        post_entry_min_cents: postMinCents, post_entry_min_sec: postMinSec,
        window_quotes: wm.windowQuotes, confidence_flags: wm.flags.length ? wm.flags.join(",") : null, code_version: codeVer, created_at: now,
      });
      written++;
    }
  }
  return written;
}

// ── Offline event detector (deterministic — §9.6: code, no LLM) ──
export type TennisEventType = "break" | "hold" | "set_won" | "match_finished" | "retirement" | "walkover" | "correction" | "tiebreak_set";
export interface TennisEvent {
  eventKey: string; type: TennisEventType; batchAt: string;
  setNum: number | null; server: "first" | "second" | null; winner: "first" | "second" | null;
  brokenPlayer: string | null; scoreBefore: string | null; scoreAfter: string | null; note?: string;
}
export interface BreakEvent { eventKey: string; batchAt: string; setNum: number; server: "first" | "second"; winner: "first" | "second"; brokenPlayer: string; gameScore: string }

const RETIRE = /retir|\bret\.?\b|ретай/i;
const WALKOVER = /walkover|w[\/.]o\b|w\.o/i;
const FINISHED = /finish|заверш|final/i;

/**
 * Full deterministic event stream from one match's snapshots (sorted). Handles:
 *  · break (server lost their game) vs hold (server held)
 *  · set_won / tiebreak_set (a 6-6 game decides the set — break logic does NOT apply)
 *  · match_finished / retirement / walkover (from status)
 *  · DEBOUNCE: a game change is confirmed only if it PERSISTS into the next snapshot; a
 *    change that reverts next snapshot is a provider correction (emitted, not acted on).
 *  · >1-game jumps (missed polls) are skipped as coverage gaps, never guessed.
 */
export function detectTennisEvents(rows: R.TennisSnapshotRow[]): TennisEvent[] {
  const out: TennisEvent[] = [];
  const s = [...rows].sort((a, b) => (a.batch_at < b.batch_at ? -1 : 1));
  const gs = (r: R.TennisSnapshotRow) => `${r.games_p1}-${r.games_p2}`;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    if (a.set_num == null || b.set_num == null) continue;
    if (b.set_num > a.set_num) { // a set completed
      out.push({ eventKey: b.event_key, type: "set_won", batchAt: b.batch_at, setNum: a.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b), note: a.games_p1 === 6 && a.games_p2 === 6 ? "tiebreak" : undefined });
      continue;
    }
    if (b.set_num < a.set_num) continue;
    if (a.games_p1 == null || a.games_p2 == null || b.games_p1 == null || b.games_p2 == null) continue;
    const da = b.games_p1 - a.games_p1, dbb = b.games_p2 - a.games_p2;
    if (da === 0 && dbb === 0) continue;
    if (da < 0 || dbb < 0) { out.push({ eventKey: b.event_key, type: "correction", batchAt: b.batch_at, setNum: b.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b) }); continue; }
    if (da + dbb !== 1) continue; // missed poll → coverage gap, don't guess
    // Tiebreak: a game completed FROM 6-6 decides the set — not a break.
    if (a.games_p1 === 6 && a.games_p2 === 6) { out.push({ eventKey: b.event_key, type: "tiebreak_set", batchAt: b.batch_at, setNum: b.set_num, server: null, winner: da === 1 ? "first" : "second", brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b), note: "tiebreak" }); continue; }
    // DEBOUNCE: confirm the new score persists; a same-tick reversal is a correction.
    const n = s[i + 1];
    if (n && n.set_num === a.set_num && n.games_p1 === a.games_p1 && n.games_p2 === a.games_p2) { out.push({ eventKey: b.event_key, type: "correction", batchAt: b.batch_at, setNum: b.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b) }); continue; }
    const winner: "first" | "second" = da === 1 ? "first" : "second";
    const server = a.server; // who served the just-finished game
    if (server !== "first" && server !== "second") continue;
    if (winner === server) { out.push({ eventKey: b.event_key, type: "hold", batchAt: b.batch_at, setNum: b.set_num, server, winner, brokenPlayer: null, scoreBefore: gs(a), scoreAfter: gs(b) }); continue; }
    out.push({ eventKey: b.event_key, type: "break", batchAt: b.batch_at, setNum: b.set_num, server, winner, brokenPlayer: server === "first" ? (b.p1 ?? "first") : (b.p2 ?? "second"), scoreBefore: gs(a), scoreAfter: gs(b) });
  }
  // Terminal state from the last snapshot's status (retirement mid-game is detectable here).
  const last = s[s.length - 1];
  if (last) {
    const st = String(last.status ?? "");
    if (RETIRE.test(st)) out.push({ eventKey: last.event_key, type: "retirement", batchAt: last.batch_at, setNum: last.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: null, scoreAfter: gs(last) });
    else if (WALKOVER.test(st)) out.push({ eventKey: last.event_key, type: "walkover", batchAt: last.batch_at, setNum: last.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: null, scoreAfter: null });
    else if (FINISHED.test(st) || last.live === 0) out.push({ eventKey: last.event_key, type: "match_finished", batchAt: last.batch_at, setNum: last.set_num, server: null, winner: null, brokenPlayer: null, scoreBefore: null, scoreAfter: gs(last) });
  }
  return out;
}

/** Just the confirmed BREAK events (server lost their service game). */
export function detectBreaks(rows: R.TennisSnapshotRow[]): BreakEvent[] {
  return detectTennisEvents(rows).filter((e) => e.type === "break").map((e) => ({
    eventKey: e.eventKey, batchAt: e.batchAt, setNum: e.setNum as number, server: e.server as "first" | "second",
    winner: e.winner as "first" | "second", brokenPlayer: e.brokenPlayer as string, gameScore: e.scoreAfter as string,
  }));
}

// ── Report ──
export interface TennisScoutReport {
  provider: string; totalSnapshots: number; events: number;
  coverageByType: { type: string; events: number }[];
  perEvent: { eventKey: string; players: string; tournament: string | null; type: string | null; snapshots: number; medianCadenceSec: number | null; breaks: number; linkedToPolymarket: boolean; gaps: number }[];
  breaks: BreakEvent[];
  lag: { measured: number; medianLagSec: number | null; note: string };
  limitations: string[];
}
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function buildTennisScoutReport(db: Database): TennisScoutReport {
  const keys = R.tennisSnapshotEventKeys(db);
  const perEvent: TennisScoutReport["perEvent"] = [];
  const allBreaks: BreakEvent[] = [];
  const typeCount = new Map<string, Set<string>>();
  let total = 0;
  const lagSamples: number[] = [];
  for (const k of keys) {
    const rows = R.tennisSnapshotsForEvent(db, k);
    total += rows.length;
    const t = rows[0]?.event_type ?? "(unknown)";
    (typeCount.get(t) ?? typeCount.set(t, new Set()).get(t)!).add(k);
    // cadence + gaps
    const gapsSec: number[] = [];
    for (let i = 1; i < rows.length; i++) gapsSec.push((Date.parse(rows[i].batch_at) - Date.parse(rows[i - 1].batch_at)) / 1000);
    const breaks = detectBreaks(rows);
    allBreaks.push(...breaks);
    // lag vs Polymarket: for each break, when did the linked mid move ≥ MOVE_CENTS after it?
    const MOVE_CENTS = 4;
    for (const br of breaks) {
      const withMid = rows.filter((r) => r.pm_mid_cents != null);
      const at = Date.parse(br.batchAt);
      const before = withMid.filter((r) => Date.parse(r.batch_at) <= at).slice(-1)[0];
      if (!before || before.pm_mid_cents == null) continue;
      const after = withMid.find((r) => Date.parse(r.batch_at) > at && Math.abs((r.pm_mid_cents as number) - (before.pm_mid_cents as number)) >= MOVE_CENTS);
      if (after) lagSamples.push((Date.parse(after.batch_at) - at) / 1000);
    }
    perEvent.push({
      eventKey: k, players: `${rows[0]?.p1 ?? "?"} vs ${rows[0]?.p2 ?? "?"}`, tournament: rows[0]?.tournament ?? null,
      type: rows[0]?.event_type ?? null, snapshots: rows.length,
      medianCadenceSec: gapsSec.length ? Math.round(median(gapsSec) as number) : null,
      breaks: breaks.length, linkedToPolymarket: rows.some((r) => r.pm_match_id != null),
      gaps: gapsSec.filter((g) => g > 40).length,
    });
  }
  return {
    provider: "apitennis", totalSnapshots: total, events: keys.length,
    coverageByType: [...typeCount.entries()].map(([type, s]) => ({ type, events: s.size })).sort((a, b) => b.events - a.events),
    perEvent: perEvent.sort((a, b) => b.snapshots - a.snapshots),
    breaks: allBreaks,
    lag: { measured: lagSamples.length, medianLagSec: lagSamples.length ? Math.round(median(lagSamples) as number) : null,
      note: lagSamples.length ? "медианный лаг: Polymarket сдвинулся ≥4¢ ПОСЛЕ детекции брейка (сек)" : "нет измерений лага — нужен линк к Polymarket-матчу + захваченный mid вокруг брейка" },
    limitations: [
      "один провайдер (API-Tennis) — лаг меряется относительно движения Polymarket, не относительно второго счёт-провайдера",
      "брейки при пропуске поллов (скачок >1 гейма за снапшот) не атрибутируются — считаются как gaps, не угадываются",
      "линк к Polymarket по фамилиям обоих игроков; несопоставленные матчи меряют только качество провайдера, без лага",
    ],
  };
}

// ── §4 break-marker report: panic calibration by context ──
export interface TennisBreakReport {
  totalMarks: number; targetForCalibration: number; ready: boolean;
  rawMarks: number; unmeasured: number; mapping: { auto: number; review: number; skip: number };
  byContext: { context: string; n: number; medianPanic: number | null; medianFloor: number | null; medianTFloorSec: number | null }[];
  overall: { medianPanic: number | null; medianFloor: number | null; medianRecovery2: number | null };
  note: string;
}
const CALIB_TARGET = 100;
export function buildTennisBreakReport(db: Database): TennisBreakReport {
  const allMarks = R.listTennisBreakMarks(db);
  const marks = allMarks.filter((m) => m.panic_cents != null); // measurable only (has a price window)
  const mapLog = R.tennisMapLog(db, 5000);
  const mapping = { auto: mapLog.filter((m) => m.verdict === "auto").length, review: mapLog.filter((m) => m.verdict === "review").length, skip: mapLog.filter((m) => m.verdict === "skip").length };
  const groups = new Map<string, R.TennisBreakMarkRow[]>();
  const levelOf = (t: string | null) => /challenger/i.test(t ?? "") ? "Challenger" : /wta/i.test(t ?? "") ? "WTA" : /atp|men/i.test(t ?? "") ? "ATP" : (t ?? "?");
  for (const m of marks) {
    const ctx = `${levelOf(m.event_type)} · ${m.broke_early ? "early" : "late"}`;
    (groups.get(ctx) ?? groups.set(ctx, []).get(ctx)!).push(m);
  }
  const med = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2 * 10) / 10) : null; };
  return {
    totalMarks: marks.length, targetForCalibration: CALIB_TARGET, ready: marks.length >= CALIB_TARGET,
    rawMarks: allMarks.length, unmeasured: allMarks.length - marks.length, mapping,
    byContext: [...groups.entries()].map(([context, ms]) => ({
      context, n: ms.length, medianPanic: med(ms.map((m) => m.panic_cents)), medianFloor: med(ms.map((m) => m.floor_cents)), medianTFloorSec: med(ms.map((m) => m.t_floor_sec)),
    })).sort((a, b) => b.n - a.n),
    overall: { medianPanic: med(marks.map((m) => m.panic_cents)), medianFloor: med(marks.map((m) => m.floor_cents)), medianRecovery2: med(marks.map((m) => m.recovery_2)) },
    note: marks.length >= CALIB_TARGET
      ? "≥100 брейков — можно калибровать армед-цены из распределения (новая эпоха, thresholds=calibrated)"
      : `накоплено ${marks.length}/${CALIB_TARGET} брейков — армед-цены остаются interim, копим`,
  };
}

// ── T1 (batch-3): SCOUT LINK-RATE report — the first-priority diagnostic ──────────────────────
// Everything downstream stands on the scout linking the API-Tennis live match to the Polymarket app
// match (mapTennisMatch → verdict "auto"): overreaction/set_value only tick on linked snapshots, the
// shadow cohorts only fill from linked matches, break-marks only accrue when linked. The 19-log "0
// snapshots · скаут не привязал" reading could be a RETENTION artifact (snapshots pruned) OR the real
// prod truth. This report answers it from the PERSISTENT source: tennis_map_log records every mapping
// DECISION at the time it was made (kept independently of snapshot pruning), so its auto-share is the
// true decision-time link-rate. Split by day + reason (gray-zone vs no-candidate) + examples, and cross-
// checked against the CURRENT snapshot linkage so a low number can be attributed (mapping vs discovery).
export interface LinkRateDay { day: string; total: number; auto: number; review: number; skip: number; linkPct: number }
export interface LinkRateExample { players: string; verdict: string; bestScore: number; bestCandidate: string | null; day: string }
export interface TennisLinkRateReport {
  totalEvents: number; auto: number; review: number; skip: number; linkPct: number;
  grayZone: number; noCandidate: number;
  byDay: LinkRateDay[];
  unlinkedExamples: LinkRateExample[];
  betsWithProvenance: number; betsTotal: number;
  currentlyLinkedMatches: number; currentLiveTennisMatches: number;
  mapAuto: number; mapReview: number;
  note: string;
}
export function buildTennisLinkRate(db: Database): TennisLinkRateReport {
  const rank = (v: string): number => (v === "auto" ? 2 : v === "review" ? 1 : 0);
  // Collapse the per-pass rows to ONE verdict per distinct match (event_key): the BEST it ever reached
  // (a match that ever auto-linked is linked). Keep its top score, latest players, first-seen day.
  const best = new Map<string, { players: string; verdict: string; score: number; candidates: string | null; day: string }>();
  for (const r of R.tennisMapLog(db, 20000)) {
    const day = (r.created_at ?? "").slice(0, 10);
    const cur = best.get(r.event_key);
    const score = Number(r.score ?? 0) || 0;
    if (!cur || rank(r.verdict) > rank(cur.verdict) || (rank(r.verdict) === rank(cur.verdict) && score > cur.score)) {
      best.set(r.event_key, { players: r.players ?? "?", verdict: r.verdict, score, candidates: r.candidates, day: cur?.day ?? day });
    } else if (cur && day < cur.day) cur.day = day;
  }
  const events = [...best.values()];
  const auto = events.filter((e) => e.verdict === "auto").length;
  const review = events.filter((e) => e.verdict === "review").length;
  const skip = events.filter((e) => e.verdict === "skip").length;
  const total = events.length;
  // Reason split for the UNLINKED (non-auto): gray-zone = a candidate scored into [MAP_REVIEW, MAP_AUTO)
  // (names nearly matched — a normalization/threshold near-miss); no-candidate = nothing scored that high
  // (the match likely isn't in Polymarket discovery at all, NOT a name-order problem).
  const grayZone = events.filter((e) => e.verdict !== "auto" && e.score >= MAP_REVIEW).length;
  const noCandidate = events.filter((e) => e.verdict !== "auto" && e.score < MAP_REVIEW).length;
  const byDayMap = new Map<string, LinkRateDay>();
  for (const e of events) {
    const d = byDayMap.get(e.day) ?? { day: e.day, total: 0, auto: 0, review: 0, skip: 0, linkPct: 0 };
    d.total++; if (e.verdict === "auto") d.auto++; else if (e.verdict === "review") d.review++; else d.skip++;
    byDayMap.set(e.day, d);
  }
  const byDay = [...byDayMap.values()].map((d) => ({ ...d, linkPct: d.total ? Math.round((d.auto / d.total) * 1000) / 10 : 0 })).sort((a, b) => b.day.localeCompare(a.day));
  const topCand = (c: string | null): string | null => {
    try { const arr = JSON.parse(c ?? "[]"); const t = arr[0]; return t ? `${t.home} — ${t.away} (score ${t.score ?? t.nameScore ?? "?"})` : null; } catch { return null; }
  };
  const unlinkedExamples = events.filter((e) => e.verdict !== "auto")
    .sort((a, b) => b.score - a.score) // closest near-misses first — the actionable ones
    .slice(0, 25).map((e) => ({ players: e.players, verdict: e.verdict, bestScore: e.score, bestCandidate: topCand(e.candidates), day: e.day }));
  // Independent corroboration #1: bets whose entry carried a data_provenance source (proves a snapshot
  // backed the decision at the time — immune to later snapshot pruning).
  const tennisMatchIds = new Set(R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id).map((m) => m.id)));
  let betsWithProvenance = 0, betsTotal = 0;
  for (const b of R.allBets(db)) {
    if (!tennisMatchIds.has(b.match_id)) continue;
    betsTotal++;
    try { if (parseEntryMeta(b.entry_meta)?.dataProvenance?.source) betsWithProvenance++; } catch { /* ignore */ }
  }
  // Independent corroboration #2: the CURRENT snapshot linkage (subject to pruning) — if this is 0 but the
  // map-log auto-share is high, the "0 snapshots" logs were a RETENTION artifact, not a mapping failure.
  let currentlyLinkedMatches = 0, currentLiveTennisMatches = 0;
  for (const mid of tennisMatchIds) {
    const linked = (db.prepare(`SELECT COUNT(*) n FROM tennis_snapshots WHERE pm_match_id=?`).get(mid) as { n: number }).n;
    if (linked > 0) currentlyLinkedMatches++;
  }
  currentLiveTennisMatches = R.listCompetitions(db).filter((c) => c.sport_id === "tennis").flatMap((c) => R.listMatches(db, c.id)).filter((m) => m.state === "live").length;
  const linkPct = total ? Math.round((auto / total) * 1000) / 10 : 0;
  const note = total === 0
    ? "нет решений маппинга в журнале — скаут ещё не видел ни одного live-матча (проверь API_TENNIS_KEY и что идут ATP/WTA матчи)"
    : linkPct >= 80
      ? `link-rate ${linkPct}% (${auto}/${total}) — скаут привязывает нормально; «0 снапшотов» в старых логах — это ретеншн (снапшоты подчищены), НЕ провал маппинга`
      : grayZone >= noCandidate
        ? `link-rate ${linkPct}% (${auto}/${total}) НИЗКИЙ, доминируют gray-zone (${grayZone}) — имена почти сходятся, но не дотягивают до порога ${MAP_AUTO}; чинить нормализацию/порог (примеры ниже — ближайшие промахи)`
        : `link-rate ${linkPct}% (${auto}/${total}) НИЗКИЙ, доминирует no-candidate (${noCandidate}) — матча нет в Polymarket-дискавери (не проблема порядка имён); смотреть покрытие рынков, не маппинг`;
  return { totalEvents: total, auto, review, skip, linkPct, grayZone, noCandidate, byDay, unlinkedExamples, betsWithProvenance, betsTotal, currentlyLinkedMatches, currentLiveTennisMatches, mapAuto: MAP_AUTO, mapReview: MAP_REVIEW, note };
}
export function tennisLinkRateMarkdown(r: TennisLinkRateReport): string {
  const L: string[] = [];
  L.push(`# Теннис — link-rate скаута (API-Tennis ↔ Polymarket)`);
  L.push("");
  L.push(`**${r.note}**`);
  L.push("");
  L.push(`- Всего матчей в журнале маппинга: **${r.totalEvents}** · привязано (auto) **${r.auto}** · серая зона (review) ${r.review} · не найдено (skip) ${r.skip}`);
  L.push(`- **Link-rate: ${r.linkPct}%** (порог auto=${r.mapAuto}, review=${r.mapReview})`);
  L.push(`- Причина непривязки: gray-zone (почти сошлось) ${r.grayZone} · no-candidate (нет матча) ${r.noCandidate}`);
  L.push(`- Проверка ретеншна: снапшоты сейчас привязаны у ${r.currentlyLinkedMatches} матчей · live-теннис сейчас ${r.currentLiveTennisMatches} · ставок с provenance ${r.betsWithProvenance}/${r.betsTotal}`);
  L.push("");
  L.push(`## По дням`);
  L.push(`| день | всего | auto | review | skip | link-rate |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const d of r.byDay.slice(0, 30)) L.push(`| ${d.day} | ${d.total} | ${d.auto} | ${d.review} | ${d.skip} | ${d.linkPct}% |`);
  L.push("");
  L.push(`## Непривязанные — ближайшие промахи (кандидат на починку нормализации)`);
  L.push(`| API-Tennis игроки | вердикт | score | лучший кандидат Polymarket | день |`);
  L.push(`|---|---|---|---|---|`);
  for (const e of r.unlinkedExamples) L.push(`| ${e.players} | ${e.verdict} | ${e.bestScore} | ${e.bestCandidate ?? "—"} | ${e.day} |`);
  return L.join("\n");
}

// ── Part B: recovery-vs-no-recovery calibration report (build now, READ after ~100 marks) ──
// A mark "recovered" when the price climbed back to within the take buffer of the pre-break level
// (recovery_N ≥ panic − buffer for some window N) — the same definition the live take_price uses.
// From the recovered set we read HOW FAST the buyback pays (→ calibrates K and confirms the take
// buffer); from the no-recovery set we read HOW FAR it slid (→ calibrates the catastrophic floor).
const TAKE_BUFFER_FOR_CALIB = (() => { const n = Number(process.env.TENNIS_TAKE_BUFFER_CENTS); return Number.isFinite(n) && n >= 0 ? n : 3; })();
const RECOVERY_MINUTES: [keyof R.TennisBreakMarkRow, number][] = [["recovery_1", 1], ["recovery_2", 2], ["recovery_3", 3], ["recovery_5", 5]];

export interface TennisCalibrationReport {
  measured: number; target: number; ready: boolean;
  recovery: { n: number; share: number; withinMin: { p25: number | null; p50: number | null; p75: number | null }; note: string };
  noRecovery: { n: number; slideCents: { p25: number | null; p50: number | null; p75: number | null; p90: number | null }; note: string };
  byContext: { context: string; n: number; recoveryShare: number; medianEntry: number | null }[];
  suggests: { takeBufferCents: number | null; catastrophicFloorCents: number | null; gameCountK: number | null };
  note: string;
}

/** The earliest window-minute at which a mark recovered to (pre − buffer); null = never recovered. */
function recoveredWithinMin(m: R.TennisBreakMarkRow, buffer: number): number | null {
  if (m.panic_cents == null) return null;
  const need = m.panic_cents - buffer; // cents of recovery required to reach (pre − buffer)
  for (const [k, min] of RECOVERY_MINUTES) { const v = m[k] as number | null; if (v != null && v >= need) return min; }
  return null;
}
const pctl = (xs: number[], p: number): number | null => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); const i = Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1)))); return Math.round(v[i] * 10) / 10; };

export function buildTennisCalibrationReport(db: Database): TennisCalibrationReport {
  const marks = R.listTennisBreakMarks(db).filter((m) => m.panic_cents != null); // measurable only
  const levelOf = (t: string | null) => /challenger/i.test(t ?? "") ? "Challenger" : /wta/i.test(t ?? "") ? "WTA" : /atp|men/i.test(t ?? "") ? "ATP" : (t ?? "?");
  const recovered: R.TennisBreakMarkRow[] = [], noRec: R.TennisBreakMarkRow[] = [];
  const recMin: number[] = [];
  for (const m of marks) { const w = recoveredWithinMin(m, TAKE_BUFFER_FOR_CALIB); if (w != null) { recovered.push(m); recMin.push(w); } else noRec.push(m); }
  const slides = noRec.map((m) => m.panic_cents as number); // pre − floor: how far it slid with no comeback
  // Context split: recovery share by (level · early/late).
  const groups = new Map<string, R.TennisBreakMarkRow[]>();
  for (const m of marks) { const ctx = `${levelOf(m.event_type)} · ${m.broke_early ? "early" : "late"}`; (groups.get(ctx) ?? groups.set(ctx, []).get(ctx)!).push(m); }
  const med = (xs: (number | null)[]) => pctl(xs.filter((x): x is number => x != null), 50);
  const ready = marks.length >= CALIB_TARGET;
  // Suggestions are RENDERED but only trustworthy at the target — the report says so.
  const floorP90 = pctl(slides, 90);
  return {
    measured: marks.length, target: CALIB_TARGET, ready,
    recovery: {
      n: recovered.length, share: marks.length ? Math.round(recovered.length / marks.length * 100) / 100 : 0,
      withinMin: { p25: pctl(recMin, 25), p50: pctl(recMin, 50), p75: pctl(recMin, 75) },
      note: "минуты окна, за которые цена вернулась к (предбрейк − буфер) — верхняя граница жизни edge → калибрует K и буфер тейка",
    },
    noRecovery: {
      n: noRec.length, slideCents: { p25: pctl(slides, 25), p50: pctl(slides, 50), p75: pctl(slides, 75), p90: floorP90 },
      note: "насколько цена сползла без возврата (pre − floor) — хвост калибрует катастрофический floor",
    },
    byContext: [...groups.entries()].map(([context, ms]) => {
      const rec = ms.filter((m) => recoveredWithinMin(m, TAKE_BUFFER_FOR_CALIB) != null).length;
      return { context, n: ms.length, recoveryShare: ms.length ? Math.round(rec / ms.length * 100) / 100 : 0, medianEntry: med(ms.map((m) => m.floor_cents)) };
    }).sort((a, b) => b.n - a.n),
    // Interim suggestions from the current sample (floor ≈ the no-recovery p90 slide; K from the median recovery minute ≈ ~2min/receiving game).
    suggests: {
      takeBufferCents: TAKE_BUFFER_FOR_CALIB,
      catastrophicFloorCents: floorP90,
      gameCountK: recMin.length ? Math.max(2, Math.ceil((pctl(recMin, 75) ?? 6) / 2)) : null,
    },
    note: ready
      ? "≥100 марок — калибровка готова: подставить floor из no-recovery p90, K из recovery p75, сверить армед-цены по recoveryShare контекстов (эпоха → calibrated)"
      : `марок ${marks.length} из ${CALIB_TARGET} — структура готова, читаем после набора (числа interim)`,
  };
}

export function tennisCalibrationMarkdown(rep: TennisCalibrationReport): string {
  const pc = (x: number | null) => x == null ? "—" : `${x}`;
  const L: string[] = [];
  L.push(`# Теннис — калибровка выкупа (recovery vs no-recovery)`);
  L.push(`Измеримых марок: **${rep.measured} / ${rep.target}** — ${rep.ready ? "**готово к калибровке**" : "копим (числа interim)"}`);
  L.push(`\n## Recovery (выкуп сыграл)`);
  L.push(`n=${rep.recovery.n}, доля ${(rep.recovery.share * 100).toFixed(0)}%. Возврат за минуты окна: p25 ${pc(rep.recovery.withinMin.p25)} · p50 ${pc(rep.recovery.withinMin.p50)} · p75 ${pc(rep.recovery.withinMin.p75)}.`);
  L.push(`_${rep.recovery.note}_`);
  L.push(`\n## No-recovery (возврата не было)`);
  L.push(`n=${rep.noRecovery.n}. Сполз (¢): p25 ${pc(rep.noRecovery.slideCents.p25)} · p50 ${pc(rep.noRecovery.slideCents.p50)} · p75 ${pc(rep.noRecovery.slideCents.p75)} · p90 ${pc(rep.noRecovery.slideCents.p90)}.`);
  L.push(`_${rep.noRecovery.note}_`);
  L.push(`\n## По контексту (доля recovery)`);
  L.push(`| контекст | n | recovery | медиана floor¢ |`);
  L.push(`|---|---|---|---|`);
  for (const c of rep.byContext) L.push(`| ${c.context} | ${c.n} | ${(c.recoveryShare * 100).toFixed(0)}% | ${pc(c.medianEntry)} |`);
  L.push(`\n## Предложения (interim до набора)`);
  L.push(`- буфер тейка: ${pc(rep.suggests.takeBufferCents)}¢ · катастрофический floor ≈ ${pc(rep.suggests.catastrophicFloorCents)}¢ (no-recovery p90) · K ≈ ${pc(rep.suggests.gameCountK)} приёмных гейма`);
  L.push(`\n${rep.note}`);
  return L.join("\n");
}

/** Per-mark CSV with the recovery classification for the calibration split. */
export function tennisCalibrationCsv(db: Database): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["t_event", "players", "event_type", "broke_early", "pre_cents", "floor_cents", "panic_cents", "recovery_1", "recovery_2", "recovery_3", "recovery_5", "recovered", "recovered_within_min"];
  const rows = R.listTennisBreakMarks(db).filter((m) => m.panic_cents != null).map((m) => {
    const w = recoveredWithinMin(m, TAKE_BUFFER_FOR_CALIB);
    return [m.t_event, m.players, m.event_type, m.broke_early, m.pre_cents, m.floor_cents, m.panic_cents, m.recovery_1, m.recovery_2, m.recovery_3, m.recovery_5, w != null ? 1 : 0, w ?? ""].map(esc).join(",");
  });
  return [head.join(","), ...rows].join("\n");
}

// ── Overreaction CALIBRATION Step 1 — armed-COHORT diagnostic (Petro's 6 conditions) ──────────────
// The pooled 1529 marks are every break (underdogs, coin-flips, late sets); the strategy arms only a
// FAVOURITE broken EARLY. Calibrating armed prices off the pooled median (floor ≈ 22¢) would repeat
// the PMV mistake. This filters to the armed cohort and answers, per Petro's formula, whether it has a
// TRADEABLE recovery edge — before any calibration.
//   #1 favourite = pre_cents ≥ 60¢ (primary); 55–60¢ reported as a separate sensitivity band, never merged.
//   #2 buyback entry = floor p60 (conservative-rarity, per B6).
//   #3 go/no-go = recovery ≥ max(55%, breakeven+5pp); breakeven from the cohort's OWN levels
//      (E=floor p60, T=pre−3, S=pre−slide p90). Marks are mid (no spread/fill) so recovery% is an
//      UPPER bound → the +5pp margin is mandatory.
//   #4 sufficiency: primary needs n≥80 (else "insufficient"); a per-tour verdict needs that tour n≥40.
//   #6 recovery = reached the TAKE level (pre−3¢) within ≤2 min of the FLOOR — recovery_N is already
//      measured from the floor (overreactionLatency: target = floorTime + N·60s), so this is exact:
//      max(recovery_1, recovery_2) ≥ panic − 3.
const OVR_TAKE_BUFFER = 3;              // ¢ below pre = the recovery take level (#3/#6)
const OVR_FAV_MIN_PRIMARY = 60;         // #1 clear favourite
const OVR_FAV_MIN_SENSITIVITY = 55;     // #1 sensitivity band lower bound
const OVR_MIN_N_PRIMARY = 80;           // #4
const OVR_MIN_N_TOUR = 40;              // #4
const OVR_FLOOR_HARD = 0.55;            // #3 hard recovery floor
const OVR_MARGIN_PP = 0.05;             // #3 mandatory margin over breakeven (mid → upper-bound)
const ovrTour = (t: string | null): "ATP" | "WTA" | null => /challenger/i.test(t ?? "") ? null : /wta|women/i.test(t ?? "") ? "WTA" : /atp|men/i.test(t ?? "") ? "ATP" : null;
/** #6: did the favourite snap back to the take level (pre−3) within ≤2 min of the FLOOR? */
function ovrReachedTake(m: R.TennisBreakMarkRow): boolean {
  if (m.panic_cents == null) return false;
  const need = m.panic_cents - OVR_TAKE_BUFFER; // cents above floor to reach pre − buffer
  return (m.recovery_1 != null && m.recovery_1 >= need) || (m.recovery_2 != null && m.recovery_2 >= need);
}
export interface OvrCohortStats {
  label: string; n: number; recoveryShare: number;
  floorP60: number | null; preMedian: number | null; slideP90: number | null;
  takeLevel: number | null; stopLevel: number | null; breakevenPct: number | null; goThreshold: number | null;
  verdict: "go" | "no_go" | "insufficient" | "degenerate" | "sensitivity";
}
export interface OvrCohortReport {
  primary: OvrCohortStats; byTour: OvrCohortStats[]; sensitivity: OvrCohortStats;
  recoveryDef: string; orientation: string; note: string;
}
function ovrCohortStats(marks: R.TennisBreakMarkRow[], label: string, kind: "primary" | "tour" | "sensitivity"): OvrCohortStats {
  const meas = marks.filter((m) => m.pre_cents != null && m.floor_cents != null && m.panic_cents != null);
  const n = meas.length;
  const recoveryShare = n ? Math.round(meas.filter(ovrReachedTake).length / n * 1000) / 1000 : 0;
  const floorP60 = pctl(meas.map((m) => m.floor_cents as number), 60);
  const preMedian = pctl(meas.map((m) => m.pre_cents as number), 50);
  const slideP90 = pctl(meas.map((m) => m.panic_cents as number), 90);
  const takeLevel = preMedian != null ? Math.round((preMedian - OVR_TAKE_BUFFER) * 10) / 10 : null;
  const stopLevel = preMedian != null && slideP90 != null ? Math.round((preMedian - slideP90) * 10) / 10 : null;
  const E = floorP60, T = takeLevel, S = stopLevel;
  const degenerate = E == null || T == null || S == null || !(T > E && E > S);
  const breakevenPct = degenerate ? null : Math.round((E! - S!) / (T! - S!) * 1000) / 1000;
  const goThreshold = breakevenPct == null ? null : Math.round(Math.max(OVR_FLOOR_HARD, breakevenPct + OVR_MARGIN_PP) * 1000) / 1000;
  const minN = kind === "tour" ? OVR_MIN_N_TOUR : OVR_MIN_N_PRIMARY;
  let verdict: OvrCohortStats["verdict"];
  if (kind === "sensitivity") verdict = "sensitivity";
  else if (n < minN) verdict = "insufficient";        // #4: too few marks → don't decide (before any level check)
  else if (degenerate) verdict = "degenerate";
  else verdict = recoveryShare >= (goThreshold as number) ? "go" : "no_go";
  return { label, n, recoveryShare, floorP60, preMedian, slideP90, takeLevel, stopLevel, breakevenPct, goThreshold, verdict };
}
/** Step-1 cohort diagnostic: is the FAVOURITE-broken-EARLY cohort tradeable (per Petro's formula)? */
export function buildTennisOverreactionCohort(db: Database): OvrCohortReport {
  const all = R.listTennisBreakMarks(db).filter((m) => m.broke_early === 1 && ovrTour(m.event_type) != null);
  const primaryMarks = all.filter((m) => (m.pre_cents ?? 0) >= OVR_FAV_MIN_PRIMARY);
  const bandMarks = all.filter((m) => (m.pre_cents ?? 0) >= OVR_FAV_MIN_SENSITIVITY && (m.pre_cents ?? 0) < OVR_FAV_MIN_PRIMARY);
  const primary = ovrCohortStats(primaryMarks, `ATP+WTA, ранний брейк фаворита ≥${OVR_FAV_MIN_PRIMARY}¢`, "primary");
  const byTour = (["ATP", "WTA"] as const).map((tour) => ovrCohortStats(primaryMarks.filter((m) => ovrTour(m.event_type) === tour), `${tour} ≥${OVR_FAV_MIN_PRIMARY}¢`, "tour"));
  const sensitivity = ovrCohortStats(bandMarks, `полоса ${OVR_FAV_MIN_SENSITIVITY}–${OVR_FAV_MIN_PRIMARY}¢ (sensitivity, не мержим)`, "sensitivity");
  const verdictNote = primary.verdict === "insufficient" ? `когорта n=${primary.n} < ${OVR_MIN_N_PRIMARY} — вердикт INSUFFICIENT, копим, не решаем`
    : primary.verdict === "degenerate" ? "уровни вырождены (T≤E или E≤S) — проверить данные, не калибровать"
      : primary.verdict === "go" ? `recovery ${(primary.recoveryShare * 100).toFixed(1)}% ≥ порога ${((primary.goThreshold ?? 0) * 100).toFixed(1)}% (breakeven ${((primary.breakevenPct ?? 0) * 100).toFixed(1)}% + маржа) → у когорты ЕСТЬ торгуемый edge, можно на Шаг 2 (калибровка)`
        : `recovery ${(primary.recoveryShare * 100).toFixed(1)}% < порога ${((primary.goThreshold ?? 0) * 100).toFixed(1)}% → edge НЕ покрывает безубыток+маржу, Overreaction парковать как PMV`;
  return {
    primary, byTour, sensitivity,
    recoveryDef: "recovery = цена вернулась к тейк-уровню (pre−3¢) в пределах ≤2 мин ОТ ДНА (recovery_N меряется от floor: floorTime+N·60s), т.е. max(recovery_1,recovery_2) ≥ panic−3. Марки — mid без спреда/филла → верхняя граница торгуемости, отсюда обязательная маржа +5пп.",
    orientation: "цена — winner-манилайн СЛОМАННОЙ стороны (broken_side из детектора брейков по дельте геймов, не токен/first-named); фильтр pre≥60¢ сам отсекает перевёрнутые марки (у андердога winner-цена <40¢). Пятый ориентационный баг здесь не воспроизводится.",
    note: verdictNote,
  };
}

// ── П3 (batch-3): "take 50% + hold runner to settle" backtest on the ALREADY-accumulated cohort ──
// The runner is NOT a tweak to a live strategy — Overreaction is PARKED (no_go). It is a NEW payout
// structure, so the ONLY legitimate path is to measure it on marks we already have (zero money) and
// gate it on a criterion fixed BEFORE the data: runner-EV > 0 with ≥3pp margin after commission on
// n≥80. Pass → carry to ratification as a NEW-epoch re-enable; fail → it stays parked, buried as cleanly
// as the first version. Per mark we compare the current TAKE-ONLY structure (sell 100% at the buyback)
// against the RUNNER (sell 50% at the buyback, hold 50% to the match settlement). The delta is non-zero
// only on marks whose take was reached — i.e. exactly where the current strategy leaves the settlement
// upside on the table (the Napolitano ≈$68 case). Marks are MID (no spread/fill) → an UPPER bound, hence
// the mandatory margin. Read-only.
const OVR_RUNNER_FEE = (() => { const n = Number(process.env.TENNIS_RUNNER_FEE_RATE); return Number.isFinite(n) && n >= 0 ? n : 0.02; })();
const OVR_RUNNER_MARGIN = 0.03; // criterion: EV must clear 0 by ≥3pp after commission (fixed before data)
export interface OvrRunnerBacktest {
  n: number; nTakeReached: number; nSettleWin: number;
  runnerEvPct: number | null; takeOnlyEvPct: number | null; deltaPct: number | null;
  verdict: "go" | "no_go" | "insufficient"; criterion: string; note: string;
}
export async function buildOvrRunnerBacktest(db: Database): Promise<OvrRunnerBacktest> {
  // Dynamic import breaks the static cycle (tennisTrading already imports this module); the settlement
  // resolver is the SINGLE source, never re-implemented here (no drift with the live settle path).
  const { tennisFinalResult } = await import("./tennisTrading.js");
  const cohort = R.listTennisBreakMarks(db).filter((m) =>
    m.broke_early === 1 && ovrTour(m.event_type) != null && (m.pre_cents ?? 0) >= OVR_FAV_MIN_PRIMARY &&
    m.panic_cents != null && m.pre_cents != null && m.broken_side != null && m.match_id != null);
  const runnerNets: number[] = [], takeOnlyNets: number[] = [];
  let nTakeReached = 0, nSettleWin = 0;
  for (const m of cohort) {
    const fin = tennisFinalResult(db, m.match_id!);
    if (!fin || !fin.finished || fin.canceled || fin.manual || fin.advancing == null) continue; // need a clean win/loss
    const entry = m.panic_cents as number; if (!(entry > 0)) continue;
    const shares = 100 / entry; // binary pays 100¢ per share on a win
    const won = fin.advancing === m.broken_side; // the broken favourite went on to win the match
    if (won) nSettleWin++;
    const takeTarget = (m.pre_cents as number) - OVR_TAKE_BUFFER;
    const reached = [m.recovery_1, m.recovery_2, m.recovery_3, m.recovery_5].some((v) => v != null && (v as number) >= takeTarget);
    if (reached) nTakeReached++;
    const settleProceeds = shares * (won ? 1 : 0);                 // hold to settle → 100¢ or 0
    const takeProceeds = shares * (takeTarget / 100) * (1 - OVR_RUNNER_FEE); // sell at the buyback (a trade → fee)
    const takeOnly = reached ? takeProceeds : settleProceeds;      // current parked structure
    const runner = reached ? 0.5 * takeProceeds + 0.5 * settleProceeds : settleProceeds;
    runnerNets.push(runner - 1); // staked $1
    takeOnlyNets.push(takeOnly - 1);
  }
  const n = runnerNets.length;
  const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  const runnerEv = mean(runnerNets), takeOnlyEv = mean(takeOnlyNets);
  const runnerEvPct = runnerEv == null ? null : Math.round(runnerEv * 1000) / 10;
  const takeOnlyEvPct = takeOnlyEv == null ? null : Math.round(takeOnlyEv * 1000) / 10;
  const deltaPct = runnerEv == null || takeOnlyEv == null ? null : Math.round((runnerEv - takeOnlyEv) * 1000) / 10;
  const criterion = `раннер-EV > 0 с маржой ≥${OVR_RUNNER_MARGIN * 100}пп после комиссии (${OVR_RUNNER_FEE * 100}%) на n≥${OVR_MIN_N_PRIMARY}; марки — MID (без спреда/филла) → верхняя граница`;
  const verdict: OvrRunnerBacktest["verdict"] =
    n < OVR_MIN_N_PRIMARY ? "insufficient"
      : (runnerEv != null && runnerEv >= OVR_RUNNER_MARGIN) ? "go" : "no_go";
  const note = verdict === "insufficient"
    ? `n=${n} < ${OVR_MIN_N_PRIMARY} — данных мало, НЕ решаем (Overreaction остаётся парковаться); копим марки`
    : verdict === "go"
      ? `раннер-EV ${runnerEvPct}% ≥ ${OVR_RUNNER_MARGIN * 100}пп (vs take-only ${takeOnlyEvPct}%, Δ${deltaPct}пп) — структура проходит критерий, выносить на ратификацию как НОВУЮ эпоху re-enable (не включать руками)`
      : `раннер-EV ${runnerEvPct}% < ${OVR_RUNNER_MARGIN * 100}пп (vs take-only ${takeOnlyEvPct}%, Δ${deltaPct}пп) — не проходит, раннер хоронится так же чисто, как take-only`;
  return { n, nTakeReached, nSettleWin, runnerEvPct, takeOnlyEvPct, deltaPct, verdict, criterion, note };
}

/** Per-break-mark CSV — inspect the actual pre/floor/panic per break (is the panic real?). */
export function tennisBreakMarksCsv(db: Database): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["t_event", "players", "tournament", "event_type", "set_num", "broken_side", "broke_early", "match_id", "pre_cents", "floor_cents", "panic_cents", "t_floor_sec", "recovery_1", "recovery_2", "recovery_5", "post_entry_min_cents", "post_entry_min_sec", "window_quotes", "flags"];
  const rows = R.listTennisBreakMarks(db).map((m) => [m.t_event, m.players, m.tournament, m.event_type, m.set_num, m.broken_side, m.broke_early, m.match_id, m.pre_cents, m.floor_cents, m.panic_cents, m.t_floor_sec, m.recovery_1, m.recovery_2, m.recovery_5, m.post_entry_min_cents, m.post_entry_min_sec, m.window_quotes, m.confidence_flags].map(esc).join(","));
  return [head.join(","), ...rows].join("\n");
}

export function tennisScoutCsv(rep: TennisScoutReport): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["event_key", "players", "tournament", "type", "snapshots", "median_cadence_sec", "breaks", "linked_polymarket", "gaps"];
  const rows = rep.perEvent.map((e) => [e.eventKey, e.players, e.tournament, e.type, e.snapshots, e.medianCadenceSec, e.breaks, e.linkedToPolymarket ? "yes" : "no", e.gaps].map(esc).join(","));
  return [head.join(","), ...rows].join("\n");
}
export function tennisScoutMarkdown(rep: TennisScoutReport): string {
  const L: string[] = [];
  L.push("# Теннис — разведка провайдера (API-Tennis), Stage 0");
  L.push(`\nПровайдер: **${rep.provider}** · событий наблюдалось: **${rep.events}** · снапшотов: **${rep.totalSnapshots}** · брейков детектировано: **${rep.breaks.length}**`);
  L.push("\n## Покрытие по типу события");
  L.push("тип | событий"); L.push("---|---:");
  for (const c of rep.coverageByType) L.push(`${c.type} | ${c.events}`);
  L.push("\n## Лаг детекции брейка (vs Polymarket)");
  L.push(`- измерений: **${rep.lag.measured}** · медианный лаг: **${rep.lag.medianLagSec == null ? "—" : rep.lag.medianLagSec + " сек"}**`);
  L.push(`- ${rep.lag.note}`);
  L.push("\n## По событиям");
  L.push("игроки | турнир | тип | снапшотов | каденция | брейков | PM-линк | пропуски");
  L.push("---|---|---|---:|---:|---:|:-:|---:");
  for (const e of rep.perEvent) L.push(`${e.players} | ${e.tournament ?? "—"} | ${e.type ?? "—"} | ${e.snapshots} | ${e.medianCadenceSec == null ? "—" : e.medianCadenceSec + "с"} | ${e.breaks} | ${e.linkedToPolymarket ? "✓" : "—"} | ${e.gaps}`);
  L.push("\n## Ограничения");
  for (const l of rep.limitations) L.push(`- ${l}`);
  return L.join("\n");
}
