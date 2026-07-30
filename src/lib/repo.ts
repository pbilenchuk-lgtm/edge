// ============================================================
// EDGE LAB — repository (domain queries over the DB)  [SERVER-ONLY]
// Boolean <-> INTEGER(0/1) and JSON <-> TEXT are handled here so callers
// work with the clean domain types from types.ts.
// ============================================================

import { randomUUID } from "node:crypto";
import { resolveBetOrigin, CODE_VERSION } from "./betMeta.js";
import { warsawLabel } from "./time.js";
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
// P0.5 football epoch — the clean era after the P0.1-P0.3 fixes (fixture date gate, prematch_value
// defend-only, depth/stale guards). New football bets carry it; pre-fix rows are epoch_unknown.
export const FOOTBALL_EPOCH = process.env.FOOTBALL_EPOCH || "f-clean-m1";
const FOOTBALL_STRATS = new Set(["prematch_value", "overreaction", "live_xg"]);
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

// ---------- risk config (Окно 4 — global validated risk constants) ----------
/** Raw stored risk-config JSON string, or null if never saved (→ defaults). */
export function getRiskConfigRaw(db: Database): string | null {
  const row = db.prepare(`SELECT content FROM risk_config WHERE id=1`).get() as { content: string } | undefined;
  return row?.content ?? null;
}
export function setRiskConfigRaw(db: Database, content: string, updatedAt: string): void {
  db.prepare(
    `INSERT INTO risk_config(id,content,updated_at) VALUES(1,?,?)
     ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
  ).run(content, updatedAt);
}

// ---------- risk profiles (named risk presets) ----------
export interface RiskProfileRow { id: string; name: string; content: string; sort: number; created_at: string }
export function listRiskProfiles(db: Database): RiskProfileRow[] {
  return db.prepare(`SELECT * FROM risk_profiles ORDER BY sort, created_at`).all() as RiskProfileRow[];
}
export function getRiskProfileRow(db: Database, id: string): RiskProfileRow | undefined {
  return db.prepare(`SELECT * FROM risk_profiles WHERE id=?`).get(id) as RiskProfileRow | undefined;
}
export function upsertRiskProfile(db: Database, p: { id: string; name: string; content: string; sort?: number; created_at: string }): void {
  db.prepare(
    `INSERT INTO risk_profiles(id,name,content,sort,created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, content=excluded.content, sort=excluded.sort`,
  ).run(p.id, p.name, p.content, p.sort ?? 0, p.created_at);
}
export function deleteRiskProfile(db: Database, id: string): void {
  db.prepare(`DELETE FROM risk_profiles WHERE id=?`).run(id);
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
/** A single analytics prompt row (sport base OR competition modifier), or null.
 *  Used by the two-layer football analysis to keep base and modifier SEPARATE
 *  (the modifier is its own Layer-2 LLM call, not concatenated text). */
export function analyticsPromptRow(
  db: Database, scope: "sport" | "competition", scopeId: string,
): { body: string; model: string | null } | null {
  const r = db.prepare(`SELECT body, model FROM analytics_prompts WHERE scope=? AND scope_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(scope, scopeId) as { body: string; model: string | null } | undefined;
  return r ? { body: r.body, model: r.model ?? null } : null;
}

export function analyticsPromptFor(
  db: Database,
  sportId: string,
  competitionId: string,
): { body: string; model: string | null } {
  const base = db
    .prepare(`SELECT * FROM analytics_prompts WHERE scope='sport' AND scope_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
    .get(sportId);
  const override = db
    .prepare(`SELECT * FROM analytics_prompts WHERE scope='competition' AND scope_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
    .get(competitionId);
  const parts = [base?.body, override?.body].filter(Boolean);
  return { body: parts.join("\n\n"), model: base?.model ?? null };
}

// ---------- strategies ----------
export function insertStrategy(db: Database, s: Strategy): void {
  db.prepare(
    `INSERT INTO strategies(id,sport_id,name,tag,color,version,prompt,prompt_live,params,model,model_live,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.id, s.sport_id, s.name, s.tag, s.color, s.version, s.prompt, s.prompt_live ?? null,
    JSON.stringify(s.params), s.model, s.model_live ?? null, s.created_at,
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
    `INSERT INTO strategy_versions(id,strategy_id,version,prompt,prompt_live,params,reason,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(uid(), strategyId, cur.version, cur.prompt, cur.prompt_live ?? null, JSON.stringify(cur.params), reason, nowIso());
  const next = cur.version + 1;
  db.prepare(`UPDATE strategies SET prompt=?,params=?,version=? WHERE id=?`)
    .run(prompt, JSON.stringify(params), next, strategyId);
  return next;
}
export function updateStrategy(
  db: Database, id: string,
  patch: Partial<Pick<Strategy, "name" | "prompt" | "prompt_live" | "model" | "model_live" | "tag">> & { params?: StrategyParams },
): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["name", "prompt", "prompt_live", "model", "model_live", "tag"] as const)
    if (patch[k] !== undefined) { cols.push(`${k}=?`); vals.push(patch[k]); }
  if (patch.params !== undefined) { cols.push(`params=?`); vals.push(JSON.stringify(patch.params)); }
  if (!cols.length) return;
  db.prepare(`UPDATE strategies SET ${cols.join(", ")} WHERE id=?`).run(...vals, id);
}
/** Remove a strategy and all of its dependent rows (paper data — no FK cascade
 * in the schema, so we delete children first, in FK-safe order). */
export function deleteStrategy(db: Database, id: string): void {
  // analysis_artifacts (strategist / battle_sheet) are keyed by label = strategy
  // NAME (± " · profile"), not strategy_id — clean them by name so a deleted
  // strategy's artifacts don't linger in the «Анализ» tab.
  const name = (db.prepare(`SELECT name FROM strategies WHERE id=?`).get(id) as { name?: string } | undefined)?.name;
  if (name) db.prepare(`DELETE FROM analysis_artifacts WHERE kind IN ('strategist','battle_sheet') AND (label=? OR label LIKE ?)`).run(name, `${name} · %`);
  for (const sql of [
    `DELETE FROM trade_log WHERE strategy_id=?`,
    `DELETE FROM reassessments WHERE strategy_id=?`,
    `DELETE FROM bets WHERE strategy_id=?`,
    // Shadow reserves/ledger are keyed by strategy_id too — drop them or their capital
    // stays "reserved" against a bet row that no longer exists (leaked capital that
    // releaseOrphanReserves can't reclaim, since it keys off the now-absent bet).
    `DELETE FROM shadow_reserves WHERE strategy_id=?`,
    `DELETE FROM shadow_events WHERE strategy_id=?`,
    `DELETE FROM fill_costs WHERE strategy_id=?`,
    `DELETE FROM strategy_shares WHERE strategy_id=?`,
    `DELETE FROM strategy_versions WHERE strategy_id=?`,
    `DELETE FROM quality_metrics WHERE strategy_id=?`,
    `DELETE FROM strategies WHERE id=?`,
  ]) db.prepare(sql).run(id);
}
function mapStrategy(r: any): Strategy {
  return { ...r, prompt_live: r.prompt_live ?? null, model_live: r.model_live ?? null, params: safeJson<StrategyParams>(r.params, {}) };
}

// ---------- match live (ESPN link + lineups) & events ----------
export interface MatchLive { match_id: string; espn_event_id: string | null; league: string | null; espn_event_date?: string | null; home_lineup: string | null; away_lineup: string | null; stats: string | null; updated_at: string }
export function getMatchLive(db: Database, matchId: string): MatchLive | undefined {
  return db.prepare(`SELECT * FROM match_live WHERE match_id=?`).get(matchId) as MatchLive | undefined;
}
/** Sports where a confirmed starting lineup materially changes the read, so we
 *  refuse to ANALYZE (and to fund pre-match capital) until the real roster is
 *  published. Currently football only. */
export const LINEUP_SPORTS = new Set(["football"]);
/** Have REAL starting lineups actually been published for this match? True only
 *  when the provider stored both sides' starters (engine.ts, provider lineupOut =
 *  both teams have starters). This is NOT the `lineup_out` flag — that also flips
 *  on a pure ~1h-before-kickoff timer with no real roster. For sports where the
 *  lineup materially changes the read (football), analysis is gated on THIS. */
export function hasLineups(db: Database, matchId: string): boolean {
  const l = getMatchLive(db, matchId);
  if (!l) return false;
  // A match_live row is ALSO written as a bare coverage marker with EMPTY
  // starters ({team, formation:null, starters:[]}) before the teamsheet lands —
  // a non-null string, so a mere presence check wrongly reads as "состав есть".
  // Require an actually populated starting XI on BOTH sides (mirrors the
  // provider's lineupOut = both teams have starters).
  return lineupHasStarters(l.home_lineup) && lineupHasStarters(l.away_lineup);
}
function lineupHasStarters(raw: string | null): boolean {
  if (!raw) return false;
  try { const s = JSON.parse(raw); return Array.isArray(s?.starters) && s.starters.length > 0; }
  catch { return false; }
}
/** Should we HOLD analysis on this match because the lineup isn't out yet?
 *  True only for a lineup-sport (football) still PRE-kickoff (upcoming/lineup)
 *  whose real starting XI hasn't been published. A live/finished match has its
 *  lineup out by definition — never held — so live trading is unaffected. */
export function awaitingLineup(db: Database, match: { id: string; state: string; competition_id: string }, sport: string): boolean {
  if (!LINEUP_SPORTS.has(sport)) return false;
  if (match.state !== "upcoming" && match.state !== "lineup") return false;
  return !hasLineups(db, match.id);
}
export function upsertMatchLive(db: Database, m: MatchLive): void {
  db.prepare(
    `INSERT INTO match_live(match_id,espn_event_id,league,espn_event_date,home_lineup,away_lineup,stats,updated_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(match_id) DO UPDATE SET espn_event_id=excluded.espn_event_id, league=excluded.league,
       espn_event_date=COALESCE(excluded.espn_event_date, match_live.espn_event_date),
       home_lineup=excluded.home_lineup, away_lineup=excluded.away_lineup, stats=excluded.stats, updated_at=excluded.updated_at`,
  ).run(m.match_id, m.espn_event_id, m.league, m.espn_event_date ?? null, m.home_lineup, m.away_lineup, m.stats ?? null, m.updated_at);
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

// ---------- gap-wake protective-exit watch (P0.6) ----------
export interface GapRepriceRow {
  bet_id: string; match_id: string; strategy_id: string; profile: string | null; gap_sec: number;
  wake_price_cents: number; floor_cents: number; deadline_at: string; ticks: number;
  outcome: string | null; exec_price_cents: number | null; delta_cents: number | null;
  created_at: string; resolved_at: string | null;
}
/** Open a deferral watch for a position (idempotent — first write wins so a re-fire doesn't reset the clock). */
export function openGapReprice(db: Database, r: Omit<GapRepriceRow, "ticks" | "outcome" | "exec_price_cents" | "delta_cents" | "resolved_at">): void {
  db.prepare(
    `INSERT OR IGNORE INTO gap_reprice(bet_id,match_id,strategy_id,profile,gap_sec,wake_price_cents,floor_cents,deadline_at,ticks,outcome,exec_price_cents,delta_cents,created_at,resolved_at)
     VALUES(?,?,?,?,?,?,?,?,0,NULL,NULL,NULL,?,NULL)`,
  ).run(r.bet_id, r.match_id, r.strategy_id, r.profile ?? null, r.gap_sec, r.wake_price_cents, r.floor_cents, r.deadline_at, r.created_at);
}
/** The OPEN (still-watching) deferral for a bet, or null. */
export function getOpenGapReprice(db: Database, betId: string): GapRepriceRow | null {
  return (db.prepare(`SELECT * FROM gap_reprice WHERE bet_id=? AND outcome IS NULL`).get(betId) as GapRepriceRow | undefined) ?? null;
}
/** All open (watching) deferrals — the sweep walks these. */
export function openGapReprices(db: Database): GapRepriceRow[] {
  return db.prepare(`SELECT * FROM gap_reprice WHERE outcome IS NULL`).all() as GapRepriceRow[];
}
export function bumpGapRepriceTick(db: Database, betId: string): number {
  db.prepare(`UPDATE gap_reprice SET ticks=ticks+1 WHERE bet_id=? AND outcome IS NULL`).run(betId);
  const r = db.prepare(`SELECT ticks FROM gap_reprice WHERE bet_id=?`).get(betId) as { ticks: number } | undefined;
  return r?.ticks ?? 0;
}
export function resolveGapReprice(db: Database, betId: string, res: { outcome: "recovered" | "expired"; execCents: number; deltaCents: number; at: string }): void {
  db.prepare(`UPDATE gap_reprice SET outcome=?, exec_price_cents=?, delta_cents=?, resolved_at=? WHERE bet_id=? AND outcome IS NULL`)
    .run(res.outcome, res.execCents, res.deltaCents, res.at, betId);
  // keep the table bounded — retain the most recent 200 resolved rows (+ all open ones).
  db.exec(`DELETE FROM gap_reprice WHERE outcome IS NOT NULL AND bet_id NOT IN (SELECT bet_id FROM gap_reprice WHERE outcome IS NOT NULL ORDER BY resolved_at DESC LIMIT 200)`);
}
/** Resolved deferrals (for the self-measurement verdict in the schedule_gaps report). */
export function gapRepriceMeasurements(db: Database, limit = 200): GapRepriceRow[] {
  return db.prepare(`SELECT * FROM gap_reprice WHERE outcome IS NOT NULL ORDER BY resolved_at DESC LIMIT ?`).all(limit) as GapRepriceRow[];
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
export function setShare(db: Database, s: Omit<StrategyShare, "risk_profile_id"> & { risk_profile_id?: string }): void {
  const profile = s.risk_profile_id ?? "medium";
  db.prepare(
    `INSERT INTO strategy_shares(competition_id,strategy_id,risk_profile_id,pct) VALUES(?,?,?,?)
     ON CONFLICT(competition_id,strategy_id,risk_profile_id) DO UPDATE SET pct=excluded.pct`,
  ).run(s.competition_id, s.strategy_id, profile, s.pct);
}
export function sharesForComp(db: Database, competitionId: string): StrategyShare[] {
  return (db.prepare(`SELECT * FROM strategy_shares WHERE competition_id=?`)
    .all(competitionId) as any[]).map((r) => ({ ...r, risk_profile_id: r.risk_profile_id ?? "medium" }));
}
export function clearShares(db: Database, competitionId: string): void {
  db.prepare(`DELETE FROM strategy_shares WHERE competition_id=?`).run(competitionId);
}

// ---------- app_meta (KV: migration markers etc.) ----------
export function metaGet(db: Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key=?`).get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}
export function metaSet(db: Database, key: string, value: string, now: string): void {
  db.prepare(
    `INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, value, now);
}
export function metaDelete(db: Database, key: string): void {
  db.prepare(`DELETE FROM app_meta WHERE key=?`).run(key);
}
/** All KV rows whose key starts with `prefix` (newest first). Used by diagnostics that
 *  aggregate per-item markers (e.g. the tennis funnel's per-break action markers). */
export function metaByPrefix(db: Database, prefix: string): { key: string; value: string; updated_at: string }[] {
  return db.prepare(`SELECT key,value,updated_at FROM app_meta WHERE key LIKE ? ESCAPE '\\' ORDER BY updated_at DESC`)
    .all(prefix.replace(/[%_\\]/g, (c) => "\\" + c) + "%") as { key: string; value: string; updated_at: string }[];
}

// ---------- shadow allocator (observe-only capital pool) ----------
export interface ShadowReserveRow {
  id: string; bet_id: string; match_id: string; competition_id: string;
  strategy_id: string; profile_id: string; size: number; is_live: number;
  edge: number; state: "reserved" | "settling"; settle_at: string | null; created_at: string;
}
export interface ShadowEventRow {
  id: string; bet_id: string | null; match_id: string; competition_id: string;
  strategy_id: string; profile_id: string; size_requested: number; size_reserved: number;
  verdict: "allowed" | "blocked" | "trimmed"; reason: string | null; is_live: number;
  edge: number; contention: number; free_at: number | null; pool_snapshot: string | null;
  config_snapshot?: string | null; intensity?: number | null; created_at: string;
}
export function insertShadowReserve(db: Database, r: ShadowReserveRow): void {
  db.prepare(`INSERT INTO shadow_reserves(id,bet_id,match_id,competition_id,strategy_id,profile_id,size,is_live,edge,state,settle_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.id, r.bet_id, r.match_id, r.competition_id, r.strategy_id, r.profile_id, r.size, r.is_live, r.edge, r.state, r.settle_at, r.created_at);
}
export function allShadowReserves(db: Database): ShadowReserveRow[] {
  return db.prepare(`SELECT * FROM shadow_reserves`).all() as ShadowReserveRow[];
}
export function shadowReservedForBet(db: Database, betId: string): ShadowReserveRow | null {
  return (db.prepare(`SELECT * FROM shadow_reserves WHERE bet_id=? AND state='reserved' LIMIT 1`).get(betId) as ShadowReserveRow | undefined) ?? null;
}
export function updateShadowReserve(db: Database, id: string, patch: { size?: number; state?: string; settle_at?: string | null }): void {
  const sets: string[] = [], vals: (string | number | null)[] = [];
  if (patch.size != null) { sets.push("size=?"); vals.push(patch.size); }
  if (patch.state != null) { sets.push("state=?"); vals.push(patch.state); }
  if ("settle_at" in patch) { sets.push("settle_at=?"); vals.push(patch.settle_at ?? null); }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE shadow_reserves SET ${sets.join(",")} WHERE id=?`).run(...vals);
}
export function deleteShadowReserve(db: Database, id: string): void {
  db.prepare(`DELETE FROM shadow_reserves WHERE id=?`).run(id);
}
/** Free every 'settling' row whose lag has elapsed (settle_at <= now). Returns freed count. */
export function releaseSettledShadow(db: Database, nowIso: string): number {
  const info = db.prepare(`DELETE FROM shadow_reserves WHERE state='settling' AND settle_at IS NOT NULL AND settle_at <= ?`).run(nowIso);
  return Number(info.changes ?? 0);
}
/** Drop 'reserved' rows whose bet is no longer OPEN (settled / not_filled / gone). Such a
 *  reserve is orphaned capital — it would keep the pool counting a closed position as
 *  invested, understating free and falsely tightening caps. Returns released count. */
export function releaseOrphanReserves(db: Database): number {
  // Only drop a reserve whose bet EXISTS and is in a terminal (non-open) state — a bet
  // that settled without its reserve being released. A reserve whose bet row is absent
  // (isolated shadow simulation, no real bet) is left untouched.
  const info = db.prepare(`DELETE FROM shadow_reserves WHERE state='reserved' AND bet_id IN (SELECT id FROM bets WHERE status <> 'open')`).run();
  return Number(info.changes ?? 0);
}
export function insertShadowEvent(db: Database, e: ShadowEventRow): void {
  db.prepare(`INSERT INTO shadow_events(id,bet_id,match_id,competition_id,strategy_id,profile_id,size_requested,size_reserved,verdict,reason,is_live,edge,contention,free_at,pool_snapshot,config_snapshot,intensity,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.id, e.bet_id, e.match_id, e.competition_id, e.strategy_id, e.profile_id, e.size_requested, e.size_reserved, e.verdict, e.reason, e.is_live, e.edge, e.contention, e.free_at, e.pool_snapshot, e.config_snapshot ?? null, e.intensity ?? null, e.created_at);
}
export function listShadowEvents(db: Database, limit = 200): ShadowEventRow[] {
  return db.prepare(`SELECT * FROM shadow_events ORDER BY created_at DESC LIMIT ?`).all(limit) as ShadowEventRow[];
}
export function allShadowEvents(db: Database): ShadowEventRow[] {
  return db.prepare(`SELECT * FROM shadow_events`).all() as ShadowEventRow[];
}
export function shadowEventsForMatch(db: Database, matchId: string): ShadowEventRow[] {
  return db.prepare(`SELECT * FROM shadow_events WHERE match_id=? ORDER BY created_at ASC`).all(matchId) as ShadowEventRow[];
}
export interface FillCostRow {
  id: string; bet_id: string | null; match_id: string; competition_id: string;
  strategy_id: string; profile_id: string; side: "buy" | "sell";
  shares: number; notional_usd: number; quote_cents: number | null; vwap_cents: number | null;
  fee_cents: number; fee_usd: number; slip_cents: number; slip_usd: number;
  from_book: number; created_at: string;
}
export function insertFillCost(db: Database, f: FillCostRow): void {
  db.prepare(`INSERT INTO fill_costs(id,bet_id,match_id,competition_id,strategy_id,profile_id,side,shares,notional_usd,quote_cents,vwap_cents,fee_cents,fee_usd,slip_cents,slip_usd,from_book,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.id, f.bet_id, f.match_id, f.competition_id, f.strategy_id, f.profile_id, f.side, f.shares, f.notional_usd, f.quote_cents, f.vwap_cents, f.fee_cents, f.fee_usd, f.slip_cents, f.slip_usd, f.from_book, f.created_at);
}
export function allFillCosts(db: Database): FillCostRow[] {
  return db.prepare(`SELECT * FROM fill_costs`).all() as FillCostRow[];
}
export function fillCostsForMatch(db: Database, matchId: string): FillCostRow[] {
  return db.prepare(`SELECT * FROM fill_costs WHERE match_id=? ORDER BY created_at ASC`).all(matchId) as FillCostRow[];
}
export function shadowReservesForMatch(db: Database, matchId: string): ShadowReserveRow[] {
  return db.prepare(`SELECT * FROM shadow_reserves WHERE match_id=? ORDER BY created_at ASC`).all(matchId) as ShadowReserveRow[];
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

// ---------- analysis artifacts (raw JSON of each layer's output) ----------
export interface AnalysisArtifact { id: string; match_id: string; kind: string; label: string; stage: string | null; content: string; model: string | null; created_at: string }
/** Store the CURRENT artifact for (match, kind, label) — a new run replaces the
 *  prior one so the «Анализ» tab shows the latest filled schema, not a pile of
 *  history. `content` is the raw JSON string exactly as produced. */
export function saveArtifact(db: Database, a: { match_id: string; kind: string; label?: string; stage?: string | null; content: string; model?: string | null; created_at: string }): void {
  db.prepare(
    `INSERT INTO analysis_artifacts(id,match_id,kind,label,stage,content,model,created_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(match_id,kind,label) DO UPDATE SET
       stage=excluded.stage, content=excluded.content, model=excluded.model, created_at=excluded.created_at`,
  ).run(uid(), a.match_id, a.kind, a.label ?? "", a.stage ?? null, a.content, a.model ?? null, a.created_at);
}
export function artifactsForMatch(db: Database, matchId: string): AnalysisArtifact[] {
  return db.prepare(`SELECT * FROM analysis_artifacts WHERE match_id=? ORDER BY created_at DESC`).all(matchId) as AnalysisArtifact[];
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
    `INSERT INTO markets(id,match_id,label,price,ai_prob,liquidity,external_ref,token_second,snapshot_at,is_closing,ask_cents,spread_cents)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(m.id, m.match_id, m.label, m.price, m.ai_prob, m.liquidity, m.external_ref, m.token_second ?? null, m.snapshot_at, m.is_closing ? 1 : 0, m.ask_cents ?? null, m.spread_cents ?? null);
}
/** Remove a market entirely (all snapshot rows + its kickoff-open row) from a match
 *  — used to drop a dust/orphan listing the importer no longer wants to surface.
 *  Returns the number of snapshot rows deleted. Never touches bets (a dust market
 *  never carried one). */
export function deleteMarketLabel(db: Database, matchId: string, label: string): number {
  db.prepare(`DELETE FROM market_open WHERE match_id=? AND label=?`).run(matchId, label);
  return db.prepare(`DELETE FROM markets WHERE match_id=? AND label=?`).run(matchId, label).changes as number;
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
// provider_match_map is a disposable id cache → safe to delete with a pruned
// match. provider_snapshots is NOT here on purpose: it's long-retention research
// data, and the prune queries below EXCLUDE any match that has snapshots, so a
// snapshotted match is never deleted (protects the data AND avoids the FK error).
// EVERY table with a FK to matches(id) must be here — a match DELETE fails the FK
// otherwise. analysis_artifacts was missing, which is why pruneMatches / pruneCategories
// / reconcileFootball logged "FOREIGN KEY constraint failed" (an analyzed match couldn't
// be pruned). (shadow_reserves/shadow_events/fill_costs have no FK but are cleaned here too.)
const MATCH_CHILD_TABLES = ["assessments", "assessment_history", "analysis_artifacts", "markets", "bets", "reassessments", "trade_log", "analysis_jobs", "match_live", "match_events", "market_open", "provider_match_map", "provider_snapshots", "shadow_reserves", "shadow_events", "fill_costs"];

/**
 * Prune bloat matches to keep the DB (and every `buildAppData` scan) bounded.
 * ONLY deletes matches that carry NO bets — so no strategy's betting history,
 * settled P&L, or metric samples are ever touched (matches with any bet are
 * always kept). Targets: finished matches nobody bet on, and stale discovered
 * imports (kickoff older than `staleBeforeMs`) that never resolved. This is what
 * bounds the Polymarket catch-all discovery flood (up to ~200 matches/sport/day
 * into unfunded `pm-*` comps). Returns the number of matches removed.
 */
export interface MatchLogRow { id: string; match: string; sport: string; compName: string; finalScore: string | null; endIso: string | null; kickoffAt: string | null; endLabel: string | null; endNote: string | null; broken: boolean; betCount: number; endTimeMalformed: boolean }
/** Lean archive query for the «Логи» page — ONE row per finished match, straight from SQL, NOT the fat
 *  buildAppData payload. This is what decouples the log archive from the per-poll payload: keep finished matches
 *  as long as you like without bloating what the browser downloads each tick. Newest-first; bounded by `limit`. */
export function listMatchLogs(db: Database, limit = 1000): MatchLogRow[] {
  // Out-of-perimeter tennis (ITF / Challenger / WTA-ATP 125 / qualifying / doubles) is NEVER traded, so its logs
  // are noise for review — exclude them from the archive. This mirrors tennisTourOf() (tennisScout.ts, the
  // single source of truth) as a SQL port so the LIMIT counts only KEPT rows; tennisScout can't be imported here
  // (it imports repo → cycle). If tennisTourOf's token list changes, update this WHERE with it.
  const HAY = "lower(c.id || ' ' || c.name || ' ' || COALESCE(c.external_league,''))";
  const rows = db.prepare(
    `SELECT m.id AS id, m.home AS home, m.away AS away, m.final_score AS final_score, m.end_time AS end_time,
            m.kickoff_at AS kickoff_at, m.end_note AS end_note, c.sport_id AS sport, c.name AS comp_name,
            (SELECT COUNT(*) FROM bets b WHERE b.match_id = m.id AND b.status NOT IN ('proposed','not_filled')) AS bet_count
       FROM matches m JOIN competitions c ON c.id = m.competition_id
      WHERE m.state = 'finished'
        AND NOT (c.sport_id = 'tennis' AND (
             instr(${HAY}, 'itf') > 0 OR instr(${HAY}, 'challenger') > 0 OR instr(${HAY}, 'doubles') > 0
          OR instr(${HAY}, 'qualif') > 0 OR instr(${HAY}, '125') > 0))
        -- BROKEN + no-bet = an abandoned / no-feed import (nothing happened, nothing traded) — zero review value,
        -- and with a recent kickoff it sorts to the top and buries the useful logs. Drop it. A BROKEN match WITH
        -- a real bet is kept (a bet on a match that broke IS worth reviewing).
        AND NOT (COALESCE(m.end_note,'') LIKE '⚠ поломан%'
                 AND NOT EXISTS (SELECT 1 FROM bets b3 WHERE b3.match_id = m.id AND b3.status NOT IN ('proposed','not_filled')))
      -- СОРТИРОВКА ПО НОРМАЛИЗОВАННОМУ ВРЕМЕНИ, А НЕ ПО СЫРОЙ СТРОКЕ.
      -- Прод 30.07: архив «Логи» перестал показывать новое. Событий было 49 за день — они просто уехали
      -- на 22-ю позицию и ниже. Наверху намертво сидели 20 строк, у которых end_time записан ГОЛЫМ
      -- ВРЕМЕНЕМ («23:51»), а не ISO. Сортировка тут лексикографическая, и "23:51" > "2026-07-30T…",
      -- потому что на второй позиции '3' > '0'. То есть КАЖДАЯ такая строка вечно выше ЛЮБОЙ даты, и
      -- чем дольше живёт архив, тем толще пробка. Со стороны это неотличимо от «ничего не добавляется».
      -- Чиним сортировку: значение, не похожее на ISO, к сортировке не допускается — падаем на kickoff_at.
      -- Сам дефект записи НЕ маскируем, а помечаем полем endTimeMalformed (иначе починим симптом и
      -- потеряем причину — ровно то, за что ругали немые нули).
      ORDER BY COALESCE(
                 CASE WHEN m.end_time LIKE '____-__-__T%' THEN m.end_time END,
                 m.kickoff_at,
                 m.end_time
               ) DESC
      LIMIT ?`,
  ).all(Math.max(1, limit)) as { id: string; home: string; away: string; final_score: string | null; end_time: string | null; kickoff_at: string | null; end_note: string | null; sport: string; comp_name: string; bet_count: number }[];
  return rows.map((r) => ({
    id: r.id, match: `${r.home}–${r.away}`, sport: r.sport, compName: r.comp_name, finalScore: r.final_score,
    endIso: r.end_time, kickoffAt: r.kickoff_at, endLabel: warsawLabel(r.end_time) ?? warsawLabel(r.kickoff_at),
    endNote: r.end_note, broken: (r.end_note ?? "").startsWith("⚠ поломан"), betCount: Number(r.bet_count) || 0,
    // Улика, а не заплатка: строка, у которой end_time не ISO, названа таковой. Их 20 на проде, и пока
    // источник записи не найден, они обязаны быть видимы, а не тихо переехать вниз.
    endTimeMalformed: !!r.end_time && !/^\d{4}-\d{2}-\d{2}T/.test(String(r.end_time)),
  }));
}

/** Backstop cap on the no-bet finished-match ARCHIVE. Two tiers, bet-bearing matches NEVER touched:
 *   1. BROKEN + no-bet = abandoned / no-feed junk (never shown in Логи, zero review value) → always pruned.
 *      This was pruned before the archive decouple too, so it's restoring prior behaviour, not new loss.
 *   2. CLEAN (non-broken) no-bet finished → keep the newest `keep` for review, prune older. "Effectively forever"
 *      yet bounded against unbounded growth (like the tennis-snapshot cap).
 *  Returns the number removed. */
export function capMatchLogArchive(db: Database, keep = 20000): number {
  const noBet = "NOT EXISTS (SELECT 1 FROM bets b WHERE b.match_id = m.id AND b.status NOT IN ('proposed','not_filled'))";
  const brokenJunk = db.prepare(
    `SELECT m.id AS id FROM matches m WHERE m.state = 'finished' AND m.end_note LIKE '⚠ поломан%' AND ${noBet}`,
  ).all() as { id: string }[];
  const overflow = db.prepare(
    `SELECT m.id AS id FROM matches m
      WHERE m.state = 'finished' AND (m.end_note IS NULL OR m.end_note NOT LIKE '⚠ поломан%') AND ${noBet}
      ORDER BY COALESCE(m.end_time, m.kickoff_at) DESC
      LIMIT -1 OFFSET ?`,
  ).all(Math.max(0, keep)) as { id: string }[];
  return deleteMatches(db, [...brokenJunk, ...overflow].map((r) => r.id));
}

export function pruneStaleMatches(db: Database, opts: { staleBeforeMs?: number; graceBeforeMs?: number; now?: string } = {}): number {
  const rows = db.prepare(
    `SELECT m.id AS id, m.state AS state, m.kickoff_at AS kickoff_at, m.home AS home, m.away AS away,
            c.budget AS budget, c.name AS comp, c.external_league AS league FROM matches m
       JOIN competitions c ON c.id = m.competition_id
       WHERE NOT EXISTS (SELECT 1 FROM bets b WHERE b.match_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM provider_snapshots ps WHERE ps.match_id = m.id)`,
  ).all() as { id: string; state: string; kickoff_at: string | null; home: string; away: string; budget: number; comp: string; league: string | null }[];
  const doomed: string[] = [];
  // Audit trail: WHY each match is pruned, so a silent DELETE becomes visible («куда попропало»). Bounded ring.
  const audit: { match: string; comp: string; league: string | null; kickoff: string | null; state: string; reason: string }[] = [];
  const olderThan = (k: string | null, before?: number) => before != null && k != null && /^\d{4}-\d\d-\d\dT/.test(k) && !isNaN(Date.parse(k)) && Date.parse(k) < before;
  const stale = (k: string | null) => olderThan(k, opts.staleBeforeMs);
  void opts.graceBeforeMs; // (retained in the signature for back-compat; finished matches are no longer age-pruned)
  for (const r of rows) {
    // A FINISHED match is the log ARCHIVE now — NEVER age-pruned here (kept for review as long as the cap
    // allows; capMatchLogArchive bounds it by count, buildAppData keeps it out of the hot payload). Only a
    // NON-finished STALE import (an upcoming/lineup fixture that never resolved — pure Polymarket discovery
    // junk, no bets, no snapshots, kickoff long past) is pruned.
    if (r.state !== "finished" && stale(r.kickoff_at)) {
      doomed.push(r.id);
      audit.push({ match: `${r.home}—${r.away}`, comp: r.comp, league: r.league, kickoff: r.kickoff_at, state: r.state, reason: "не завершился, без ставок, старше окна — зависший импорт (не дошёл до финала)" });
    }
  }
  if (doomed.length) {
    try {
      const now = opts.now ?? new Date().toISOString();
      const prev = (() => { try { return JSON.parse(metaGet(db, "pruned_matches_recent") ?? "null")?.pruned ?? []; } catch { return []; } })();
      const ring = [...audit.map((a) => ({ ...a, at: now })), ...prev].slice(0, 100);
      metaSet(db, "pruned_matches_recent", JSON.stringify({ at: now, total: audit.length, pruned: ring }), now);
    } catch { /* never block the prune on the audit write */ }
  }
  return deleteMatches(db, doomed);
}

export interface BlindFundedMatch { id: string; match: string; comp: string; league: string | null; kickoff: string | null; state: string; reason: string }
/**
 * R2(б): funded FOOTBALL matches that are past kickoff yet carry NO match_live row —
 * i.e. we went into (or through) the match blind on a league we pay to trade. This is the
 * "не молчаливая слепота" surface: instead of a silent `?:?`, these get flagged so the
 * category_tier_mismatch / name-fold / upstream-dark cause can be chased (the R2(в) probe
 * classifies which). Bounded to a recent window so it's a rolling "recently blind" set.
 * reason: `no_league` (comp has no external_league at all) vs `unbound` (league set, but no
 * provider bind — tier mismatch, name mismatch, or a genuinely dark board).
 */
export function listBlindFundedFootball(db: Database, opts: { nowMs?: number; windowDays?: number; minPastMin?: number } = {}): BlindFundedMatch[] {
  const nowMs = opts.nowMs ?? Date.now();
  const loMs = nowMs - (opts.windowDays ?? 3) * 86400_000;
  const hiMs = nowMs - (opts.minPastMin ?? 15) * 60_000; // kickoff at least this long ago
  const rows = db.prepare(
    `SELECT m.id AS id, m.home AS home, m.away AS away, m.state AS state, m.kickoff_at AS kickoff_at,
            c.name AS comp, c.external_league AS league FROM matches m
       JOIN competitions c ON c.id = m.competition_id
       WHERE c.sport_id='football' AND c.budget > 0 AND m.kickoff_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM match_live ml WHERE ml.match_id = m.id)`,
  ).all() as { id: string; home: string; away: string; state: string; kickoff_at: string | null; comp: string; league: string | null }[];
  const out: BlindFundedMatch[] = [];
  for (const r of rows) {
    const k = r.kickoff_at && /^\d{4}-\d\d-\d\dT/.test(r.kickoff_at) ? Date.parse(r.kickoff_at) : NaN;
    if (isNaN(k) || k < loMs || k > hiMs) continue;
    out.push({ id: r.id, match: `${r.home}—${r.away}`, comp: r.comp, league: r.league, kickoff: r.kickoff_at, state: r.state, reason: r.league ? "unbound" : "no_league" });
  }
  return out.sort((a, b) => (b.kickoff ?? "").localeCompare(a.kickoff ?? ""));
}

/** Delete matches + all their child rows — NO transaction (caller owns one).
 *  node:sqlite has no nested transactions, so this is the reusable body that
 *  both deleteMatches and deleteCompetition run inside their own BEGIN/COMMIT. */
function deleteMatchRows(db: Database, ids: string[]): void {
  if (!ids.length) return;
  const delChild = MATCH_CHILD_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE match_id = ?`));
  const delMatch = db.prepare(`DELETE FROM matches WHERE id = ?`);
  for (const id of ids) {
    for (const stmt of delChild) stmt.run(id);
    delMatch.run(id);
  }
}

/** Delete matches + all their child rows (no ON DELETE CASCADE), atomically. */
function deleteMatches(db: Database, ids: string[]): number {
  if (!ids.length) return 0;
  db.exec("BEGIN");
  try { deleteMatchRows(db, ids); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
  return ids.length;
}

/** Public wrapper: delete specific matches (+ children) atomically. */
export function deleteMatchesById(db: Database, ids: string[]): number {
  return deleteMatches(db, ids);
}

/** Delete a competition and its children — NO transaction (caller owns one). */
function deleteCompetitionRows(db: Database, id: string): void {
  const matchIds = (db.prepare(`SELECT id FROM matches WHERE competition_id=?`).all(id) as { id: string }[]).map((r) => r.id);
  deleteMatchRows(db, matchIds);
  db.prepare(`DELETE FROM strategy_shares WHERE competition_id=?`).run(id);
  db.prepare(`DELETE FROM analytics_prompts WHERE scope='competition' AND scope_id=?`).run(id);
  db.prepare(`DELETE FROM competitions WHERE id=?`).run(id);
}

/** Delete a competition and everything under it (matches + their children,
 *  strategy shares, comp-scoped analytics prompts, the comp row) in ONE
 *  transaction — so a crash can't leave an empty orphaned competition row. */
export function deleteCompetition(db: Database, id: string): void {
  db.exec("BEGIN");
  try {
    deleteCompetitionRows(db, id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Fully retire a sport dropped from the app: every competition (cascading its
 *  matches/bets/…), every strategy (+ versions, quality, shares and any
 *  strategy-scoped rows), sport-scoped analytics prompts, and the sport row —
 *  funded or not, since it will never be traded again. All in one transaction.
 *  Returns competitions removed. */
export function removeSport(db: Database, sportId: string): number {
  const comps = (db.prepare(`SELECT id FROM competitions WHERE sport_id=?`).all(sportId) as { id: string }[]).map((r) => r.id);
  const strats = (db.prepare(`SELECT id FROM strategies WHERE sport_id=?`).all(sportId) as { id: string }[]).map((r) => r.id);
  db.exec("BEGIN");
  try {
    for (const cid of comps) deleteCompetitionRows(db, cid);
    for (const sid of strats) {
      // Strategy-scoped children first (match-scoped ones already went with the
      // comps above), then the strategy row — respecting the FKs to strategies(id).
      for (const t of ["strategy_versions", "quality_metrics", "strategy_shares", "bets", "reassessments", "trade_log"])
        db.prepare(`DELETE FROM ${t} WHERE strategy_id=?`).run(sid);
      db.prepare(`DELETE FROM strategies WHERE id=?`).run(sid);
    }
    db.prepare(`DELETE FROM analytics_prompts WHERE scope='sport' AND scope_id=?`).run(sportId);
    db.prepare(`DELETE FROM sports WHERE id=?`).run(sportId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return comps.length;
}

// ---------- empirical provider-coverage signals (per competition) ----------
// A match_live row is written ONLY when a provider (ESPN) actually returned this
// fixture on its scoreboard (engine.ts, sameTeams match) — so its existence is
// GROUND TRUTH that the provider covers this competition, not a guess like the
// static external_league mapping. Used to keep/prune football categories: a
// category we discovered, mapped, and played through but NEVER received live data
// for (unmapped league, or a wrong ESPN code) is proven-blind and can be dropped.
export function competitionLiveObserved(db: Database, compId: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM match_live ml JOIN matches m ON ml.match_id=m.id WHERE m.competition_id=? LIMIT 1`,
  ).get(compId);
}
/** Does this competition carry a bet with REAL money at stake (filled/settled)?
 *  A merely `proposed`/`not_filled` bet never moved capital — it must NOT protect
 *  a dead category from pruning (that's why phantom-proposal leagues like the
 *  Chinese Super League lingered). */
export function competitionHasRealBets(db: Database, compId: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM bets b JOIN matches m ON b.match_id=m.id
      WHERE m.competition_id=? AND b.status IN ('open','settled_won','settled_lost','settled_void') LIMIT 1`,
  ).get(compId);
}
/** Does this competition have any live (pct>0) strategy shares? A category the
 *  user has configured allocations for is "invested in" and never auto-pruned. */
export function competitionHasShares(db: Database, compId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM strategy_shares WHERE competition_id=? AND pct>0 LIMIT 1`).get(compId);
}
/** Matches still ahead of us (pre-kickoff or in-play) — a category with any of
 *  these might still deliver live data, so it's never pruned as "proven dead". */
export function competitionPendingMatchCount(db: Database, compId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM matches WHERE competition_id=? AND state IN ('upcoming','lineup','live')`,
  ).get(compId) as { n: number }).n;
}

/**
 * Remove discovered (`pm-*`) categories we no longer track — a sport dropped
 * from keepSports (e.g. cricket) or a tennis series outside the allow-list
 * (non-ATP). NEVER touches a competition the user has invested in — one that
 * carries a bet (preserves P&L), has a budget, or has strategy shares — nor a
 * seeded (non-`pm-`) competition. Then drops now-empty sport rows for untracked
 * sports so their tab disappears. Returns competitions removed.
 */
export function pruneRemovedCategories(db: Database, opts: { keepSports: Set<string>; tennisSeriesAllow: Set<string> | null }): number {
  let removed = 0;
  // A sport dropped from the app ENTIRELY (not in keepSports) is retired outright —
  // every competition + strategy + sport row, funded or invested or not — because
  // we will never trade it again and it only clutters the UI. Gather sport ids from
  // all three tables so an orphan (comp/strategy whose sport row already went) is
  // still swept.
  const sportIds = new Set<string>();
  for (const r of db.prepare(`SELECT id AS s FROM sports UNION SELECT sport_id AS s FROM competitions UNION SELECT sport_id AS s FROM strategies`).all() as { s: string }[])
    sportIds.add(r.s);
  for (const sid of sportIds) if (!opts.keepSports.has(sid)) removed += removeSport(db, sid);

  // Within KEPT sports: prune the noisy discovered catch-alls — but never a
  // competition the user has invested in (bet / budget / shares) or a seeded one.
  for (const c of listCompetitions(db)) {
    if (!c.id.startsWith("pm-")) continue; // only discovered catch-alls
    if (!opts.keepSports.has(c.sport_id)) continue; // already retired above
    let doomed = false;
    if (c.id === `pm-${c.sport_id}`) doomed = true;                      // seriesless «… · прочее» catch-all
    else if (c.sport_id === "tennis") {
      const slug = c.id.slice(3);                                        // pm-<slug>
      // Doubles are out of scope entirely (env-independent) — always prune.
      if (/doubles/.test(slug)) doomed = true;
      // Else the series filter applies ONLY when a whitelist is set. null = unrestricted
      // (keep every liquid tennis series) — an empty/absent allow-list must NOT doom
      // every tennis category (that's how display-only tennis would vanish next cycle).
      else if (opts.tennisSeriesAllow && !opts.tennisSeriesAllow.has(slug)) doomed = true;
    }
    else if (c.sport_id === "football" && c.external_league == null) doomed = true; // no ESPN live coverage → not tradeable
    if (!doomed || c.budget > 0) continue;                               // funded → keep
    // For football a merely `proposed`/`not_filled` bet moved NO money, so it must
    // NOT keep a dead (unmapped) category alive — that's exactly why the Chinese
    // Super League lingered on phantom proposals. Require REAL P&L to protect it.
    // Other sports keep the conservative any-bet guard.
    const hasBet = c.sport_id === "football"
      ? competitionHasRealBets(db, c.id)
      : db.prepare(`SELECT 1 FROM bets b JOIN matches m ON b.match_id=m.id WHERE m.competition_id=? LIMIT 1`).get(c.id);
    const hasShares = db.prepare(`SELECT 1 FROM strategy_shares WHERE competition_id=? AND pct>0 LIMIT 1`).get(c.id);
    if (hasBet || hasShares) continue;                                   // invested → keep (P&L / config)
    deleteCompetition(db, c.id);
    removed++;
  }
  return removed;
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

/** Minutes since a label's price last CHANGED (P1 zombie stale-book rule). Walks the label's snapshots
 *  newest-first over the contiguous run at the current price; the oldest snapshot in that run is when the
 *  current price was set. Returns null when the label has no history. A book re-snapshotted every tick at an
 *  unchanged price yields a growing age — exactly the «стухшая книга» signal. */
export function bookStaleMinutes(db: Database, matchId: string, label: string, currentPrice: number, nowIso: string): number | null {
  const rows = db.prepare(
    `SELECT price, snapshot_at FROM markets WHERE match_id=? AND label=? ORDER BY snapshot_at DESC, rowid DESC`,
  ).all(matchId, label) as { price: number; snapshot_at: string }[];
  if (!rows.length) return null;
  let firstOfCurrent = rows[0].snapshot_at;
  for (const r of rows) {
    if (Math.abs((r.price ?? NaN) - currentPrice) < 0.6) firstOfCurrent = r.snapshot_at;
    else break;
  }
  const ageMs = Date.parse(nowIso) - Date.parse(firstOfCurrent);
  return Number.isFinite(ageMs) ? Math.max(0, ageMs / 60_000) : null;
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
  // Every bet is born with a stable decision_id (the twin link to a future real order,
  // spec §0.1). Callers may pass one to group bets under a shared decision; otherwise a
  // fresh id is minted here so no row ever lacks one.
  const decisionId = b.decision_id ?? uid();
  // origin phase is a FIELD resolved once here (never inferred at read). A caller may pass it
  // explicitly (backfill); otherwise derive from entry_meta.phase → source 'decision'. FAIL-LOUD: a
  // fresh entry with NO phase is a bug (some path forgot to stamp it) — we tag it 'inferred_backfill'
  // (visible in the report's diagnostic line, NOT a silent 'prematch' default) and warn, so it can't
  // become a quiet fourth "empty" class.
  let origin = b.origin ?? null, originSource = b.origin_source ?? null;
  // P0.5: stamp the football epoch on any new football-strategy bet (parallels tennis «пороги:…»). The
  // clean era begins after the P0.1-P0.3 fixes; pre-fix rows are migrated to epoch_unknown and dropped
  // from verdict cuts. Explicit b.football_epoch wins (tests / backfill).
  const footballEpoch = b.football_epoch ?? (FOOTBALL_STRATS.has(b.strategy_id) ? FOOTBALL_EPOCH : null);
  if (origin == null) {
    const r = resolveBetOrigin(b.entry_meta, b.entered_minute, true);
    origin = r.origin; originSource = r.source;
    // The durable loud signal is the 'inferred_backfill' tag on a fresh row (the report surfaces it).
    // A console warn on top ONLY for the clearest bug — a bet that HAS entry_meta but no phase (a prod
    // path that forgot to stamp it); entry_meta-less inserts (legacy/tests) stay quiet.
    if (r.source !== "decision" && b.entry_meta != null) console.warn(`[origin] bet ${b.id} (${b.strategy_id}) has entry_meta but NO phase → reconstructed origin='${r.origin}'. A new entry must stamp entry_meta.phase.`);
  }
  db.prepare(
    `INSERT INTO bets(id,match_id,strategy_id,risk_profile_id,market_label,status,proposed_price,entry_price,
       current_price,closing_price,ai_prob,stake,rationale,entered_minute,result,payout,settled_by,settled_at,entry_meta,code_version,decision_id,origin,origin_source,football_epoch,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    b.id, b.match_id, b.strategy_id, b.risk_profile_id ?? null, b.market_label, b.status, b.proposed_price, b.entry_price,
    b.current_price, b.closing_price, b.ai_prob, b.stake, b.rationale, b.entered_minute,
    b.result, b.payout, b.settled_by ?? null, b.settled_at ?? null, b.entry_meta ?? null, b.code_version ?? null, decisionId, origin, originSource, footballEpoch, b.created_at,
  );
}
export function updateBet(db: Database, id: string, patch: Partial<Bet>): void {
  const p: Partial<Bet> = patch;
  // п.2 (batch-4): stamp the EXIT epoch the first time a bet transitions to a settled state. code_version
  // is the entry epoch; exit_code_version is the epoch at close. A deploy mid-position-life makes them
  // differ (cross_epoch), which per-epoch verdict slices exclude. Single choke point: every settle path
  // funnels its status change through updateBet. Only stamp once (first settled transition) and only when
  // the caller didn't set it explicitly. Epoch computed inline to avoid a repo→codeEpoch import cycle.
  if (typeof p.status === "string" && p.status.startsWith("settled")) {
    const row = db.prepare(`SELECT exit_code_version, stake, entry_price, closing_price, settled_by, payout FROM bets WHERE id=?`).get(id) as
      { exit_code_version?: string | null; stake?: number | null; entry_price?: number | null; closing_price?: number | null; settled_by?: string | null; payout?: number | null } | undefined;
    // п.2: stamp the EXIT epoch on the first settled transition (entry epoch = code_version, exit epoch =
    // exit_code_version; a deploy mid-life makes them differ → cross_epoch, excluded from per-epoch cuts).
    if (p.exit_code_version === undefined && row && row.exit_code_version == null) {
      const me = Number(metaGet(db, "model_epoch") ?? 1);
      p.exit_code_version = `${CODE_VERSION}·m${Number.isFinite(me) && me >= 1 ? Math.floor(me) : 1}`;
    }
    // Z2(b): payout-consistency invariant. The recorded payout must match the EXPECTED value for its settle
    // kind within a commission tolerance — a mismatch is a decimal shift (Kansas «payout ≈ тек/10»), flagged
    // accounting_suspect at birth. void refunds vary by path → skipped (only won/lost validated). Read-only
    // guard: it flags, never blocks a settle. Both consumers share this single choke (every settle → updateBet).
    if ((p.status === "settled_won" || p.status === "settled_lost") && p.accounting_suspect === undefined && row) {
      const stake = Number(p.stake ?? row.stake ?? 0);
      const entry = Number(row.entry_price ?? 0);
      const payout = Number(p.payout ?? row.payout ?? NaN);
      const closing = Number(p.closing_price ?? row.closing_price ?? NaN);
      const settledBy = (p.settled_by ?? row.settled_by ?? null) as string | null;
      if (stake > 0 && entry > 0 && Number.isFinite(payout)) {
        const early = settledBy === "early" || settledBy === "partial";
        // [Z2(б) / batch-9] An EARLY settle with no exit price recorded used to set expected := payout, i.e.
        // the invariant compared the payout to ITSELF and could never fire — a silent self-disable on exactly
        // the path the batch-9 case lives on (тек.39.3 with payout↔выход ~17¢ and no accounting_suspect). An
        // un-checkable settle must be LOUD, not quietly blessed: flag it accounting_unverifiable and count it,
        // so the gap is visible as a number instead of masquerading as a clean row.
        if (early && !Number.isFinite(closing)) {
          p.accounting_unverifiable = 1;
          try {
            const n = Number(metaGet(db, "accounting_unverifiable_count") ?? 0) + 1;
            metaSet(db, "accounting_unverifiable_count", String(n), new Date().toISOString());
            metaSet(db, "accounting_unverifiable_last", JSON.stringify({ betId: id, status: p.status, settledBy, stake, entry, payout, why: "early-выход без записанной цены выхода (closing_price) — ожидание не с чем сверить" }), new Date().toISOString());
          } catch { /* best-effort telemetry */ }
        }
        const expected = early
          ? (Number.isFinite(closing) ? stake * (closing / entry) : payout) // trading cash-out: stake·exit/entry
          : (p.status === "settled_won" ? stake * (100 / entry) : 0);        // held to settle: won→100¢, lost→0
        const tol = Math.max(0.5, 0.02 * Math.max(stake, expected)); // ~2% of notional or 50¢, covers fee+rounding
        if (Math.abs(payout - expected) > tol) {
          p.accounting_suspect = 1;
          try {
            const n = Number(metaGet(db, "accounting_suspect_count") ?? 0) + 1;
            metaSet(db, "accounting_suspect_count", String(n), new Date().toISOString());
            metaSet(db, "accounting_suspect_last", JSON.stringify({ betId: id, status: p.status, settledBy, stake, entry, payout, expected: Math.round(expected * 100) / 100 }), new Date().toISOString());
          } catch { /* best-effort telemetry */ }
        }
      }
    }
  }
  const keys = Object.keys(p);
  if (!keys.length) return;
  const set = keys.map((k) => `${k}=?`).join(", ");
  db.prepare(`UPDATE bets SET ${set} WHERE id=?`).run(...keys.map((k) => (p as any)[k]), id);
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
/** Every bet, one query — for buildAppData's bulk aggregation (stats/quality)
 *  instead of a per-match betsForMatch scan. */
export function allBets(db: Database): Bet[] {
  return db.prepare(`SELECT * FROM bets`).all() as Bet[];
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
    `SELECT * FROM bets WHERE strategy_id=? AND status IN ('settled_won','settled_lost','settled_void')`,
  ).all(strategyId) as Bet[];
}
// Canonical "this bet reached a terminal state" test — the single source so no caller re-derives it
// (and can't forget that a VOID is settled-but-not-a-loss). A loss-specific check must use
// `status === "settled_lost"` directly; a stats/outcome check must exclude settled_void.
export function isSettled(status: string): boolean {
  return status === "settled_won" || status === "settled_lost" || status === "settled_void";
}

// ---------- reassessments / trade log ----------
export function insertReassessment(db: Database, r: Reassessment): void {
  db.prepare(
    `INSERT INTO reassessments(id,match_id,strategy_id,minute,body,confidence,trigger,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(r.id, r.match_id, r.strategy_id, r.minute, r.body, r.confidence, r.trigger, r.created_at);
}
export function insertTradeLog(db: Database, e: TradeLogEntry): void {
  // Z3: OR IGNORE + the partial unique index on (match_id,type,dedup_key) makes a keyed line idempotent —
  // a re-render / double-write of the same event is dropped. Rows without a dedup_key never hit the index,
  // so they insert normally (the uid() PK is unique), and behaviour is unchanged for all existing callers.
  db.prepare(
    `INSERT OR IGNORE INTO trade_log(id,match_id,strategy_id,minute,type,text,dedup_key,created_at) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(e.id, e.match_id, e.strategy_id, e.minute, e.type, e.text, e.dedup_key ?? null, e.created_at);
}
export function reassessmentsForMatch(db: Database, matchId: string): Reassessment[] {
  return db.prepare(`SELECT * FROM reassessments WHERE match_id=? ORDER BY created_at`).all(matchId) as Reassessment[];
}
export function tradeLogForMatch(db: Database, matchId: string): TradeLogEntry[] {
  return db.prepare(`SELECT * FROM trade_log WHERE match_id=? ORDER BY created_at`).all(matchId) as TradeLogEntry[];
}
// Globally most-recent rows for the event feed — bounded LIMIT instead of
// scanning every match's log/reassessments/events and slicing afterwards.
export function recentTradeLog(db: Database, limit: number, excludeSkips = false): TradeLogEntry[] {
  // excludeSkips filters «пропуски» in SQL, not after: every cron tick logs a skip per
  // (strategy,profile,match), so with tennis running 4 profiles × many live matches the
  // newest-N window is flooded with skips and real enters/settles fall out of it. The feed
  // wants the newest P&L-affecting rows, so it must exclude skips BEFORE the LIMIT.
  const where = excludeSkips ? `WHERE type != 'skip'` : ``;
  return db.prepare(`SELECT * FROM trade_log ${where} ORDER BY created_at DESC LIMIT ?`).all(limit) as TradeLogEntry[];
}
export function recentReassessments(db: Database, limit: number): Reassessment[] {
  return db.prepare(`SELECT * FROM reassessments ORDER BY created_at DESC LIMIT ?`).all(limit) as Reassessment[];
}
export function recentMatchEvents(db: Database, limit: number): MatchEventRow[] {
  return db.prepare(`SELECT * FROM match_events WHERE type != 'other' ORDER BY created_at DESC LIMIT ?`).all(limit) as MatchEventRow[];
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
  const existing = db.prepare(`SELECT id FROM analytics_prompts WHERE scope=? AND scope_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(scope, scopeId);
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

// ---------- provider snapshots (raw + extracted per provider) ----------
export interface ProviderSnapshotRow {
  id: string; match_id: string; batch_at: string; provider: string; phase: string;
  ok: number; http_status: number | null; provider_ref: string | null;
  minute: number | null; latency_ms: number | null; extracted: string | null; raw: string | null; created_at: string;
}
export interface SnapshotInput {
  match_id: string; batch_at: string; provider: string; phase: string;
  ok: boolean; http_status: number | null; provider_ref: string | null;
  minute: number | null; latency_ms: number | null; extracted: unknown; raw: string | null;
}
export function insertProviderSnapshot(db: Database, s: SnapshotInput): void {
  db.prepare(
    `INSERT INTO provider_snapshots(id,match_id,batch_at,provider,phase,ok,http_status,provider_ref,minute,latency_ms,extracted,raw,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(uid(), s.match_id, s.batch_at, s.provider, s.phase, s.ok ? 1 : 0, s.http_status, s.provider_ref, s.minute,
        s.latency_ms, s.extracted == null ? null : JSON.stringify(s.extracted), s.raw, nowIso());
}
/** Snapshot metadata for a match (NO raw payload — keeps the view light), newest first. */
export function snapshotMetaForMatch(db: Database, matchId: string, limit = 400): Omit<ProviderSnapshotRow, "raw">[] {
  return db.prepare(
    `SELECT id,match_id,batch_at,provider,phase,ok,http_status,provider_ref,minute,latency_ms,extracted,created_at
     FROM provider_snapshots WHERE match_id=? ORDER BY batch_at DESC, provider LIMIT ?`,
  ).all(matchId, limit) as Omit<ProviderSnapshotRow, "raw">[];
}
/** One snapshot's FULL raw payload, by id (for the raw-JSON view / export). */
export function snapshotRaw(db: Database, id: string): { provider: string; batch_at: string; raw: string | null } | null {
  const r = db.prepare(`SELECT provider,batch_at,raw FROM provider_snapshots WHERE id=?`).get(id);
  return r ?? null;
}
/** Count of snapshots per match (for the Анализ tab badge). */
export function snapshotCount(db: Database, matchId: string): number {
  const r = db.prepare(`SELECT COUNT(*) n FROM provider_snapshots WHERE match_id=?`).get(matchId) as { n: number };
  return r?.n ?? 0;
}
/** Latest LIVE xG (home/away) captured for a match — from the freshest provider
 *  snapshot that actually carries xG values (Sportmonks). Feeds the Live xG
 *  Momentum strategist, which is dead without a live-xG flow. Null if none yet. */
export function latestLiveXg(db: Database, matchId: string): { home: number; away: number; minute: number | null; provider: string; at: string } | null {
  const rows = db.prepare(
    `SELECT provider, minute, batch_at, extracted FROM provider_snapshots
       WHERE match_id=? AND ok=1 AND extracted IS NOT NULL ORDER BY batch_at DESC LIMIT 12`,
  ).all(matchId) as { provider: string; minute: number | null; batch_at: string; extracted: string }[];
  for (const r of rows) {
    try {
      const e = JSON.parse(r.extracted);
      if (e?.xg?.present && e.xg.home != null && e.xg.away != null)
        return { home: Number(e.xg.home), away: Number(e.xg.away), minute: r.minute, provider: r.provider, at: r.batch_at };
    } catch { /* skip malformed */ }
  }
  return null;
}
/** Keep the snapshot table bounded on the persistent disk: drop rows older than N days. */
export function pruneSnapshots(db: Database, olderThanIso: string): number {
  return db.prepare(`DELETE FROM provider_snapshots WHERE batch_at < ?`).run(olderThanIso).changes ?? 0;
}

// provider_match_map — resolved external match id per provider (cache).
export interface ProviderCoverageRow {
  provider: string; league: string; consec_fail: number;
  muted_until: string | null; last_probe_at: string | null; updated_at: string;
}
export function getProviderCoverage(db: Database, provider: string, league: string): ProviderCoverageRow | null {
  return (db.prepare(`SELECT * FROM provider_coverage WHERE provider=? AND league=?`).get(provider, league) as ProviderCoverageRow | undefined) ?? null;
}
/** [batch-9] Every (provider, league) coverage row — for the plan-scope report. Worst first. */
export function listProviderCoverage(db: Database): ProviderCoverageRow[] {
  return db.prepare(`SELECT * FROM provider_coverage ORDER BY consec_fail DESC`).all() as ProviderCoverageRow[];
}
export function upsertProviderCoverage(db: Database, r: ProviderCoverageRow): void {
  db.prepare(`INSERT INTO provider_coverage(provider,league,consec_fail,muted_until,last_probe_at,updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(provider,league) DO UPDATE SET consec_fail=excluded.consec_fail, muted_until=excluded.muted_until, last_probe_at=excluded.last_probe_at, updated_at=excluded.updated_at`)
    .run(r.provider, r.league, r.consec_fail, r.muted_until, r.last_probe_at, r.updated_at);
}
// ── comeback_latency_metrics — persisted Overreaction latency cases (computed at settle) ──
export interface ComebackLatencyRow {
  id: string; match_id: string; competition_id: string; case_type: string;
  market_label: string; token: string | null;
  event_type: string; event_text: string | null; t_event: string; event_minute: number | null;
  panic_amplitude_cents: number | null; price_floor_cents: number | null; t_floor_sec: number | null;
  entry_price_cents: number | null; t_entry_sec: number | null; missed_cents: number | null; lag_floor_to_entry_sec: number | null;
  recovery_1: number | null; recovery_2: number | null; recovery_3: number | null; recovery_5: number | null;
  floor_thinness_usd: number | null; paper_floor: number | null;
  price_trigger_cents: number | null; floor_below_trigger_cents: number | null;
  window_quotes: number; confidence_flags: string | null; code_version: string | null; created_at: string;
}
export function insertComebackLatencyMetric(db: Database, r: ComebackLatencyRow): void {
  db.prepare(
    `INSERT INTO comeback_latency_metrics(
       id,match_id,competition_id,case_type,market_label,token,event_type,event_text,t_event,event_minute,
       panic_amplitude_cents,price_floor_cents,t_floor_sec,entry_price_cents,t_entry_sec,missed_cents,lag_floor_to_entry_sec,
       recovery_1,recovery_2,recovery_3,recovery_5,floor_thinness_usd,paper_floor,price_trigger_cents,floor_below_trigger_cents,
       window_quotes,confidence_flags,code_version,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?)`,
  ).run(
    r.id, r.match_id, r.competition_id, r.case_type, r.market_label, r.token, r.event_type, r.event_text, r.t_event, r.event_minute,
    r.panic_amplitude_cents, r.price_floor_cents, r.t_floor_sec, r.entry_price_cents, r.t_entry_sec, r.missed_cents, r.lag_floor_to_entry_sec,
    r.recovery_1, r.recovery_2, r.recovery_3, r.recovery_5, r.floor_thinness_usd, r.paper_floor, r.price_trigger_cents, r.floor_below_trigger_cents,
    r.window_quotes, r.confidence_flags, r.code_version, r.created_at,
  );
}
export function listComebackLatencyMetrics(db: Database): ComebackLatencyRow[] {
  return db.prepare(`SELECT * FROM comeback_latency_metrics ORDER BY created_at`).all() as ComebackLatencyRow[];
}
export function comebackLatencyCountForMatch(db: Database, matchId: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM comeback_latency_metrics WHERE match_id=?`).get(matchId) as { n: number }).n;
}

// ── tennis_snapshots — Stage-0 tennis provider scouting (parallel stream) ──
export interface TennisSnapshotRow {
  id: string; event_key: string; provider: string; batch_at: string;
  p1: string | null; p2: string | null; tournament: string | null; event_type: string | null;
  live: number | null; status: string | null;
  sets_p1: number | null; sets_p2: number | null; set_num: number | null;
  games_p1: number | null; games_p2: number | null; game_points: string | null; server: string | null;
  pm_match_id: string | null; pm_mid_cents: number | null; pm_p1_cents: number | null; pm_p2_cents: number | null; raw: string | null; created_at: string;
}
export function insertTennisSnapshot(db: Database, r: Omit<TennisSnapshotRow, "id" | "created_at"> & { id?: string; created_at?: string }): void {
  db.prepare(
    `INSERT INTO tennis_snapshots(id,event_key,provider,batch_at,p1,p2,tournament,event_type,live,status,
       sets_p1,sets_p2,set_num,games_p1,games_p2,game_points,server,pm_match_id,pm_mid_cents,pm_p1_cents,pm_p2_cents,raw,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?, ?,?)`,
  ).run(r.id ?? uid(), r.event_key, r.provider, r.batch_at, r.p1, r.p2, r.tournament, r.event_type, r.live, r.status,
    r.sets_p1, r.sets_p2, r.set_num, r.games_p1, r.games_p2, r.game_points, r.server, r.pm_match_id, r.pm_mid_cents, r.pm_p1_cents ?? null, r.pm_p2_cents ?? null, r.raw, r.created_at ?? nowIso());
}
export function tennisSnapshotsForEvent(db: Database, eventKey: string): TennisSnapshotRow[] {
  return db.prepare(`SELECT * FROM tennis_snapshots WHERE event_key=? ORDER BY batch_at`).all(eventKey) as TennisSnapshotRow[];
}
export function tennisSnapshotEventKeys(db: Database): string[] {
  return (db.prepare(`SELECT DISTINCT event_key FROM tennis_snapshots`).all() as { event_key: string }[]).map((r) => r.event_key);
}
export function tennisSnapshotCount(db: Database): number {
  return (db.prepare(`SELECT COUNT(*) n FROM tennis_snapshots`).get() as { n: number }).n;
}
export function pruneTennisSnapshots(db: Database, olderThanIso: string): number {
  return db.prepare(`DELETE FROM tennis_snapshots WHERE batch_at < ?`).run(olderThanIso).changes ?? 0;
}
// Hard row-cap backstop: if a burst (e.g. a catch-up storm) wrote far more snapshots than the
// time-retention keeps, drop the oldest beyond `keep`. Prevents the table (with its big raw blobs)
// from bloating the DB file — it hit 1.2 GB once, which starved boot. Cheap (uses the batch_at index).
// T1: NEVER evict snapshots of a match with a PENDING sv_shadow_signal — resolveSvShadowSignals reads the
// final set counts from tennis_snapshots, so evicting them before resolution (a real race during the hourly
// cron sleeps) silently loses a cohort row — irreplaceable calibration raw material. The 5-day time-prune
// (pruneTennisSnapshots) stays the absolute ceiling, so a stuck-pending signal can't pin snapshots forever.
export function capTennisSnapshots(db: Database, keep = 20000): number {
  const n = tennisSnapshotCount(db);
  if (n <= keep) return 0;
  return db.prepare(
    `DELETE FROM tennis_snapshots WHERE batch_at < (SELECT MIN(batch_at) FROM (SELECT batch_at FROM tennis_snapshots ORDER BY batch_at DESC LIMIT ?))
       AND (pm_match_id IS NULL OR pm_match_id NOT IN (SELECT match_id FROM sv_shadow_signals WHERE status='pending'))`,
  ).run(keep).changes ?? 0;
}

/** T1 retained-depth diagnostic: makes the ACTUAL retro-cohort window visible (the 20k row-cap silently
 *  undercuts the SNAPSHOT_RETENTION_DAYS setting when scouting is dense). Read by the prune step → app_meta. */
export function tennisSnapshotDepth(db: Database): { count: number; oldest: string | null; newest: string | null } {
  const r = db.prepare(`SELECT COUNT(*) n, MIN(batch_at) oldest, MAX(batch_at) newest FROM tennis_snapshots`).get() as { n: number; oldest: string | null; newest: string | null };
  return { count: r.n, oldest: r.oldest, newest: r.newest };
}
// tennis_map_log is pure observability (mapping decisions) and is written every collection pass —
// it accumulated 47k rows. Keep only the newest `keep`.
export function capTennisMapLog(db: Database, keep = 3000): number {
  const n = (db.prepare(`SELECT COUNT(*) n FROM tennis_map_log`).get() as { n: number }).n;
  if (n <= keep) return 0;
  return db.prepare(`DELETE FROM tennis_map_log WHERE created_at < (SELECT MIN(created_at) FROM (SELECT created_at FROM tennis_map_log ORDER BY created_at DESC LIMIT ?))`).run(keep).changes ?? 0;
}

export interface TennisMapLogRow { id?: string; event_key: string; players: string | null; verdict: string; match_id: string | null; score: number | null; candidates: string | null; created_at: string }
export function insertTennisMapLog(db: Database, r: TennisMapLogRow): void {
  db.prepare(`INSERT INTO tennis_map_log(id,event_key,players,verdict,match_id,score,candidates,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(r.id ?? uid(), r.event_key, r.players, r.verdict, r.match_id, r.score, r.candidates, r.created_at);
}
export function tennisMapLog(db: Database, limit = 500): TennisMapLogRow[] {
  return db.prepare(`SELECT * FROM tennis_map_log ORDER BY created_at DESC LIMIT ?`).all(limit) as TennisMapLogRow[];
}

export interface TennisBreakMarkRow {
  id?: string; event_key: string; match_id: string | null; players: string | null; tournament: string | null; event_type: string | null;
  set_num: number | null; broken_side: string | null; broke_early: number | null; episode_n?: number | null; t_event: string;
  pre_cents: number | null; floor_cents: number | null; t_floor_sec: number | null; panic_cents: number | null;
  recovery_1: number | null; recovery_2: number | null; recovery_3: number | null; recovery_5: number | null;
  post_entry_min_cents?: number | null; post_entry_min_sec?: number | null;
  window_quotes: number; confidence_flags: string | null; code_version: string | null; created_at: string;
}
export function insertTennisBreakMark(db: Database, r: TennisBreakMarkRow): void {
  db.prepare(
    `INSERT INTO tennis_break_marks(id,event_key,match_id,players,tournament,event_type,set_num,broken_side,broke_early,episode_n,t_event,
       pre_cents,floor_cents,t_floor_sec,panic_cents,recovery_1,recovery_2,recovery_3,recovery_5,post_entry_min_cents,post_entry_min_sec,window_quotes,confidence_flags,code_version,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(r.id ?? uid(), r.event_key, r.match_id, r.players, r.tournament, r.event_type, r.set_num, r.broken_side, r.broke_early, r.episode_n ?? null, r.t_event,
    r.pre_cents, r.floor_cents, r.t_floor_sec, r.panic_cents, r.recovery_1, r.recovery_2, r.recovery_3, r.recovery_5, r.post_entry_min_cents ?? null, r.post_entry_min_sec ?? null, r.window_quotes, r.confidence_flags, r.code_version, r.created_at);
}
export function listTennisBreakMarks(db: Database): TennisBreakMarkRow[] {
  return db.prepare(`SELECT * FROM tennis_break_marks ORDER BY created_at`).all() as TennisBreakMarkRow[];
}
export function tennisBreakMarkCountForEvent(db: Database, eventKey: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM tennis_break_marks WHERE event_key=?`).get(eventKey) as { n: number }).n;
}

export function getProviderRef(db: Database, matchId: string, provider: string): { provider_ref: string | null; resolved_at: string } | null {
  const r = db.prepare(`SELECT provider_ref,resolved_at FROM provider_match_map WHERE match_id=? AND provider=?`).get(matchId, provider);
  return r ?? null;
}
export function setProviderRef(db: Database, matchId: string, provider: string, ref: string | null): void {
  db.prepare(
    `INSERT INTO provider_match_map(match_id,provider,provider_ref,resolved_at)
     VALUES(?,?,?,?)
     ON CONFLICT(match_id,provider) DO UPDATE SET provider_ref=excluded.provider_ref, resolved_at=excluded.resolved_at`,
  ).run(matchId, provider, ref, nowIso());
}
