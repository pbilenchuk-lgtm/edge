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

## Tennis PMV — phantom value from its OWN MATH; flag-only + recalibration + uniformity guard (DONE)

PMV was built WITHOUT an LLM specifically to exclude phantom value — and on its first day produced
phantom value anyway, from its own model, with the SAME signature we caught the LLM making: a uniform,
one-sided, fat edge (theo systematically above mid on Total Sets Over / Match Over, 25 of 27 prop
types). The signature is universal — "homogeneous heavy edge in one direction of one family" is a model
bias whatever the source. Response, by priority:

1. **FLAG-ONLY stop (pmvFlagOnly, default ON):** the scan still logs every would-be entry (data keeps
   accumulating) but places NO bets. Open paper positions ride to settle as the diagnostic sample.
   Contamination stopped at the tick it was noticed, not after a review cycle.
2. **Frequency diagnosis (?report=pmv_freq):** actual 3-set rate + hold rate from our snapshots vs the
   model's i.i.d. base_hold chain — closes the cause empirically.
3. **Recalibration = new epoch ("interim-m1"):** set-dependence MOMENTUM (winner of a set gets +ε hold
   in the next → fewer 3-setters, the direct fix for the Total Sets Over lean) + base_hold from our own
   hold frequencies. ε interim (TENNIS_MOMENTUM=0.04), calibrated from P(win set2 | won set1).
4. **UNIFORMITY GUARD (the durable fix):** across the whole slate, if >65% of a family's passing
   deviations lean the same side over ≥5 samples → STOP the family (log uniformity_stop), don't bet. It
   would have fired on the 5th bet, not the 108th. Plus placeholder filter (~50¢ untraded default),
   totals correlation cluster (games+sets = one), and contract-side provenance (ambiguous Set Handicap
   "+/-1.5" blocked; Set Winner orientation aligned to the moneyline).
5. **Re-enable (TENNIS_PMV_FLAG_ONLY=false) ONLY after** the recalibrated epoch stops producing the
   uniform lean, and then the Brier criterion judges the strategy on the CLEAN "interim-m1" sample as
   the spec requires — never mixed with the broken first batch.

## Tennis PMV — the THIRD tennis strategy: prop consistency vs the moneyline anchor (DONE, v1 no-LLM)

The epistemic inversion of the football PMV (which bled −$1022 on "I know better than the market"):
Tennis PMV does NOT estimate player strength. It takes the LIQUID MONEYLINE as the anchor, solves the
single class differential δ that reproduces it under a hold-based Markov chain (tennisMarkov.ts), prices
every prop theoretically, and trades only the INTERNAL inconsistency of a thin inattentive prop vs the
moneyline. Our own estimate is nowhere in the loop → the France-Morocco phantom-value class is excluded
by construction. Deterministic end-to-end: NO LLM in v1 (the deliberate end point of the football
lesson — market+code were the better pre-match judges). An LLM filter is added ONLY if paper shows a
systematic class of false entries explained by info outside prices — data-gated, never pre-emptive.

**Stage-0 gates (both cleared):** 0.1 prop liquidity — production says 89.4% of ATP/WTA matches carry a
prop with book ≥$500 (bar 15%) → BUILD (`?report=prop_liquidity`; caveat: gamma POOL proxy, a live CLOB
probe precedes real sizing). 0.2 retire provenance — documented above; the void-on-incompletion semantics
are wired into settle AND folded into the theo (Total Sets / Set Handicap / match-total-games get a
completion-rate haircut so we don't read a phantom deviation against a mid that already prices the void).

**Anti-Draw rule (the two-Draw lesson, the main safety):** deviation ≥18¢ is NOT a bet but a
`provenance_review` FLAG — a giant gap almost always means we misread the CONTRACT (retire resolution,
line semantics), not free money. Blocked + logged until the clause is hand-checked. Entry band: deviation
≥7¢ (props are noisier than football), price 8-92¢, book ≥$500. Correlation: ≤2 props/match of DIFFERENT
families (all match props correlate through the result); thin-book stake cap = 25% of the prop's book.
Held to settle (a thin-book early exit is eaten by spread); no price stops — size + entry bar are the guard.

**Success criterion (Brier, primary; written before data):** over ~40-60 settles the Markov probabilities
must beat the implied mid — `Brier_markov ≤ Brier_implied` (`?report=pmv_brier`) → the core prices props
more accurately than the inattentive market, strategy lives. Worse → park and review (base_hold /
tiebreak approximation). PnL/CLV on this sample are noisy and secondary. base_hold is INTERIM by
tour×surface (ATP hard ~0.80 / clay ~0.77 / WTA ~0.65), calibrated later from our own hold-frequency
snapshots as its own epoch. bo3 only (bo5 = different chain + retire dynamics, later). v1 does NOT build:
point-by-point game expansion, fatigue/between-set dynamics, or a live-PMV re-price (pre-match only).

## Tennis PMV Gate 0.2 — prop RETIREMENT provenance, VERIFIED from gamma-api (DONE); families void differently

The PMV core anchors every prop's theoretical price on the moneyline via a Markov chain. But a prop's
resolution at RETIREMENT (tennis retires often) embeds an option that changes BOTH tradeability and
the fair price. Read the live gamma-api clauses (tag 864, 2026-07) for each family — verbatim below.
NO family has a murky clause → no clause-blacklist needed; but the void-on-incompletion semantics
DIFFER by family and MUST be wired into settle AND folded into the theo price when the core is built.

- **Moneyline (anchor):** retire/default/DQ mid-match → the ADVANCER wins; walkover / cancel / tie /
  delay>7d → 50-50 (void). (Already documented under the retirement-provenance entry.)
- **Total Sets O/U:** *"If the match begins but is not completed, this market will resolve 50-50."*
  ⇒ ANY mid-match retire → VOID. A super-tiebreak counts as one set.
- **Set Handicap (−1.5/+1.5):** *"If the match begins but is not completed, … 50-50 … Otherwise …
  based on the final completed score."* ⇒ ANY mid-match retire → VOID.
- **Total Games (Set N Games O/U):** *"If set N is not completed for any reason (including the match
  ending before set N is reached), … 50-50."* ⇒ voids ONLY if THAT set is incomplete; a COMPLETED
  set resolves even if the match later retires. Any tiebreak counts as one game.
