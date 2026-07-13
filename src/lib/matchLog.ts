// ============================================================
// EDGE LAB — full match-log export. Assembles EVERYTHING recorded for one match
// into a single markdown document for offline analysis: the live-data / provider
// status (the entry-gate diagnosis), the analysis artifacts, every strategist
// decision (incl. its error field), battle sheets, bets, reassessments, the trade
// log, events, provider snapshots, and the recent cron log. Read-only.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { summarizeFillCosts } from "./fillCosts.js";
import { loadShadowConfig } from "./shadow.js";

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
const round0 = (n: number) => Math.round(n);
const round2 = (n: number) => Math.round(n * 100) / 100;

// Shadow denial/trim reasons → readable labels (mirror of ShadowScreen's map).
const SHADOW_REASON: Record<string, string> = {
  insufficient_free: "нет свободных средств", cash_reserve: "неснижаемый остаток",
  live_buffer: "буфер под live", cap_match: "потолок матча",
  cap_category: "потолок категории", cap_strategy: "потолок стратегии",
};

/** The EXACT predicate autoEnter gates entry on (kept local to avoid a circular
 *  import). Pre-kickoff (upcoming/lineup) needs only the fixture confirmed; a LIVE
 *  match needs the provider actually DELIVERING in-play data — a lineup-only
 *  match_live on a fixture ESPN still shows "pre" (frozen 0', no stats/events) does
 *  NOT count, so we don't take blind in-play capital. */
