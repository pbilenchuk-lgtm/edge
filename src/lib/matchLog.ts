// ============================================================
// EDGE LAB — full match-log export. Assembles EVERYTHING recorded for one match
// into a single markdown document for offline analysis: the live-data / provider
// status (the entry-gate diagnosis), the analysis artifacts, every strategist
// decision (incl. its error field), battle sheets, bets, reassessments, the trade
// log, events, provider snapshots, and the recent cron log. Read-only.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

/** Resolve a match by exact id, else a case-insensitive team-name substring.
 *  Prefers the most recent match when several fixtures match the same query. */
export function findMatch(db: Database, query: string): { id: string } | null {
  const q = query.trim().toLowerCase();
  const all = R.listCompetitions(db).flatMap((c) => R.listMatches(db, c.id));
  const exact = all.find((m) => m.id === query);
  if (exact) return { id: exact.id };
  const hits = all.filter((m) => `${m.home} ${m.away}`.toLowerCase().includes(q));
  if (!hits.length) return null;
  hits.sort((a, b) => (a.kickoff_at ?? "") < (b.kickoff_at ?? "") ? 1 : -1);
  return { id: hits[0].id };
}

const j = (x: unknown) => "```json\n" + JSON.stringify(x, null, 2) + "\n```";

/** True iff the engine considers this match to have provider live coverage — the
 *  exact predicate autoEnter gates entry on. Mirror of lifecycle.hasLiveData (kept
 *  local to avoid a circular import). */
function liveDataStatus(db: Database, matchId: string): { ok: boolean; via: string } {
  const live = R.getMatchLive(db, matchId);
  if (live) return { ok: true, via: `match_live row (провайдер отдал матч; составы ${live.home_lineup ? "есть" : "нет"}, статистика ${live.stats ? "есть" : "нет"})` };
  const m = R.getMatch(db, matchId);
  if (m?.state === "live" && m.minute != null) return { ok: true, via: "state=live + minute" };
  const realEvents = R.eventsForMatch(db, matchId).filter((e) => e.type !== "stats" && e.type !== "other");
  if (realEvents.length) return { ok: true, via: `${realEvents.length} реальных событий` };
  return { ok: false, via: "НЕТ (нет match_live-строки, нет live-минуты, нет реальных событий) → autoEnter держит предложения как превью, не входит" };
}

