import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as RR from "../src/lib/realRepo.js";
import {
  operatorStop, setOperatorModeControl, clearAutoPauseControl,
  whitelistAddControl, whitelistToggleControl, setCapsControl, ON_CONFIRM_PHRASE, authorizeControl,
} from "../src/lib/executor/realControl.js";

const NOW = "2026-07-15T12:00:00.000Z";
function db() { const d = openDb(":memory:"); initSchema(d); return d; }

// A helper to run a block with a fixed REAL_TRADING env (control fns read process.env directly).
function withEnv(v: string | undefined, fn: () => void) {
  const prev = process.env.REAL_TRADING;
  if (v === undefined) delete process.env.REAL_TRADING; else process.env.REAL_TRADING = v;
  try { fn(); } finally { if (prev === undefined) delete process.env.REAL_TRADING; else process.env.REAL_TRADING = prev; }
}

function workingOrder(d: any, id: string) {
  RR.insertRealOrder(d, { id, client_order_id: id, exchange_order_id: `ex-${id}`, decision_id: `dec-${id}`, strategy_id: "overreaction", profile_id: "medium", match_id: "m1", token_id: "tok1", side: "BUY", leg: "entry", limit_price_cents: 45, size_usd: 30, tif_sec: 45, code_version: "e", whitelist_version: 1, note: null, created_at: NOW });
  RR.transitionRealOrder(d, id, "placed", NOW, {});
}

// ── [STOP] ────────────────────────────────────────────────────────────────────
test("operatorStop: mode→off, cancels every working order, raises orphan alert, logs who/what", () => {
  const d = db();
  workingOrder(d, "o1"); workingOrder(d, "o2");
  const r = operatorStop(d, "owner", NOW);
  assert.equal(r.ok, true);
  assert.equal(RR.getOperatorMode(d), "exits_only", "A5: STOP floors at exits_only (positions keep exit management), not off");
  const statuses = ["o1", "o2"].map((id) => (d.prepare(`SELECT status FROM real_orders WHERE id=?`).get(id) as any).status);
  assert.deepEqual(statuses, ["cancelled", "cancelled"], "both working orders cancelled");
  assert.ok(RR.getRealOrphanAlert(d), "orphan alert set (positions ride under exits-only)");
  assert.match(r.note, /отменено висящих: 2 из 2/, "reports N of M, not just attempted");
  const log = RR.listControlLog(d, 10);
  assert.equal(log[0].action, "stop");
  assert.equal(log[0].actor, "owner");
  const det = JSON.parse(String(log[0].detail));
  assert.deepEqual(det, { attempted: 2, cancelled: 2, failed: 0, mode: "exits_only" }, "logs the greedy tally + the floor mode");
});

test("operatorStop: greedy — transitions that throw do NOT abort the sweep; STOP still returns ok + a tally", () => {
  const d = db();
  workingOrder(d, "o1"); workingOrder(d, "o2"); workingOrder(d, "o3");
  // Force every transition to throw at the event-append step (drop its table). The sweep must swallow
  // each failure, keep going, and report {attempted:3, failed:3} — never propagate and never half-stop.
  d.prepare(`DROP TABLE real_order_events`).run();
  const r = operatorStop(d, "owner", NOW);
  assert.equal(r.ok, true, "STOP never throws, even when the whole sweep fails");
  assert.match(r.note, /отменено висящих: 0 из 3, 3 не удалось/, "honest N-of-M with failures surfaced");
  const det = JSON.parse(String(RR.listControlLog(d, 5)[0].detail));
  assert.deepEqual(det, { attempted: 3, cancelled: 0, failed: 3, mode: "exits_only" });
});

test("operatorStop: idempotent — a second press cancels nothing new and still logs", () => {
  const d = db();
  workingOrder(d, "o1");
  operatorStop(d, "owner", NOW);
  const r2 = operatorStop(d, "owner", NOW);
  assert.equal(r2.ok, true);
  assert.match(r2.note, /отменено висящих: 0/);
});

