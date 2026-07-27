import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Foundation health check. Lazily touches the DB so the module graph never
 * imports node:sqlite at build time. Returns entity counts, or a clear hint
 * if the DB has not been seeded / the runtime flag is missing.
 */
export async function GET() {
  try {
    const { getDb } = await import("@/lib/db");
    const { listCompetitions, listStrategies, getTreasury, metaGet } = await import("@/lib/repo");
    const { scheduleGapSummary } = await import("@/lib/scheduleGap");
    const db = getDb();
    const comps = listCompetitions(db);
    const strats = listStrategies(db);
    const treasury = getTreasury(db);
    // Scheduler sleep-window monitor: surface any recorded gaps so an external uptime monitor (or a glance at
    // /api/health) sees when the in-process loop was down and stops sat unmanaged. Best-effort.
    let scheduleGaps: ReturnType<typeof scheduleGapSummary> | null = null;
    try { scheduleGaps = scheduleGapSummary(db); } catch { scheduleGaps = null; }
    // п.5-tail: cheap tennis scout link-rate signal so a mapping degradation ALERTS here (external monitor)
    // rather than being found in a batch of logs a week later. Best-effort; never blocks the health response.
    let tennisLinkRate: { inDiscoveryLinkPct: number | null; listable: number; degraded: boolean; windowDays: number } | null = null;
    try { const { tennisLinkRateHealth } = await import("@/lib/tennisScout"); const h = tennisLinkRateHealth(db); tennisLinkRate = { inDiscoveryLinkPct: h.inDiscoveryLinkPct, listable: h.listable, degraded: h.degraded, windowDays: h.windowDays }; } catch { tennisLinkRate = null; }
    // Turn Render's health pings into a deploy-independent cron heartbeat: if the
    // in-process scheduler has stalled (a redeploy/crash killed it), run a catch-up
    // auto-cycle. Fire-and-forget + internally locked/overdue-gated, so it never
    // blocks the health response and no-ops when the cron is healthy.
    void import("@/lib/scheduler").then((s) => s.heartbeat()).catch(() => {});
    return NextResponse.json({
      ok: true,
      treasury: treasury.total_balance,
      competitions: comps.length,
      strategies: strats.length,
      // count + longest recorded scheduler sleep window (0/none when the loop has stayed alive).
      scheduleGaps: scheduleGaps ? { count: scheduleGaps.count, longestSec: scheduleGaps.longestSec, last: scheduleGaps.last } : null,
      // Z2(b): running count of payout-inconsistent settles (decimal-shift class); >0 warrants a look.
      accountingSuspect: (() => { try { const n = Number(metaGet(db, "accounting_suspect_count") ?? 0); return { count: Number.isFinite(n) ? n : 0, last: (() => { try { return JSON.parse(metaGet(db, "accounting_suspect_last") ?? "null"); } catch { return null; } })() }; } catch { return { count: 0, last: null }; } })(),
      // Decision-1 condition-1: last PM-resolution settle sweep (PM-only fixtures + the backfilled open tail).
      pmResolution: (() => { try { return JSON.parse(metaGet(db, "pm_resolution_last") ?? "null"); } catch { return null; } })(),
      // Pre-F gate self-announces: the dry-fill verdict + all-time count, so a gate that passed weeks ago
      // (279 dry-fills, unnoticed) is visible at a glance instead of waiting for the 5th manual query.
      dryFill: await (async () => { try { const { buildDryFillWatch } = await import("@/lib/executor/dryFillWatch"); const w = buildDryFillWatch(db); return { verdict: w.verdict, allTime: w.dryFillsAllTime, inWindow: w.dryFillsInWindow, openDry: w.openDryPositions }; } catch { return null; } })(),
      // Overreaction sample gate self-announces its progress ("6/30") so the strategy-verdict readiness is
      // visible at a glance instead of living in chat memory. Full breakdown at ?report=overreaction_gate.
      overreactionGate: await (async () => { try { const { buildOverreactionGate } = await import("@/lib/overreactionGate"); const g = buildOverreactionGate(db); return { progress: g.progress, cleanCycles: g.cleanCycles, target: g.target, verdict: g.verdict }; } catch { return null; } })(),
      // [ratified #1] The void rate self-announces, next to the other gates. Built because the complement bug
      // was found by ACCIDENT: 225 bets sat booked as refunds while their markets had resolved, and no number
      // anywhere could have shouted. This does not detect that bug (it is fixed) — it detects the CLASS, «the
      // ledger has quietly drifted from reality», whatever the next cause turns out to be.
      voidWatch: await (async () => { try { const { buildVoidWatch } = await import("@/lib/voidWatch"); const v = buildVoidWatch(db); return { verdict: v.verdict, voidPct: v.voidPct, voids: v.voids, decided: v.decided, byReason: v.byReason, note: v.note }; } catch { return null; } })(),
      tennisLinkRate,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        hint: "Run `npm run db:seed` and start with NODE_OPTIONS=--experimental-sqlite (see package.json scripts).",
      },
      { status: 503 },
    );
  }
}
