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

## Tennis buyback exits — structure built on INTERIM numbers; calibrate ONLY from §4/B (DONE)

tennisExitTick executes a fixed-priority exit ladder (§9.6 — all triggers CODE, no LLM):
retirement/final (settle) → thesis_stop (2nd fav break) → catastrophic_floor → game_count_stop
→ take_price. Defensive exits outrank profit-taking on a simultaneous hit.

The interim thresholds — **K=3** receiving games, **floor = entry−15¢**, **take buffer 3¢** — are
env-tunable and tagged `armed_epoch:"interim"` on every bet's exitPlan. **Do NOT hand-tune them from
the first paper bets** — that overfits noise. The ONLY source for the calibrated values is the
Part B recovery-split report (`/api/tennis-scout?report=calibration`): floor ← no-recovery p90 slide,
K ← recovery-time p75 (~2min/receiving game), take buffer ← recovered floor-gap; armed entry prices
← §4 panic distribution. When it swaps in, bump `TENNIS_ARMED_EPOCH` to `calibrated` so exits stay
segmentable by which era's numbers fired. Structure is complete NOW; the numbers land last.

**catastrophic_floor phantom guard:** tennis has a midpoint, not a raw executable bid, so the
Örgryte "don't stop on a phantom print" lesson is enforced by PERSISTENCE — the collapse must show
on TWO consecutive priced snapshots (cur AND prev ≤ floor). A single artifact print never dumps.

**One buyback per match (A3):** never stack a second buyback on a match with an open one (any
profile). Structurally kills the "докупка в падающую" between trigger #1 (early break) and #2 (lost
set) — #1 exits by the game-count stop before #2 arms, and if #1 is still alive, #2 doesn't open.

## Tennis retirement provenance — VERIFIED from Polymarket, mandatory pre-first-bet (DONE)

Read the actual Polymarket H2H resolution text (gamma-api, tag 864). The clause is
IDENTICAL across ATP / WTA / ITF singles AND doubles (verbatim, 2026-07):

> "resolve to 'X' if X advances against Y … If the match begins but is not completed,
> and one player advances due to the opponent's **retirement, default, or disqualification**,
> this market will resolve to the **player who advances**. If the match ends in a **walkover**
> (player withdraws **before the start**), this market will resolve to **50-50**. If the match
> is **canceled** (not played at all), ends in a **tie**, or is **delayed beyond 7 days**
> without a winner, this market will resolve to **50-50**."
> Primary source: official tour info (ATP/WTA); a consensus of credible reporting may also be used.

**Two resolution families — do NOT merge them:**
- **Advancer wins** (a real YES/NO): normal win, mid-match **retirement / default / disqualification**.
- **Void / 50-50** (refund, excluded from accuracy): **walkover** (pre-start withdrawal), canceled,
  tie, delayed-no-winner.

The subtlety that bites: a **walkover names a "winner" too**, but it's VOID, not a win —
because the withdrawal was BEFORE the first ball. Retirement (mid-match) is a win for the advancer.

**Code (settlement.ts resolveTennisWinner + tennisTrading.ts tennisFinalResult) matches this:**
`canceled = /cancel|abandon|walkover|w\/o/` → void; `retired = /retir|ret|default|disqualif|dsq/`
→ advancer wins. We only enter LIVE (post-break), so a pre-start walkover can't be an open
entry anyway — but settle handles it correctly if one exists. Tests lock both families.

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
