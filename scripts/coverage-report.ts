// ============================================================
// EDGE LAB — football coverage report.
//   1) Pull the football match CATEGORIES Polymarket currently lists (by series),
//      with liquidity, so we see where there's money.
//   2) For each category, resolve our ESPN league mapping AND verify it live
//      against ESPN's scoreboard (real coverage, not just a guessed code).
//   npm run coverage:report            # default: 60d window, 600 matches
// ============================================================
import { loadPolymarketConfig, discoverSportMatches, type DiscoveredMatch } from "../src/lib/polymarket.js";
import { espnLeagueForSeries, seriesSlugOf } from "../src/lib/engine.js";

const cfg = { ...loadPolymarketConfig(), enabled: true, timeoutMs: 15000, minLiquidity: 0 };
const ESPN_BASE = process.env.ESPN_BASE ?? "https://site.api.espn.com/apis/site/v2/sports";

const num = (s: string | number | null) => (s == null ? 0 : Number(s) || 0);

// Live-verify an ESPN soccer league code: does the scoreboard endpoint exist and
// name a real league? (Empty event list is fine — off-season, still covered.)
async function espnVerify(code: string): Promise<{ ok: boolean; name?: string; events?: number; status?: number }> {
  const url = `${ESPN_BASE}/soccer/${code}/scoreboard`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, status: res.status };
    const j: any = await res.json();
    const name = j?.leagues?.[0]?.name ?? j?.leagues?.[0]?.abbreviation;
    return { ok: !!name, name, events: Array.isArray(j?.events) ? j.events.length : 0 };
  } catch { return { ok: false }; }
}

interface Cat { series: string; slug: string; matches: number; totalLiq: number; maxLiq: number; sample: string }

async function main() {
  console.log("Тяну футбол с Polymarket (окно 60д, до 600 матчей)…\n");
  const now = new Date().toISOString();
  const discovered: DiscoveredMatch[] = await discoverSportMatches(cfg, "football", now, {}, { limit: 600, windowDays: 60 });

  const cats = new Map<string, Cat>();
  for (const d of discovered) {
    if (!d.series && !d.seriesSlug) continue; // props/novelty, not real fixtures
    const slug = seriesSlugOf(d.series, d.seriesSlug);
    const key = slug || d.series || "?";
    const liq = num(d.liquidity);
    const c = cats.get(key) ?? { series: d.series ?? slug, slug, matches: 0, totalLiq: 0, maxLiq: 0, sample: `${d.home} — ${d.away}` };
    c.matches++; c.totalLiq += liq; c.maxLiq = Math.max(c.maxLiq, liq);
    cats.set(key, c);
  }

  const rows = [...cats.values()].sort((a, b) => b.maxLiq - a.maxLiq);
  console.log(`Категорий: ${rows.length}, всего матчей: ${discovered.length}\n`);

  // Resolve + verify ESPN for each category (dedupe verify calls per code).
  const verifyCache = new Map<string, Awaited<ReturnType<typeof espnVerify>>>();
  const out: any[] = [];
  for (const c of rows) {
    const code = espnLeagueForSeries(c.series, c.slug);
    let v: Awaited<ReturnType<typeof espnVerify>> | null = null;
    if (code) {
      if (!verifyCache.has(code)) verifyCache.set(code, await espnVerify(code));
      v = verifyCache.get(code)!;
    }
    out.push({ ...c, code, v });
  }

  const covered = out.filter((r) => r.code && r.v?.ok);
  const mappedButBad = out.filter((r) => r.code && !r.v?.ok);
  const uncovered = out.filter((r) => !r.code);

  const fmt = (r: any) => `  ${(r.series || r.slug).slice(0, 34).padEnd(34)}  матчей ${String(r.matches).padStart(3)}  ликв.макс $${Math.round(r.maxLiq).toString().padStart(7)}  ${r.code ? `→ ${r.code}${r.v?.ok ? ` ✓ (${r.v.name}${r.v.events ? `, ${r.v.events} live` : ""})` : ` ✗ ESPN ${r.v?.status ?? "нет"}`}` : "→ нет ESPN"}`;

  console.log(`═══ ПОКРЫТО ESPN (${covered.length}) ═══`);
  covered.forEach((r) => console.log(fmt(r)));
  console.log(`\n═══ МАППИНГ ЕСТЬ, НО ESPN НЕ ПОДТВЕРДИЛ (${mappedButBad.length}) — код неверный/лига не на ESPN ═══`);
  mappedButBad.forEach((r) => console.log(fmt(r)));
  console.log(`\n═══ НЕТ ПОКРЫТИЯ ESPN (${uncovered.length}) — кандидаты на StatPal или удаление ═══`);
  uncovered.forEach((r) => console.log(fmt(r)));

  // Machine-readable dump for the next step (StatPal cross-check).
  console.log("\n\n──── JSON (для следующего шага) ────");
  console.log(JSON.stringify({
    covered: covered.map((r) => ({ series: r.series, slug: r.slug, matches: r.matches, maxLiq: Math.round(r.maxLiq), code: r.code })),
    uncovered: [...uncovered, ...mappedButBad].map((r) => ({ series: r.series, slug: r.slug, matches: r.matches, maxLiq: Math.round(r.maxLiq), code: r.code ?? null })),
  }, null, 0));
}

main().catch((e) => { console.error("probe failed:", e); process.exit(1); });
