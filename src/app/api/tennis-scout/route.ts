import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Tennis provider scouting (Stage 0) — parallel, observe-only. No money-path.
 *   GET  /api/tennis-scout?format=md|csv|json  → the scouting report from accumulated snapshots
 *   POST /api/tennis-scout                      → run ONE live poll now (needs API_TENNIS_KEY)
 */
export async function GET(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const scout = await import("@/lib/tennisScout");
    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "md";
    // ?report=breaks → the §4 panic-calibration report; &format=csv → per-break-mark rows.
    if (url.searchParams.get("report") === "breaks") {
      if (format === "csv") return new NextResponse(scout.tennisBreakMarksCsv(getDb()), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="tennis-break-marks.csv"` } });
      return NextResponse.json(scout.buildTennisBreakReport(getDb()));
    }
    const rep = scout.buildTennisScoutReport(getDb());
    if (format === "json") return NextResponse.json(rep);
    if (format === "csv") return new NextResponse(scout.tennisScoutCsv(rep), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="tennis-scout-${new Date().toISOString().slice(0, 10)}.csv"` } });
    return new NextResponse(scout.tennisScoutMarkdown(rep), { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST() {
  try {
    const { getDb } = await import("@/lib/db");
    const scout = await import("@/lib/tennisScout");
    const cfg = scout.loadTennisConfig();
    if (!cfg.enabled) return NextResponse.json({ ok: false, error: "API_TENNIS_KEY не задан — разведка выключена" }, { status: 400 });
    const written = await scout.collectTennisSnapshots(getDb());
    return NextResponse.json({ ok: true, written });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
