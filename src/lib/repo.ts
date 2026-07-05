// ============================================================
// EDGE LAB — repository (domain queries over the DB)  [SERVER-ONLY]
// Boolean <-> INTEGER(0/1) and JSON <-> TEXT are handled here so callers
// work with the clean domain types from types.ts.
// ============================================================

import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type {
  AnalysisJob,
  Assessment,
  Bet,
  Competition,
  Market,
  Match,
  QualityMetrics,
  Reassessment,
  Strategy,
  StrategyParams,
  StrategyShare,
  TradeLogEntry,
  Treasury,
} from "./types.js";

export const uid = () => randomUUID();
export const nowIso = () => new Date().toISOString();

// ---------- treasury ----------
export function setTreasury(db: Database, total: number): void {
  db.prepare(
    `INSERT INTO treasury(id,total_balance) VALUES(1,?)
     ON CONFLICT(id) DO UPDATE SET total_balance=excluded.total_balance`,
  ).run(total);
}
export function getTreasury(db: Database): Treasury {
  const row = db.prepare(`SELECT * FROM treasury WHERE id=1`).get();
  return row ?? { id: 1, total_balance: 0 };
}

// ---------- sports / competitions ----------
export function upsertSport(db: Database, id: string, label: string): void {
  db.prepare(
    `INSERT INTO sports(id,label) VALUES(?,?)
     ON CONFLICT(id) DO UPDATE SET label=excluded.label`,
  ).run(id, label);
}
export function upsertCompetition(db: Database, c: Competition): void {
  db.prepare(
    `INSERT INTO competitions(id,sport_id,name,budget,external_league,created_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       sport_id=excluded.sport_id, name=excluded.name, budget=excluded.budget,
       external_league=excluded.external_league`,
  ).run(c.id, c.sport_id, c.name, c.budget, c.external_league, c.created_at);
}
/** Competitions linked to an external league (for auto-import/sync). */
export function linkedCompetitions(db: Database): Competition[] {
  return db.prepare(`SELECT * FROM competitions WHERE external_league IS NOT NULL AND external_league != ''`).all() as Competition[];
}
export function listCompetitions(db: Database, sportId?: string): Competition[] {
  const rows = sportId
    ? db.prepare(`SELECT * FROM competitions WHERE sport_id=? ORDER BY name`).all(sportId)
    : db.prepare(`SELECT * FROM competitions ORDER BY name`).all();
  return rows as Competition[];
}
export function setCompetitionBudget(db: Database, id: string, budget: number): void {
  db.prepare(`UPDATE competitions SET budget=? WHERE id=?`).run(budget, id);
}
/** Backfill an ESPN league on a category comp (for lineup/event enrichment) without touching its budget. */
export function setCompetitionLeague(db: Database, id: string, league: string): void {
  db.prepare(`UPDATE competitions SET external_league=? WHERE id=?`).run(league, id);
}

// ---------- analytics prompts (§2.4) ----------
export function upsertAnalyticsPrompt(
  db: Database,
  scope: "sport" | "competition",
  scopeId: string,
  body: string,
  model: string | null,
): void {
  db.prepare(
    `INSERT INTO analytics_prompts(id,scope,scope_id,body,model,updated_at)
     VALUES(?,?,?,?,?,?)`,
  ).run(uid(), scope, scopeId, body, model, nowIso());
}
/** Analytics prompt for a match: base (sport) + optional competition override (§2.4). */
export function analyticsPromptFor(
  db: Database,
  sportId: string,
  competitionId: string,
): { body: string; model: string | null } {
  const base = db
    .prepare(`SELECT * FROM analytics_prompts WHERE scope='sport' AND scope_id=? ORDER BY updated_at DESC LIMIT 1`)
    .get(sportId);
  const override = db
    .prepare(`SELECT * FROM analytics_prompts WHERE scope='competition' AND scope_id=? ORDER BY updated_at DESC LIMIT 1`)
    .get(competitionId);
  const parts = [base?.body, override?.body].filter(Boolean);
  return { body: parts.join("\n\n"), model: base?.model ?? null };
}

