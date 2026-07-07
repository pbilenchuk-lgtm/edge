// ============================================================
// EDGE LAB — RISK CONFIG (Окно 4)  [SERVER-ONLY]
//
// Human-set risk constants — thresholds, sizing, bankroll limits, safeguards —
// that BOTH strategists (prematch + live) read as immutable constants. No LLM
// invents or changes these per match; they are stable, changed only here.
//
// This module is the deterministic LOADER (orchestration doc, module #2): it
// takes a raw config (typed by a human, or structured by the risk-config LLM
// window from human values) and VALIDATES it — every field must be inside a
// sane range. Out-of-range → REJECT with an error, never silently "fix". Unset
// fields fall back to the documented default and are listed in `_defaults_used`.
// The result is frozen; every downstream layer reads it read-only.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

export interface RiskConfig {
  config_version: string;
  entry_thresholds: {
    min_edge: number;               // 0..1 — our prob − vig-cleaned market implied
    min_edge_low_liquidity: number; // 0..1 — raised bar for thin markets
    min_calibration: number;        // 0..1 — min analysis xg_confidence to enter
    min_market_liquidity: number;   // ≥0 — platform units (Polymarket $ depth)
  };
  sizing: {
    kelly_fraction_base: number;         // 0..1 — base Kelly fraction (1/5 = 0.20)
    calibration_ref: number;             // (0..1] — reference confidence for scaling
    kelly_fraction_clamp: [number, number]; // [lo, hi] the scaled fraction is clamped to
    max_position_pct: number;            // 0..1 — hard ceiling on ONE position (% bank)
    max_match_exposure_pct: number;      // 0..1 — correlation cap across one match
  };
  bankroll_limits: {
    daily_loss_limit_pct: number;        // 0..1 — daily drawdown stop
    max_concurrent_exposure_pct: number; // 0..1 — max bank in play at once (all matches)
    max_concurrent_positions: number;    // ≥1 integer — max simultaneous open positions
  };
  safeguards: {
    global_drawdown_killswitch_pct: number; // 0..1 — absolute drawdown → halt new entries
    absurd_edge_block: number;              // 0..1 — edge above this = almost surely a bug
    max_quote_age_seconds: number;          // >0 — stale quote → don't trade the market
    prob_sum_tolerance: number;             // 0..1 — group prob-sum drift tolerance vs 1
  };
  _defaults_used: string[];
}

// Canonical defaults (orchestration doc / risk_config prompt). min_market_liquidity
// and max_concurrent_positions are "human-set" — we ship a conservative default
// and flag them so the человек knows they were never explicitly chosen.
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  config_version: "1.0",
  entry_thresholds: { min_edge: 0.04, min_edge_low_liquidity: 0.07, min_calibration: 0.45, min_market_liquidity: 1000 },
  sizing: { kelly_fraction_base: 0.20, calibration_ref: 0.6, kelly_fraction_clamp: [0.05, 0.33], max_position_pct: 0.05, max_match_exposure_pct: 0.10 },
  bankroll_limits: { daily_loss_limit_pct: 0.15, max_concurrent_exposure_pct: 0.30, max_concurrent_positions: 8 },
  safeguards: { global_drawdown_killswitch_pct: 0.30, absurd_edge_block: 0.25, max_quote_age_seconds: 30, prob_sum_tolerance: 0.02 },
  _defaults_used: [],
};

export interface RiskConfigLoad {
  ok: boolean;
  config?: RiskConfig;   // frozen, present only when ok
  errors?: string[];     // present when !ok — every out-of-range field, with the reason
}

