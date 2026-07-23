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
import { canonicalProfileId } from "./riskProfiles.js";

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
  exits: {
    take_profit_pct: number; // 0..N — deterministic safety-net take-profit (+X% of position value)
    hard_stop_pct: number;   // 0..1 — deterministic safety-net hard stop (−X%)
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
  exits: { take_profit_pct: 0.5, hard_stop_pct: 0.5 },
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
  "exits.take_profit_pct": { lo: 0, hi: 10, loExclusive: true },
  "exits.hard_stop_pct": { lo: 0, hi: 1, loExclusive: true },
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

  // kelly_fraction_clamp: validate the pair or default it. The scaled Kelly is
  // clamped to [lo, hi] (strategist §5), so the base MUST lie inside the clamp —
  // a base above hi is dead (capped even at reference calibration), below lo it's
  // floored up. Keep the two coherent.
  const kb = cfg.sizing.kelly_fraction_base;
  const clamp = get(r, "sizing.kelly_fraction_clamp");
  if (clamp == null) {
    // Clamp not given → derive a DEFAULT that contains the base, so «base» is
    // realizable (its ceiling of aggression) instead of being silently capped
    // by a default ceiling below it. Only widens; a small base keeps defaults.
    defaultsUsed.push("sizing.kelly_fraction_clamp");
    const [dlo, dhi] = cfg.sizing.kelly_fraction_clamp;
    cfg.sizing.kelly_fraction_clamp = [Math.min(dlo, kb), Math.max(dhi, kb)];
  }
  else if (!Array.isArray(clamp) || clamp.length !== 2 || !clamp.every((x) => typeof x === "number" && Number.isFinite(x))) {
    errors.push("sizing.kelly_fraction_clamp: нужен [lo, hi] из двух чисел");
  } else {
    const [lo, hi] = clamp as [number, number];
    if (lo <= 0 || hi > 1 || lo > hi) errors.push(`sizing.kelly_fraction_clamp: [${lo}, ${hi}] должно быть 0 < lo ≤ hi ≤ 1`);
    // Both base and clamp are user-set: an incoherent pair is a real error, not
    // something to silently fix — tell them which knob to move.
    else if (kb < lo || kb > hi) errors.push(`sizing.kelly_fraction_base: ${kb} вне kelly_fraction_clamp [${lo}, ${hi}] — база должна лежать внутри клэмпа (подними потолок клэмпа или опусти базу)`);
    else cfg.sizing.kelly_fraction_clamp = [lo, hi];
  }

  if (typeof r.config_version === "string" && r.config_version.trim()) cfg.config_version = r.config_version.trim();

  if (errors.length) return { ok: false, errors };
  cfg._defaults_used = defaultsUsed;
  return { ok: true, config: Object.freeze(cfg) };
}

