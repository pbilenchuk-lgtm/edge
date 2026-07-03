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
