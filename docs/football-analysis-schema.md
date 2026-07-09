# Football analysis schema — what the analyst fills

Canonical reference for the JSON the football analyst produces and the engine
consumes. Two layers, kept separate (see `llm.ts`):

- **Layer 1 — base** (`assessFootballStructured`): pure match fundamentals, no
  quotes. Fills a full `FootballAnalysis` object.
- **Layer 2 — category modifier** (`assessCategoryModifier`): only DELTAS specific
  to a category (e.g. World Cup). Fills a `CategoryDelta` object.

The engine (`poisson.ts` + `assembler.ts`) derives EVERY market from the core —
the analyst never fills the `derived` block and never sees prices.

> **Enforced vs methodology.** The *shape* below is enforced by the parser in
> `llm.ts` — anything off-schema is dropped. The *methodology* (how to reason,
> when to emit an override, the scenario checklist) lives in the editable prompt
> body seeded from `seed.ts` and is what a user edits in the UI. If you changed
> the prompt in the app, the shape here still holds; only the guidance changed.

---

## Layer 1 — `FootballAnalysis` (the base analyst fills this)

```jsonc
{
  "match_type": "group" | "knockout" | "uncertain",   // by CONTINUATION markets, not by the presence of a Draw
  "match_type_reason": "str",                          // strictly in terms of which continuation markets exist/don't

  "core": {                    // the ONLY numbers that matter — Poisson unfolds the rest
    "xg_home": 0.1..5.0,       // clamped to [0.1, 5] by the engine
    "xg_away": 0.1..5.0,       // clamped to [0.1, 5]
    "home_share_1h": 0..1,     // fraction of home xG in the 1st half (~0.44); clamped to [0.1, 0.9]; default 0.44
    "away_share_1h": 0..1,     // clamped to [0.1, 0.9]; default 0.44
    "poisson_correction": -0.1..0.1  // Dixon–Coles ρ. 0 = pure Poisson; >0 adds draw mass. CLAMPED to [-0.1, 0.1]
  },

  "overrides": [               // optional; nudge ONE derived market by `adjust` prob-points. EMPTY unless real tactical knowledge
    { "target": "totals_match.2.5.over", "adjust": -0.04, "reason": "str — REQUIRED, no reason → dropped" }
  ],

  "drivers": [                 // qualitative factors (shown to the strategist)
    { "factor": "str", "direction": "str", "magnitude": "small"|"medium"|"large", "confidence": 0..1 }
  ],

  "scenarios": [               // MIN 5 — the live-management tree. A node with neither shifts NOR note is DROPPED by the assembler
    { "trigger": "str", "prob": 0..1,
      "shifts": { "outcome_90": {"home":0..1,"draw":0..1,"away":0..1},
                  "xg_remaining_home": 0.0, "xg_remaining_away": 0.0, "note": "str" } }
  ],

  "calibration": {
    "xg_confidence": 0..1,        // drives the analysis confidence band + the strategist's min_calibration gate
    "scenario_confidence": 0..1,
    "sample_size": 0,             // int ≥ 0
    "notes": "str"                // say here if lineups are NOT confirmed (keep confidence lower)
  },

  "unknowns": ["str"]             // must COLLAPSE once real lineups are in (no "who starts?" after the XI is known)
  // "derived": DO NOT FILL — the engine computes the whole market book.
}
```

### What the engine does with each field
| Field | Consumed by | Effect |
|---|---|---|
| `core.xg_home/xg_away` | `derivePoissonMarkets` | λ of each side's Poisson → the whole score matrix |
| `core.home_share_1h/away_share_1h` | `derivePoissonMarkets` | splits xG into 1H/2H → half totals, 2H BTTS |
| `core.poisson_correction` | `dcTau` | Dixon–Coles draw correction (clamped ±0.1) |
| `overrides[]` | `applyOverrides` | ± prob-points on one target; `.under`/`.no` flips sign; 1X2 renormalised |
| `drivers[]` | strategist context | shown as qualitative factors, no math |
| `scenarios[]` | strategist context + `usefulScenario` filter | live-management tree; dropped if no shifts and no note |
| `calibration.xg_confidence` | confidence band + `min_calibration` entry gate | high → "высокая", low → "низкая" |
| `unknowns[]` | assessment body | surfaced, no math |

---

## Layer 2 — `CategoryDelta` (the category specialist fills this)

Only deltas; it never recomputes the match and is the **sole** owner of
tournament-context narrative (reputation, stage, knockout-underdog discipline).

```jsonc
{
  "core_adjustments": [   // op applied to ONE core field, in order
    { "target": "xg_home"|"xg_away"|"home_share_1h"|"away_share_1h"|"poisson_correction",
      "op": "multiply"|"add", "value": 0.0, "reason": "str — REQUIRED" }
  ],
  "new_drivers":   [ { "factor": "str", "direction": "str", "magnitude": "small"|"medium"|"large", "confidence": 0..1, "reason": "str" } ],
  "new_scenarios": [ { "trigger": "str", "prob": 0..1, "shifts": { /* same shape as Layer 1 */ }, "reason": "str" } ],
  "override_adjustments": [ { "target": "totals_match.2.5.over", "adjust": 0.0, "reason": "str" } ],
  "confidence_adjustments": { "xg_confidence_delta": 0.0, "scenario_confidence_delta": 0.0, "reason": "str" },
  "notes": "str"
}
```

