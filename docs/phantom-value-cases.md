# Phantom-value case log

Labeled cases where the model shows a large pre-match edge on a PROMINENT/LIQUID
market — suspected to be a re-counted public narrative, not real value. Each case
is recorded BEFORE the match (prediction frozen), outcome filled after. This is
the seed of the model-vs-market sample (see `model-vs-market-measurement.md`).

Rule of thumb being tested: a big pre-match edge on a liquid, closely-watched
market (e.g. a World Cup knockout) is more often a model error than found value.

---

## Case #1 — France–Morocco (WC 2026 QF) — REFERENCE CASE

- **When recorded:** pre-match, lineups out. Kickoff 2026-07-09 20:00 UTC.
- **Market:** FIFA World Cup quarter-final (knockout, single-leg). Liquid,
  closely watched → efficient. Favorite = France.

### Frozen prediction (model vs market)
| Market | Model `ai_prob` | Market (implied) | Model edge | Suspected |
|---|---|---|---|---|
| Team to Advance — **Morocco** | **0.32** | ~0.224 | **+9.6%** | phantom |
| Team to Advance — France | 0.683 | ~0.776 | −9.3% | model underrates fav |
| Morocco Over 0.5 | 0.63 | 0.575 | +5.5% | underdog-scoring optimism |

### Model internals (base artifact)
- `xg_home (France) = 1.75`, `xg_away (Morocco) = 1.05`.
- Derived 90-min: **France ~52% / draw ~26% / Morocco ~22%**.
- Advance uses an xG-weighted draw split (`biasHome = 1.75/2.80 = 0.625`) — this
  part is REASONABLE; the whole gap is in the 90-min win prob, i.e. the xG.

### Hypothesis (why this is phantom value, not value)
The model compressed France's xG for a well-known underdog narrative — its own
calibration notes say: *"Марокко исторически перформит выше underlying в кубках
за счёт дисциплины блока и Буну… могло бы сжать xg_home"*. Yet the notes also
say Morocco has no true striker and below-xG conversion — so Morocco's 1.05 xG
looks too high by the model's own read. The efficient WC market has ALREADY
priced the Morocco-2022 / Bounou / low-block story into the 22% price. The model
re-applied it → **double-count → phantom edge on the underdog.** For France to
advance ~77% (market), its 90-min win must be ~63%, needing xG ≈ 2.0 / 0.9.

### Outcome (fill after full time)
- Result 90': `___`  | ET/pens: `___`  | Advanced: `___`
- Who was closer to reality (model 32% vs market 22% Morocco-advance): `___`
- Morocco scored (Over 0.5)? `___`
- Verdict: `[ ] confirms phantom value  [ ] model was right (real value)  [ ] inconclusive`

> One outcome proves nothing — this is data point #1. Its value is as a clean,
> pre-registered example of the suspected defect to anchor the sample.
