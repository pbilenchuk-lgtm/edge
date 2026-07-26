// ============================================================
// EDGE LAB — WHY IS THE PRE-MATCH PASS STILL LATE?  [R3 follow-up]
//
// The post-deploy read said 41.7% of analyses landed before the whistle, median margin −1′. The anchor lane
// (60′ window, own per-tick budget) was supposed to fix exactly that, so either the lane is not reaching these
// fixtures or something downstream of it refuses them.
//
// There is an obvious suspect, and this script exists to CONVICT OR ACQUIT it rather than to assume it:
// autoAnalyze skips a football match while `awaitingLineup` is true — state upcoming/lineup and no populated
// starting XI on both sides. A fixture whose lineup feed never publishes is therefore not late by accident;
// it is structurally unanalysable until it goes live, at which point state='live' clears the gate, the pass
// finally runs, and the decision is stamped origin='live' — the very stamp that made ft_blind refuse.
//
// If that is the mechanism, the late set should be almost entirely LINEUP-LESS and the on-time set almost
// entirely lineup-bearing. If the two look alike, the suspect is innocent and the cause is elsewhere — a
// possibility this script is built to be able to show.
//
// Read-only.
//   node --experimental-sqlite --import tsx scripts/anchor-diagnose.ts [--since=ISO]
// ============================================================
import { openDb, dbPath } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { ANCHOR_OPEN_MIN } from "../src/lib/prematchAnchor.js";

const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8)
  ?? new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
const db = openDb(dbPath());

const rows = db.prepare(
  `SELECT a.created_at AS analysed_at, a.stage, m.id, m.home, m.away, m.kickoff_at, m.state, m.competition_id,
          c.name AS comp, c.sport_id AS sport
     FROM assessments a
     JOIN matches m ON m.id = a.match_id
     LEFT JOIN competitions c ON c.id = m.competition_id
    WHERE a.status = 'ok' AND a.created_at >= ? AND m.kickoff_at IS NOT NULL
    ORDER BY a.created_at`,
).all(since) as any[];

console.log(`# ПОЧЕМУ ПРЕДМАТЧ ОПАЗДЫВАЕТ · окно с ${since}`);
console.log(`якорное окно: T−${ANCHOR_OPEN_MIN()}′ … свисток\n`);
if (!rows.length) { console.log("нет успешных анализов в окне."); process.exit(0); }

interface Row { late: boolean; gap: number; lineups: boolean; liveRow: boolean; r: any }
const data: Row[] = rows.map((r) => {
  const gap = (Date.parse(r.kickoff_at) - Date.parse(r.analysed_at)) / 60000; // + = before whistle
  const live = R.getMatchLive(db, r.id);
  return { late: gap <= 0, gap, lineups: R.hasLineups(db, r.id), liveRow: !!live, r };
});

// ── The cross-tab that decides it ────────────────────────────────────────────────────────────────
// Lineups are read NOW, not at analysis time — a teamsheet that landed later would make an on-time-looking
// row read as lineup-bearing. That biases the table AGAINST the hypothesis (late matches get extra time to
// acquire lineups), so a clean separation despite the bias is strong evidence, and a muddy one is not proof
// of innocence. Stated here because the limitation changes how the numbers may be used.
const cell = (late: boolean, lu: boolean) => data.filter((d) => d.late === late && d.lineups === lu).length;
console.log(`## Опоздание × наличие состава (состав читается СЕЙЧАС — см. оговорку в коде)`);
console.log(`| | состав есть | состава нет |`);
console.log(`|---|---|---|`);
console.log(`| **до свистка** | ${cell(false, true)} | ${cell(false, false)} |`);
console.log(`| **после свистка** | ${cell(true, true)} | ${cell(true, false)} |`);

const late = data.filter((d) => d.late), ontime = data.filter((d) => !d.late);
const pct = (a: number, b: number) => (b ? `${Math.round((1000 * a) / b) / 10}%` : "—");
console.log(`\nопоздавших: ${late.length}/${data.length}; из них БЕЗ состава: ${late.filter((d) => !d.lineups).length} (${pct(late.filter((d) => !d.lineups).length, late.length)})`);
console.log(`вовремя: ${ontime.length}; из них без состава: ${ontime.filter((d) => !d.lineups).length} (${pct(ontime.filter((d) => !d.lineups).length, ontime.length)})`);
console.log(`опоздавших вообще без match_live-строки (нет привязки к фиду): ${late.filter((d) => !d.liveRow).length}`);

