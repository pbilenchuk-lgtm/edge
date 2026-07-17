import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/real — the read-only real-trading contour view (Phase G, iteration 1).
 * Mode (effective, so sticky-pause shows), bank/ledger, order feed with lifecycle events,
 * positions, whitelist, reconciliation/orphan, and the real_vs_paper showcase. No control
 * here — STOP / mode / whitelist edits are iteration 2 (each its own audited POST).
 */
export async function GET(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    // ?report=dry_fill_watch → the paper→dry-fill funnel, localising WHERE the first end-to-end
    // dry fill is stuck (no live liquid book vs a gate closed at the wrong stage). Read-only.
    if (new URL(req.url).searchParams.get("report") === "dry_fill_watch") {
      const { buildDryFillWatch } = await import("@/lib/executor/dryFillWatch");
      return NextResponse.json({ ok: true, watch: buildDryFillWatch(db, process.env) });
    }
    const { realView } = await import("@/lib/executor/realView");
    return NextResponse.json({ ok: true, view: realView(db, process.env) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
