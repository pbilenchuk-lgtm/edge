// ============================================================
// EDGE LAB — single in-process lock for heavy engine cycles. [SERVER-ONLY]
//
// The scheduler (cron) and the manual HTTP triggers (discover / tick /
// refreshAllOdds) all run the same multi-minute lifecycle that touches
// odds / exits / entries. Running two at once doubles the DB / LLM / network
// load on one instance (a real 502 contributor on a small box). This module is
// the ONE lock they share so at most one heavy cycle runs at a time.
//
// A wedged job can't lock out the cron forever: the lock auto-expires after
// MAX_HOLD_MS so the scheduler recovers even if a release is somehow missed.
// ============================================================

const MAX_HOLD_MS = 15 * 60_000;
let heldSince = 0;
let owner = 0;    // token of the current holder (0 = free) — guards release
let counter = 0;  // monotonic, NEVER reset, so every acquire gets a unique token

/** Try to take the lock. Returns a non-zero OWNER TOKEN on success, else 0.
 *  Pass the token to releaseEngine so a holder whose lock was force-expired
 *  (a cycle that ran past MAX_HOLD) can't wipe the NEW holder's lock. */
export function tryAcquireEngine(): number {
  const now = Date.now();
  if (heldSince && now - heldSince < MAX_HOLD_MS) return 0;
  heldSince = now;
  owner = (counter = (counter % 2_000_000_000) + 1); // unique, monotonic, ≠ 0
  return owner;
}

/** Release only if `token` still owns the lock (or unconditionally when omitted,
 *  for legacy callers). A stale token — the lock was expiry-stolen and re-taken
 *  by someone else — is a no-op, so a slow cycle finishing late can't release a
 *  lock it no longer holds. */
export function releaseEngine(token?: number): void {
  if (token == null || token === owner) { heldSince = 0; owner = 0; }
}

export function engineIsBusy(): boolean {
  return heldSince !== 0 && Date.now() - heldSince < MAX_HOLD_MS;
}
