import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/overreaction-latency?format=md|csv|json
 * MEASUREMENT SLICE (read-only): how much price Overreaction leaves on the table due to
 * the event→detection→LLM→fill lag. Answers the carve-out decision from historical
 * snapshots. No money-path, no runtime change.
 *   md  (default) → the markdown report
 *   csv           → per-case CSV (downloadable)
 *   json          → the full structured report
 */
export async function GET(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const rep = await import("@/lib/overreactionLatency");
    const format = new URL(req.url).searchParams.get("format") ?? "md";
    const db = getDb();
    const report = rep.buildOverreactionLatencyReport(db);
    const date = new Date().toISOString().slice(0, 10);
    if (format === "json") return NextResponse.json(report);
    if (format === "csv") {
      return new NextResponse(rep.latencyCasesCsv(report), {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="overreaction-latency-${date}.csv"` },
      });
    }
    return new NextResponse(rep.latencyReportMarkdown(report), { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
