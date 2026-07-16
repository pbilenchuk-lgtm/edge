# Real-trading functionality audit

**Date:** 2026-07-16 (overnight, owner-requested) · **Scope:** the whole real-trading contour before
real money is enabled — executor + fill engine, safety belt, whitelist/mirror/sweep, data layer +
owner controls, and system-level invariants / Phase-F readiness. Five independent review passes; a
finding hit by more than one pass is flagged **(×N)** and is high-confidence.

## Verdict

**The architecture is sound; the accounting plumbing underneath it is not ready.** Real money cannot
move today (no RealExecutor, `@polymarket/clob-client-v2` isn't even a dependency; the mode selector
returns `null` for every send path). The kill switch, most-restrictive-wins mode invariant, sticky
pause, sport/whitelist gate, and §9.6 (no LLM prices a real order) are genuinely well-built and verified.

But the **quantitative belt and the money accounting have real defects** — several let real exposure or
real loss exceed the intended ceiling, and the dry-run metrics we'd use to justify going live are
themselves biased. **Do not enable `on` until the CRITICAL/HIGH items below are closed and one dry fill
has validated the contour end-to-end.**

## Confirmed strengths (verified, not just assumed)
- Mode invariant holds: `effectiveTradingMode` only ever tightens; garbage operator value → `off`
  (fail-safe); sticky pause floors at `exits_only`; `on` needs the typed phrase; STOP is greedy/honest.
- §9.6: no LLM *call* sits below the executor; real limit/exit prices are code-derived; `fairValueCents`
  (an LLM number) is carried but **never read** by the Dry/Real executors. Contained.
