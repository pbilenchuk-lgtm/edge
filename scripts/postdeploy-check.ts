// ============================================================
// EDGE LAB — POST-DEPLOY VERIFICATION PASS
//
// Everything shipped in batches 9–10 was written against logs, not against a running system. This script is
// the counter-check: it asks the DEPLOYED process what it actually sees and what it has actually done, so a
// repair is confirmed by its footprint rather than by the diff that introduced it.
//
// Three parts, deliberately separate:
//   §1 CONFIG READBACK  — what the live process reads from env. A gate whose flag is mistyped is not a gate,
//                         and that failure mode has already cost us once (FT_BLIND_ENABLED).
//   §2 RETRO NET-EV     — the two tennis entries taken while PR #46 was merged but undeployed, re-scored
//                         through the gate that was supposed to be guarding them. A line for the report.
//   §3 LIVE-FIRE        — did each batch-10 repair leave a footprint since the deploy? Silence here is not
//                         success: it means the path has not been exercised and remains unverified.
//
// Nothing is written to the DB. Read-only.
//
//   node --experimental-sqlite --import tsx scripts/postdeploy-check.ts [--since=ISO]
// ============================================================
import { openDbReadOnly, dbPath } from "../src/lib/db.js";
import { CODE_VERSION } from "../src/lib/betMeta.js";
import { pmvNetEvCents } from "../src/lib/tennisPmv.js";
import { isFtBlindBet } from "../src/lib/betMeta.js";
import { buildDrawCanonProbe } from "../src/lib/drawCanonProbe.js";

const argSince = process.argv.find((a) => a.startsWith("--since="))?.slice(8);
const since = argSince ?? new Date(Date.now() - 24 * 3600_000).toISOString();
// The moment the CURRENT build started serving. §3 counts footprints of code that only exists after it, so a
// window that opens earlier mixes old-code behaviour into a "did the repair fire?" answer — and reads as if a
// repair made things worse when the rows predate it. Separate knob, because --since is also used to size the
// cohort in §2/§4, where pre-deploy history is exactly what we want.
const deployedAt = process.argv.find((a) => a.startsWith("--deployed="))?.slice(11);
const fireSince = deployedAt && deployedAt > since ? deployedAt : since;
const fireHours = Math.round(((Date.now() - Date.parse(fireSince)) / 3600_000) * 10) / 10;
const db = openDbReadOnly(dbPath());
const out: string[] = [];
const P = (s = "") => out.push(s);

const q = <T = any>(sql: string, ...args: any[]): T[] => {
  try { return db.prepare(sql).all(...args) as T[]; } catch (e) { P(`  ⚠ запрос не выполнен: ${(e as Error).message}`); return []; }
};
const n1 = (sql: string, ...args: any[]): number => (q<{ n: number }>(sql, ...args)[0]?.n ?? 0);

P(`# POST-DEPLOY CHECK · ${new Date().toISOString()}`);
P(`окно «после деплоя»: с ${since}`);
P(`БД: ${dbPath()}`);
P();

// ── §1 CONFIG READBACK ────────────────────────────────────────────────────────────────────────────
// Printed as the process SEES it, including the parsed interpretation — the raw string alone hides the
// class of bug where "TRUE" or " true" reads as false.
P(`## §1. Что видит живой процесс`);
P(`epoch (CODE_VERSION): **${CODE_VERSION}**`);
const flag = (name: string, dflt: string, parse?: (v: string | undefined) => string) => {
  const raw = process.env[name];
  const shown = raw === undefined ? `(не задан → ${dflt})` : JSON.stringify(raw);
  P(`- \`${name}\` = ${shown}${parse ? ` → **${parse(raw)}**` : ""}`);
};
flag("FT_BLIND_ENABLED", "false", (v) => ((v ?? "false").toLowerCase() === "true" ? "ВКЛ" : "выкл"));
flag("FT_BLIND_LIVE_GRACE_MIN", "5");
flag("TENNIS_PMV_FLAG_ONLY", "false", (v) => ((v ?? "false").toLowerCase() === "true" ? "ТОЛЬКО ФЛАГИ (денег нет)" : "деньги разрешены"));
flag("TENNIS_PMV_EV_MARGIN_CENTS", "2");
flag("TENNIS_PMV_EV_FILL_DRIFT_CENTS", "0");
flag("POLYMARKET_TAKER_FEE_RATE", "0.02");
flag("QUASI_LOCK_MIN_MINUTE", "80");
flag("PARTIAL_DUST_FLOOR_USD", "5");
flag("THESIS_BANK_USD", "1000");
flag("THESIS_MATCH_CAP_FRAC", "0.25");
flag("THESIS_DAILY_CLUSTER_MULT", "2");
flag("REFUSAL_SHADOW_EDGE_MIN", "0.05");
P();

