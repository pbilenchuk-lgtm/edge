import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/real — the read-only real-trading contour view (Phase G, iteration 1).
 * Mode (effective, so sticky-pause shows), bank/ledger, order feed with lifecycle events,
 * positions, whitelist, reconciliation/orphan, and the real_vs_paper showcase. No control
 * here — STOP / mode / whitelist edits are iteration 2 (each its own audited POST).
 */
export async function GET() {
  try {
    const { getDb } = await import("@/lib/db");
    const { realView } = await import("@/lib/executor/realView");
    const db = getDb();
    return NextResponse.json({ ok: true, view: realView(db, process.env) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
