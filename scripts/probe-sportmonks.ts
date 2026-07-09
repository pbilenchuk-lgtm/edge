// Live Sportmonks probe — inspects the REAL in-play payload for our decision:
//   what comes через live-фид, с какой глубиной, и есть ли xG.
// Run: SPORTMONKS_KEY=... npm run sm:probe
// Docs: https://docs.sportmonks.com/football  (v3, auth via ?api_token=)
import "../src/lib/http.js"; // proxy-aware fetch

const KEY = process.env.SPORTMONKS_KEY ?? process.env.SPORTMONKS_API_KEY ?? process.env.Sportmonks ?? process.env.SPORTMONKS ?? "";
const BASE = process.env.SPORTMONKS_BASE ?? "https://api.sportmonks.com/v3/football";
if (!KEY) {
  console.error("✗ Нет ключа. Задай SPORTMONKS_KEY в окружении (env этой сессии, не Render).");
  process.exit(1);
}

// v3 includes we care about. statistics/events/lineups — «глубина» лайва;
// xGFixture — платный add-on (проверяем, приходит ли он с этим ключом).
const INCLUDE = process.env.SPORTMONKS_INCLUDE
  ?? "participants;scores;state;periods;events;statistics;lineups;league";

async function get(path: string): Promise<{ status: number; body: any }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE}${path}${sep}api_token=${encodeURIComponent(KEY)}`;
  const res = await fetch(url);
  let body: any = null;
  try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
  return { status: res.status, body };
}

function trunc(v: unknown, n = 1400): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} символов)` : s;
}

// 1) Кого вообще разрешает ключ (какие лиги/план) — эндпоинт «мой аккаунт».
console.log("=== 1. Доступ ключа (leagues в подписке) ===");
{
  const { status, body } = await get("/leagues?filters=&per_page=50");
  console.log("HTTP", status);
  const rows = body?.data ?? [];
  if (Array.isArray(rows)) {
    console.log(`Лиг доступно: ${rows.length}${body?.pagination ? ` (total=${body.pagination.count ?? "?"})` : ""}`);
    for (const l of rows.slice(0, 40)) console.log(`  • ${l.id}  ${l.name}${l.country_id ? "  country=" + l.country_id : ""}`);
  } else {
    console.log(trunc(body));
  }
}

// 2) Живые матчи прямо сейчас + вся доступная глубина.
console.log("\n=== 2. Live inplay (глубина фида) ===");
const { status, body } = await get(`/livescores/inplay?include=${encodeURIComponent(INCLUDE)}`);
console.log("HTTP", status);
const fixtures = body?.data ?? [];
if (!Array.isArray(fixtures) || fixtures.length === 0) {
  console.log("Сейчас нет матчей in-play (или include не разрешён планом). Ответ:");
  console.log(trunc(body));
} else {
  console.log(`Матчей in-play: ${fixtures.length}`);
  const f = fixtures[0];
  console.log(`\n— Разбор первого матча (fixture ${f.id}) —`);
  console.log("Ключи объекта fixture:", Object.keys(f).join(", "));
  console.log("name:", f.name, "| state:", f.state?.state ?? f.state, "| minute:", f?.periods?.data?.at?.(-1)?.minutes ?? "?");
  console.log("participants:", (f.participants?.data ?? f.participants ?? []).map((p: any) => `${p.name}(${p.meta?.location ?? "?"})`).join(" vs "));
  console.log("scores:", trunc(f.scores?.data ?? f.scores, 500));
  console.log("events sample:", trunc((f.events?.data ?? f.events ?? []).slice(0, 6), 900));
  console.log("statistics sample:", trunc((f.statistics?.data ?? f.statistics ?? []).slice(0, 12), 900));
  console.log("lineups present:", Array.isArray(f.lineups?.data ?? f.lineups) ? (f.lineups?.data ?? f.lineups).length : "нет");
}

// 3) Отдельная проверка xG (add-on). Если план без него — тут будет ошибка/пусто.
console.log("\n=== 3. xG (add-on проверка) ===");
if (Array.isArray(fixtures) && fixtures.length) {
  const id = fixtures[0].id;
  const xg = await get(`/fixtures/${id}?include=xGFixture`);
  console.log("HTTP", xg.status);
  console.log(trunc(xg.body?.data?.xGFixture ?? xg.body?.data?.xgfixture ?? xg.body, 900));
} else {
  console.log("Нет live-матча для проверки xG — перезапусти во время игры.");
}

console.log("\n✓ probe-sportmonks завершён");
