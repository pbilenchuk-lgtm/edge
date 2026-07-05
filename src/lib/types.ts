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
  | "settled_lost";
export type ReassessTrigger =
  | "goal"
  | "red_card"
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
  /** portfolio stop-loss, negative fraction (from «стоп -25%») */
  stop?: number;
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
  prompt: string;
  params: StrategyParams;
  model: string | null;
  created_at: string;
}

export interface StrategyShare {
  competition_id: string;
  strategy_id: string;
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
  external_ref: string | null;
  snapshot_at: string;
  is_closing: boolean;
}

export interface Bet {
  id: string;
  match_id: string;
  strategy_id: string;
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
  type: "enter" | "exit" | "settle";
  text: string;
  created_at: string;
}

export interface CalibrationBucket {
  bucket: string;
  predicted: number;
  actual: number;
}

/** Performance of a strategy split by entry phase. Post-event is folded into
 *  live — only pre-match vs in-match remain. */
export interface PhaseMetric {
  id: "pre" | "live";
  label: string;
  bets: number;
  wins: number;
  pnl: number;
  clv: number | null; // mean CLV in cents for bets with a closing price
}

/** Value of active management: realized P&L of managed (early/partial) exits
 *  vs what the same slices would have returned held to settlement. */
export interface MgmtMetric {
  actualPnl: number;
  heldToEndPnl: number;
  managed: number; // count of managed positions comparable to a held-to-end outcome
}

export interface QualityMetrics {
  strategy_id: string;
  samples: number;
  brier: number | null;
  clv: number | null;
  calibration: CalibrationBucket[];
  phases: PhaseMetric[];
  mgmt: MgmtMetric | null;
  equity: number[]; // cumulative realized P&L per settled match (starts at 0)
  updated_at: string;
}
