"use client";
// ============================================================
// EDGE LAB — UI (ported from edge-lab-v18.jsx, driven by real data)
// Receives the server-built AppData payload, keeps editable slices in state,
// persists money/strategy/analytics edits via /api/mutations, and refreshes
// the odds column live via /api/quotes (Polymarket).
// ============================================================
import React, { useState, useRef, useEffect } from "react";
import type { AppData } from "@/lib/view";

const INK = "#12161d", PANEL = "#1a2029", PANEL2 = "#212936", LINE = "#2c3543", TEXT = "#e6e9ef", MUTE = "#8b95a5";
const PALETTE = ["#e8a838", "#5b9bd5", "#70b56a", "#c98bdb", "#e07a5f", "#4fc3c7"];
// Sports that have team sheets — analysis is staged as до/после состава for these;
// others (tennis) get a single "Анализ" with no lineup framing.
const LINEUP_SPORTS = new Set(["football"]);
const STATE_META: Record<string, { label: string; color: string; bg: string }> = {
  upcoming: { label: "СКОРО", color: "#8b95a5", bg: "#232a35" },
  lineup: { label: "СОСТАВ", color: "#e8a838", bg: "#2e2a1a" },
  live: { label: "LIVE", color: "#ff6b6b", bg: "#2e1f22" },
  finished: { label: "ЗАВЕРШЁН", color: "#70b56a", bg: "#1f2a22" },
};

const impliedProb = (o: number) => (o > 1 ? 1 / o : 0);
const fmtMoney = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
const fmtMoney0 = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(0);
// Compact liquidity: 10093.73 → "$10K", 1300 → "$1.3K", 300 → "$0.3K", 2.5e6 → "$2.5M".
// Pre-formatted values (seed "$1.1M") pass through unchanged.
const fmtLiq = (raw: string | null): string => {
  if (!raw) return "";
  const s = String(raw).trim();
  if (/[a-zа-я]/i.test(s)) return s.startsWith("$") ? s : `$${s}`; // already has a K/M suffix
  const n = Number(s.replace(/[$,\s]/g, ""));
  if (!isFinite(n) || n <= 0) return "";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `$${Math.round(n / 1e3)}K`;   // 10K, 45K
  if (n >= 100) return `$${(n / 1e3).toFixed(1)}K`;  // 1.3K, 0.3K, 0.1K
  return `$${Math.round(n)}`;                         // <100 → $61 (no "$0.0K")
};
// Warsaw-time label for cron timestamps, e.g. "сб 04.07, 20:45".
const fmtWarsaw = (iso: string) => {
  try {
    const p = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Warsaw", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso));
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return `${g("weekday")} ${g("day")}.${g("month")}, ${g("hour")}:${g("minute")}`;
  } catch { return iso; }
};

// Persist a UI action, surviving a brief gateway blip. On a single-instance
// deploy (Render disk) a redeploy makes the app return 502/503 for a few
// seconds; a plain fetch would fail the user's save with no retry. setBudget/
// setShares are idempotent (absolute writes), so retrying a gateway error is
// safe. A real 4xx/JSON error is returned as-is (no retry).
const RETRIABLE_STATUS = new Set([502, 503, 504]);
async function mutate(action: any): Promise<any> {
  let lastErr = "сервер не ответил";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("/api/mutations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
      if (r.ok) return await r.json();
      if (!RETRIABLE_STATUS.has(r.status)) {
        try { return await r.json(); } catch { return { ok: false, error: `ошибка сервера (${r.status})` }; }
      }
      lastErr = "сервер недоступен (возможно идёт передеплой)";
    } catch { lastErr = "сеть недоступна"; }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return { ok: false, error: `${lastErr} — повтори через минуту` };
}

function stratBudget(compBudget: Record<string, number>, compId: string, shares: any, stratId: string) {
  const pct = shares[compId]?.[stratId] || 0;
  return Math.floor((compBudget[compId] || 0) * pct / 100); // floor: summed strat budgets never exceed the comp budget
}
function betItems(raw: any) {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : (raw.items || []);
}
function describeParam(k: string, v: any): { label: string; value: string } {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  switch (k) {
    case "maxPerBet": return { label: "макс. на одну ставку", value: pct(v) };
    case "stop": return { label: "стоп-лосс портфеля", value: `${Math.round(v * 100)}%` };
    case "minEdge": return { label: "мин. край для входа", value: `${v}%` };
    case "flatSize": return { label: "фикс. размер ставки", value: pct(v) };
    case "kellyFraction": return { label: "доля Келли", value: `${v}×` };
    case "cap": return { label: "потолок размера", value: pct(v) };
    case "minConfidence": return { label: "мин. уверенность", value: v === "high" ? "высокая" : String(v) };
    case "tiers": return { label: "лесенка размеров (край → доля)", value: (Array.isArray(v) ? v.map(([e, s]: any) => `≥${e}% → ${Math.round(s * 100)}%`).join(",  ") : String(v)) };
    case "note": return { label: "примечание", value: String(v) };
    default: return { label: k, value: Array.isArray(v) ? JSON.stringify(v) : String(v) };
  }
}
function stratEquityOnComp(matchDb: any, comp: any, stratId: string, budget: number) {
  let realized = 0, unreal = 0, staked = 0;
  for (const mid of comp.matches) {
    const m = matchDb[mid];
    if (!m) continue;
    // Realized P&L from every CLOSED position — including cash-outs / partial
    // fixations taken while the match is still live. Was gated on
    // state==="finished", so money booked mid-match never showed up in the
    // tournament budget/equity until the match ended.
    if (m.result?.[stratId] != null) realized += m.result[stratId];
    // Mark opens to the FRESHEST quote (same source the Metrics screen uses), so
    // the budget/portfolio and stats views agree between odds refreshes.
    const cur: Record<string, number> = {};
    for (const mk of (m.markets || [])) if (!(mk.label in cur)) cur[mk.label] = mk.price;
    for (const b of betItems(m.bets?.[stratId])) {
      if (b.status === "open" && b.entryPrice != null && b.entryPrice > 0) {
        const stake = b.stake ?? 0; // null-stake open row must not poison equity with NaN
        staked += stake;
        const price = cur[b.market] ?? b.currentPrice ?? b.entryPrice;
        unreal += stake * (price / b.entryPrice) - stake;
      }
    }
  }
  return { equity: budget + realized + unreal, realized, unreal, staked };
}
function stratOverall(competitions: any[], matchDb: any, stratId: string, sportId: string, compBudget: any, shares: any) {
  const comps = competitions.filter((c) => c.sport === sportId);
  let sumPnl = 0, sumBudget = 0; const roiList: number[] = [];
  for (const c of comps) {
    const pct = shares[c.id]?.[stratId] || 0;
    if (pct <= 0 || (compBudget[c.id] || 0) <= 0) continue;
    const budget = Math.floor((compBudget[c.id]) * pct / 100);
    const e = stratEquityOnComp(matchDb, c, stratId, budget);
    const pnl = e.equity - budget;
    sumPnl += pnl; sumBudget += budget;
    if (budget > 0) roiList.push((pnl / budget) * 100);
  }
  const avgRoi = roiList.length ? roiList.reduce((a, b) => a + b, 0) / roiList.length : 0;
  return { avgRoi, pnl: sumPnl, budget: sumBudget, active: roiList.length };
}
function collectPortfolio(competitions: any[], matchDb: any, catalog: any[], compBudget: any, shares: any) {
  const positions: any[] = [];
  for (const comp of competitions) {
    for (const mid of comp.matches) {
      const m = matchDb[mid];
      // Any NON-finished match with open positions — not just live: a bet placed
      // on lineup (pre-match entry) is real exposure and must show in «Актуальные»
      // (was live-only, so pre-match opens counted in the comp card but not here).
      if (!m || m.state === "finished") continue;
      const cur: Record<string, number> = {};
      for (const mk of (m.markets || [])) if (!(mk.label in cur)) cur[mk.label] = mk.price;
      const when = m.state === "live" ? (m.minute != null ? `${m.minute}'` : "LIVE") : "предматч";
      for (const st of catalog) {
        if (st.sport !== comp.sport) continue;
        if ((shares[comp.id]?.[st.id] || 0) <= 0 || (compBudget[comp.id] || 0) <= 0) continue;
        for (const b of betItems(m.bets?.[st.id])) {
          if (b.status !== "open") continue;
          const stake = b.stake ?? 0;
          const price = b.entryPrice != null ? (cur[b.market] ?? b.currentPrice ?? b.entryPrice) : null; // freshest quote
          const live = price != null && b.entryPrice != null && b.entryPrice > 0 ? stake * (price / b.entryPrice) - stake : 0;
          positions.push({
            sport: comp.sport, compName: comp.name, compId: comp.id,
            match: `${m.home}–${m.away}`, minute: when,
            strat: st.name, stratColor: st.color, stratId: st.id,
            market: b.market, stake, entryPrice: b.entryPrice, currentPrice: price ?? b.currentPrice,
            live, entered: b.entered,
          });
        }
      }
    }
  }
  return positions;
}
// Closed positions (settled bets) across ALL matches — the «Завершённые» tab of
// the portfolio. Includes real-outcome settlements and early/partial cash-outs
// (settledBy). Not gated on the strategy's CURRENT share/budget so history stays
// visible even after a strategy is de-funded. Realized P&L = payout − stake.
function collectClosed(competitions: any[], matchDb: any, catalog: any[]) {
  const positions: any[] = [];
  for (const comp of competitions) {
    for (const mid of comp.matches) {
      const m = matchDb[mid];
      if (!m) continue;
      for (const st of catalog) {
        if (st.sport !== comp.sport) continue;
        for (const b of (m.settledBets?.[st.id] || [])) {
          const pnl = (b.payout ?? 0) - (b.stake ?? 0);
          positions.push({
            sport: comp.sport, compName: comp.name, compId: comp.id,
            match: `${m.home}–${m.away}`, finalScore: m.finalScore, state: m.state,
            strat: st.name, stratColor: st.color, stratId: st.id,
            market: b.market, stake: b.stake, payout: b.payout, pnl,
            result: b.result, settledBy: b.settledBy, closedPct: b.closedPct ?? 100,
          });
        }
      }
    }
  }
  return positions;
}