// ============================================================
// Named risk profiles — three presets (risk_profiles.md). The mechanics are
// identical; only the numbers differ. MEDIUM is the reference used to TEST the
// strategists (same profile for all, so the result reflects the strategist, not
// the thresholds). AGGRESSIVE/CONSERVATIVE are baked in but tuned separately,
// later, on the winning strategist. min_market_liquidity + max_concurrent_
// positions are "human-set" in the doc — sensible Polymarket-scaled values here.
// ============================================================
export interface RiskProfileDef { id: string; name: string; sort: number; values: unknown }
export const RISK_PROFILE_DEFS: RiskProfileDef[] = [
  {
    id: "aggressive", name: "Агрессивный", sort: 0,
    values: {
      config_version: "aggressive-1.0",
      entry_thresholds: { min_edge: 0.03, min_edge_low_liquidity: 0.05, min_calibration: 0.40, min_market_liquidity: 500 },
      sizing: { kelly_fraction_base: 0.33, calibration_ref: 0.6, kelly_fraction_clamp: [0.05, 0.40], max_position_pct: 0.08, max_match_exposure_pct: 0.15 },
      bankroll_limits: { daily_loss_limit_pct: 0.20, max_concurrent_exposure_pct: 0.40, max_concurrent_positions: 12 },
      safeguards: { global_drawdown_killswitch_pct: 0.35, absurd_edge_block: 0.25, max_quote_age_seconds: 30, prob_sum_tolerance: 0.02 },
      exits: { take_profit_pct: 0.80, hard_stop_pct: 0.60 }, // hold for more, tolerate a wider drawdown
    },
  },
  {
    id: "medium", name: "Средний", sort: 1,
    values: {
      config_version: "medium-1.0",
      entry_thresholds: { min_edge: 0.05, min_edge_low_liquidity: 0.07, min_calibration: 0.45, min_market_liquidity: 1000 },
      sizing: { kelly_fraction_base: 0.20, calibration_ref: 0.6, kelly_fraction_clamp: [0.05, 0.33], max_position_pct: 0.05, max_match_exposure_pct: 0.10 },
      bankroll_limits: { daily_loss_limit_pct: 0.15, max_concurrent_exposure_pct: 0.30, max_concurrent_positions: 8 },
      safeguards: { global_drawdown_killswitch_pct: 0.30, absurd_edge_block: 0.25, max_quote_age_seconds: 30, prob_sum_tolerance: 0.02 },
      exits: { take_profit_pct: 0.50, hard_stop_pct: 0.50 },
    },
  },
  {
    id: "conservative", name: "Консервативный", sort: 2,
    values: {
      config_version: "conservative-1.0",
      entry_thresholds: { min_edge: 0.07, min_edge_low_liquidity: 0.10, min_calibration: 0.55, min_market_liquidity: 2000 },
      sizing: { kelly_fraction_base: 0.12, calibration_ref: 0.6, kelly_fraction_clamp: [0.04, 0.20], max_position_pct: 0.03, max_match_exposure_pct: 0.06 },
      bankroll_limits: { daily_loss_limit_pct: 0.10, max_concurrent_exposure_pct: 0.20, max_concurrent_positions: 5 },
      safeguards: { global_drawdown_killswitch_pct: 0.25, absurd_edge_block: 0.25, max_quote_age_seconds: 30, prob_sum_tolerance: 0.02 },
      exits: { take_profit_pct: 0.35, hard_stop_pct: 0.40 }, // lock gains sooner, cut losses sooner
    },
  },
];
/** The reference profile used to test strategists (doc: use MEDIUM for all). */
export const DEFAULT_PROFILE_ID = "medium";

/** Seed the three preset profiles if none exist yet. Idempotent; called on boot
 *  so a live prod DB gets them without a wipe. Each is validated before storing;
 *  a preset that somehow fails validation is skipped (never persist garbage). */
export function seedRiskProfiles(db: Database, now: string): void {
  if (R.listRiskProfiles(db).length > 0) return;
  for (const def of RISK_PROFILE_DEFS) {
    const loaded = loadRiskConfig(def.values);
    if (!loaded.ok || !loaded.config) continue;
    R.upsertRiskProfile(db, { id: def.id, name: def.name, content: JSON.stringify(loaded.config), sort: def.sort, created_at: now });
  }
}

/** One-time: add the `exits` group to the 3 PRESET profiles already seeded before
 *  exits existed (they'd otherwise load with the generic 0.5/0.5 default instead
 *  of their profile-specific take/stop). Idempotent (skips a profile that already
 *  has `exits`); preserves any user edits to the profile's other fields. */
export function migrateRiskProfileExits(db: Database): void {
  for (const def of RISK_PROFILE_DEFS) {
    const row = R.getRiskProfileRow(db, def.id);
    if (!row) continue;
    let cfg: any;
    try { cfg = JSON.parse(row.content); } catch { continue; }
    if (cfg && cfg.exits) continue; // already migrated
    const merged = { ...cfg, exits: (def.values as any).exits };
    const loaded = loadRiskConfig(merged);
    if (loaded.ok && loaded.config) R.upsertRiskProfile(db, { id: def.id, name: row.name, content: JSON.stringify(loaded.config), sort: row.sort, created_at: row.created_at });
  }
}

/** Owner decision 23.07.2026 (option b): rename the super-risky profile `rp-lite-mrca9dz8` → `max`, keeping
 *  its config (Kelly ×0.50, no calibration floor) AS-IS — that is now design. Idempotent, marker-guarded.
 *  Historical BETS are NOT rewritten (readers alias `rp-lite*`→`max`); only the ACTIVE allocation moves: the
 *  risk_profiles row is renamed and strategy_shares are repointed, so NEW bets place under `max`. */
