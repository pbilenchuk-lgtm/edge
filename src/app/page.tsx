import EdgeLab from "@/components/EdgeLab";
import { getAppSnapshot } from "@/lib/appSnapshot";

export const dynamic = "force-dynamic";

// The heavy AppData build is behind a shared STALE-WHILE-REVALIDATE cache (see lib/appSnapshot): `/` and the
// `/api/app` poll share it, so buildAppData runs at most once per TTL for the worker and never blocks the port
// with back-to-back builds. This page just reads the current snapshot.
export default async function Home() {
  let initial: unknown | null = null;
  let error: string | null = null;
  try { initial = await getAppSnapshot(); }
  catch (e) { error = e instanceof Error ? e.message : String(e); }

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

  return <EdgeLab initial={initial as any} />;
}