// ── §2 RETRO NET-EV ───────────────────────────────────────────────────────────────────────────────
// The gate (PR #46) existed in code but not in the running process when these entries were taken. Re-score
// them now: this does NOT change any money — it answers whether the gate would have saved us or cost us.
P(`## §2. Ретро-прогон net-EV гейта по теннисным входам, сделанным до деплоя #46`);
const pmv = q<any>(
  `SELECT b.id, b.market_label, b.entry_price, b.ai_prob, b.stake, b.status, b.result, b.payout,
          b.entry_meta, b.created_at, b.code_version, m.home, m.away
     FROM bets b JOIN matches m ON m.id = b.match_id
    WHERE b.strategy_id = 'tennis_pmv' AND b.status <> 'not_filled'
    ORDER BY b.created_at DESC LIMIT 50`,
);
if (!pmv.length) P(`нет ставок tennis_pmv в базе — ретро-прогон нечего считать.`);
else {
  // COLLAPSE THE PROFILE FAN-OUT (R0.1 units). One decision placed across four risk profiles is four ROWS
  // but one SIGNAL, and the gate is a per-decision object: it either cut that candidate or it did not. Listing
  // the rows makes a handful of decisions look like a sample. Money still sums over rows — that part is real.
  type Sig = { rows: any[]; theo: number; mid: number };
  const sig = new Map<string, Sig>();
  const orphans: any[] = [];
  for (const b of pmv) {
    let meta: any = null; try { meta = b.entry_meta ? JSON.parse(b.entry_meta) : null; } catch { /* legacy row */ }
    const theo = meta?.derivedProb != null ? meta.derivedProb * 100 : (b.ai_prob != null ? b.ai_prob * 100 : null);
    const mid = meta?.marketPrice ?? b.entry_price;
    if (theo == null || mid == null) { orphans.push(b); continue; }
    const k = `${b.created_at}|${b.home}|${b.market_label}`;
    const e: Sig = sig.get(k) ?? { rows: [], theo: Math.round(theo * 10) / 10, mid };
    e.rows.push(b); sig.set(k, e);
  }
  P(`| время | матч | рынок | theo | mid | gross | комиссия | net | вердикт гейта | профилей | факт P&L |`);
  P(`|---|---|---|---|---|---|---|---|---|---|---|`);
  let cutN = 0, cutPnl = 0, passN = 0, passPnl = 0, openLegs = 0;
  for (const [, e] of sig) {
    const ev = pmvNetEvCents(e.theo, e.mid);
    let pnl = 0, decided = 0;
    for (const b of e.rows) {
      if (String(b.status).startsWith("settled")) { pnl += (b.payout ?? 0) - (b.stake ?? 0); decided++; } else openLegs++;
    }
    pnl = Math.round(pnl * 100) / 100;
    if (ev.pass) { passN++; passPnl += pnl; } else { cutN++; cutPnl += pnl; }
    const b0 = e.rows[0];
    P(`| ${b0.created_at} | ${b0.home}–${b0.away} | ${b0.market_label} | ${e.theo}¢ | ${e.mid}¢ | ${ev.grossCents}¢ | ${ev.feeCents}¢ | ${ev.netCents}¢ | ${ev.pass ? "прошёл бы" : `**СРЕЗАН** (< ${ev.marginCents}¢)`} | ${e.rows.length} | ${decided ? `$${pnl}` : "открыта"} |`);
  }
  for (const b of orphans) P(`| ${b.created_at} | ${b.home}–${b.away} | ${b.market_label} | — | — | — | — | — | нет meta | 1 | — |`);
  P();
  P(`**${sig.size} решений** (${pmv.length} строк ставок — фан-аут по профилям схлопнут; ${orphans.length} без meta).`);
  P(`Гейт срезал бы **${cutN}** из ${sig.size}. P&L срезанных: **$${Math.round(cutPnl * 100) / 100}** ` +
    `(положительное = гейт стоил бы денег на этой выборке, отрицательное = сберёг). ` +
    `P&L прошедших: $${Math.round(passPnl * 100) / 100}. Открытых ног: ${openLegs}.`);
  if (cutN === 0) P(`⚠ Гейт не срезал НИЧЕГО: при марже ${pmvNetEvCents(50, 50).marginCents}¢ он лежит сильно ниже ` +
    `распределения отклонений и на этой выборке ни разу не связывал. Это не «защита сработала» — это «защита не включалась». ` +
    `Двигать маржу без данных всё равно нельзя, но и считать её работающей нельзя.`);
  P(`Выборка мала и НЕ является проверкой гипотезы — это строка в отчёт, а не основание двигать порог.`);
}
P();