// ---------- strategies ----------
export function insertStrategy(db: Database, s: Strategy): void {
  db.prepare(
    `INSERT INTO strategies(id,sport_id,name,tag,color,version,prompt,params,model,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.id, s.sport_id, s.name, s.tag, s.color, s.version, s.prompt,
    JSON.stringify(s.params), s.model, s.created_at,
  );
}
export function listStrategies(db: Database, sportId?: string): Strategy[] {
  const rows = sportId
    ? db.prepare(`SELECT * FROM strategies WHERE sport_id=? ORDER BY created_at`).all(sportId)
    : db.prepare(`SELECT * FROM strategies ORDER BY created_at`).all();
  return (rows as any[]).map(mapStrategy);
}
export function getStrategy(db: Database, id: string): Strategy | null {
  const row = db.prepare(`SELECT * FROM strategies WHERE id=?`).get(id);
  return row ? mapStrategy(row) : null;
}
/** Bump a strategy to a new version, archiving the previous one (§2.6, §3.5). */
export function saveStrategyVersion(
  db: Database, strategyId: string, prompt: string, params: StrategyParams, reason: string,
): number {
  const cur = getStrategy(db, strategyId);
  if (!cur) throw new Error(`strategy ${strategyId} not found`);
  db.prepare(
    `INSERT INTO strategy_versions(id,strategy_id,version,prompt,params,reason,created_at)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(uid(), strategyId, cur.version, cur.prompt, JSON.stringify(cur.params), reason, nowIso());
  const next = cur.version + 1;
  db.prepare(`UPDATE strategies SET prompt=?,params=?,version=? WHERE id=?`)
    .run(prompt, JSON.stringify(params), next, strategyId);
  return next;
}
export function updateStrategy(
  db: Database, id: string,
  patch: Partial<Pick<Strategy, "name" | "prompt" | "model" | "tag">> & { params?: StrategyParams },
): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["name", "prompt", "model", "tag"] as const)
    if (patch[k] !== undefined) { cols.push(`${k}=?`); vals.push(patch[k]); }
  if (patch.params !== undefined) { cols.push(`params=?`); vals.push(JSON.stringify(patch.params)); }
  if (!cols.length) return;
  db.prepare(`UPDATE strategies SET ${cols.join(", ")} WHERE id=?`).run(...vals, id);
}
/** Remove a strategy and all of its dependent rows (paper data — no FK cascade
 * in the schema, so we delete children first, in FK-safe order). */
export function deleteStrategy(db: Database, id: string): void {
  for (const sql of [
    `DELETE FROM trade_log WHERE strategy_id=?`,
    `DELETE FROM reassessments WHERE strategy_id=?`,
    `DELETE FROM bets WHERE strategy_id=?`,
    `DELETE FROM strategy_shares WHERE strategy_id=?`,
    `DELETE FROM strategy_versions WHERE strategy_id=?`,
    `DELETE FROM quality_metrics WHERE strategy_id=?`,
    `DELETE FROM strategies WHERE id=?`,
  ]) db.prepare(sql).run(id);
}
function mapStrategy(r: any): Strategy {
  return { ...r, params: safeJson<StrategyParams>(r.params, {}) };
}