const RENAME_MAX_MARK = "rename_rplite_to_max_v1";
export function migrateRenameRpLiteToMax(db: Database, now: string): void {
  if (R.metaGet(db, RENAME_MAX_MARK)) return;
  const legacy = R.listRiskProfiles(db).filter((r) => /^rp-lite/i.test(r.id));
  const maxExists = !!R.getRiskProfileRow(db, "max");
  for (const r of legacy) {
    // Create `max` from the legacy config verbatim (super-risky by owner decision — Kelly ×0.50, no
    // calibration floor — намеренно), unless it already exists; then repoint active shares + drop the old row.
    if (!maxExists && !R.getRiskProfileRow(db, "max")) {
      R.upsertRiskProfile(db, { id: "max", name: "max", content: r.content, sort: r.sort, created_at: r.created_at });
    }
    try { db.prepare(`UPDATE strategy_shares SET risk_profile_id='max' WHERE risk_profile_id=?`).run(r.id); }
    catch { /* a (comp,strat,'max') already exists → PK clash; the max share is already there, drop the legacy one */
      db.prepare(`DELETE FROM strategy_shares WHERE risk_profile_id=?`).run(r.id); }
    R.deleteRiskProfile(db, r.id);
    console.log(`[migrate] risk profile «${r.id}» → «max» (супер-рисковый профиль по решению владельца 23.07.2026)`);
  }
  R.metaSet(db, RENAME_MAX_MARK, now, now);
}

/** A named profile's validated config, or defaults if missing/corrupt. Aliases a legacy `rp-lite*` id to
 *  `max` so a lingering old-id reference (an open bet placed pre-rename) still resolves to its real config. */
export function getProfileConfig(db: Database, id: string): RiskConfig {
  const row = R.getRiskProfileRow(db, id) ?? R.getRiskProfileRow(db, canonicalProfileId(id));
  if (!row) return DEFAULT_RISK_CONFIG;
  try {
    const loaded = loadRiskConfig(JSON.parse(row.content));
    return loaded.ok && loaded.config ? loaded.config : DEFAULT_RISK_CONFIG;
  } catch { return DEFAULT_RISK_CONFIG; }
}

export interface RiskProfileView { id: string; name: string; sort: number; config: RiskConfig }
/** All profiles for the UI, each parsed to its validated config. */
export function listRiskProfileViews(db: Database): RiskProfileView[] {
  return R.listRiskProfiles(db).map((r) => {
    let config = DEFAULT_RISK_CONFIG;
    try { const l = loadRiskConfig(JSON.parse(r.content)); if (l.ok && l.config) config = l.config; } catch { /* fall back */ }
    return { id: r.id, name: r.name, sort: r.sort, config };
  });
}

/**
 * The effective risk config every layer reads (read-only) — the MEDIUM reference
 * profile while strategists are being tested. Falls back to frozen defaults.
 */
export function getRiskConfig(db: Database): RiskConfig {
  return getProfileConfig(db, DEFAULT_PROFILE_ID);
}

