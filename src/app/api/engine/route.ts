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

    const db = getDb();
    const body = (await req.json()) as any;

    switch (body.action) {
      case "reassess": {
        const match = R.getMatch(db, body.matchId);
        if (!match) return NextResponse.json({ ok: false, error: "матч не найден" }, { status: 404 });
        const r = await engine.triggerReassessment(db, { match, strategyId: body.strategyId, trigger: "manual", minute: match.minute }, {});
        const list = R.reassessmentsForMatch(db, match.id).filter((x) => x.strategy_id === body.strategyId);
        const last = list[list.length - 1];
        return NextResponse.json({ ok: r.created, source: r.source, reassessment: last ? { min: last.minute, text: last.body, conf: last.confidence } : null });
      }
      case "refreshOdds": {
        const res = await engine.refreshMatchOdds(db, body.matchId, {});
        const markets = R.latestMarkets(db, body.matchId).map((m) => ({ id: m.id, label: m.label, price: m.price, tokenId: m.external_ref }));
        return NextResponse.json({ ok: true, updated: res.updated, markets });
      }
      case "sync": {
        const cfg = loadSportsConfig();
        const provider = loadSportsProvider(cfg);
        if (!provider) return NextResponse.json({ ok: false, error: "SPORTS_ENABLED=false — спортивный провайдер выключен" }, { status: 400 });
        const results = [];
        for (const sport of Object.keys(cfg.leagues)) {
          const statuses = await provider.scoreboard(sport, cfg.leagues[sport]);
          for (const s of statuses) {
            const r = await engine.syncMatchStatus(db, s, {});
            if (r) results.push(r);
          }
        }
        return NextResponse.json({ ok: true, synced: results.length, results });
      }
      default:
        return NextResponse.json({ ok: false, error: `неизвестное действие: ${body.action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
