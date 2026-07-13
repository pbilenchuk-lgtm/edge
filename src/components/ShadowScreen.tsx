"use client";

// «Бюджет (shadow)» — observe-only view of the shadow capital allocator. Answers ONE
// question at a glance — «would a single limited bank have been squeezed?» — then lets you
// drill down: where the money sits, where concentration builds, the ledger of every
// allowed/blocked/trimmed decision, and the settings. It never touches real money.

import { useMemo, useState } from "react";
import type { ShadowView } from "@/lib/view";

// Design tokens — mirror the app shell (EdgeLab `S`) so the tab reads as native.
const INK = "#12161d", PANEL = "#1a2029", PANEL2 = "#212936", LINE = "#2c3543", TEXT = "#e6e9ef", MUTE = "#8b95a5";
const BLUE = "#5b9bd5", GREEN = "#5fd08a", AMBER = "#e8a838", RED = "#ff6b6b", PURPLE = "#c98bdb", HELD = "#3b4658";
const MONO = "'JetBrains Mono', monospace";

const usd = (n: number) => `$${Math.round(n).toLocaleString("ru-RU")}`;
const usd2 = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("ru-RU", { minimumFractionDigits: n % 1 ? 2 : 0 })}`;
const pctOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

const REASON_RU: Record<string, string> = {
  insufficient_free: "нет свободных средств", cash_reserve: "неснижаемый остаток", live_buffer: "буфер под live",
  cap_match: "потолок матча", cap_category: "потолок категории", cap_strategy: "потолок стратегии",
};
const VERDICT = {
  allowed: { ru: "принят", color: GREEN, bg: "#16241c" },
  blocked: { ru: "заблокирован", color: RED, bg: "#2a1a1c" },
  trimmed: { ru: "урезан", color: AMBER, bg: "#2a2413" },
} as const;

const S: Record<string, React.CSSProperties> = {
  wrap: { fontFamily: "'Inter', system-ui, sans-serif", color: TEXT, display: "flex", flexDirection: "column", gap: 14 },
  head: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" },
  h1: { fontSize: 19, fontWeight: 800, letterSpacing: "0.01em" },
  sub: { fontSize: 12.5, color: MUTE },
  secLbl: { fontSize: 11, color: MUTE, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 700, marginBottom: 8 },
  card: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16 },
  tileGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(112px, 1fr))", gap: 10 },
  tile: { background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 12px" },
  tLbl: { fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" },
  tVal: { fontSize: 18, fontWeight: 800, fontFamily: MONO, marginTop: 3, whiteSpace: "nowrap" },
  tSub: { fontSize: 10.5, color: MUTE, fontFamily: MONO, marginTop: 1 },
  legend: { display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10, fontSize: 11.5, color: MUTE },
  dot: { width: 9, height: 9, borderRadius: 2, display: "inline-block", marginRight: 6, verticalAlign: "baseline" },
  meterRow: { display: "flex", alignItems: "center", gap: 10, padding: "5px 0", fontSize: 12.5 },
  meterName: { width: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meterTrack: { flex: 1, minWidth: 90, height: 8, borderRadius: 4, background: "#0e1219", overflow: "hidden" },
  meterNum: { width: 150, textAlign: "right", fontFamily: MONO, fontSize: 12, color: "#b8c1cf" },
  seg: { display: "inline-flex", background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: 3, gap: 2 },
  segBtn: { background: "transparent", border: "none", color: MUTE, fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" },
  segOn: { background: "#2f3a4a", color: TEXT },
  th: { textAlign: "left", fontSize: 10, color: MUTE, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", padding: "8px 10px", borderBottom: `1px solid ${LINE}`, whiteSpace: "nowrap", position: "sticky", top: 0, background: PANEL },
  td: { fontSize: 12.5, padding: "7px 10px", borderBottom: "1px solid #232c38", whiteSpace: "nowrap" },
  pill: { display: "inline-block", fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 20 },
  input: { width: 74, background: INK, border: `1px solid ${LINE}`, borderRadius: 7, color: TEXT, padding: "6px 8px", fontSize: 13, fontFamily: MONO, textAlign: "right" },
  adorn: { display: "inline-flex", alignItems: "center", background: INK, border: `1px solid ${LINE}`, borderRadius: 7, overflow: "hidden" },
  adornUnit: { fontSize: 11, color: MUTE, padding: "0 8px" },
  btn: { background: AMBER, border: "none", borderRadius: 8, color: "#1a1200", padding: "9px 18px", fontSize: 13, cursor: "pointer", fontWeight: 800 },
  ghost: { background: "transparent", border: `1px solid ${LINE}`, borderRadius: 8, color: MUTE, padding: "9px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600 },
  empty: { color: MUTE, textAlign: "center", padding: "26px 12px", fontSize: 13, lineHeight: 1.5 },
  hint: { fontSize: 11.5, color: MUTE, lineHeight: 1.4 },
};

function exportCsv(events: ShadowView["events"]) {
  const cols = ["time", "match", "category", "strategy", "profile", "source", "edge", "requested", "reserved", "verdict", "reason", "contention", "free", "proj_size", "proj_verdict"];
  const rows = events.map((e) => [e.at, e.matchLabel, e.category, e.strategyLabel, e.profileId, e.isLive ? "live" : "prematch", e.edge, e.sizeRequested, e.sizeReserved, e.verdict, e.reason ?? "", e.contention ? "1" : "0", e.freeAt ?? "", e.projSize ?? "", e.projVerdict ?? ""]);
  const csv = [cols, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = `shadow-events-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function Tile({ label, value, sub, color }: { label: string; value: React.ReactNode; sub?: string; color?: string }) {
  return <div style={S.tile}><div style={S.tLbl}>{label}</div><div style={{ ...S.tVal, color: color ?? TEXT }}>{value}</div>{sub && <div style={S.tSub}>{sub}</div>}</div>;
}

