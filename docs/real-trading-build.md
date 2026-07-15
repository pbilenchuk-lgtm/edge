# Real-Trading Infrastructure — Build Notes

Companion to the owner spec (`real_trading_infrastructure_spec.md`). Tracks how the
spec maps onto THIS codebase and the sequencing decisions taken with the owner.

## Prime directive: build ≠ enable

Everything is built with `REAL_TRADING=off` (default). The simulation does not change,
loses no data point, and takes no LLM out / puts none in. Enabling real money is a
separate owner decision gated on the §8 checklist.

## Scope decision (owner, this session)

Build **through DryRun** now (Phases A–E + UI/metrics/tests). Defer the live
`RealExecutor` (Phase F, `@polymarket/clob-client` + wallet secrets + allowances) to a
focused, separately-reviewed change once the owner's §10 actions (account, wallet, USDC,
uptime monitor) are done. Rationale: F has no preconditions yet, is unverifiable against
the exchange today, and money-moving code deserves an isolated security review — not a
diff buried inside the mega-build. A–E deliver all the value immediately (execution-realism
metrics via the live book, UI, safety belt, tests); F is a thin adapter over a proven contract.

## Architecture findings that shape the build

- **Two distinct paper-fill paths today** (the executor must unify both):
  - **Football**: decision → `insertBet(status:"proposed")` → `autoEnter` tick runs
    `executeEntry` (real order-book VWAP: slippage, taker fee, depth cap, phantom guard,
    `lifecycle.ts:541`) → `updateBet(status:"open")` at `lifecycle.ts:696-717`. A real fill model.
  - **Tennis**: decision inserts **directly** `status:"open"` at the quote with **`0¢ (paper)`**
    slippage (`tennisTrading.ts:719/846`, `tennisPmv.ts:555`). No book model at all.
