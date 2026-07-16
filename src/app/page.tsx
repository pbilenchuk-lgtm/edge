import EdgeLab from "@/components/EdgeLab";

export const dynamic = "force-dynamic";

// SSR snapshot cache. buildAppData() is a synchronous node:sqlite pass over EVERY match
// (per-match assessments/markets/odds queries) — it grows with the DB and now takes
// several SECONDS. node:sqlite blocks the event loop, so an uncached `/` freezes the whole
// process on every hit (nothing else — not /api/health, not Render's post-deploy port
// probe — can be answered while it runs). A burst of `/` hits during a deploy therefore
// starved the port scan → "No open HTTP ports" → deploy timeout. Caching the snapshot for
// a few seconds means `/` blocks the loop at most once per TTL instead of once per request,
// so health/port probes get their free windows and homepage loads are instant after the
// first. A few seconds of staleness on a dashboard is irrelevant. Module-level state
// persists across requests in the single production worker (WEB_CONCURRENCY=1).
const SNAPSHOT_TTL_MS = Math.max(0, Number(process.env.APP_SNAPSHOT_TTL_MS ?? 10_000));
let _snap: { at: number; data: unknown } | null = null;

export default async function Home() {
  const { getDb } = await import("@/lib/db");
  const { buildAppData } = await import("@/lib/view");

  let initial = null;
  let error: string | null = null;
  try {
    const now = Date.now();
    if (_snap && now - _snap.at < SNAPSHOT_TTL_MS) {
      initial = _snap.data as ReturnType<typeof buildAppData>;
    } else {
      initial = buildAppData(getDb());
      _snap = { at: now, data: initial };
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!initial) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: 32, lineHeight: 1.6 }}>
        <h1 style={{ color: "#e8a838" }}>◆ EDGE LAB</h1>
        <p style={{ color: "#8b95a5" }}>Данные ещё не готовы. Наполни БД и перезапусти:</p>
        <pre style={{ background: "#1a2029", border: "1px solid #2c3543", borderRadius: 10, padding: 14 }}>{`npm run db:seed
npm run dev`}</pre>
        {error && <p style={{ color: "#ff6b6b", fontFamily: "monospace", fontSize: 12 }}>{error}</p>}
      </main>
    );
  }

  return <EdgeLab initial={initial} />;
}
