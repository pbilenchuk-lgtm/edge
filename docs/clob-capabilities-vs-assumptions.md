# Polymarket CLOB — Capabilities vs. Our Executor Assumptions

**Status:** paper spike (no code changes). Research date: 2026-07-15.
**Purpose:** verify the 5 spec assumptions against the real CLOB API + TypeScript SDK before we wire the real-money executor.
**Method:** primary sources = Polymarket docs (docs.polymarket.com), GitHub repos, npm registry. Secondary/third-party sources flagged inline. Anything I could not confirm from a primary source is marked **UNVERIFIED**.

---

## 0. SDK reality check (read this first — it changes what we build against)

This is the biggest finding and it is not one of the 5 assumptions, but it invalidates the premise of the task.

- **`@polymarket/clob-client` is ARCHIVED and non-functional.** The GitHub repo (github.com/Polymarket/clob-client) was archived 2026-05-25 with the notice: *"The client is no longer functional and should not be used for new or existing integrations."* Last release v5.8.2 (2026-04-14). Source: https://github.com/Polymarket/clob-client
- **The current official TypeScript client is `@polymarket/clob-client-v2`.** Docs "Clients & SDKs" page instructs `npm install @polymarket/clob-client-v2 viem`. npm `latest` = **1.0.8**, package created 2026-03-01, last modified 2026-07-09 (actively maintained), repo github.com/Polymarket/clob-client-v2. Sources: https://docs.polymarket.com/api-reference/clients-sdks , https://registry.npmjs.org/@polymarket%2Fclob-client-v2
- There is also a **unified `@polymarket/ts-sdk` monorepo** (github.com/Polymarket/ts-sdk) still marked **beta / "No releases published."** The archived clob-client points migrators there; the docs point to clob-client-v2. These likely overlap (ts-sdk is the monorepo, clob-client-v2 the published package) but I could not confirm the exact relationship — **UNVERIFIED**.
- **Protocol moved V1 → V2 (CTF Exchange V2).** The order struct changed between versions (see §2). Third-party sources report field changes; treat V2 struct details as **UNVERIFIED** until read from clob-client-v2 source / the API reference.

**Decision:** build the executor against **`@polymarket/clob-client-v2` (viem-based)**, not `@polymarket/clob-client`. All method/field names below should be re-confirmed against clob-client-v2's actual types before implementation, because most of Polymarket's public docs examples still describe the older client's surface.

---

## 1. Limit orders with expiry (TIF)

**Assumption.** LIMIT orders only (no market orders), each with a bounded lifetime (~45s live entry, ~10min pre-match, ~15s protective exit); on expiry → cancel + log. We want native expiring orders.

**What the API actually does.**
- Four order types: **GTC** (Good-Til-Cancelled, resting limit), **GTD** (Good-Til-Date, limit with expiry), **FOK** (Fill-Or-Kill, market), **FAK** (Fill-And-Kill, market). GTC/GTD are the limit types; FOK/FAK are the market types. Source: https://docs.polymarket.com/trading/orders/overview
- **GTD gives native expiry.** Orders are EIP-712-signed messages carrying an `expiration` field (UTC seconds). Source: https://docs.polymarket.com/concepts/order-lifecycle
- **Two hard timing rules on GTD:**
  1. **Security threshold:** the order effectively expires **~1 minute before** the stated `expiration` (the matching engine subtracts a buffer). To get an effective lifetime of N seconds you must set `expiration = now + 60 + N`.
  2. **Minimum future expiry:** the matching engine **rejects an expiration less than ~10 seconds out** (docs) and third-party sources say GTD must be **at least ~3 minutes** in the future. These two statements conflict — **partially UNVERIFIED**; the 60s security buffer is the safe assumption to design around.
- Native expiry means the exchange drops the order at expiry; you do **not** have to send a cancel for it to stop resting. (You still cancel manually for early exits.)

Sources: https://docs.polymarket.com/trading/orders/overview , https://docs.polymarket.com/concepts/order-lifecycle

**Verdict: MATCHES (with a caveat).** Native TIF exists via GTD. But the **~60s security buffer breaks our short lifetimes**: a 45s live-entry and a 15s protective-exit are *below* the buffer, so GTD cannot express them — the engine would either reject (too soon) or the "expire 1 min early" rule makes sub-60s GTD meaningless.

**Implication for our contract.**
- Use **GTD natively for the ~10min pre-match** orders (`expiration = now + 60 + 600`). Fine.
- For **~45s live entries and ~15s protective exits, GTD is not usable** — fall back to **client-side timers + explicit `cancelOrder`** (place GTC, arm a timer, cancel on expiry, log). This is the "no native expiry" path the spec anticipated, and we need it for the short windows regardless.
- Our "LIMIT only" stance is fully supported (GTC/GTD). We never need FOK/FAK.

