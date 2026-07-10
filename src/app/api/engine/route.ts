import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Engine actions (ТЗ §3.3). Body: { action, ... }.
 *   reassess     { matchId, strategyId }  — manual reassessment (trigger button)
 *   refreshOdds  { matchId }              — pull Polymarket, snapshot + mark-to-market
 *   sync         { }                      — poll the sports provider, drive lifecycle
 */
export async function POST(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const R = await import("@/lib/repo");
    const engine = await import("@/lib/engine");
    const { loadSportsProvider, loadSportsConfig } = await import("@/lib/sports");
    const { tryAcquireEngine, releaseEngine } = await import("@/lib/engineLock");

    const db = getDb();
    let body: any;
    try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "невалидный JSON в теле запроса" }, { status: 400 }); }

    switch (body.action) {
      case "reassess": {
        const match = R.getMatch(db, body.matchId);
        if (!match) return NextResponse.json({ ok: false, error: "матч не найден" }, { status: 404 });
        // FULL strategist reassessment for this one strategy: writes the narrative
        // note AND re-evaluates its open positions (full/partial exit) plus fresh
        // entries — then fills any newly-proposed bets. This is the same engine the
        // 5-min heartbeat runs, invoked on demand for a single strategy.
        const { strategistReassess, autoEnter } = await import("@/lib/lifecycle");
        const res = await strategistReassess(db, {}, {
          newEventMatchIds: new Set([match.id]), triggeredOnly: true,
          onlyStrategyId: body.strategyId, labelFor: new Map([[match.id, "manual"]]), max: 1,
        });
        autoEnter(db, {});
        const list = R.reassessmentsForMatch(db, match.id).filter((x) => x.strategy_id === body.strategyId);
        const last = list[list.length - 1];
        return NextResponse.json({
          ok: true, exits: res.exits.length, entries: res.entries.length,
          reassessment: last ? { min: last.minute, text: last.body, conf: last.confidence } : null,
        });
      }
      case "analyze": {
        // Kick the expensive LLM path into the background and return at once
        // (§9.5 split). The client polls `analyzeStatus` for completion.
        const { startAnalysis } = await import("@/lib/analysis");
        const res = startAnalysis(db, body.matchId, {});
        return NextResponse.json(res, { status: res.ok ? 202 : 422 });
      }
      case "analyzeStatus": {
        const { analysisStatus } = await import("@/lib/analysis");
        return NextResponse.json(analysisStatus(db, body.matchId));
      }
      case "refreshOdds": {
        const res = await engine.refreshMatchOdds(db, body.matchId, {});
        const markets = R.latestMarkets(db, body.matchId).map((m) => ({ id: m.id, label: m.label, price: m.price, tokenId: m.external_ref }));
        return NextResponse.json({ ok: true, updated: res.updated, markets });
      }
      case "refreshAllOdds": {
        // Heavy: re-quotes every non-finished match. Run in the BACKGROUND behind
        // the shared engine lock so it can't hold the HTTP request open past
        // Render's gateway timeout (→ 502) or overlap with the cron.
        { const tok = tryAcquireEngine();
        if (!tok) return NextResponse.json({ ok: true, running: true }, { status: 202 });
        void (async () => { try { await engine.refreshActiveOdds(db, {}); } catch (e) { console.error("[refreshAllOdds]", e); } finally { releaseEngine(tok); } })();
        return NextResponse.json({ ok: true, started: true }, { status: 202 }); }
      }
      case "tick": {
        // Full automated lifecycle pass (same as `npm run tick:once`):
        // sync + odds + exits + auto-analyze + paper-enter. Multi-minute → run in
        // the BACKGROUND behind the shared lock, return at once (avoids a 502).
        { const tok = tryAcquireEngine();
        if (!tok) return NextResponse.json({ ok: true, running: true }, { status: 202 });
        void (async () => {
          try {
            const { runAutoCycle } = await import("@/lib/lifecycle");
            const { loadPolymarketConfig } = await import("@/lib/polymarket");
            const provider = loadSportsProvider(loadSportsConfig());
            await runAutoCycle(db, provider, {}, { linkOdds: loadPolymarketConfig().enabled });
          } catch (e) { console.error("[tick]", e); } finally { releaseEngine(tok); }
        })();
        return NextResponse.json({ ok: true, started: true }, { status: 202 }); }
      }
      case "discover": {
        // "Pull matches" UI button: parse Polymarket (~7 days out), import
        // ESPN-linked matches + lineups/events, refresh odds. NO LLM. This is
        // MULTI-MINUTE work, so it runs in the BACKGROUND behind the shared engine
        // lock and returns 202 immediately — holding it in the request timed out
        // past Render's gateway (→ 502). The client surfaces the new matches on
        // its next reload (competitions now sync in reloadApp).
        { const tok = tryAcquireEngine();
        if (!tok) return NextResponse.json({ ok: true, running: true }, { status: 202 });
        void (async () => {
          try {
            const { importPolymarketMatches, syncCompetitions, enrichFromEspn } = engine;
            const { SPORT_TAG_IDS, loadPolymarketConfig } = await import("@/lib/polymarket");
            const provider = loadSportsProvider(loadSportsConfig());
            let discovered = 0;
            if (loadPolymarketConfig().enabled) {
              for (const sport of Object.keys(SPORT_TAG_IDS)) {
                const items = await importPolymarketMatches(db, sport, {}, {});
                discovered += items.length;
              }
            }
            let enriched = 0;
            if (provider) {
              await syncCompetitions(db, provider, {}, { linkOdds: loadPolymarketConfig().enabled });
              const e = await enrichFromEspn(db, provider, {});
              enriched = e.enriched;
            }
            const odds = await engine.refreshActiveOdds(db, {});
            const oddsUpdated = odds.reduce((n, r) => n + r.updated, 0);
            const at = new Date().toISOString();
            try { R.insertCronLog(db, { id: R.uid(), at, kind: "manual", ok: 1, summary: `подтянуть матчи: +${discovered} матчей · составы ${enriched} · котировки ${oddsUpdated}`, created_at: at }); } catch {}
          } catch (e) { console.error("[discover]", e); } finally { releaseEngine(tok); }
        })();
        return NextResponse.json({ ok: true, started: true }, { status: 202 }); }
      }
      case "sync": {
        const cfg = loadSportsConfig();
        const provider = loadSportsProvider(cfg);
        if (!provider) return NextResponse.json({ ok: false, error: "SPORTS_ENABLED=false — спортивный провайдер выключен" }, { status: 400 });
        // Import + categorize matches per linked competition (ЧМ-2026 = fifa.world),
        // refresh status, and attach Polymarket odds to new matches when enabled.
        const { loadPolymarketConfig } = await import("@/lib/polymarket");
        const linkOdds = loadPolymarketConfig().enabled;
        const results = await engine.syncCompetitions(db, provider, {}, { linkOdds });
        return NextResponse.json({ ok: true, synced: results.length, imported: results.filter((r) => r.created).length, results });
      }
      case "snapshots": {
        // Provider-snapshot metadata for a match (NO raw payload — light for the
        // Анализ tab). Newest batch first; extracted labels parsed to JSON.
        if (!body.matchId) return NextResponse.json({ ok: false, error: "нет matchId" }, { status: 400 });
        const rows = R.snapshotMetaForMatch(db, body.matchId, body.limit ?? 500).map((r) => ({
          id: r.id, at: r.batch_at, provider: r.provider, phase: r.phase, ok: !!r.ok,
          httpStatus: r.http_status, ref: r.provider_ref, minute: r.minute, latencyMs: r.latency_ms,
          extracted: r.extracted ? JSON.parse(r.extracted) : null,
        }));
        return NextResponse.json({ ok: true, snapshots: rows });
      }
      case "snapshotRaw": {
        // The full raw payload of one snapshot, for the raw-JSON view / export.
        if (!body.id) return NextResponse.json({ ok: false, error: "нет id" }, { status: 400 });
        const r = R.snapshotRaw(db, body.id);
        if (!r) return NextResponse.json({ ok: false, error: "снимок не найден" }, { status: 404 });
        return NextResponse.json({ ok: true, provider: r.provider, at: r.batch_at, raw: r.raw });
      }
      case "snapshotNow": {
        // Force one capture pass now (manual — for testing before/around a match).
        const { collectSnapshots } = await import("@/lib/snapshots");
        const n = await collectSnapshots(db, {});
        return NextResponse.json({ ok: true, written: n });
      }
      case "activeMatchRefs": {
        // For the external Betfair collector (non-US host): which live/near
        // football matches to price. Auth via the shared ingest token so the
        // match list isn't world-readable.
        const token = process.env.BETFAIR_INGEST_TOKEN ?? "";
        if (!token || body.token !== token) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
        const { matchRefsForCollection } = await import("@/lib/snapshots");
        return NextResponse.json({ ok: true, refs: matchRefsForCollection(db, Date.now()) });
      }
      case "ingestSnapshot": {
        // Write a snapshot produced by the external collector (Betfair) into
        // provider_snapshots. Shared-secret auth; batch_at is the collector's
        // stamp so it aligns with its own poll cadence.
        const token = process.env.BETFAIR_INGEST_TOKEN ?? "";
        if (!token || body.token !== token) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
        if (!body.matchId || !R.getMatch(db, body.matchId)) return NextResponse.json({ ok: false, error: "unknown matchId" }, { status: 400 });
        R.insertProviderSnapshot(db, {
          match_id: body.matchId, batch_at: body.batchAt ?? new Date().toISOString(),
          provider: body.provider ?? "betfair", phase: body.phase ?? "live",
          ok: body.ok !== false, http_status: body.httpStatus ?? null, provider_ref: body.providerRef ?? null,
          minute: body.minute ?? null, latency_ms: body.latencyMs ?? null,
          extracted: body.extracted ?? null, raw: body.raw != null ? (typeof body.raw === "string" ? body.raw : JSON.stringify(body.raw)) : null,
        });
        return NextResponse.json({ ok: true });
      }
      case "matchLog": {
        // Full single-file match log (markdown) for offline analysis: live-data
        // status, analysis artifacts, every strategist decision (incl. its error),
        // battle sheets, bets, reassessments, trade log, events, provider snapshots,
        // cron log. `match` may be a match id OR a team-name substring.
        const q = body.match ?? body.matchId;
        if (!q) return NextResponse.json({ ok: false, error: "нет match (id или имя команды)" }, { status: 400 });
        const { buildMatchLog, findMatch } = await import("@/lib/matchLog");
        const hit = findMatch(db, q);
        if (!hit) return NextResponse.json({ ok: false, error: `матч не найден: ${q}` }, { status: 404 });
        const md = buildMatchLog(db, hit.id);
        return NextResponse.json({ ok: true, matchId: hit.id, markdown: md });
      }
      default:
        return NextResponse.json({ ok: false, error: `неизвестное действие: ${body.action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