The assembler folds Layer 2 in: `core_adjustments` (multiply/add, then re-clamp)
→ re-derive markets → concatenate `override_adjustments` with base overrides →
add `confidence_*_delta` (clamped 0..1) → merge drivers/scenarios.

---

## Valid `target` namespace (overrides & the `.over/.under/.yes/.no` suffix)

Derived groups an override may point at (`DerivedMarkets` in `poisson.ts`). Path
is at most two levels: a scalar leaf (`btts`) or `group.key` (`totals_match.2.5`).

| Group | Keys | Notes |
|---|---|---|
| `outcome_90` | `home` / `draw` / `away` | 1X2 in 90'; triple renormalised after a nudge |
| `advance` | `home` / `away` | knockout only |
| `extra_time_prob` | scalar | ≈ P(draw in 90) for knockouts |
| `totals_match` | `1.5` `2.5` `3.5` … | `.over`/`.under` suffix; `adjust` refers to OVER |
| `totals_home` / `totals_away` | per line | team totals |
| `totals_1h` / `totals_2h` | per line | half totals |
| `btts` / `btts_2h` | scalar | `.yes`/`.no` suffix |
| `handicap` | `home_-1.5` etc. | `home_-1.5` = P(home wins by ≥2) |

`core_adjustments` (Layer 2 only) accept exactly the 5 core fields:
`xg_home, xg_away, home_share_1h, away_share_1h, poisson_correction`.

---

## Derived-only: `outcome_scenarios` + `match_shape` (engine, not analyst)

The engine also emits an outcome tree in `derived` — the analyst never fills it.
Built from the FINAL score matrix (post-category core adjustments), it partitions
every final score into **6 MECE branches over (winner × BTTS)** whose weights sum
to 1. No priority order: each score maps to exactly one branch by who won and
whether both teams scored.

| id | winner_side | btts | meaning / example scores |
|---|---|---|---|
| `fav_clean` | fav | no | favourite wins, dog blank (1:0, 2:0, 3:0) |
| `fav_concedes` | fav | yes | favourite wins but concedes (2:1, 3:1, 3:2) |
| `draw_0_0` | draw | no | 0:0 |
| `draw_scoring` | draw | yes | scoring draw (1:1, 2:2, 3:3) |
| `dog_clean` | dog | no | underdog wins, fav blank (0:1, 0:2) |
| `dog_concedes` | dog | yes | underdog wins but concedes (1:2, 2:3) |

Because the split is homogeneous on winner and BTTS, three markets fall out of the
tree **cleanly** (asserted to match the independent Poisson within 1e-6, else throw):
- **BTTS Yes** = `fav_concedes + draw_scoring + dog_concedes` = `derived.btts`.
- **P(draw 90) / Extra Time** = `draw_0_0 + draw_scoring` = `derived.extra_time_prob`
  (in a knockout both draw branches carry `leads_to_extra_time: true`).
- **Winner/advance sides** = sum branches by `winner_side` (fav / draw / dog).

Each branch also carries `favorite`, a `score_cluster` (heaviest scores), and
`bets_that_live` (market shorthands that win inside it, derived from winner_side +
btts). The two `*_concedes` branches add `total_note` — their TOTAL is not
homogeneous (2:1 vs 3:2), so the note gives the within-branch Over-2.5/Over-3.5
split for a consumer sitting on a borderline total. `match_shape` (`A` class
favourite / `B` open / `C` tight-even / `mixed`) is derived from the branch
weights — a deterministic replacement for asking the LLM to "type" the match.

Pre-match Value reads this to build anchor+satellite portfolios and to see which
branches kill two legs at once. Clustering + shape thresholds live in named
constants in `poisson.ts` for calibration. **Split rule** (guard against sprawl):
split a branch only if the new edge opens a tradeable market not already in the
tree or flips a bet's sign — these 6 already cover advance, BTTS, totals, Extra
Time and handicaps, so finer splits add weight-estimation noise, not signal.

---

## Consistency check (this file vs code)

Verified coherent across the three coupled sites: the enforced schema string in
`assessFootballStructured` (llm.ts), the parser + `FootballAnalysis` type
(llm.ts), and the consumer (`poisson.ts` / `assembler.ts`). The Layer-1/Layer-2
narrative separation is enforced in the two system prompts. Every field the
analyst is asked to fill is consumed; nothing is dead.

One improvement applied at the time of writing: the base prompt now states the
`poisson_correction` effective range (±0.1) so the analyst calibrates within what
the engine keeps, instead of emitting a large ρ that is silently clamped.
