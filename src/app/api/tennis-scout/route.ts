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
    // ?report=funnel → the live entry funnel (why the loop is holding fire, per match).
    if (url.searchParams.get("report") === "funnel") {
      const trading = await import("@/lib/tennisTrading");
      const f = trading.buildTennisFunnel(getDb());
      if (format === "json") return NextResponse.json(f);
      return new NextResponse(trading.tennisFunnelMarkdown(f), { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    }
    // ?report=prop_liquidity → PMV Stage-0 Gate 0.1: prop book-depth survey (build-vs-park decision).
    if (url.searchParams.get("report") === "prop_liquidity") {
      const rep = scout.buildTennisPropLiquidity(getDb());
      if (format === "json") return NextResponse.json(rep);
      return new NextResponse(scout.tennisPropLiquidityMarkdown(rep), { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    }
    // ?report=pmv_freq → P2 diagnosis: actual 3-set + hold rates from our snapshots vs the model.
    if (url.searchParams.get("report") === "pmv_freq") {
      const pmv = await import("@/lib/tennisPmv");
      return NextResponse.json(pmv.buildTennisFrequencyReport(getDb()));
    }
    // ?report=pmv_settle_check → Option-A sim de-risk: dry-run the settlement path over finished
    // ATP/WTA matches (no bet touched) → do props resolve to won/lost or would they hang open?
    if (url.searchParams.get("report") === "pmv_settle_check") {
      const pmv = await import("@/lib/tennisPmv");
      return NextResponse.json(pmv.buildPmvSettleCheck(getDb()));
    }
    // ?report=pmv_brier → PMV core success criterion: Brier of the Markov prob vs the implied mid.
    if (url.searchParams.get("report") === "pmv_brier") {
      const pmv = await import("@/lib/tennisPmv");
      return NextResponse.json(pmv.buildPmvBrierReport(getDb()));
    }
    // ?report=pmv_bets → audit export: every PMV entry with full provenance (+ anti-Draw flags). csv|json.
    if (url.searchParams.get("report") === "pmv_bets") {
      const pmv = await import("@/lib/tennisPmv");
      const rep = pmv.buildPmvBetsReport(getDb());
      if (format === "csv") return new NextResponse(pmv.pmvBetsCsv(rep), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="pmv-bets.csv"` } });
      return NextResponse.json(rep);
    }
    // ?report=calibration → Part B recovery-vs-no-recovery split (calibrates K / floor / take buffer).
    if (url.searchParams.get("report") === "calibration") {
      if (format === "csv") return new NextResponse(scout.tennisCalibrationCsv(getDb()), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="tennis-calibration.csv"` } });
      const rep = scout.buildTennisCalibrationReport(getDb());
      if (format === "json") return NextResponse.json(rep);
      return new NextResponse(scout.tennisCalibrationMarkdown(rep), { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
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
