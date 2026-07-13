# EDGE LAB — backlog & durable decisions

Short, load-bearing decisions that must NOT be re-litigated or "helpfully" undone.

## ⛔ Duplicate-looking Polymarket markets — DO NOT collapse/dedup

A bare `Draw` and `Draw (Spain vs. Belgium)` (or `— Yes`/`— No` twins) are **two
different Polymarket contracts** — different tokens, different **resolution
conditions** — NOT one outcome listed twice.

**Evidence (Spain–Belgium, live 1:1):** one Draw sat at 100¢ (reacts to "a draw on
the scoreboard NOW" — HT / current state), the other at 31.6¢ (draw AT 90'). One
outcome can't cost 100 and 31.6 at once ⇒ the outcomes differ. Same shape recurs
(Djurgården–Halmstad: 28.5¢ vs 13.5¢).

**Merging them creates a bug** (trade one contract at the other's price). The
current guard is correct: `duplicateOutcomeConflicts` (src/lib/analysis.ts)
FLAGS+BLOCKS on a ≥8¢ divergence and never merges. It holds the money.

**Real fix (backlog, no rush — guard covers it):**
1. **Provenance first** — token-check whether the bare `Draw` even belongs to THIS
   match or was dragged in by the importer from another event. **Step 1 is research
   (inspect the two tokens' resolution conditions on Polymarket), not code.**
2. If it belongs → **split the semantics**: each token gets its own resolution
   condition + its own `ai_prob`. Do NOT dedup.
3. Same class covers "broken labels" (`Team — Yes` = 100¢): a token with an unclear
   resolution condition, resolved by the same provenance pass.

## Sportmonks negative-cache (coverage) — DONE (see providerCoverage.ts)

`fixture not resolved` on Allsvenskan is a **provider-coverage** fact (Sportmonks
doesn't map swe.1), not a per-match one. Cache is two-level: per-fixture + per
(provider, league) coverage map that persists across matches. After N `not_resolved`
failures the provider drops to a SLOW retry (not permanent silence — mappings can
appear at kickoff/HT). A **timeout** is a transient network failure and is NOT
cached (distinct from `not_resolved`). Confirmed-coverage leagues never hard-disable
on transient errors.