---

## 2. Idempotent retry via open-order lookup

**Assumption (spec §4.3).** On a network timeout after placing, FIRST look up whether the order already exists (by *our own client-generated id*); re-place only if it does NOT exist. Never a blind re-place.

**What the API actually does.**
- Lookup endpoints exist and require L2 auth: **`getOrder(orderId)`** (single order by id) and **`getOpenOrders({ market, asset_id })`** (active orders, filterable by market / asset id). Sources: https://docs.polymarket.com/developers/CLOB/orders/get-order , https://docs.polymarket.com/developers/CLOB/clients/methods-private
- **There is no client-supplied order id.** Orders are keyed by a Polymarket-generated **order id = the EIP-712 order hash**. `getOpenOrders` filters only by market/asset, **not** by an arbitrary client id. So you cannot "look up by my id" as written.
- **Idempotency is achievable via the salt, not a client id.** The signed order struct includes **`salt`** (random uint256 for uniqueness) plus maker/signer/tokenId/makerAmount/takerAmount/side/expiration/signatureType. The order id/hash is deterministic in these fields. If you **persist the salt (and all order fields) before sending and reuse the identical salt on retry, you regenerate the identical order hash**, which you can then look up with `getOrder(hash)` — and a duplicate submission of the same signed order is rejected server-side (observed error `INVALID_ORDER_DUPLICATED`). Sources: https://github.com/Polymarket/ctf-exchange/blob/main/src/exchange/libraries/OrderStructs.sol , https://docs.polymarket.com/developers/CLOB/orders/create-order (third-party corroboration of the duplicate rejection). **V2 struct fields are UNVERIFIED** (some third-party sources claim V2 replaces `nonce` with a millisecond `timestamp` and adds `metadata`/`builder`) — confirm against clob-client-v2 before relying on exact field names.

**Verdict: MISMATCH (mechanism), but the goal is achievable.** No arbitrary client order id and no filter-by-client-id lookup. Idempotency must be built on a **deterministic order hash derived from a persisted salt**, not on a client id we invent.

**Implication for our contract.**
- Rewrite §4.3: our "client-generated id" becomes **"deterministic order hash from a persisted order (salt + all fields)."** Compute and store the order hash locally *before* the network send.
- Retry path: on timeout, call **`getOrder(orderHash)`** (and/or `getOpenOrders` for the market and match on id). If present → already placed, do not resend. If absent → resend the **byte-identical signed order** (same salt) so the exchange's duplicate-detection is the final backstop.
- Persist salt + full order struct + computed hash atomically with the "intent to send" record.

---

## 3. Partial-fill reporting

**Assumption.** We account positions by ACTUALLY-filled size.

