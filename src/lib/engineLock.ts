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

/** Try to take the lock. Returns false if another heavy cycle holds it. */
export function tryAcquireEngine(): boolean {
  const now = Date.now();
  if (heldSince && now - heldSince < MAX_HOLD_MS) return false;
  heldSince = now;
  return true;
}

export function releaseEngine(): void {
  heldSince = 0;
}

export function engineIsBusy(): boolean {
  return heldSince !== 0 && Date.now() - heldSince < MAX_HOLD_MS;
}