// ---------- match live (ESPN link + lineups) & events ----------
export interface MatchLive { match_id: string; espn_event_id: string | null; league: string | null; home_lineup: string | null; away_lineup: string | null; stats: string | null; updated_at: string }
export function getMatchLive(db: Database, matchId: string): MatchLive | undefined {
  return db.prepare(`SELECT * FROM match_live WHERE match_id=?`).get(matchId) as MatchLive | undefined;
}
export function upsertMatchLive(db: Database, m: MatchLive): void {
  db.prepare(
    `INSERT INTO match_live(match_id,espn_event_id,league,home_lineup,away_lineup,stats,updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(match_id) DO UPDATE SET espn_event_id=excluded.espn_event_id, league=excluded.league,
       home_lineup=excluded.home_lineup, away_lineup=excluded.away_lineup, stats=excluded.stats, updated_at=excluded.updated_at`,
  ).run(m.match_id, m.espn_event_id, m.league, m.home_lineup, m.away_lineup, m.stats ?? null, m.updated_at);
}
export interface MatchEventRow { id: string; match_id: string; event_key: string; minute: number | null; type: string; team: string | null; text: string; created_at: string }
/** Insert a match event; returns true if it was new (deduped by match+key). */
export function insertMatchEvent(db: Database, e: MatchEventRow): boolean {
  const r = db.prepare(
    `INSERT OR IGNORE INTO match_events(id,match_id,event_key,minute,type,team,text,created_at) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(e.id, e.match_id, e.event_key, e.minute, e.type, e.team, e.text, e.created_at);
  return r.changes > 0;
}
export function eventsForMatch(db: Database, matchId: string): MatchEventRow[] {
  return db.prepare(`SELECT * FROM match_events WHERE match_id=? ORDER BY created_at`).all(matchId) as MatchEventRow[];
}

// ---------- cron log (scheduler audit trail) ----------
export interface CronLogRow { id: string; at: string; kind: string; ok: number; summary: string; created_at: string }
export function insertCronLog(db: Database, e: CronLogRow): void {
  db.prepare(`INSERT INTO cron_log(id,at,kind,ok,summary,created_at) VALUES(?,?,?,?,?,?)`)
    .run(e.id, e.at, e.kind, e.ok, e.summary, e.created_at);
  // keep the table small — retain the most recent 100 runs
  db.exec(`DELETE FROM cron_log WHERE id NOT IN (SELECT id FROM cron_log ORDER BY created_at DESC LIMIT 100)`);
}
export function recentCronLog(db: Database, limit = 20): CronLogRow[] {
  return db.prepare(`SELECT * FROM cron_log ORDER BY created_at DESC LIMIT ?`).all(limit) as CronLogRow[];
}

// ---------- provider keys (optional, entered via UI; server-side only) ----------
export function getProviderKeys(db: Database): Partial<Record<string, string>> {
  const rows = db.prepare(`SELECT provider, api_key FROM provider_keys`).all() as { provider: string; api_key: string }[];
  const out: Partial<Record<string, string>> = {};
  for (const r of rows) if (r.api_key && r.api_key.trim()) out[r.provider] = r.api_key.trim();
  return out;
}
export function setProviderKey(db: Database, provider: string, key: string, at: string): void {
  db.prepare(
    `INSERT INTO provider_keys(provider,api_key,updated_at) VALUES(?,?,?)
     ON CONFLICT(provider) DO UPDATE SET api_key=excluded.api_key, updated_at=excluded.updated_at`,
  ).run(provider, key.trim(), at);
}
export function deleteProviderKey(db: Database, provider: string): void {
  db.prepare(`DELETE FROM provider_keys WHERE provider=?`).run(provider);
}

// ---------- shares ----------
export function setShare(db: Database, s: StrategyShare): void {
  db.prepare(
    `INSERT INTO strategy_shares(competition_id,strategy_id,pct) VALUES(?,?,?)
     ON CONFLICT(competition_id,strategy_id) DO UPDATE SET pct=excluded.pct`,
  ).run(s.competition_id, s.strategy_id, s.pct);
}
export function sharesForComp(db: Database, competitionId: string): StrategyShare[] {
  return db.prepare(`SELECT * FROM strategy_shares WHERE competition_id=?`)
    .all(competitionId) as StrategyShare[];
}
export function clearShares(db: Database, competitionId: string): void {
  db.prepare(`DELETE FROM strategy_shares WHERE competition_id=?`).run(competitionId);
}

// ---------- matches ----------
export function insertMatch(db: Database, m: Match): void {
  db.prepare(
    `INSERT INTO matches(id,competition_id,home,away,state,lineup_out,kickoff_at,minute,
       score_home,score_away,final_score,kickoff_time,end_time,duration,end_note,external_ref,clock)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    m.id, m.competition_id, m.home, m.away, m.state, m.lineup_out ? 1 : 0,
    m.kickoff_at, m.minute, m.score_home, m.score_away, m.final_score,
    m.kickoff_time, m.end_time, m.duration, m.end_note, m.external_ref, m.clock ?? null,
  );
}
export function getMatch(db: Database, id: string): Match | null {
  const r = db.prepare(`SELECT * FROM matches WHERE id=?`).get(id);
  return r ? mapMatch(r) : null;
}
export function listMatches(db: Database, competitionId: string): Match[] {
  return (db.prepare(`SELECT * FROM matches WHERE competition_id=?`).all(competitionId) as any[])
    .map(mapMatch);
}
export function updateMatch(db: Database, id: string, patch: Partial<Match>): void {
  const map: Record<string, unknown> = { ...patch };
  if ("lineup_out" in map) map.lineup_out = patch.lineup_out ? 1 : 0;
  const keys = Object.keys(map);
  if (!keys.length) return;
  db.prepare(`UPDATE matches SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`)
    .run(...keys.map((k) => map[k]), id);
}
export function allMatches(db: Database): Match[] {
  return (db.prepare(`SELECT * FROM matches`).all() as any[]).map(mapMatch);
}
export function matchByExternalRef(db: Database, ref: string): Match | null {
  const r = db.prepare(`SELECT * FROM matches WHERE external_ref=?`).get(ref);
  return r ? mapMatch(r) : null;
}
function mapMatch(r: any): Match {
  return { ...r, lineup_out: !!r.lineup_out };
}

