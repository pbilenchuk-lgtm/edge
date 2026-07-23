// ============================================================
// EDGE LAB — domain types (mirror of ТЗ §2 schema)
// ============================================================

export type Confidence = "низкая" | "средняя" | "высокая";
export type MatchState = "upcoming" | "lineup" | "live" | "finished";
export type BetStatus =
  | "proposed"
  | "open"
  | "not_filled"
  | "settled_won"
  | "settled_lost"
  // A VOID (refund) — canceled / walkover / exact-line push / unresolvable-by-us / a strategy reset.
  // NOT a loss: single-source truth in the STATUS field, so no consumer can miscount a refund as a
  // loss by reading `status` directly (it always pairs with settled_by="void", result=null, payout=stake).
  | "settled_void";
export type ReassessTrigger =
  | "goal"
  | "red_card"
  | "penalty"
  | "price_move"
  | "time"
  | "manual";

export interface Sport {
  id: string;
  label: string;
}

export interface Competition {
  id: string;
  sport_id: string;
  name: string;
  budget: number;
  /** ESPN league code for auto-import (e.g. 'fifa.world'); null = manual only */
  external_league: string | null;
  created_at: string;
}

export interface Treasury {
  id: 1;
  total_balance: number;
}

export interface AnalyticsPrompt {
  id: string;
  scope: "sport" | "competition";
  scope_id: string;
  body: string;
  model: string | null;
  updated_at: string;
}

/**
 * Thresholds extracted from a strategy's natural-language prompt (ТЗ §3.2).
 * The ENGINE computes bet sizes from these — never the LLM (invariant §9.6).
 */
export interface StrategyParams {
  /** max fraction of budget on a single bet (from «не более 20%») */
  maxPerBet?: number;
  /** min edge % to enter (from «edge >= 3%») */
  minEdge?: number;
  /** fixed size fraction (from «размер всегда 5%») */
  flatSize?: number;
  /** Kelly multiplier, e.g. 0.5 for half-Kelly */
  kellyFraction?: number;
  /** size cap fraction for Kelly strategies */
  cap?: number;
  /** ladder [[edge%, fraction], ...] (from «>=10% -> 20%; 7-10% -> 15%») */
  tiers?: Array<[number, number]>;
  /** min confidence to enter */
  minConfidence?: Confidence | "high";
  /** take-profit: close a position once its value is up this fraction (e.g. 0.5 = +50%) */
  takeProfit?: number;
  /** per-position stop: close once down this fraction (positive number, e.g. 0.4) */
  exitStop?: number;
  /** deterministic "edge gone" auto-exit (model prob ≤ current price). Default ON
   *  for back-compat; set false to let the STRATEGIST manage exits instead of the
   *  fast loop cashing out every tick the edge dips (avoids in-match churn). */
  edgeExit?: boolean;
  /** diagnostic note when nothing could be extracted */
  note?: string;
}

export interface Strategy {
  id: string;
  sport_id: string;
  name: string;
  tag: string | null;
  color: string | null;
  version: number;
  prompt: string;              // предматч-окно стратега
  prompt_live: string | null;  // live-окно стратега (может отсутствовать)
  params: StrategyParams;
  model: string | null;       // модель для ПРЕДМАТЧ-входа (формирование тезиса)
  model_live: string | null;  // модель для LIVE-переоценки (исполнение боевого листа); null → падаем на model
  created_at: string;
}

export interface StrategyShare {
  competition_id: string;
  strategy_id: string;
  risk_profile_id: string; // назначенный профиль пары (default 'medium')
  pct: number;
}

export interface Match {
  id: string;
  competition_id: string;
  home: string;
  away: string;
  state: MatchState;
  lineup_out: boolean;
  kickoff_at: string | null;
  minute: number | null;
  score_home: number | null;
  score_away: number | null;
  final_score: string | null;
  kickoff_time: string | null;
  end_time: string | null;
  duration: string | null;
  end_note: string | null;
  external_ref: string | null;
  /** raw ESPN display clock incl. stoppage ("45'+2'"); null pre-match / non-ESPN */
  clock?: string | null;
}

export interface Assessment {
  id: string;
  match_id: string;
  stage: "pre_lineup" | "post_lineup";
  confidence: Confidence | null;
  short: string | null;
  body: string | null;
  verdict: string | null;
  model: string | null;
  status: "ok" | "failed";
  created_at: string;
}

