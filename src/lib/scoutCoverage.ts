// ============================================================
// EDGE LAB — ПОЧЕМУ У МАТЧА НЕТ СВЕЖЕГО СЧЁТА. ПОИМЁННО, А НЕ ОДНИМ СЛОВОМ.
//
// ИСПРАВЛЕНИЕ МОЕГО СОБСТВЕННОГО ВЫВОДА ПО ЛОГАМ. Я написал, что `no_score_data_skip` в 64% логов —
// структурный дедлок каденции: порог свежести 15 минут при медленном цикле 30 минут, «устаревает по
// построению». ПРОВЕРКА ЭТО ОПРОВЕРГЛА: `tennisSetValue` стоит в ЖИВОМ тике сразу после `tennisScout`
// (lifecycle: скаут строкой выше потребителя), то есть внутри тика снимок свежий по конструкции.
// Каденция ни при чём — при чём ПОКРЫТИЕ конкретного матча.
//
// ПОЧЕМУ ЧИСЛО В ЛОГЕ НИЧЕГО НЕ ДОКАЗЫВАЛО. Строка пишется ОДИН раз на матч (throttle `warned`), то есть
// ровно на первом пересечении порога — поэтому там ВСЕГДА «15м > 15м», сколько бы часов матч потом ни
// стоял без данных. Я читал этот пятнадцать как «отставание на 15 минут», а это тавтология конструкции:
// диагностика отвечала на вопрос, которого никто не задавал. Число, которое не может быть другим, —
// не измерение.
//
// ЧТО МЕРЯЕТСЯ ЗДЕСЬ. У «нет свежего счёта» есть ШЕСТЬ разных причин, и чинятся они по-разному:
//   • ДО НАЧАЛА          — матч ещё не стартовал; живой фид несёт только in-play. НЕ дефект и НЕ замер.
//   • покрыт             — есть свежий связанный снимок.
//   • ЗАВЕРШЁН У ПРОВАЙДЕРА — последний снимок терминальный: данных нет законно, матч кончился.
//   • НЕ СВЯЗАН          — провайдер матч ВИДИТ, но вердикт привязки review/skip: имена не сошлись.
//                          Единственная причина, которую чинят алиасом, — и она названа со счётом и зазором.
//   • УСТАРЕЛ            — привязка была, свежих строк нет: провайдер перестал отдавать матч.
//   • НЕ В ФИДЕ          — стартовое время прошло, а провайдер матча не видел вовсе.
// Плюс отдельно ПРОСРОЧЕН — запись висит нефинишированной спустя часы после старта; такой матч генерит
// `no_score_data_skip` вечно и портит любую статистику покрытия, поэтому назван отдельно, а не смешан.
//
// Модуль ТОЛЬКО читает: ни одной записи, ни одного решения о деньгах.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { Match } from "./types.js";
import { snapshotWitness } from "./snapshotWitness.js";
import { MAP_AUTO, MAP_REVIEW } from "./tennisMatch.js";

/**
 * Порог свежести снимка скаута. ЖИВЁТ ЗДЕСЬ, а не в торговом модуле, ровно по правилу «один авторитет
 * на одно решение»: тот же порог, по которому Set-Value отказывается армиться, обязан быть тем, по
 * которому отчёт называет матч непокрытым. Иначе доля покрытия и отказы разъедутся, и разбираться
 * придётся, читая оба файла.
 */
export const SV_SNAP_STALE_MIN = (() => { const n = Number(process.env.TENNIS_SV_SNAP_STALE_MIN); return Number.isFinite(n) && n > 0 ? n : 15; })();

/** Матч считается «должен идти» столько часов после старта; дальше это просроченная запись, а не игра. */
export const OVERDUE_H = 6;
/** Окно, в котором решения привязки считаются относящимися к сейчас. */
export const MAP_LOOKBACK_H = 12;

export type CoverageVerdict =
  | "ДО НАЧАЛА" | "покрыт" | "ЗАВЕРШЁН У ПРОВАЙДЕРА" | "НЕ СВЯЗАН" | "УСТАРЕЛ" | "НЕ В ФИДЕ" | "ПРОСРОЧЕН";

export interface CoverageRow {
  matchId: string; players: string; state: string; kickoffAt: string | null;
  snapshots: number; lastAt: string | null; ageMin: number | null; lastStatus: string | null;
  /** Решение привязки, если провайдер этот матч вообще видел: вердикт, счёт и имена ЕГО стороны. */
  mapVerdict: string | null; mapScore: number | null; providerPlayers: string | null;
  verdict: CoverageVerdict; note: string;
}
export interface ScoutCoverageReport {
  staleMin: number; rows: CoverageRow[];
  /** Только те, что чинятся: привязка не сошлась / фид не даёт / запись просрочена. */
  actionable: CoverageRow[];
  covered: number; measured: number;
  note: string;
}