- Sim→real gate direction: nothing non-football, non-whitelisted, or tennis can reach a real order;
  sizing is genuinely proportional and bounded; entry limit is executable (the earlier phantom's entry side).
- `clientOrderIdFor` deterministic/collision-safe; entry idempotency solid; dry-fill is a legitimate
  lower bound on real fill rate.

---

## CRITICAL — must fix before any real order

1. **Unauthenticated control plane; `actor` is forgeable.** `/api/real-control` has no auth/session/token
   (no `middleware.ts`). Anyone who reaches the Render URL can POST `set_mode on` (the phrase is a
   hardcoded constant, not a secret), `stop`, or `set_caps`, and the `real_control_log` "who" is whatever
   the body claims. → Require an owner token/signed session; derive `actor` from it, never from the body.
   *This makes every other control — phrase, confirm, audit log — theatre until fixed.*

2. **Fill accounting is not atomic (×2).** `place()` does insert→placed→`await book`→fill→ledger×2→
   position→final-transition as separate auto-commit statements with a network `await` in the middle, and
   `grep '.transaction('` = 0 hits anywhere. A crash after the fill/ledger writes but before the final
   transition leaves cash+position moved while the order is stuck `placed`/0-filled — and the idempotency
   guard (`status !== "created"`) then makes it **permanent**. → Fetch the book first, then wrap
   insert→…→transition in one `db.transaction()`; guard re-fills against an existing `real_fills` row.

3. **`real_positions` keyed by `token_id` only (×4 — the strongest signal in the audit).** Multiple
   (strategy, profile, decision) twins bet the same token → they collapse into one position row
   (`strategy_id`/`avg` blended); the dry column isn't in the key either, so a dry and a real position on
   the same token collide. The sweep then binds the merged blob to the *first* decision_id and can sell
   shares belonging to a different twin. → Key by `(token_id, decision_id)` (or `token_id, strategy,
   profile, dry`); make the sweep resolve the exact twin.

4. **No real exit path; `exits_only` is a no-op.** `sweepDryExits` skips every non-dry position and builds
   an executor only in `simulate` mode. `modeCaps(exits_only).realExit = true` is a promise the code
   can't keep — if entries were ever enabled, real positions would open with **no stop, no take, no exit**.
   → Phase F must build a `dry=0` settled-twin exit sweep + a real exit executor, and prove `exits_only`
   actually places a real exit.

---

## HIGH

5. **Caps override not clamped to the env ceiling (×2).** `resolveSafetyCaps` took the override outright —
   `set_caps {maxExposureUsd: 1e6}` silently blew past the env floor; "UI can only tighten" was false for
   all four caps. **✅ FIXED tonight** (`min(env, override)`; tests green). Still owed: a confirm gate on
   caps-loosening (parity with mode→on).

6. **Exposure cap is a lifetime-volume throttle, not a risk cap (×3).** `openRealExposureUsd` sums
   `filled_size_usd` over BUY orders in placed/partial/filled — SELLs never subtract, filled orders stay
   forever, freshly-placed orders count 0 until they fill (so a burst clears the cap), and dry orders are
   included. → Compute exposure from **open real positions** (`size × avg`, `dry=0`); reserve at check-time
   to close the TOCTOU where two concurrent places both pass.

7. **Daily-loss breaker measures net cash flow, not realized P&L (×3).** A BUY books `−filledUsd` (opening
   a position, not a loss) and a SELL/redemption books positive, and the query isn't `dry=0`. So it
   **over-fires** on normal entries and — the dangerous direction — **fails to fire** when a genuinely
   losing day is masked by same-day inflows or dry P&L. → Drive it from realized P&L on closed lots,
   `dry=0`.

8. **SELL proceeds booked at the limit price, not the fill VWAP (×2).** A sell fills at bids ≥ limit, but
   the ledger is credited at the limit value while `realized_pnl_usd` uses the true VWAP — so the ledger and
   the position disagree (~10% on the example), and §4.4 reconciliation will stand in permanent
   discrepancy (false-pause, or masking a real gap). → Book the sell at actual gross proceeds; fee as its
   own line (as the BUY side already does).

9. **Exit mirror sells at the CLV *opening line*, not the live bid → held-to-settlement dry positions leak
   forever (×2).** `mirrorDryExit` uses `bet.closing_price` (deliberately the kickoff/entry line for CLV),
   so on a settled market with no book the sell never fills, re-reads the same stale price next tick, and
   the position stays open **forever**. The exit half of the dry rehearsal is systematically missing →
   the go-live metric (fill-rate/slippage) is biased, and `dryVirtualFreeUsd` bleeds toward zero and
   strangles sizing. → Exit limit from the current book **bid** (− tolerance); add a resolution-close path
   (credit at 0/100) for result-settled twins.

10. **The safety belt is written but entirely unwired.** `runReconciliation`, `checkOrphanPositions`,
    `expiredClientCancelOrders`, `resolveRetry` have **zero call sites** outside their own definitions;
    `balance()`/`positions()` return the local ledger — there is **no exchange source of truth**. The belt
    is inert. → Phase F must run reconciliation (~5 min), the orphan sentinel, and client-cancel expiry on
    a real cycle, diffing against the exchange.

11. **Zero dry fills have ever occurred — the contour has run only in unit tests.** Every historical bet
    predates `decision_id`; no new football entry on a liquid book has mirrored. Until one does, we cannot
    know: `external_ref`→CLOB `token_id` correctness (one wrong map = trading the wrong contract), real
    fill-rate, real slippage, latency, or TIF behavior. → A green end-to-end dry fill on a whitelisted
    liquid book is a **hard gate** before Phase F.

---

## MEDIUM

12. **Mirror-support reads sit *outside* the isolation try/catch.** `R.getBet` and `dryVirtualFreeUsd`
    (a `SUM` query) run around, not inside, `mirrorPaperEntryToReal`; a `SQLITE_BUSY` there throws into
    `autoEnter` and **suppresses paper entries for the rest of the cycle** — violating "the mirror never
    affects the paper flow." → Pull them inside the per-bet try/catch.
13. **Real size is re-derived, not pinned to the paper twin's stored fraction.** The mirror recomputes
    `intensity` from raw Kelly, ignoring the calibration/edge/correlation/liquidity down-scaling the paper
    sizer applied — so the "twin" can be proportionally larger than its paper twin, distorting the
    real-vs-paper comparison. → Size from `entry_meta.kellyFraction`.
14. **`MAX_DRY_SWEEP` silently starves the settled positions it exists to close.** `fetched++` counts every
    position (not just settled ones) and the scan is newest-first, so with >25 live dry positions the older
    settled twins never get swept — and it's silent. → Count only settled twins, scan oldest-first, log truncation.
15. **Partial dry exit strands the residual forever.** After a partial fill the remainder "expires"; next
    tick the same exit `clientOrderId` is idempotency-blocked. → seq-bump the sanctioned partial-exit
    re-quote (`clientOrderIdFor(id,"exit",1)`).
16. **STOP drops to `off`, freezing exits, while the alert says "positions ride under exits-only".** The
    reassurance is false — `off` disables `realExit`. → Floor STOP at `exits_only`, or correct the message.
17. **Fee/gas/redemption accounting incomplete.** Nothing writes gas/redemption ledger rows, yet the
    daily-loss cap and reconciliation include those kinds — so loss is under-counted and reconciliation is
    guaranteed to diverge on the first on-chain settlement. → Wire them in Phase F.
18. **`dryBalanceUsd` in the Real view is actually the TOTAL balance** (`realOnly=false` = no filter); once
    real cash exists the "dry" figure silently includes it. → Add a `dry=1` path.
19. **Silent orphan when a paper twin is deleted/re-settled** — the sweep `continue`s with no alert. → Alert.

## LOW (hygiene, not blockers)
Dead guards `entriesAllowed`/`sendsRealOrders` (unused — could mislead the Phase-F author); whitelist
version allocation is a non-atomic read-modify-write; `transitionRealOrder` UPDATE+event not atomic;
`realOrdersLastHour` loads the whole table and filters in JS (no index); `conformOrderToMarket` can reject
a boundary-priced defensive exit; `clearAutoPauseControl` doesn't clear the orphan alert its docstring
promises; `setWhitelistEnabled` bumps version/logs even on a 0-row id; the `dry` migration marks all
pre-existing rows `dry=0` (=real); BUY fill row is fee-inconsistent (size excl. fee, price incl.).

---

## PRE-PHASE-F CHECKLIST (what must be true before one real order)
1. **A green end-to-end dry fill** on a whitelisted liquid football book (order→book fill→ledger→
   position→settled twin→dry sell). No real order until the contour has executed once. *(11)*
2. **`external_ref` → CLOB `token_id` verified** against the real tradeable book. *(11)*
3. **Auth in front of `/api/real-control`**, `actor` from the identity. *(1)*
4. **Positions keyed to their twin** `(token_id, decision_id)`; sweep resolves the exact decision. *(3)*
5. **A real exit path exists** and `exits_only` provably places a real exit. *(4)*
6. **Fill accounting wrapped in a transaction**; re-fill guarded by an existing fill row. *(2)*
7. **Exposure from open positions; daily-loss from realized P&L; both `dry=0`.** *(6,7)*
8. **Sell proceeds booked at fill VWAP; fee/gas/redemption ledger rows wired.** *(8,17)*
9. **Safety belt wired to a running cycle**; exchange is the source of truth for balance/positions. *(10)*
10. **Idempotency real:** `salt`/`order_hash` persisted *before* send; `resolveRetry` drives every retry.
11. **Order-status polling** drives placed→partial→filled; TIF/partial exercised against a moving book.
12. **Exit limit from live bid + resolution-close; exit size clamped to shares held.** *(9)*
13. **Real size pinned to the paper twin's stored fraction; executable-ask edge consistent** (edge fix
    landed 2026-07-16). *(13)*
14. **Key custody / wallet / allowances** reviewed in a separate security pass.
15. **An "intended-N-mirrored-0" alert** so a silent mirror gap is loud. *(observability doc)*

## Fixed during this audit
- **Caps override now clamped to the env ceiling** (`resolveSafetyCaps`) — closes the "UI can only tighten"
  violation for the four dollar/rate caps. *(#5)*
- **Executable-ask edge** (separate commit) — the decision now measures edge against the ask, not the mid.
