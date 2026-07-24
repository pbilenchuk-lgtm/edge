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
    // ?report=draw_empirics → B1 step 1: the EMPIRICAL pass over settled draw bets — did they resolve as a
    // 90'-draw contract MUST? Confirms/refutes the "HT vs 90'" contract model before any canon settles money.
    if (new URL(req.url).searchParams.get("report") === "draw_empirics") {
      const { buildDrawNotationEmpirics } = await import("@/lib/drawCanon");
      return NextResponse.json({ ok: true, empirics: buildDrawNotationEmpirics(db) });
    }
    // ?report=draw_canon → B1 step 2: the canonicalizer — pick the sum-consistent (market 1X2) draw book per
    // match, tag the rest "different condition"; quarantine when no candidate is coherent. Read-only.
    if (new URL(req.url).searchParams.get("report") === "draw_canon") {
      const { buildDrawCanon } = await import("@/lib/drawCanon");
      return NextResponse.json({ ok: true, report: buildDrawCanon(db) });
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
        const { fetchTokenResolution, loadPolymarketConfig } = await import("@/lib/polymarket");
        // Proof #1: a MULTI-MATCH ground-truth sample. ONE clear final-score market per finished football
        // fixture that HAS a real score, across up to 10 matches — so the resolver's verdict can be hand-checked
        // against reality (does resolution.priceCents ~0/~100 agree with the actual score?). Read-only (no settle).
        const samples: { token: string; label: string; match: string; score: string }[] = [];
        outer: for (const c of R.listCompetitions(db).filter((x) => x.sport_id === "football")) {
          for (const m of R.listMatches(db, c.id)) {
            if (m.state !== "finished" || m.score_home == null || m.score_away == null) continue; // need a real score to verify
            const mks = R.latestMarkets(db, m.id).filter((x) => x.external_ref);
            const pick = mks.find((x) => /over 2\.5|under 2\.5/i.test(x.label)) ?? mks[0]; // a clear totals leg if present
            if (pick?.external_ref) samples.push({ token: pick.external_ref, label: pick.label, match: `${m.home}—${m.away}`, score: `${m.score_home}:${m.score_away}` });
            if (samples.length >= 10) break outer;
          }
        }
        const map = await fetchTokenResolution(loadPolymarketConfig(process.env), samples.map((s) => s.token));
        return NextResponse.json({ ok: true, probe: samples.map((s) => ({ ...s, resolution: map[s.token] ?? null })) });
      }
      if (url.searchParams.get("run") === "1") {
        const { settlePmResolutionBets } = await import("@/lib/pmResolution");
        const { loadPolymarketConfig } = await import("@/lib/polymarket");
        const result = await settlePmResolutionBets(db, { polymarket: loadPolymarketConfig(process.env) });
        return NextResponse.json({ ok: true, ran: true, result });
      }
      const { metaGet } = await import("@/lib/repo");
      const { ftBlindCohort } = await import("@/lib/pmResolution");
      let last: unknown = null; try { last = JSON.parse(metaGet(db, "pm_resolution_last") ?? "null"); } catch { last = null; }
      // condition 2: the SEPARATE ft_blind verdict row (blind Polymarket-only positions — kept out of the
      // managed prematch_value metrics, measured on their own).
      return NextResponse.json({ ok: true, ran: false, last, ftBlind: ftBlindCohort(db), hint: "add &run=1 to run the sweep now" });
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
      const { buildSvCohort, svCohortAccrual } = await import("@/lib/tennisSetValueShadow");
      return NextResponse.json({ ok: true, cohort: buildSvCohort(db), accrual: svCohortAccrual(db, new Date().toISOString()) });
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
    // ?report=no_feed_coverage → P3/B2: link-rate over the current football cohort (covered = has a match_live
    // provider row, blind = Polymarket-listed with none), overall + per league + the euro cups against the ≥85%
    // target, "blind pairs × league × day", and a derived rejection reason per blind euro pair. Optional &days=N
    // (default 14). Read-only.
    if (new URL(req.url).searchParams.get("report") === "no_feed_coverage") {
      const url = new URL(req.url);
      // &probe=1 → live provider-probe: for each near-kickoff blind euro fixture, the ESPN board's closest-name
      // events, so canonicalization aliases are added from data (needs the provider; network).
      if (url.searchParams.get("probe") === "1") {
        const { buildNoFeedProbe } = await import("@/lib/noFeedCoverage");
        const { loadSportsProvider } = await import("@/lib/sports");
        const provider = loadSportsProvider();
        if (!provider) return NextResponse.json({ ok: false, error: "провайдер выключен (нет SPORTS_ENABLED / STATPAL ключа)" }, { status: 503 });
        return NextResponse.json({ ok: true, probe: await buildNoFeedProbe(db, provider, { env: process.env }) });
      }
      const { buildNoFeedCoverage } = await import("@/lib/noFeedCoverage");
      const daysRaw = Number(url.searchParams.get("days"));
      const windowDays = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined;
      return NextResponse.json({ ok: true, report: buildNoFeedCoverage(db, { windowDays }) });
    }
    // ?report=clean_favourite → P5 (batch-7): retro-backtest of the «clean favourite» hypothesis (derived
    // P(win) ≥70%, liquid consistent main-line, prematch) over settled history. The ABSTAINED (anti-phantom-
    // rejected) cohort's EV after fees against the ≥3pp @ n≥50 criterion → enable_small_cap / buried. Read-only.
    if (new URL(req.url).searchParams.get("report") === "clean_favourite") {
      const { buildCleanFavouriteBacktest } = await import("@/lib/cleanFavouriteBacktest");
      return NextResponse.json({ ok: true, report: buildCleanFavouriteBacktest(db, { env: process.env }) });
    }
    // ?report=pruned_matches → the audit trail of which no-bet matches pruneStaleMatches deleted and WHY
    // («куда попропали матчи из логов»). A no-bet match survives while its provider_snapshots live
    // (SNAPSHOT_RETENTION_DAYS), then is pruned; bet-bearing matches are never pruned. Read-only.
    if (new URL(req.url).searchParams.get("report") === "pruned_matches") {
      const { metaGet } = await import("@/lib/repo");
      let pruned: unknown = null; try { pruned = JSON.parse(metaGet(db, "pruned_matches_recent") ?? "null"); } catch { pruned = null; }
      return NextResponse.json({ ok: true, pruned, note: "матчи со ставками не удаляются НИКОГДА. Завершённые без ставок теперь архив (хранятся до cap MATCH_LOG_ARCHIVE_MAX). Удаляются только: зависшие НЕ-завершённые импорты (старше окна) + сломанные-без-ставок (заброшенный мусор). Старые записи с причиной «finished … старше окна review» — из прежнего пруна до decouple." });
    }
    // ?report=league_map_audit → R2(а): category-name↔league-id cross-mapping validation. `mismatches`
    // = comps whose stored external_league disagrees with current inference (dry-run, NOT applied here —
    // the lifecycle repairLeagueMap step applies them); `fixes` = the audit ring of corrections already made.
    if (new URL(req.url).searchParams.get("report") === "league_map_audit") {
      const { repairCategoryLeagues } = await import("@/lib/engine");
      const { metaGet } = await import("@/lib/repo");
      const mismatches = repairCategoryLeagues(db, new Date().toISOString(), { apply: false });
      let fixes: unknown = []; try { fixes = JSON.parse(metaGet(db, "league_map_fixes_recent") ?? "[]"); } catch { fixes = []; }
      return NextResponse.json({ ok: true, mismatches, fixes, note: "mismatches — расхождения имя-категории↔слаг-лиги по текущему инференсу (dry-run); применяет их шаг lifecycle repairLeagueMap. fixes — кольцо уже исправленных (from→to)." });
    }
    // ?report=blind_funded → R2(б): funded football matches that ran past kickoff with NO provider bind
    // (не молчаливая слепота). `live` = current detection; `persisted` = the ring the lifecycle step wrote.
    // reason: no_league (comp unmapped) vs unbound (league set, bind failed — tier/name/dark).
    if (new URL(req.url).searchParams.get("report") === "blind_funded") {
      const { listBlindFundedFootball, metaGet } = await import("@/lib/repo");
      const live = listBlindFundedFootball(db, { nowMs: Date.now() });
      let persisted: unknown = null; try { persisted = JSON.parse(metaGet(db, "blind_funded_matches_recent") ?? "null"); } catch { persisted = null; }
      return NextResponse.json({ ok: true, live, persisted, note: "funded-футбол прошёл kickoff без привязки провайдера. no_league — комп без external_league; unbound — лига есть, но бинд не случился (tier/name-fold/тёмная доска). Причину по каждому классифицирует ?report=no_feed_coverage&probe=1." });
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