function Meter({ name, used, cap }: { name: string; used: number; cap: number }) {
  const frac = cap > 0 ? Math.min(1, used / cap) : 0;
  const col = frac >= 0.9 ? RED : frac >= 0.7 ? AMBER : BLUE;
  return (
    <div style={S.meterRow}>
      <div style={S.meterName} title={name}>{name}</div>
      <div style={S.meterTrack}><div style={{ width: `${frac * 100}%`, height: "100%", background: col, borderRadius: 4 }} /></div>
      <div style={S.meterNum}>{usd(used)} <span style={{ color: MUTE }}>/ {usd(cap)}</span> · {pctOf(used, cap)}%</div>
    </div>
  );
}

export default function ShadowScreen({ data, onSave, onReplay }: { data: ShadowView; onSave: (config: any) => Promise<any>; onReplay: (config: any) => Promise<any> }) {
  const { pool, analytics, config, projection } = data;
  const [filter, setFilter] = useState<"all" | "blocked" | "contention">("all");
  const [cat, setCat] = useState<string>("");
  const [grouped, setGrouped] = useState(false);

  const events = useMemo(() => data.events.filter((e) =>
    (filter === "all" || (filter === "blocked" ? e.verdict !== "allowed" : e.contention)) && (!cat || e.category === cat)
  ), [data.events, filter, cat]);
  const categories = useMemo(() => Array.from(new Set(data.events.map((e) => e.category))), [data.events]);
  const groups = useMemo(() => {
    const m = new Map<string, { match: string; count: number; req: number; reserved: number; allowed: number; blocked: number; trimmed: number; projBlocked: number; isLive: boolean }>();
    for (const e of events) {
      const g = m.get(e.matchId) ?? { match: e.matchLabel, count: 0, req: 0, reserved: 0, allowed: 0, blocked: 0, trimmed: 0, projBlocked: 0, isLive: false };
      g.count++; g.req += e.sizeRequested; g.reserved += e.sizeReserved;
      if (e.verdict === "allowed") g.allowed++; else if (e.verdict === "blocked") g.blocked++; else g.trimmed++;
      if (e.projVerdict === "blocked") g.projBlocked++;
      g.isLive = g.isLive || e.isLive;
      m.set(e.matchId, g);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [events]);

  // Verdict: is capital the bottleneck? deficit rate = share of decisions not fully funded.
  const deficit = Math.round((analytics.blockedPct + analytics.trimmedPct) * 10) / 10;
  const peakUtil = analytics.utilization.length ? Math.max(...analytics.utilization.map((p) => pctOf(p.reserved, pool.bank))) : pctOf(pool.reserved, pool.bank);
  const status = analytics.total === 0
    ? { color: MUTE, bg: PANEL2, word: "нет данных", line: "Событий пока нет — появятся при первых входах реальной симуляции." }
    : deficit === 0
      ? { color: GREEN, bg: "#16241c", word: "капитал свободен", line: `Ни один вход не упёрся в лимит банка. Пиковая утилизация ${peakUtil}%.` }
      : deficit < 10
        ? { color: GREEN, bg: "#16241c", word: "запас есть", line: `Капитал был узким местом лишь в ${deficit}% решений. Пик утилизации ${peakUtil}%.` }
        : deficit < 25
          ? { color: AMBER, bg: "#2a2413", word: "капитал поджимает", line: `${deficit}% входов не получили полный размер из-за лимитов. Стоит присмотреться.` }
          : { color: RED, bg: "#2a1a1c", word: "капитал — узкое место", line: `${deficit}% решений упёрлись в лимит банка. Общий пул тесен для текущего потока входов.` };

  // Capital bar segments (sum = bank): reserved | settling | live-buffer held | spendable free.
  const spendable = Math.max(0, pool.free - pool.liveBufferFree);
  const segs = [
    { v: pool.reserved, c: BLUE, l: "резерв" },
    { v: pool.settling, c: PURPLE, l: "settling" },
    { v: pool.liveBufferFree, c: HELD, l: "буфер live" },
    { v: spendable, c: GREEN, l: "свободно" },
  ];

  // Settings form: percentages shown as WHOLE numbers (40, not 0.4). Convert on save.
  const toForm = (c: typeof config) => ({
    enabled: c.enabled, bankTotal: c.bankTotal, settlementLagMin: c.settlementLagMin,
    liveBufferPct: Math.round(c.liveBufferPct * 100), capCategoryPct: Math.round(c.capCategoryPct * 100),
    capStrategyPct: Math.round(c.capStrategyPct * 100), capMatchPct: Math.round(c.capMatchPct * 100),
    cashReservePct: Math.round(c.cashReservePct * 100),
  });
  const [form, setForm] = useState<any>(toForm(config));
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(config));
  const save = async () => {
    setSaving(true);
    await onSave({
      enabled: !!form.enabled, bankTotal: Number(form.bankTotal), settlementLagMin: Number(form.settlementLagMin),
      liveBufferPct: Number(form.liveBufferPct) / 100, capCategoryPct: Number(form.capCategoryPct) / 100,
      capStrategyPct: Number(form.capStrategyPct) / 100, capMatchPct: Number(form.capMatchPct) / 100,
      cashReservePct: Number(form.cashReservePct) / 100,
    }).catch(() => {});
    setSaving(false);
  };

  // Calibration / what-if: replay the recorded stream under a candidate config (read-only).
  const [cand, setCand] = useState<any>(toForm(config));
  const [replay, setReplay] = useState<{ baseline: any; candidate: any; sampleSize: number } | null>(null);
  const [running, setRunning] = useState(false);
  const runReplay = async () => {
    setRunning(true);
    const r = await onReplay({
      enabled: true, bankTotal: Number(cand.bankTotal), settlementLagMin: Number(cand.settlementLagMin),
      liveBufferPct: Number(cand.liveBufferPct) / 100, capCategoryPct: Number(cand.capCategoryPct) / 100,
      capStrategyPct: Number(cand.capStrategyPct) / 100, capMatchPct: Number(cand.capMatchPct) / 100,
      cashReservePct: Number(cand.cashReservePct) / 100,
    }).catch(() => null);
    if (r && r.ok !== false) setReplay({ baseline: r.baseline, candidate: r.candidate, sampleSize: r.sampleSize });
    setRunning(false);
  };

  return (
    <main style={S.wrap}>
      <div style={S.head}>
        <div style={S.h1}>Бюджет (shadow)</div>
        <div style={S.sub}>теневая симуляция ОДНОГО общего банка {usd(config.bankTotal)} · только наблюдает, не влияет на изолированные бюджеты пар</div>
      </div>

      {/* VERDICT HERO — the one-glance answer */}
      <div style={{ ...S.card, borderColor: `${status.color}44`, background: status.bg, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "1 1 320px" }}>
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: status.color, flexShrink: 0, boxShadow: `0 0 12px ${status.color}88` }} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: status.color, textTransform: "uppercase", letterSpacing: "0.03em" }}>{status.word}</div>
            <div style={{ fontSize: 12.5, color: "#c4cdd9", marginTop: 3, lineHeight: 1.4, maxWidth: 460 }}>{status.line}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Tile label="дефицит входов" value={`${deficit}%`} sub={`${analytics.blocked} блок · ${analytics.trimmed} урез`} color={status.color} />
          <Tile label="упущенный P&L" value={<>{analytics.missedPnl >= 0 ? "+" : ""}{usd2(analytics.missedPnl)}</>} sub="из-за дефицита" color={analytics.missedPnl >= 0 ? GREEN : RED} />
          <Tile label="пик утилизации" value={`${peakUtil}%`} sub={`конкуренций ${analytics.contentionEvents}`} />
        </div>
      </div>

      {/* CAPITAL — where the money sits */}
      <div>
        <div style={S.secLbl}>Капитал пула</div>
        <div style={S.card}>
          <div style={{ display: "flex", height: 16, borderRadius: 6, overflow: "hidden", background: "#0e1219" }} title="разбивка банка">
            {segs.map((s, i) => s.v > 0 && <div key={i} style={{ width: `${(s.v / pool.bank) * 100}%`, background: s.c }} title={`${s.l}: ${usd(s.v)}`} />)}
          </div>
          <div style={S.legend}>
            {segs.map((s, i) => <span key={i}><span style={{ ...S.dot, background: s.c }} />{s.l} {usd(s.v)}</span>)}
            <span style={{ marginLeft: "auto", color: MUTE }}>неснижаемый остаток {usd(pool.cashFloor)}</span>
          </div>
          <div style={{ ...S.tileGrid, marginTop: 14 }}>
            <Tile label="банк" value={usd(pool.bank)} />
            <Tile label="резерв" value={usd(pool.reserved)} sub={`${pctOf(pool.reserved, pool.bank)}% банка`} color={BLUE} />
            <Tile label="settling" value={usd(pool.settling)} sub={`резолв ${config.settlementLagMin} мин`} color={PURPLE} />
            <Tile label="свободно" value={usd(spendable)} sub="доступно предматчу" color={GREEN} />
            <Tile label="live-буфер" value={usd(pool.liveBufferUsed)} sub={`из ${usd(pool.liveBufferTotal)} · только live`} />
          </div>
          {data.settlingQueue.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
              <div style={{ ...S.hint, marginBottom: 6 }}>очередь settling — {usd(pool.settling)} вернётся во «свободно» после лага</div>
              {data.settlingQueue.slice(0, 8).map((s, i) => {
                const mins = Math.max(0, Math.round((Date.parse(s.settleAt) - Date.now()) / 60000));
                return (
                  <div key={i} style={{ display: "flex", gap: 10, fontSize: 12, padding: "3px 0" }}>
                    <span style={{ fontFamily: MONO, width: 60, color: PURPLE }}>{usd(s.size)}</span>
                    <span style={{ width: 118, color: MUTE }}>{mins > 0 ? `через ${mins} мин` : "вот-вот"}</span>
                    <span style={{ color: "#c4cdd9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${s.matchLabel} · ${s.strategyLabel}`}>{s.matchLabel}</span>
                  </div>
                );
              })}
              {data.settlingQueue.length > 8 && <div style={{ ...S.hint, marginTop: 4 }}>…ещё {data.settlingQueue.length - 8}</div>}
            </div>
          )}
        </div>
      </div>

      {/* CONCENTRATION — where limits build */}
      <div>
        <div style={S.secLbl}>Концентрация под потолками</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
          <div style={S.card}>
            <div style={{ ...S.hint, marginBottom: 6 }}>по категориям · потолок {Math.round(config.capCategoryPct * 100)}% банка</div>
            {Object.entries(pool.byCategory).length === 0 ? <div style={{ color: MUTE, fontSize: 12.5, padding: "8px 0" }}>нет открытых резервов</div>
              : Object.entries(pool.byCategory).sort((a, b) => b[1].used - a[1].used).map(([id, b]) => <Meter key={id} name={data.categoryNames[id] ?? id} used={b.used} cap={b.cap} />)}
          </div>
          <div style={S.card}>
            <div style={{ ...S.hint, marginBottom: 6 }}>по стратегиям · потолок {Math.round(config.capStrategyPct * 100)}% банка</div>
            {Object.entries(pool.byStrategy).length === 0 ? <div style={{ color: MUTE, fontSize: 12.5, padding: "8px 0" }}>нет открытых резервов</div>
              : Object.entries(pool.byStrategy).sort((a, b) => b[1].used - a[1].used).map(([id, b]) => <Meter key={id} name={data.strategyNames[id] ?? id} used={b.used} cap={b.cap} />)}
          </div>
          <div style={S.card}>
            <div style={{ ...S.hint, marginBottom: 6 }}>по матчам · потолок {Math.round(config.capMatchPct * 100)}% банка</div>
            {Object.entries(pool.byMatch).length === 0 ? <div style={{ color: MUTE, fontSize: 12.5, padding: "8px 0" }}>нет открытых резервов</div>
              : Object.entries(pool.byMatch).sort((a, b) => b[1].used - a[1].used).slice(0, 8).map(([id, b]) => <Meter key={id} name={data.matchNames[id] ?? id} used={b.used} cap={b.cap} />)}
          </div>
        </div>
      </div>

      {/* PROJECTION — worst-case «sizing from the single bank» */}
      <div>
        <div style={S.secLbl}>Проекция · сайзинг от единого банка</div>
        <div style={{ ...S.card, borderColor: "#4a5a3a" }}>
          <div style={{ ...S.hint, marginBottom: 12 }}>
            факт выше считает дефицит на размерах от изолированных бюджетов пар (~$1000) — в реале сайзинг пойдёт от общего банка ({usd(config.bankTotal)}), и размеры будут крупнее. Здесь каждый вход пересчитан как <b>Kelly×edge × доступная база</b> (free − остаток, урезано потолками), пул сам себя тормозит по мере заполнения. <b style={{ color: AMBER }}>Верхняя граница (worst case)</b>: считается для ВСЕХ текущих пар — боевых в реале будет меньше.
          </div>
          {projection.covered === 0 ? (
            <div style={{ ...S.hint, padding: "14px 12px", background: "#1a1f27", borderRadius: 8, color: MUTE }}>
              Проекция пока <b style={{ color: TEXT }}>без данных</b>: ни один из {projection.total} входов в журнале не несёт захваченной <b>intensity</b> (Kelly×edge). Такие входы записаны до включения захвата — они исключены из проекции (это «нет данных», а не «нет места»). Как только накопятся новые входы с intensity, здесь появятся реальные worst-case размеры.
            </div>
          ) : (<>
          <div style={S.tileGrid}>
            <Tile label="пик утилизации" value={`${projection.peakUtilPct}%`} sub={`факт ${Math.round(pctOf(pool.reserved, pool.bank))}%`} color={projection.peakUtilPct >= 90 ? RED : projection.peakUtilPct >= 70 ? AMBER : GREEN} />
            <Tile label="средняя утилизация" value={`${projection.avgUtilPct}%`} />
            <Tile label="не влезло" value={`${projection.blockedPct}%`} sub={`${projection.blocked} из ${projection.covered}`} color={projection.blocked > 0 ? RED : GREEN} />
            <Tile label="спроецировано" value={usd(projection.totalProjected)} sub="суммарный размер" color={BLUE} />
            <Tile label="упущенный P&L" value={<>{projection.missedPnl >= 0 ? "+" : ""}{usd2(projection.missedPnl)}</>} sub="входы без места" color={projection.missedPnl >= 0 ? GREEN : RED} />
          </div>
          <div style={{ ...S.hint, marginTop: 10 }}>
            проекция по <b>{projection.covered}</b> из {projection.total} входов{projection.noData > 0 ? ` · ${projection.noData} без intensity исключены` : ""}. если пик утилизации приближается к 90–100% или «не влезло» &gt; 0 — банка {usd(config.bankTotal)} при реальных размерах не хватит. Подбери потолки/банк в «Калибровке» ниже.
          </div>
          </>)}
        </div>
      </div>

      {/* DEFICIT DETAIL */}
      <div>
        <div style={S.secLbl}>Аналитика дефицита (факт)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
          <div style={S.card}>
            <div style={{ ...S.hint, marginBottom: 10 }}>почему входы не получали полный размер</div>
            {Object.keys(analytics.byReason).length === 0 ? <div style={{ color: MUTE, fontSize: 12.5 }}>отказов не было — банк покрывал все входы</div>
              : Object.entries(analytics.byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => {
                  const max = Math.max(...Object.values(analytics.byReason));
                  return (
                    <div key={r} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", fontSize: 12.5 }}>
                      <div style={{ width: 150 }}>{REASON_RU[r] ?? r}</div>
                      <div style={S.meterTrack}><div style={{ width: `${(n / max) * 100}%`, height: "100%", background: AMBER, borderRadius: 4 }} /></div>
                      <div style={{ width: 34, textAlign: "right", fontFamily: MONO, fontSize: 12 }}>{n}</div>
                    </div>
                  );
                })}
            <div style={{ ...S.hint, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${LINE}` }}>
              <b style={{ color: analytics.missedPnl >= 0 ? GREEN : RED }}>{analytics.missedPnl >= 0 ? "+" : ""}{usd2(analytics.missedPnl)}</b> — суммарный реальный P&L входов, которым пул отказал (они исполнились в изолированной симуляции). Плюс = дефицит стоил денег; минус = уберёг от убытка.
            </div>
          </div>
          <div style={S.card}>
            <div style={{ ...S.hint, marginBottom: 10 }}>утилизация пула во времени</div>
            <Spark points={analytics.utilization} bank={pool.bank} />
          </div>
        </div>
      </div>

      {/* LEDGER */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <div style={{ ...S.secLbl, margin: 0 }}>Лента решений</div>
          <div style={{ ...S.seg, marginLeft: "auto" }}>
            {([["all", "все"], ["blocked", "с отказом"], ["contention", "конкуренция"]] as const).map(([k, l]) => (
              <button key={k} style={{ ...S.segBtn, ...(filter === k ? S.segOn : {}) }} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          {categories.length > 1 && (
            <select style={{ ...S.segBtn, ...S.seg, padding: "5px 8px", color: TEXT }} value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">все категории</option>
              {categories.map((c) => <option key={c} value={c}>{data.categoryNames[c] ?? c}</option>)}
            </select>
          )}
          <button style={{ ...S.ghost, ...(grouped ? { color: TEXT, borderColor: "#4a4a5c" } : {}) }} onClick={() => setGrouped((v) => !v)} title="свернуть события по матчу">по матчу</button>
          <button style={S.ghost} onClick={() => exportCsv(events)} title="скачать текущую выборку в CSV">CSV</button>
          <a style={{ ...S.ghost, textDecoration: "none" }} href="/api/shadow-log" title="полный лог распоряжения бюджетом по ВСЕМ матчам (markdown) — для оффлайн-аналитики и оптимизации потолков/буфера">глобальный лог</a>
        </div>
        <div style={{ ...S.card, padding: 0, overflow: "auto", maxHeight: 420 }}>
          {grouped ? (
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 620 }}>
              <thead><tr>{["матч", "входов", "запрошено", "зарезерв.", "принят / урез. / блок", "проекц. отказы"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {groups.length === 0 && <tr><td colSpan={6} style={S.empty}>Событий нет.</td></tr>}
                {groups.map((g) => (
                  <tr key={g.match}>
                    <td style={S.td} title={g.match}>{g.match.length > 30 ? g.match.slice(0, 29) + "…" : g.match}{g.isLive && <span style={{ ...S.pill, background: "#2a1a1c", color: RED, marginLeft: 6, fontSize: 9.5, padding: "1px 6px" }}>LIVE</span>}</td>
                    <td style={{ ...S.td, fontFamily: MONO }}>{g.count}</td>
                    <td style={{ ...S.td, fontFamily: MONO }}>{usd(g.req)}</td>
                    <td style={{ ...S.td, fontFamily: MONO }}>{usd(g.reserved)}</td>
                    <td style={{ ...S.td, fontFamily: MONO }}><span style={{ color: GREEN }}>{g.allowed}</span> / <span style={{ color: AMBER }}>{g.trimmed}</span> / <span style={{ color: RED }}>{g.blocked}</span></td>
                    <td style={{ ...S.td, fontFamily: MONO, color: g.projBlocked > 0 ? RED : MUTE }}>{g.projBlocked || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 720 }}>
            <thead><tr>{["время", "матч", "категория", "стратегия", "запрос → резерв", "проекция", "вердикт", "причина", "free"].map((h) => <th key={h} style={S.th} title={h === "проекция" ? "размер при сайзинге от единого банка (worst case)" : undefined}>{h}</th>)}</tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={9} style={S.empty}>{data.events.length ? "Под фильтр ничего не попало." : "Событий пока нет.\nОни появляются при каждом входе реальной симуляции — allowed / blocked / trimmed."}</td></tr>}
              {events.slice(0, 150).map((e) => {
                const v = VERDICT[e.verdict as keyof typeof VERDICT] ?? VERDICT.allowed;
                return (
                  <tr key={e.id}>
                    <td style={{ ...S.td, color: MUTE, fontFamily: MONO }}>{new Date(e.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</td>
                    <td style={S.td} title={e.matchLabel}>{e.matchLabel.length > 24 ? e.matchLabel.slice(0, 23) + "…" : e.matchLabel}{e.isLive && <span style={{ ...S.pill, background: "#2a1a1c", color: RED, marginLeft: 6, fontSize: 9.5, padding: "1px 6px" }}>LIVE</span>}{e.contention && <span title="конкуренция за пул" style={{ color: AMBER, marginLeft: 6 }}>⚔</span>}</td>
                    <td style={{ ...S.td, color: "#c4cdd9" }}>{e.category}</td>
                    <td style={S.td}>{e.strategyLabel} <span style={{ color: MUTE }}>/{e.profileId}</span></td>
                    <td style={{ ...S.td, fontFamily: MONO }}>{usd(e.sizeRequested)} <span style={{ color: MUTE }}>→</span> {usd(e.sizeReserved)}</td>
                    <td style={{ ...S.td, fontFamily: MONO, color: e.projVerdict === "blocked" ? RED : e.projVerdict === "nodata" ? MUTE : "#c4cdd9" }} title={e.projVerdict === "nodata" ? "нет захваченной intensity — вне проекции" : "сайзинг от банка (worst case)"}>{e.projVerdict === "blocked" ? "нет места" : e.projVerdict === "nodata" ? "н/д" : e.projSize != null ? usd(e.projSize) : "—"}</td>
                    <td style={S.td}><span style={{ ...S.pill, background: v.bg, color: v.color }}>{v.ru}</span></td>
                    <td style={{ ...S.td, color: e.reason ? "#c4cdd9" : MUTE }}>{e.reason ? (REASON_RU[e.reason] ?? e.reason) : "—"}</td>
                    <td style={{ ...S.td, color: MUTE, fontFamily: MONO }}>{e.freeAt != null ? usd(e.freeAt) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
      </div>

      {/* SETTINGS */}
      <div>
        <div style={S.secLbl}>Настройки</div>
        <div style={S.card}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 14, cursor: "pointer" }}>
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            <span style={{ fontWeight: 600 }}>аллокатор включён</span>
            <span style={S.hint}>— когда выключен, новые входы не оцениваются (история сохраняется)</span>
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
            <SetField label="банк" hint="общий пул">
              <span style={S.adorn}><span style={S.adornUnit}>$</span><input style={{ ...S.input, borderRadius: 0, borderWidth: "0 0 0 1px", width: 84 }} type="number" step={100} value={form.bankTotal} onChange={(e) => setForm({ ...form, bankTotal: e.target.value })} /></span>
            </SetField>
            <SetField label="лаг резолва" hint="от закрытия до возврата средств">
              <span style={S.adorn}><input style={{ ...S.input, borderRadius: 0, border: "none", width: 60 }} type="number" step={5} value={form.settlementLagMin} onChange={(e) => setForm({ ...form, settlementLagMin: e.target.value })} /><span style={S.adornUnit}>мин</span></span>
            </SetField>
            <PctField label="live-буфер" hint="держится под live-входы" v={form.liveBufferPct} on={(x) => setForm({ ...form, liveBufferPct: x })} />
            <PctField label="неснижаемый остаток" hint="никогда не тратится" v={form.cashReservePct} on={(x) => setForm({ ...form, cashReservePct: x })} />
            <PctField label="потолок категории" hint="макс на одну категорию" v={form.capCategoryPct} on={(x) => setForm({ ...form, capCategoryPct: x })} />
            <PctField label="потолок стратегии" hint="макс на одну стратегию" v={form.capStrategyPct} on={(x) => setForm({ ...form, capStrategyPct: x })} />
            <PctField label="потолок матча" hint="макс на один матч" v={form.capMatchPct} on={(x) => setForm({ ...form, capMatchPct: x })} />
          </div>
          <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button style={{ ...S.btn, opacity: saving || !dirty ? 0.5 : 1, cursor: saving || !dirty ? "default" : "pointer" }} onClick={save} disabled={saving || !dirty}>{saving ? "Сохраняю…" : "Сохранить"}</button>
            {dirty && <button style={S.ghost} onClick={() => setForm(toForm(config))}>Отменить</button>}
            <span style={S.hint}>применяется с момента изменения — история не пересчитывается</span>
          </div>
        </div>
      </div>

      {/* CALIBRATION — offline what-if replay */}
      <div>
        <div style={S.secLbl}>Калибровка «что-если»</div>
        <div style={S.card}>
          <div style={{ ...S.hint, marginBottom: 12 }}>прогнать всю записанную историю решений с ДРУГИМИ настройками — детерминированно, оффлайн, не трогая историю. Так подбираются потолки по данным, а не на глаз.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 14 }}>
            <SetField label="банк" hint="кандидат"><span style={S.adorn}><span style={S.adornUnit}>$</span><input style={{ ...S.input, borderRadius: 0, borderWidth: "0 0 0 1px", width: 84 }} type="number" step={100} value={cand.bankTotal} onChange={(e) => setCand({ ...cand, bankTotal: e.target.value })} /></span></SetField>
            <SetField label="лаг резолва" hint="кандидат"><span style={S.adorn}><input style={{ ...S.input, borderRadius: 0, border: "none", width: 60 }} type="number" step={5} value={cand.settlementLagMin} onChange={(e) => setCand({ ...cand, settlementLagMin: e.target.value })} /><span style={S.adornUnit}>мин</span></span></SetField>
            <PctField label="live-буфер" hint="кандидат" v={cand.liveBufferPct} on={(x) => setCand({ ...cand, liveBufferPct: x })} />
            <PctField label="неснижаемый остаток" hint="кандидат" v={cand.cashReservePct} on={(x) => setCand({ ...cand, cashReservePct: x })} />
            <PctField label="потолок категории" hint="кандидат" v={cand.capCategoryPct} on={(x) => setCand({ ...cand, capCategoryPct: x })} />
            <PctField label="потолок стратегии" hint="кандидат" v={cand.capStrategyPct} on={(x) => setCand({ ...cand, capStrategyPct: x })} />
            <PctField label="потолок матча" hint="кандидат" v={cand.capMatchPct} on={(x) => setCand({ ...cand, capMatchPct: x })} />
          </div>
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button style={{ ...S.btn, opacity: running ? 0.5 : 1 }} onClick={runReplay} disabled={running}>{running ? "Считаю…" : "Прогнать историю"}</button>
            <button style={S.ghost} onClick={() => setCand(toForm(config))}>= текущие</button>
            {analytics.total === 0 && <span style={S.hint}>история пуста — прогонять пока нечего</span>}
          </div>
          {replay && (
            <div style={{ marginTop: 16, overflowX: "auto" }}>
              <div style={{ ...S.hint, marginBottom: 8 }}>сравнение на {replay.sampleSize} записанных решениях</div>
              <table style={{ borderCollapse: "collapse", minWidth: 460 }}>
                <thead><tr>{["метрика", "сейчас", "кандидат", "Δ"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {([
                    ["дефицит входов", (x: any) => `${Math.round((x.blockedPct + x.trimmedPct) * 10) / 10}%`, true],
                    ["заблокировано", (x: any) => `${x.blocked}`, true],
                    ["урезано", (x: any) => `${x.trimmed}`, true],
                    ["упущенный P&L", (x: any) => usd2(x.missedPnl), true],
                    ["пик утилизации", (x: any) => `${x.peakUtilPct}%`, false],
                  ] as const).map(([label, fmt, lowerBetter]) => {
                    const bv = fmt(replay.baseline), cv = fmt(replay.candidate);
                    const bn = parseFloat(String(bv).replace(/[^0-9.\-]/g, "")) || 0, cn = parseFloat(String(cv).replace(/[^0-9.\-]/g, "")) || 0;
                    const delta = Math.round((cn - bn) * 100) / 100;
                    const good = delta === 0 ? MUTE : (lowerBetter ? delta < 0 : delta > 0) ? GREEN : RED;
                    return (
                      <tr key={label}>
                        <td style={{ ...S.td, color: "#c4cdd9" }}>{label}</td>
                        <td style={{ ...S.td, fontFamily: MONO }}>{bv}</td>
                        <td style={{ ...S.td, fontFamily: MONO, fontWeight: 700 }}>{cv}</td>
                        <td style={{ ...S.td, fontFamily: MONO, color: good }}>{delta > 0 ? "+" : ""}{delta}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function SetField({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 5 }}><span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>{children}<span style={S.hint}>{hint}</span></div>;
}
function PctField({ label, hint, v, on }: { label: string; hint: string; v: number; on: (x: number) => void }) {
  return <SetField label={label} hint={hint}><span style={S.adorn}><input style={{ ...S.input, borderRadius: 0, border: "none", width: 56 }} type="number" step={5} min={0} max={100} value={v} onChange={(e) => on(Number(e.target.value))} /><span style={S.adornUnit}>%</span></span></SetField>;
}

function Spark({ points, bank }: { points: { t: string; free: number; reserved: number }[]; bank: number }) {
  if (points.length < 2 || bank <= 0) return <div style={{ color: MUTE, fontSize: 12.5, padding: "18px 0", textAlign: "center" }}>мало данных для графика</div>;
  const W = 100, H = 30;
  const y = (val: number) => H - Math.max(0, Math.min(1, val / bank)) * H;
  const line = (key: "free" | "reserved") => points.map((p, i) => `${(i / (points.length - 1)) * W},${y(p[key])}`).join(" ");
  const area = `${line("reserved")} ${W},${H} 0,${H}`;
  const peak = Math.max(...points.map((p) => pctOf(p.reserved, bank)));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 84, background: INK, borderRadius: 8, border: `1px solid ${LINE}` }}>
        <polygon points={area} fill={`${BLUE}22`} />
        <polyline points={line("reserved")} fill="none" stroke={BLUE} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polyline points={line("free")} fill="none" stroke={GREEN} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11.5, color: MUTE }}>
        <span><span style={{ ...S.dot, background: BLUE }} />резерв (пик {peak}%)</span>
        <span><span style={{ ...S.dot, background: GREEN }} />свободно · {points.length} решений</span>
      </div>
    </div>
  );
}