// Contain render crashes so one bad screen / match card can't blank the whole
// app with Next's generic "Application error: a client-side exception has
// occurred". The real error + component stack are logged to the console (tagged
// [EDGE LAB]) so a production crash is actually debuggable, and the user gets a
// retry / reload instead of a dead page.
class ErrorBoundary extends React.Component<{ label?: string; children: React.ReactNode }, { error: Error | null }> {
  constructor(props: any) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: any) {
    // eslint-disable-next-line no-console
    console.error(`[EDGE LAB] UI error${this.props.label ? ` · ${this.props.label}` : ""}:`, error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={S.errBox}>
          <div style={S.errTitle}>⚠ Не удалось отобразить{this.props.label ? ` «${this.props.label}»` : " этот блок"}</div>
          <div style={S.errMsg}>{String(this.state.error?.message || this.state.error)}</div>
          <div style={S.errActions}>
            <button style={S.errBtn} onClick={() => this.setState({ error: null })}>↻ Повторить</button>
            <button style={S.errBtn} onClick={() => { if (typeof window !== "undefined") window.location.reload(); }}>Перезагрузить</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function EdgeLab({ initial }: { initial: AppData }) {
  // State (not const) so a background discover/sync — new matches, new
  // tournaments — surfaces on the next 3s reload instead of only after a full
  // page reload (the live-dot + comp chips read these).
  const [SPORTS, setSports] = useState(initial.sports);
  const [COMPETITIONS, setCompetitions] = useState(initial.competitions);
  const [TOTAL_BALANCE, setTotalBalance] = useState(initial.treasuryTotal);
  // These update on reloadApp too (not just at first load) so the Metrics/Feed
  // screens reflect live settlement/stats instead of the initial snapshot.
  const [QUALITY, setQuality] = useState(initial.quality);
  const [EVENT_FEED, setEventFeed] = useState(initial.eventFeed);
  const [strategyStats, setStrategyStats] = useState(initial.strategyStats);

  const [screen, setScreen] = useState("matches");
  const toastId = useRef(0);
  const [catalog, setCatalog] = useState(initial.catalog);
  const [compBudget, setCompBudget] = useState(initial.compBudget);
  const [shares, setShares] = useState(initial.shares);
  const [analysis, setAnalysis] = useState(initial.analysis);
  const [matchDb, setMatchDb] = useState(initial.matchDb);
  const [providers, setProviders] = useState(initial.providers);
  const PROVIDERS = providers;
  // Per-match odds-refresh failure signal: a monotonically-bumped counter the
  // MatchCard watches to flash a RED dot (vs the green "prices changed" flash)
  // when a refresh didn't go through (network / server error).
  const [oddsErr, setOddsErr] = useState<Record<string, number>>({});

  const [sportId, setSportId] = useState("football");
  const sportComps = COMPETITIONS.filter((c) => c.sport === sportId);
  const [compId, setCompId] = useState(sportComps[0]?.id);
  // Resolve within the CURRENT sport only — otherwise switching to a sport with
  // no comps would keep the old sport's compId and render a foreign comp's data.
  const comp = sportComps.find((c) => c.id === compId) || sportComps[0];
  const [matchTab, setMatchTab] = useState("active"); // «Актуальные» (идут + будущие) по умолчанию; «Завершённые» отдельно
  const [compModal, setCompModal] = useState<string | null>(null);
  const [shareModal, setShareModal] = useState<string | null>(null);

  const onSport = (id: string) => { setSportId(id); const c = COMPETITIONS.find((c) => c.sport === id); if (c) setCompId(c.id); }; // sport may have no comps yet — don't crash

  const allocatedSum = Object.values(compBudget).reduce((a, b) => a + b, 0);
  const freeBalance = TOTAL_BALANCE - allocatedSum;
  // Total realized P&L booked across ALL tournaments (settled bets). Surfaced in
  // the treasury bar so winnings/losses are visible there too — previously only
  // the per-tournament equity reflected them, so the treasury looked frozen
  // after a win/loss. (Allocation still validates against the base balance.)
  const totalRealized = Object.values(matchDb).reduce((a: number, m: any) =>
    a + Object.values(m?.result || {}).reduce((x: number, v: any) => x + (v as number), 0), 0);
  // Effective bank = base balance + realized P&L. Realized winnings/losses stay
  // in the tournament that earned them (auto-reinvested by the sizing), so the
  // FREE pool stays base−allocated (no double-count); but the top-line balance
  // grows/shrinks so funds visibly "go somewhere" after a position resolves.
  const effectiveBalance = TOTAL_BALANCE + totalRealized;

  // Live-now indicators: derive from matchDb (the live-updated source), not the
  // static COMPETITIONS snapshot, so a match kicking off mid-session lights up
  // its tournament chip and sport tab. compId→sport via the catalog of comps.
  const compSport: Record<string, string> = Object.fromEntries(COMPETITIONS.map((c) => [c.id, c.sport]));
  const liveCompIds = new Set(Object.values(matchDb).filter((m: any) => m.state === "live").map((m: any) => m.competitionId));
  const liveSports = new Set([...liveCompIds].map((cid) => compSport[cid as string]).filter(Boolean));

  // Optimistic + confirmed: apply locally, persist, and if the POST fails (cold
  // start / rejected) toast so a silent revert on the next live reload isn't a
  // mystery. reloadApp reads server state, so a failed save visibly reverts —
  // the toast tells the user why.
  const setBudget = async (cid: string, amt: number) => {
    setCompBudget((p) => ({ ...p, [cid]: amt })); setCompModal(null);
    const r = await mutate({ type: "setBudget", compId: cid, amount: amt }).catch(() => ({ ok: false }));
    if (r && r.ok === false) toast("err", r.error || "Не удалось сохранить бюджет — изменение откатится");
  };
  const saveShares = async (cid: string, newShares: any) => {
    setShares((p) => ({ ...p, [cid]: newShares })); setShareModal(null);
    const r = await mutate({ type: "setShares", compId: cid, shares: newShares }).catch(() => ({ ok: false }));
    if (r && r.ok === false) toast("err", r.error || "Не удалось сохранить доли — изменение откатится");
  };

  // Refresh a match's odds via the SERVER action (engine.refreshMatchOdds): the
  // same reliable CLOB path the cron uses, keyed off the market's stored token —
  // so it works even when the client copy of a market lacks a tokenId (which was
  // why the manual ↻ silently returned "нет котировок"). `silent` skips toasts
  // for the background auto-refresh loop.
  const bumpOddsErr = (matchId: string) => setOddsErr((p) => ({ ...p, [matchId]: (p[matchId] ?? 0) + 1 }));
  const refreshOddsCore = async (matchId: string, silent = false): Promise<void> => {
    let res: any;
    try {
      res = await engine("refreshOdds", matchId);
    } catch { bumpOddsErr(matchId); if (!silent) toast("err", "Котировки не обновились — сеть недоступна"); return; }
    // engine() returns {ok:false} on a network/cold-start failure instead of
    // throwing — treat that as a failed refresh too (red dot in the card).
    if (!res || res.ok === false) { bumpOddsErr(matchId); if (!silent) toast("err", res?.error || "Котировки не обновились — сервер не ответил"); return; }
    const byId: Record<string, any> = {};
    for (const mk of res?.markets || []) byId[mk.id] = mk;
    setMatchDb((prev) => {
      const cur = prev[matchId];
      if (!cur) return prev;
      const nm = { ...cur };
      nm.markets = nm.markets.map((mk) => { const q = byId[mk.id]; return q && q.price != null ? { ...mk, price: q.price } : mk; });
      // The "updated" cue is now a fading green dot in MatchCard (driven by an
      // actual price change), not a text line that reflowed the odds list.
      return { ...prev, [matchId]: nm };
    });
    if (!silent) toast(res?.updated ? "ok" : "info", res?.updated ? `Котировки обновлены (${res.updated})` : "Свежих котировок нет — рынок закрыт или неликвиден");
  };
  const refreshOdds = (matchId: string) => refreshOddsCore(matchId, false);

  const doReassess = async (matchId: string, strategyId: string) => {
    let j: any;
    try {
      const r = await fetch("/api/engine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reassess", matchId, strategyId }) });
      j = await r.json();
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `ошибка ${r.status}`);
    } catch (e: any) {
      toast("err", e?.message || "переоценка не удалась");
      return;
    }
    // Pull fresh state so any exits/entries the reassessment made show at once
    // (the note, positions, log and P&L all change together).
    await reloadApp().catch(() => {});
    const acted = (j.exits || 0) + (j.entries || 0);
    toast("ok", acted ? `Переоценка: выходов ${j.exits}, входов ${j.entries}` : "Переоценка готова — изменений по позициям нет");
  };

  // Never let a failed request reject: a network error (server mid-redeploy, or
  // the free instance cold-starting/asleep) would otherwise throw out of the
  // caller before it can reset its "работает…" state, leaving the button stuck
  // with a raw "fetch failed". Return a structured error instead.
  const engine = async (action: string, matchId: string): Promise<any> => {
    try {
      const r = await fetch("/api/engine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, matchId }) });
      return await r.json();
    } catch {
      return { ok: false, status: "error", error: "сервер не ответил — возможно идёт передеплой или холодный старт (free-план засыпает после простоя). Повтори через минуту." };
    }
  };
  const reloadApp = async () => {
    let app: any;
    try { app = await (await fetch("/api/app")).json(); } catch { return; } // cold start / redeploy — keep current state
    if (!app || app.error) return;
    if (app.matchDb) setMatchDb(app.matchDb);
    if (app.catalog) setCatalog(app.catalog);
    // Sync the catalog of sports/competitions too, so newly discovered matches
    // and tournaments appear (and their live-dot lights) without a page reload.
    if (app.competitions) setCompetitions(app.competitions);
    if (app.sports) setSports(app.sports);
    if (app.analysis) setAnalysis(app.analysis);
    if (app.providers) setProviders(app.providers);
    // Keep the allocation maps in sync with the server too — otherwise a
    // strategy the cron funded/activated stays excluded from `compStrats`, and
    // all its per-strategy tab content (log / reassess / settle) renders empty.
    if (app.compBudget) setCompBudget(app.compBudget);
    if (app.shares) setShares(app.shares);
    if (typeof app.treasuryTotal === "number") setTotalBalance(app.treasuryTotal);
    if (app.strategyStats) setStrategyStats(app.strategyStats);
    if (app.eventFeed) setEventFeed(app.eventFeed);
    if (app.quality) setQuality(app.quality);
  };

  // Live auto-refresh: while ANY match is in play, every 3s (a) pull fresh CLOB
  // prices for each live match server-side, then (b) re-pull the full app state
  // so money, quotes, trade log, reassessments and settlement all stay live with
  // no manual reload. Idle (no live match) → no polling. 3s is comfortably inside
  // Polymarket's rate limits; drop it if you want a faster tick.
  const liveMatchIds = Object.values(matchDb)
    .filter((m: any) => m.state === "live" || m.state === "lineup" || m.lineupOut)
    .map((m: any) => m.id);
  const liveKey = liveMatchIds.join(",");
  useEffect(() => {
    if (!liveMatchIds.length) return;
    let stop = false;
    let timer: any;
    // Recursive setTimeout, NOT setInterval: schedule the next tick only AFTER the
    // current one fully resolves. On a slow network (or a cold-starting free
    // instance) a fixed 3s interval would pile up overlapping refresh+reload
    // calls, and an older/slower reloadApp could land last and overwrite fresh
    // state with stale data. This keeps at most one tick in flight.
    const tick = async () => {
      try {
        // Ping Polymarket for live prices ONLY on the Matches screen (where odds
        // are shown), capped to avoid a 30+ concurrent-call storm every tick. On
        // other screens (Лента / Портфель / Метрики) just re-pull server state so
        // they stay live in real time without the heavy per-match refresh — the
        // cron already keeps odds fresh server-side.
        if (screen === "matches") {
          await Promise.all(liveMatchIds.slice(0, 12).map((id) => refreshOddsCore(id, true).catch(() => {})));
        }
        if (!stop) await reloadApp().catch(() => {});
      } finally {
        if (!stop) timer = setTimeout(tick, 3000);
      }
    };
    timer = setTimeout(tick, 3000);
    return () => { stop = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, screen]);

  // Toasts — side notifications for actions, so the user sees what worked/failed.
  const [toasts, setToasts] = useState<{ id: number; kind: "ok" | "err" | "info"; text: string }[]>([]);
  const toast = (kind: "ok" | "err" | "info", text: string) => {
    const id = toastId.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 8000 : 5000);
  };

  // "Pull matches" — parse Polymarket + ESPN lineups + odds (no LLM). Fast.
  const [discovering, setDiscovering] = useState(false);
  const doDiscover = async () => {
    setDiscovering(true);
    // The server runs discovery in the BACKGROUND (202) so the request can't time
    // out (→ 502). Kick it, then surface the new matches on a few delayed reloads
    // as they land — competitions/matches now sync in reloadApp.
    try {
      const r = await fetch("/api/engine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "discover" }) }).then((x) => x.json());
      if (!r.ok) { toast("err", r.error || "Не удалось запустить подтягивание"); setDiscovering(false); return; }
      toast("info", r.running ? "Подтягивание уже идёт — матчи скоро появятся" : "Подтягиваю матчи в фоне — появятся через несколько секунд…");
    } catch { toast("err", "Сеть недоступна — Polymarket/ESPN не ответили"); setDiscovering(false); return; }
    for (const d of [4000, 10000, 20000]) setTimeout(() => reloadApp().catch(() => {}), d);
    setTimeout(() => { setDiscovering(false); toast("ok", "Готово — новые матчи подтянуты"); }, 22000);
  };
  // Poll the durable job until it settles, then reload. Used both after a fresh
  // kick and to RESUME a run already in flight (e.g. after navigating back — the
  // server tracks the job, so the card picks the analysis back up on its own).
  // Returns "done" | "failed" | "timeout". "timeout" ≠ success: the run may
  // still be going server-side (the job persists and the card re-derives
  // `analyzing` on the next reload and resumes), so we must not report ok.
  const pollAnalyze = async (matchId: string): Promise<{ outcome: "done" | "failed" | "timeout"; error?: string }> => {
    for (let i = 0; i < 100; i++) { // ~150s ceiling (LLM timeout is 120s)
      const s = await engine("analyzeStatus", matchId);
      // A transient status-call failure (cold start / redeploy) must not be read
      // as "done" — keep polling; the durable job on the server is unaffected.
      if (s.status === "error") { await new Promise((res) => setTimeout(res, 1500)); continue; }
      if (s.status !== "analyzing") { await reloadApp(); return { outcome: s.failed ? "failed" : "done", error: s.error }; }
      await new Promise((res) => setTimeout(res, 1500));
    }
    await reloadApp();
    return { outcome: "timeout" };
  };
  const doAnalyze = async (matchId: string) => {
    // Kick off (returns immediately with 202 / "analyzing"), then poll until the
    // background LLM run settles. The request is never held open for the whole
    // model round-trip, so nothing "hangs" on slow/timeout-y analyses.
    const kick = await engine("analyze", matchId);
    if (kick.ok === false) return kick; // validation error (no markets / not found) — show at once
    const { outcome, error } = await pollAnalyze(matchId);
    if (outcome === "failed") return { ok: false, error: error || "оценка не удалась" }; // surface the real reason
    if (outcome === "timeout") return { ok: false, error: "анализ идёт дольше обычного — результат появится сам" };
    return { ok: true };
  };

  const sportStrats = catalog.filter((s) => s.sport === sportId);
  const compStrats = sportStrats.filter((s) => (shares[comp?.id]?.[s.id] || 0) > 0 && compBudget[comp?.id] > 0);

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      <div style={S.toastWrap}>
        {toasts.map((t) => (
          <div key={t.id} style={{ ...S.toast, ...(t.kind === "ok" ? S.toastOk : t.kind === "err" ? S.toastErr : S.toastInfo) }}>
            <span style={S.toastIcon}>{t.kind === "ok" ? "✓" : t.kind === "err" ? "✕" : "…"}</span>
            <span style={S.toastText}>{t.text}</span>
          </div>
        ))}
      </div>

      <div style={S.treasury}>
        <div style={S.trBrand}><span style={S.mark}>&#9670;</span><span style={S.trBrandTxt}>EDGE LAB</span></div>
        <div style={S.trCell} title={`База ${fmtMoney0(TOTAL_BALANCE)} + реализованный P&L ${totalRealized >= 0 ? "+" : ""}${fmtMoney0(totalRealized)}. Реализованный остаётся в своём турнире (реинвест); свободный остаток — от базы.`}><div style={S.trLbl}>Общий баланс</div><div style={{ ...S.trVal, color: totalRealized > 0 ? "#5fd08a" : totalRealized < 0 ? "#ff6b6b" : undefined }}>{fmtMoney0(effectiveBalance)}</div></div>
        <div style={S.trDiv} />
        <div style={S.trCell}><div style={S.trLbl}>Распределено</div><div style={{ ...S.trVal, color: "#e8a838" }}>{fmtMoney0(allocatedSum)}</div></div>
        <div style={S.trDiv} />
        <div style={S.trCell}><div style={S.trLbl}>Свободно</div><div style={{ ...S.trVal, color: freeBalance >= 0 ? "#5fd08a" : "#ff6b6b" }}>{fmtMoney0(freeBalance)}</div></div>
        <div style={S.trDiv} />
        <div style={S.trCell} title="Суммарный реализованный P&L по всем турнирам (расчёты и закрытия). Распределение бюджета считается от базового баланса.">
          <div style={S.trLbl}>P&amp;L реализ.</div>
          <div style={{ ...S.trVal, color: totalRealized >= 0 ? "#5fd08a" : "#ff6b6b" }}>{totalRealized >= 0 ? "+" : ""}{fmtMoney0(totalRealized)}</div>
        </div>
        <div style={S.trDiv} />
        <div style={S.trCell}>
          <button style={{ ...S.discoverBtn, opacity: discovering ? 0.6 : 1 }} disabled={discovering} onClick={doDiscover} title="Подтянуть матчи с Polymarket + составы ESPN + котировки (без ИИ)">{discovering ? "подтягиваю…" : "↧ Подтянуть матчи"}</button>
        </div>
      </div>

      <div style={S.screenSwitch} className="el-screen-switch">
        {[["matches", "Матчи"], ["feed", "Лента"], ["portfolio", "Портфель"], ["metrics", "Метрики"], ["strategies", "Стратегии"], ["models", "Настройки"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setScreen(k)} style={{ ...S.screenBtn, ...(screen === k ? S.screenOn : {}) }}>{lbl}</button>
        ))}
      </div>

      {(screen === "matches" || screen === "strategies") && (
        <nav style={S.sportTabs}>
          {SPORTS.map((s) => <button key={s.id} onClick={() => onSport(s.id)} style={{ ...S.sportTab, ...(sportId === s.id ? S.sportTabOn : {}) }}>{s.label}{liveSports.has(s.id) && <span style={S.liveDot} title="сейчас идёт матч" />}</button>)}
        </nav>
      )}

      <ErrorBoundary key={screen} label={screen}>
      {screen === "matches" ? (
        <>
          <div style={S.compRow}>
            {sportComps.map((c) => {
              const budget = compBudget[c.id] || 0;
              const cStrats = sportStrats.filter((s) => (shares[c.id]?.[s.id] || 0) > 0);
              // delta is PURE P&L (realized + open mark-to-market) across the comp's
              // strategies — 0 until something is actually bet, so a freshly-funded
              // tournament shows "бюджет свободен", not a phantom -100%.
              const agg = cStrats.reduce((acc, s) => { const e = stratEquityOnComp(matchDb, c, s.id, stratBudget(compBudget, c.id, shares, s.id)); return { delta: acc.delta + e.realized + e.unreal, staked: acc.staked + e.staked }; }, { delta: 0, staked: 0 });
              const delta = agg.delta;
              const eq = budget + delta;
              // "Bets exist" is money IN PLAY or already realized — NOT "delta != 0".
              // A fresh $75 bet whose price hasn't moved has delta 0 but is very
              // much a bet, so it must not read as "ставок нет".
              const hasBets = agg.staked > 0.005 || Math.round(delta * 100) !== 0;
              // ROI denominator = the ACTIVE (allocated) strategy budgets, not the
              // whole comp budget — so the comp-card % reconciles with the sum of
              // the per-strategy rows below instead of being diluted by idle budget.
              const activeBudget = cStrats.reduce((a, s) => a + stratBudget(compBudget, c.id, shares, s.id), 0);
              return (
                <div key={c.id} style={{ ...S.compCard, ...(c.id === comp?.id ? S.compOn : {}) }}>
                  <button style={S.compMain} onClick={() => setCompId(c.id)}>
                    <div style={S.compName}>{c.name}{liveCompIds.has(c.id) && <span style={S.liveDot} title="сейчас идёт матч" />}</div>
                    {budget > 0 ? <>
                      <div style={S.compBudget}>{fmtMoney0(budget)} <span style={S.compBudgetLbl}>бюджет</span></div>
                      {hasBets
                        ? <div style={{ ...S.compDelta, color: delta >= 0 ? "#5fd08a" : "#ff6b6b" }}>{delta >= 0 ? "▲ +" : "▼ "}{fmtMoney(delta)} ({delta >= 0 ? "+" : ""}{(activeBudget > 0 ? (delta / activeBudget) * 100 : 0).toFixed(1)}%) <span style={S.compRoi}>· {agg.staked > 0.005 ? `${fmtMoney0(agg.staked)} в игре` : `сейчас ${fmtMoney0(eq)}`}</span></div>
                        : <div style={S.compFlat}>ставок нет · бюджет свободен</div>}
                    </> : <div style={S.compUnalloc}>{c.matches.length ? "нет бюджета" : "нет матчей"}</div>}
                  </button>
                  <button style={S.allocIcon} title="Бюджет турнира" onClick={() => setCompModal(c.id)}>$</button>
                </div>
              );
            })}
          </div>

          <div style={S.stratStripHead}>
            <span style={S.stratStripTitle}>Стратегии на «{comp?.name}»</span>
            {compBudget[comp?.id] > 0 && <button style={S.shareBtn} onClick={() => setShareModal(comp.id)}>⚙ Распределить доли %</button>}
          </div>
          <div style={S.bankStrip}>
            {(compBudget[comp?.id] || 0) === 0 && <div style={S.noStrat}>У «{comp?.name}» нет бюджета. Нажми $ на плашке турнира.</div>}
            {compBudget[comp?.id] > 0 && compStrats.length === 0 && <div style={S.noStrat}>Бюджет есть, но доли стратегий не заданы. Нажми «Распределить доли %».</div>}
            {compBudget[comp?.id] > 0 && compStrats.map((st) => {
              const pct = shares[comp.id][st.id];
              const budget = stratBudget(compBudget, comp.id, shares, st.id);
              const e = stratEquityOnComp(matchDb, comp, st.id, budget);
              const d = e.equity - budget;
              return (
                <div key={st.id} style={S.bankCell}>
                  <span style={{ ...S.dot, background: st.color }} />
                  <div style={S.bankInfo}><span style={S.bankNm}>{st.name}</span><span style={S.bankBudget}>{pct}% · {fmtMoney0(budget)}</span></div>
                  <div style={S.bankNums}><span style={S.bankEq}>{fmtMoney(e.equity)}</span><span style={{ ...S.bankD, color: d >= 0 ? "#5fd08a" : "#ff6b6b" }}>{d >= 0 ? "▲" : "▼"}{fmtMoney(d)} ({d >= 0 ? "+" : ""}{budget ? ((d / budget) * 100).toFixed(1) : "0.0"}%)</span></div>
                </div>
              );
            })}
          </div>

          <main style={S.main}>
            {(() => {
              const ids = (comp?.matches || []).filter((mid) => matchDb[mid]);
              // «Актуальные» = идут сейчас + будущие (live → lineup → upcoming),
              // live первыми; «Завершённые» = финал, свежие сверху.
              const RANK: any = { live: 0, lineup: 1, upcoming: 2 };
              const active = ids.filter((mid) => matchDb[mid].state !== "finished")
                .sort((a, b) => (RANK[matchDb[a].state] ?? 3) - (RANK[matchDb[b].state] ?? 3));
              const finished = ids.filter((mid) => matchDb[mid].state === "finished").reverse();
              const shown = matchTab === "finished" ? finished : active;
              return (
                <>
                  <div style={S.matchTabs}>
                    <button style={{ ...S.matchTab, ...(matchTab === "active" ? S.matchTabOn : {}) }} onClick={() => setMatchTab("active")}>Актуальные{active.length ? ` · ${active.length}` : ""}</button>
                    <button style={{ ...S.matchTab, ...(matchTab === "finished" ? S.matchTabOn : {}) }} onClick={() => setMatchTab("finished")}>Завершённые{finished.length ? ` · ${finished.length}` : ""}</button>
                  </div>
                  {shown.length === 0 && <div style={S.empty}>{matchTab === "finished" ? "Завершённых матчей пока нет." : "Актуальных матчей нет — появятся, когда подтянутся будущие или начнутся текущие."}</div>}
                  {shown.map((mid) => (
                    <ErrorBoundary key={mid} label={`${matchDb[mid].home}–${matchDb[mid].away}`}>
                      <MatchCard match={matchDb[mid]} catalog={catalog} comp={comp} compBudget={compBudget} shares={shares} onRefreshOdds={refreshOdds} onReassess={doReassess} onAnalyze={doAnalyze} onResumeAnalyze={pollAnalyze} oddsErrKey={oddsErr[mid] || 0} />
                    </ErrorBoundary>
                  ))}
                </>
              );
            })()}
          </main>
        </>
      ) : screen === "strategies" ? (
        <StrategyScreen sportId={sportId} sportLabel={SPORTS.find((s) => s.id === sportId)?.label ?? sportId} catalog={catalog} setCatalog={setCatalog}
          competitions={COMPETITIONS} matchDb={matchDb} compBudget={compBudget} shares={shares} providers={PROVIDERS} quality={QUALITY}
          analysis={analysis} setAnalysis={setAnalysis} onGoModels={() => setScreen("models")} />
      ) : screen === "portfolio" ? (
        <PortfolioScreen open={collectPortfolio(COMPETITIONS, matchDb, catalog, compBudget, shares)} closed={collectClosed(COMPETITIONS, matchDb, catalog)} onGoMatches={() => setScreen("matches")} />
      ) : screen === "feed" ? (
        <FeedScreen feed={EVENT_FEED} />
      ) : screen === "metrics" ? (
        <MetricsScreen catalog={catalog} quality={QUALITY} stats={strategyStats} />
      ) : (
        <ModelsScreen providers={providers} setProviders={setProviders} total={TOTAL_BALANCE} allocated={allocatedSum} cron={initial.cron}
          onSetTotal={async (amount: number) => {
            const r = await mutate({ type: "setTreasury", amount });
            if (r.ok) { setTotalBalance(amount); toast("ok", `Общий баланс: $${amount}`); }
            else toast("err", r.error || "Не удалось изменить баланс");
            return r;
          }} />
      )}
      </ErrorBoundary>

      {compModal && <BudgetModal comp={COMPETITIONS.find((c) => c.id === compModal)!} current={compBudget[compModal] || 0} free={freeBalance} onClose={() => setCompModal(null)} onSave={(amt: number) => setBudget(compModal, amt)} />}
      {shareModal && <SharesModal comp={COMPETITIONS.find((c) => c.id === shareModal)!} strats={catalog.filter((s) => s.sport === COMPETITIONS.find((c) => c.id === shareModal)!.sport)} budget={compBudget[shareModal]} current={shares[shareModal] || {}} onClose={() => setShareModal(null)} onSave={(sh: any) => saveShares(shareModal, sh)} />}

      <footer style={S.footer}>
        Два уровня денег: казна→турнир ($), турнир→стратегии (%). Данные — из БД; котировки обновляются через сервер (Polymarket). Правки бюджета/долей/стратегий сохраняются.
      </footer>
    </div>
  );
}