// ---------- assessments ----------
export function upsertAssessment(db: Database, a: Assessment): void {
  db.prepare(
    `INSERT INTO assessments(id,match_id,stage,confidence,short,body,verdict,model,status,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(match_id,stage) DO UPDATE SET
       confidence=excluded.confidence, short=excluded.short, body=excluded.body,
       verdict=excluded.verdict, model=excluded.model, status=excluded.status`,
  ).run(a.id, a.match_id, a.stage, a.confidence, a.short, a.body, a.verdict, a.model, a.status, a.created_at);
}
export function assessmentsForMatch(db: Database, matchId: string): Assessment[] {
  return db.prepare(`SELECT * FROM assessments WHERE match_id=?`).all(matchId) as Assessment[];
}

/** Append a successful assessment to the append-only history archive (kept
 *  separate from `assessments`, which only holds the latest per stage). */
export function appendAssessmentHistory(
  db: Database,
  a: { id: string; match_id: string; stage: string; confidence: string | null; short: string | null; body: string | null; verdict: string | null; model: string | null; created_at: string },
): void {
  db.prepare(
    `INSERT INTO assessment_history(id,match_id,stage,confidence,short,body,verdict,model,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(a.id, a.match_id, a.stage, a.confidence, a.short, a.body, a.verdict, a.model, a.created_at);
  // Cap per-match history so a long tournament (many re-analyses) can't grow the
  // table without bound; reads only ever show the last couple dozen anyway.
  db.prepare(
    `DELETE FROM assessment_history WHERE match_id=? AND id NOT IN (
       SELECT id FROM assessment_history WHERE match_id=? ORDER BY created_at DESC LIMIT 40)`,
  ).run(a.match_id, a.match_id);
}
export interface AssessmentHistoryRow {
  id: string; match_id: string; stage: string; confidence: string | null;
  short: string | null; body: string | null; verdict: string | null; model: string | null; created_at: string;
}
/** Past assessments for a match, newest first (capped). */
export function assessmentHistoryForMatch(db: Database, matchId: string, limit = 24): AssessmentHistoryRow[] {
  return db.prepare(
    `SELECT * FROM assessment_history WHERE match_id=? ORDER BY created_at DESC LIMIT ?`,
  ).all(matchId, limit) as AssessmentHistoryRow[];
}

// ---------- analysis jobs (durable per-match analyze state) ----------
export function getAnalysisJob(db: Database, matchId: string): AnalysisJob | undefined {
  return db.prepare(`SELECT * FROM analysis_jobs WHERE match_id=?`).get(matchId) as AnalysisJob | undefined;
}
export function startAnalysisJob(db: Database, matchId: string, at: string): void {
  db.prepare(
    `INSERT INTO analysis_jobs(match_id,status,error,started_at,finished_at)
     VALUES(?,'running',NULL,?,NULL)
     ON CONFLICT(match_id) DO UPDATE SET status='running', error=NULL, started_at=excluded.started_at, finished_at=NULL`,
  ).run(matchId, at);
}
export function finishAnalysisJob(db: Database, matchId: string, failed: boolean, error: string | null, at: string): void {
  db.prepare(
    `UPDATE analysis_jobs SET status=?, error=?, finished_at=? WHERE match_id=?`,
  ).run(failed ? "failed" : "done", failed ? error : null, at, matchId);
}
export function runningAnalysisJobs(db: Database): AnalysisJob[] {
  return db.prepare(`SELECT * FROM analysis_jobs WHERE status='running'`).all() as AnalysisJob[];
}
/** Restart reconciliation: a 'running' row with no live process is orphaned. */
export function failStaleAnalysisJobs(db: Database, error: string, at: string): number {
  const r = db.prepare(
    `UPDATE analysis_jobs SET status='failed', error=?, finished_at=? WHERE status='running'`,
  ).run(error, at);
  return r.changes;
}

// ---------- markets ----------
export function insertMarket(db: Database, m: Market): void {
  db.prepare(
    `INSERT INTO markets(id,match_id,label,price,ai_prob,liquidity,external_ref,snapshot_at,is_closing)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(m.id, m.match_id, m.label, m.price, m.ai_prob, m.liquidity, m.external_ref, m.snapshot_at, m.is_closing ? 1 : 0);
}
/** Find the match that already owns a market backed by any of these CLOB token
 *  refs — a spelling-independent way to recognise the same Polymarket fixture
 *  across runs (the tokens are stable even when the title's wording drifts). */
export function matchByMarketTokens(db: Database, tokenRefs: string[]): Match | null {
  const refs = tokenRefs.filter(Boolean);
  if (!refs.length) return null;
  const ph = refs.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT m.* FROM matches m JOIN markets k ON k.match_id = m.id
     WHERE k.external_ref IN (${ph}) LIMIT 1`,
  ).get(...refs) as Match | undefined;
  return row ?? null;
}
/** Cap the market-snapshot history to the latest `keepPerLabel` NON-closing rows
 *  per (match, label); closing snapshots (CLV) are always kept. Only the latest
 *  snapshot per label is ever read, so old ones are dead weight — pruning keeps
 *  the table bounded now that the DB is on a persistent disk. */
export function pruneMarketSnapshots(db: Database, keepPerLabel = 8): number {
  const res = db.prepare(
    `DELETE FROM markets WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY match_id, label ORDER BY snapshot_at DESC, rowid DESC) AS rn
         FROM markets WHERE is_closing = 0
       ) WHERE rn > ?
     )`,
  ).run(keepPerLabel);
  return res.changes;
}

// Child tables that reference matches(id) (no ON DELETE CASCADE — delete explicitly).
const MATCH_CHILD_TABLES = ["assessments", "assessment_history", "markets", "bets", "reassessments", "trade_log", "analysis_jobs", "match_live", "match_events", "market_open"];

/**
 * Prune bloat matches to keep the DB (and every `buildAppData` scan) bounded.
 * ONLY deletes matches that carry NO bets — so no strategy's betting history,
 * settled P&L, or metric samples are ever touched (matches with any bet are
 * always kept). Targets: finished matches nobody bet on, and stale discovered
 * imports (kickoff older than `staleBeforeMs`) that never resolved. This is what
 * bounds the Polymarket catch-all discovery flood (up to ~200 matches/sport/day
 * into unfunded `pm-*` comps). Returns the number of matches removed.
 */
export function pruneStaleMatches(db: Database, opts: { staleBeforeMs?: number } = {}): number {
  const rows = db.prepare(
    `SELECT m.id AS id, m.state AS state, m.kickoff_at AS kickoff_at FROM matches m
       WHERE NOT EXISTS (SELECT 1 FROM bets b WHERE b.match_id = m.id)`,
  ).all() as { id: string; state: string; kickoff_at: string | null }[];
  const doomed: string[] = [];
  for (const r of rows) {
    if (r.state === "finished") { doomed.push(r.id); continue; }
    // Stale import: a real ISO kickoff already well in the past, never resolved.
    if (opts.staleBeforeMs != null && r.kickoff_at && /^\d{4}-\d\d-\d\dT/.test(r.kickoff_at)) {
      const t = Date.parse(r.kickoff_at);
      if (!isNaN(t) && t < opts.staleBeforeMs) doomed.push(r.id);
    }
  }
  return deleteMatches(db, doomed);
}

/**
 * Drop already-imported discovered matches from leagues with NO ESPN live feed —
 * uncovered `pm-*` competitions (external_league IS NULL) — that carry no bets.
 * The discovery filter (espnLeagueForSeries) stops importing these; this clears
 * the ones imported before it. Never touches a match with betting history or a
 * competition that has a real ESPN league. Returns the count removed.
 */
export function pruneUncoveredMatches(db: Database): number {
  const rows = db.prepare(
    `SELECT m.id AS id FROM matches m
       JOIN competitions c ON c.id = m.competition_id
       WHERE c.external_league IS NULL AND c.id LIKE 'pm-%'
         AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.match_id = m.id)`,
  ).all() as { id: string }[];
  return deleteMatches(db, rows.map((r) => r.id));
}

/** Delete matches + all their child rows (no ON DELETE CASCADE), atomically. */
function deleteMatches(db: Database, ids: string[]): number {
  if (!ids.length) return 0;
  const delChild = MATCH_CHILD_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE match_id = ?`));
  const delMatch = db.prepare(`DELETE FROM matches WHERE id = ?`);
  // node:sqlite has no .transaction() helper — wrap in an explicit BEGIN/COMMIT
  // so a mid-prune throw can't leave a match half-deleted (orphaned children).
  db.exec("BEGIN");
  try {
    for (const id of ids) {
      for (const stmt of delChild) stmt.run(id);
      delMatch.run(id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return ids.length;
}
/** Latest snapshot per market label (or only closing prices). */
export function latestMarkets(db: Database, matchId: string, closingOnly = false): Market[] {
  const rows = db.prepare(
    `SELECT * FROM markets WHERE match_id=? ${closingOnly ? "AND is_closing=1" : ""}
     ORDER BY snapshot_at DESC, rowid DESC`,
  ).all(matchId) as any[];
  const seen = new Set<string>();
  const out: Market[] = [];
  for (const r of rows) {
    if (seen.has(r.label)) continue;
    seen.add(r.label);
    out.push({ ...r, is_closing: !!r.is_closing });
  }
  return out;
}

/** Capture the KICKOFF price of each current market (first-write-wins), so the
 *  odds column shows in-match line movement rather than pre-match drift. Called
 *  the first time a match is seen live. Returns how many labels were captured. */
export function captureOpenOdds(db: Database, matchId: string, capturedAt: string): number {
  const stmt = db.prepare(`INSERT OR IGNORE INTO market_open(match_id,label,price,captured_at) VALUES(?,?,?,?)`);
  let n = 0;
  for (const mk of latestMarkets(db, matchId)) n += stmt.run(matchId, mk.label, mk.price, capturedAt).changes;
  return n;
}
/** Kickoff price per market label (empty until the match goes live). */
export function openOddsFor(db: Database, matchId: string): Record<string, number> {
  const rows = db.prepare(`SELECT label, price FROM market_open WHERE match_id=?`).all(matchId) as { label: string; price: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.label] = r.price;
  return out;
}

export function setMarketAiProb(db: Database, marketId: string, prob: number): void {
  // Reject a non-finite / out-of-range probability at the boundary: a NaN slips
  // through every `!= null` filter and every `<`/`<=` sizing gate (NaN compares
  // false), producing a NaN stake. Leave ai_prob null instead so the market is
  // simply skipped downstream.
  if (!Number.isFinite(prob) || prob < 0 || prob > 1) return;
  db.prepare(`UPDATE markets SET ai_prob=? WHERE id=?`).run(prob, marketId);
}

// ---------- bets ----------
export function insertBet(db: Database, b: Bet): void {
  db.prepare(
    `INSERT INTO bets(id,match_id,strategy_id,market_label,status,proposed_price,entry_price,
       current_price,closing_price,ai_prob,stake,rationale,entered_minute,result,payout,settled_by,settled_at,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    b.id, b.match_id, b.strategy_id, b.market_label, b.status, b.proposed_price, b.entry_price,
    b.current_price, b.closing_price, b.ai_prob, b.stake, b.rationale, b.entered_minute,
    b.result, b.payout, b.settled_by ?? null, b.settled_at ?? null, b.created_at,
  );
}
export function updateBet(db: Database, id: string, patch: Partial<Bet>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const set = keys.map((k) => `${k}=?`).join(", ");
  db.prepare(`UPDATE bets SET ${set} WHERE id=?`).run(...keys.map((k) => (patch as any)[k]), id);
}
export function betsForMatch(db: Database, matchId: string, strategyId?: string): Bet[] {
  const rows = strategyId
    ? db.prepare(`SELECT * FROM bets WHERE match_id=? AND strategy_id=?`).all(matchId, strategyId)
    : db.prepare(`SELECT * FROM bets WHERE match_id=?`).all(matchId);
  return rows as Bet[];
}
export function openBets(db: Database): Bet[] {
  return db.prepare(`SELECT * FROM bets WHERE status='open'`).all() as Bet[];
}
export function getBet(db: Database, id: string): Bet | null {
  return (db.prepare(`SELECT * FROM bets WHERE id=?`).get(id) as Bet | undefined) ?? null;
}
/** Remove not-yet-executed proposals (before re-deciding after a fresh assessment). */
export function clearProposedBets(db: Database, matchId: string): void {
  db.prepare(`DELETE FROM bets WHERE match_id=? AND status='proposed'`).run(matchId);
}
export function settledBetsForStrategy(db: Database, strategyId: string): Bet[] {
  return db.prepare(
    `SELECT * FROM bets WHERE strategy_id=? AND status IN ('settled_won','settled_lost')`,
  ).all(strategyId) as Bet[];
}

// ---------- reassessments / trade log ----------
export function insertReassessment(db: Database, r: Reassessment): void {
  db.prepare(
    `INSERT INTO reassessments(id,match_id,strategy_id,minute,body,confidence,trigger,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(r.id, r.match_id, r.strategy_id, r.minute, r.body, r.confidence, r.trigger, r.created_at);
}
export function insertTradeLog(db: Database, e: TradeLogEntry): void {
  db.prepare(
    `INSERT INTO trade_log(id,match_id,strategy_id,minute,type,text,created_at) VALUES(?,?,?,?,?,?,?)`,
  ).run(e.id, e.match_id, e.strategy_id, e.minute, e.type, e.text, e.created_at);
}
export function reassessmentsForMatch(db: Database, matchId: string): Reassessment[] {
  return db.prepare(`SELECT * FROM reassessments WHERE match_id=? ORDER BY created_at`).all(matchId) as Reassessment[];
}
export function tradeLogForMatch(db: Database, matchId: string): TradeLogEntry[] {
  return db.prepare(`SELECT * FROM trade_log WHERE match_id=? ORDER BY created_at`).all(matchId) as TradeLogEntry[];
}
/** All analytics prompts (for building the base/override maps). */
export function allAnalyticsPrompts(db: Database): {
  scope: "sport" | "competition"; scope_id: string; body: string; model: string | null;
}[] {
  return db.prepare(`SELECT scope,scope_id,body,model FROM analytics_prompts ORDER BY updated_at`).all() as any[];
}
export function updateAnalyticsPrompt(
  db: Database, scope: "sport" | "competition", scopeId: string, body: string,
): void {
  const existing = db.prepare(`SELECT id FROM analytics_prompts WHERE scope=? AND scope_id=? ORDER BY updated_at DESC LIMIT 1`).get(scope, scopeId);
  if (existing) db.prepare(`UPDATE analytics_prompts SET body=?, updated_at=? WHERE id=?`).run(body, nowIso(), existing.id);
  else upsertAnalyticsPrompt(db, scope, scopeId, body, null);
}
export function setAnalyticsModel(db: Database, sportId: string, model: string): void {
  db.prepare(`UPDATE analytics_prompts SET model=?, updated_at=? WHERE scope='sport' AND scope_id=?`).run(model, nowIso(), sportId);
}

// ---------- quality metrics ----------
export function upsertQuality(db: Database, q: QualityMetrics): void {
  db.prepare(
    `INSERT INTO quality_metrics(strategy_id,samples,brier,clv,calibration,updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(strategy_id) DO UPDATE SET
       samples=excluded.samples, brier=excluded.brier, clv=excluded.clv,
       calibration=excluded.calibration, updated_at=excluded.updated_at`,
  ).run(q.strategy_id, q.samples, q.brier, q.clv, JSON.stringify(q.calibration), q.updated_at);
}
export function getQuality(db: Database, strategyId: string): QualityMetrics | null {
  const r = db.prepare(`SELECT * FROM quality_metrics WHERE strategy_id=?`).get(strategyId);
  return r ? { ...r, calibration: safeJson(r.calibration, []) } : null;
}

function safeJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return (s as T) ?? fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
