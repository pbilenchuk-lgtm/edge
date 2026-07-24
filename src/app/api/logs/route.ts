import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/logs — the «Логи» archive list, DECOUPLED from the fat buildAppData payload. One lean row per
 * finished match (identity + score + finish time + bet count + broken flag), straight from SQL, newest-first.
 * This is what lets the finished-match log archive be kept long/forever without bloating what the browser
 * downloads on every poll. The FULL log of any row is still fetched on demand via /api/engine (buildMatchLog).
 * Optional &limit=N (default 1000, capped 5000).
 */
export async function GET(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const { listMatchLogs } = await import("@/lib/repo");
    const raw = Number(new URL(req.url).searchParams.get("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(5000, raw) : 1000;
    return NextResponse.json({ ok: true, logs: listMatchLogs(getDb(), limit) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