// ── Verdict, stated as a claim that can be wrong ─────────────────────────────────────────────────
const lateNoLu = late.length ? late.filter((d) => !d.lineups).length / late.length : 0;
const onTimeNoLu = ontime.length ? ontime.filter((d) => !d.lineups).length / ontime.length : 0;
console.log(`\n## Вердикт`);
if (late.length < 5) console.log(`опоздавших слишком мало (${late.length}) — на этой выборке ничего не доказывается.`);
else if (lateNoLu >= 0.7 && lateNoLu - onTimeNoLu >= 0.3)
  console.log(`ПОДТВЕРЖДЕНО: опоздание — это lineup-гейт, а не нехватка тиков. Якорная полоса даёт слот, но\n` +
    `\`awaitingLineup\` отклоняет матч, пока не вышли составы; матч без фида составов становится анализируемым\n` +
    `ровно тогда, когда стартовал (state='live' снимает гейт) — и решение получает origin='live'.\n` +
    `Больше слотов это не лечит: чинить надо сам гейт, а не расписание.`);
else if (lateNoLu <= onTimeNoLu + 0.1)
  console.log(`ОПРАВДАН: у опоздавших состав есть примерно так же часто, как у успевших — lineup-гейт ни при чём.\n` +
    `Причину искать в другом месте (бюджет тика, фандинг лиги, окно ANALYZE_PRE_HOURS, задержка провайдера).`);
else console.log(`СМЕШАННО: lineup-гейт объясняет часть опозданий (${pct(late.filter((d) => !d.lineups).length, late.length)} против ${pct(ontime.filter((d) => !d.lineups).length, ontime.length)} у успевших), но не всё. Чинить обе стороны нельзя вслепую — нужен ещё один срез.`);

// ── Where the late ones live: a league concentration is a different fix from a global one ────────
const byComp = new Map<string, { late: number; total: number }>();
for (const d of data) {
  const k = `${d.r.comp ?? d.r.competition_id}`;
  const e = byComp.get(k) ?? { late: 0, total: 0 };
  e.total++; if (d.late) e.late++;
  byComp.set(k, e);
}
console.log(`\n## По турнирам (опоздавших / всего)`);
for (const [k, v] of [...byComp.entries()].sort((a, b) => b[1].late - a[1].late).slice(0, 15))
  console.log(`  ${v.late}/${v.total}  ${k}`);

console.log(`\n## Опоздавшие поимённо (мин ПОСЛЕ свистка)`);
for (const d of late.sort((a, b) => a.gap - b.gap).slice(0, 25))
  console.log(`  ${String(Math.round(-d.gap)).padStart(3)}′  ${d.r.home}–${d.r.away}  [состав: ${d.lineups ? "есть" : "НЕТ"}, match_live: ${d.liveRow ? "есть" : "НЕТ"}, стадия: ${d.r.stage}]`);

// ── The margin distribution: a lane that works should leave a fat pre-whistle tail ───────────────
const g = data.map((d) => d.gap).sort((a, b) => a - b);
const qq = (p: number) => Math.round(g[Math.min(g.length - 1, Math.floor(p * g.length))]);
console.log(`\n## Запас до свистка, минуты (отрицательное = опоздал)`);
console.log(`  p10 ${qq(0.1)}  p25 ${qq(0.25)}  медиана ${qq(0.5)}  p75 ${qq(0.75)}  p90 ${qq(0.9)}`);
console.log(`  внутри якорного окна (0…${ANCHOR_OPEN_MIN()}′ до старта): ${data.filter((d) => d.gap > 0 && d.gap <= ANCHOR_OPEN_MIN()).length}`);
console.log(`  раньше якорного окна (> ${ANCHOR_OPEN_MIN()}′ до старта): ${data.filter((d) => d.gap > ANCHOR_OPEN_MIN()).length}`);