function liveDataStatus(db: Database, matchId: string): { ok: boolean; via: string } {
  const m = R.getMatch(db, matchId);
  const live = R.getMatchLive(db, matchId);
  const realEvents = R.eventsForMatch(db, matchId).filter((e) => e.type !== "stats" && e.type !== "other");
  const football = R.listCompetitions(db).some((c) => c.id === m?.competition_id && c.sport_id === "football");
  if (m?.state === "live") {
    // Live: require real delivery — an event, or a real ADVANCING minute. NOT
    // match_live.stats (ESPN returns a zeros stats object even for a "pre" fixture).
    if (realEvents.length) return { ok: true, via: `${realEvents.length} реальных событий` };
    if (!football && live) return { ok: true, via: "match_live (не-футбол: live-борд)" };
    if (m.minute != null && m.minute > 0) return { ok: true, via: `провайдерская минута ${m.minute}'` };
    return { ok: false, via: `LIVE по таймеру, но провайдер live НЕ отдаёт (минута 0', нет событий${live?.stats ? "; статы есть, но это нули pre-матча" : ""}) → провайдер показывает «pre»/лагает; autoEnter НЕ входит (иначе слепой капитал)` };
  }
  // Pre-kickoff: the fixture being confirmed (match_live / lineups) is enough — a
  // fill here is a pre-match entry, no live feed needed.
  if (live) return { ok: true, via: `match_live row (составы ${live.home_lineup ? "есть" : "нет"}, статистика ${live.stats ? "есть" : "нет"}) — предматч, вход по подтверждённой фикстуре` };
  if (realEvents.length) return { ok: true, via: `${realEvents.length} реальных событий` };
  return { ok: false, via: "НЕТ (нет match_live-строки, нет реальных событий) → autoEnter держит предложения как превью, не входит" };
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

  // ── Shadow budget (the whole-bank allocator layer: what it reserved / denied) ──
  // The real bets above are sized off each pair's isolated budget; the shadow pool
  // re-decides every fill against ONE shared bank (caps, cash floor, live-buffer).
  // This is the layer that will GATE real money — so the per-match log must show its
  // verdicts, the reason a fill was blocked/trimmed, and the P&L those denials touched.
  h("Теневой бюджет (shadow — единый банк, каденция реальных денег)");
  const shEvents = R.shadowEventsForMatch(db, m.id);
  const shReserves = R.shadowReservesForMatch(db, m.id);
  if (!shEvents.length && !shReserves.length) {
    // Disambiguate the empty case: an OFF allocator never modelled this match, vs an ON
    // allocator that simply saw no fills yet — two very different states that used to read
    // identically ("аллокатор выключен, или входов ещё не было").
    L.push(loadShadowConfig(db).enabled
      ? "(аллокатор включён — но по этому матчу ещё не было ни входов, ни решений пула)"
      : "(теневой аллокатор ВЫКЛЮЧЕН — shadow-слой по этому матчу не считался)");
  } else {
    const reqSum = round0(shEvents.reduce((s, e) => s + e.size_requested, 0));
    const resSum = round0(shEvents.reduce((s, e) => s + e.size_reserved, 0));
    const blocked = shEvents.filter((e) => e.verdict === "blocked");
    const trimmed = shEvents.filter((e) => e.verdict === "trimmed");
    // Real P&L of the fills the pool DENIED (blocked) or SHRANK (trimmed) — the money a
    // real-bank gate would have missed/avoided. Weight by the UN-funded fraction (blocked =
    // 100%, trimmed = the part the pool didn't fund) so this reconciles with the global log
    // and shadowAnalytics.missedPnl, which use the same weighting. Observe-only.
    const deniedPnl = round2([...blocked, ...trimmed].reduce((s, e) => {
      const bet = e.bet_id ? R.getBet(db, e.bet_id) : null;
      const settled = bet && (bet.status === "settled_won" || bet.status === "settled_lost");
      if (!settled || bet!.payout == null || bet!.stake == null) return s;
      const unfunded = e.size_requested > 0 ? (e.size_requested - e.size_reserved) / e.size_requested : 0;
      return s + (bet!.payout - bet!.stake) * unfunded;
    }, 0));
    const heldNow = round0(shReserves.filter((r) => r.state === "reserved").reduce((s, r) => s + r.size, 0));
    const settlingNow = round0(shReserves.filter((r) => r.state === "settling").reduce((s, r) => s + r.size, 0));
    L.push(`- Итог: ${shEvents.length} решений · запрошено $${reqSum} → зарезервировано $${resSum} · заблокировано ${blocked.length} · урезано ${trimmed.length}`);
    L.push(`- Реальный P&L входов, которым пул ОТКАЗАЛ/УРЕЗАЛ: ${deniedPnl < 0 ? `-$${Math.abs(deniedPnl)}` : `+$${deniedPnl}`} (плюс = дефицит стоил денег; минус = уберёг от убытка)`);
    L.push(`- Держится сейчас по матчу: $${heldNow} зарезервировано${settlingNow ? ` · $${settlingNow} в резолве (лаг)` : ""}`);
    if (blocked.length || trimmed.length) {
      const byReason: Record<string, number> = {};
      for (const e of [...blocked, ...trimmed]) if (e.reason) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
      L.push(`- Причины отказа/урезания: ${Object.entries(byReason).map(([r, n]) => `${SHADOW_REASON[r] ?? r}=${n}`).join(" · ") || "—"}`);
    }
    L.push("\nРешения (в порядке времени):");
    for (const e of shEvents) {
      const v = e.verdict === "allowed" ? "принят" : e.verdict === "trimmed" ? "урезан" : "отказ";
      const why = e.reason ? ` · ${SHADOW_REASON[e.reason] ?? e.reason}` : "";
      L.push(`- ${e.created_at} · ${e.strategy_id}/${e.profile_id} · ${e.is_live ? "live" : "предматч"} · $${round0(e.size_requested)}→$${round0(e.size_reserved)} · **${v}**${why} · edge ${(e.edge * 100).toFixed(1)}%${e.contention ? " · ⚔ конкуренция" : ""}`);
    }
  }

  // ── Execution costs (fees + slippage — the real-money leak, folded into P&L) ──
  h("Издержки исполнения (комиссии + слиппедж — на реальных деньгах это прямой минус)");
  const fills = R.fillCostsForMatch(db, m.id);
  if (!fills.length) {
    L.push("(нет исполнений с книгой — котировочный фолбэк или входов ещё не было)");
  } else {
    const fc = summarizeFillCosts(fills);
    L.push(`- Итог: ${fc.fills} исполнений (${fc.buys} вход / ${fc.sells} выход) на оборот $${round0(fc.notionalUsd)}`);
    L.push(`- Комиссии: **$${fc.feeUsd}** (вход $${fc.feeBuyUsd} · выход $${fc.feeSellUsd})`);
    L.push(`- Слиппедж: **$${fc.slipUsd}** (вход $${fc.slipBuyUsd} · выход $${fc.slipSellUsd}) · средний ${fc.avgSlipCents}¢/шт`);
    L.push(`- Всего издержек: **$${fc.totalUsd}** = ${fc.costPctOfNotional}% от оборота${fc.modelledFills ? ` · ${fc.modelledFills} исп. по модели (без реальной книги)` : ""}`);
    L.push("\nПо исполнениям:");
    for (const f of fills) {
      L.push(`- ${f.created_at} · ${f.strategy_id}/${f.profile_id} · ${f.side === "buy" ? "вход" : "выход"} $${round0(f.notional_usd)} · котир. ${f.quote_cents ?? "—"}¢ → VWAP ${f.vwap_cents ?? "—"}¢ · комиссия $${round2(f.fee_usd)} (${f.fee_cents}¢/шт) · слип $${round2(f.slip_usd)} (${f.slip_cents}¢/шт)${f.from_book ? "" : " · модель"}`);
    }
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