- **The tennis path is the root of a whole bug class** (yesterday's "exit at entry price,
  P&L fabricated to $0"): tennis never had a book-fill model. Phase A unifying tennis onto
  the PaperExecutor's book-VWAP fill is therefore a **deliberate FIX, not an invariant**.
  → Football: snapshot test asserts behavior UNCHANGED.
  → Tennis: tests assert the behavior CHANGES (honest book prices, not 0¢ / entry price).
- **No `decision_id` exists** anywhere. Added as a `bets` column (twin link paper↔real).
  `clientOrderId` is derived deterministically from `decisionId + leg` → idempotency key.
- **Polymarket client is read-only** (`/midpoint`, `/book`); no CLOB write client. Good —
  the real executor is genuinely new surface. `markets.external_ref` = CLOB `token_id`.
- **Migration idiom**: new tables via `CREATE TABLE IF NOT EXISTS` in `schema.sql`; new
  columns via `ALTER TABLE … ADD COLUMN` in the `db.ts:178` try/catch array; CHECK changes
  via table-rebuild (`db.ts:239`). UI toggle lives in the header `S.treasury` block
  (`EdgeLab.tsx:603`).

## Phases

| Phase | Deliverable | Status |
|---|---|---|
| **A** | `Executor` contract + `PaperExecutor` (unify both fill paths, tennis entry+exit book-fill) + `decision_id`/`clientOrderId` | **done** |
| **B** | `real_orders/fills/positions/ledger/whitelist` tables + repo | pending |
| **C** | Safety belt: 4 caps + tick/min conform, kill switch, idempotent-retry protocol, reconciliation, persistent expiry sweep | **done** |
| **spike** | CLOB capabilities-vs-assumptions doc (before D) | pending |
| **D** | `DryRunExecutor` (real path, fills vs live book, no send) | pending |
| **E** | Whitelist filter (single sim→real gate, `sport=football` hardcoded) | pending |
| **F** | `RealExecutor` (live CLOB) — **deferred**, separate review | deferred |
| **G/H/I** | UI (Sim/Real, twin-link, [STOP]) · `real_vs_paper` metrics · §9 tests | pending |

## Tennis epoch break — `book-fill-m1` (recorded before the data)

From `book-fill-m1`, tennis **entries** fill against the LIVE moneyline order book (VWAP
or honest skip), replacing the old `0¢`/quote insert. This is a **hard break, no bridge**:
- Pre-`book-fill-m1` tennis marks/bets were priced in a different world (fabricated `0¢`
  fills, exits at entry price — the Travaglia bug). They are **incomparable** with the new
  ones: NO cross-epoch aggregates. Per-sport views default to the current epoch.
- Old tennis statistics are **diagnostic, not calibration**. The interrupted PMV/Set-Value
  sample was already poisoned (zero fills, entry-price exits); the break stops accumulating
  garbage, it doesn't lose signal.
- Overreaction + Set-Value carry `book-fill-m1`. **PMV is untouched** — it is flag-only and
  never touches the book, so its epoch (`interim-m1`) is unchanged.

### Two-fork skip map (recorded before the data)

Every non-fill is tagged with a machine `reason` so two questions get separate counters:
- `untradeable_market` — book EMPTY / placeholder → **coverage map**: which tours/markets are dead.
- `orderbook_unavailable` — book exists, no offers now / fetch failed → transient.
- `no_edge` — depth exists but slippage eats the edge → priced out.
- `phantom` — effective price drifted from the decision → stale/phantom book.
- A THIN book (depth < requested) does NOT reject — it fills SMALLER and sets `clamped`
  (the "where we lose size" signal / the future partial-fill argument, §2.2).

### Set-Value routing criterion (recorded before the data)

On moneylines with **declared liquidity ≥ $10k**, the `no_book_liquidity` skip rate should be
**LOW (<10–20%)**. A HIGH rate there is a signal of OUR book mapping (wrong tokenId, wrong
book side, limit price missing the spread) FIRST, the market SECOND. First day post-deploy:
eyeball this slice on ATP moneylines.

### Exit routing (done — Phase A closed)

Exits now sell into the live BID book (VWAP), symmetric to entries. `tennisExitTick` is async;
the trigger DETECTION still runs on the midpoint (`cur`), the EXECUTION price comes from the book.
Exec model off → midpoint (legacy paper). Per trigger → fill-path → flags:

| Trigger | kind | live bid book | thin bid (depth < position) | NO bid book |
|---|---|---|---|---|
| take_price | take | sell fillable frac at VWAP | take the fillable part | **skip + retry** (never fabricate a take) |
| thesis_stop / catastrophic_floor / game_count_stop | protective | full sell at VWAP | **partial sell + remainder `exitAttention` + retry** (never dump below floor) | **full exit at modelled price + `exitStalePrice` flag + alert** (§4.5) |

Flags reach the bet's `entry_meta`: `exitStalePrice` (stale/modelled defensive fill) and
`exitAttention` (partial protective, remainder awaiting retry). `profileAnalytics` treats a
stale-priced exit as `void` → OUT of the win-rate/calibration slices (a stale cut isn't a clean fill).

Orientation guard (test): a sell fills into the **38¢ bid**, never the 40¢ ask.

## First-day observability (post-deploy, POLYMARKET_ENABLED=true)

Four numbers to eyeball on day one, plus one full cycle:
1. Skip share by type (`untradeable_market` / `orderbook_unavailable` / `no_edge` / `phantom`)
   on ATP moneylines with declared liquidity ≥ $10k — criterion **<10–20%**; higher ⇒ suspect
   OUR book mapping first (tokenId / book side / limit vs spread).
2. First Set-Value entry at a book price — the whole cycle by eye.
3. PMV flag-only stream — confirm routing did not touch it.
4. **`exitStalePrice` share** among protective exits. Stale exits are voided out of the win-rate/
   calibration slices, so a HIGH share (>10–15%, realistic on thin tennis bid books) means the stop
   slices UNDER-count — not a reason to change the void logic, but a known caveat for calibration.

## CLOB doc-spike verdicts (fold into Phase F; details in clob-capabilities-vs-assumptions.md)

The spike checked our spec's assumptions against the real API. Applied to the paper contract NOW;
the rest are Phase-F build constraints recorded so F doesn't reopen the contract.

- **SDK**: `@polymarket/clob-client` is **archived/dead** → target **`@polymarket/clob-client-v2`** (v1.0.8).
- **TIF (MATCHES w/ caveat)**: native GTD has a ~60s security buffer → usable for the ~10min pre-match
  window only; 45s entries / 15s exits need **GTC + client-side timer + cancel**. → `OrderRequest.expiryMode`
  (`native-GTD` | `client-cancel`) added to the contract now.
- **Idempotency (MISMATCH)**: the CLOB has **no client-supplied order id**; server dedup is by the
  **order hash** of a signed struct with a random **salt**. Our `client_order_id` stays as OUR local
  key; added `salt` + `order_hash` columns to `real_orders` so a retry re-derives the byte-identical
  order and looks it up by hash before any resend (§4.3).
- **Partial fills (MATCHES)**: `size_matched`/`original_size`; compute avg price from `getTrades`
  (size_matched can slightly overstate). Our partial model holds.
- **Min size + tick (MISMATCH, risk)**: both are **per-market** (`getTickSize` / `minimum_order_size`).
  A fixed ±1¢ tolerance = 1 tick at 0.01 but is **sub-tick/meaningless on coarse (0.025/0.1) ticks**.
  Phase E/F MUST fetch tick + min-size per market, clamp the limit to tick, skip when ±1¢ < 1 tick or
  notional < market min, and keep the depth-clamp above the min-size floor. **Do not hardcode.**
- **Redemption (MATCHES, under-specified)**: on-chain CTF `redeemPositions` (branch neg-risk adapter),
  gas paid in **POL**; separate from the CLOB client.
- **Auth CONFIRMED**; our spec's `signatureType` numbering was stale → proxy=1, Safe=2, deposit=3.
- **Rate limits**: non-issue (thousands/10s vs our 20/hr cap).

## Phase C — safety belt (pure, exchange-independent; `src/lib/executor/safety.ts`)

The second belt: every check runs IN the executor AFTER all upstream gates, trusting no upper layer.
All logic is pure — Phase D/E/F only FEEDS it live inputs (market tick/min, exchange lookup/view).
Nothing is wired to place orders yet; this is the ready-to-call belt + its tests.

- **Kill switch** `readTradingMode(env)` — read FRESH per operation (no boot cache): `off` | `dry_run`
  | `exits_only` | `on`; unknown/blank → `off` (fail-safe). `entriesAllowed` only in `on`;
  `sendsRealOrders` only in `on`.
- **Four hard caps** `enforceCaps` (env, conservative defaults), gating ENTRIES only — a defensive
  EXIT is never blocked (a stop must always leave):
  - `REAL_MAX_ORDER_USD=50` → clamp down.
  - `REAL_MAX_EXPOSURE_USD=200` → reject over-cap entry (reads open BUY exposure).
  - `REAL_MAX_DAILY_LOSS_USD=60` → `pause` (caller flips `exits_only`); reads ledger loss-of-day.
  - `REAL_MAX_ORDERS_PER_HOUR=20` → reject (berserk-loop guard; bug hits the cap, not the bank).
- **Fifth cap** `conformOrderToMarket(order, {tickCents, minOrderUsd, tolCents})` — BUY floors / SELL
  ceils to the market tick; skip when ±tol < 1 tick (coarse-tick market) or notional < market min.
  Phase E/F feeds real per-market tick/min (never hardcoded).
- **Idempotent-retry protocol** `resolveRetry({orderHash}, lookup)` — blob held → `resend_same`
  (never re-sign; re-sign = new salt = new hash = a 2nd order), `wait` only if already `exists`; blob
  lost → `new_intent` ONLY on confirmed `absent`, else `wait`. Signed blob (salt/hash) persisted in
  `real_orders` before send.
- **Reconciliation** `reconcile(local, exchangeView, tol)` — balance/position diff beyond $1 / 1 token
  → `exits_only` + discrepancy list (return to `on` is a manual owner call).
- **Persistent expiry** `expiredClientCancelOrders(db, now)` — a `client-cancel` order past its
  PERSISTED `client_cancel_deadline` is swept by the reconciliation cycle, so a crashed in-memory
  timer / Render restart can't leave a GTC order hanging (the "process slept with an open position"
  class, for orders). GTD orders are the exchange's job, not swept.

Tests (13): mode fresh-read + fail-safe; each of the 4 caps + exit-bypass; tick BUY-floor/SELL-ceil +
sub-tick skip + below-min skip; retry all six branches; reconcile clean/balance/position/ghost;
expiry sweep. 527/527 green.

## Invariants (never violated by any phase)

1. Simulation → whitelist → real is the ONLY direction. Real never writes back to sim
   (budgets, strategy stats, calibration, shadow).
2. No LLM in the real contour. All executor decisions deterministic (§9.6).
3. Real-contour failure degrades to paper-only with an alert (try/catch at the boundary).
4. Tennis can never reach real this stage (`sport=football` hardcoded in whitelist validation).
5. Hard caps + kill switch are checked IN the executor, after every upstream gate — the
   last belt, trusting no upper layer.
