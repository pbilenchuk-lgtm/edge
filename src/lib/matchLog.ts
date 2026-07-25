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
import { loadAnalysisDuel } from "./analysisDuel.js";

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
  const sportId = R.listCompetitions(db).find((c) => c.id === m?.competition_id)?.sport_id;
  const football = sportId === "football";
  // TENNIS: there is NO ESPN/StatPal match_live row and no events table row — liveness lives
  // ENTIRELY in the scout (tennis_snapshots). Reading the football provider path here would
  // falsely report "нет live-данных" for a tennis match the scout is actively feeding (and did
  // feed the trades). Consult the scout directly (local, to avoid a circular import).
  if (sportId === "tennis") {
    const snap = db.prepare(`SELECT live, batch_at, set_num, games_p1, games_p2 FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`).get(matchId) as { live?: number; batch_at?: string; set_num?: number; games_p1?: number; games_p2?: number } | undefined;
    const total = (db.prepare(`SELECT COUNT(*) n FROM tennis_snapshots WHERE pm_match_id=?`).get(matchId) as { n?: number } | undefined)?.n ?? 0;
    if (!snap) return { ok: false, via: "теннис: скаут не привязал матч (0 снапшотов tennis_snapshots) — маппинг имён не сошёлся или скаут не видит матч live" };
    const ageMin = Math.round((Date.now() - (Date.parse(snap.batch_at ?? "") || 0)) / 60000);
    // T6: env-tunable staleness (was hardcoded 15), mirrors TENNIS_SCOUT_STALE_MIN so the two never drift.
    const staleMin = (() => { const n = Number(process.env.TENNIS_SCOUT_STALE_MIN); return Number.isFinite(n) && n > 0 ? n : 15; })();
    const fresh = ageMin <= staleMin;
    const score = `сет ${snap.set_num ?? "?"}, геймы ${snap.games_p1 ?? "?"}-${snap.games_p2 ?? "?"}`;
    if (snap.live === 1 && fresh) return { ok: true, via: `теннис-скаут live (${total} снапшотов, свежий ${ageMin}м назад · ${score})` };
    // T4: a FINISHED match legitimately stops receiving fresh snapshots — the scout stop-polled after the
    // terminal snapshot (which still carries live=1 Finished). Report that, NOT a false "скаут молчит /
    // крон простаивал" outage — the match just ended, nothing is broken.
    if (snap.live === 1 && m?.state === "finished") return { ok: false, via: `теннис-скаут: матч завершён ${ageMin}м назад — скаут корректно остановился (${total} снапшотов · ${score})` };
    if (snap.live === 1) return { ok: false, via: `теннис-скаут: последний снапшот live, но устарел (${ageMin}м > ${staleMin}м) — скаут молчит (крон/скаут простаивал)` };
    return { ok: false, via: `теннис-скаут: последний снапшот не live (${total} снапшотов, ${ageMin}м назад · ${score})` };
  }
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
  return { ok: false, via: "НЕТ (нет match_live-строки, нет реальных событий) — сам по себе это ещё НЕ причина невхода: ft_blind может войти вслепую, см. «Почему не было входа»" };
}