- **Set N Winner:** *"If the match begins but is not completed, and the first set is concluded with a
  winner, this market will resolve based on that completed set. If the … set is not completed → 50-50."*
  ⇒ resolves on the completed set REGARDLESS of a later retire; voids only if the set itself is incomplete.

**Consequence for the core (do NOT skip):** Total Sets & Set Handicap are *conditional on the whole
match completing* — their fair value is `P(outcome | completes)` with a void refund otherwise, so the
Markov theo price MUST fold in P(non-completion) or it will read a phantom deviation against a mid that
already prices the void option (the same class as the Draw / retire lessons). Total Games (a done set)
and Set N Winner (a done set) are robust once their unit completes. Settle must implement: relevant
unit incomplete → VOID (refund, excluded from Brier); unit complete → resolve on it even post-retire.

## Tennis Set-Value — the SECOND tennis strategy; the "lost set 1" trigger is DIVORCED from Overreaction (DONE)

Two tennis strategies now trade the same "favourite is over-sold" thesis on the SAME moneyline, so
they MUST NOT both hold a position on one match (hidden double exposure). The split is by HORIZON:

- **Overreaction** (horizon = minutes, snapback): keeps ONLY the intra-set break. `chargeTennisTriggers`
  arms one trigger (`early_break`); `tennisReassessShouldCall` fires only in the early window
  (set 1 / start of set 2, no set yet lost). The old trigger #2 (`lost_first_set`) is GONE from here.
- **Set-Value** (horizon = the match): buys the favourite AFTER it loses set 1 (bo3) into the 30-45¢
  band and HOLDS to resolution. Trigger #2 moved here ENTIRELY (tennisSetValue.ts + tennisSetValueTick).

**Cross-strategy one-position rule (hard, code):** before a Set-Value entry, a profile holding ANY
open tennis buyback (Overreaction OR Set-Value) on the match is NOT free — Set-Value WAITS (no acted
marker, logs `blocked_cross_strategy` once) and enters once the block clears (e.g. Overreaction closed
by its K-stop). Overreaction fires earlier (pre-set-loss) so it needs no symmetric guard.

**Favourite ID from the MATCH-START price, never the current one:** after losing set 1 the favourite's
price drops into 30-45¢, so identifying off the current price would FLIP the favourite to the opponent.
Set-Value reads the first priced snapshot (startPrices) for favourite ID.

**Deterministic vs LLM (§9.6):** CODE gates format (bo3 only — a Grand Slam men's singles is bo5,
filtered by `isBestOfFive`), the lost-set-1 state, and the price band (<25¢ = "market knows more",
never enter; >45¢ = no panic; 30-45¢ = armed). The LLM judges ONLY competitive-set vs blowout +
retire-risk. Exit (deterministic, tennisExitTick, order retire → thesis_stop → floor → take):
thesis_stop = broken in set 2 with NO break-back within K=2 receiving games; catastrophic_floor =
entry−12¢ (phantom-guarded by persistence); take = PARTIAL 50% fixation at 55¢, remainder to settle.

**Interim numbers — do NOT hand-tune from the first bets (epoch discipline):** P(comeback)=0.50 for a
competitive lost set, band 30-45¢, floor 12¢, take 55¢ are INTERIM constants tagged `armed_epoch:"interim"`.
**Pending calibration (backlog):** a set_won cut on tennis_break_marks (favourite-lost-set-1 → price
after the set, comeback win-rate from finals, set-2 price trajectory); report at ≥40 setups replaces
P(comeback) and the band; bump `TENNIS_SV_EPOCH` to `calibrated` then. Markov core deliberately NOT built.

