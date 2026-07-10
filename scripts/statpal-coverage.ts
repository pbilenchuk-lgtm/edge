// ============================================================
// EDGE LAB — StatPal soccer coverage probe.
// StatPal has NO league-list endpoint (/soccer/leagues 404s); the only soccer
// feed is /soccer/livescores, which returns whatever is LIVE right now. So this
// script snapshots the live feed, extracts every distinct league/country label
// present, and checks whether the leagues ESPN does NOT cover show up.
//
// Needs a real key (prod secret): STATPAL_KEY=... npm run statpal:probe
// Run it a few times across the day — a league only appears while a match is live.
// ============================================================
const KEY = process.env.STATPAL_KEY ?? process.env.STATPAL ?? "";
const BASE = process.env.STATPAL_BASE ?? "https://statpal.io/api/v1";
// The football categories Polymarket lists that ESPN does NOT cover — the ones we
// need StatPal to fill (else they get dropped). Edit as the board changes.
const ESPN_GAPS = ["Chinese Super League", "K-League", "Australia Cup"];

if (!KEY) {
  console.error("✗ STATPAL_KEY не задан. Это прод-секрет — задай его в окружении:");
  console.error("    STATPAL_KEY=xxxx npm run statpal:probe");
  process.exit(1);
}

// Collect league/country labels: StatPal nests matches under category/league nodes.
function collectLeagues(body: any): { labels: Set<string>; matchCount: number } {
  const labels = new Set<string>();
  let matchCount = 0;
  const isMatchNode = (n: any) => n && typeof n === "object" && (n.home || n.hometeam || n.localteam || n.awayteam);
  const walk = (n: any, nearestLabel: string | null) => {
    if (Array.isArray(n)) { n.forEach((x) => walk(x, nearestLabel)); return; }
    if (!n || typeof n !== "object") return;
    // A node that names a league/country and holds matches → record it.
    const label = [n.country, n.name ?? n.league ?? n.tournament].filter(Boolean).join(" · ") || null;
    const here = label ?? nearestLabel;
    if (isMatchNode(n)) { matchCount++; if (here) labels.add(here); }
    for (const v of Object.values(n)) walk(v, here);
  };
  walk(body, null);
  return { labels, matchCount };
}

async function main() {
  const url = `${BASE}/soccer/livescores?access_key=${KEY}`;
  console.log(`GET ${BASE}/soccer/livescores  (снимок «сейчас в лайве»)\n`);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res) { console.error("✗ StatPal недоступен (сеть/таймаут)"); process.exit(2); }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) { console.error(`✗ StatPal ${res.status}: ${body?.error ?? "нет тела"}`); process.exit(3); }

  const { labels, matchCount } = collectLeagues(body);
  const sorted = [...labels].sort();
  console.log(`Лиг в лайве сейчас: ${sorted.length}, матчей: ${matchCount}\n`);
  sorted.forEach((l) => console.log(`  • ${l}`));

  console.log(`\n── Проверка «дыр» ESPN (есть ли они у StatPal ПРЯМО СЕЙЧАС) ──`);
  for (const gap of ESPN_GAPS) {
    const needle = gap.toLowerCase().replace(/[^a-z]/g, "");
    const hit = sorted.find((l) => l.toLowerCase().replace(/[^a-z]/g, "").includes(needle.slice(0, 8)));
    console.log(`  ${gap.padEnd(22)} ${hit ? `✓ есть: ${hit}` : "— нет в этом снимке (нет лайв-матча или не покрывается)"}`);
  }
  console.log(`\nПрогони ещё раз, когда в этих лигах идёт матч — лига видна только в лайве.`);
}

main().catch((e) => { console.error("probe failed:", e); process.exit(1); });
