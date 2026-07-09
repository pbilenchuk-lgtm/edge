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

### ⚠️ Confounds — MUST account for these in the post-match review
This match's live decision log has infra artifacts that are NOT strategy behaviour.
Do not read them as defects.

1. **LLM-budget outage ≈ 72'–85' (Claude credits ran out).** Detected in the data as
   a **14-minute gap between reassessments** (23:36 / 72' → 23:50 / 85'), against a
   normal ~5-min periodic cadence everywhere else. During this window the strategist
   was BLIND (LLM calls failed silently → `continue`, no note/exit/entry). Any
   apparent lag / missed reaction to price or xG in 72'–85' is the credit outage, not
   the strategy. **EXCLUDE (or flag) 72'–85' from any timing / responsiveness metric.**
   - Detection heuristic for the review script: a reassessment gap ≫ the 5-min cadence
     on a live, funded match with open positions ⇒ probable LLM outage window.
   - Data gap to close (follow-up): LLM-call failures are currently SILENT — the outage
     is only visible as an ABSENCE. Log strategist/analyze failures explicitly (an
     error row) so outages are first-class, not inferred from gaps.

2. **Edge display −29/−30% on live-entered positions** (France Over 2.5, France (-2.5)):
   the UI edge uses the stale pre-match `market.aiProb`, but these were entered on the
   live strategist's own estimate stored on the bet (`bet.ai_prob` 0.5–0.6). Cosmetic;
   fully reconstructable (bet.ai_prob + market ai_prob + price all logged). Real fix:
   live reassessment should update `market.aiProb`, or the display should prefer
   `bet.ai_prob` for in-match entries.

3. **Correlated / competing bets** (France Over 2.5 + France (-2.5), both need a 3rd
   goal): the sizing/entry didn't account for cross-market correlation → overlapping
   exposure on one event. Logged with ai_prob + rationale per bet. Design fix: dedup /
   correlation cap across markets that resolve on the same event.

All three are fully reconstructable from the logs (bets, 200+ reassessments, trade_log,
1100+ provider snapshots). Fix ROOTS in a batch post-match, not symptoms mid-match.
