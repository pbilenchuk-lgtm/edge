// ─────────────────────────────────────────────────────────────────────────────
// EDGE LAB — SCOUT GAP diagnostic. Answers the one question about a tennis-scout
// outage (the 933-min hole): was it the SCOUT LOOP dying independently, or the whole
// CRON / process being down? Reads only recorded data — no guessing.
//
//   EDGE_DB_PATH=/app/data/edge-compact.db node --experimental-sqlite --import tsx scripts/scout-gap.ts
//
// Method: find the largest gap between consecutive tennis_snapshots rows, then ask —
// during that window, was the PROCESS demonstrably alive? The cron_log gets a row every
// full scheduler pass (tick/discover/heartbeat), and football market snapshots land on
// the same loop. So:
//   • cron_log / football rows DID land inside the gap  → process ALIVE, scout died
//     INDEPENDENTLY (a persistent collectTennisSnapshots throw, swallowed by stepLive,
//     or a provider that kept returning empty). Look for [liveCycle:tennisScout] /
//     [autoCycle:tennisScout] errors in the Render log for that window.
//   • NOTHING landed inside the gap                      → CRON / PROCESS DOWN (the
//     in-process setInterval wasn't running — Render idled/restarted the web service, or
//     a deploy crash-loop). The heartbeat can't self-recover a process that isn't alive.
// Cross-check the verdict against the external monitor's ping history for the same window.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "../src/lib/db.js";

const db = getDb();
const MIN_GAP_MIN = Number(process.env.SCOUT_GAP_MIN) || 30; // report gaps ≥ this
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const ms = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0);

const rows = db.prepare(`SELECT batch_at FROM tennis_snapshots ORDER BY batch_at`).all() as { batch_at: string }[];
if (rows.length < 2) { console.log("(недостаточно tennis_snapshots для анализа пробелов)"); process.exit(0); }

// Every gap between consecutive scout writes, largest first.
const gaps: { fromMs: number; toMs: number; min: number }[] = [];
for (let i = 1; i < rows.length; i++) {
  const a = ms(rows[i - 1].batch_at), b = ms(rows[i].batch_at);
  const gapMin = (b - a) / 60_000;
  if (gapMin >= MIN_GAP_MIN) gaps.push({ fromMs: a, toMs: b, min: Math.round(gapMin) });
}
gaps.sort((x, y) => y.min - x.min);

const firstScout = ms(rows[0].batch_at), lastScout = ms(rows[rows.length - 1].batch_at);
console.log(`Скаут: ${rows.length} снапшотов, с ${iso(firstScout)} по ${iso(lastScout)}.`);
console.log(`Пробелов ≥ ${MIN_GAP_MIN} мин: ${gaps.length}.\n`);

// For a window, is there independent evidence the PROCESS was alive? cron_log rows and
// football market snapshots both ride the SAME in-process loop the scout does.
const aliveEvidence = (fromMs: number, toMs: number) => {
  const cron = db.prepare(`SELECT kind, at, created_at, summary FROM cron_log WHERE created_at > ? AND created_at < ? ORDER BY created_at`).all(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as { kind: string; created_at: string; summary: string }[];
  const mkt = db.prepare(`SELECT COUNT(*) n FROM markets WHERE snapshot_at > ? AND snapshot_at < ?`).get(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as { n: number };
  return { cron, footballSnaps: mkt.n };
};

for (const g of gaps.slice(0, 5)) {
  const ev = aliveEvidence(g.fromMs, g.toMs);
  const alive = ev.cron.length > 0 || ev.footballSnaps > 0;
  console.log(`━━ пробел ${g.min} мин: ${iso(g.fromMs)} → ${iso(g.toMs)}`);
  console.log(`   внутри окна: cron_log ${ev.cron.length} записей · футбол-снапшотов ${ev.footballSnaps}`);
  if (ev.cron.length) {
    const kinds = ev.cron.reduce((a, c) => ((a[c.kind] = (a[c.kind] ?? 0) + 1), a), {} as Record<string, number>);
    console.log(`   виды cron: ${Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(", ")}`);
  }
  if (alive) {
    console.log(`   ВЕРДИКТ: ПРОЦЕСС БЫЛ ЖИВ → скаут умер НЕЗАВИСИМО (луп/провайдер).`);
    console.log(`            → ищи в логе Render строки [liveCycle:tennisScout] / [autoCycle:tennisScout] за это окно;`);
    console.log(`              если их нет — collectTennisSnapshots возвращал 0 без ошибки (провайдер отдавал пусто / нет API-ключа).`);
  } else {
    console.log(`   ВЕРДИКТ: НИЧЕГО не крутилось в окне → КРОН/ПРОЦЕСС ЛЕЖАЛ (setInterval не работал — Render усыпил/рестартил сервис).`);
    console.log(`            → хартбит не может поднять мёртвый процесс; нужен внешний пингер /api/health или always-on план.`);
  }
  console.log("");
}

console.log("Сверь вердикт с историей пингов внешнего монитора за то же окно: пинги отвечали → процесс жив (луп); пинги падали → процесс лежал (крон).");
