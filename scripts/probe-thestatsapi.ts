// Live TheStatsAPI probe — что реально приходит в in-play фиде (лайв G).
// Run: THESTATSAPI_KEY=... npm run tsa:probe
// Авторизация в доках не зафиксирована — пробуем несколько схем и печатаем
// сырой ответ, чтобы после первого запуска зафиксировать правильную.
import "../src/lib/http.js"; // proxy-aware fetch

const KEY = process.env.THESTATSAPI_KEY ?? process.env.THESTATSAPI_API_KEY ?? "";
const BASE = process.env.THESTATSAPI_BASE ?? "https://api.thestatsapi.com";
if (!KEY) {
  console.error("✗ Нет ключа. Задай THESTATSAPI_KEY в окружении этой сессии (не Render).");
  process.exit(1);
}

function trunc(v: unknown, n = 1600): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} символов)` : s;
}

// Перебираем правдоподобные схемы auth — фиксируем ту, что даст 200.
const path = process.env.THESTATSAPI_PATH ?? "/api/football/matches?status=live";
const attempts: { label: string; url: string; headers: Record<string, string> }[] = [
  { label: "header x-api-key", url: `${BASE}${path}`, headers: { "x-api-key": KEY } },
  { label: "header Authorization: Bearer", url: `${BASE}${path}`, headers: { Authorization: `Bearer ${KEY}` } },
  { label: "query ?api_key=", url: `${BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(KEY)}`, headers: {} },
  { label: "query ?apikey=", url: `${BASE}${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(KEY)}`, headers: {} },
];

let ok: { label: string; body: any } | null = null;
for (const a of attempts) {
  try {
    const res = await fetch(a.url, { headers: a.headers });
    let body: any = null;
    try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
    console.log(`[${a.label}] HTTP ${res.status}`);
    if (res.status === 200 && !ok) { ok = { label: a.label, body }; break; }
    if (res.status !== 200) console.log("  ", trunc(body, 300));
  } catch (e) {
    console.log(`[${a.label}] ошибка: ${(e as Error).message}`);
  }
}

if (!ok) {
  console.log("\n✗ Ни одна схема auth не дала 200. Уточни в доках формат ключа и задай THESTATSAPI_PATH/THESTATSAPI_BASE.");
  process.exit(0);
}

console.log(`\n✓ Рабочая auth-схема: ${ok.label}`);
const matches = ok.body?.data ?? ok.body?.matches ?? ok.body;
console.log("=== Live матчи ===");
if (Array.isArray(matches)) {
  console.log(`Матчей: ${matches.length}`);
  const m = matches[0];
  if (m) {
    console.log("Ключи объекта match:", Object.keys(m).join(", "));
    console.log(trunc(m, 1400));
  }
} else {
  console.log(trunc(matches));
}

console.log("\n✓ probe-thestatsapi завершён");
