// Глубина фида по КОНКРЕТНОМУ матчу (когда нет live прямо сейчас) — смотрим
// реальную структуру: события, статистику, составы и xG.
// Run: SPORTMONKS_KEY=... THESTATSAPI_KEY=... npm run depth:probe [YYYY-MM-DD-from] [YYYY-MM-DD-to]
import "../src/lib/http.js";

const SM = process.env.SPORTMONKS_KEY ?? process.env.Sportmonks ?? "";
const TSA = process.env.THESTATSAPI_KEY ?? "";
const from = process.argv[2] ?? "2026-07-01";
const to = process.argv[3] ?? "2026-07-09";

function trunc(v: unknown, n = 1800): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} символов)` : s;
}

// ---------- Sportmonks ----------
if (SM) {
  const SB = "https://api.sportmonks.com/v3/football";
  const inc = "participants;scores;state;events;statistics.type;periods;lineups;xGFixture";
  const url = `${SB}/fixtures/between/${from}/${to}?api_token=${SM}&include=${encodeURIComponent(inc)}&per_page=50`;
  console.log("=== SPORTMONKS: матчи", from, "→", to, "===");
  const res = await fetch(url);
  const body: any = await res.json().catch(() => null);
  console.log("HTTP", res.status);
  const fx = body?.data ?? [];
  console.log(`Матчей в диапазоне: ${Array.isArray(fx) ? fx.length : 0}`);
  if (Array.isArray(fx) && fx.length) {
    // берём последний завершённый (у него будут статы/xG)
    const done = fx.filter((f: any) => /FT|Finished|Ended/i.test(f.state?.state ?? f.state?.name ?? "")).at(-1) ?? fx.at(-1);
    console.log(`\n— fixture ${done.id}: ${done.name} (${done.state?.state ?? done.state}) —`);
    console.log("Топ-ключи:", Object.keys(done).join(", "));
    console.log("scores:", trunc(done.scores?.data ?? done.scores, 400));
    const evs = done.events?.data ?? done.events ?? [];
    console.log(`events: ${evs.length}. Пример:`, trunc(evs.slice(0, 4), 700));
    const sts = done.statistics?.data ?? done.statistics ?? [];
    console.log(`statistics: ${sts.length}. Пример (с type):`, trunc(sts.slice(0, 8), 900));
    const xg = done.xgfixture?.data ?? done.xGFixture?.data ?? done.xgfixture ?? done.xGFixture ?? null;
    console.log("xG (xGFixture):", xg ? trunc(xg, 700) : "НЕ пришло (нет в плане или в этом матче)");
    const lu = done.lineups?.data ?? done.lineups ?? [];
    console.log(`lineups: ${Array.isArray(lu) ? lu.length : 0} игроков`);
  } else {
    console.log(trunc(body, 700));
  }
}

// ---------- TheStatsAPI ----------
if (TSA) {
  const TB = process.env.THESTATSAPI_BASE ?? "https://api.thestatsapi.com";
  const H = { Authorization: `Bearer ${TSA}` };
  console.log("\n=== THESTATSAPI: недавние матчи ===");
  // пробуем несколько вариантов, какой отдаст завершённые матчи со статой
  const paths = [
    `/api/football/matches?status=finished`,
    `/api/football/matches?date=${to}`,
    `/api/football/matches`,
  ];
  for (const p of paths) {
    const res = await fetch(`${TB}${p}`, { headers: H });
    const body: any = await res.json().catch(() => null);
    const rows = body?.data ?? body?.matches ?? (Array.isArray(body) ? body : null);
    console.log(`[${p}] HTTP ${res.status} → ${Array.isArray(rows) ? rows.length + " матч(ей)" : "не список"}`);
    if (Array.isArray(rows) && rows.length) {
      const m = rows[0];
      console.log("Ключи match:", Object.keys(m).join(", "));
      console.log(trunc(m, 1400));
      // детальный эндпоинт по id, если есть
      const id = m.match_id ?? m.id;
      if (id) {
        const d = await fetch(`${TB}/api/football/matches/${id}`, { headers: H });
        const db: any = await d.json().catch(() => null);
        console.log(`\n[match ${id} detail] HTTP ${d.status}:`, trunc(db, 1400));
      }
      break;
    }
  }
}

console.log("\n✓ probe-depth завершён");