// ── §3 LIVE-FIRE ──────────────────────────────────────────────────────────────────────────────────
// Each repair gets: did it fire, and how often. A zero is reported as UNVERIFIED, never as "fine" — an
// untriggered path is an untested path, and several of these were shipped precisely because a count was 0.
P(`## §3. Следы починок batch-10 после деплоя (с ${fireSince}, это ${fireHours} ч)`);
if (!deployedAt) P(`⚠ \`--deployed=ISO\` не передан: окно может захватывать время ДО текущей сборки, и тогда цифры ниже\n` +
  `описывают старый код, а не починку. Передайте момент выкатки, иначе §3 не читается как проверка.`);
if (fireHours < 2) P(`⚠ Сборка живёт всего ${fireHours} ч. Нули ниже означают «не успело сработать», а НЕ «не работает».\n` +
  `Осмысленное чтение — не раньше чем через сутки, тем же ключом \`--deployed\`.`);
const line = (name: string, count: number, note: string) =>
  P(`- **${name}**: ${count === 0 ? `0 — ⚠ путь НЕ прошёл, починка НЕ подтверждена` : `${count}`} — ${note}`);

// Counts are NOT comparable across windows of different length, and the zombie baseline was taken over ~8
// hours while this window is whatever the deploy marker makes it. Comparing 953 to a 20-hour number would
// «prove» the hysteresis made things worse — the same units error this project keeps having to fix. So the
// baseline is stored as a RATE, measured once and named here, and the report does the division itself
// instead of trusting whoever reads it to remember.
const BASE = { hours: 7.96, quarantine: 953, lifted: 745, at: "2026-07-25T18:00Z…2026-07-26T01:57Z (до гистерезиса)" };
const rateLine = (name: string, count: number, baseCount: number, note: string) => {
  const rate = fireHours > 0 ? Math.round((count / fireHours) * 10) / 10 : null;
  const baseRate = Math.round((baseCount / BASE.hours) * 10) / 10;
  // A LITERAL zero is not a win. Dropping from ~120/hour to exactly none is not what a hysteresis margin
  // does — it is what an empty table, a stopped tick loop or a wrong DB path does. Read as «improvement» it
  // would certify a dead system as a fixed one, which is the same fail-open the P5 panic gate had. So zero
  // gets the suspicion, and a real improvement has to show a real, non-zero, smaller rate.
  const verdict = rate == null ? ""
    : count === 0 ? " → ⚠ РОВНО НОЛЬ — это не победа: так же выглядит остановленный тик или пустая база. Проверить, что цикл вообще работал"
    : rate <= baseRate * 0.7 ? " → **ЗАМЕТНО МЕНЬШЕ**"
    : rate >= baseRate * 1.3 ? " → **БОЛЬШЕ базы** (гистерезис не помог — разбираться)"
    : " → в пределах базы (изменения не видно)";
  P(`- **${name}**: ${count} за ${fireHours} ч = **${rate}/час** против базы **${baseRate}/час**${verdict}`);
  P(`    ${note} · база: ${BASE.at}`);
};

// TWO INDEPENDENT READINGS, on purpose. The first version of this counter looked for the string "ft_blind"
// in bets.rationale — a field the entry path never writes it to (the mark goes to entry_meta.ftBlind and to
// a trade_log line). It would have reported 0 forever while the mode worked perfectly, which is exactly the
// mistake already made once in PR #49: a diagnostic that guesses the wrong field is worse than none, because
// it manufactures a false negative and sends the next investigation down a dead end.
//
// So the authoritative read now uses the SAME helper the money path and the cohort reports use, and the
// trade_log line is kept alongside as an independent witness. If the two ever disagree, that disagreement is
// itself the finding — one of the two writes is missing.
const ftBlindBets = q<any>(`SELECT entry_meta FROM bets WHERE created_at >= ?`, fireSince).filter(isFtBlindBet).length;
const ftBlindLogs = n1(`SELECT COUNT(*) n FROM trade_log WHERE created_at >= ? AND text LIKE '%ft_blind%'`, fireSince);
line("ft_blind входы (entry_meta.ftBlind — источник истины)", ftBlindBets,
  `V0.1: до деплоя было ровно 0 из-за origin='live' на опоздавшем анализе`);
