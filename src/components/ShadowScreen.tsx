"use client";

// «Бюджет (shadow)» — observe-only view of the shadow capital allocator. Shows how one
// shared limited bank would have lived (reserved / settling / free, per-category and
// per-strategy ceilings), the ledger of allowed/blocked/trimmed entry decisions, the
// deficit analytics (the whole point — how often + where capital was the bottleneck, and
// the realised P&L we'd have missed), and editable settings. Never touches real money.

import { useMemo, useState } from "react";
import type { ShadowView } from "@/lib/view";

const usd = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("ru-RU")}`;
const pct = (n: number) => `${Math.round(n * 10) / 10}%`;
const REASON_RU: Record<string, string> = {
  insufficient_free: "нет свободных", cash_reserve: "неснижаемый остаток", live_buffer: "буфер live",
  cap_match: "потолок матча", cap_category: "потолок категории", cap_strategy: "потолок стратегии",
};
const VERDICT_RU: Record<string, string> = { allowed: "принят", blocked: "заблокирован", trimmed: "урезан" };
const VERDICT_COLOR: Record<string, string> = { allowed: "#70b56a", blocked: "#e07a5f", trimmed: "#e8a838" };

const st: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 1080, margin: "0 auto", padding: "8px 16px 48px", color: "#e6e6ea" },
  h: { fontSize: 15, fontWeight: 700, margin: "22px 0 10px", color: "#cfcfe0" },
  card: { background: "#17171d", border: "1px solid #2a2a33", borderRadius: 10, padding: 16 },
  row: { display: "flex", gap: 16, flexWrap: "wrap" },
  stat: { flex: "1 1 120px", minWidth: 110 },
  statN: { fontSize: 20, fontWeight: 700 },
  statL: { fontSize: 11, color: "#8a8a99", marginTop: 2 },
  bar: { height: 10, borderRadius: 5, background: "#26262f", overflow: "hidden", display: "flex", marginTop: 12 },
  th: { textAlign: "left", fontSize: 11, color: "#8a8a99", fontWeight: 600, padding: "6px 8px", borderBottom: "1px solid #2a2a33", whiteSpace: "nowrap" },
  td: { fontSize: 12, padding: "6px 8px", borderBottom: "1px solid #202028", whiteSpace: "nowrap" },
  chip: { fontSize: 11, padding: "2px 8px", borderRadius: 12, border: "1px solid #33333f", cursor: "pointer", background: "transparent", color: "#cfcfe0" },
  chipOn: { background: "#2b2b38", borderColor: "#4a4a5c" },
  capBar: { position: "relative", height: 8, borderRadius: 4, background: "#26262f", overflow: "hidden", flex: 1, minWidth: 80 },
  input: { width: 90, background: "#0f0f14", border: "1px solid #33333f", borderRadius: 6, color: "#e6e6ea", padding: "5px 8px", fontSize: 13 },
  btn: { background: "#3a5bbf", border: "none", borderRadius: 7, color: "#fff", padding: "8px 16px", fontSize: 13, cursor: "pointer", fontWeight: 600 },
  muted: { color: "#8a8a99", fontSize: 12 },
};

function Bucket({ label, used, cap }: { label: string; used: number; cap: number }) {
  const frac = cap > 0 ? Math.min(1, used / cap) : 0;
  const col = frac > 0.9 ? "#e07a5f" : frac > 0.7 ? "#e8a838" : "#5b9bd5";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", fontSize: 12 }}>
      <div style={{ width: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label}>{label}</div>
      <div style={st.capBar}><div style={{ width: `${frac * 100}%`, height: "100%", background: col }} /></div>
      <div style={{ width: 130, textAlign: "right", color: "#a8a8b8" }}>{usd(used)} <span style={{ color: "#6a6a77" }}>/ {usd(cap)}</span></div>
    </div>
  );
}

export default function ShadowScreen({ data, onSave }: { data: ShadowView; onSave: (config: any) => Promise<any> }) {
  const { pool, analytics, config } = data;
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  const [cat, setCat] = useState<string>("");
  const [form, setForm] = useState<any>({ ...config });
  const [saving, setSaving] = useState(false);

  const events = useMemo(() => data.events.filter((e) =>
    (!onlyBlocked || e.verdict !== "allowed") && (!cat || e.category === cat)
  ), [data.events, onlyBlocked, cat]);
  const categories = useMemo(() => Array.from(new Set(data.events.map((e) => e.category))), [data.events]);

  const reservedFrac = pool.bank > 0 ? pool.reserved / pool.bank : 0;
  const settlingFrac = pool.bank > 0 ? pool.settling / pool.bank : 0;
  const bufFrac = pool.bank > 0 ? pool.liveBufferFree / pool.bank : 0;

  const save = async () => {
    setSaving(true);
    const patch = {
      enabled: !!form.enabled, bankTotal: Number(form.bankTotal), settlementLagMin: Number(form.settlementLagMin),
      liveBufferPct: Number(form.liveBufferPct), capCategoryPct: Number(form.capCategoryPct),
      capStrategyPct: Number(form.capStrategyPct), capMatchPct: Number(form.capMatchPct), cashReservePct: Number(form.cashReservePct),
    };
    await onSave(patch).catch(() => {});
    setSaving(false);
  };
  const num = (k: string, step = 1) => (
    <input style={st.input} type="number" step={step} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
  );

  return (
    <main style={st.wrap}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 6 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>Бюджет (shadow)</div>
        <div style={st.muted}>{data.enabled ? "теневой аллокатор наблюдает" : "выключен"} · один общий банк {usd(config.bankTotal)} · не влияет на изолированные бюджеты пар</div>
      </div>

      {/* 1 — POOL STATE */}
      <div style={st.h}>Состояние пула</div>
      <div style={st.card}>
        <div style={st.row}>
          <div style={st.stat}><div style={st.statN}>{usd(pool.bank)}</div><div style={st.statL}>банк</div></div>
          <div style={st.stat}><div style={{ ...st.statN, color: "#5b9bd5" }}>{usd(pool.reserved)}</div><div style={st.statL}>резерв (открытые)</div></div>
          <div style={st.stat}><div style={{ ...st.statN, color: "#c98bdb" }}>{usd(pool.settling)}</div><div style={st.statL}>settling (резолв)</div></div>
          <div style={st.stat}><div style={{ ...st.statN, color: "#70b56a" }}>{usd(pool.free)}</div><div style={st.statL}>свободно</div></div>
          <div style={st.stat}><div style={st.statN}>{usd(pool.liveBufferUsed)} <span style={{ fontSize: 12, color: "#6a6a77" }}>/ {usd(pool.liveBufferTotal)}</span></div><div style={st.statL}>live-буфер (занято)</div></div>
          <div style={st.stat}><div style={st.statN}>{usd(pool.cashFloor)}</div><div style={st.statL}>неснижаемый остаток</div></div>
        </div>
        <div style={st.bar} title={`резерв ${usd(pool.reserved)} · settling ${usd(pool.settling)} · live-буфер свободен ${usd(pool.liveBufferFree)}`}>
          <div style={{ width: `${reservedFrac * 100}%`, background: "#5b9bd5" }} />
          <div style={{ width: `${settlingFrac * 100}%`, background: "#c98bdb" }} />
          <div style={{ width: `${bufFrac * 100}%`, background: "#3a3a48" }} />
        </div>
        <div style={{ ...st.muted, marginTop: 6 }}>синий — резерв · фиолетовый — settling · серый — live-буфер (свободен, недоступен предматчу)</div>

        <div style={{ display: "flex", gap: 28, marginTop: 18, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 340px" }}>
            <div style={{ ...st.statL, marginBottom: 4 }}>по категориям (потолок {pct(config.capCategoryPct * 100)})</div>
            {Object.entries(pool.byCategory).length === 0 && <div style={st.muted}>нет резервов</div>}
            {Object.entries(pool.byCategory).map(([id, b]) => <Bucket key={id} label={data.categoryNames[id] ?? id} used={b.used} cap={b.cap} />)}
          </div>
          <div style={{ flex: "1 1 340px" }}>
            <div style={{ ...st.statL, marginBottom: 4 }}>по стратегиям (потолок {pct(config.capStrategyPct * 100)})</div>
            {Object.entries(pool.byStrategy).length === 0 && <div style={st.muted}>нет резервов</div>}
            {Object.entries(pool.byStrategy).map(([id, b]) => <Bucket key={id} label={data.strategyNames[id] ?? id} used={b.used} cap={b.cap} />)}
          </div>
        </div>
      </div>

      {/* 3 — DEFICIT ANALYTICS (main value) */}
      <div style={st.h}>Аналитика дефицита</div>
      <div style={st.card}>
        <div style={st.row}>
          <div style={st.stat}><div style={st.statN}>{analytics.total}</div><div style={st.statL}>всего решений</div></div>
          <div style={st.stat}><div style={{ ...st.statN, color: "#e07a5f" }}>{pct(analytics.blockedPct)}</div><div style={st.statL}>заблокировано ({analytics.blocked})</div></div>
          <div style={st.stat}><div style={{ ...st.statN, color: "#e8a838" }}>{pct(analytics.trimmedPct)}</div><div style={st.statL}>урезано ({analytics.trimmed})</div></div>
          <div style={st.stat}><div style={st.statN}>{analytics.contentionEvents}</div><div style={st.statL}>решений в конкуренции</div></div>
          <div style={st.stat}><div style={{ ...st.statN, color: analytics.missedPnl >= 0 ? "#70b56a" : "#e07a5f" }}>{analytics.missedPnl >= 0 ? "+" : ""}{usd(analytics.missedPnl)}</div><div style={st.statL}>упущенный P&L дефицита</div></div>
        </div>
        {Object.keys(analytics.byReason).length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
            {Object.entries(analytics.byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => (
              <span key={r} style={{ ...st.chip, cursor: "default" }}>{REASON_RU[r] ?? r}: <b>{n}</b></span>
            ))}
          </div>
        )}
        <Spark points={analytics.utilization} bank={pool.bank} />
      </div>

      {/* 2 — EVENT LEDGER */}
      <div style={st.h}>Лента shadow-событий</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <button style={{ ...st.chip, ...(onlyBlocked ? st.chipOn : {}) }} onClick={() => setOnlyBlocked((v) => !v)}>только заблок./урезан.</button>
        <select style={{ ...st.chip, padding: "3px 8px" }} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">все категории</option>
          {categories.map((c) => <option key={c} value={c}>{data.categoryNames[c] ?? c}</option>)}
        </select>
        <span style={st.muted}>{events.length} событий</span>
      </div>
      <div style={{ ...st.card, padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
          <thead><tr>
            {["время", "матч", "категория", "стратегия", "запрошено", "зарезерв.", "вердикт", "причина", "free"].map((h) => <th key={h} style={st.th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {events.length === 0 && <tr><td colSpan={9} style={{ ...st.td, color: "#8a8a99", textAlign: "center", padding: 18 }}>Событий нет — появятся при входах реальной симуляции.</td></tr>}
            {events.slice(0, 120).map((e) => (
              <tr key={e.id}>
                <td style={st.td}>{new Date(e.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</td>
                <td style={st.td} title={e.matchLabel}>{e.matchLabel.length > 26 ? e.matchLabel.slice(0, 25) + "…" : e.matchLabel}{e.isLive && <span style={{ color: "#e07a5f", marginLeft: 5, fontSize: 10 }}>LIVE</span>}{e.contention && <span title="конкуренция за пул" style={{ color: "#e8a838", marginLeft: 5 }}>⚔</span>}</td>
                <td style={st.td}>{e.category}</td>
                <td style={st.td}>{e.strategyLabel} <span style={{ color: "#6a6a77" }}>/{e.profileId}</span></td>
                <td style={st.td}>{usd(e.sizeRequested)}</td>
                <td style={st.td}>{usd(e.sizeReserved)}</td>
                <td style={{ ...st.td, color: VERDICT_COLOR[e.verdict], fontWeight: 600 }}>{VERDICT_RU[e.verdict] ?? e.verdict}</td>
                <td style={st.td}>{e.reason ? (REASON_RU[e.reason] ?? e.reason) : "—"}</td>
                <td style={{ ...st.td, color: "#8a8a99" }}>{e.freeAt != null ? usd(e.freeAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 4 — SETTINGS */}
      <div style={st.h}>Настройки</div>
      <div style={st.card}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> включён
          </label>
          <Field label="банк, $">{num("bankTotal", 100)}</Field>
          <Field label="live-буфер (0..1)">{num("liveBufferPct", 0.05)}</Field>
          <Field label="лаг резолва, мин">{num("settlementLagMin", 5)}</Field>
          <Field label="потолок категории">{num("capCategoryPct", 0.05)}</Field>
          <Field label="потолок стратегии">{num("capStrategyPct", 0.05)}</Field>
          <Field label="потолок матча">{num("capMatchPct", 0.05)}</Field>
          <Field label="неснижаемый остаток">{num("cashReservePct", 0.05)}</Field>
        </div>
        <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <button style={{ ...st.btn, opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>{saving ? "Сохраняю…" : "Сохранить"}</button>
          <span style={st.muted}>применяется с момента изменения — история не пересчитывается</span>
        </div>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span style={{ fontSize: 11, color: "#8a8a99" }}>{label}</span>{children}</div>;
}

function Spark({ points, bank }: { points: { t: string; free: number; reserved: number }[]; bank: number }) {
  if (points.length < 2 || bank <= 0) return null;
  const W = 100, H = 28;
  const path = (key: "free" | "reserved") => points.map((p, i) => `${(i / (points.length - 1)) * W},${H - Math.max(0, Math.min(1, p[key] / bank)) * H}`).join(" ");
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ ...st.statL, marginBottom: 4 }}>утилизация пула во времени (последние {points.length} решений)</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 60, background: "#0f0f14", borderRadius: 6 }}>
        <polyline points={path("reserved")} fill="none" stroke="#5b9bd5" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
        <polyline points={path("free")} fill="none" stroke="#70b56a" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ ...st.muted, marginTop: 4 }}>зелёный — свободно · синий — резерв</div>
    </div>
  );
}
