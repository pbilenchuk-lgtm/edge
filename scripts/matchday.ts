// ─────────────────────────────────────────────────────────────────────────────
// EDGE LAB — match-day readiness check. Run in the Render shell (SSH) to verify
// that today's / upcoming matches are wired up: live-provider link, lineups, and
// whether the AI has run (or will auto-run before kickoff).
//
//   EDGE_DB_PATH=/app/data/edge-compact.db node --experimental-sqlite --import tsx scripts/matchday.ts
//
// For each football match within the next 24h it prints:
//   ESPN   — is the match linked to the live provider (provider_match_map)?
//   XI     — has the real starting lineup been captured?
//   AI     — pre/post analysis done? (✓pre ✓post) and the model used
//   AUTO   — will the scheduler auto-analyze it before kickoff? (accounts for the
//            new lineup-fallback: within LINEUP_FALLBACK_MIN it analyzes even w/o XI)
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { LINEUP_FALLBACK_MIN, ANALYZE_PRE_HOURS } from "../src/lib/lifecycle.js";

const db = getDb();
const now = Date.now();
const HORIZON_H = Number(process.env.MATCHDAY_HORIZON_H) || 24;

const espnRef = db.prepare(`SELECT provider_ref FROM provider_match_map WHERE match_id=? AND provider='espn'`);
const fallbackMin = LINEUP_FALLBACK_MIN;

let total = 0;
for (const c of R.listCompetitions(db, "football")) {
  const rows: string[] = [];
  for (const m of R.listMatches(db, c.id)) {
    if (m.state === "finished") continue;
    const h = m.kickoff_at ? (Date.parse(m.kickoff_at) - now) / 3_600_000 : null;
    if (h == null || h > HORIZON_H) continue;               // only the next 24h
    const minsToKick = h * 60;
    const espn = (espnRef.get(m.id) as { provider_ref?: string } | undefined)?.provider_ref;
    const xi = R.hasLineups(db, m.id);
    const asmts = R.assessmentsForMatch(db, m.id).filter((a) => a.status === "ok");
    const pre = asmts.find((a) => a.stage === "pre_lineup");
    const post = asmts.find((a) => a.stage === "post_lineup");
    const model = post?.model ?? pre?.model ?? "—";
    const analysed = pre || post;
    // Will the scheduler pick it up before kickoff?
    const awaiting = !xi && (m.state === "upcoming" || m.state === "lineup");
    const fallbackNow = minsToKick > 0 && minsToKick <= fallbackMin;
    const funded = (c.budget ?? 0) > 0;
    const hasOdds = R.latestMarkets(db, m.id).length > 0;
    let auto: string;
    if (!funded) auto = "—(budget 0)";
    else if (!hasOdds) auto = "нет котировок";
    else if (analysed) auto = "готов";
    else if (h > ANALYZE_PRE_HOURS) auto = `ждёт (>${ANALYZE_PRE_HOURS}ч)`;
    else if (awaiting && !fallbackNow) auto = `ждёт XI / fallback ${fallbackMin}м`;
    else auto = "запустится";
    const kt = m.kickoff_at ? new Date(m.kickoff_at).toISOString().slice(5, 16).replace("T", " ") : "?";
    rows.push(
      `  ${kt} ${m.home}–${m.away}\n` +
      `      state=${m.state} · ESPN=${espn ? "✓" : "✗"} · XI=${xi ? "✓" : "✗"} · ` +
      `AI=${pre ? "✓pre" : "·pre"} ${post ? "✓post" : "·post"} (${model}) · AUTO=${auto}`,
    );
    total++;
  }
  if (rows.length) {
    console.log(`\n▄ ${c.name}  [budget $${c.budget}]`);
    console.log(rows.join("\n"));
  }
}
console.log(`\n${total} матч(ей) в ближайшие ${HORIZON_H}ч. Fallback-анализ без составов: за ${fallbackMin} мин до старта.`);
if (!total) console.log("(пусто — либо нет матчей на сегодня, либо не подтянулись с Polymarket)");
