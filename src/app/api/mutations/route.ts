import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PALETTE = ["#e8a838", "#5b9bd5", "#70b56a", "#c98bdb", "#e07a5f", "#4fc3c7"];

/**
 * Single write endpoint for all persisted UI actions. Body: { type, ... }.
 * Validates money invariants server-side (§9.1–9.2) and uses the engine for
 * threshold extraction / name suggestion (§3.2). Returns { ok, ...result }.
 */
export async function POST(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const R = await import("@/lib/repo");
    const { canSetBudget, sharesValid, freeBalance } = await import("@/lib/money");
    const { extractThresholds, extractThresholdsHeuristic } = await import("@/lib/thresholds");
    const { heuristicName } = await import("@/lib/llm");

    const db = getDb();
    const body = (await req.json()) as any;
    const type = body?.type as string;

    switch (type) {
      case "setBudget": {
        const { compId, amount } = body;
        const comps = R.listCompetitions(db);
        const total = R.getTreasury(db).total_balance;
        if (!canSetBudget(total, comps, compId, amount))
          return bad("Бюджет превышает свободный остаток казны (§9.1)");
        R.setCompetitionBudget(db, compId, Math.round(amount));
        return ok({ free: freeBalance(total, R.listCompetitions(db)) });
      }
      case "setShares": {
        const { compId, shares } = body as { compId: string; shares: Record<string, number> };
        const list = Object.entries(shares).map(([, pct]) => ({ pct: Number(pct) }));
        if (!sharesValid(list)) return bad("Сумма долей превышает 100% (§9.2)");
        R.clearShares(db, compId);
        for (const [sid, pct] of Object.entries(shares))
          if (Number(pct) > 0) R.setShare(db, { competition_id: compId, strategy_id: sid, pct: Number(pct) });
        return ok();
      }
      case "createStrategy": {
        const { sport, name, prompt, model, params } = body;
        const count = R.listStrategies(db).length;
        const id = "s" + Date.now();
        R.insertStrategy(db, {
          id, sport_id: sport, name, tag: "custom", color: PALETTE[count % PALETTE.length],
          version: 1, prompt, params: params ?? extractThresholdsHeuristic(prompt),
          model: model ?? null, created_at: new Date().toISOString(),
        });
        return ok({ id, color: PALETTE[count % PALETTE.length] });
      }
      case "patchStrategy": {
        const { id, patch } = body;
        R.updateStrategy(db, id, patch);
        return ok();
      }
      case "improveStrategy": {
        const { id, prompt, params, reason } = body;
        const version = R.saveStrategyVersion(db, id, prompt, params, reason ?? "improvement");
        return ok({ version });
      }
      case "saveAnalytics": {
        const { scope, scopeId, body: text } = body;
        R.updateAnalyticsPrompt(db, scope, scopeId, text);
        return ok();
      }
      case "setAnalyticsModel": {
        R.setAnalyticsModel(db, body.sportId, body.model);
        return ok();
      }
      case "parseThresholds": {
        const params = await extractThresholds(String(body.prompt ?? ""));
        return ok({ params });
      }
      case "suggestName": {
        return ok({ name: heuristicName(String(body.prompt ?? "")) });
      }
      default:
        return bad(`неизвестное действие: ${type}`);
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

function ok(extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...extra });
}
function bad(error: string) {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}
