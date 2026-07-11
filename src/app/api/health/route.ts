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
    const { listCompetitions, listStrategies, getTreasury } = await import("@/lib/repo");
    const db = getDb();
    const comps = listCompetitions(db);
    const strats = listStrategies(db);
    const treasury = getTreasury(db);
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
