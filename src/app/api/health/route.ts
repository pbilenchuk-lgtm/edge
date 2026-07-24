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