P(`    свидетель из trade_log: ${ftBlindLogs} строк${ftBlindBets !== ftBlindLogs ? ` — ⚠ РАСХОЖДЕНИЕ с ${ftBlindBets}: одна из двух записей не делается, это отдельный баг` : ""}`);
// A zero here is only informative once it can be ATTRIBUTED. "No blind fixture existed" and "blind fixtures
// existed, were analysed in time, and still produced nothing" are opposite conclusions with the same count,
// and treating them alike is how V0.1 stayed unexplained for a whole batch. So the funnel is printed.
const blindFunnel = q<any>(
  `SELECT m.id, m.home, m.away, m.kickoff_at,
          (SELECT COUNT(*) FROM match_live ml WHERE ml.match_id = m.id)  AS live_rows,
          (SELECT COUNT(*) FROM markets mk WHERE mk.match_id = m.id)      AS mkts,
          (SELECT MIN(a.created_at) FROM assessments a WHERE a.match_id = m.id AND a.status='ok') AS first_ok
     FROM matches m JOIN competitions c ON c.id = m.competition_id
    WHERE c.budget > 0 AND m.kickoff_at >= ? AND c.sport_id = 'football'`, fireSince);
// KICKOFF MUST HAVE HAPPENED. The query bounds kickoff_at from BELOW only, so it also collects every fixture
// imported for next week. Those are unanalysed because their turn has not come — counting them as misses
// turned a healthy funnel into «166 слепых → 10 проанализировано», i.e. a 94% loss that does not exist. The
// number was about to send the next investigation into the scheduler. A fixture can only be judged on whether
// it was analysed once its kickoff is in the past.
const nowIso = new Date().toISOString();
const blindAll = blindFunnel.filter((r) => r.live_rows === 0 && r.mkts > 0);
const blind = blindAll.filter((r) => r.kickoff_at < nowIso);
const upcoming = blindAll.length - blind.length;
const blindAnalysed = blind.filter((r) => r.first_ok);
const blindInTime = blindAnalysed.filter((r) => r.first_ok < r.kickoff_at);
P(`    воронка слепых фикстур в окне: ${blind.length} слепых с котировками (кикофф уже был) → ${blindAnalysed.length} проанализировано → **${blindInTime.length} успело ДО свистка**`);
if (upcoming) P(`    (+${upcoming} слепых с кикоффом ВПЕРЕДИ — их черёд ещё не настал, в воронку не идут)`);
P(blind.length === 0
  ? `    → слепых фикстур в окне просто НЕ БЫЛО: ноль выше ничего не говорит про режим, нужен слейт с ними`
  : blindInTime.length === 0
    ? `    → анализ по-прежнему не успевает к слепым: чинить дальше вход, а не режим`
    : `    → анализ успевает, но входов нет: узкое место ПОСЛЕ анализа (стратег не предлагает, сайзинг режет, нет FT-рынка или упирается в кэп) — вот где копать`);
line("net_ev_cut (теннис)", n1(
  `SELECT COUNT(*) n FROM trade_log WHERE created_at >= ? AND text LIKE 'net_ev_cut%'`, fireSince),
  `гейт PR #46 режет кандидатов до денег`);
line("flag_only (теннис)", n1(
  `SELECT COUNT(*) n FROM trade_log WHERE created_at >= ? AND text LIKE 'flag_only%'`, fireSince),
  `R2: безопасная ветка — сигналы пишутся в калибровку, деньги не идут`);
rateLine("zombie_quarantine эпизоды", n1(
  `SELECT COUNT(*) n FROM trade_log WHERE created_at >= ? AND text LIKE 'zombie_quarantine%'`, fireSince),
  BASE.quarantine, `R4: с гистерезисом частота должна УПАСТЬ — рынок на пороге больше не мигает`);
rateLine("zombie_lifted", n1(
  `SELECT COUNT(*) n FROM trade_log WHERE created_at >= ? AND text LIKE 'zombie_lifted%'`, fireSince),
  BASE.lifted, `снятие карантина требует 2 подряд чистых тика (dwell), а не одного`);
line("quasi_locked_tail (хвост досижен)", n1(
  `SELECT COUNT(*) n FROM trade_log WHERE created_at >= ? AND text LIKE '%quasi_locked_tail%'`, fireSince),
  `R1: тейк подавлен, потому что счёт запер рынок`);
