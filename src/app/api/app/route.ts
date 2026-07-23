import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Full read payload for the UI (all screens). Served from the shared STALE-WHILE-REVALIDATE snapshot cache
 *  (lib/appSnapshot) so the client's periodic polls never drive a fresh, blocking buildAppData on every hit —
 *  it runs at most once per TTL for the worker, shared with the `/` SSR. */
export async function GET() {
  try {
    const { getAppSnapshot } = await import("@/lib/appSnapshot");
    const data = await getAppSnapshot();
    if (!data) return NextResponse.json({ error: "данные ещё не готовы", hint: "Run `npm run db:seed` first." }, { status: 503 });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), hint: "Run `npm run db:seed` first." },
      { status: 503 },
    );
  }
}
