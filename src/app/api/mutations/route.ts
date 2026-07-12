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
    const { heuristicName, proposeImprovement, effectiveEnv } = await import("@/lib/llm");
    const { parseRiskProfile, loadRiskConfig } = await import("@/lib/riskConfig");

    const db = getDb();
    let body: any;
    try { body = await req.json(); } catch { return bad("невалидный JSON в теле запроса"); }
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
      case "setShadowConfig": {
        // Observe-only shadow allocator settings. Whitelist + sanitise; % fields clamp to
        // [0,1]. Applies from now forward (history is not recomputed — spec §69).
        const { saveShadowConfig } = await import("@/lib/shadow");
        const src = (body.config ?? {}) as Record<string, unknown>;
        const clean: Record<string, number | boolean> = {};
        const pcts = new Set(["liveBufferPct", "capCategoryPct", "capStrategyPct", "capMatchPct", "cashReservePct"]);
        if ("enabled" in src) clean.enabled = !!src.enabled;
        for (const k of ["bankTotal", "settlementLagMin", ...pcts]) {
          if (!(k in src)) continue;
          const n = Number(src[k]);
          if (!Number.isFinite(n) || n < 0) return bad(`Некорректное значение: ${k}`);
          clean[k] = pcts.has(k) ? Math.min(1, n) : n;
        }
        return ok(saveShadowConfig(db, clean as any, new Date().toISOString()) as any);
      }
      case "setTreasury": {
        const amount = Math.round(Number(body.amount));
        if (!isFinite(amount) || amount < 0) return bad("Некорректная сумма");
        const allocated = R.listCompetitions(db).reduce((n, c) => n + c.budget, 0);
        if (amount < allocated) return bad(`Общий баланс не может быть меньше уже распределённого ($${allocated})`);
        R.setTreasury(db, amount);
        return ok({ total: amount, free: freeBalance(amount, R.listCompetitions(db)) });
      }
      case "setShares": {
        // New shape: rows of (strategy, profile, pct) pairs. Back-compat: an
        // object {strategyId: pct} is treated as pairs on the MEDIUM profile.
        const { compId, rows, shares } = body as { compId: string; rows?: { strategyId: string; profileId: string; pct: number }[]; shares?: Record<string, number> };
        if (!compId) return bad("нужен compId");
        const pairs = rows ?? Object.entries(shares ?? {}).map(([strategyId, pct]) => ({ strategyId, profileId: "medium", pct: Number(pct) }));
        if (!sharesValid(pairs.map((p) => ({ pct: Number(p.pct) })))) return bad("Сумма долей превышает 100% (§9.2)");
        R.clearShares(db, compId);
        for (const p of pairs)
          if (Number(p.pct) > 0) R.setShare(db, { competition_id: compId, strategy_id: p.strategyId, risk_profile_id: p.profileId || "medium", pct: Number(p.pct) });
        return ok();
      }
      case "createStrategy": {
        const { sport, name, prompt, promptLive, model, params } = body;
        const count = R.listStrategies(db).length;
        const id = "s" + Date.now();
        R.insertStrategy(db, {
          id, sport_id: sport, name, tag: "custom", color: PALETTE[count % PALETTE.length],
          version: 1, prompt, prompt_live: promptLive ?? null, params: params ?? extractThresholdsHeuristic(prompt),
          model: model ?? null, created_at: new Date().toISOString(),
        });
        return ok({ id, color: PALETTE[count % PALETTE.length] });
      }
      case "patchStrategy": {
        const { id, patch } = body;
        // Frontend sends promptLive (camelCase); the repo column is prompt_live.
        if (patch && patch.promptLive !== undefined) { patch.prompt_live = patch.promptLive; delete patch.promptLive; }
        R.updateStrategy(db, id, patch);
        return ok();
      }
      case "deleteStrategy": {
        const { id } = body;
        if (!id || !R.getStrategy(db, id)) return bad("стратегия не найдена");
        R.deleteStrategy(db, id);
        return ok();
      }
      // --- risk profiles (Окно 4) ---
      case "parseRiskConfig": {
        // «вытащить и захардкодить»: free text → validated risk config (or errors)
        const { text } = body as { text: string };
        const res = parseRiskProfile(String(text ?? ""));
        return ok({ config: res.config ?? null, errors: res.errors ?? [] });
      }
      case "saveRiskProfile": {
        const { id, name, config } = body as { id?: string; name: string; config: unknown };
        if (!name || !String(name).trim()) return bad("пустое название профиля");
        const loaded = loadRiskConfig(config); // re-validate before persisting
        if (!loaded.ok || !loaded.config) return bad("невалидный конфиг: " + (loaded.errors ?? []).join("; "));
        const slug = (id && String(id).trim()) || "rp-" + String(name).toLowerCase().replace(/[^a-z0-9а-я]+/gi, "-").slice(0, 20) + "-" + Date.now().toString(36);
        const existing = R.getRiskProfileRow(db, slug);
        R.upsertRiskProfile(db, { id: slug, name: String(name).trim(), content: JSON.stringify(loaded.config), sort: existing?.sort ?? R.listRiskProfiles(db).length, created_at: existing?.created_at ?? new Date().toISOString() });
        return ok({ id: slug });
      }
      case "deleteRiskProfile": {
        const { id } = body as { id: string };
        if (!id) return bad("нет id профиля");
        R.deleteRiskProfile(db, id);
        return ok();
      }
      case "setProviderKey": {
        const { provider, key } = body as { provider: string; key: string };
        if (!["anthropic", "openai", "google"].includes(provider)) return bad("неизвестный провайдер");
        if (!key || !String(key).trim()) return bad("пустой ключ");
        R.setProviderKey(db, provider, String(key), new Date().toISOString());
        return ok(); // never echo the key back
      }
      case "deleteProviderKey": {
        const { provider } = body as { provider: string };
        R.deleteProviderKey(db, provider);
        return ok();
      }
      case "proposeImprovement": {
        const { strategyId } = body;
        const strat = R.getStrategy(db, strategyId);
        if (!strat) return bad("стратегия не найдена");
        const q = R.getQuality(db, strategyId);
        const samples = q?.samples ?? 0;
        if (samples < 20) {
          // §3.5 gate: too few matches — improving now overfits noise.
          return NextResponse.json({ ok: false, gated: true, samples, error: `Рано улучшать: ${samples}/20 матчей (§3.5)` }, { status: 400 });
        }
        const proposal = await proposeImprovement(strat, { matches: samples, clv: q?.clv ?? null, brier: q?.brier ?? null }, strat.model, { env: effectiveEnv(R.getProviderKeys(db)) });
        const params = await extractThresholds(proposal.newPrompt); // params computed in CODE (§9.6)
        return ok({ proposal: { ...proposal, params, version: strat.version + 1 } });
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