line("dust_floor", n1(
  `SELECT COUNT(*) n FROM bets WHERE settled_at >= ? AND rationale LIKE '%dust_floor%'`, fireSince),
  `R6: остаток дешевле собственного выхода закрыт целиком`);
line("refusal_shadow сигналы", n1(
  `SELECT COUNT(*) n FROM refusal_shadow_signals WHERE created_at >= ?`, fireSince),
  `R5: отказы стратега заморожены как would-be сигналы (нужно 25 решённых)`);

// [G5 / batch-11] The Draw-canon counter, surfaced where the operator already looks. Reported as accumulation,
// never as a verdict, until it matures — the whole point of building it was to stop deciding on a story.
try {
  const probe = buildDrawCanonProbe(db);
  P(`- **Draw-канон (счётчик G5)**: ${probe.observations} наблюдений по ${probe.matches} матчам · ` +
    `канон выбрал книгу ${probe.canonChosen}× · из них в карантине ${probe.canonQuarantined}` +
    (probe.doubleLockPct == null ? "" : ` (${probe.doubleLockPct}%)`));
  P(`    ${probe.note}`);
} catch (e) { P(`- **Draw-канон (счётчик G5)**: недоступен — ${(e as Error).message}`); }

const rs = q<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM refusal_shadow_signals GROUP BY status`);
if (rs.length) P(`  refusal_shadow по статусам: ${rs.map((r) => `${r.status}=${r.n}`).join(", ")}`);
P();

// R3 anchor lane — measured by OUTCOME, not by a log marker: the point of the lane is that a pre-match
// analysis lands BEFORE the whistle. That is a fact about timestamps, so read it from timestamps.
P(`### R3 (T-минус якорь): доля анализов, успевших ДО стартового свистка`);
const anch = q<any>(
  `SELECT a.created_at, m.kickoff_at, m.home, m.away
     FROM assessments a JOIN matches m ON m.id = a.match_id
    WHERE a.status = 'ok' AND a.created_at >= ? AND m.kickoff_at IS NOT NULL`, fireSince);
if (!anch.length) P(`нет успешных анализов в окне — мерить нечего (⚠ путь не подтверждён).`);
else {
  const gaps = anch.map((r) => (new Date(r.kickoff_at).getTime() - new Date(r.created_at).getTime()) / 60000);
  const before = gaps.filter((g) => g > 0).length;
  const late = anch.map((r, i) => ({ r, g: gaps[i] })).filter((x) => x.g <= 0).sort((a, b) => a.g - b.g);
  const med = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  P(`до свистка: **${before}/${anch.length}** (${Math.round((1000 * before) / anch.length) / 10}%), медианный запас **${Math.round(med)}′**`);
  if (late.length) {
    P(`опоздавшие (эти станут origin='live' и упрутся в grace-окно ft_blind):`);
    for (const x of late.slice(0, 10)) P(`  - ${x.r.home}–${x.r.away}: анализ на ${Math.round(-x.g)}′ ПОСЛЕ старта`);
  } else P(`опоздавших нет — ровно та дыра, ради которой якорь и делался.`);
}
P();

// ── §4 READINESS OF THE 24h TRIPLE SNAPSHOT ───────────────────────────────────────────────────────
// The agreed protocol: one pass over exit_honesty + F4 + the golden cell, read fresh, with comparison
// against pre-epoch numbers forbidden. It is only meaningful once the new epoch has bets to read.
P(`## §4. Готовность суточного тройного снимка`);
const epochBets = n1(`SELECT COUNT(*) n FROM bets WHERE created_at >= ? AND status <> 'not_filled'`, since);
const epochSettled = n1(`SELECT COUNT(*) n FROM bets WHERE settled_at >= ?`, since);
P(`ставок в окне: **${epochBets}**, из них закрыто/разрешено: **${epochSettled}**.`);
P(epochSettled >= 20
  ? `Данных достаточно — снимок можно снимать (\`npm run melt:report\`, вкладка «Профили», F4-отчёт), один проход, без сравнения со старыми числами.`
  : `Рано: снимок на ${epochSettled} закрытых позициях прочитается как шум. Ждём накопления — сравнение с доэпохальными числами запрещено, поэтому «дотянуть» нечем.`);
P();
P(`---`);
P(`Правило чтения: **0 в §3 — это не «всё хорошо», а «путь не проверен»**. Каждая строка с нулём остаётся`);
P(`незакрытой до первого срабатывания в проде.`);

console.log(out.join("\n"));
