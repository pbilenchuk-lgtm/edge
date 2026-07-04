import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Live Polymarket quotes for a set of markets. Body:
 *   { markets: [{ tokenId: string, snapshotCents?: number }] }
 * Returns quotes (source: live|snapshot|disabled|error). Never throws —
 * unreachable/blocked tokens fall back to their snapshot (ТЗ §6).
 * Live fetching requires POLYMARKET_ENABLED=true in the environment.
 */
export async function POST(req: Request) {
  try {
    const { loadPolymarketConfig, getQuotes } = await import("@/lib/polymarket");
    let body: { markets?: { tokenId?: string | null; snapshotCents?: number | null }[] };
    try { body = await req.json(); } catch { body = {}; } // empty/malformed => no tokens
    const tokens = (body.markets ?? [])
      .filter((m) => m.tokenId)
      .map((m) => ({ tokenId: String(m.tokenId), snapshotCents: m.snapshotCents ?? null }));
    const quotes = await getQuotes(tokens, loadPolymarketConfig());
    return NextResponse.json({ quotes });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
