import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/profiles?report=pmv_origin_cut — judge football PMV cut by origin×family×epoch,
 * verdict metrics from decision-time provenance only, inferred rows quarantined to a diagnostic
 * block. Self-validating: refuses to be silent if the origin column is unmigrated. Read-only.
 */
export async function GET(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    if (new URL(req.url).searchParams.get("report") === "pmv_origin_cut") {
      const { buildPmvOriginCut } = await import("@/lib/pmvOriginCut");
      return NextResponse.json({ ok: true, cut: buildPmvOriginCut(db) });
    }
    return NextResponse.json({ ok: false, error: "unknown report" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/**
 * POST /api/profiles — risk-profile analytics (Blocks A–D) for a filter.
 * Body: { fromMs?, toMs?, competitionId?, strategyId?, phase?, codeVersion? }.
 * Also returns the filter vocabulary (categories, strategies, code versions) so the
 * tab can populate its selectors. Read-only, measurement-only.
 */
export async function POST(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const R = await import("@/lib/repo");
    const { profileAnalytics } = await import("@/lib/profileAnalytics");
    const db = getDb();
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const filter = {
      fromMs: Number.isFinite(body.fromMs) ? body.fromMs : undefined,
      toMs: Number.isFinite(body.toMs) ? body.toMs : undefined,
      competitionId: body.competitionId || undefined,
      strategyId: body.strategyId || undefined,
      phase: body.phase === "prematch" || body.phase === "live" ? body.phase : undefined,
      codeVersion: body.codeVersion || undefined,
    };
    const analytics = profileAnalytics(db, filter);
    const categories = R.listCompetitions(db).map((c) => ({ id: c.id, name: c.name }));
    const strategies = R.listStrategies(db).map((s) => ({ id: s.id, name: s.name }));
    return NextResponse.json({ ok: true, analytics, vocab: { categories, strategies } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