const TERMINAL_RE = /finish|ended|walkover|retired|w\.?o\.?|abandon|cancel|awarded/i;

interface SnapAgg { n: number; lastAt: string | null; lastStatus: string | null }
function snapAgg(db: Database, matchId: string): SnapAgg {
  const r = db.prepare(
    `SELECT COUNT(*) n, MAX(batch_at) lastAt FROM tennis_snapshots WHERE pm_match_id=?`,
  ).get(matchId) as { n: number; lastAt: string | null };
  if (!r?.n) return { n: 0, lastAt: null, lastStatus: null };
  const s = db.prepare(
    `SELECT status FROM tennis_snapshots WHERE pm_match_id=? ORDER BY batch_at DESC LIMIT 1`,
  ).get(matchId) as { status: string | null } | undefined;
  return { n: r.n, lastAt: r.lastAt, lastStatus: s?.status ?? null };
}

/** Свежайшее решение привязки, КАСАЮЩЕЕСЯ этого матча: либо привязано к нему, либо он был кандидатом. */
function mapDecisionFor(db: Database, matchId: string, sinceMs: number): R.TennisMapLogRow | null {
  for (const row of R.tennisMapLog(db, 800)) {                       // уже отсортирован по времени вниз
    if ((Date.parse(row.created_at) || 0) < sinceMs) break;
    if (row.match_id === matchId) return row;
    if (row.candidates) {
      try {
        if ((JSON.parse(row.candidates) as { matchId?: string }[]).some((c) => c.matchId === matchId)) return row;
      } catch { /* повреждённый след не должен ронять отчёт */ }
    }
  }
  return null;
}

/** Разбор ОДНОГО матча. Тот же классификатор зовёт и отчёт, и лог пропуска — авторитет один. */
export function classifyScoutCoverage(db: Database, m: Match, nowIso = new Date().toISOString()): CoverageRow {
  const nowMs = Date.parse(nowIso) || Date.now();
  const agg = snapAgg(db, m.id);
  // [N7] Свидетель снимков переживает ретеншн. Без него ветка «НЕ В ФИДЕ» утверждала «провайдер этого
  // матча не видел вовсе» — утверждение о ПРОШЛОМ, выведенное из счёта в НАСТОЯЩЕМ по кэпнутой таблице.
  const w = snapshotWitness(db, m.id, agg.n, m.kickoff_at ?? null);
  const ageMin = agg.lastAt ? Math.round((nowMs - (Date.parse(agg.lastAt) || 0)) / 60_000) : null;
  const koMs = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
  const started = Number.isFinite(koMs) ? koMs <= nowMs : m.state === "live";
  const overdueH = Number.isFinite(koMs) ? (nowMs - koMs) / 3_600_000 : null;
  const dec = mapDecisionFor(db, m.id, nowMs - MAP_LOOKBACK_H * 3_600_000);
  const base = {
    matchId: m.id, players: `${m.home} — ${m.away}`, state: m.state, kickoffAt: m.kickoff_at ?? null,
    snapshots: agg.n, lastAt: agg.lastAt, ageMin, lastStatus: agg.lastStatus,
    mapVerdict: dec?.verdict ?? null, mapScore: dec?.score ?? null, providerPlayers: dec?.players ?? null,
  };
  const mk = (verdict: CoverageVerdict, note: string): CoverageRow => ({ ...base, verdict, note });

  // ДО НАЧАЛА идёт ПЕРВЫМ: живой фид несёт только in-play, и «нет данных» тут ничего не утверждает.
  if (!started) return mk("ДО НАЧАЛА", `старт ${m.kickoff_at ?? "не назначен"} ещё не наступил — живой фид несёт только идущие матчи, отсутствие снимков здесь НИЧЕГО не значит`);
  if (agg.n && (ageMin as number) <= SV_SNAP_STALE_MIN) return mk("покрыт", `снимков ${agg.n}, последний ${ageMin}м назад (порог ${SV_SNAP_STALE_MIN}м), статус «${agg.lastStatus ?? "—"}»`);
  if (agg.n && TERMINAL_RE.test(agg.lastStatus ?? "")) return mk("ЗАВЕРШЁН У ПРОВАЙДЕРА", `последний снимок терминальный («${agg.lastStatus}», ${ageMin}м назад) — свежих данных нет ЗАКОННО; если матч всё ещё не finished у нас, это вопрос к финишеру, а не к скауту`);
  if (overdueH != null && overdueH > OVERDUE_H) return mk("ПРОСРОЧЕН", `старт ${Math.round(overdueH)}ч назад, а запись всё ещё «${m.state}» — такой матч генерит no_score_data_skip бесконечно; это мусор в записях, а не пробел покрытия`);
  if (dec && dec.verdict !== "auto") return mk("НЕ СВЯЗАН", `провайдер матч ВИДИТ («${dec.players ?? "?"}»), но привязка ${dec.verdict} со счётом ${dec.score ?? "?"} при пороге ${MAP_AUTO} (зазор ${dec.score != null ? Math.round((MAP_AUTO - dec.score) * 100) / 100 : "?"}, порог review ${MAP_REVIEW}) — чинится алиасом имён, а не порогом свежести`);
  if (agg.n) return mk("УСТАРЕЛ", `привязка была (снимков ${agg.n}), но свежих строк нет ${ageMin}м — провайдер перестал отдавать матч, а он у нас всё ещё «${m.state}»`);
  // Живых строк нет — но свидетель помнит, что они БЫЛИ. Это тот же «УСТАРЕЛ», просто окно ретеншна
  // короче возраста матча; называть это «не видел вовсе» значило бы обвинить фид в работе кэпа.
  if (w.verdict === "wiped") {
    return mk("УСТАРЕЛ", `привязка была (за жизнь матча записано ${w.seenTotal} снимков${w.lastAt ? `, последний ${w.lastAt}` : ""}),`
      + ` но живых строк не осталось — их стёр ретеншн, а не провал маппинга`);
  }
  // `unknown` — матч старше счётчика-свидетеля. Утверждать про него «провайдер не видел вовсе» значило бы
  // выдать незнание за факт ровно тем способом, который эта задача и чинит.
  if (w.verdict === "unknown") {
    return mk("НЕ СВЯЗАН", `живых снимков нет, и ответить «были ли они» нельзя: ${w.note}`);
  }
  return mk("НЕ В ФИДЕ", `старт прошёл${overdueH != null ? ` ${Math.round(overdueH * 10) / 10}ч назад` : ""}, снимков НЕТ ни живых, ни за всю жизнь матча (счётчик-свидетель 0),`
    + ` и решения привязки за ${MAP_LOOKBACK_H}ч тоже нет — провайдер этого матча не видел вовсе`);
}