**What the API actually does.**
- **Order object carries fill state directly:** `getOrder` / `getOpenOrders` return `id, status, market, asset_id, side, original_size, size_matched, price, outcome, order_type, expiration, associate_trades, created_at`. **Filled = `size_matched`; remaining = `original_size - size_matched`.** Source: https://docs.polymarket.com/developers/CLOB/orders/get-order
- **Trades/fills endpoint:** `getTrades` (paginated via `getTradesPaginated`), fields `id, taker_order_id, maker_orders[], market, asset_id, side, size, price, fee_rate_bps, status, match_time, last_update, outcome, trader_side, transaction_hash`. Source: https://docs.polymarket.com/developers/CLOB/clients/methods-private
- **Websocket USER channel** streams live order/trade updates for push-based fill tracking (avoids polling). **UNVERIFIED** on exact channel name/payload — confirm in clob-client-v2 docs.
- **Avg fill price:** not a single field. `price` on the order is the *limit* price; realized average must be computed from `getTrades` (`size`,`price` per fill) or inferred. There is a known caveat (py-clob-client issue #245) that **`size_matched` can slightly overstate the actual on-chain token balance received** due to rounding/fees — so for true position accounting, reconcile against trades and/or on-chain ERC-1155 balance. Source: https://github.com/Polymarket/py-clob-client/issues/245

**Verdict: MATCHES.** Partial fills are first-class: poll the order for `size_matched`/`original_size`, or pull `getTrades` for per-fill detail, or subscribe to the user websocket.

**Implication for our contract.**
- Account filled size from **`size_matched`** for fast in-loop decisions, but treat it as *approximate*; **reconcile realized fills and average price from `getTrades`** (sum of `size`, size-weighted `price`) and, for money-correctness, against the on-chain token balance before booking P&L.
- Prefer the **user websocket** for the 15s/45s windows to detect fills without hammering the REST poll; keep a REST poll as fallback.

---

## 4. Redemption flow

**Assumption.** After resolution, auto-redeem winning tokens (batch, hourly), account gas.

**What the API actually does.**
- **Redemption is ON-CHAIN, not a CLOB API call.** After the oracle reports payouts to the CTF contract, holders call **`redeemPositions`** on the Conditional Tokens Framework contract; it burns the outcome tokens and returns collateral. Sources: https://docs.polymarket.com/developers/CTF/redeem , third-party corroboration https://robottraders.io/blog/polymarket-auto-redeem-python
- **Parameters:** `collateralToken` (Polymarket collateral, e.g. USDC.e / pUSD address `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` per docs), `parentCollectionId` = `0x000…000` (32 zero bytes) always for Polymarket, `conditionId` (market condition id), `indexSets` (array, e.g. `[1,2]` to redeem both outcomes). **No `amount` param — it redeems your entire balance for the condition.** Source: https://docs.polymarket.com/developers/CTF/redeem
- **Neg-risk markets use a different path:** a **neg-risk adapter** (`redeemPositions`/`redeemNegRiskPositions` on the adapter, not the raw CTF) handles multi-outcome markets, and newer adapters auto-wrap collateral to pUSD and return it to your wallet. So you must branch on `negRisk` per market. **Partially UNVERIFIED** on exact adapter function signature.
- **Chain & gas:** Polygon; gas paid in **POL (MATIC)**. A **gasless/relayer** path exists for proxy wallets (POLY_PROXY / Safe / POLY_1271) — **UNVERIFIED** whether it covers redemption specifically.
- **No batching primitive documented for `redeemPositions` across conditions** — each condition is redeemed by its own call. "Batch, hourly" for us means *loop N calls*, not one multicall (unless we add our own multicall contract). **UNVERIFIED** whether a native batch/multicall is exposed.

**Verdict: MATCHES (with additions the spec omits).** Redemption works as assumed (on-chain, gas-accounted) but the spec under-specifies it.

**Implication for our contract.**
- Redeem is an **on-chain executor path** (viem/ethers), separate from the CLOB client. Need: condition id, `indexSets`, correct collateral address, and a **negRisk branch** (CTF vs neg-risk adapter).
- Account gas in **POL**, not USDC; ensure the wallet holds POL. Evaluate the **relayer/gasless** path to avoid holding gas.
- "Batch hourly" = iterate resolved conditions and call redeem per condition; there is **no free position amount to choose** (whole-balance redemption). Track which conditions are already redeemed to stay idempotent (a re-call on a zero balance just wastes gas).

---

## 5. Minimum order size + price tick

**Assumption.** Depth-clamp + ±1¢ limit tolerance must match exchange constraints. Need min order size and tick.

**What the API actually does.**
- **Tick size is per-market**, one of **`0.1, 0.01, 0.001, 0.0001` (and `0.0025` appears in one docs listing)**. Fetch via **`getTickSize(tokenId)`** / market info (`minimum_tick_size` on the market object). The engine **rejects** orders whose price violates the tick. Sources: https://docs.polymarket.com/api-reference/market-data/get-tick-size , https://docs.polymarket.com/trading/orders/overview
- **Minimum order size is per-market**, exposed as `minimum_order_size` / `min_order_size` on the market/orderbook object; retrieve via `getClobMarketInfo` / market info. No single global constant is documented. Orders below it are rejected. Sources: https://docs.polymarket.com/developers/CLOB/orders/overview , search of docs market-data. **Exact numeric floor is UNVERIFIED** — historically Polymarket has used a small floor (on the order of a few shares / ~$1 notional), but because it is market-specific we must read it live, not hardcode.
- Practical consequence for **$5–$50 orders**: at tick `0.01`, a **±1¢ tolerance = exactly ±1 tick** — meaningful but the *tightest possible* band (you can only move one price level). On a market with a **coarser 0.025 or 0.1 tick**, a ±1¢ tolerance is **sub-tick → meaningless / unsatisfiable** (no valid price 1¢ away). On finer ticks (0.001) it's 10 ticks, plenty.

**Verdict: MISMATCH (risk).** The assumption that ±1¢ and our depth-clamp are universally valid is **not safe**: min size and tick are per-market, and a fixed 1¢ tolerance degenerates on coarse-tick markets.

**Implication for our contract.**
- **Fetch `tickSize` and `minimum_order_size` per market at order-build time** (cache per market/session). Do not hardcode.
- **Round/clamp our limit price to the market tick** before signing; reject/skip if our ±1¢ band spans **< 1 tick** (coarse-tick market) or would round to a crossing price.
- Enforce our own **min-notional check against the market's `minimum_order_size`** before sending, especially for the small end ($5). Depth-clamp must also respect min size (don't clamp below the floor).