## Tennis price layer = the MONEYLINE, resolved by structure — never surname-match (DONE)

**The bug that hid under "взведено, но пусто":** Polymarket lists a tennis match as ONE
moneyline market **plus many props** (Match Over/Under total games, Total Sets O/U, Set
Handicap, Set N Winner, Set N O/U). EVERY label is `"Tournament: A vs B <suffix>"` — so it
contains BOTH surnames. `winnerMarketFor` matched by surname → grabbed the FIRST such market
(a PROP, e.g. `Match Over 21.5 @ 70.5¢`) instead of the moneyline (`6.4¢`). Every derived
value — favourite detection, armed bands, book gate, and 105 calibration marks — inherited
the substitution. Garbage-in up the whole vertical, masked because 70¢ looks plausible.
Same class as the Draw-dedup and player-mapping lessons: string-match + a contract-semantics
assumption is the quietest, costliest bug.

**Orientation — VERIFIED from gamma-api (source of truth), 2026-07, verbatim:**
A tennis H2H market has `groupItemTitle: ""`, `outcomes: ["PlayerA","PlayerB"]` (index 0 =
the FIRST-named player), `outcomePrices: ["P(A)","P(B)"]` (sum 1), `clobTokenIds: [tA,tB]`.
Evidence: `Croatia Open: Lukas Neumayer vs Juan Carlos Prado` → `["0.665","0.335"]` (Neumayer,
first-named & higher-ranked, 66.5%); `Segundo Goity Zapico vs Juan Estevez` → `["0.09","0.91"]`.
Our importer (marketSides) collapses this to ONE stored market because the `"A vs B"` title
contains both outcome names (`namesOutcome=true` → no expansion): label = the question,
**price = outcomePrices[0] = P(first-named player)**, `external_ref` = clobTokenIds[0] (first
player's token). So the second player's price = `100 − stored`.

**RULE (resolver): the moneyline is the SINGLE market with NO prop keyword** (over/under/total
sets/handicap/set N/winner/games/odd-even/tiebreak/±handicap). Align its `A vs B` to the
match's players by surname. **0 or >1 non-prop markets → HONEST SKIP with a log — never take
the closest match.** Same discipline as honest player-mapping. A resolver test on the real
15-market Uchida–Galarneau fixture must return exactly the bare market and fail LOUD otherwise.

**Calibration reset:** the 105 marks were measured on PROP prices (game totals move far LESS
on a break than the winner market). They are discarded, and ALL tennis thresholds return to the
`interim` epoch until ~100 marks re-accumulate on the moneyline. The exit DESIGN (game-count
stop, floor, take buffer) is price-independent and stays; its NUMBERS do not carry over — the
moneyline panic amplitude is almost certainly LARGER, so armed bands + recovery stats will shift.

## 🎯 token-fix-m1 — the FOURTH orientation bug + the invariant that outlives it

The tennis buyback always transacted `outcomes[0]`'s token but reasoned/sized/settled on the
FAVOURITE. When the favourite was the SECOND-named moneyline player (~half of matches) the
position HELD THE WRONG PLAYER (Mrva–Roncadelli: sold at the opponent's 25%, logged the
favourite's 73%). Root: the second outcome's token was never persisted, and every consumer
re-derived orientation instead of reading it once — the same sin as the moneyline resolver,
set_winner, and handicap-theo bugs. Fix: `markets.token_second` persists outcomes[1]'s token;
`favTokenOf(ml, favSide)` resolves the favourite's OWN token; entry+exit (both strategies) use it;
orientation (`favSide`+`firstIsP1`) is FROZEN on the bet. Pre-fix second-outcome bets are
quarantined (`tokenFlipPoisoned`) out of every slice. Epoch `token-fix-m1`.

**RULE (kept FOREVER, do not remove after the fix): the runtime orientation invariant.** Before
any buy/sell the token's live top-of-book must sit within ~28% (`TOKEN_ORIENTATION_TOLERANCE_C`)
of the side we sized on, else block + `token_orientation_mismatch`. "Last known consumer" ≠ "last
consumer" — this backstops the fifth orientation bug we have not found yet.

## 📌 Data-gated follow-ups (revisit with data, do NOT guess-tune now)

- **B3 real-book floor `TENNIS_MIN_REAL_BOOK_USD` = $250** is a from-the-head start (declared
  liquidity vs executable top-of-book notional are different metrics — the stage-1 $2k could not
  transfer 1:1). The `thin_real_book` skip logs the real-vs-declared gap; after ~a week, look at
  that distribution and raise the floor if dust still leaks.
- **Scout H1-specific recovery** (external `/api/health` pinger / always-on plan + unhook the
  heartbeat from `hasLiveMatchInPlay`, which a dead scout defeats) waits on the `scout:gap` verdict
  (loop-death H2 vs cron-downtime H1). The observability (own liveness stamp + due-live watchdog +
  unwrapped provider errors) shipped unconditionally.