// ── mode switch: loosening needs confirm; env is the ceiling ────────────────────
test("setOperatorModeControl: a non-'on' loosening needs a single confirm; a confirmed loosen writes", () => {
  withEnv("on", () => {
    const d = db();
    // tighten first (no confirm needed) so the effective/before mode is off.
    const t = setOperatorModeControl(d, "off", false, "owner", NOW);
    assert.equal(t.ok, true);
    assert.equal(RR.getOperatorMode(d), "off");
    // now loosen off→dry_run WITHOUT confirm → refused, nothing written.
    const refuse = setOperatorModeControl(d, "dry_run", false, "owner", NOW);
    assert.equal(refuse.ok, false);
    assert.equal(refuse.needConfirm, true);
    assert.equal(RR.getOperatorMode(d), "off", "still off — loosen not applied without confirm");
    // with confirm → applied.
    const ok = setOperatorModeControl(d, "dry_run", true, "owner", NOW);
    assert.equal(ok.ok, true);
    assert.equal(RR.getOperatorMode(d), "dry_run");
    assert.match(ok.note, /режим→dry_run/);
  });
});

test("setOperatorModeControl: 'on' is the STRONG barrier — a bare confirm is NOT enough, only the typed phrase arms it", () => {
  withEnv("on", () => {
    const d = db();
    // a click (even confirm:true) is refused for on — needPhrase, nothing written.
    const click = setOperatorModeControl(d, "on", true, "owner", NOW);
    assert.equal(click.ok, false);
    assert.equal(click.needConfirm, undefined, "not a plain confirm — it's a phrase gate");
    assert.equal(click.needPhrase, true);
    assert.equal(RR.getOperatorMode(d), null, "real money NOT armed by a click");
    // a wrong phrase is refused too.
    const wrong = setOperatorModeControl(d, "on", true, "owner", NOW, "on");
    assert.equal(wrong.ok, false);
    assert.equal(wrong.needPhrase, true);
    assert.equal(RR.getOperatorMode(d), null);
    // the exact phrase (case/space-insensitive) arms it — confirm irrelevant.
    const armed = setOperatorModeControl(d, "on", false, "owner", NOW, `  ${ON_CONFIRM_PHRASE.toLowerCase()} `);
    assert.equal(armed.ok, true);
    assert.equal(RR.getOperatorMode(d), "on");
    const det = JSON.parse(String(RR.listControlLog(d, 5).find((e) => e.action === "set_mode")!.detail));
    assert.equal(det.phrase, "✓ typed", "log records the phrase gate was cleared");
  });
});

test("setOperatorModeControl: tightening never needs confirm", () => {
  withEnv("on", () => {
    const d = db();
    const r = setOperatorModeControl(d, "exits_only", false, "owner", NOW);
    assert.equal(r.ok, true, "on→exits_only is tightening — applied straight away");
    assert.equal(RR.getOperatorMode(d), "exits_only");
  });
});

test("setOperatorModeControl: env caps the request — asking for 'on' under env=dry_run only reaches dry_run", () => {
  withEnv("dry_run", () => {
    const d = db();
    const r = setOperatorModeControl(d, "on", false, "owner", NOW, ON_CONFIRM_PHRASE);
    assert.equal(r.ok, true);
    assert.equal(RR.getOperatorMode(d), "on", "operator override stored as requested…");
    assert.match(r.note, /действует dry_run/, "…but the effective note reflects the env ceiling");
    const log = RR.listControlLog(d, 5).find((e) => e.action === "set_mode")!;
    const detail = JSON.parse(String(log.detail));
    assert.equal(detail.target, "on");
    assert.equal(detail.after, "dry_run", "logged before/after captures the clamp");
  });
});

test("setOperatorModeControl: an unknown mode is rejected", () => {
  const d = db();
  const r = setOperatorModeControl(d, "nonsense", true, "owner", NOW);
  assert.equal(r.ok, false);
  assert.equal(RR.getOperatorMode(d), null);
});

// ── clear auto-pause ────────────────────────────────────────────────────────────
test("clearAutoPauseControl: lifts the sticky pause and logs it", () => {
  const d = db();
  RR.setRealAutoPause(d, "daily loss", NOW);
  assert.ok(RR.getRealAutoPause(d));
  const r = clearAutoPauseControl(d, "owner", NOW);
  assert.equal(r.ok, true);
  assert.equal(RR.getRealAutoPause(d), null, "pause cleared");
  assert.equal(RR.listControlLog(d, 5)[0].action, "clear_pause");
});

