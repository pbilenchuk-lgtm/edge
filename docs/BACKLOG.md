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

## Strategist LLM reliability — the 4-rung stack (DONE) — do NOT collapse a rung

The live strategist is now a SAFETY precondition (price-stops were removed from melting
options — only the strategist / deterministic time_stop protect them from riding to zero),
and tennis shares the same `strategistDecide` call on SHORT break windows. A parse failure
at the wrong moment = a missed buyback. Four independent rungs, each covering a different
failure class — removing one re-opens the "невалидный JSON от стратега" skip that reproduced twice:

1. **NETWORK retry** (`callLLM`, llm.ts) — a dropped socket / 5xx / 429 / 529 re-sends the
   SAME request with backoff. A transient hiccup must not sink a whole live cycle.
2. **JSON repair** (`parseJsonLoose`→`repairJson`, llm.ts) — salvages the routine LLM
   malformations IN PLACE (trailing commas, bare control chars, truncation, stray brackets).
   Never applied to a reply that already parsed — a valid response is never altered.
3. **CONTENT re-ask** (`callLLMParsed`, llm.ts) — when a reply is UNsalvageable (prose /
   refusal / wrong shape), re-ask ONCE with a JSON-only nudge before declaring failure.
   `parse` throwing is the re-ask signal, so a structurally-wrong-but-valid-JSON reply
   (missing xg core, etc.) also triggers it. NOT re-asked on a provider/network failure
   (rung 1's job). This rung is what keeps a one-off parse hiccup from falsely tripping rung 4.
4. **DEGRADED-mode** (`strategistDegraded` + exit-net price-stop restoration, lifecycle.ts) —
   when the strategist is in an ACTIVE outage (last outcome failed, recent), RESTORE the
   deterministic price stop to the melting-option positions the strategist was trusted to
   manage. The insurance auto-returns exactly when the layer recovers.

## Sportmonks negative-cache (coverage) — DONE (see providerCoverage.ts)

`fixture not resolved` on Allsvenskan is a **provider-coverage** fact (Sportmonks
doesn't map swe.1), not a per-match one. Cache is two-level: per-fixture + per
(provider, league) coverage map that persists across matches. After N `not_resolved`
failures the provider drops to a SLOW retry (not permanent silence — mappings can
appear at kickoff/HT). A **timeout** is a transient network failure and is NOT
cached (distinct from `not_resolved`). Confirmed-coverage leagues never hard-disable
on transient errors.