// A field spec: dotted path, the default, and the accepted range [lo, hi]
// (inclusive), plus whether it must be an integer or strictly-positive.
type Range = { lo: number; hi: number; loExclusive?: boolean; int?: boolean };
const FIELD_RANGES: Record<string, Range> = {
  "entry_thresholds.min_edge": { lo: 0, hi: 1 },
  "entry_thresholds.min_edge_low_liquidity": { lo: 0, hi: 1 },
  "entry_thresholds.min_calibration": { lo: 0, hi: 1 },
  "entry_thresholds.min_market_liquidity": { lo: 0, hi: Number.MAX_SAFE_INTEGER },
  "sizing.kelly_fraction_base": { lo: 0, hi: 1, loExclusive: true },
  "sizing.calibration_ref": { lo: 0, hi: 1, loExclusive: true },
  "sizing.max_position_pct": { lo: 0, hi: 1, loExclusive: true },
  "sizing.max_match_exposure_pct": { lo: 0, hi: 1, loExclusive: true },
  "bankroll_limits.daily_loss_limit_pct": { lo: 0, hi: 1 },
  "bankroll_limits.max_concurrent_exposure_pct": { lo: 0, hi: 1, loExclusive: true },
  "bankroll_limits.max_concurrent_positions": { lo: 1, hi: 1000, int: true },
  "safeguards.global_drawdown_killswitch_pct": { lo: 0, hi: 1, loExclusive: true },
  "safeguards.absurd_edge_block": { lo: 0, hi: 1, loExclusive: true },
  "safeguards.max_quote_age_seconds": { lo: 0, hi: 86400, loExclusive: true },
  "safeguards.prob_sum_tolerance": { lo: 0, hi: 1 },
};

function get(o: any, path: string): unknown {
  return path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);
}
function set(o: any, path: string, val: unknown): void {
  const ks = path.split(".");
  let cur = o;
  for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] ??= {};
  cur[ks[ks.length - 1]] = val;
}

/**
 * Validate a raw config into a frozen RiskConfig, or reject with errors.
 * - Provided fields must be finite numbers inside their range → else an error.
 * - Absent fields take the documented default and are recorded in `_defaults_used`.
 * - kelly_fraction_clamp is validated as a [lo, hi] pair with 0 < lo ≤ hi ≤ 1.
 * Never silently repairs an out-of-range value (orchestration doc, module #2).
 */
export function loadRiskConfig(raw: unknown): RiskConfigLoad {
  const errors: string[] = [];
  const defaultsUsed: string[] = [];
  // deep-clone the defaults so we never mutate the shared constant
  const cfg: RiskConfig = JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIG));
  const r = (raw ?? {}) as any;

  for (const [path, range] of Object.entries(FIELD_RANGES)) {
    const v = get(r, path);
    if (v == null) { defaultsUsed.push(path); continue; }
    if (typeof v !== "number" || !Number.isFinite(v)) { errors.push(`${path}: не число (${JSON.stringify(v)})`); continue; }
    if (range.int && !Number.isInteger(v)) { errors.push(`${path}: должно быть целым (${v})`); continue; }
    const belowLo = range.loExclusive ? v <= range.lo : v < range.lo;
    if (belowLo || v > range.hi) { errors.push(`${path}: ${v} вне диапазона [${range.loExclusive ? ">" : ""}${range.lo}, ${range.hi}]`); continue; }
    set(cfg, path, v);
  }

  // kelly_fraction_clamp: validate the pair or default it.
  const clamp = get(r, "sizing.kelly_fraction_clamp");
  if (clamp == null) { defaultsUsed.push("sizing.kelly_fraction_clamp"); }
  else if (!Array.isArray(clamp) || clamp.length !== 2 || !clamp.every((x) => typeof x === "number" && Number.isFinite(x))) {
    errors.push("sizing.kelly_fraction_clamp: нужен [lo, hi] из двух чисел");
  } else {
    const [lo, hi] = clamp as [number, number];
    if (lo <= 0 || hi > 1 || lo > hi) errors.push(`sizing.kelly_fraction_clamp: [${lo}, ${hi}] должно быть 0 < lo ≤ hi ≤ 1`);
    else cfg.sizing.kelly_fraction_clamp = [lo, hi];
  }

  if (typeof r.config_version === "string" && r.config_version.trim()) cfg.config_version = r.config_version.trim();

  if (errors.length) return { ok: false, errors };
  cfg._defaults_used = defaultsUsed;
  return { ok: true, config: Object.freeze(cfg) };
}

/**
 * The effective risk config every layer reads (read-only). Loads the stored raw
 * config through the validator; if nothing is stored, or a stored blob somehow
 * fails validation (shouldn't — we only persist validated ones), falls back to
 * the frozen defaults so the system always has a coherent config to size against.
 */
export function getRiskConfig(db: Database): RiskConfig {
  const raw = R.getRiskConfigRaw(db);
  if (!raw) return DEFAULT_RISK_CONFIG;
  try {
    const loaded = loadRiskConfig(JSON.parse(raw));
    return loaded.ok && loaded.config ? loaded.config : DEFAULT_RISK_CONFIG;
  } catch { return DEFAULT_RISK_CONFIG; }
}