function MatchCard({ match, catalog, comp, compBudget, shares, onRefreshOdds, onReassess, onAnalyze, onResumeAnalyze, oddsErrKey }: any) {
  const meta = STATE_META[match.state] ?? { label: String(match.state ?? "—").toUpperCase(), color: "#8b95a5", bg: "#232a35" };
  const hasLineups = LINEUP_SPORTS.has(comp.sport); // does this sport have team sheets?
  const compStrats = catalog.filter((s: any) => s.sport === comp.sport && (shares[comp.id]?.[s.id] || 0) > 0 && compBudget[comp.id] > 0);
  // Strategies to surface in the per-strategy bars (log / reassess / settle): the
  // funded ones PLUS any that actually have data on THIS match. A strategy can
  // place a bet and then have its share zeroed (or the client's share map lag
  // the server), which would drop it from `compStrats` and make its log /
  // reassessments unreachable. Union keeps its history visible.
  const dataStratIds = new Set<string>([
    ...Object.keys(match.logByStrat || {}), ...Object.keys(match.reassessByStrat || {}),
    ...Object.keys(match.settledBets || {}), ...Object.keys(match.bets || {}),
  ]);
  const barStrats = catalog.filter((s: any) => compStrats.some((c: any) => c.id === s.id) || dataStratIds.has(s.id));
  // Show the Лог tab whenever there ARE log rows, not only for live/finished —
  // a pre-match (upcoming/lineup) entry writes a trade-log row too, and gating
  // on state alone hid it entirely ("ставку поставило, но лог не отобразило").
  const hasLog = match.state === "live" || match.state === "finished" || Object.values(match.logByStrat || {}).some((a: any) => a?.length);
  const hasReassess = Object.keys(match.reassessByStrat || {}).length > 0;
  // Split settled bets: resolution = the market actually resolved (settledBy null);
  // cashout = closed early or partially fixed mid-match (settledBy early/partial).
  // Only a real RESOLUTION on a FINISHED match is "Финальный счёт — рассчитано";
  // mid-match cash-outs are just closed trades, never framed as final results.
  const settledEntries: [string, any[]][] = Object.entries(match.settledBets || {});
  const hasResolution = !!match.finalScore && settledEntries.some(([, arr]) => arr.some((b: any) => !b.settledBy));
  const hasCashout = settledEntries.some(([, arr]) => arr.some((b: any) => b.settledBy));
  const hasSettled = hasResolution || hasCashout;
  // Strategies matter more than analysis → their bets tab leads and is default.
  const tabs: any[] = [{ id: "strat", label: "Ставки стратегий" }, { id: "analysis", label: "Анализ" }];
  if (hasReassess) tabs.push({ id: "reassess", label: "Переоценки" });
  if (hasSettled) tabs.push({ id: "settle", label: hasResolution ? "Расчёт" : "Закрытия" });
  const hasLive = !!((match.lineups && (match.lineups.home || match.lineups.away)) || (match.events && match.events.length));
  if (hasLive) tabs.push({ id: "live", label: "События матча" });
  if (hasLog) tabs.push({ id: "log", label: "Лог" });
  // Only jump straight to the settle tab when the match actually resolved — a
  // mid-match partial fixation must not hijack a live card into "рассчитано".
  const defaultTab = hasResolution ? "settle" : "strat";
  const [tab, setTab] = useState(defaultTab);
  const [logStrat, setLogStrat] = useState(barStrats[0]?.id);
  // Re-sync selections after a reload: the card never remounts, so a `logStrat`
  // pinned to a since-removed strategy (or undefined from an empty first mount)
  // would leave the log/reassess panels pointed at nothing. Likewise, keep the
  // active tab valid when the visible tab set changes (e.g. a match resolves).
  const barStratKey = barStrats.map((s: any) => s.id).join(",");
  const tabKey = tabs.map((t) => t.id).join(",");
  useEffect(() => { if (!barStrats.some((s: any) => s.id === logStrat)) setLogStrat(barStrats[0]?.id); }, [barStratKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!tabs.some((t) => t.id === tab)) setTab(defaultTab); }, [tabKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [refreshing, setRefreshing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null);
  const [reassessing, setReassessing] = useState<Record<string, boolean>>({});
  const [showLineups, setShowLineups] = useState(false); // составы скрыты по умолчанию — по кнопке

  // Quote-refresh indicator: instead of an "обновлено только что" line that
  // pushed the odds list down on every tick, flash a small green dot next to ↻
  // ONLY when a price actually changed. The dot slot is always reserved, so the
  // layout never shifts.
  const priceSig = (match.markets || []).map((mk: any) => `${mk.id}:${mk.price}`).join("|");
  // Freshest quote per market label — so a bet row marks to the same price the
  // bank strip / portfolio use (client odds refresh updates markets[].price but
  // not the bet's currentPrice), keeping the views consistent between reloads.
  const curByLabel: Record<string, number> = {};
  for (const mk of (match.markets || [])) if (!(mk.label in curByLabel)) curByLabel[mk.label] = mk.price;
  // One flash slot next to ↻, two meanings: GREEN when a price actually changed,
  // RED when a refresh failed (oddsErrKey bumped by the parent). `n` keys the
  // animation restart; `kind` picks the colour.
  const [flash, setFlash] = useState<{ n: number; kind: "ok" | "err" }>({ n: 0, kind: "ok" });
  const prevSig = useRef(priceSig);
  useEffect(() => {
    if (prevSig.current !== priceSig) { prevSig.current = priceSig; setFlash((f) => ({ n: f.n + 1, kind: "ok" })); }
  }, [priceSig]);
  const prevErr = useRef(oddsErrKey);
  useEffect(() => {
    if (oddsErrKey !== prevErr.current) { prevErr.current = oddsErrKey; setFlash((f) => ({ n: f.n + 1, kind: "err" })); }
  }, [oddsErrKey]);

  const doRefresh = async () => { setRefreshing(true); await onRefreshOdds(match.id); setRefreshing(false); };
  const runAnalyze = async () => {
    setAnalyzing(true); setAnalyzeErr(null);
    try { const r = await onAnalyze(match.id); if (r && r.ok === false) setAnalyzeErr(r.error || "оценка не удалась"); }
    catch (e: any) { setAnalyzeErr(e?.message || "оценка не удалась"); }
    finally { setAnalyzing(false); }
  };

  // Resume a run already in flight on the server (durable job): if the user
  // kicked analysis then navigated away, the card picks the poll back up on
  // mount instead of silently stalling until a manual reload.
  const resumed = useRef(false);
  useEffect(() => {
    if (match.analyzing && !resumed.current && onResumeAnalyze) {
      resumed.current = true;
      setAnalyzing(true); setAnalyzeErr(null);
      onResumeAnalyze(match.id).then(({ outcome, error }: { outcome: string; error?: string }) => { if (outcome === "failed") setAnalyzeErr(error || "оценка не удалась"); setAnalyzing(false); });
    }
  }, [match.analyzing, match.id, onResumeAnalyze]);

  return (
    <section style={{ ...S.card, borderColor: meta.color + "55" }}>
      <div style={S.cardHead}>
        <div>
          <div style={S.matchup}>{match.home}{match.state === "live" || match.state === "finished" ? <span style={S.score}> {match.scoreHome}:{match.scoreAway} </span> : <span style={S.vs}> — </span>}{match.away}</div>
          <div style={S.timing}>{(match.state === "upcoming" || match.state === "lineup") && match.kickoff}{match.state === "live" && `LIVE · ${match.clock || (match.minute != null ? `${match.minute}'` : "")}`}{match.state === "finished" && (match.endTime ? `завершён ${match.endTime}` : "финал")}{hasLineups && <>{"  ·  "}<span style={{ color: match.lineupOut ? "#70b56a" : "#8b95a5" }}>{match.lineupOut ? "✓ состав" : "○ без состава"}</span></>}</div>
          {match.state === "finished" && match.duration && <div style={S.finishTiming}>{match.kickoffTime}–{match.endTime} · длительность {match.duration}{match.endNote && ` · ${match.endNote}`}</div>}
        </div>
        <div style={{ ...S.stateBadge, background: meta.bg, color: meta.color }}>{match.state === "live" && <span style={S.pulse} />}{meta.label}</div>
      </div>

      <div style={S.matchBody} className="el-match-body">
        <div style={S.matchLeft}>
          <div style={S.tabBar} className="el-tab-buttons">{tabs.map((t) => <button key={t.id} onClick={() => setTab(t.id)} style={{ ...S.tabBtn, ...(tab === t.id ? S.tabBtnOn : {}) }}>{t.label}</button>)}</div>
          <select style={S.tabSelect} className="el-tab-select" value={tab} onChange={(e) => setTab(e.target.value)}>
            {tabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <div style={S.tabBody}>
            {tab === "analysis" && (() => {
              const hasAnalysis = !!(match.preLineup || match.postLineup);
              const noQuotes = !match.markets?.length;
              const canRun = match.state !== "finished";
              return (
              <div style={S.analysisFlow}>
                {analyzeErr && <div style={S.analysisPending}>{analyzeErr}</div>}
                {/* Empty state — clean, centered: one line + one button */}
                {!hasAnalysis && (
                  <div style={S.analysisEmpty}>
                    <div style={S.analysisEmptyText}>{noQuotes ? "Нет котировок — сначала «Подтянуть матчи»." : "ИИ оценит матч и предложит ставки стратегий."}</div>
                    {canRun
                      ? <button style={{ ...S.analysisRunBtn, opacity: (analyzing || noQuotes) ? 0.6 : 1 }} disabled={analyzing || noQuotes} onClick={runAnalyze}>{analyzing ? <><span style={S.spinner} /> ИИ оценивает…</> : "✨ Оценить матч (ИИ)"}</button>
                      : <div style={S.analysisEmptyMuted}>матч завершён — анализа не было</div>}
                  </div>
                )}
                {hasLineups ? <>
                  {match.preLineup && (
                    <div style={S.analysisStage}>
                      <div style={S.analysisStageLabel}><span style={S.stageNum}>1</span> До состава</div>
                      <Assessment a={match.preLineup} />
                    </div>
                  )}
                  {match.postLineup && (
                    <div style={S.analysisStage}>
                      <div style={S.analysisStageLabel}><span style={{ ...S.stageNum, background: "#e8a838", color: "#12161d" }}>2</span> После состава <span style={S.stagePriority}>приоритетная</span></div>
                      <Assessment a={match.postLineup} />
                    </div>
                  )}
                </> : <>
                  {(match.postLineup || match.preLineup) && <div style={S.analysisStage}><div style={S.analysisStageLabel}><span style={S.stageNum}>✓</span> Анализ</div><Assessment a={match.postLineup || match.preLineup} /></div>}
                </>}
                {/* Compact re-run — only once an analysis exists */}
                {hasAnalysis && canRun && (
                  <div style={S.analysisRerunRow}>
                    <button style={{ ...S.analysisRerunBtn, opacity: analyzing ? 0.6 : 1 }} disabled={analyzing} onClick={runAnalyze}>{analyzing ? <><span style={S.spinner} /> ИИ оценивает…</> : "↻ Переоценить (ИИ)"}</button>
                  </div>
                )}
                {compStrats.length > 0 && compStrats.some((st: any) => { const r = match.bets?.[st.id]; return r && r.rationale; }) && (
                  <div style={S.analysisStage}>
                    <div style={S.analysisStageLabel}><span style={{ ...S.stageNum, background: "#5b9bd5", color: "#12161d" }}>3</span> Решения стратегий</div>
                    <div style={S.decisionList}>
                      {compStrats.map((st: any) => {
                        const raw = match.bets?.[st.id];
                        const rationale = raw ? raw.rationale : null;
                        const items = betItems(raw);
                        return (
                          <div key={st.id} style={S.decisionItem}>
                            <div style={S.decisionHead}>
                              <span style={{ ...S.dot, background: st.color }} />
                              <span style={S.decisionName}>{st.name}</span>
                              <span style={S.decisionVerdict}>{items.length === 0 ? "пропуск" : `${items.length} ${items.length === 1 ? "ставка" : "ставки"}`}</span>
                            </div>
                            {/* The concrete decision — which markets, at what edge/size, and
                                whether it's a preview (предлагается) or an actual entry (вошёл).
                                The rationale below then EXPLAINS this, not floats on its own. */}
                            {items.length > 0 && (
                              <div style={S.decisionBets}>
                                {items.map((b: any, i: number) => {
                                  const price = curByLabel[b.market] ?? b.price ?? b.currentPrice ?? b.entryPrice;
                                  const edge = b.aiProb != null && price ? (b.aiProb - price / 100) * 100 : null;
                                  const statusTxt = b.status === "open" ? "вошёл" : b.status === "proposed" ? "предлагается" : b.status === "not_filled" ? "не заполнилась" : b.status;
                                  return (
                                    <div key={i} style={S.decisionBetRow}>
                                      <span style={S.decisionBetMkt}>{b.market}</span>
                                      <span style={S.decisionBetMeta}>{price != null ? `${price}¢` : "—"}{edge != null && <span style={{ color: edge >= 0 ? "#5fd08a" : "#ff6b6b" }}> · edge {edge >= 0 ? "+" : ""}{edge.toFixed(1)}%</span>}{b.stake != null && ` · ${fmtMoney(b.stake)}`}</span>
                                      <span style={{ ...S.decisionBetStatus, color: b.status === "open" ? "#5fd08a" : b.status === "proposed" ? "#e8a838" : MUTE }}>{statusTxt}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            <p style={S.decisionText}>{rationale || (items.length === 0 ? "Край недостаточен — стратегия воздерживается." : "—")}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <PastAssessments history={match.assessmentHistory} />
              </div>
              );
            })()}
            {tab === "strat" && (
              <div style={S.stratListGrid} className="el-strat-grid">
                {analyzing && <div style={S.runningRow}><span style={S.spinner} /> ИИ прогоняет стратегии…</div>}
                {analyzeErr && <div style={S.analysisPending}>{analyzeErr}</div>}
                {compStrats.length === 0 && <div style={S.noStrat}>Стратегия не активирована на «{comp.name}». Задай бюджет турниру (кнопка <b>$</b> на плашке) и распредели долю стратегии («⚙ Распределить доли %» над матчами) — тогда она начнёт играть и появится здесь.</div>}
                {compStrats.map((st: any) => {
                  const budget = stratBudget(compBudget, comp.id, shares, st.id);
                  const raw = match.bets?.[st.id];
                  const items = betItems(raw);
                  return (
                    <div key={st.id} style={S.stratBlock}>
                      <div style={S.stratBlockHead}>
                        <span style={{ ...S.dot, background: st.color }} /><span style={S.stratName}>{st.name}</span>
                        <span style={S.stratBudgetChip}>{shares[comp.id][st.id]}% · {fmtMoney0(budget)}</span>
                        {/* Always-on per-strategy run icon. Live → full reassessment
                            (revisit positions); pre-match/lineup → analyze the match
                            (podбор ставок). Hidden only once the match is finished. */}
                        {match.state !== "finished" && (() => {
                          const live = match.state === "live";
                          const noQuotes = !match.markets?.length;
                          const busy = reassessing[st.id] || (!live && analyzing);
                          return (
                          <button
                            style={{ ...S.stratReassessBtn, opacity: (busy || noQuotes) ? 0.5 : 1 }}
                            disabled={busy || noQuotes}
                            title={live
                              ? `Переоценить «${st.name}» по этому матчу (ИИ пересмотрит позиции: вход/частичный или полный выход)`
                              : noQuotes ? "Нет котировок — сначала «Подтянуть матчи»" : `Прогнать ИИ по матчу — подобрать ставки стратегий`}
                            onClick={async () => {
                              if (live) { setReassessing((p) => ({ ...p, [st.id]: true })); try { await onReassess(match.id, st.id); } finally { setReassessing((p) => ({ ...p, [st.id]: false })); } }
                              else { await runAnalyze(); }
                            }}
                          >{busy ? "…" : "↻"}</button>
                          );
                        })()}
                      </div>
                      {items.length === 0 ? <div style={S.noBets}>ставок нет — край недостаточен, стратегия пропускает матч</div> : (
                        <div style={S.betList}>
                          {items.map((b: any, i: number) => {
                            const curPrice = curByLabel[b.market] ?? b.currentPrice ?? b.entryPrice; // freshest quote
                            const impl = b.price != null ? b.price / 100 : impliedProb(curPrice);
                            const edge = b.aiProb != null ? (b.aiProb - impl) * 100 : null; // no model prob → no edge, don't show "NaN%"
                            const stake = b.stake != null ? b.stake : Math.round(budget * (b.pct || 0));
                            const isOpen = b.status === "open";
                            const live = isOpen && curPrice != null && b.entryPrice != null && b.entryPrice > 0 ? b.stake * (curPrice / b.entryPrice) - b.stake : null;
                            const entryDisp = b.entryPrice != null ? `${b.entryPrice}¢` : (b.price != null ? `${b.price}¢` : "");
                            return (
                              <div key={i} style={S.betRow}>
                                <div style={S.betMain}><span style={S.betMarket}>{b.market}</span><span style={S.betOdds}>@ {entryDisp}</span></div>
                                <div style={S.betMeta}>
                                  {edge != null && <span style={{ ...S.betEdge, color: edge >= 5 ? "#5fd08a" : edge >= 3 ? "#e8a838" : "#9aa4b2" }}>edge {edge >= 0 ? "+" : ""}{edge.toFixed(1)}%</span>}
                                  <span style={S.betStake}>{fmtMoney(stake)}</span>
                                  {isOpen && live != null && <span style={{ ...S.betLive, color: live >= 0 ? "#5fd08a" : "#ff6b6b" }}>{live >= 0 ? "▲" : "▼"}{fmtMoney(live)}</span>}
                                  {b.status === "proposed" && <span style={S.betProposed}>предлагается</span>}
                                </div>
                                {b.entered && <div style={S.betEntered}>вход: {b.entered}</div>}
                              </div>
                            );
                          })}
                          <div style={S.betTotal}>задействовано {fmtMoney(items.reduce((a: number, b: any) => a + (b.stake != null ? b.stake : Math.round(budget * (b.pct || 0))), 0))} из {fmtMoney0(budget)}</div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {tab === "reassess" && (
              <div>
                <div style={S.reassessTop}>
                  <span style={S.reassessHint}>Развёрнутые переоценки ИИ по ходу матча (в отличие от сухого лога). Запустить вручную — кнопкой ↻ у стратегии во вкладке «Ставки стратегий».</span>
                </div>
                <div style={S.logStratBar}>{barStrats.map((st: any) => <button key={st.id} onClick={() => setLogStrat(st.id)} style={{ ...S.logStratBtn, ...(logStrat === st.id ? { background: st.color + "22", color: st.color, borderColor: st.color + "66" } : {}) }}>{st.name}</button>)}</div>
                <div style={S.reassessList}>
                  {(match.reassessByStrat?.[logStrat] || []).length === 0 && <div style={S.noPos}>переоценок пока нет</div>}
                  {(match.reassessByStrat?.[logStrat] || []).map((r: any, i: number) => (
                    <div key={i} style={S.reassessItem}>
                      <div style={S.reassessItemHead}>{r.at && <span style={S.reassessAt}>{r.at}</span>}<span style={S.reassessMin}>{r.min}</span>{r.conf && r.conf !== "—" && <span style={S.reassessConf}>уверенность: {r.conf}</span>}</div>
                      <p style={S.reassessText}>{r.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {tab === "settle" && (
              <div>
                {/* RESOLUTION — only when the match actually finished. */}
                {hasResolution && (
                  <div style={{ marginBottom: hasCashout ? 18 : 0 }}>
                    <div style={S.settleHead}>Финальный счёт <b style={{ color: "#e8a838" }}>{match.finalScore}</b> — ставки рассчитаны</div>
                    {barStrats.filter((st: any) => (match.settledBets[st.id] || []).some((b: any) => !b.settledBy)).map((st: any) => (
                      <div key={st.id} style={S.settleStrat}>
                        <div style={S.settleStratHead}><span style={{ ...S.dot, background: st.color }} /><span style={S.stratName}>{st.name}</span></div>
                        {match.settledBets[st.id].filter((b: any) => !b.settledBy).map((b: any, i: number) => (
                          <div key={i} style={S.settleBet}>
                            <span style={S.settleMarket}>{b.market}</span>
                            <span style={S.settleStake}>{fmtMoney(b.stake)}</span>
                            <span style={{ ...S.settleResult, color: b.result === "won" ? "#5fd08a" : "#ff6b6b" }}>{b.result === "won" ? "✓ выиграла" : "✕ проиграла"}</span>
                            <span style={{ ...S.settlePayout, color: b.result === "won" ? "#5fd08a" : "#ff6b6b" }}>{b.result === "won" ? `→ ${fmtMoney(b.payout)}` : "→ $0"}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                {/* CASH-OUTS — positions closed / partially fixed in-match. These
                    are trades, not the match result: show realised P&L, no счёт. */}
                {hasCashout && (
                  <div>
                    <div style={S.settleHead}>Закрытия по ходу матча — реализованный P&L (не итог матча)</div>
                    {barStrats.filter((st: any) => (match.settledBets[st.id] || []).some((b: any) => b.settledBy)).map((st: any) => (
                      <div key={st.id} style={S.settleStrat}>
                        <div style={S.settleStratHead}><span style={{ ...S.dot, background: st.color }} /><span style={S.stratName}>{st.name}</span></div>
                        {match.settledBets[st.id].filter((b: any) => b.settledBy).map((b: any, i: number) => {
                          const pnl = (b.payout ?? 0) - (b.stake ?? 0);
                          const up = pnl >= 0;
                          const pnlPct = b.stake ? (pnl / b.stake) * 100 : 0;
                          const closedPct = b.closedPct ?? 100;
                          const orig = closedPct > 0 ? (b.stake ?? 0) / (closedPct / 100) : (b.stake ?? 0); // full position size
                          return (
                            <div key={i} style={S.settleBet}>
                              {b.at && <span style={S.settleAt}>{b.at}</span>}
                              <span style={S.settleMarket}>{b.market}</span>
                              <span style={S.settleStake} title="Какая доля позиции закрыта и её размер в $">
                                {closedPct >= 100 ? "закрыта полностью" : `фиксация ${closedPct}%`} · {fmtMoney(b.stake)}{closedPct < 100 && orig > 0 ? ` из ${fmtMoney(orig)}` : ""}
                              </span>
                              <span style={{ ...S.settlePayout, color: up ? "#5fd08a" : "#ff6b6b" }} title="Реализованный P&L по закрытой доле (не итог матча)">{up ? "+" : "−"}{fmtMoney(Math.abs(pnl))} ({up ? "+" : ""}{pnlPct.toFixed(0)}%)</span>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {tab === "log" && hasLog && (
              <div>
                <div style={S.logStratBar}>{barStrats.map((st: any) => <button key={st.id} onClick={() => setLogStrat(st.id)} style={{ ...S.logStratBtn, ...(logStrat === st.id ? { background: st.color + "22", color: st.color, borderColor: st.color + "66" } : {}) }}>{st.name}</button>)}</div>
                <div style={S.logList}>
                  {(match.logByStrat?.[logStrat] || []).length === 0 && <div style={S.noPos}>действий пока нет</div>}
                  {(match.logByStrat?.[logStrat] || []).map((e: any, i: number) => <div key={i} style={S.logEntry}>{e.at && <span style={S.logAt}>{e.at}</span>}<span style={S.logMin}>{e.min}</span><span style={{ ...S.logType, ...logTypeStyle(e.type) }}>{e.type}</span><span style={S.logText}>{e.text}</span></div>)}
                </div>
              </div>
            )}
            {tab === "live" && hasLive && (
              <div style={S.liveWrap}>
                {match.lineups && (match.lineups.home || match.lineups.away) && (
                  <div>
                    <button style={S.lineupToggle} onClick={() => setShowLineups((v) => !v)}>{showLineups ? "▾ Скрыть составы" : "▸ Показать составы"}</button>
                    {showLineups && (
                      <div style={S.lineupGrid}>
                        {[match.lineups.home, match.lineups.away].filter(Boolean).map((l: any, i: number) => (
                          <div key={i} style={S.lineupCol}>
                            <div style={S.lineupTeam}>{l.team}{l.formation && <span style={S.lineupForm}> · {l.formation}</span>}</div>
                            <ol style={S.lineupList}>{l.starters.map((p: string, j: number) => <li key={j} style={S.lineupPlayer}>{p}</li>)}</ol>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {match.events?.length > 0 && (
                  <div style={S.eventsBox}>
                    <div style={S.eventsLabel}>События и статистика по ходу матча</div>
                    {match.events.map((e: any, i: number) => (
                      <div key={i} style={S.eventRow}>
                        <span style={S.eventMin}>{e.minute != null ? `${e.minute}'` : ""}</span>
                        <span style={{ ...S.eventTag, ...eventTagStyle(e.type) }}>{eventTagChar(e.type)}</span>
                        <span style={S.eventText}>{e.team ? <b>{e.team}</b> : null} {e.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {match.state === "finished" ? (
          <aside style={S.oddsCol} className="el-odds-col">
            <div style={S.oddsColLabel}>Итог стратегий</div>
            <div style={S.oddsColSub}>как отработала каждая</div>
            <div style={S.oddsScroll}>
              {barStrats.filter((st: any) => match.result?.[st.id] != null).map((st: any) => {
                const budget = stratBudget(compBudget, comp.id, shares, st.id);
                const roi = budget ? (match.result[st.id] / budget) * 100 : 0;
                return (
                  <div key={st.id} style={S.finishCell}>
                    <div style={S.finishTop}><span style={{ ...S.dot, background: st.color }} /><span style={S.finishNm}>{st.name}</span></div>
                    <div style={{ ...S.finishVal, color: match.result[st.id] >= 0 ? "#5fd08a" : "#ff6b6b" }}>{fmtMoney(match.result[st.id])}</div>
                    <div style={{ ...S.finishRoi, color: roi >= 0 ? "#5fd08a" : "#ff6b6b" }}>ROI {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%</div>
                  </div>
                );
              })}
            </div>
          </aside>
        ) : match.markets && match.markets.length > 0 && (
          <aside style={S.oddsCol} className="el-odds-col">
            <div style={S.oddsColHead}>
              <div><div style={S.oddsColLabel}>Котировки</div><div style={S.oddsColSub}>Polymarket · цена в ¢</div></div>
              <div style={S.oddsRefreshWrap}>
                <span style={S.oddsFlashSlot}>{flash.n > 0 && <span key={flash.n} className="el-odds-flash" style={flash.kind === "err" ? S.oddsFlashErr : S.oddsFlash} title={flash.kind === "err" ? "не удалось обновить котировки" : "котировки обновились"}>&#9679;</span>}</span>
                <button style={S.oddsRefresh} title="Обновить котировки" onClick={doRefresh} disabled={refreshing}>{refreshing ? "…" : "↻"}</button>
              </div>
            </div>
            <div style={S.oddsScroll}>
              {[...match.markets].sort((a: any, b: any) => (b.price ?? 0) - (a.price ?? 0)).map((mk: any) => {
                const move = mk.openCents != null ? Math.round(mk.price - mk.openCents) : 0;
                return (
                  <div key={mk.id} style={S.oddsRow}>
                    <div style={S.oddsTop}><span style={S.oddsLabel}>{mk.label}</span><span style={S.oddsVal}>{mk.price}¢</span></div>
                    <div style={S.oddsBot}>
                      {move !== 0 && (
                        <span style={{ ...S.oddsMove, color: move > 0 ? "#5fd08a" : "#ff6b6b" }} title={`Цена на старте матча ${mk.openCents}¢ → сейчас ${mk.price}¢`}>{move > 0 ? "▲+" : "▼"}{move}¢ от старта</span>
                      )}
                      <span style={S.oddsLiq}>{fmtLiq(mk.liq)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}

// Previous analyses of a match, kept as history so re-оценки don't erase the
// model's earlier reasoning. Collapsed by default — the current pre/post is
// shown above; this is the archive.
function PastAssessments({ history }: { history?: any[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!history || history.length === 0) return null;
  return (
    <div style={S.pastWrap}>
      <button style={S.pastToggle} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Прошлые оценки ({history.length})
      </button>
      {open && (
        <div style={S.pastList}>
          {history.map((h: any, i: number) => (
            <div key={i} style={S.pastItem}>
              <button style={S.pastItemHead} onClick={() => setExpanded(expanded === i ? null : i)}>
                <span style={S.pastStage}>{h.label}</span>
                <span style={S.pastAt}>{h.at}</span>
                {h.confidence && <span style={S.pastConf}>увер.: {h.confidence}</span>}
                <span style={S.pastChev}>{expanded === i ? "свернуть" : "показать"}</span>
              </button>
              {expanded === i && (
                <div style={S.pastBody}>
                  <p style={S.pastText}>{h.text || h.short || "—"}</p>
                  {h.verdict && <div style={S.verdict}><span style={{ color: "#e8a838" }}>&#9656;</span> {h.verdict}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Assessment({ a }: any) {
  const [full, setFull] = useState(false);
  if (!a) return <div style={S.noPos}>нет данных</div>;
  return (
    <div>
      <div style={S.assessTop}><span style={S.confChip}>уверенность: {a.confidence}</span><button onClick={() => setFull(!full)} style={S.fullToggle}>{full ? "кратко" : "подробно"}</button></div>
      <p style={S.assessText}>{full ? a.text : a.short}</p>
      {a.verdict && <div style={S.verdict}><span style={{ color: "#e8a838" }}>&#9656;</span> {a.verdict}</div>}
    </div>
  );
}

function ModelSelect({ value, models, onChange, onGoModels }: any) {
  if (!models || models.length === 0) {
    return <button style={S.modelSelectEmpty} onClick={onGoModels}>нет ключей — добавить →</button>;
  }
  return (
    <select style={S.modelSelect} value={value} onChange={(e) => e.target.value === "__add" ? onGoModels() : onChange(e.target.value)}>
      {!models.includes(value) && <option value={value}>{value}</option>}
      {models.map((m: string) => <option key={m} value={m}>{m}</option>)}
      <option value="__add">+ управлять моделями…</option>
    </select>
  );
}

function StrategyScreen({ sportId, sportLabel, catalog, setCatalog, competitions, matchDb, compBudget, shares, providers, quality, analysis, setAnalysis, onGoModels }: any) {
  const [modal, setModal] = useState<any>(null);
  const sportStrats = catalog.filter((s: any) => s.sport === sportId);
  const sportComps = competitions.filter((c: any) => c.sport === sportId);
  const [anSel, setAnSel] = useState("base");
  const [saved, setSaved] = useState(true);
  const saveTimer = useRef<any>(null);

  const availableModels = providers.filter((p: any) => p.hasKey).flatMap((p: any) => p.models);

  const addStrategy = async (draft: any) => {
    const res = await mutate({ type: "createStrategy", sport: sportId, name: draft.name, prompt: draft.prompt, model: draft.model, params: draft.params });
    const id = res.id || "s" + Date.now();
    setCatalog((c: any) => [...c, { ...draft, id, version: 1, sport: sportId, color: res.color || PALETTE[c.length % PALETTE.length], tag: "custom" }]);
    setModal(null);
  };
  const updateStrategy = (id: string, patch: any) => { setCatalog((c: any) => c.map((s: any) => (s.id === id ? { ...s, ...patch } : s))); mutate({ type: "patchStrategy", id, patch }); };
  const deleteStrategy = (id: string, name: string) => {
    if (typeof window !== "undefined" && !window.confirm(`Удалить стратегию «${name}» и все её данные (ставки, переоценки, метрики, доли)? Действие необратимо.`)) return;
    setCatalog((c: any) => c.filter((s: any) => s.id !== id));
    mutate({ type: "deleteStrategy", id });
  };
  const acceptImprovement = (id: string, p: string, params: any) => {
    setCatalog((c: any) => c.map((s: any) => (s.id === id ? { ...s, prompt: p, params, version: s.version + 1 } : s)));
    mutate({ type: "improveStrategy", id, prompt: p, params, reason: "improvement" });
    setModal(null);
  };

  const anValue = anSel === "base" ? analysis.bySport[sportId] : (analysis.byComp[anSel] || "");
  const setAnValue = (txt: string) => {
    setAnalysis((p: any) => anSel === "base" ? { ...p, bySport: { ...p.bySport, [sportId]: txt } } : { ...p, byComp: { ...p.byComp, [anSel]: txt } });
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await mutate({ type: "saveAnalytics", scope: anSel === "base" ? "sport" : "competition", scopeId: anSel === "base" ? sportId : anSel, body: txt });
      setSaved(true);
    }, 500);
  };
  const anModel = analysis.modelBySport?.[sportId] || "—";
  const setAnModel = (m: string) => { setAnalysis((p: any) => ({ ...p, modelBySport: { ...p.modelBySport, [sportId]: m } })); mutate({ type: "setAnalyticsModel", sportId, model: m }); };

  return (
    <main style={S.main}>
      <div style={S.analysisCard}>
        <div style={S.analysisCardHead}>
          <div style={S.analysisTitle}>Аналитический промт · {sportLabel}</div>
          <div style={S.analysisModelPick}>
            <span style={S.analysisModelLbl}>модель:</span>
            <ModelSelect value={anModel} models={availableModels} onChange={setAnModel} onGoModels={onGoModels} />
          </div>
        </div>
        <div style={S.masterDetail} className="el-master-detail">
          <div style={S.mdList}>
            <button style={{ ...S.mdItem, ...(anSel === "base" ? S.mdItemOn : {}) }} onClick={() => setAnSel("base")}>
              <span style={S.mdItemName}>Базовый ({sportLabel})</span>
              <span style={S.mdItemTag}>применяется везде</span>
            </button>
            {sportComps.map((c: any) => (
              <button key={c.id} style={{ ...S.mdItem, ...(anSel === c.id ? S.mdItemOn : {}) }} onClick={() => setAnSel(c.id)}>
                <span style={S.mdItemName}>{c.name}</span>
                <span style={{ ...S.mdItemTag, color: analysis.byComp[c.id] ? "#70b56a" : MUTE }}>{analysis.byComp[c.id] ? "✓ переопределено" : "наследует базовый"}</span>
              </button>
            ))}
          </div>
          <div style={S.mdContent}>
            {anSel !== "base" && <div style={S.mdHint}>Дополнение к базовому промту, только для «{sportComps.find((c: any) => c.id === anSel)?.name}». Пусто — используется базовый.</div>}
            <textarea style={S.mdTextarea} value={anValue} onChange={(e) => setAnValue(e.target.value)} placeholder={anSel === "base" ? "Как ИИ оценивает матчи этого спорта…" : "Особенности для турнира…"} />
            <div style={S.saveIndicator}>{saved ? <span style={{ color: "#70b56a" }}>✓ сохранено</span> : <span style={{ color: "#e8a838" }}>сохранение…</span>}</div>
          </div>
        </div>
      </div>

      <div style={S.stratIntro}>
        <div style={S.stratIntroTop}><div><div style={S.stratIntroTitle}>Стратегии · {sportLabel}</div><div style={S.stratIntroSub}>Бюджет и доли — на экране «Матчи». Модель выбирается для каждой стратегии.</div></div><button style={S.addBtn} onClick={() => setModal({ type: "new" })}>+ Новая</button></div>
        <div style={S.howto}>Опиши стратегию <b>словами</b>: вход, размер, переоценка, выход, ограничители. Движок вытащит числа.</div>
      </div>

      {sportStrats.length === 0 && <div style={S.empty}>В категории «{sportLabel}» пока нет стратегий.</div>}
      {sportStrats.map((st: any) => <StrategyCard key={st.id} st={st} overall={stratOverall(competitions, matchDb, st.id, sportId, compBudget, shares)} availableModels={availableModels} onSetModel={(m: string) => updateStrategy(st.id, { model: m })} onGoModels={onGoModels} onEdit={() => setModal({ type: "edit", stratId: st.id })} onImprove={() => setModal({ type: "improve", stratId: st.id })} onDelete={() => deleteStrategy(st.id, st.name)} />)}

      {modal?.type === "new" && <PromptModal title={`Новая стратегия · ${sportLabel}`} availableModels={availableModels} onGoModels={onGoModels} onClose={() => setModal(null)} onSave={addStrategy} />}
      {modal?.type === "edit" && <PromptModal title="Редактировать" strat={catalog.find((s: any) => s.id === modal.stratId)} availableModels={availableModels} onGoModels={onGoModels} onClose={() => setModal(null)} onSave={(d: any) => { updateStrategy(modal.stratId, d); setModal(null); }} />}
      {modal?.type === "improve" && <ImproveModal strat={catalog.find((s: any) => s.id === modal.stratId)} stats={improveStats(quality[modal.stratId], stratOverall(competitions, matchDb, modal.stratId, sportId, compBudget, shares))} onClose={() => setModal(null)} onAccept={(p: string, params: any) => acceptImprovement(modal.stratId, p, params)} />}
    </main>
  );
}

function improveStats(q: any, overall: any) {
  const matches = q?.samples ?? 0;
  return { matches, roi: overall?.avgRoi ?? 0, note: matches >= 20 ? "Данных достаточно для анализа." : "Мало данных — метрики шумны." };
}

function FeedScreen({ feed }: any) {
  const [filter, setFilter] = useState("all");
  const types = [["all", "Всё"], ["enter", "Входы"], ["reassess", "Переоценки"], ["settle", "Расчёты"], ["goal", "События матча"], ["skip", "Пропуски"]];
  const MATCH_EVENT = new Set(["goal", "lineup", "card", "sub", "stats"]);
  const shown = filter === "all" ? feed : feed.filter((e: any) => e.type === filter || (filter === "goal" && MATCH_EVENT.has(e.type)));
  return (
    <main style={S.main}>
      <div style={S.feedHead}>
        <div><div style={S.feedTitle}>Лента событий</div><div style={S.feedSub}>Хронология по всем матчам, спортам и стратегиям.</div></div>
      </div>
      <div style={S.feedFilters}>
        {types.map(([k, lbl]) => <button key={k} onClick={() => setFilter(k)} style={{ ...S.feedFilterBtn, ...(filter === k ? S.feedFilterOn : {}) }}>{lbl}</button>)}
      </div>
      <div style={S.feedList}>
        {shown.length === 0 && <div style={S.noPos}>событий нет</div>}
        {shown.map((e: any, i: number) => (
          <div key={i} style={S.feedItem}>
            <div style={S.feedTime}>{e.at && <span style={S.feedClock}>{e.at}</span>}{e.t && <span>{e.t}</span>}</div>
            <div style={{ ...S.feedIcon, ...feedIconStyle(e.type) }}>{feedIconChar(e.type)}</div>
            <div style={S.feedBody}>
              <div style={S.feedItemTop}>
                {e.strat && <span style={{ ...S.feedStrat, color: e.color || "#8b95a5" }}>{e.strat}</span>}
                <span style={S.feedMatch}>{e.sport} · {e.match}</span>
                {e.score && <span style={S.feedScore}>{e.score}</span>}
              </div>
              <div style={S.feedText}>{e.text}</div>
            </div>
            {e.pnl != null && <div style={{ ...S.feedPnl, color: e.pnl >= 0 ? "#5fd08a" : "#ff6b6b" }}>{e.pnl >= 0 ? "+" : ""}{fmtMoney(e.pnl)}</div>}
          </div>
        ))}
      </div>
    </main>
  );
}
function eventTagChar(t: string) { return ({ goal: "⚽", red_card: "🟥", yellow_card: "🟨", sub: "⇄", stats: "📊" } as any)[t] || "•"; }
function eventTagStyle(t: string) { const map: any = { goal: { color: "#e8a838" }, red_card: { color: "#ff6b6b" }, yellow_card: { color: "#e8c838" }, sub: { color: "#4fc3c7" }, stats: { color: "#7fb4e8" } }; return map[t] || { color: "#8b95a5" }; }
function feedIconChar(t: string) { return ({ enter: "→", reassess: "↻", settle: "✓", goal: "⚽", card: "▪", sub: "⇄", lineup: "📋", stats: "📊", skip: "—" } as any)[t] || "•"; }
function feedIconStyle(t: string) {
  const map: any = { enter: { color: "#70b56a", borderColor: "#70b56a55" }, reassess: { color: "#5b9bd5", borderColor: "#5b9bd555" }, settle: { color: "#c98bdb", borderColor: "#c98bdb55" }, goal: { color: "#e8a838", borderColor: "#e8a83855" }, card: { color: "#e07a5f", borderColor: "#e07a5f55" }, sub: { color: "#4fc3c7", borderColor: "#4fc3c755" }, lineup: { color: "#e8a838", borderColor: "#e8a83855" }, stats: { color: "#7fb4e8", borderColor: "#7fb4e855" }, skip: { color: "#8b95a5", borderColor: "#2c3543" } };
  return map[t] || {};
}

function EquitySpark({ data }: any) {
  const w = 100, h = 32;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v: number, i: number) => { const x = (i / (data.length - 1)) * w; const y = h - ((v - min) / range) * h; return `${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");
  const start = data[0], end = data[data.length - 1];
  const up = end >= start;
  return (
    <div style={S.equityWrap}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={S.equitySvg}>
        <polyline points={pts} fill="none" stroke={up ? "#5fd08a" : "#ff6b6b"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={S.equityMeta}>
        <span style={S.equityStart}>{fmtMoney0(start)}</span>
        <span style={{ ...S.equityEnd, color: up ? "#5fd08a" : "#ff6b6b" }}>{fmtMoney0(end)} ({up ? "+" : ""}{start ? (((end - start) / start) * 100).toFixed(1) : "0.0"}%)</span>
      </div>
    </div>
  );
}

function MetricsScreen({ catalog, quality, stats }: any) {
  const S0 = { matches: 0, predictions: 0, won: 0, lost: 0, openPlus: 0, openMinus: 0, openPnl: 0, earned: 0, lostMoney: 0, inMatch: 0, inMatchPlus: 0, inMatchMinus: 0 };
  return (
    <main style={S.main}>
      <div style={S.feedHead}>
        <div><div style={S.feedTitle}>Статистика стратегий</div><div style={S.feedSub}>Подробная статистика по каждой стратегии. Открытые позиции — по актуальной котировке. Ниже — метрики качества эджа.</div></div>
      </div>
      <div style={S.metricExplain}>
        <div style={S.metricExplainItem}><b style={{ color: "#7fb4e8" }}>Brier</b> — точность вероятностей (ниже = лучше). Насколько «70%» ИИ реально значит 70%.</div>
        <div style={S.metricExplainItem}><b style={{ color: "#70b56a" }}>CLV</b> — closing line value. Двигался ли рынок в твою сторону после входа. Лучший ранний признак реального эджа.</div>
        <div style={S.metricExplainItem}><b style={{ color: "#e8a838" }}>Калибровка</b> — совпадают ли предсказанные вероятности с фактической частотой исходов.</div>
      </div>
      {catalog.map((s: any) => {
        const st = { ...S0, ...(stats?.[s.id] || {}) };
        const q = quality[s.id];
        const netRealized = st.earned - st.lostMoney;
        return (
          <section key={s.id} style={{ ...S.card, borderColor: s.color + "55" }}>
            <div style={S.metricHead}>
              <span style={{ ...S.dot, background: s.color }} />
              <span style={S.metricName}>{s.name}</span>
              <span style={S.metricSamples}>{st.matches} матч(ей) · {st.predictions} ставок</span>
            </div>
            <div style={S.statGrid}>
              <div style={S.statCell}><div style={S.statLbl}>Верных прогнозов</div><div style={{ ...S.statVal, color: "#5fd08a" }}>{st.won}</div></div>
              <div style={S.statCell}><div style={S.statLbl}>Неверных</div><div style={{ ...S.statVal, color: "#ff6b6b" }}>{st.lost}</div></div>
              <div style={S.statCell}><div style={S.statLbl}>Заработано</div><div style={{ ...S.statVal, color: "#5fd08a" }}>{fmtMoney(st.earned)}</div></div>
              <div style={S.statCell}><div style={S.statLbl}>Потеряно</div><div style={{ ...S.statVal, color: "#ff6b6b" }}>−{fmtMoney(st.lostMoney)}</div></div>
              <div style={S.statCell}><div style={S.statLbl}>Итог (реализ.)</div><div style={{ ...S.statVal, color: netRealized >= 0 ? "#5fd08a" : "#ff6b6b" }}>{netRealized >= 0 ? "+" : ""}{fmtMoney(netRealized)}</div></div>
              <div style={S.statCell}><div style={S.statLbl}>Открыто +/−</div><div style={S.statVal}><span style={{ color: "#5fd08a" }}>{st.openPlus}</span> / <span style={{ color: "#ff6b6b" }}>{st.openMinus}</span></div></div>
              <div style={S.statCell}><div style={S.statLbl}>Открытый P&L</div><div style={{ ...S.statVal, color: st.openPnl >= 0 ? "#5fd08a" : "#ff6b6b" }}>{st.openPnl >= 0 ? "+" : ""}{fmtMoney(st.openPnl)}</div></div>
              <div style={S.statCell}><div style={S.statLbl}>В матче +/−</div><div style={S.statVal}><span style={{ color: "#5fd08a" }}>{st.inMatchPlus}</span> / <span style={{ color: "#ff6b6b" }}>{st.inMatchMinus}</span> <span style={{ color: MUTE, fontSize: 10 }}>из {st.inMatch}</span></div></div>
            </div>
            {st.predictions === 0 && <div style={S.metricWarn}>Ставок ещё нет — статистика появится, когда стратегия начнёт играть.</div>}
            <div style={{ ...S.calibLabel, marginTop: 12 }}>Метрики качества эджа {q && q.samples < 20 && <span style={{ color: "#e8a838" }}>· мало данных ({q.samples})</span>}</div>
            {q ? <>
            <div style={S.metricNums}>
              <div style={S.metricNumCell}><div style={S.metricNumLbl}>Brier</div><div style={{ ...S.metricNumVal, color: q.brier == null ? MUTE : q.brier <= 0.19 ? "#5fd08a" : q.brier <= 0.22 ? "#e8a838" : "#ff6b6b" }}>{q.brier != null ? q.brier.toFixed(3) : "—"}</div></div>
              <div style={S.metricNumCell}><div style={S.metricNumLbl}>CLV</div><div style={{ ...S.metricNumVal, color: q.clv == null ? MUTE : q.clv > 0 ? "#5fd08a" : "#ff6b6b" }}>{q.clv != null ? `${q.clv >= 0 ? "+" : ""}${q.clv.toFixed(1)}%` : "—"}</div></div>
              <div style={S.metricNumCell}><div style={S.metricNumLbl}>вердикт</div><div style={{ ...S.metricVerdict, color: (q.clv ?? 0) > 1 && (q.brier ?? 1) < 0.2 ? "#5fd08a" : (q.clv ?? 0) < 0 ? "#ff6b6b" : "#e8a838" }}>{q.brier == null || q.clv == null ? "нет данных" : q.clv > 1 && q.brier < 0.2 ? "эдж реален" : q.clv < 0 ? "эджа нет" : "неясно"}</div></div>
            </div>
            <div style={S.calibLabel}>Калибровка (предсказано → факт)</div>
            <div style={S.calibRows}>
              {(q.calib || []).map((c: any, i: number) => {
                const diff = c.actual - c.predicted;
                return (
                  <div key={i} style={S.calibRow}>
                    <span style={S.calibBucket}>{c.bucket}</span>
                    <div style={S.calibBar}>
                      <div style={{ ...S.calibBarPred, width: `${c.predicted}%` }} />
                      <div style={{ ...S.calibDot, left: `${c.actual}%` }} />
                    </div>
                    <span style={{ ...S.calibDiff, color: Math.abs(diff) <= 3 ? "#5fd08a" : Math.abs(diff) <= 6 ? "#e8a838" : "#ff6b6b" }}>{diff >= 0 ? "+" : ""}{diff}</span>
                  </div>
                );
              })}
            </div>
            {q.samples < 20 && <div style={S.metricWarn}>Выборка мала ({q.samples}) — не доверяй метрикам качества до 20+ рассчитанных ставок.</div>}
            </> : <div style={S.mgmtNeutral}>Нет рассчитанных ставок — метрики появятся после расчёта по завершённым матчам.</div>}

            {/* Результативность по фазам входа */}
            {(
              <div style={S.phaseBlock}>
                <div style={S.phaseBlockLabel}>Результативность по фазам входа <span style={S.phaseHint}>где стратегия реально зарабатывает</span></div>
                {q?.phases && q.phases.some((p: any) => p.bets > 0) ? (
                <div style={S.phaseRows}>
                  {q.phases.map((ph: any) => {
                    const empty = ph.bets === 0;
                    const wr = ph.bets ? Math.round((ph.wins / ph.bets) * 100) : 0;
                    return (
                      <div key={ph.id} style={{ ...S.phaseRow, opacity: empty ? 0.45 : 1 }}>
                        <span style={S.phaseName}>{ph.label}</span>
                        <span style={S.phaseBets}>{empty ? "—" : `${ph.bets} ст. · ${wr}% W`}</span>
                        <span style={{ ...S.phasePnl, color: empty ? MUTE : ph.pnl >= 0 ? "#5fd08a" : "#ff6b6b" }}>{empty ? "$0" : `${ph.pnl >= 0 ? "+" : ""}${fmtMoney(ph.pnl)}`}</span>
                      </div>
                    );
                  })}
                </div>
                ) : <div style={S.mgmtNeutral}>Нет рассчитанных ставок — появится, когда стратегия сыграет и матчи завершатся.</div>}
              </div>
            )}

            {/* Ценность активного управления */}
            {(
              <div style={S.phaseBlock}>
                <div style={S.phaseBlockLabel}>Ценность активного управления <span style={S.phaseHint}>эдж в управлении позицией, а не в прогнозе</span></div>
                {!q?.mgmt || q.mgmt.managed === 0 ? (
                  <div style={S.mgmtNeutral}>{q?.mgmt ? "Стратегия не управляет по ходу — держит до финала. Нечего сравнивать." : "Нет данных — стратегия ещё не фиксировала и не выходила из позиций досрочно."}</div>
                ) : (() => {
                  const delta = q.mgmt.actualPnl - q.mgmt.heldToEndPnl;
                  return (
                    <>
                      <div style={S.mgmtRow}>
                        <div style={S.mgmtCell}><div style={S.mgmtLbl}>факт (с выходами)</div><div style={S.mgmtVal}>{fmtMoney(q.mgmt.actualPnl)}</div></div>
                        <div style={S.mgmtVs}>vs</div>
                        <div style={S.mgmtCell}><div style={S.mgmtLbl}>держал бы до конца</div><div style={S.mgmtVal}>{fmtMoney(q.mgmt.heldToEndPnl)}</div></div>
                        <div style={S.mgmtVs}>=</div>
                        <div style={S.mgmtCell}><div style={S.mgmtLbl}>вклад управления</div><div style={{ ...S.mgmtDelta, color: delta >= 0 ? "#5fd08a" : "#ff6b6b" }}>{delta >= 0 ? "+" : ""}{fmtMoney(delta)}</div></div>
                      </div>
                      <div style={{ ...S.mgmtVerdict, color: delta >= 0 ? "#5fd08a" : "#ff6b6b" }}>
                        {delta >= 0 ? `Управление приносит деньги: ранние выходы/фиксации лучше, чем держать (${q.mgmt.managed} упр. позиций).` : `Управление вредит: стратегия зря дёргается, лучше держать до конца (${q.mgmt.managed} упр. позиций).`}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {/* CLV по фазам */}
            {(
              <div style={S.phaseBlock}>
                <div style={S.phaseBlockLabel}>CLV по фазам <span style={S.phaseHint}>двигался ли рынок в твою сторону после входа</span></div>
                {q?.phases && q.phases.some((p: any) => p.clv != null) ? (
                <div style={S.clvRows}>
                  {q.phases.filter((p: any) => p.clv != null).map((ph: any) => (
                    <div key={ph.id} style={S.clvRow}>
                      <span style={S.clvName}>{ph.label}</span>
                      <div style={S.clvBarWrap}>
                        <div style={S.clvBarZero} />
                        <div style={{ ...S.clvBarFill, width: `${Math.min(50, Math.abs(ph.clv) * 6)}%`, left: ph.clv >= 0 ? "50%" : "auto", right: ph.clv < 0 ? "50%" : "auto", background: ph.clv >= 0 ? "#5fd08a" : "#ff6b6b" }} />
                      </div>
                      <span style={{ ...S.clvVal, color: ph.clv >= 0 ? "#5fd08a" : "#ff6b6b" }}>{ph.clv >= 0 ? "+" : ""}{ph.clv.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
                ) : <div style={S.mgmtNeutral}>Нет закрытых котировок — CLV появится после завершения матчей.</div>}
              </div>
            )}

            {/* Кривая банка */}
            {(
              <div style={S.phaseBlock}>
                <div style={S.phaseBlockLabel}>Кривая банка <span style={S.phaseHint}>стоимость по матчам</span></div>
                {q?.equity && q.equity.length > 1 ? (
                  <EquitySpark data={q.equity} />
                ) : <div style={S.mgmtNeutral}>Недостаточно завершённых матчей для кривой.</div>}
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}

function PortfolioScreen({ open, closed, onGoMatches }: any) {
  const [view, setView] = useState("open"); // «Актуальные» — по умолчанию
  const [groupBy, setGroupBy] = useState("strat");
  const positions = view === "open" ? open : closed;

  // Open-tab aggregates (mark-to-market) vs closed-tab aggregates (realized).
  const totalStake = open.reduce((a: number, p: any) => a + p.stake, 0);
  const totalLive = open.reduce((a: number, p: any) => a + p.live, 0);
  const openWinners = open.filter((p: any) => p.live >= 0).length;
  const realizedTotal = closed.reduce((a: number, p: any) => a + p.pnl, 0);
  const closedWinners = closed.filter((p: any) => p.pnl >= 0).length;

  const groups: any = {};
  for (const p of positions) {
    const key = groupBy === "strat" ? p.strat : p.compName;
    const g = (groups[key] = groups[key] || { items: [], color: p.stratColor, stake: 0, live: 0, pnl: 0 });
    g.items.push(p); g.stake += p.stake || 0; g.live += p.live || 0; g.pnl += p.pnl || 0;
  }
  const closedLabel = (p: any) => p.settledBy === "void" ? "возврат ставки" : p.result === "won" ? "✓ выигрыш" : "✕ проигрыш";

  return (
    <main style={S.main}>
      <div style={S.pfHeader}>
        <div><div style={S.pfTitle}>Портфель</div><div style={S.pfSub}>{view === "open" ? "Открытые позиции — всё, что сейчас в игре. Mark-to-market." : "Завершённые позиции — реализованный P&L по закрытым ставкам."}</div></div>
      </div>
      <div style={S.pfViewTabs}>
        <button style={{ ...S.pfViewTab, ...(view === "open" ? S.pfViewTabOn : {}) }} onClick={() => setView("open")}>Актуальные{open.length ? ` · ${open.length}` : ""}</button>
        <button style={{ ...S.pfViewTab, ...(view === "closed" ? S.pfViewTabOn : {}) }} onClick={() => setView("closed")}>Завершённые{closed.length ? ` · ${closed.length}` : ""}</button>
      </div>

      {view === "open" ? (
        <div style={S.pfAgg}>
          <div style={S.pfAggCell}><div style={S.pfAggLbl}>Открытых позиций</div><div style={S.pfAggVal}>{open.length}</div></div>
          <div style={S.pfAggDiv} />
          <div style={S.pfAggCell}><div style={S.pfAggLbl}>В игре</div><div style={S.pfAggVal}>{fmtMoney(totalStake)}</div></div>
          <div style={S.pfAggDiv} />
          <div style={S.pfAggCell}><div style={S.pfAggLbl}>Unrealized P&L</div><div style={{ ...S.pfAggVal, color: totalLive >= 0 ? "#5fd08a" : "#ff6b6b" }}>{totalLive >= 0 ? "+" : ""}{fmtMoney(totalLive)}</div></div>
          <div style={S.pfAggDiv} />
          <div style={S.pfAggCell}><div style={S.pfAggLbl}>В плюсе / всего</div><div style={S.pfAggVal}>{openWinners}/{open.length}</div></div>
        </div>
      ) : (
        <div style={S.pfAgg}>
          <div style={S.pfAggCell}><div style={S.pfAggLbl}>Завершённых позиций</div><div style={S.pfAggVal}>{closed.length}</div></div>
          <div style={S.pfAggDiv} />
          <div style={S.pfAggCell}><div style={S.pfAggLbl}>Реализованный P&L</div><div style={{ ...S.pfAggVal, color: realizedTotal >= 0 ? "#5fd08a" : "#ff6b6b" }}>{realizedTotal >= 0 ? "+" : ""}{fmtMoney(realizedTotal)}</div></div>
          <div style={S.pfAggDiv} />
          <div style={S.pfAggCell}><div style={S.pfAggLbl}>В плюсе / всего</div><div style={S.pfAggVal}>{closedWinners}/{closed.length}</div></div>
        </div>
      )}

      {positions.length === 0 ? (
        <div style={S.pfEmpty}>{view === "open" ? <>Сейчас нет открытых позиций. Появятся, когда стратегии войдут в live. <button style={S.pfEmptyBtn} onClick={onGoMatches}>К матчам →</button></> : "Завершённых позиций пока нет — они появятся после первых расчётов и закрытий."}</div>
      ) : (
        <>
          <div style={S.pfGroupToggle}>
            <span style={S.pfGroupLbl}>группировать:</span>
            <button style={{ ...S.pfGroupBtn, ...(groupBy === "strat" ? S.pfGroupOn : {}) }} onClick={() => setGroupBy("strat")}>по стратегии</button>
            <button style={{ ...S.pfGroupBtn, ...(groupBy === "comp" ? S.pfGroupOn : {}) }} onClick={() => setGroupBy("comp")}>по турниру</button>
          </div>
          {Object.entries(groups).map(([key, g]: any) => (
            <div key={key} style={S.pfGroup}>
              <div style={S.pfGroupHead}>
                {groupBy === "strat" && <span style={{ ...S.dot, background: g.color }} />}
                <span style={S.pfGroupName}>{key}</span>
                {view === "open" ? <>
                  <span style={S.pfGroupStake}>{fmtMoney(g.stake)} в игре</span>
                  <span style={{ ...S.pfGroupLive, color: g.live >= 0 ? "#5fd08a" : "#ff6b6b" }}>{g.live >= 0 ? "▲" : "▼"}{fmtMoney(g.live)}</span>
                </> : <>
                  <span style={S.pfGroupStake}>{g.items.length} поз.</span>
                  <span style={{ ...S.pfGroupLive, color: g.pnl >= 0 ? "#5fd08a" : "#ff6b6b" }}>{g.pnl >= 0 ? "▲+" : "▼"}{fmtMoney(Math.abs(g.pnl))}</span>
                </>}
              </div>
              <div style={S.pfPosList}>
                {g.items.map((p: any, i: number) => view === "open" ? (
                  <div key={i} style={S.pfPos}>
                    <div style={S.pfPosLeft}>
                      <div style={S.pfPosMarket}>{p.market}</div>
                      <div style={S.pfPosMeta}>
                        {groupBy === "strat" ? p.compName : <span style={{ color: p.stratColor }}>{p.strat}</span>}
                        {" · "}{p.match} · {p.minute}
                        {p.entered && <span style={S.pfPosEntered}> · вход {p.entered}</span>}
                      </div>
                    </div>
                    <div style={S.pfPosRight}>
                      <div style={S.pfPosStake}>{fmtMoney(p.stake)} @ {p.entryPrice}¢</div>
                      <div style={S.pfPosLiveWrap}>
                        <span style={S.pfPosNow}>{p.currentPrice}¢</span>
                        <span style={{ ...S.pfPosLive, color: p.live >= 0 ? "#5fd08a" : "#ff6b6b" }}>{p.live >= 0 ? "▲" : "▼"}{fmtMoney(p.live)}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={i} style={S.pfPos}>
                    <div style={S.pfPosLeft}>
                      <div style={S.pfPosMarket}>{p.market}</div>
                      <div style={S.pfPosMeta}>
                        {groupBy === "strat" ? p.compName : <span style={{ color: p.stratColor }}>{p.strat}</span>}
                        {" · "}{p.match}{p.finalScore ? ` · ${p.finalScore}` : ""}
                        {p.closedPct < 100 && <span style={S.pfPosEntered}> · фиксация {p.closedPct}%</span>}
                      </div>
                    </div>
                    <div style={S.pfPosRight}>
                      <div style={S.pfPosStake}>{fmtMoney(p.stake)} · {closedLabel(p)}</div>
                      <div style={S.pfPosLiveWrap}>
                        <span style={{ ...S.pfPosLive, color: p.pnl >= 0 ? "#5fd08a" : "#ff6b6b" }}>{p.pnl >= 0 ? "▲+" : "▼"}{fmtMoney(Math.abs(p.pnl))}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </main>
  );
}

function ModelsScreen({ providers, setProviders, total, allocated, cron, onSetTotal }: any) {
  return (
    <main style={S.main}>
      <div style={S.modelsIntro}>
        <div style={S.modelsTitle}>Настройки</div>
        <div style={S.modelsSub}>Общий баланс казны, ключи провайдеров и журнал автоматического цикла (крон).</div>
      </div>

      <BalanceCard total={total} allocated={allocated} onSetTotal={onSetTotal} />

      <div style={S.settingsSectionLbl}>Модели и ключи</div>
      <div style={S.modelsSub}>Ключ сохраняется <b>на сервере</b> и наружу не отдаётся. Переменная окружения (<code>ANTHROPIC_API_KEY</code>) имеет приоритет над ключом из UI.</div>
      {providers.map((p: any) => (
        <ProviderCard key={p.id} p={p} onSaved={(hasKey: boolean) => setProviders((prev: any[]) => prev.map((x) => x.id === p.id ? { ...x, hasKey } : x))} />
      ))}

      <CronPanel cron={cron} />
    </main>
  );
}

function BalanceCard({ total, allocated, onSetTotal }: any) {
  const [val, setVal] = useState(String(total));
  const [busy, setBusy] = useState(false);
  const n = Math.round(Number(val));
  const invalid = !isFinite(n) || n < 0 || n < allocated || n === total;
  const save = async () => { setBusy(true); await onSetTotal(n); setBusy(false); };
  return (
    <section style={S.card}>
      <div style={S.balHead}>
        <div>
          <div style={S.balTitle}>Общий баланс казны</div>
          <div style={S.balSub}>Распределено по турнирам: <b>{fmtMoney0(allocated)}</b>. Баланс не может быть меньше распределённого.</div>
        </div>
        <div style={S.balNow}>{fmtMoney0(total)}</div>
      </div>
      <div style={S.balRow}>
        <span style={S.balDollar}>$</span>
        <input style={S.balInput} type="number" value={val} onChange={(e) => setVal(e.target.value)} min={allocated} />
        <button style={{ ...S.saveBtn, opacity: invalid || busy ? 0.4 : 1 }} disabled={invalid || busy} onClick={save}>{busy ? "…" : "Сохранить"}</button>
      </div>
      {n < allocated && <div style={S.balErr}>Меньше распределённого (${allocated}) — сначала уменьши бюджеты турниров.</div>}
    </section>
  );
}

function CronPanel({ cron }: any) {
  if (!cron) return null;
  const kindLabel: any = { tick: "тик", discover: "парсинг", manual: "вручную", live: "лайв" };
  return (
    <section style={S.card}>
      <div style={S.cronHead}>
        <div style={S.cronTitle}>Журнал крона (авто-цикл)</div>
        <div style={{ ...S.cronBadge, ...(cron.enabled ? S.cronOn : S.cronOff) }}>{cron.enabled ? "включён" : "выключен"}</div>
      </div>
      <div style={S.cronPlan}>
        {cron.enabled
          ? <><b>Лайв каждые {cron.liveSec} сек</b> — пока идёт матч: котировки + события (гол/красная) → стратегия реагирует на позиции. Общий тик каждые <b>{cron.tickMin} мин</b> · парсинг Polymarket каждые <b>{cron.discoverHr} ч</b>{cron.nextRunAt && <> · следующий тик ≈ <b>{fmtWarsaw(cron.nextRunAt)}</b></>}</>
          : <>Авто-цикл выключен (<code>AUTO_TICK=false</code>). Матчи и переоценка — только по кнопке «Подтянуть матчи» и «Оценить матч».</>}
      </div>
      <div style={S.cronList}>
        {(!cron.recent || cron.recent.length === 0) && <div style={S.noPos}>запусков ещё не было</div>}
        {cron.recent?.map((r: any, i: number) => (
          <div key={i} style={S.cronRow}>
            <span style={{ ...S.cronDot, background: r.ok ? "#5fd08a" : "#ff6b6b" }} />
            <span style={S.cronAt}>{fmtWarsaw(r.at)}</span>
            <span style={S.cronKind}>{kindLabel[r.kind] ?? r.kind}</span>
            <span style={S.cronSummary}>{r.summary}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProviderCard({ p, onSaved }: any) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!key.trim()) return;
    setBusy(true);
    const r = await mutate({ type: "setProviderKey", provider: p.id, key: key.trim() });
    setBusy(false);
    if (r.ok) { setKey(""); onSaved(true); }
  };
  const remove = async () => {
    setBusy(true);
    await mutate({ type: "deleteProviderKey", provider: p.id });
    setBusy(false);
    onSaved(false);
  };
  return (
    <section style={{ ...S.card, borderColor: p.hasKey ? "#70b56a55" : LINE }}>
      <div style={S.providerHead}>
        <div style={S.providerName}>{p.name}</div>
        <span style={{ ...S.providerStatus, color: p.hasKey ? "#70b56a" : MUTE, borderColor: p.hasKey ? "#70b56a55" : LINE }}>{p.hasKey ? "✓ ключ задан" : "нет ключа"}</span>
      </div>
      <div style={S.keyRow}>
        <input style={S.keyInput} type="password" autoComplete="off" placeholder={p.hasKey ? "заменить ключ…" : p.keyHint} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <button style={{ ...S.keySaveBtn, opacity: key.trim() && !busy ? 1 : 0.5 }} disabled={!key.trim() || busy} onClick={save}>{busy ? "…" : "Сохранить"}</button>
        {p.hasKey && <button style={S.keyRemoveBtn} disabled={busy} onClick={remove} title="Удалить ключ">Удалить</button>}
      </div>
      <div style={S.modelChips}>
        <span style={S.modelChipsLabel}>Модели:</span>
        {p.models.map((m: string) => <span key={m} style={{ ...S.modelChip, opacity: p.hasKey ? 1 : 0.4 }}>{m}</span>)}
      </div>
    </section>
  );
}

function StrategyCard({ st, overall, availableModels, onSetModel, onGoModels, onEdit, onImprove, onDelete }: any) {
  const [open, setOpen] = useState(false);
  return (
    <section style={{ ...S.card, borderColor: st.color + "55" }}>
      <button style={S.stratHeadBtn} onClick={() => setOpen(!open)}><span style={{ ...S.dot, background: st.color }} /><span style={S.stratBigName}>{st.name}</span><span style={S.verBadge}>v{st.version}</span><span style={S.stratTag}>{st.tag}</span><span style={S.modelBadge}>{st.model || "модель?"}</span><span style={S.chev}>{open ? "▾" : "▸"}</span></button>
      <div style={S.overallRow}>
        {overall.active === 0 ? <span style={S.overallNone}>нет активных бюджетов — доходность не считается</span> : <>
          <div style={S.overallMetric}><span style={S.overallLbl}>доходность (ср. ROI)</span><span style={{ ...S.overallRoi, color: overall.avgRoi >= 0 ? "#5fd08a" : "#ff6b6b" }}>{overall.avgRoi >= 0 ? "+" : ""}{overall.avgRoi.toFixed(1)}%</span></div>
          <div style={S.overallDiv} />
          <div style={S.overallMetric}><span style={S.overallLbl}>P&L всего</span><span style={{ ...S.overallPnl, color: overall.pnl >= 0 ? "#5fd08a" : "#ff6b6b" }}>{overall.pnl >= 0 ? "+" : ""}{fmtMoney(overall.pnl)}</span></div>
          <div style={S.overallDiv} />
          <div style={S.overallMetric}><span style={S.overallLbl}>в игре</span><span style={S.overallBudget}>{fmtMoney0(overall.budget)} · {overall.active} турн.</span></div>
        </>}
      </div>
      {open && (
        <div style={S.stratDetail}>
          <div style={S.modelPickRow}>
            <span style={S.modelPickLbl}>Модель стратегии:</span>
            <ModelSelect value={st.model || ""} models={availableModels} onChange={onSetModel} onGoModels={onGoModels} />
          </div>
          <div style={S.promptLabel}>Промт стратегии</div>
          <pre style={S.promptBox}>{st.prompt}</pre>
          <div style={S.paramLabel}>Пороги, распознанные движком</div>
          <div style={S.paramList}>{Object.entries(st.params).map(([k, v]) => { const d = describeParam(k, v); return <div key={k} style={S.paramItem}><span style={S.paramItemLabel}>{d.label}</span><span style={S.paramItemValue}>{d.value}</span></div>; })}</div>
          <div style={S.stratEditRow}><button style={S.editBtn} onClick={onEdit}>Редактировать промт</button><button style={S.improveBtn} onClick={onImprove}>↻ Улучшить по данным</button><button style={S.deleteBtn} onClick={onDelete}>Удалить</button></div>
        </div>
      )}
    </section>
  );
}

function BudgetModal({ comp, current, free, onClose, onSave }: any) {
  const [amount, setAmount] = useState(current);
  const maxAvail = free + current;
  const invalid = amount < 0 || amount > maxAvail;
  const quick = [500, 1000, 1500, maxAvail];
  return (
    <Modal title={`Бюджет турнира · ${comp.name}`} onClose={onClose}>
      <div style={S.allocInfo}>
        <div style={S.allocInfoRow}><span>Сейчас на турнире</span><b>{fmtMoney0(current)}</b></div>
        <div style={S.allocInfoRow}><span>Свободно в казне</span><b style={{ color: "#5fd08a" }}>{fmtMoney0(free)}</b></div>
        <div style={S.allocInfoRow}><span>Можно назначить до</span><b style={{ color: "#e8a838" }}>{fmtMoney0(maxAvail)}</b></div>
      </div>
      <label style={S.fieldLabel}>Бюджет турнира ($)</label>
      <div style={S.allocInputRow}><span style={S.allocDollar}>$</span><input style={S.allocInput} type="number" min="0" max={maxAvail} value={amount} onChange={(e) => setAmount(Math.round(+e.target.value))} /></div>
      <div style={S.quickRow}>{quick.map((q, i) => <button key={i} style={S.quickBtn} onClick={() => setAmount(Math.round(q))}>{i === 3 ? "макс" : fmtMoney0(q)}</button>)}</div>
      <div style={S.allocNote}>Общий бюджет турнира. Внутри стратегии делят его в процентах.</div>
      {invalid && <div style={S.warnBox}>Сумма от $0 до {fmtMoney0(maxAvail)}.</div>}
      <div style={S.modalActions}><button style={S.cancelBtn} onClick={onClose}>Отмена</button><button style={{ ...S.saveBtn, opacity: invalid ? 0.4 : 1 }} disabled={invalid} onClick={() => onSave(amount)}>Сохранить</button></div>
    </Modal>
  );
}

function SharesModal({ comp, strats, budget, current, onClose, onSave }: any) {
  const [sh, setSh] = useState(() => Object.fromEntries(strats.map((s: any) => [s.id, current[s.id] || 0])));
  const total = (Object.values(sh) as number[]).reduce((a, b) => a + b, 0);
  const over = total > 100;
  const setPct = (id: string, v: number) => setSh((p: any) => ({ ...p, [id]: Math.max(0, Math.min(100, Math.round(v))) }));
  return (
    <Modal title={`Доли стратегий · ${comp.name}`} onClose={onClose}>
      <div style={S.sharesHead}><span>Бюджет турнира: <b>{fmtMoney0(budget)}</b></span><span style={{ color: over ? "#ff6b6b" : total === 100 ? "#5fd08a" : "#e8a838" }}>распределено {total}% {over ? "(перебор!)" : `· свободно ${100 - total}%`}</span></div>
      {strats.map((s: any) => (
        <div key={s.id} style={S.shareRow}>
          <span style={{ ...S.dot, background: s.color }} />
          <span style={S.shareName}>{s.name}</span>
          <input type="range" min="0" max="100" value={sh[s.id]} onChange={(e) => setPct(s.id, +e.target.value)} style={S.shareRange} />
          <div style={S.sharePctBox}><input type="number" min="0" max="100" value={sh[s.id]} onChange={(e) => setPct(s.id, +e.target.value)} style={S.sharePctInput} /><span style={S.sharePctSign}>%</span></div>
          <span style={S.shareDollar}>{fmtMoney0(Math.floor(budget * sh[s.id] / 100))}</span>
        </div>
      ))}
      <div style={S.allocNote}>Проверенной стратегии — больше %, тестовой — меньше. Сумма не обязана быть 100%.</div>
      {over && <div style={S.warnBox}>Сумма долей превышает 100%. Уменьши.</div>}
      <div style={S.modalActions}><button style={S.cancelBtn} onClick={onClose}>Отмена</button><button style={{ ...S.saveBtn, opacity: over ? 0.4 : 1 }} disabled={over} onClick={() => onSave(Object.fromEntries(Object.entries(sh).filter(([, v]: any) => v > 0)))}>Сохранить</button></div>
    </Modal>
  );
}

function PromptModal({ title, strat, availableModels, onGoModels, onClose, onSave }: any) {
  const [name, setName] = useState(strat?.name || "");
  const [prompt, setPrompt] = useState(strat?.prompt || "");
  const [model, setModel] = useState(strat?.model || (availableModels[0] || ""));
  const [parsed, setParsed] = useState<any>(strat?.params || null);
  const [parsing, setParsing] = useState(false);
  const [gen, setGen] = useState(false);
  const runParse = async () => {
    setParsing(true);
    const res = await mutate({ type: "parseThresholds", prompt });
    setParsed(res.params || { note: "пороги не распознаны" });
    setParsing(false);
  };
  const genName = async () => {
    setGen(true);
    const res = await mutate({ type: "suggestName", prompt });
    if (res.name) setName(res.name);
    setGen(false);
  };
  const canSave = name.trim() && prompt.trim() && parsed;
  return (
    <Modal title={title} onClose={onClose}>
      <label style={S.fieldLabel}>Название</label>
      <div style={S.nameRow}>
        <input style={{ ...S.input, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Playoff Guard" />
        <button style={S.genNameBtn} onClick={genName} disabled={!prompt.trim() || gen} title="Придумать название">{gen ? "…" : "✨ придумать"}</button>
      </div>
      {!prompt.trim() && <div style={S.genHint}>сначала опиши промт — из него сгенерируется название</div>}
      <label style={S.fieldLabel}>Модель, на которой думает стратегия</label>
      <ModelSelect value={model} models={availableModels} onChange={setModel} onGoModels={onGoModels} />
      <label style={S.fieldLabel}>Промт (вход, размер, переоценка, выход, ограничители — словами)</label>
      <textarea style={S.textarea} value={prompt} onChange={(e) => { setPrompt(e.target.value); setParsed(null); }} placeholder={"Входи при edge >= 4% и высокой уверенности.\nОграничители: не более 12% на ставку, стоп -20%."} />
      <button style={S.parseBtn} onClick={runParse} disabled={!prompt.trim() || parsing}>{parsing ? "движок парсит…" : "→ Распознать пороги движком"}</button>
      {parsed && <div style={S.parsedBox}><div style={S.parsedLabel}>Движок распознал пороги:</div><div style={S.paramList}>{Object.entries(parsed).map(([k, v]) => { const d = describeParam(k, v); return <div key={k} style={{ ...S.paramItem, ...(k === "note" ? { borderColor: "#e8a83866" } : {}) }}><span style={S.paramItemLabel}>{d.label}</span><span style={{ ...S.paramItemValue, ...(k === "note" ? { color: "#e8a838" } : {}) }}>{d.value}</span></div>; })}</div></div>}
      <div style={S.modalActions}><button style={S.cancelBtn} onClick={onClose}>Отмена</button><button style={{ ...S.saveBtn, opacity: canSave ? 1 : 0.4 }} disabled={!canSave} onClick={() => onSave({ name, prompt, model, params: parsed, tag: "custom" })}>Сохранить</button></div>
    </Modal>
  );
}

function ImproveModal({ strat, stats, onClose, onAccept }: any) {
  const [stage, setStage] = useState("stats");
  const [proposal, setProposal] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const enough = stats.matches >= 20;

  const request = async () => {
    setLoading(true); setErr(null);
    const res = await mutate({ type: "proposeImprovement", strategyId: strat.id });
    setLoading(false);
    if (res.proposal) { setProposal(res.proposal); setStage("proposal"); }
    else setErr(res.error || "не удалось получить предложение");
  };

  return (
    <Modal title={`Улучшить: ${strat.name} v${strat.version}`} onClose={onClose}>
      {stage === "stats" ? <>
        <div style={S.statsGrid}><Stat label="Матчей" value={stats.matches} /><Stat label="ROI" value={`${stats.roi >= 0 ? "+" : ""}${stats.roi.toFixed(1)}%`} color={stats.roi >= 0 ? "#5fd08a" : "#ff6b6b"} /></div>
        <div style={S.dataProgress}>
          <div style={S.dataProgressTop}><span>данные для улучшения</span><span style={{ color: enough ? "#70b56a" : "#e8a838" }}>{stats.matches} / 20 матчей</span></div>
          <div style={S.dataBar}><div style={{ ...S.dataBarFill, width: `${Math.min(100, (stats.matches / 20) * 100)}%`, background: enough ? "#70b56a" : "#e8a838" }} /></div>
        </div>
        <div style={S.statNote}>{stats.note}</div>
        {enough ? <div style={S.okBox}>✓ Данных достаточно ({stats.matches} матчей). Улучшение опирается на статистику.</div> : <div style={S.warnBox}>✕ Рано улучшать: только {stats.matches} матчей, нужно 20+. Собери ещё {20 - stats.matches}.</div>}
        {err && <div style={S.warnBox}>{err}</div>}
        <div style={S.modalActions}><button style={S.cancelBtn} onClick={onClose}>Закрыть</button><button style={{ ...S.saveBtn, opacity: enough && !loading ? 1 : 0.4 }} disabled={!enough || loading} onClick={request}>{loading ? "ИИ думает…" : "→ Запросить у ИИ"}</button></div>
      </> : <>
        <div style={S.diffLabel}>ИИ предлагает {proposal?.source === "llm" ? "(модель)" : "(эвристика)"}</div>
        <div style={S.diffBox}><div style={S.diffRemoved}>− {proposal?.removed}</div><div style={S.diffAdded}>+ {proposal?.added}</div></div>
        <div style={S.promptLabel}>Новый промт</div>
        <pre style={S.promptBox}>{proposal?.newPrompt}</pre>
        <div style={S.reasonBox}><b>Обоснование:</b> {proposal?.reason}</div>
        <div style={S.newVerNote}>Принятие создаст <b>v{strat.version + 1}</b> (пороги пересчитаны движком).</div>
        <div style={S.modalActions}><button style={S.cancelBtn} onClick={() => setStage("stats")}>← Назад</button><button style={S.saveBtn} onClick={() => onAccept(proposal.newPrompt, proposal.params)}>Принять v{strat.version + 1}</button></div>
      </>}
    </Modal>
  );
}

function Stat({ label, value, color }: any) { return <div style={S.statCell}><div style={S.statLbl}>{label}</div><div style={{ ...S.statVal, color: color || TEXT }}>{value}</div></div>; }
function Modal({ title, children, onClose }: any) { return <div style={S.overlay} onClick={onClose}><div style={S.modal} onClick={(e) => e.stopPropagation()}><div style={S.modalHead}><span style={S.modalTitle}>{title}</span><button style={S.closeX} onClick={onClose}>✕</button></div><div style={S.modalBody}>{children}</div></div></div>; }
function logTypeStyle(type: string) { const m: any = { enter: { color: "#70b56a" }, exit: { color: "#e8a838" }, reassess: { color: "#5b9bd5" }, settle: { color: "#c98bdb" } }; return m[type] || { color: "#8b95a5" }; }

const CSS = `* { box-sizing: border-box; } button { font-family: inherit; } button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #e8a838; outline-offset: 2px; } p { margin: 0; } pre { margin: 0; } textarea, input, select { font-family: inherit; } input[type=range]{ accent-color: #e8a838; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
@keyframes elOddFlash { 0%{opacity:0;transform:scale(.4)} 15%{opacity:1;transform:scale(1)} 60%{opacity:1} 100%{opacity:0;transform:scale(1)} }
.el-odds-flash { animation: elOddFlash 1.6s ease-out forwards; }
@keyframes elSpin { to { transform: rotate(360deg) } }
.el-tab-select { display: none; }
@media (min-width: 760px) {
  .el-match-body { display: grid !important; grid-template-columns: 1fr 280px; gap: 16px; align-items: start; }
  .el-strat-grid { display: grid !important; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
  .el-odds-col { position: sticky; top: 12px; }
  .el-master-detail { display: grid !important; grid-template-columns: 220px 1fr; gap: 12px; align-items: start; }
}
@media (max-width: 759px) {
  .el-odds-col { margin-top: 14px; }
  .el-tab-buttons { display: none !important; }
  .el-tab-select { display: block !important; }
}`;

const S: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', system-ui, sans-serif", background: INK, color: TEXT, minHeight: "100vh", padding: 20, maxWidth: 1120, margin: "0 auto" },
  treasury: { display: "flex", alignItems: "center", gap: 4, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: "10px 12px", marginBottom: 12, flexWrap: "wrap" },
  trBrand: { display: "flex", alignItems: "center", gap: 6, paddingRight: 10, flexShrink: 0 },
  mark: { fontSize: 18, color: "#e8a838" },
  trBrandTxt: { fontSize: 14, fontWeight: 800, letterSpacing: "0.1em" },
  trCell: { flex: 1, textAlign: "center", minWidth: 90 },
  trLbl: { fontSize: 9.5, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" },
  trVal: { fontSize: 17, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginTop: 2 },
  trDiv: { width: 1, height: 30, background: LINE },
  discoverBtn: { background: PANEL2, border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  toastWrap: { position: "fixed", top: 16, right: 16, zIndex: 1000, display: "flex", flexDirection: "column", gap: 8, maxWidth: 380, pointerEvents: "none" },
  toast: { display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 14px", borderRadius: 10, fontSize: 12.5, lineHeight: 1.35, boxShadow: "0 8px 24px rgba(0,0,0,0.35)", border: `1px solid ${LINE}`, background: "#1b212b" },
  toastOk: { borderColor: "#5fd08a66", background: "#16241c" },
  toastErr: { borderColor: "#ff6b6b66", background: "#2a1a1c" },
  toastInfo: { borderColor: "#5b9bd566", background: "#182230" },
  toastIcon: { fontWeight: 800, flexShrink: 0 },
  toastText: { color: "#e6ebf2" },
  liveWrap: { display: "flex", flexDirection: "column", gap: 14 },
  lineupToggle: { background: "transparent", border: "none", color: "#7fb4e8", fontSize: 12, cursor: "pointer", padding: "2px 0", marginBottom: 8, fontWeight: 600 },
  lineupGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  lineupCol: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px" },
  lineupTeam: { fontSize: 13, fontWeight: 700, color: "#e6ebf2", marginBottom: 6 },
  lineupForm: { color: "#e8a838", fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" },
  lineupList: { margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 2 },
  lineupPlayer: { fontSize: 12, color: "#b8c1cf" },
  eventsBox: { display: "flex", flexDirection: "column", gap: 5 },
  eventsLabel: { fontSize: 10.5, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 },
  eventRow: { display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5 },
  eventMin: { minWidth: 30, color: MUTE, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 },
  eventTag: { fontSize: 13, flexShrink: 0 },
  eventText: { color: "#c4cdd9", lineHeight: 1.35 },
  screenSwitch: { display: "flex", gap: 2, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 4, marginBottom: 12, overflowX: "auto" },
  screenBtn: { background: "transparent", border: "none", color: MUTE, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", borderRadius: 7, whiteSpace: "nowrap", flexShrink: 0 },
  screenOn: { background: PANEL2, color: TEXT },
  sportTabs: { display: "flex", gap: 4, marginBottom: 12, borderBottom: `1px solid ${LINE}` },
  sportTab: { background: "transparent", border: "none", borderBottom: "2px solid transparent", color: MUTE, padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  sportTabOn: { color: TEXT, borderBottomColor: "#e8a838" },
  compRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 },
  compCard: { display: "flex", alignItems: "stretch", background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, minWidth: 150, overflow: "hidden" },
  compMain: { textAlign: "left", background: "transparent", border: "none", padding: "8px 10px 8px 12px", cursor: "pointer", flex: 1, color: TEXT },
  compOn: { borderColor: "#e8a838", background: PANEL2 },
  compName: { fontSize: 13, fontWeight: 700, color: TEXT },
  compBudget: { fontSize: 14, color: TEXT, fontFamily: "'JetBrains Mono', monospace", marginTop: 3, fontWeight: 800 },
  compBudgetLbl: { fontSize: 10, color: MUTE, fontWeight: 500, letterSpacing: "0.03em" },
  compDelta: { fontSize: 11, fontFamily: "'JetBrains Mono', monospace", marginTop: 2 },
  compRoi: { fontSize: 10, opacity: 0.85, color: MUTE },
  compFlat: { fontSize: 10, color: MUTE, marginTop: 2 },
  compUnalloc: { fontSize: 10, color: "#e8a838", marginTop: 3, fontStyle: "italic" },
  allocIcon: { background: "transparent", border: "none", borderLeft: `1px solid ${LINE}`, color: "#e8a838", fontSize: 17, fontWeight: 800, cursor: "pointer", padding: "0 12px" },
  stratStripHead: { display: "flex", alignItems: "center", marginBottom: 8 },
  stratStripTitle: { fontSize: 12, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 },
  shareBtn: { marginLeft: "auto", background: "transparent", border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 },
  bankStrip: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 },
  noStrat: { fontSize: 12.5, color: "#e8a838", background: "#2e2a1a", borderRadius: 8, padding: "10px 14px" },
  bankCell: { display: "flex", alignItems: "center", gap: 10, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 12px" },
  dot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  bankInfo: { display: "flex", flexDirection: "column" },
  bankNm: { fontSize: 13, fontWeight: 600 },
  bankBudget: { fontSize: 10.5, color: MUTE, fontFamily: "'JetBrains Mono', monospace" },
  bankNums: { marginLeft: "auto", textAlign: "right" },
  bankEq: { fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", display: "block" },
  bankD: { fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
  main: { display: "flex", flexDirection: "column", gap: 12 },
  empty: { color: MUTE, padding: 30, textAlign: "center" },
  errBox: { background: "#2e1f22", border: "1px solid #ff6b6b55", borderRadius: 12, padding: "16px 18px", margin: "10px 0", color: "#ffd7d7" },
  errTitle: { fontSize: 14, fontWeight: 700, color: "#ff8f8f", marginBottom: 6 },
  errMsg: { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "#e8b3b3", wordBreak: "break-word", marginBottom: 12, lineHeight: 1.5 },
  errActions: { display: "flex", gap: 8, flexWrap: "wrap" },
  errBtn: { background: "#3a2a2c", border: "1px solid #ff6b6b55", color: "#ffd7d7", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
  card: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, padding: 14 },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  matchup: { fontSize: 17, fontWeight: 700 },
  score: { fontFamily: "'JetBrains Mono', monospace", color: "#e8a838", fontWeight: 800 },
  vs: { color: MUTE, fontWeight: 400 },
  timing: { fontSize: 12, color: MUTE, marginTop: 2 },
  stateBadge: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", padding: "5px 10px", borderRadius: 20, whiteSpace: "nowrap" },
  pulse: { width: 6, height: 6, borderRadius: "50%", background: "#ff6b6b", animation: "pulse 1.3s infinite" },
  liveDot: { display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "#5fd08a", boxShadow: "0 0 5px #5fd08a", marginLeft: 6, verticalAlign: "middle", animation: "pulse 1.3s infinite" },
  tabBar: { display: "flex", gap: 2, background: INK, borderRadius: 8, padding: 3, marginBottom: 12, flexWrap: "wrap" },
  tabBtn: { flex: 1, background: "transparent", border: "none", color: MUTE, padding: "7px 10px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", borderRadius: 6, minWidth: 90 },
  tabBtnOn: { background: PANEL2, color: TEXT },
  tabBody: { minHeight: 60 },
  matchBody: { display: "block" },
  matchLeft: { minWidth: 0 },
  oddsCol: { background: INK, border: `1px solid ${LINE}`, borderRadius: 10, padding: 10, alignSelf: "start" },
  oddsColHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  oddsColLabel: { fontSize: 11, color: "#e8a838", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 },
  oddsColSub: { fontSize: 10, color: MUTE, marginTop: 2, marginBottom: 8 },
  oddsRefresh: { background: PANEL2, border: `1px solid ${LINE}`, color: "#e8a838", borderRadius: 6, width: 28, height: 28, fontSize: 15, cursor: "pointer", flexShrink: 0 },
  oddsRefreshWrap: { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 },
  oddsFlashSlot: { width: 10, display: "inline-flex", justifyContent: "center", alignItems: "center" },
  oddsFlash: { color: "#5fd08a", fontSize: 10, lineHeight: 1 },
  oddsFlashErr: { color: "#ff6b6b", fontSize: 10, lineHeight: 1 },
  oddsUpdated: { fontSize: 9.5, color: MUTE, marginBottom: 8, fontFamily: "'JetBrains Mono', monospace" },
  oddsScroll: { maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 2 },
  oddsRow: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "7px 9px" },
  oddsTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 },
  oddsLabel: { fontSize: 12, fontWeight: 600, lineHeight: 1.3 },
  oddsVal: { fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 14, color: "#e8a838", flexShrink: 0 },
  oddsBot: { display: "flex", justifyContent: "flex-start", alignItems: "baseline", marginTop: 4, gap: 6 },
  oddsAi: { fontSize: 10.5, color: MUTE, fontFamily: "'JetBrains Mono', monospace" },
  oddsLiq: { fontSize: 10, color: "#6b7686", fontFamily: "'JetBrains Mono', monospace", marginLeft: "auto", flexShrink: 0 },
  oddsEdge: { fontSize: 11.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  oddsMove: { fontSize: 10, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" },
  finishCell: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 10px" },
  finishTop: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  finishNm: { fontSize: 12.5, fontWeight: 600 },
  finishVal: { fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" },
  finishRoi: { fontSize: 11, fontFamily: "'JetBrains Mono', monospace", marginTop: 1 },
  betEntered: { fontSize: 10, color: MUTE, marginTop: 4, fontFamily: "'JetBrains Mono', monospace" },
  reassessTop: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" },
  reassessHint: { fontSize: 11.5, color: MUTE, lineHeight: 1.4, flex: 1, minWidth: 180 },
  reassessBtn: { background: "transparent", border: `1px solid #5b9bd566`, color: "#7fb4e8", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" },
  reassessList: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 },
  reassessItem: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 12px" },
  reassessItemHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 5 },
  reassessMin: { fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#e8a838", fontWeight: 700 },
  reassessAt: { fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace", color: MUTE },
  reassessConf: { fontSize: 10.5, color: MUTE },
  reassessText: { fontSize: 13, lineHeight: 1.55, color: "#d3d8e0" },
  assessTop: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 },
  analysisFlow: { display: "flex", flexDirection: "column", gap: 14, maxHeight: 520, overflowY: "auto", paddingRight: 4 },
  analysisStage: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 },
  analysisStageLabel: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, marginBottom: 10, color: TEXT },
  stageNum: { width: 20, height: 20, borderRadius: "50%", background: LINE, color: TEXT, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0 },
  stagePriority: { fontSize: 10, color: "#e8a838", background: "#2e2a1a", borderRadius: 20, padding: "2px 8px", marginLeft: "auto", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" },
  analysisPending: { fontSize: 12, color: MUTE, fontStyle: "italic", padding: "10px 12px", background: PANEL2, borderRadius: 10, border: `1px dashed ${LINE}` },
  analysisEmpty: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, textAlign: "center", padding: "34px 18px", background: PANEL2, border: `1px dashed ${LINE}`, borderRadius: 12 },
  analysisEmptyText: { fontSize: 13, color: "#c3c9d3", lineHeight: 1.5, maxWidth: 380 },
  analysisEmptyMuted: { fontSize: 12, color: MUTE, fontStyle: "italic" },
  analysisRunBtn: { background: "#1e2836", border: `1px solid #5b9bd566`, color: "#7fb4e8", borderRadius: 10, padding: "10px 22px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 },
  analysisRerunRow: { display: "flex", justifyContent: "flex-end" },
  analysisRerunBtn: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 },
  runningRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#7fb4e8", fontWeight: 600, padding: "10px 12px", background: "#1a2230", border: `1px solid #5b9bd533`, borderRadius: 10 },
  spinner: { display: "inline-block", width: 12, height: 12, border: "2px solid #5b9bd555", borderTopColor: "#7fb4e8", borderRadius: "50%", animation: "elSpin 0.7s linear infinite", flexShrink: 0 },
  decisionList: { display: "flex", flexDirection: "column", gap: 8 },
  decisionItem: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px" },
  decisionHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 5 },
  decisionName: { fontSize: 13, fontWeight: 700 },
  decisionVerdict: { marginLeft: "auto", fontSize: 10.5, color: "#7fb4e8", background: "#1e2836", borderRadius: 20, padding: "2px 10px", fontFamily: "'JetBrains Mono', monospace" },
  decisionText: { fontSize: 12.5, color: "#d3d8e0", lineHeight: 1.55, marginTop: 8 },
  decisionBets: { display: "flex", flexDirection: "column", gap: 4, marginTop: 8 },
  decisionBetRow: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
  decisionBetMkt: { fontSize: 12, fontWeight: 600, color: "#e6e9ef" },
  decisionBetMeta: { fontSize: 11, color: MUTE, fontFamily: "'JetBrains Mono', monospace" },
  decisionBetStatus: { marginLeft: "auto", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" },
  pastWrap: { marginTop: 2 },
  pastToggle: { background: "transparent", border: "none", color: MUTE, fontSize: 11.5, cursor: "pointer", padding: "2px 0", fontWeight: 600 },
  pastList: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 },
  pastItem: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, overflow: "hidden" },
  pastItemHead: { display: "flex", alignItems: "center", gap: 8, width: "100%", background: "transparent", border: "none", cursor: "pointer", padding: "7px 10px", textAlign: "left", flexWrap: "wrap" },
  pastStage: { fontSize: 11, fontWeight: 700, color: "#7fb4e8", textTransform: "uppercase", letterSpacing: "0.04em" },
  pastAt: { fontSize: 10.5, color: MUTE, fontFamily: "'JetBrains Mono', monospace" },
  pastConf: { fontSize: 10.5, color: MUTE },
  pastChev: { marginLeft: "auto", fontSize: 10.5, color: "#6b7686" },
  pastBody: { padding: "0 10px 10px" },
  pastText: { fontSize: 12.5, lineHeight: 1.55, color: "#c7cdd6" },
  finishTiming: { fontSize: 11, color: "#6b7686", marginTop: 3, fontFamily: "'JetBrains Mono', monospace" },
  confChip: { fontSize: 11, color: MUTE },
  fullToggle: { marginLeft: "auto", background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 20, padding: "3px 10px", fontSize: 11, cursor: "pointer" },
  assessText: { fontSize: 13.5, lineHeight: 1.55, color: "#d3d8e0" },
  verdict: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${LINE}`, fontSize: 13, fontWeight: 600, color: TEXT },
  stratListGrid: { display: "flex", flexDirection: "column", gap: 10 },
  stratBlock: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 },
  stratBlockHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  stratName: { fontSize: 13.5, fontWeight: 700 },
  stratBudgetChip: { marginLeft: "auto", fontSize: 10.5, color: "#e8a838", fontFamily: "'JetBrains Mono', monospace", background: "#2e2a1a", borderRadius: 20, padding: "2px 10px" },
  stratReassessBtn: { flex: "0 0 auto", width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid #5b9bd566`, color: "#7fb4e8", borderRadius: 7, fontSize: 13, cursor: "pointer", lineHeight: 1, padding: 0 },
  noBets: { fontSize: 12, color: MUTE, fontStyle: "italic" },
  betList: { display: "flex", flexDirection: "column", gap: 6 },
  betRow: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 10px" },
  betMain: { display: "flex", alignItems: "baseline", gap: 8 },
  betMarket: { fontSize: 13, fontWeight: 600 },
  betOdds: { fontSize: 12, color: MUTE, fontFamily: "'JetBrains Mono', monospace" },
  betMeta: { display: "flex", alignItems: "center", gap: 10, marginTop: 5, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 },
  betEdge: { fontWeight: 700 },
  betStake: { color: TEXT, fontWeight: 700 },
  betLive: { fontWeight: 700 },
  betProposed: { color: "#8b95a5", fontStyle: "italic", fontFamily: "'Inter', sans-serif" },
  betTotal: { fontSize: 11, color: MUTE, fontFamily: "'JetBrains Mono', monospace", marginTop: 4, paddingTop: 6, borderTop: `1px solid ${LINE}` },
  logStratBar: { display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" },
  logStratBtn: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 20, padding: "4px 12px", fontSize: 12, cursor: "pointer" },
  logList: { display: "flex", flexDirection: "column", gap: 7 },
  noPos: { fontSize: 12, color: MUTE, fontStyle: "italic", padding: "8px 0" },
  logEntry: { display: "grid", gridTemplateColumns: "44px 46px 68px 1fr", gap: 8, fontSize: 12, alignItems: "baseline" },
  logAt: { fontFamily: "'JetBrains Mono', monospace", color: "#e8a838", fontSize: 11, fontWeight: 600 },
  logMin: { fontFamily: "'JetBrains Mono', monospace", color: MUTE, fontSize: 11 },
  logType: { fontSize: 10, fontWeight: 700, textTransform: "uppercase" },
  logText: { color: "#c3c9d3", lineHeight: 1.4 },
  analysisCard: { background: PANEL, border: `1px solid #5b9bd555`, borderRadius: 14, padding: 14 },
  analysisCardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" },
  analysisTitle: { fontSize: 15, fontWeight: 700, color: "#7fb4e8" },
  analysisModelPick: { display: "flex", alignItems: "center", gap: 8 },
  analysisModelLbl: { fontSize: 12, color: MUTE },
  masterDetail: { display: "block" },
  mdList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 },
  mdItem: { textAlign: "left", background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 12px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 2 },
  mdItemOn: { borderColor: "#5b9bd5", background: "#1a2430" },
  mdItemName: { fontSize: 13, fontWeight: 600, color: TEXT },
  mdItemTag: { fontSize: 10.5 },
  mdContent: { minWidth: 0 },
  mdHint: { fontSize: 11.5, color: "#c3c9d3", background: PANEL2, borderRadius: 8, padding: "8px 12px", lineHeight: 1.5, marginBottom: 8 },
  mdTextarea: { width: "100%", minHeight: 200, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, color: TEXT, padding: "10px 12px", fontSize: 13, lineHeight: 1.55, resize: "vertical", fontFamily: "'JetBrains Mono', monospace" },
  stratIntro: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, padding: 14 },
  stratIntroTop: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 },
  stratIntroTitle: { fontSize: 15, fontWeight: 700 },
  stratIntroSub: { fontSize: 11.5, color: MUTE, marginTop: 3 },
  addBtn: { marginLeft: "auto", background: "#e8a838", border: "none", color: "#12161d", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  howto: { fontSize: 12, lineHeight: 1.55, color: "#c3c9d3", background: PANEL2, borderRadius: 8, padding: "9px 12px" },
  stratHeadBtn: { width: "100%", background: "transparent", border: "none", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: 0 },
  overallRow: { display: "flex", alignItems: "center", gap: 12, marginTop: 12, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 12px", flexWrap: "wrap" },
  overallNone: { fontSize: 11.5, color: MUTE, fontStyle: "italic" },
  overallMetric: { display: "flex", flexDirection: "column", gap: 2 },
  overallLbl: { fontSize: 9.5, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" },
  overallRoi: { fontSize: 17, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" },
  overallPnl: { fontSize: 15, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  overallBudget: { fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: "#c3c9d3" },
  overallDiv: { width: 1, height: 28, background: LINE },
  stratBigName: { fontSize: 16, fontWeight: 700, color: TEXT },
  verBadge: { fontSize: 10, background: LINE, color: TEXT, borderRadius: 20, padding: "1px 7px", fontFamily: "'JetBrains Mono', monospace" },
  stratTag: { fontSize: 10, color: MUTE },
  chev: { marginLeft: "auto", color: MUTE },
  stratDetail: { marginTop: 12, paddingTop: 12, borderTop: `1px solid ${LINE}` },
  promptLabel: { fontSize: 10, color: "#e8a838", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, marginBottom: 6 },
  promptBox: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: 12, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12, lineHeight: 1.6, color: "#d3d8e0", whiteSpace: "pre-wrap", marginBottom: 14 },
  paramLabel: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 8 },
  paramList: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 },
  paramItem: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 12px" },
  paramItemLabel: { fontSize: 12.5, color: "#c3c9d3" },
  paramItemValue: { fontSize: 12.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: TEXT, textAlign: "right" },
  nameRow: { display: "flex", gap: 6, alignItems: "center" },
  genNameBtn: { background: "transparent", border: `1px solid #c98bdb66`, color: "#c98bdb", borderRadius: 8, padding: "9px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 },
  genHint: { fontSize: 11, color: MUTE, fontStyle: "italic", marginTop: 4 },
  saveIndicator: { fontSize: 11, marginTop: 6, fontFamily: "'JetBrains Mono', monospace", textAlign: "right" },
  stratEditRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  editBtn: { background: "transparent", border: `1px solid ${LINE}`, color: TEXT, borderRadius: 8, padding: "7px 14px", fontSize: 12.5, cursor: "pointer" },
  improveBtn: { background: "transparent", border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "7px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600 },
  deleteBtn: { background: "transparent", border: `1px solid #ff6b6b55`, color: "#ff6b6b", borderRadius: 8, padding: "7px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600, marginLeft: "auto" },
  keyRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" },
  keyInput: { flex: 1, minWidth: 200, background: INK, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 8, padding: "9px 12px", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" },
  keySaveBtn: { background: "#e8a838", border: "none", color: "#12161d", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  keyRemoveBtn: { background: "transparent", border: `1px solid #ff6b6b55`, color: "#ff6b6b", borderRadius: 8, padding: "9px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600 },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 20, overflowY: "auto", zIndex: 100 },
  modal: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, width: "100%", maxWidth: 560, marginTop: 40 },
  modalHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: `1px solid ${LINE}` },
  modalTitle: { fontSize: 15, fontWeight: 700 },
  closeX: { background: "transparent", border: "none", color: MUTE, fontSize: 16, cursor: "pointer" },
  modalBody: { padding: 16 },
  fieldLabel: { display: "block", fontSize: 11.5, color: MUTE, marginBottom: 6, marginTop: 12 },
  input: { width: "100%", background: INK, border: `1px solid ${LINE}`, borderRadius: 8, color: TEXT, padding: "9px 12px", fontSize: 13 },
  textarea: { width: "100%", minHeight: 120, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, color: TEXT, padding: "10px 12px", fontSize: 13, lineHeight: 1.55, resize: "vertical" },
  parseBtn: { marginTop: 10, width: "100%", background: PANEL2, border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "9px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  parsedBox: { marginTop: 12, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: 12 },
  parsedLabel: { fontSize: 11, color: "#70b56a", marginBottom: 8, fontWeight: 600 },
  modalActions: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 },
  cancelBtn: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 8, padding: "9px 16px", fontSize: 13, cursor: "pointer" },
  saveBtn: { background: "#e8a838", border: "none", color: "#12161d", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  allocInfo: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 6 },
  allocInfoRow: { display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#c3c9d3", padding: "3px 0", fontFamily: "'JetBrains Mono', monospace" },
  allocInputRow: { display: "flex", alignItems: "center", background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "4px 12px", marginTop: 6 },
  allocDollar: { color: MUTE, fontSize: 18, fontFamily: "'JetBrains Mono', monospace" },
  allocInput: { flex: 1, background: "transparent", border: "none", color: TEXT, padding: "8px 8px", fontSize: 20, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, outline: "none" },
  quickRow: { display: "flex", gap: 6, marginTop: 8 },
  quickBtn: { flex: 1, background: PANEL2, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 6, padding: "6px", fontSize: 12, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" },
  allocNote: { fontSize: 11.5, color: MUTE, lineHeight: 1.5, marginTop: 10 },
  sharesHead: { display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#c3c9d3", marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" },
  shareRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  shareName: { fontSize: 13, fontWeight: 600, width: 90, flexShrink: 0 },
  shareRange: { flex: 1 },
  sharePctBox: { display: "flex", alignItems: "center", background: INK, border: `1px solid ${LINE}`, borderRadius: 6, padding: "2px 6px", width: 62 },
  sharePctInput: { width: 34, background: "transparent", border: "none", color: TEXT, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", textAlign: "right", outline: "none" },
  sharePctSign: { fontSize: 12, color: MUTE },
  shareDollar: { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "#e8a838", width: 56, textAlign: "right", flexShrink: 0 },
  statsGrid: { display: "flex", gap: 8, marginTop: 6 },
  statCell: { flex: 1, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", textAlign: "center" },
  statLbl: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em" },
  statVal: { fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginTop: 4 },
  statNote: { fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.55, marginTop: 12, background: PANEL2, borderRadius: 8, padding: "10px 12px" },
  warnBox: { fontSize: 12, color: "#e8a838", background: "#2e2a1a", borderRadius: 8, padding: "10px 12px", marginTop: 10, lineHeight: 1.5 },
  okBox: { fontSize: 12, color: "#70b56a", background: "#1c2620", borderRadius: 8, padding: "10px 12px", marginTop: 10, lineHeight: 1.5 },
  diffLabel: { fontSize: 11, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 8 },
  diffBox: { background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: 12, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.6 },
  diffRemoved: { color: "#ff6b6b", background: "#2e1f22", borderRadius: 4, padding: "2px 6px", marginBottom: 4 },
  diffAdded: { color: "#5fd08a", background: "#1c2620", borderRadius: 4, padding: "2px 6px" },
  reasonBox: { fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.55, marginTop: 12, background: PANEL2, borderRadius: 8, padding: "10px 12px" },
  newVerNote: { fontSize: 12, color: MUTE, marginTop: 10 },
  footer: { marginTop: 22, paddingTop: 14, borderTop: `1px solid ${LINE}`, fontSize: 12, color: MUTE, lineHeight: 1.5 },
  feedHead: { marginBottom: 4 },
  feedTitle: { fontSize: 17, fontWeight: 700 },
  feedSub: { fontSize: 12, color: MUTE, marginTop: 3 },
  feedFilters: { display: "flex", gap: 6, flexWrap: "wrap" },
  feedFilterBtn: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 20, padding: "5px 12px", fontSize: 12.5, cursor: "pointer" },
  feedFilterOn: { background: PANEL2, color: TEXT, borderColor: "#e8a83855" },
  feedList: { display: "flex", flexDirection: "column", gap: 6 },
  feedItem: { display: "flex", alignItems: "flex-start", gap: 10, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 12px" },
  feedTime: { fontSize: 11, color: MUTE, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, width: 48, paddingTop: 3, display: "flex", flexDirection: "column", lineHeight: 1.35 },
  feedClock: { color: "#e8a838", fontWeight: 600 },
  feedIcon: { width: 26, height: 26, borderRadius: 7, border: "1px solid", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 },
  feedBody: { flex: 1, minWidth: 0 },
  feedItemTop: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" },
  feedStrat: { fontSize: 12, fontWeight: 700 },
  feedMatch: { fontSize: 11, color: MUTE },
  feedScore: { fontSize: 12, fontWeight: 700, color: "#e8a838", fontFamily: "'JetBrains Mono', monospace" },
  feedText: { fontSize: 13, color: "#d3d8e0", marginTop: 2, lineHeight: 1.4 },
  feedPnl: { fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, paddingTop: 2 },
  metricExplain: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 8 },
  metricExplainItem: { fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.5 },
  metricHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 },
  metricName: { fontSize: 15, fontWeight: 700 },
  metricSamples: { fontSize: 11.5, color: MUTE, marginLeft: "auto", fontFamily: "'JetBrains Mono', monospace" },
  statGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 10 },
  metricNums: { display: "flex", gap: 8, marginBottom: 14 },
  metricNumCell: { flex: 1, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", textAlign: "center" },
  metricNumLbl: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" },
  metricNumVal: { fontSize: 20, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginTop: 3 },
  metricVerdict: { fontSize: 13, fontWeight: 700, marginTop: 6 },
  calibLabel: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 8 },
  calibRows: { display: "flex", flexDirection: "column", gap: 8 },
  calibRow: { display: "flex", alignItems: "center", gap: 10 },
  calibBucket: { fontSize: 11, color: MUTE, fontFamily: "'JetBrains Mono', monospace", width: 56, flexShrink: 0 },
  calibBar: { flex: 1, height: 16, background: INK, borderRadius: 4, position: "relative", border: `1px solid ${LINE}` },
  calibBarPred: { position: "absolute", left: 0, top: 0, bottom: 0, background: "#5b9bd533", borderRight: "2px solid #5b9bd5", borderRadius: "4px 0 0 4px" },
  calibDot: { position: "absolute", top: "50%", width: 8, height: 8, borderRadius: "50%", background: "#e8a838", transform: "translate(-50%, -50%)", boxShadow: "0 0 0 2px #12161d" },
  calibDiff: { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, width: 32, textAlign: "right", flexShrink: 0 },
  metricWarn: { fontSize: 11.5, color: "#e8a838", background: "#2e2a1a", borderRadius: 8, padding: "8px 12px", marginTop: 12, lineHeight: 1.5 },
  phaseBlock: { marginTop: 16, paddingTop: 14, borderTop: `1px solid ${LINE}` },
  phaseBlockLabel: { fontSize: 10.5, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700, marginBottom: 10 },
  phaseHint: { textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "#6b7686", marginLeft: 6, fontSize: 10.5 },
  phaseRows: { display: "flex", flexDirection: "column", gap: 6 },
  phaseRow: { display: "flex", alignItems: "center", gap: 10, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 12px" },
  phaseName: { fontSize: 12.5, fontWeight: 600, flex: 1 },
  phaseBets: { fontSize: 11.5, color: MUTE, fontFamily: "'JetBrains Mono', monospace" },
  phasePnl: { fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", width: 80, textAlign: "right" },
  mgmtNeutral: { fontSize: 12, color: MUTE, fontStyle: "italic", background: PANEL2, borderRadius: 8, padding: "10px 12px" },
  mgmtRow: { display: "flex", alignItems: "center", gap: 8, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: 12, flexWrap: "wrap" },
  mgmtCell: { flex: 1, textAlign: "center", minWidth: 80 },
  mgmtLbl: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em" },
  mgmtVal: { fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", marginTop: 3 },
  mgmtDelta: { fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginTop: 3 },
  mgmtVs: { fontSize: 12, color: MUTE, flexShrink: 0 },
  mgmtVerdict: { fontSize: 12.5, lineHeight: 1.5, marginTop: 10, fontWeight: 600 },
  clvRows: { display: "flex", flexDirection: "column", gap: 8 },
  clvRow: { display: "flex", alignItems: "center", gap: 10 },
  clvName: { fontSize: 12, color: "#c3c9d3", width: 150, flexShrink: 0 },
  clvBarWrap: { flex: 1, height: 16, background: INK, borderRadius: 4, position: "relative", border: `1px solid ${LINE}`, overflow: "hidden" },
  clvBarZero: { position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "#4a5568" },
  clvBarFill: { position: "absolute", top: 2, bottom: 2, borderRadius: 2 },
  clvVal: { fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", width: 48, textAlign: "right", flexShrink: 0 },
  equityWrap: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px" },
  equitySvg: { width: "100%", height: 44, display: "block" },
  equityMeta: { display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11.5, fontFamily: "'JetBrains Mono', monospace" },
  equityStart: { color: MUTE },
  equityEnd: { fontWeight: 700 },
  settleHead: { fontSize: 13, color: "#d3d8e0", marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${LINE}` },
  settleStrat: { marginBottom: 12 },
  settleStratHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  settleBet: { display: "flex", alignItems: "center", gap: 10, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 12px", marginBottom: 4, flexWrap: "wrap" },
  settleAt: { fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#e8a838", flexShrink: 0 },
  settleMarket: { fontSize: 13, fontWeight: 600, flex: 1, minWidth: 100 },
  settleStake: { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: MUTE },
  settleResult: { fontSize: 12, fontWeight: 700 },
  settlePayout: { fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  pfHeader: { marginBottom: 4 },
  pfTitle: { fontSize: 17, fontWeight: 700 },
  pfSub: { fontSize: 12, color: MUTE, marginTop: 3 },
  matchTabs: { display: "flex", gap: 6, marginBottom: 12 },
  matchTab: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 8, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  matchTabOn: { background: PANEL2, color: TEXT, borderColor: "#e8a83666" },
  pfViewTabs: { display: "flex", gap: 6, margin: "10px 0" },
  pfViewTab: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 8, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  pfViewTabOn: { background: PANEL2, color: TEXT, borderColor: "#e8a83866" },
  pfAgg: { display: "flex", alignItems: "center", background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: "12px 8px", flexWrap: "wrap", gap: 8 },
  pfAggCell: { flex: 1, textAlign: "center", minWidth: 110 },
  pfAggLbl: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" },
  pfAggVal: { fontSize: 20, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginTop: 3 },
  pfAggDiv: { width: 1, height: 34, background: LINE },
  pfEmpty: { color: MUTE, padding: 40, textAlign: "center", fontSize: 13, lineHeight: 1.6 },
  pfEmptyBtn: { background: "transparent", border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, cursor: "pointer", marginLeft: 8 },
  pfGroupToggle: { display: "flex", alignItems: "center", gap: 6 },
  pfGroupLbl: { fontSize: 12, color: MUTE, marginRight: 4 },
  pfGroupBtn: { background: "transparent", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 20, padding: "5px 14px", fontSize: 12.5, cursor: "pointer" },
  pfGroupOn: { background: PANEL2, color: TEXT, borderColor: "#e8a83855" },
  pfGroup: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14 },
  pfGroupHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${LINE}` },
  pfGroupName: { fontSize: 14, fontWeight: 700 },
  pfGroupStake: { fontSize: 11.5, color: MUTE, fontFamily: "'JetBrains Mono', monospace", marginLeft: "auto" },
  pfGroupLive: { fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  pfPosList: { display: "flex", flexDirection: "column", gap: 6 },
  pfPos: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 12px" },
  pfPosLeft: { minWidth: 0, flex: 1 },
  pfPosMarket: { fontSize: 13.5, fontWeight: 600 },
  pfPosMeta: { fontSize: 11, color: MUTE, marginTop: 2 },
  pfPosEntered: { color: "#6b7686" },
  pfPosRight: { textAlign: "right", flexShrink: 0 },
  pfPosStake: { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "#c3c9d3" },
  pfPosLiveWrap: { display: "flex", gap: 8, alignItems: "baseline", justifyContent: "flex-end", marginTop: 2 },
  pfPosNow: { fontSize: 11, color: "#e8a838", fontFamily: "'JetBrains Mono', monospace" },
  pfPosLive: { fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  tabSelect: { width: "100%", background: PANEL2, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 8, padding: "9px 12px", fontSize: 13, fontWeight: 600, marginBottom: 12 },
  modelBadge: { fontSize: 10, color: "#7fb4e8", background: "#1e2836", border: "1px solid #5b9bd544", borderRadius: 20, padding: "2px 9px", fontFamily: "'JetBrains Mono', monospace" },
  modelSelect: { background: INK, border: `1px solid ${LINE}`, color: TEXT, borderRadius: 8, padding: "7px 10px", fontSize: 12.5, cursor: "pointer", maxWidth: "100%" },
  modelSelectEmpty: { background: "transparent", border: `1px solid #e8a83866`, color: "#e8a838", borderRadius: 8, padding: "7px 12px", fontSize: 12, cursor: "pointer" },
  modelPickRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  modelPickLbl: { fontSize: 12, color: MUTE, fontWeight: 600 },
  modelsIntro: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, padding: 16 },
  modelsTitle: { fontSize: 16, fontWeight: 700 },
  modelsSub: { fontSize: 12.5, color: "#c3c9d3", lineHeight: 1.55, marginTop: 6 },
  settingsSectionLbl: { fontSize: 11, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginTop: 8 },
  balHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  balTitle: { fontSize: 15, fontWeight: 700 },
  balSub: { fontSize: 12, color: MUTE, lineHeight: 1.5, marginTop: 4, maxWidth: 460 },
  balNow: { fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: "#5fd08a" },
  balRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 12 },
  balDollar: { fontSize: 15, color: MUTE, fontWeight: 700 },
  balInput: { flex: 1, maxWidth: 200, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 12px", color: TEXT, fontSize: 14, fontFamily: "'JetBrains Mono', monospace" },
  balErr: { fontSize: 11.5, color: "#ff6b6b", marginTop: 8 },
  cronHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  cronTitle: { fontSize: 15, fontWeight: 700 },
  cronBadge: { fontSize: 10.5, borderRadius: 20, padding: "2px 10px", fontWeight: 700, border: "1px solid" },
  cronOn: { color: "#5fd08a", borderColor: "#5fd08a55", background: "#16241c" },
  cronOff: { color: MUTE, borderColor: LINE, background: PANEL2 },
  cronPlan: { fontSize: 12, color: "#c3c9d3", lineHeight: 1.55, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px" },
  cronList: { display: "flex", flexDirection: "column", gap: 2, marginTop: 10, maxHeight: 320, overflowY: "auto" },
  cronRow: { display: "flex", alignItems: "baseline", gap: 8, fontSize: 11.5, padding: "4px 0", borderBottom: `1px solid ${LINE}` },
  cronDot: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0, alignSelf: "center" },
  cronAt: { color: MUTE, fontFamily: "'JetBrains Mono', monospace", minWidth: 118, flexShrink: 0 },
  cronKind: { color: "#e8a838", minWidth: 56, flexShrink: 0, fontWeight: 600 },
  cronSummary: { color: "#c4cdd9", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
  providerHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  providerName: { fontSize: 15, fontWeight: 700 },
  providerStatus: { fontSize: 11, border: "1px solid", borderRadius: 20, padding: "2px 10px", fontWeight: 600 },
  modelChips: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" },
  modelChipsLabel: { fontSize: 11, color: MUTE },
  modelChip: { fontSize: 11.5, background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 20, padding: "3px 10px", color: "#c3c9d3", fontFamily: "'JetBrains Mono', monospace" },
  modelsNote: { fontSize: 11.5, color: MUTE, lineHeight: 1.5, background: "#2e2a1a", borderRadius: 8, padding: "10px 12px", borderLeft: "2px solid #e8a838" },
  dataProgress: { marginTop: 12, background: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px" },
  dataProgressTop: { display: "flex", justifyContent: "space-between", fontSize: 11.5, color: MUTE, marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" },
  dataBar: { height: 6, background: PANEL2, borderRadius: 3, overflow: "hidden" },
  dataBarFill: { height: "100%", borderRadius: 3 },
};
