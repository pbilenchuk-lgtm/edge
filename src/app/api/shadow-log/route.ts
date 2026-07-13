import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/shadow-log — the GLOBAL shadow-budget log as a downloadable markdown
 * document: config, current pool, roll-up analytics, projection, per-category /
 * per-strategy / per-phase breakdowns, and the FULL decision ledger across ALL
 * matches (not the 200-row UI cap). Read-only; for offline analytics + tuning.
 */
export async function GET() {
  try {
    const { getDb } = await import("@/lib/db");
    const { buildShadowLog } = await import("@/lib/shadowLog");
    const md = buildShadowLog(getDb());
    const name = `shadow-log-${new Date().toISOString().slice(0, 10)}.md`;
    return new NextResponse(md, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