export function buildScoutCoverage(db: Database, nowIso = new Date().toISOString()): ScoutCoverageReport {
  const rows: CoverageRow[] = [];
  for (const c of R.listCompetitions(db)) {
    if (c.sport_id !== "tennis") continue;
    for (const m of R.listMatches(db, c.id)) {
      if (m.state === "finished") continue;
      rows.push(classifyScoutCoverage(db, m, nowIso));
    }
  }
  const ORDER: CoverageVerdict[] = ["НЕ СВЯЗАН", "НЕ В ФИДЕ", "УСТАРЕЛ", "ПРОСРОЧЕН", "ЗАВЕРШЁН У ПРОВАЙДЕРА", "покрыт", "ДО НАЧАЛА"];
  rows.sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || (a.ageMin ?? 0) - (b.ageMin ?? 0));

  const actionable = rows.filter((r) => r.verdict === "НЕ СВЯЗАН" || r.verdict === "НЕ В ФИДЕ" || r.verdict === "УСТАРЕЛ" || r.verdict === "ПРОСРОЧЕН");
  const covered = rows.filter((r) => r.verdict === "покрыт").length;
  // ЗНАМЕНАТЕЛЬ НАЗВАН ЧЕСТНО. «До начала» и «завершён у провайдера» в долю покрытия не входят: в них
  // отсутствие данных законно, и включив их, я бы получил красивую дробь, которая ничего не измеряет.
  const measured = rows.filter((r) => r.verdict !== "ДО НАЧАЛА" && r.verdict !== "ЗАВЕРШЁН У ПРОВАЙДЕРА").length;
  const byVerdict = new Map<CoverageVerdict, number>();
  for (const r of rows) byVerdict.set(r.verdict, (byVerdict.get(r.verdict) ?? 0) + 1);

  return {
    staleMin: SV_SNAP_STALE_MIN, rows, actionable, covered, measured,
    note: !rows.length ? "незавершённых теннисных матчей нет — измерять нечего"
      : !measured ? `${rows.length} матч(ей), но ни один не в измеряемом состоянии (все до начала / завершены у провайдера) — это ОТСУТСТВИЕ ЗАМЕРА, а не 100% покрытие`
      : `покрытие ${covered}/${measured} (в знаменателе только те, где данные ДОЛЖНЫ быть) · ${[...byVerdict].map(([v, n]) => `${v}:${n}`).join(" · ")}`,
  };
}

/** Строка для еженедельника. Причина названа поимённо — иначе «нет счёта» опять станет одним словом. */
export function scoutCoverageLine(r: ScoutCoverageReport): string {
  if (!r.measured) return `scout_coverage: НЕ ИЗМЕРЯЕТСЯ — измеряемых матчей нет (${r.rows.length} до начала / завершены)`;
  const worst = r.actionable.slice(0, 3).map((x) => `${x.players} → ${x.verdict}`);
  return `scout_coverage: ${r.covered}/${r.measured} покрыто${r.actionable.length ? ` · ⚠ ${r.actionable.length} с причиной: ${worst.join("; ")}${r.actionable.length > 3 ? " …" : ""}` : ""}`;
}