---

## Cross-cutting confirmations

- **Auth model — CONFIRMED.** Two levels. **L1** = one-time EIP-712 wallet signature to create/derive credentials, returns `apiKey` (UUID) + `secret` (base64) + `passphrase`. **L2** = per-request **HMAC-SHA256** over `timestamp + METHOD + path + body` using the L1-derived secret; all order placement/lookup/cancel is L2. `signatureType`: **0 = EOA, 1 = POLY_PROXY (Magic/email), 2 = GNOSIS_SAFE, 3 = POLY_1271 (deposit wallet, recommended for new API users).** Source: https://docs.polymarket.com/api-reference/authentication (Note: our spec's "signatureType 2 = poly proxy" numbering is stale — proxy is **1**, Safe is **2**.)
- **Rate limits — NON-ISSUE for us.** `POST /order` documented at ~**3,500 / 10s burst** and ~**36,000 / 10 min** sustained; general CLOB ~9,000 / 10s. Over-limit is throttled/queued, not hard-rejected. Our **20 orders/hour** cap is ~3 orders/min of headroom vs. thousands allowed — no concern. Source: https://docs.polymarket.com/quickstart/introduction/rate-limits (burst figures corroborated by third-party https://agentbets.ai/guides/polymarket-rate-limits-guide/ — **treat exact numbers as approximate**).
- **SDK version / maintenance:** `@polymarket/clob-client-v2` **1.0.8**, last modified 2026-07-09 (active). Old `@polymarket/clob-client` v5.8.2 archived/dead. `@polymarket/ts-sdk` beta.

---

## Contract changes to make now (still paper)

1. **Target `@polymarket/clob-client-v2` (viem), not `@polymarket/clob-client`.** The latter is archived and non-functional. Re-verify all method/field names in §1–5 against clob-client-v2's actual TypeScript types (Polymarket's public docs still describe the old surface).
2. **Split the TIF strategy by window.** Use **native GTD** only for pre-match (~10min): `expiration = now + 60 + lifetime`. For **45s live entries and 15s exits, GTD is unusable (≈60s security buffer)** — use **GTC + client-side timer + explicit cancel + log**. Update the Executor contract to carry a per-order `expiryMode: native-GTD | client-cancel`.
3. **Rewrite idempotency (§4.3).** Replace "our client-generated id" with **"deterministic order hash from a persisted salt + full order struct."** Compute/store the hash before send; on timeout, `getOrder(hash)` before any resend; resend byte-identical (same salt) so server duplicate-detection backstops us. There is **no arbitrary client id and no filter-by-client-id lookup.**
4. **Fill accounting from `size_matched`, reconciled by `getTrades` (+ on-chain balance).** Treat `size_matched` as approximate (known slight overstatement); compute realized avg price from trades. Prefer the **user websocket** in short windows, REST poll as fallback.
5. **Fetch `tickSize` + `minimum_order_size` per market; clamp price to tick; guard the ±1¢ band.** Reject/skip when ±1¢ < 1 tick (coarse-tick markets) and when notional < market min. Depth-clamp must respect the min-size floor. Do not hardcode either value.
6. **Add an on-chain redemption path (viem/ethers), separate from the CLOB client.** Branch **CTF `redeemPositions` vs neg-risk adapter** on `negRisk`; params = collateral addr + `parentCollectionId=0x0` + `conditionId` + `indexSets`; whole-balance (no amount). Account gas in **POL**; track already-redeemed conditions for idempotency; evaluate the gasless relayer.
7. **Fix `signatureType` numbering** in our spec: proxy = **1**, Safe = **2**, deposit/POLY_1271 = **3** (spec currently mislabels 2 as proxy). Pick the type that matches our funding wallet.

### Open items to verify against clob-client-v2 source before build (currently UNVERIFIED)
- V2 order struct fields (is `nonce` replaced by ms `timestamp`? new `metadata`/`builder`?).
- Exact GTD minimum-future-expiry (docs "≥10s" vs third-party "≥3min") and whether the 60s buffer is exact.
- User websocket channel name/payload for fills.
- Neg-risk redeem function signature and whether any native batch/multicall redeem exists.
- Whether the relayer/gasless path covers redemption.
- Exact relationship between `@polymarket/clob-client-v2` and the `@polymarket/ts-sdk` monorepo.
