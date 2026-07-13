import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/profiles-export?type=bets-csv|bets-json|exits-csv&competitionId=&strategyId=&phase=&codeVersion=&fromMs=&toMs=
 * Downloadable flat export of the bet log for external analysis. Read-only.
 */
export async function GET(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const exp = await import("@/lib/profileExport");
    const url = new URL(req.url);
    const q = url.searchParams;
    const type = q.get("type") ?? "bets-csv";
    const filter = {
      fromMs: q.get("fromMs") ? Number(q.get("fromMs")) : undefined,
      toMs: q.get("toMs") ? Number(q.get("toMs")) : undefined,
      competitionId: q.get("competitionId") || undefined,
      strategyId: q.get("strategyId") || undefined,
      phase: (q.get("phase") as "prematch" | "live" | null) || undefined,
      codeVersion: q.get("codeVersion") || undefined,
    };
    const db = getDb();
    const date = new Date().toISOString().slice(0, 10);
    let body: string, ctype: string, name: string;
    if (type === "bets-json") { body = exp.betsJson(db, filter); ctype = "application/json; charset=utf-8"; name = `bets-${date}.json`; }
    else if (type === "exits-csv") { body = exp.exitsCsv(db, filter); ctype = "text/csv; charset=utf-8"; name = `exits-${date}.csv`; }
    else { body = exp.betsCsv(db, filter); ctype = "text/csv; charset=utf-8"; name = `bets-${date}.csv`; }
    return new NextResponse(body, { status: 200, headers: { "Content-Type": ctype, "Content-Disposition": `attachment; filename="${name}"` } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
