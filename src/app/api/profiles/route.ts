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
    // ?report=pm_resolution → Decision-1 condition-1: settle Polymarket-only (score-less) finished fixtures
    // from PM resolution. Default returns the LAST stored sweep summary (read-only); &run=1 RUNS the sweep
    // now and returns it — an on-demand validation independent of the (slow/dormant) auto cycle.
    if (new URL(req.url).searchParams.get("report") === "pm_resolution") {
      const url = new URL(req.url);
      // &probe=1 — validate the Gamma resolver against REAL resolved football tokens from the DB (read-only,
      // no settle). Confirms fetchTokenResolution returns a sensible closed flag + resolved price before any FT
      // entry relies on it — the resolver never runs in the sweep while candidates=0.
      if (url.searchParams.get("probe") === "1") {
        const R = await import("@/lib/repo");
        const { loadPolymarketConfig } = await import("@/lib/polymarket");
        // Find ONE real resolved football token, then hit several Gamma endpoint variants RAW so we can see
        // exactly what the API returns (status + a body snippet) and fix the resolver against ground truth.
        let token: string | null = null, label = "", match = "";
        outer: for (const c of R.listCompetitions(db).filter((x) => x.sport_id === "football")) {
          for (const m of R.listMatches(db, c.id)) {
            if (m.state !== "finished") continue;
            for (const mk of R.latestMarkets(db, m.id)) if (mk.external_ref) { token = mk.external_ref; label = mk.label; match = `${m.home}—${m.away}`; break outer; }
          }
        }
        if (!token) return NextResponse.json({ ok: true, probe: "no finished football market with a token found" });
        const poly = loadPolymarketConfig(process.env);
        const variants = [
          `${poly.gammaBase}/markets?clob_token_ids=${encodeURIComponent(token)}`,
          `${poly.gammaBase}/markets?clob_token_ids=${encodeURIComponent(token)}&closed=true`,
        ];
        const probes: any[] = [];
        for (const u of variants) {
          try {
            const r = await fetch(u);
            const body = await r.text();
            probes.push({ url: u, status: r.status, ok: r.ok, bodyLen: body.length, bodySnippet: body.slice(0, 600) });
          } catch (e) { probes.push({ url: u, error: e instanceof Error ? e.message : String(e) }); }
        }
        return NextResponse.json({ ok: true, token, label, match, gammaEnabled: poly.enabled, probes });
      }
      if (url.searchParams.get("run") === "1") {
        const { settlePmResolutionBets } = await import("@/lib/pmResolution");
        const { loadPolymarketConfig } = await import("@/lib/polymarket");
        const result = await settlePmResolutionBets(db, { polymarket: loadPolymarketConfig(process.env) });
        return NextResponse.json({ ok: true, ran: true, result });
      }
      const { metaGet } = await import("@/lib/repo");
      let last: unknown = null; try { last = JSON.parse(metaGet(db, "pm_resolution_last") ?? "null"); } catch { last = null; }
      return NextResponse.json({ ok: true, ran: false, last, hint: "add &run=1 to run the sweep now" });
    }
    // ?report=pmv_shadow_calibration → tennis PMV flag-only shadow scoring (Brier markov vs implied on
    // frozen-mid, win%-vs-theo, unresolved share) — the «немой ноль» fix. Read-only.
    if (new URL(req.url).searchParams.get("report") === "pmv_shadow_calibration") {
      const { buildPmvShadowCalibration } = await import("@/lib/tennisPmvShadow");
      return NextResponse.json({ ok: true, calibration: buildPmvShadowCalibration(db) });
    }
    // ?report=sv_shadow_calibration → set_value flag-only cohort: measured P(comeback) vs the 0.5 constant,
    // binned by frozen favourite strength × ATP/WTA, price-path drawdown/take. Read-only (§P1.1).
    if (new URL(req.url).searchParams.get("report") === "sv_shadow_calibration") {
      const { buildSvShadowCalibration } = await import("@/lib/tennisSetValueShadow");
      return NextResponse.json({ ok: true, calibration: buildSvShadowCalibration(db) });
    }
    // ?report=sv_cohort → P1.1 measured comeback rate: retro (from snapshot history) + shadow (frozen
    // forward), binned by frozen favourite strength × ATP/WTA — the number that replaces the 0.5 constant.
    if (new URL(req.url).searchParams.get("report") === "sv_cohort") {
      const { buildSvCohort } = await import("@/lib/tennisSetValueShadow");
      return NextResponse.json({ ok: true, cohort: buildSvCohort(db) });
    }
    // ?report=sv_sizing_audit → per-profile set_value sizing on one fixed setup (P0.6): the knobs +
    // stake each profile would size, with an inversion flag if a "lite" profile outsizes "aggressive".
    if (new URL(req.url).searchParams.get("report") === "sv_sizing_audit") {
      const { buildSvSizingAudit } = await import("@/lib/svSizingAudit");
      return NextResponse.json({ ok: true, audit: buildSvSizingAudit(db) });
    }
    // ?report=unfillable_edge → P2 execution diagnostic: how many football edge signals fired, how many were
    // FILLABLE, and why the rest weren't (league × strategy × reason) + coverage-tier recommendation + the F3
    // model-vs-market side check on non-zombie fills. Optional &days=N window (default 14). Read-only.
    if (new URL(req.url).searchParams.get("report") === "unfillable_edge") {
      const { buildUnfillableEdge } = await import("@/lib/unfillableEdge");
      const daysRaw = Number(new URL(req.url).searchParams.get("days"));
      const windowDays = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined;
      return NextResponse.json({ ok: true, report: buildUnfillableEdge(db, { windowDays }) });
    }
    // ?report=schedule_gaps → scheduler sleep-window monitor: recorded gaps (count, longest, last, recent list)
    // where the in-process loop was down and deterministic stops sat unmanaged / ran at the gap bottom on wake.
    if (new URL(req.url).searchParams.get("report") === "schedule_gaps") {
      const { scheduleGapSummary, gapRepriceSummary } = await import("@/lib/scheduleGap");
      // gaps = the recorded sleep windows; reprice = the P0.6 protective-exit window's SELF-MEASUREMENT
      // (delta saved/cost vs the gap bottom, with the pre-set verdict criterion).
      return NextResponse.json({ ok: true, gaps: scheduleGapSummary(db), reprice: gapRepriceSummary(db) });
    }
    // ?report=pmv_exit_counterfactual → F4: for every early-closed prematch_value bet, actual P&L vs
    // hold-to-settle (the real settle grade on the final score), cut by exit reason × market family with a
    // pre-set «держать было лучше на ≥15% оборота при n≥30» flag, plus opposite-outcome twin divergences.
    if (new URL(req.url).searchParams.get("report") === "pmv_exit_counterfactual") {
      const { buildPmvExitCounterfactual } = await import("@/lib/pmvExitCounterfactual");
      return NextResponse.json({ ok: true, report: buildPmvExitCounterfactual(db) });
    }
    // ?report=reassess_efficiency → F5: re-measure the P0.4 «LLM-мельница» ratio post-gate — cumulative
    // strategist calls vs deterministic gate skips, calls per traded match against the 26–42 baseline band.
    // ?report=reassess_audit → Z4 (batch-5): reassess-throttle MEASUREMENT — storm composition by trigger
    // + a conservative count of executed exits the proposed throttle might have skipped (gate: must be 0).
    if (new URL(req.url).searchParams.get("report") === "reassess_audit") {
      const { buildReassessAudit } = await import("@/lib/reassessAudit");
      return NextResponse.json({ ok: true, audit: buildReassessAudit(getDb()) });
    }
    if (new URL(req.url).searchParams.get("report") === "reassess_efficiency") {
      const { buildReassessEfficiency } = await import("@/lib/reassessEfficiency");
      return NextResponse.json({ ok: true, report: buildReassessEfficiency(db) });
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