// ============================================================
// «Вытащить и захардкодить» for a risk profile — extract the numeric constants
// from a human's free text (the risk_config_prompt values) into a raw config,
// then loadRiskConfig VALIDATES it. Dependency-free regex over the known field
// names (robust to "field: 0.05" / "field = 0.05" / "field 0.05" formats).
// ============================================================
// Each field lists the labels «вытащить» should recognise — the raw snake_case
// key PLUS the human/RU labels the UI shows (Kelly base, max позиция, take-profit…)
// and common Russian phrasings — so a profile described the way the cards read
// parses, not only strict keys. Ordered so a prefix/longer name is claimed first
// (min_edge_low_liquidity before min_edge). Aliases are regex fragments.
const RISK_FIELDS: { path: string; aliases: string[] }[] = [
  { path: "entry_thresholds.min_edge_low_liquidity", aliases: ["min_edge_low_liquidity", "min[\\s_]*edge[\\s_]*low", "край.{0,14}тонк\\w*ликвид", "тонк\\w*\\s*ликвид\\w*"] },
  { path: "entry_thresholds.min_edge", aliases: ["min_edge", "min\\s*edge", "мин\\.?\\s*кра[йея]"] },
  { path: "entry_thresholds.min_calibration", aliases: ["min_calibration", "min\\s*calibration", "мин\\.?\\s*калибров\\w*", "калибровк\\w*"] },
  { path: "entry_thresholds.min_market_liquidity", aliases: ["min_market_liquidity", "мин\\.?\\s*ликвидн\\w*"] },
  { path: "sizing.kelly_fraction_base", aliases: ["kelly_fraction_base", "kelly\\s*base", "доля\\s*kelly", "база\\s*kelly", "kelly", "келли"] },
  { path: "sizing.calibration_ref", aliases: ["calibration_ref"] },
  { path: "sizing.max_position_pct", aliases: ["max_position_pct", "max\\s*position", "max\\s*позиц\\w*", "макс\\.?\\s*позиц\\w*"] },
  { path: "sizing.max_match_exposure_pct", aliases: ["max_match_exposure_pct", "max\\s*match", "max\\s*на\\s*матч", "макс\\.?\\s*на\\s*матч"] },
  { path: "bankroll_limits.daily_loss_limit_pct", aliases: ["daily_loss_limit_pct", "дневн\\w*\\s*лимит\\w*", "дневн\\w*\\s*убыт\\w*"] },
  { path: "bankroll_limits.max_concurrent_exposure_pct", aliases: ["max_concurrent_exposure_pct"] },
  { path: "bankroll_limits.max_concurrent_positions", aliases: ["max_concurrent_positions"] },
  { path: "safeguards.global_drawdown_killswitch_pct", aliases: ["global_drawdown_killswitch_pct", "killswitch", "килл[\\s-]*свитч"] },
  { path: "safeguards.absurd_edge_block", aliases: ["absurd_edge_block", "absurd\\s*edge", "абсурд\\w*\\s*край", "абсурд\\w*"] },
  { path: "safeguards.max_quote_age_seconds", aliases: ["max_quote_age_seconds", "возраст\\s*котир\\w*"] },
  { path: "safeguards.prob_sum_tolerance", aliases: ["prob_sum_tolerance", "prob\\s*sum"] },
  { path: "exits.take_profit_pct", aliases: ["take_profit_pct", "take[\\s-]*profit", "тейк[\\s-]*профит", "тейк[\\s-]*проф\\w*"] },
  { path: "exits.hard_stop_pct", aliases: ["hard_stop_pct", "hard[\\s-]*stop", "хард[\\s-]*стоп", "стоп[\\s-]*лосс", "жёстк\\w*\\s*стоп"] },
];
/** Extract a raw risk config from free text (validated separately by loadRiskConfig). */
export function parseRiskConfigHeuristic(text: string): Record<string, unknown> {
  const raw: any = {};
  const claimed: Array<[number, number]> = []; // char spans already consumed by a longer field name
  const clampM = text.match(/kelly_fraction_clamp\s*[:=]?\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/i);
  if (clampM) set(raw, "sizing.kelly_fraction_clamp", [parseFloat(clampM[1]), parseFloat(clampM[2])]);
  for (const { path, aliases } of RISK_FIELDS) {
    // alias  [: =]  number  [%] — a trailing «%» flags a percent value. `\w` in JS
    // is ASCII-only, so widen it to also cover Cyrillic word chars — otherwise a
    // stem like «позиц\w*» stops before «…ия» and the whole alias fails to match.
    const aliasSrc = aliases.join("|").replace(/\\w/g, "[a-zа-яё0-9_]");
    const re = new RegExp("(?:" + aliasSrc + ")\\s*[:=]?\\s*(-?\\d+(?:\\.\\d+)?)\\s*(%?)", "i");
    const m = re.exec(text);
    if (!m || m.index == null) continue;
    // skip a match that sits inside an already-claimed longer field (min_edge vs
    // min_edge_low_liquidity): the longer name is listed first and claims its span.
    if (claimed.some(([s, e]) => m.index >= s && m.index < e)) continue;
    claimed.push([m.index, m.index + m[0].length]);
    // «12%» → 0.12: a percent-written value is a fraction, so a number the user
    // typed with «%» must be divided by 100 before validation (2% is 0.02, not 2).
    const val = m[2] === "%" ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    set(raw, path, val);
  }
  return raw;
}
/** Parse free text → validated config (or errors), for the profile «вытащить» button.
 *  A pasted JSON config (exported/AI-generated) is validated as-is; otherwise the
 *  free-text heuristic pulls values from human/RU labels. JSON first, because the
 *  heuristic can't read `"min_edge": 0.02` (the quote before the colon breaks the
 *  label→number regex, so every field would silently fall to its default). */
export function parseRiskProfile(text: string): RiskConfigLoad {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let obj: unknown;
    try { obj = JSON.parse(trimmed); }
    catch { return { ok: false, errors: ["похоже на JSON, но он не парсится — проверь синтаксис (запятые, кавычки, скобки)"] }; }
    return loadRiskConfig(obj);
  }
  return loadRiskConfig(parseRiskConfigHeuristic(text));
}
