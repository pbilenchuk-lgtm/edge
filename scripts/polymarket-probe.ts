// ============================================================
// EDGE LAB — live Polymarket probe (exercises the real library)
// Proves the match -> event -> markets -> live quotes pipeline against the
// real API. Requires network egress to Polymarket.
//
//   npm run pm:probe                      # auto-pick a current tennis match
//   npm run pm:probe -- tennis Alcaraz Sinner
//   npm run pm:probe -- football Португалия Хорватия
// ============================================================
import {
  loadPolymarketConfig, listSportEvents, findMatchEvent,
  eventToMarketSnapshots, getQuotes, titleMatchScore,
} from "../src/lib/polymarket.js";

// Force live for the probe regardless of .env.
const cfg = { ...loadPolymarketConfig(), enabled: true, timeoutMs: 12000 };

const [, , sportArg, homeArg, awayArg] = process.argv;
const sport = sportArg ?? "tennis";

async function main() {
  let event;
  if (homeArg && awayArg) {
    console.log(`Ищу матч: ${sport} — ${homeArg} vs ${awayArg}`);
    event = await findMatchEvent(cfg, { sport, home: homeArg, away: awayArg });
  } else {
    console.log(`Беру ближайший матч (${sport}) с рынками…`);
    const events = await listSportEvents(cfg, sport, 60);
    event = events.find((e) => / vs /i.test(e.title) && e.markets.length >= 2) ?? events[0];
  }

  if (!event) {
    console.log("Событие не найдено (нет доступа к сети или нет матчей).");
    return;
  }

  console.log(`\nСОБЫТИЕ: ${event.title}`);
  console.log(`slug: ${event.slug}  start: ${event.startDate ?? "-"}  рынков: ${event.markets.length}`);
  if (homeArg && awayArg) console.log(`title-score: ${titleMatchScore(event.title, homeArg, awayArg)}/2`);

  const snaps = eventToMarketSnapshots(event, new Date().toISOString());
  console.log(`\nРынки (snapshot из Gamma, центы):`);
  for (const s of snaps.slice(0, 10)) {
    console.log(`  ${s.label.padEnd(48).slice(0, 48)} ${String(s.price).padStart(5)}¢  token=${(s.external_ref ?? "").slice(0, 14)}…`);
  }

  // Realtime cross-check via CLOB for the first few markets.
  const tokens = event.markets
    .filter((m) => m.tokenIds[0])
    .slice(0, 5)
    .map((m) => ({ tokenId: m.tokenIds[0], snapshotCents: m.priceCents }));
  const quotes = await getQuotes(tokens, cfg);
  console.log(`\nРеалтайм CLOB /midpoint (первые ${quotes.length}):`);
  for (const q of quotes) {
    console.log(`  token=${q.tokenId.slice(0, 14)}…  ${q.source}  ${q.priceCents}¢  ${q.stale ? "(stale)" : ""}`);
  }
  console.log("\n✓ probe OK");
}

main().catch((e) => {
  console.error("probe error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