// [V0.1 / batch-9] WHY there was no entry — the REAL blocker, not a guess.
//
// The old one-liner claimed «autoEnter держит предложения как превью» for every hasLiveData=НЕТ match. That
// text is a lie on a blind FUNDED fixture where ft_blind is exactly the mode that MAY fill: it sent the
// Samegrelo/Varnamo root-cause hunt at the preview branch, while the true blocker was upstream (a book parked
// at 50¢ → placeholder_mid quarantine, and in Varnamo's case not a single proposal was ever produced).
// This walks autoEnter's ACTUAL gate order and names the first gate that would stop each proposal, so the log
// answers «на каком условии умирает вход» directly. Read-only, best-effort, never throws.
const FT_SETTLED_RE = /\b(over|under|btts|both teams|draw|ничья|тотал)\b|[—-]\s*(yes|no|да|нет)\s*$/i;
export function entryBlockerDiag(db: Database, matchId: string, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  try {
    const m = R.getMatch(db, matchId);
    if (!m) return ["матч не найден"];
    const sportId = R.listCompetitions(db).find((c) => c.id === m.competition_id)?.sport_id ?? "football";
    const markets = R.latestMarkets(db, m.id);
    const bets = R.betsForMatch(db, m.id);
    const proposed = bets.filter((b) => b.status === "proposed");
    const filled = bets.filter((b) => b.status === "open" || R.isSettled(b.status));
    if (filled.length) out.push(`вход БЫЛ: ${filled.length} позиц. заполнено — блокеры ниже относятся только к оставшимся предложениям`);
    // Gate 0 — quotes at all.
    if (!markets.length) { out.push("НЕТ КОТИРОВОК: ни одного рынка в снапшотах — autoEnter выходит до всех гейтов"); return out; }
    // Gate 0b — the book itself. A book parked at ~50¢ is an untraded placeholder: any «edge» against it is a
    // phantom, and the zombie placeholder_mid rule blocks the fill. This is the Samegrelo/Varnamo case.
    const parked = markets.filter((mk) => Math.abs((mk.price ?? 0) - 50) <= 0.6).length;
    if (parked) out.push(`КНИГА НЕ РАЗМЕЧЕНА: ${parked}/${markets.length} рынков стоят на ~50¢ (неторгованный дефолт) → любой edge против них фантом; zombie placeholder_mid режет вход. Это не гейт входа, а отсутствие настоящей цены`);
    // Gate 1 — pre-lineup preview hold (the branch the old text always blamed).
    const preLineupHold = R.LINEUP_SPORTS.has(sportId) && !m.lineup_out && (m.state === "upcoming" || m.state === "lineup");
    if (preLineupHold) out.push("ПРЕВЬЮ ДО СОСТАВОВ: lineup_out=false и состояние upcoming/lineup → предложения держатся как превью (это и есть ветка превью)");
    else out.push(`превью-ветка НЕ активна (составы ${m.lineup_out ? "out" : "не out"}, состояние ${m.state}) — невход объясняется НЕ ею`);
    // Gate 2 — was there anything to fill?
    if (!proposed.length && !filled.length) { out.push("НЕТ ПРЕДЛОЖЕНИЙ: стратег не выдал ни одной ставки — заполнять было нечего (гейты входа даже не достигнуты)"); return out; }
    if (!proposed.length) return out;
    // Gate 3 — live coverage vs ft_blind eligibility, per proposal.
    const ftEnabled = /^(1|true|on|yes)$/i.test(String(env.FT_BLIND_MODE ?? env.FOOTBALL_FT_BLIND ?? ""));
    const hasLive = liveDataStatus(db, m.id).ok;
    const hasMatchLive = !!R.getMatchLive(db, m.id);
    for (const b of proposed) {
      const why: string[] = [];
      if (!hasLive) {
        if (!ftEnabled) why.push("ft_blind ВЫКЛЮЧЕН (env)");
        else if (b.origin !== "prematch") why.push(`origin=${b.origin ?? "?"} — ft_blind берёт только prematch`);
        else if (!FT_SETTLED_RE.test(b.market_label)) why.push("рынок не FT-сеттлится — ft_blind держит только финальные тоталы/исходы");
        else if (hasMatchLive) why.push("есть match_live-строка → фикстура покрыта, ft_blind неприменим");
        else why.push("ft_blind ПРИМЕНИМ — если входа нет, блокер ниже по цепочке (карантин книги / дубль-позиция / нулевая котировка)");
      }
      const mk = markets.find((x) => x.label === b.market_label);
      if (!mk) why.push("рынка нет в последнем снапшоте — котировка не найдена");
      else if ((mk.price ?? 0) <= 0) why.push("котировка ≤0 — вход пропущен");
      else if (Math.abs(mk.price - 50) <= 0.6) why.push("котировка ~50¢ — плейсхолдер, zombie-карантин режет филл");
      out.push(`«${b.market_label}» [${b.strategy_id}/${b.risk_profile_id ?? "medium"}]: ${why.length ? why.join(" · ") : "гейты пройдены — вход ожидался"}`);
    }
  } catch (e) {
    out.push(`диагностика не собралась: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

export function buildMatchLog(db: Database, matchId: string): string {
  const m = R.getMatch(db, matchId);
  if (!m) return `# Матч ${matchId} не найден`;
  const comp = R.listCompetitions(db).find((c) => c.id === m.competition_id);
  const L: string[] = [];
  const h = (s: string) => L.push("\n## " + s);

  L.push(`# Лог матча: ${m.home} — ${m.away}`);
  L.push(`- Матч ID: \`${m.id}\``);
  // P2.3: tennis comps are budget-0 in the table (funded by the tennis loop, not the comp budget) — show
  // the real paper engine, not a dead «бюджет $0».
  const tennisComp = comp?.sport_id === "tennis";
  const budgetNote = tennisComp ? `движок: теннис-петля (paper $${Number(process.env.TENNIS_PAPER_BUDGET_USD) || 1000})` : `бюджет $${comp?.budget ?? 0}`;
  L.push(`- Категория: ${comp?.name ?? "?"} (\`${comp?.id}\`, external_league=\`${comp?.external_league ?? "null"}\`, ${budgetNote})`);
  // P2.4: tennis score lives in the scout snapshots (sets), not m.score_home/away — resolve it from the
  // terminal snapshot so a finished tennis match reads «сеты 2-1», not «?:?».
  let scoreStr = `${m.score_home ?? "?"}:${m.score_away ?? "?"}`;
  if (tennisComp) {
    const s = db.prepare(`SELECT sets_p1, sets_p2, set_num, games_p1, games_p2 FROM tennis_snapshots WHERE pm_match_id=? AND sets_p1 IS NOT NULL ORDER BY batch_at DESC LIMIT 1`).get(matchId) as { sets_p1: number | null; sets_p2: number | null; set_num: number | null; games_p1: number | null; games_p2: number | null } | undefined;
    if (s && s.sets_p1 != null) scoreStr = `сеты ${s.sets_p1}-${s.sets_p2}${m.state !== "finished" && s.set_num ? ` · сет ${s.set_num} геймы ${s.games_p1 ?? "?"}-${s.games_p2 ?? "?"}` : ""}`;
  }
  L.push(`- Состояние: **${m.state}**${m.lineup_out ? " · составы: out" : ""} · счёт ${scoreStr}${m.final_score ? ` (итог ${m.final_score})` : ""}${m.minute != null ? ` · ${m.minute}'` : ""}${m.clock ? ` (${m.clock})` : ""}`);
  L.push(`- Kickoff: ${m.kickoff_at ?? "?"} · external_ref: \`${m.external_ref ?? "null"}\``);

  // ── The entry-gate diagnosis (why bets did / didn't enter) ──
  h("Провайдер и live-данные (диагноз входа)");
  const lds = liveDataStatus(db, m.id);
  // T6: hasLiveData is evaluated NOW, at report generation — for a finished match its snapshots may already
  // be pruned, so «НЕТ» here does not mean the entry lacked live data at decision time (see per-bet dataProvenance).
  L.push(`- **hasLiveData: ${lds.ok ? "ДА" : "НЕТ"}** (на момент генерации отчёта) — ${lds.via}`);
  const isTennis = comp?.sport_id === "tennis";
  const live = R.getMatchLive(db, m.id);
  L.push(`- match_live: ${live ? `есть (espn_event_id=\`${live.espn_event_id ?? "null"}\`, league=\`${live.league ?? "null"}\`, обновлён ${live.updated_at})` : isTennis ? "**н/д для тенниса** — теннис не использует match_live (ESPN/StatPal); live идёт из скаута (tennis_snapshots), см. hasLiveData выше" : "**НЕТ** — ни ESPN, ни StatPal не привязали эту фикстуру (проверь совпадение имён команд и покрытие StatPal)"}`);
  const xg = R.latestLiveXg(db, m.id);
  L.push(`- live xG: ${xg ? `дом ${xg.home} – ${xg.away} гости (${xg.provider}${xg.minute != null ? `, ${xg.minute}'` : ""})` : "нет"}`);
  L.push(`- provider-refs: ${["sportmonks", "thestatsapi", "statpal"].map((p) => { const r = R.getProviderRef(db, m.id, p); return `${p}=${r?.provider_ref ?? "—"}`; }).join(" · ")}`);
  // [V0.1 / batch-9] The REAL entry blocker, walked in autoEnter's own gate order — replaces the blanket
  // «держит превью» claim that misdirected the ft_blind=0 root-cause hunt on blind FUNDED fixtures.
  const blockers = entryBlockerDiag(db, m.id, process.env);
  if (blockers.length) { L.push("- **Почему не было входа (по порядку гейтов autoEnter):**"); for (const b of blockers) L.push(`  - ${b}`); }

  // ── Current markets ──
  h("Рынки (текущие котировки + ai_prob)");
  const markets = R.latestMarkets(db, m.id);
  if (!markets.length) L.push("(нет рынков)");
  for (const mk of markets) L.push(`- ${mk.label}: ${mk.price}¢${mk.ai_prob != null ? ` · ai_prob ${(mk.ai_prob * 100).toFixed(0)}%` : ""}${mk.liquidity ? ` · ликв. ${mk.liquidity}` : ""}`);
  // Z1 (batch-5): zombie-quarantine COVERAGE counter — one header line replaces the (now episode-throttled)
  // per-tick skip flood and answers "is quarantine choking the entry universe?" for this match at a glance.
  // Derived from the throttled episode lines in the trade log: distinct markets that hit quarantine, by cause.
  {
    const byCode = new Map<string, Set<string>>();
    for (const e of R.tradeLogForMatch(db, m.id)) {
      const mtch = /zombie_quarantine:(\w+)\s+«([^»]+)»/.exec(e.text ?? "");
      if (!mtch) continue;
      (byCode.get(mtch[1]) ?? byCode.set(mtch[1], new Set()).get(mtch[1])!).add(mtch[2]);
    }
    if (byCode.size) {
      const distinct = new Set<string>(); for (const s of byCode.values()) for (const l of s) distinct.add(l);
      const causes = [...byCode.entries()].map(([code, s]) => `${code} ${s.size}`).join(", ");
      L.push(`- Карантин рынков: ${distinct.size} из ${markets.length} попадали в карантин (по причинам: ${causes})`);
    }
  }

  // ── Analysis artifacts (base / category / distribution) ──
  const arts = R.artifactsForMatch(db, m.id);
  const byKind = (k: string) => arts.filter((a) => a.kind === k);
  h("Анализ (Слой 1 base / Слой 2 category / assembled distribution)");
  // A/B duel: state up front which model analysed this match, so head-to-head accuracy
  // is readable from the log without digging into each artifact's JSON.
  {
    const okA = R.assessmentsForMatch(db, m.id).filter((a) => a.status === "ok").sort((a, b) => (a.created_at >= b.created_at ? -1 : 1))[0];
    const dm = loadAnalysisDuel().models;
    if (loadAnalysisDuel().enabled) L.push(`- Дуэль анализа: **${okA?.model ?? "?"}** (арм этого матча; сравнение ${dm[0]} ↔ ${dm[1]})`);
    else if (okA?.model) L.push(`- Модель анализа: **${okA.model}**`);
  }
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
      const settled = bet && R.isSettled(bet.status);
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
  // Tennis app matches capture into tennis_snapshots (the scout), NOT provider_snapshots — show
  // the scout's raw so a tennis match doesn't read "0 снапшотов" while the scout drove the trades.
  if (isTennis) {
    const tCount = (db.prepare(`SELECT COUNT(*) n FROM tennis_snapshots WHERE pm_match_id=?`).get(m.id) as { n?: number } | undefined)?.n ?? 0;
    h(`Снимки скаута тенниса (${tCount} шт — tennis_snapshots · api-tennis + Polymarket)`);
    const tSnaps = db.prepare(`SELECT batch_at, live, status, set_num, games_p1, games_p2, sets_p1, sets_p2, pm_p1_cents, pm_p2_cents FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 24`).all(m.id) as Array<{ batch_at: string; live?: number; status?: string; set_num?: number; games_p1?: number; games_p2?: number; sets_p1?: number; sets_p2?: number; pm_p1_cents?: number; pm_p2_cents?: number }>;
    if (!tSnaps.length) L.push("- нет снапшотов скаута (матч не привязан / скаут не видит live)");
    for (const s of tSnaps) L.push(`- ${s.batch_at} · live=${s.live ?? "?"}${s.status ? ` ${s.status}` : ""} · сеты ${s.sets_p1 ?? "?"}-${s.sets_p2 ?? "?"} · сет ${s.set_num ?? "?"} геймы ${s.games_p1 ?? "?"}-${s.games_p2 ?? "?"} · PM ${s.pm_p1_cents ?? "—"}¢/${s.pm_p2_cents ?? "—"}¢`);
  } else {
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
