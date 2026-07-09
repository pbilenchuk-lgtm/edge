// ============================================================
// Betfair collector — RUN THIS ON A BETFAIR-ALLOWED HOST (EU/UA/UK), NOT on the
// US Render app. It logs into Betfair, prices our live/near matches, and POSTs
// snapshots back to the main app's ingest endpoint.
//
//   MAIN_APP_URL=https://edge-lab-oncj.onrender.com \
//   BETFAIR_INGEST_TOKEN=... BETFAIR_APP_KEY=... \
//   BETFAIR_USERNAME=... BETFAIR_PASSWORD=... \
//   BETFAIR_CERT_PEM="$(cat client.crt)" BETFAIR_KEY_PEM="$(cat client.key)" \
//   node --import tsx scripts/betfair-collect.ts
//
// Cadence: BETFAIR_POLL_SEC (default 20s), matching the live snapshot tick.
// ============================================================
import {
  loadBetfairConfig, certLogin, keepAlive, resolveEvent, marketPricesForEvent, toExtracted,
} from "../src/lib/betfair.js";

const MAIN = process.env.MAIN_APP_URL ?? "";
const TOKEN = process.env.BETFAIR_INGEST_TOKEN ?? "";
const POLL = Number(process.env.BETFAIR_POLL_SEC ?? 20) * 1000;
if (!MAIN || !TOKEN) { console.error("MAIN_APP_URL and BETFAIR_INGEST_TOKEN are required"); process.exit(1); }

const cfg = loadBetfairConfig();
if (cfg.session === undefined && (!cfg.username || !cfg.certPem)) {
  console.error("Provide BETFAIR_SESSION, or BETFAIR_USERNAME/PASSWORD + BETFAIR_CERT_PEM/KEY_PEM for cert login.");
  process.exit(1);
}

async function post(action: string, extra: Record<string, unknown>) {
  const r = await fetch(`${MAIN}/api/engine`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, token: TOKEN, ...extra }),
  });
  return r.json().catch(() => ({ ok: false }));
}

const eventCache = new Map<string, string | null>(); // matchId → betfair eventId (null = not found)

async function tick(session: string): Promise<void> {
  const batchAt = new Date().toISOString();
  const res: any = await post("activeMatchRefs", {});
  const refs: any[] = res?.refs ?? [];
  for (const ref of refs) {
    try {
      let eventId = eventCache.get(ref.matchId);
      if (eventId === undefined) {
        eventId = await resolveEvent(cfg, session, ref.home, ref.away, ref.kickoffIso);
        eventCache.set(ref.matchId, eventId);
      }
      if (!eventId) { // record a "not resolved" snapshot so the gap is visible
        await post("ingestSnapshot", { matchId: ref.matchId, batchAt, provider: "betfair", phase: ref.state === "live" ? "live" : "pre", ok: false, providerRef: null, extracted: { error: "event not resolved" } });
        continue;
      }
      const t0 = Date.now();
      const markets = await marketPricesForEvent(cfg, session, eventId);
      await post("ingestSnapshot", {
        matchId: ref.matchId, batchAt, provider: "betfair",
        phase: ref.state === "live" ? "live" : "pre", ok: markets.length > 0,
        providerRef: eventId, latencyMs: Date.now() - t0,
        extracted: toExtracted(markets), raw: JSON.stringify(markets),
      });
    } catch (e) {
      console.error(`[betfair] ${ref.home}-${ref.away}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[betfair] ${batchAt} priced ${refs.length} match(es)`);
}

// --- main loop ---
let session = cfg.session ?? (await certLogin(cfg));
console.log("[betfair] logged in; polling every", POLL / 1000, "s");
let lastKeepAlive = Date.now();
// eslint-disable-next-line no-constant-condition
while (true) {
  try { await tick(session); } catch (e) { console.error("[betfair] tick error:", e instanceof Error ? e.message : e); }
  // Betfair sessions idle-expire; keep-alive every ~10 min, re-login on failure.
  if (Date.now() - lastKeepAlive > 600_000) {
    lastKeepAlive = Date.now();
    if (!(await keepAlive(cfg, session)) && !cfg.session) { try { session = await certLogin(cfg); console.log("[betfair] re-logged in"); } catch (e) { console.error("[betfair] re-login failed:", e); } }
  }
  await new Promise((r) => setTimeout(r, POLL));
}