export function buildMatchLog(db: Database, matchId: string): string {
  const m = R.getMatch(db, matchId);
  if (!m) return `# Матч ${matchId} не найден`;
  const comp = R.listCompetitions(db).find((c) => c.id === m.competition_id);
  const L: string[] = [];
  const h = (s: string) => L.push("\n## " + s);

  L.push(`# Лог матча: ${m.home} — ${m.away}`);
  L.push(`- Матч ID: \`${m.id}\``);
  L.push(`- Категория: ${comp?.name ?? "?"} (\`${comp?.id}\`, external_league=\`${comp?.external_league ?? "null"}\`, бюджет $${comp?.budget ?? 0})`);
  L.push(`- Состояние: **${m.state}**${m.lineup_out ? " · составы: out" : ""} · счёт ${m.score_home ?? "?"}:${m.score_away ?? "?"}${m.final_score ? ` (итог ${m.final_score})` : ""}${m.minute != null ? ` · ${m.minute}'` : ""}${m.clock ? ` (${m.clock})` : ""}`);
  L.push(`- Kickoff: ${m.kickoff_at ?? "?"} · external_ref: \`${m.external_ref ?? "null"}\``);

  // ── The entry-gate diagnosis (why bets did / didn't enter) ──
  h("Провайдер и live-данные (диагноз входа)");
  const lds = liveDataStatus(db, m.id);
  L.push(`- **hasLiveData: ${lds.ok ? "ДА" : "НЕТ"}** — ${lds.via}`);
  const live = R.getMatchLive(db, m.id);
  L.push(`- match_live: ${live ? `есть (espn_event_id=\`${live.espn_event_id ?? "null"}\`, league=\`${live.league ?? "null"}\`, обновлён ${live.updated_at})` : "**НЕТ** — ни ESPN, ни StatPal не привязали эту фикстуру (проверь совпадение имён команд и покрытие StatPal)"}`);
  const xg = R.latestLiveXg(db, m.id);
  L.push(`- live xG: ${xg ? `дом ${xg.home} – ${xg.away} гости (${xg.provider}${xg.minute != null ? `, ${xg.minute}'` : ""})` : "нет"}`);
  L.push(`- provider-refs: ${["sportmonks", "thestatsapi", "statpal"].map((p) => { const r = R.getProviderRef(db, m.id, p); return `${p}=${r?.provider_ref ?? "—"}`; }).join(" · ")}`);

  // ── Current markets ──
  h("Рынки (текущие котировки + ai_prob)");
  const markets = R.latestMarkets(db, m.id);
  if (!markets.length) L.push("(нет рынков)");
  for (const mk of markets) L.push(`- ${mk.label}: ${mk.price}¢${mk.ai_prob != null ? ` · ai_prob ${(mk.ai_prob * 100).toFixed(0)}%` : ""}${mk.liquidity ? ` · ликв. ${mk.liquidity}` : ""}`);

  // ── Analysis artifacts (base / category / distribution) ──
  const arts = R.artifactsForMatch(db, m.id);
  const byKind = (k: string) => arts.filter((a) => a.kind === k);
  h("Анализ (Слой 1 base / Слой 2 category / assembled distribution)");
  for (const kind of ["base", "category", "distribution"]) {
    for (const a of byKind(kind)) { L.push(`\n### ${kind}${a.label ? ` · ${a.label}` : ""} (${a.stage}, ${a.model ?? "?"}, ${a.created_at})`); L.push(safeJson(a.content)); }
  }

  // ── Strategist decisions (THE root-cause surface: dec.ok / dec.error) ──
  h("Решения стратегов (artifact kind=strategist — тут виден dec.ok и dec.error)");
  const strat = byKind("strategist");
  if (!strat.length) L.push("(нет — стратег не вызывался)");
  for (const a of strat) {
    let ok: unknown = "?", err: unknown = "";
    try { const d = JSON.parse(a.content); ok = d.ok; err = d.error ?? ""; } catch { /* keep raw */ }
    L.push(`\n### ${a.label ?? "?"} (${a.stage}, ${a.created_at}) — ok=${ok}${err ? ` · ОШИБКА: ${err}` : ""}`);
    L.push(safeJson(a.content));
  }

  // ── Battle sheets (per pair: sizing + armed configs) ──
  h("Боевые листы (battle_sheet — сайзинг по коду + live_triggers_armed / live_entry_config)");
  for (const a of byKind("battle_sheet")) { L.push(`\n### ${a.label ?? "?"} (${a.stage}, ${a.created_at})`); L.push(safeJson(a.content)); }

  // ── Bets (all statuses) ──
  h("Ставки (все статусы)");
  const bets = R.betsForMatch(db, m.id);
  if (!bets.length) L.push("(нет ставок)");
  for (const b of bets) {
    L.push(`- [${b.status}] ${b.market_label} · ${b.strategy_id}/${b.risk_profile_id ?? "?"} · предл.${b.proposed_price ?? "—"}¢ вход ${b.entry_price ?? "—"}¢ тек.${b.current_price ?? "—"}¢ · $${b.stake ?? 0} · ai_prob ${b.ai_prob != null ? (b.ai_prob * 100).toFixed(0) + "%" : "—"} · вход:${b.entered_minute ?? "—"}${b.result ? ` · ${b.result} payout $${b.payout ?? 0}` : ""}${b.settled_by ? ` (${b.settled_by})` : ""}`);
    if (b.rationale) L.push(`    ↳ ${b.rationale}`);
  }

  // ── Reassessments (live) ──
  h("Переоценки (live)");
  const re = R.reassessmentsForMatch(db, m.id);
  if (!re.length) L.push("(нет)");
  for (const r of re) L.push(`- ${r.minute ?? "?"} · ${r.strategy_id} · [${r.trigger ?? "?"}] ${r.body}`);

  // ── Trade log (enter/exit/settle/skip — incl. strategist-outage notes) ──
  h("Трейд-лог (входы/выходы/сеттл/скипы — тут и «стратег недоступен»)");
  const tl = R.tradeLogForMatch(db, m.id);
  if (!tl.length) L.push("(нет)");
  for (const t of tl) L.push(`- ${t.minute ?? "?"} · ${t.strategy_id} · [${t.type}] ${t.text}`);

  // ── Match events ──
  h("События матча");
  const ev = R.eventsForMatch(db, m.id).filter((e) => e.type !== "stats");
  if (!ev.length) L.push("(нет реальных событий — вероятная причина отсутствия live-данных)");
  for (const e of ev) L.push(`- ${e.minute ?? "?"}' ${e.type}${e.team ? " " + e.team : ""}${e.text ? ` — ${e.text}` : ""}`);

  // ── Provider snapshots (raw-capture layer: was StatPal/Sportmonks queried?) ──
  h(`Снимки провайдеров (${R.snapshotCount(db, m.id)} шт — сырьё StatPal/Sportmonks/TheStatsAPI/Polymarket)`);
  const snaps = R.snapshotMetaForMatch(db, m.id, 60);
  const byProv: Record<string, number> = {};
  for (const s of snaps) byProv[s.provider] = (byProv[s.provider] ?? 0) + 1;
  L.push(`- по провайдерам: ${Object.entries(byProv).map(([p, n]) => `${p}=${n}`).join(" · ") || "нет"}`);
  for (const s of snaps.slice(0, 24)) {
    let extract = "";
    try { extract = s.extracted ? ` · extracted: ${JSON.stringify(JSON.parse(s.extracted)).slice(0, 300)}` : ""; } catch { /* ignore */ }
    L.push(`- ${s.batch_at} · ${s.provider} · ${s.phase} · ok=${s.ok} http=${s.http_status ?? "—"} lat=${s.latency_ms ?? "—"}ms${s.minute != null ? ` ${s.minute}'` : ""}${extract}`);
  }

  // ── Recent cron log (ИИ-сбои count) ──
  h("Cron-лог (последние прогоны — ИИ-сбои видны тут)");
  for (const c of R.recentCronLog(db, 20)) L.push(`- ${c.at} · [${c.kind}] ok=${c.ok} · ${c.summary}`);

  return L.join("\n");
}

/** JSON-in-a-fence if valid JSON, else the raw content fenced. */
function safeJson(content: string): string {
  try { return j(JSON.parse(content)); } catch { return "```\n" + content + "\n```"; }
}
