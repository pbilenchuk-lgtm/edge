import EdgeLab from "@/components/EdgeLab";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { getDb } = await import("@/lib/db");
  const { buildAppData } = await import("@/lib/view");

  let initial = null;
  let error: string | null = null;
  try {
    initial = buildAppData(getDb());
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
