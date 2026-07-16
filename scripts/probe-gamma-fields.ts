// Owner probe — does the Gamma /events response we ALREADY fetch carry executable prices
// (bestBid/bestAsk/spread), or only the mid (outcomePrices)? Decides the phantom-edge fix:
//   • if bestAsk/spread present → feed the strategist the ASK, zero new fetches (cheap, OOM-safe).
//   • if absent → must consult the CLOB book, bounded to the strategist's picks only.
//   npx tsx scripts/probe-gamma-fields.ts
// Read-only. One Gamma call.

import { loadPolymarketConfig } from "../src/lib/polymarket.js";

const cfg = loadPolymarketConfig(process.env);
const url = `${cfg.gammaBase}/events?closed=false&limit=8&order=volume&ascending=false`;
console.log(`GET ${url}\n`);
const res = await fetch(url);
if (!res.ok) { console.log(`HTTP ${res.status} — не удалось`); process.exit(1); }
const rows = (await res.json()) as any[];
const ev = rows.find((e) => Array.isArray(e.markets) && e.markets.length);
if (!ev) { console.log("нет событий с рынками"); process.exit(0); }
console.log(`событие: ${ev.title} · рынков ${ev.markets.length}\n`);

const m = ev.markets[0];
const interesting = ["outcomePrices", "bestBid", "bestAsk", "spread", "lastTradePrice", "liquidity", "orderPriceMinTickSize", "orderMinSize"];
console.log(`— поля первого рынка «${m.groupItemTitle || m.question || ""}» —`);
for (const k of interesting) console.log(`  ${k.padEnd(22)} ${k in m ? JSON.stringify(m[k]) : "(отсутствует)"}`);
console.log(`\nвсе ключи рынка: ${Object.keys(m).join(", ")}`);

const hasAsk = "bestAsk" in m && m.bestAsk != null, hasSpread = "spread" in m && m.spread != null;
console.log(`\nВЕРДИКТ: ${hasAsk || hasSpread
  ? `Gamma отдаёт ${[hasAsk ? "bestAsk" : null, hasSpread ? "spread" : null].filter(Boolean).join("+")} → фикс ДЁШЕВЫЙ: кормить стратега аском, 0 новых запросов.`
  : "bestAsk/spread НЕТ в Gamma → нужен CLOB /book, ограниченно по пикам стратега (не по всем рынкам — иначе OOM)."}`);
