"use client";

// «Профили» — measurement showcase for the 4 risk profiles. Everything is computed
// from the bet log; the profiles share the SAME picks (Model A), so the comparison is
// honest — only the edge filter + sizing differ. Read-only; no optimizer, no auto-pick.

import { useCallback, useEffect, useMemo, useState } from "react";

const INK = "#12161d", PANEL = "#1a2029", PANEL2 = "#212936", LINE = "#2c3543", TEXT = "#e6e9ef", MUTE = "#8b95a5";
const GREEN = "#5fd08a", RED = "#ff6b6b", AMBER = "#e8a838", BLUE = "#5b9bd5";
const MONO = "'JetBrains Mono', monospace";

const S: Record<string, React.CSSProperties> = {
  wrap: { fontFamily: "'Inter', system-ui, sans-serif", color: TEXT, display: "flex", flexDirection: "column", gap: 14 },
  h1: { fontSize: 19, fontWeight: 800 },
  sub: { fontSize: 12.5, color: MUTE, lineHeight: 1.5 },
  secLbl: { fontSize: 11, color: MUTE, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 700, marginBottom: 8 },
  card: { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16, overflowX: "auto" },
  note: { background: "#16241c", border: `1px solid ${GREEN}44`, borderRadius: 10, padding: "10px 14px", fontSize: 12.5, color: "#c4cdd9", lineHeight: 1.5 },
  th: { textAlign: "left", fontSize: 10, color: MUTE, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", padding: "8px 10px", borderBottom: `1px solid ${LINE}`, whiteSpace: "nowrap" },
  td: { fontSize: 12.5, padding: "7px 10px", borderBottom: "1px solid #232c38", whiteSpace: "nowrap", fontFamily: MONO },
  sel: { background: INK, border: `1px solid ${LINE}`, borderRadius: 7, color: TEXT, padding: "7px 10px", fontSize: 12.5 },
  btn: { background: "transparent", border: `1px solid ${LINE}`, borderRadius: 8, color: MUTE, padding: "8px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600, textDecoration: "none", display: "inline-block" },
};

const money = (n: number | null | undefined) => (n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("ru-RU", { maximumFractionDigits: 0 })}`);
const pct = (n: number | null | undefined, dp = 1) => (n == null ? "—" : `${n.toFixed(dp)}%`);
const cents = (n: number | null | undefined) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}¢`);
const col = (n: number | null | undefined) => (n == null ? TEXT : n >= 0 ? GREEN : RED);

function ZoneTable({ title, rows }: { title: string; rows: any[] }) {
  return (
    <div>
      <div style={{ ...S.sub, marginBottom: 4 }}>{title}</div>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 460 }}>
        <thead><tr>{["зона edge", "N", "ROI", "ср. CLV", "hit-rate", "ср. implied", "model-fill"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((z) => (
            <tr key={z.zone}>
              <td style={S.td}>{z.zone}</td>
              <td style={S.td}>{z.n}</td>
              <td style={{ ...S.td, color: col(z.roi) }}>{pct(z.roi)}</td>
              <td style={{ ...S.td, color: col(z.avgClvCents) }}>{cents(z.avgClvCents)}</td>
              <td style={S.td}>{pct(z.hitRate)}</td>
              <td style={{ ...S.td, color: MUTE }}>{pct(z.avgImplied)}</td>
              <td style={{ ...S.td, color: (z.modelFillPct ?? 0) > 0 ? AMBER : MUTE }} title={`${z.earlyExits} досрочных выходов`}>{z.modelFillPct == null ? "—" : pct(z.modelFillPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ProfilesScreen() {
  const [data, setData] = useState<any>(null);
  const [vocab, setVocab] = useState<{ categories: any[]; strategies: any[] }>({ categories: [], strategies: [] });
  const [f, setF] = useState<{ competitionId: string; strategyId: string; phase: string; codeVersion: string }>({ competitionId: "", strategyId: "", phase: "", codeVersion: "" });
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const j = await r.json();
      if (j.ok) { setData(j.analytics); setVocab(j.vocab); }
    } catch { /* keep last */ } finally { setLoading(false); }
  }, [f]);
  useEffect(() => { load(); }, [load]);

  const exportUrl = useMemo(() => {
    const q = new URLSearchParams();
    if (f.competitionId) q.set("competitionId", f.competitionId);
    if (f.strategyId) q.set("strategyId", f.strategyId);
    if (f.phase) q.set("phase", f.phase);
    if (f.codeVersion) q.set("codeVersion", f.codeVersion);
    return (type: string) => { q.set("type", type); return `/api/profiles-export?${q.toString()}`; };
  }, [f]);

  const cmp = data?.comparison ?? [];
  const edge = data?.edge;
  const cal = data?.calibration;
  const tl = data?.tails;

  return (
    <main style={S.wrap}>
      <div>
        <div style={S.h1}>Профили</div>
        <div style={S.sub}>Измерительная витрина 4 риск-профилей — из лога ставок. Не оптимизатор: показывает, человек решает.</div>
      </div>

      <div style={S.note}>
        <b>Одинаковые кандидаты (Модель А).</b> У всех профилей ОБЩИЕ picks стратегии — разница только в фильтре по edge и сайзинге. Поэтому сравнение честное: это про то, как один и тот же поток идей отрабатывает под разной агрессией.
      </div>

      {/* FILTERS */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={S.sel} value={f.competitionId} onChange={(e) => setF({ ...f, competitionId: e.target.value })}>
          <option value="">все категории</option>
          {vocab.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={S.sel} value={f.strategyId} onChange={(e) => setF({ ...f, strategyId: e.target.value })}>
          <option value="">все стратегии</option>
          {vocab.strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select style={S.sel} value={f.phase} onChange={(e) => setF({ ...f, phase: e.target.value })}>
          <option value="">все фазы</option><option value="prematch">предматч</option><option value="live">лайв</option>
        </select>
        <select style={S.sel} value={f.codeVersion} onChange={(e) => setF({ ...f, codeVersion: e.target.value })}>
          <option value="">все версии кода</option>
          {(data?.codeVersions ?? []).map((v: string) => <option key={v} value={v}>{v}</option>)}
        </select>
        <span style={{ color: MUTE, fontSize: 12 }}>{loading ? "…" : `${data?.totalBets ?? 0} ставок`}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <a style={S.btn} href={exportUrl("bets-csv")}>Экспорт ставок CSV</a>
          <a style={S.btn} href={exportUrl("bets-json")}>JSON</a>
          <a style={S.btn} href={exportUrl("exits-csv")}>Выходы CSV</a>
        </div>
      </div>

      {/* BLOCK A */}
      <div>
        <div style={S.secLbl}>A · Сравнение профилей</div>
        <div style={S.card}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 720 }}>
            <thead><tr>{["профиль", "ставок", "объём", "PnL", "ROI", "ср. CLV", "% побил закрытие", "макс. просадка", "серия убытков", "Sharpe", "model-fill"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {cmp.length === 0 && <tr><td colSpan={11} style={{ ...S.td, color: MUTE, textAlign: "center", padding: 20 }}>Пока нет закрытых ставок под этот фильтр.</td></tr>}
              {cmp.map((p: any) => (
                <tr key={p.profileId}>
                  <td style={{ ...S.td, fontWeight: 700 }}>{p.profileId}</td>
                  <td style={S.td}>{p.bets}</td>
                  <td style={S.td}>{money(p.volume)}</td>
                  <td style={{ ...S.td, color: col(p.pnl) }}>{money(p.pnl)}</td>
                  <td style={{ ...S.td, color: col(p.roi) }}>{pct(p.roi)}</td>
                  <td style={{ ...S.td, color: col(p.avgClvCents) }}>{cents(p.avgClvCents)}</td>
                  <td style={S.td}>{pct(p.pctBeatClose)}</td>
                  <td style={{ ...S.td, color: RED }}>{money(p.maxDrawdown)}</td>
                  <td style={S.td}>{p.longestLossStreak}</td>
                  <td style={S.td}>{p.sharpe == null ? "—" : p.sharpe.toFixed(2)}</td>
                  <td style={{ ...S.td, color: (p.modelFillPct ?? 0) > 0 ? AMBER : MUTE }} title={`${p.earlyExits ?? 0} досрочных выходов`}>{p.modelFillPct == null ? "—" : pct(p.modelFillPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cmp.length > 0 && (
            <div style={{ ...S.sub, marginTop: 10 }}>
              Выходы по типу триггера:{" "}
              {cmp.map((p: any) => <span key={p.profileId} style={{ marginRight: 14 }}><b>{p.profileId}:</b> {Object.entries(p.triggerMix).map(([k, v]) => `${k} ${v}%`).join(" · ") || "—"}</span>)}
            </div>
          )}
        </div>
      </div>

      {/* BLOCK B */}
      <div>
        <div style={S.secLbl}>B · Зоны edge (→ вывод для min_edge)</div>
        <div style={S.card}>
          <div style={{ ...S.sub, marginBottom: 10 }}>Где CLV систематически ≤ 0 — ниже этой зоны min_edge бессмыслен (рынок уже прав). Смотри отдельно предматч/лайв и тонкие/ликвидные рынки.</div>
          {edge && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
              <ZoneTable title="Все" rows={edge.all} />
              <ZoneTable title="Предматч" rows={edge.prematch} />
              <ZoneTable title="Лайв" rows={edge.live} />
              <ZoneTable title={`Тонкие рынки (< $${edge.thinThresholdUsd})`} rows={edge.thin} />
              <ZoneTable title={`Ликвидные (≥ $${edge.thinThresholdUsd})`} rows={edge.liquid} />
            </div>
          )}
        </div>
      </div>

      {/* BLOCK C */}
      <div>
        <div style={S.secLbl}>C · Калибровка (→ безопасная Kelly, выводит человек)</div>
        <div style={S.card}>
          {cal && (<>
            <div style={{ ...S.sub, marginBottom: 8 }}>Brier общий: <b style={{ color: TEXT }}>{cal.brier == null ? "—" : cal.brier.toFixed(3)}</b> (ниже = лучше) · N={cal.n}. По срезам:{" "}
              {Object.entries(cal.bySlice).map(([k, v]: any) => <span key={k} style={{ marginRight: 10 }}>{k} {v.brier == null ? "—" : v.brier.toFixed(3)} (N{v.n})</span>)}
            </div>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 520 }}>
              <thead><tr>{["бин вероятности", "заявлено (ср.)", "фактическая частота", "N", "смещение"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {cal.bins.map((b: any, i: number) => {
                  const bias = b.predicted != null && b.actual != null ? (b.predicted - b.actual) : null;
                  return (
                    <tr key={i}>
                      <td style={S.td}>{Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%</td>
                      <td style={S.td}>{b.predicted == null ? "—" : `${Math.round(b.predicted * 100)}%`}</td>
                      <td style={S.td}>{b.actual == null ? "—" : `${Math.round(b.actual * 100)}%`}</td>
                      <td style={{ ...S.td, color: MUTE }}>{b.n}</td>
                      <td style={{ ...S.td, color: bias == null ? MUTE : Math.abs(bias) < 0.05 ? MUTE : bias > 0 ? RED : GREEN }}>
                        {bias == null ? "—" : bias > 0 ? `переоценка +${Math.round(bias * 100)}пп` : `недооценка ${Math.round(bias * 100)}пп`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>)}
        </div>
      </div>

      {/* BLOCK D */}
      <div>
        <div style={S.secLbl}>D · Хвосты и стопы</div>
        <div style={S.card}>
          {tl && (<>
            <div style={{ ...S.sub, marginBottom: 6 }}>Hard-stop против финала рынка: {tl.hardStopVsFinal.n} стопов · спасли {tl.hardStopVsFinal.savedByStop} · срезали зря {tl.hardStopVsFinal.cutInError} · средн. (финал − стоп) {cents(tl.hardStopVsFinal.avgFinalMinusStopCents)}</div>
            <div style={{ ...S.sub, marginBottom: 8 }}>Макс. просадка по профилям: {Object.entries(tl.drawdownByProfile).map(([k, v]: any) => `${k} ${money(v)}`).join(" · ")}</div>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 620 }}>
              <thead><tr>{["матч", "рынок", "профиль", "P&L", "триггер выхода", "финал"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {tl.worst.length === 0 && <tr><td colSpan={6} style={{ ...S.td, color: MUTE }}>—</td></tr>}
                {tl.worst.map((w: any, i: number) => (
                  <tr key={i}>
                    <td style={{ ...S.td, fontFamily: "inherit" }} title={w.matchLabel}>{w.matchLabel.length > 26 ? w.matchLabel.slice(0, 25) + "…" : w.matchLabel}</td>
                    <td style={{ ...S.td, fontFamily: "inherit" }}>{w.market}</td>
                    <td style={S.td}>{w.profileId}</td>
                    <td style={{ ...S.td, color: RED }}>{money(w.pnl)}</td>
                    <td style={S.td}>{w.trigger}</td>
                    <td style={{ ...S.td, color: MUTE }}>{w.finalScore ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>)}
        </div>
      </div>
    </main>
  );
}