export interface AnalysisJob {
  match_id: string;
  status: "running" | "done" | "failed";
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface Market {
  id: string;
  match_id: string;
  label: string;
  /** price in cents 0..100 (== probability * 100) */
  price: number;
  ai_prob: number | null;
  liquidity: string | null;
  external_ref: string | null;      // CLOB token of outcomes[0] (backs `price`)
  /** CLOB token of outcomes[1] on a 2-outcome market (tennis moneyline). Lets a consumer resolve the
   *  SECOND side's token instead of assuming the first — the token-fix-m1 orientation fix. Null on
   *  single-sided rows and on markets imported before the column existed (backfilled on re-discovery). */
  token_second?: string | null;
  snapshot_at: string;
  is_closing: boolean;
  /** executable BUY ask for this side (cents) and bid/ask spread — from Gamma's book fields, so a
   *  decision's edge is measured against what a trade would actually PAY, not the mid. Null → no book
   *  → edge falls back to `price` (mid) and is flagged mid_fallback. */
  ask_cents?: number | null;
  spread_cents?: number | null;
}

export interface Bet {
  id: string;
  match_id: string;
  strategy_id: string;
  /** risk profile of the (strategy, profile) pair that placed the bet — the
   *  budget/exposure unit. May be null on legacy rows (pre-profiles). */
  risk_profile_id?: string | null;
  market_label: string;
  status: BetStatus;
  proposed_price: number | null;
  entry_price: number | null;
  current_price: number | null;
  closing_price: number | null;
  ai_prob: number | null;
  stake: number | null;
  rationale: string | null;
  entered_minute: string | null;
  result: "won" | "lost" | null;
  payout: number | null;
  created_at: string;
  /** how the bet closed: null/undefined = settled by real match resolution;
   *  "early" = cashed out at market; "partial" = a partial-fixation child slice.
   *  Only resolution-settled bets feed the predictive metrics (Brier/CLV). */
  settled_by?: string | null;
  /** When the bet was closed/settled (ISO) — for the closures-log timestamp. */
  settled_at?: string | null;
  /** JSON snapshot of the decision-time context (edge/kelly/probs/calibration/phase/
   *  score/thinness/exitPlan/…) for risk-profile analytics. Forward-only (not backfilled). */
  entry_meta?: string | null;
  /** System epoch string at entry — lets analytics segregate pre/post-fix eras. */
  code_version?: string | null;
  exit_code_version?: string | null; // п.2: system epoch at EXIT (settle) — cross_epoch iff ≠ code_version
  /** Stable id of the STRATEGY DECISION behind this bet (spec §0.1). The twin link:
   *  a real Polymarket order carries the same decision_id as its paper bet, so paper
   *  and real can be compared 1:1. Auto-generated at insert when absent. */
  decision_id?: string | null;
  /** Origin phase — 'prematch' | 'live' — the DECISION context (before/after kickoff), fixed at entry,
   *  never rewritten by the fill. Resolved once in insertBet; see betMeta.resolveBetOrigin. */
  origin?: string | null;
  /** Provenance of `origin`: 'decision' (stamped at entry) | 'meta_backfill' (lifted from entry_meta on
   *  an existing row) | 'inferred_backfill' (reconstructed from entered_minute — lower trust). */
  origin_source?: string | null;
  /** P0.1: this bet's match may have settled on ANOTHER leg's result (two-leg fixture-identity bug) —
   *  quarantined out of verdict cuts until the ESPN date backfill proves it clean. */
  settle_suspect?: number | null;
  /** P0.5: football strategy epoch tag (parallels tennis «пороги:…»); null/`epoch_unknown` excluded from cuts. */
  football_epoch?: string | null;
  /** Z2(b): set at settle when the recorded payout disagrees with the expected value for its settle kind
   *  (early/partial → stake·exit/entry; won → stake·100/entry; lost → 0) beyond a commission tolerance. */
  accounting_suspect?: number | null;
}

export interface Reassessment {
  id: string;
  match_id: string;
  strategy_id: string;
  minute: string | null;
  body: string;
  confidence: string | null;
  trigger: ReassessTrigger | null;
  created_at: string;
}

export interface TradeLogEntry {
  id: string;
  match_id: string;
  strategy_id: string;
  minute: string | null;
  type: "enter" | "exit" | "settle" | "skip" | "hold";
  text: string;
  created_at: string;
  dedup_key?: string | null; // Z3: when set, a duplicate (match_id, type, dedup_key) insert is ignored
}

export interface CalibrationBucket {
  bucket: string;
  predicted: number;
  actual: number;
}

export interface QualityMetrics {
  strategy_id: string;
  samples: number;
  brier: number | null;
  clv: number | null;
  calibration: CalibrationBucket[];
  updated_at: string;
}
