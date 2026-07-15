import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/real-control — the owner control surface (Phase G, iteration 2). ONE endpoint, but each
 * `action` is a distinct, separately-audited move (who/when/what → real_control_log). Nothing here can
 * LOOSEN past the env ceiling: effectiveTradingMode / resolveSafetyCaps always take the most restrictive
 * of (env, operator override, sticky pause). The UI can only tighten. Body: { action, ...args }.
 *
 * actions:
 *   stop                         — hard stop: mode→off + cancel working orders + orphan alert (INSTANT)
 *   set_mode   { mode, confirm, phrase } — operator-mode ceiling; loosening→dry_run/exits_only needs
 *                                  confirm:true; loosening→on needs the TYPED phrase (not a click)
 *   clear_pause                  — clear the sticky auto-pause
 *   whitelist_add { row }        — add a whitelist row (versioned + logged)
 *   whitelist_toggle { id, enabled }
 *   set_caps   { caps }          — override the 4 hard caps (env stays the floor)
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "owner";

    const { getDb } = await import("@/lib/db");
    const C = await import("@/lib/executor/realControl");
    const db = getDb();
    const now = new Date().toISOString();

    let result: { ok: boolean; note: string; needConfirm?: boolean };
    switch (action) {
      case "stop":
        result = C.operatorStop(db, actor, now);
        break;
      case "set_mode":
        result = C.setOperatorModeControl(db, String(body.mode ?? ""), body.confirm === true, actor, now, typeof body.phrase === "string" ? body.phrase : undefined);
        break;
      case "clear_pause":
        result = C.clearAutoPauseControl(db, actor, now);
        break;
      case "whitelist_add": {
        const row = (body.row ?? {}) as Record<string, unknown>;
        result = C.whitelistAddControl(db, {
          strategyId: String(row.strategyId ?? ""),
          categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
          maxOrderUsd: Number(row.maxOrderUsd),
          enabled: row.enabled === true,
        }, actor, now);
        break;
      }
      case "whitelist_toggle":
        result = C.whitelistToggleControl(db, String(body.id ?? ""), body.enabled === true, actor, now);
        break;
      case "set_caps": {
        const caps = (body.caps ?? {}) as Record<string, unknown>;
        const partial: Record<string, number> = {};
        for (const k of ["maxOrderUsd", "maxExposureUsd", "maxDailyLossUsd", "maxOrdersPerHour"]) {
          const v = Number(caps[k]);
          if (Number.isFinite(v)) partial[k] = v;
        }
        result = C.setCapsControl(db, partial, actor, now);
        break;
      }
      default:
        return NextResponse.json({ ok: false, error: `неизвестное действие «${action}»` }, { status: 400 });
    }

    // needConfirm is not an error — the UI shows a confirm dialog then re-POSTs with confirm:true.
    return NextResponse.json({ ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
