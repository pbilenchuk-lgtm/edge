# Model vs market — measurement plan, then shrinkage (order: (б) → (а))

We have ONE observed phantom-value case (France–Morocco). One case tells us the
defect exists; it does NOT tell us its **form** (systematic? which categories?
what strength?). Fixing now (a market-shrinkage guard) would be a blind patch on
one match — the exact sin we're trying to avoid, just in a different layer. So:

1. **(б) Measure** the defect from accrued snapshots until its shape is known.
2. **(а) Then** design shrinkage, calibrated from that data — not intuition.

The snapshot logger already captures, at a common timestamp, the model `ai_prob`
and the market price per market → this is precisely the raw material.

## What to measure (SLICED — average hides the defect)

The hypothesis is narrow: *"the model systematically overrates the underdog on
liquid, favourite-heavy WC matches because of a priced-in narrative."* A global
Brier smears this out. Measure model-vs-market **per slice**:

- **Favourite vs underdog** side of the market.
- **Liquid vs niche** market (by matched volume / market attention).
- **Pre-match vs in-play** phase.
- **Category** (WC / top league / lower division / …).

Metrics per slice:
- **Brier** of model `ai_prob` vs realized outcome AND Brier of the market
  implied (de-vigged) vs outcome → does the model beat the market, or lose to it?
- **CLV** — entry price vs the market's CLOSING line (last pre-kickoff quote).
  Losing to the closing line = no real edge, whatever the P&L did.

### Focus the TAIL, not the mean
The suspicious bets are the large divergences. Break out cases where
**|model − market| > 7%** separately. The model can be fine on average yet lie
systematically in the tail of big disagreements — and the tail is exactly what we
enter on. Check the tail.

Concrete first cut: model beats market in-play (its zone) but LOSES to the
closing line pre-match on liquid favourite markets → confirms the defect's shape.

## Shrinkage design (для (а), AFTER the data) — and its trap

Shrinkage = pull `ai_prob` toward the de-vigged market implied. Right idea, but it
**contradicts the overreaction thesis**: that strategy profits precisely from the
market being WRONG. A global shrinkage would drag our estimate toward the market
in exactly the cases where the market errs and our edge is REAL — curing the
phantom by killing the genuine.

Therefore shrinkage MUST be a function, not a global gate:

    shrink_weight = f(market_liquidity, phase, category_efficiency)

- **Pre-match, liquid market** → market efficient, no info edge → **shrink** (our
  "edge" there is almost always phantom).
- **In-play, post-event** → market emotional, we hold a pre-computed tree →
  **do NOT shrink** (this is our edge zone).
- **Niche market** → market inattentive → **weak / no** shrink.

The data from step (б) tells us *where* the model loses to the market (shrink
there) and *where* it beats the market (never shrink there) — turning `f` from a
guess into a fitted function.

## Reference case
France–Morocco is logged as case #1 in `phantom-value-cases.md` — a clean,
pre-registered example of the suspected defect and the first labeled sample point.
