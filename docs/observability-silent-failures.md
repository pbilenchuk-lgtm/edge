# Lesson: graceful degradation masks silent partial failure

**Date:** 2026-07-15 · **Trigger:** the Fable-5 duel arm.

## What happened

`ANALYSIS_DUEL=on` split matches ~50/50 between Opus 4.8 and Fable 5 by a stable hash.
Fable's analyses failed on ~24 of ~33 hash-assigned matches (57 Opus matches vs 9 Fable
in `analysis_artifacts`). There is **no Opus fallback** on a failed base analysis
(`analysis.ts`: `!base.ok` → record a `failed` assessment → `return {ok:false}`), so each
failed Fable match was **dropped entirely** — no distribution, no strategist, no bets.

We ran undisturbed for **weeks** without noticing, because the system **degraded
gracefully**: the ~half of matches that hashed to Opus kept producing bets, so coverage
*looked* whole. The bet log filled, the «Профили» tab had numbers, nothing errored loudly.
Only an explicit arm-balance check (`duel-status.ts`, counting matches per model) surfaced
it. A probe (`probe-fable.ts`) then proved Fable is *accessible* — it fails on the heavy
structured calls (likely the 120s timeout; Fable ran 2.5× slower even on a trivial prompt),
not on auth. So the failure was silent, partial, and intermittent — the hardest kind to see.

## The lesson

**Graceful degradation is a double edge: it keeps the system up, and it hides that half of
a subsystem died.** "It looks like it's working" is not evidence a subsystem is whole when a
healthy sibling can absorb the gap. This is the same class as the dead Overreaction feed and
the silent "abstention" drops — a *silent zero*, explained only when explicitly probed.

## The reflex (already started, extend it)

The right direction is the one taken with the real-mirror skip (`whitelist.ts`): a skip that
was **intended** to do work but couldn't must be **loud** (logged), not a silent early return.
Apply the same lens elsewhere — audit for silent partial failures wherever a fallback or a
sibling can mask a loss:

- **Analysis duel:** a Fable-hashed match that fails should log the reason (the `failed`
  assessment stores `status` but not the error text — the *why* is currently lost).
- **Any per-item loop with a fallback** (live cycle pairs, exit sweeps, provider fetches):
  count attempted vs succeeded and surface the delta, don't just proceed on the survivors.
- **Coverage as a first-class metric:** "N matches analysed" should be checkable against
  "N matches eligible", so a half-dead analyst shows as a coverage gap, not invisible.

Not an action item to do all at once — a standing lens: **when something can quietly absorb
a failure, instrument the loss, because the absorption is exactly what hides it.**
