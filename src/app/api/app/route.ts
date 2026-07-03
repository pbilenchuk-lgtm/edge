import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Full read payload for the UI (all screens). */
export async function GET() {
  try {
    const { getDb } = await import("@/lib/db");
    const { buildAppData } = await import("@/lib/view");
    return NextResponse.json(buildAppData(getDb()));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), hint: "Run `npm run db:seed` first." },
      { status: 503 },
    );
  }
}