// ── whitelist ───────────────────────────────────────────────────────────────────
test("whitelistAddControl: adds a versioned row and logs it; whitelistToggleControl toggles + logs", () => {
  const d = db();
  const add = whitelistAddControl(d, { strategyId: "overreaction", categories: ["epl"], maxOrderUsd: 25, enabled: false }, "owner", NOW);
  assert.equal(add.ok, true);
  assert.equal(RR.currentWhitelistVersion(d), 1);
  assert.equal(RR.listControlLog(d, 5)[0].action, "whitelist_add");
  const row = RR.listWhitelist(d)[0];
  assert.equal(row.enabled ? 1 : 0, 0, "added disabled by default");
  const tog = whitelistToggleControl(d, row.id, true, "owner", NOW);
  assert.equal(tog.ok, true);
  assert.equal(RR.listWhitelist(d, true).length, 1, "now enabled");
  assert.equal(RR.listControlLog(d, 5)[0].action, "whitelist_toggle");
});

test("whitelistAddControl: an over-cap row is rejected (belt survives the control layer)", () => {
  const d = db();
  const r = whitelistAddControl(d, { strategyId: "overreaction", categories: ["epl"], maxOrderUsd: 9999, enabled: false }, "owner", NOW);
  assert.equal(r.ok, false, "> REAL_MAX_ORDER_USD rejected by addWhitelistRow");
  assert.equal(RR.currentWhitelistVersion(d), 0, "nothing written");
});

// ── caps override ────────────────────────────────────────────────────────────────
test("setCapsControl: merges only valid (>0) keys over the existing override and logs before/after", () => {
  const d = db();
  const r1 = setCapsControl(d, { maxOrderUsd: 20, maxExposureUsd: 100 }, "owner", NOW);
  assert.equal(r1.ok, true);
  assert.deepEqual(RR.getCapsOverride(d), { maxOrderUsd: 20, maxExposureUsd: 100 });
  // a second edit merges (keeps maxExposureUsd), ignores non-positive/NaN.
  const r2 = setCapsControl(d, { maxOrderUsd: 30, maxDailyLossUsd: 0, maxOrdersPerHour: NaN as any }, "owner", NOW);
  assert.equal(r2.ok, true);
  assert.deepEqual(RR.getCapsOverride(d), { maxOrderUsd: 30, maxExposureUsd: 100 }, "merged; 0 and NaN dropped");
  const log = RR.listControlLog(d, 5).find((e) => e.action === "set_caps")!;
  const detail = JSON.parse(String(log.detail));
  assert.equal(detail.after.maxOrderUsd, 30);
});

test("setCapsControl: no valid values → rejected, nothing written", () => {
  const d = db();
  const r = setCapsControl(d, { maxOrderUsd: -5, maxExposureUsd: 0 }, "owner", NOW);
  assert.equal(r.ok, false);
  assert.deepEqual(RR.getCapsOverride(d), {});
});

test("setCapsControl override flows into resolveSafetyCaps (the belt reads it)", async () => {
  const { resolveSafetyCaps } = await import("../src/lib/executor/safety.js");
  withEnv("dry_run", () => {
    const d = db();
    setCapsControl(d, { maxOrderUsd: 12 }, "owner", NOW);
    const caps = resolveSafetyCaps(d, process.env);
    assert.equal(caps.maxOrderUsd, 12, "override wins over env/default for the resolved cap");
  });
});

// ── A2 (audit #1): auth on the control surface ────────────────────────────────
test("authorizeControl: only the exact Bearer token passes; missing/wrong → denied, no server token → disabled", () => {
  const env = { REAL_CONTROL_TOKEN: "s3cret-owner-token" };
  assert.equal(authorizeControl("Bearer s3cret-owner-token", env).ok, true, "exact token → ok");
  assert.equal(authorizeControl("Bearer wrong", env).reason, "bad_token");
  assert.equal(authorizeControl("s3cret-owner-token", env).reason, "bad_token", "must be a Bearer scheme");
  assert.equal(authorizeControl(null, env).reason, "bad_token", "missing header → denied");
  assert.equal(authorizeControl("Bearer ", env).reason, "bad_token");
  // Fail-CLOSED: no server token means control is disabled, not open.
  assert.equal(authorizeControl("Bearer anything", {}).reason, "no_server_token");
  assert.equal(authorizeControl("Bearer anything", { REAL_CONTROL_TOKEN: "  " }).reason, "no_server_token", "blank token = unset");
  // Case-insensitive scheme, trims.
  assert.equal(authorizeControl("bearer  s3cret-owner-token ", env).ok, true);
});
