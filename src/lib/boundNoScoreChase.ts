// ============================================================
// EDGE LAB — ДОЖАТИЕ `bound_no_score`: ПРИВЯЗКА ЕСТЬ, СЧЁТА НЕТ
//
// Класс, у которого до сих пор не было ни имени, ни пути: матч ПРИВЯЗАН к событию провайдера (match_live
// существует, значит когда-то биндинг-гейты сказали «да»), матч завершён — а клетка счёта пуста. На проде
// это 3 матча MLS одного вечера 23.07 с 14 ставками: один инцидент, а не фон.
//
// ТРИ УСЛОВИЯ РАТИФИКАЦИИ, И КАЖДОЕ ЗДЕСЬ ВИДНО:
//
// (а) СЧЁТ ДОБИРАЕТСЯ ШТАТНЫМ ПУТЁМ, ЧЕРЕЗ ДЕЙСТВУЮЩИЕ ГЕЙТЫ — не спецзапросом в обход. Хранимая привязка
//     НЕ считается пропуском: часть привязок сделана ДО того, как date-гейт появился (химеры 02.08 — ровно
//     этот класс). Поэтому привязка ПЕРЕПРОВЕРЯЕТСЯ сегодняшними гейтами по тем же самым функциям, что и
//     живой enrich: sameTeams, дата в пределах FOOTBALL_LEG_GAP_HOURS, однозначная ориентация. Ни один
//     гейт здесь не переписан — они импортируются. Второго авторитета на привязку не заводится.
//
//     Честная граница источника: ESPN-scoreboard отдаёт СЕГОДНЯШНЮЮ доску, а этим матчам десять дней —
//     их там нет и не будет. Счёт берётся из summary ПО ТОМУ ЖЕ event id, который записал биндинг, и
//     разбирается ТЕМ ЖЕ парсером (parseEspnEvent). Это не обход гейта: summary несёт и дату, и составы,
//     то есть ровно те улики, по которым гейт и судит, — просто запрошенные по id, а не по доске.
//
// (б) ПРОТИВОРЕЧИЕ СЕТТЛАМ — НЕ ТИХАЯ ПЕРЕЗАПИСЬ, А КАРАНТИН НА ГРУППУ. Если добранный счёт даёт исход,
//     отличный от того, по которому ставка уже закрыта, — счёт НЕ пишется вовсе, а ВСЕ расчётные ставки
//     матча получают settle_suspect. Молчаливая запись «правильного» счёта поверх состоявшегося сеттла
//     оставила бы книгу и метку рассогласованными и сделала бы расследование невозможным.
//
// (в) `bound_no_score` — код из словаря (repo.listMatchLogs → noScoreReason), а не free-text. Вердикты
//     этого прохода — тоже закрытый список: «не удалось» обязано иметь ИМЯ, иначе оно немой ноль.
//
// ДЕНЬГИ. Проход пишет счёт и флаг карантина; ни то, ни другое книгу не двигает. Но стандарт массовых
// записей с бэкфиллов один: дельта подтверждается ИЗМЕРЕНИЕМ до/после, а не обещанием предиката.
// ============================================================

import type { Database } from "./db.js";
import type { Match, Bet } from "./types.js";
import type { SportsProvider, SportsMatchStatus } from "./sports.js";
import * as R from "./repo.js";
import { sameTeams, nameMatch, legGapMs, suspectResolveOutcome } from "./engine.js";
import { bookTotals, type BookTotals } from "./suspectBreakdown.js";

/** Почему матч НЕ дожат. Закрытый список — «прочее» здесь означало бы, что дыра снова без имени. */
export type ChaseVerdict =
  | "filled"                 // счёт записан по ответу провайдера
  | "local_repair"           // счёт УЖЕ был в базе, не хватало только строки final_score — источник не нужен
  | "no_bind"                // привязки нет (это `no_feed`, не наш класс)
  | "no_provider_answer"     // событие по id не отдалось
  | "not_final"              // событие ещё не завершено у провайдера
  | "no_score_at_source"     // событие завершено, но счёта у провайдера нет
  | "bind_team_mismatch"     // сегодняшний sameTeams не подтверждает привязку
  | "bind_no_date"           // дату сверить нечем — привязка не подтверждаема
  | "bind_date_gap"          // дата события вне окна: привязка была бы отвергнута СЕГОДНЯ
  | "bind_orientation"       // ориентация счёта неоднозначна
  | "contradicts_settled";   // счёт спорит с состоявшимися сеттлами → карантин, а не запись

export interface ChaseContradiction { betId: string; market: string; storedResult: string; impliedResult: string }

export interface ChaseRow {
  matchId: string; match: string; league: string | null;
  kickoffAt: string | null; espnEventId: string | null; eventDate: string | null;
  verdict: ChaseVerdict; note: string;
  score: string | null; settledBets: number;
  contradictions: ChaseContradiction[];
}

export interface ChaseResult {
  scanned: number; filled: number; quarantined: number; quarantinedBets: number;
  rows: ChaseRow[];
  bookBefore: BookTotals; bookAfter: BookTotals; bookDeltaUsd: number;
  at: string; note: string;
}

/**
 * Кандидаты класса: завершённый матч С привязкой и БЕЗ счёта — ТОТ ЖЕ предикат, что рисует
 * `bound_no_score` в архиве. Совпадение обязательно: первый прогон на проде вернул «просмотрено 0» при
 * трёх строках в архиве, потому что здесь стояло лишнее условие `score_home IS NULL OR score_away IS NULL`.
 * Отчёт и конвейер разошлись в том, КОГО они считают, — тот самый именной класс «два авторитета», и на
 * этот раз я завёл его сам, в коде, который его же и лечит.
 *
 * Архив считает «счёта нет» по ПУСТОЙ строке `final_score` (в JS пусто и NULL, и ''), поэтому здесь так же.
 */
export function boundNoScoreCandidates(db: Database): { id: string; sport: string }[] {
  return db.prepare(
    `SELECT m.id AS id, c.sport_id AS sport
       FROM matches m JOIN competitions c ON c.id = m.competition_id
      WHERE m.state = 'finished'
        AND COALESCE(m.final_score, '') = ''
        AND EXISTS(SELECT 1 FROM match_live ml WHERE ml.match_id = m.id)`,
  ).all() as { id: string; sport: string }[];
}

/** Перепроверка ХРАНИМОЙ привязки сегодняшними гейтами. Возвращает либо ориентацию, либо код отказа —
 *  привязка, которую сегодня не сделали бы, не даёт права писать счёт. */
export function verifyStoredBind(
  m: Pick<Match, "home" | "away" | "kickoff_at">, s: SportsMatchStatus, gapMs: number,
): { ok: true; flip: boolean } | { ok: false; verdict: ChaseVerdict } {
  if (!sameTeams(m.home, m.away, s.home, s.away)) return { ok: false, verdict: "bind_team_mismatch" };
  const ko = m.kickoff_at ? Date.parse(m.kickoff_at) : NaN;
  const ev = s.date ? Date.parse(s.date) : NaN;
  // Строго: обе даты обязаны быть. У живого enrich есть законные послабления (единственный кандидат,
  // запись без кикоффа) — здесь их НЕТ: мы судим привязку, сделанную неизвестно когда и неизвестно чем.
  if (!Number.isFinite(ko) || !Number.isFinite(ev)) return { ok: false, verdict: "bind_no_date" };
  if (Math.abs(ev - ko) > gapMs) return { ok: false, verdict: "bind_date_gap" };
  const straight = nameMatch(m.home, s.home) && nameMatch(m.away, s.away);
  const mirrored = nameMatch(m.home, s.away) && nameMatch(m.away, s.home);
  if (straight === mirrored) return { ok: false, verdict: "bind_orientation" };
  return { ok: true, flip: mirrored };
}

export interface ChaseDeps { now?: () => string; env?: Record<string, string | undefined> }

export async function chaseBoundNoScore(
  db: Database, provider: SportsProvider | null, deps: ChaseDeps = {},
): Promise<ChaseResult> {
  const at = deps.now ? deps.now() : new Date().toISOString();
  const gapMs = legGapMs(deps.env ?? process.env);
  const bookBefore = bookTotals(db);
  const rows: ChaseRow[] = [];
  const cands = boundNoScoreCandidates(db);
  let filled = 0, quarantined = 0, quarantinedBets = 0;

  for (const c of cands) {
    const m = R.getMatch(db, c.id);
    if (!m) continue;
    const live = R.getMatchLive(db, c.id);
    const label = `${m.home}–${m.away}`;
    const settled = db.prepare(
      `SELECT * FROM bets WHERE match_id=? AND status LIKE 'settled%'`,
    ).all(c.id) as Bet[];
    const base = {
      matchId: c.id, match: label, league: live?.league ?? null, kickoffAt: m.kickoff_at ?? null,
      espnEventId: live?.espn_event_id ?? null, eventDate: live?.espn_event_date ?? null,
      score: null as string | null, settledBets: settled.length, contradictions: [] as ChaseContradiction[],
    };
    // (б) применяется на ОБОИХ путях — и к добранному счёту, и к локальному ремонту. Общий предикат,
    // а не две копии: у вопроса «спорит ли счёт с состоявшейся меткой» один авторитет.
    const contradictionsFor = (sh: number, sa: number): ChaseContradiction[] => {
      const asIf = { ...m, score_home: sh, score_away: sa, final_score: `${sh}:${sa}` } as Match;
      const out: ChaseContradiction[] = [];
      for (const b of settled) {
        if (b.result !== "won" && b.result !== "lost") continue;      // void/незакрытые исходом не спорят
        const implied = suspectResolveOutcome(b, asIf);
        if (implied == null) continue;                                 // резолвер не берётся судить — не противоречие
        const impliedResult = implied ? "won" : "lost";
        if (impliedResult !== b.result) out.push({ betId: b.id, market: b.market_label, storedResult: b.result, impliedResult });
      }
      return out;
    };
    const quarantineGroup = (score: string, contradictions: ChaseContradiction[]) => {
      for (const b of settled) {
        try { db.prepare(`UPDATE bets SET settle_suspect=1 WHERE id=?`).run(b.id); quarantinedBets++; } catch { /* строка не должна ронять проход */ }
      }
      quarantined++;
      rows.push({
        ...base, verdict: "contradicts_settled", score, contradictions,
        note: `счёт ${score} спорит с ${contradictions.length} из ${settled.length} состоявшихся сеттлов — счёт НЕ записан, вся группа (${settled.length}) в settle_suspect`,
      });
    };

    // ЛОКАЛЬНЫЙ РЕМОНТ ПЕРЕД ЛЮБЫМ ЗАПРОСОМ НАРУЖУ. Первый прогон на проде показал, что весь класс —
    // это НЕ отсутствие счёта, а отсутствие СТРОКИ: score_home/score_away в базе лежат, а `final_score`
    // пуст. Причина в enrich: счёт по сторонам он пишет всегда, а `final_score` — только при `s.final`.
    // Матч, доехавший до finished через `state==="finished"` без флага completed, получает половину записи.
    // Спрашивать провайдера о том, что уже лежит в базе, — лишний сетевой поход и лишний риск.
    if (m.score_home != null && m.score_away != null) {
      const score = `${m.score_home}:${m.score_away}`;
      const contra = contradictionsFor(m.score_home, m.score_away);
      if (contra.length) { quarantineGroup(score, contra); continue; }
      R.updateMatch(db, m.id, { final_score: score });
      filled++;
      rows.push({ ...base, verdict: "local_repair", score, note: `счёт ${score} УЖЕ был в базе по сторонам — дописана только строка final_score, наружу не ходили` });
      continue;
    }
    if (!live?.espn_event_id || !live.league) {
      rows.push({ ...base, verdict: "no_bind", note: "match_live есть, но без event id/лиги — привязки как таковой нет" });
      continue;
    }
    // Штатный источник: то же summary-событие, что и у enrich, по тому же id, тем же парсером.
    const s = provider?.eventStatus ? await provider.eventStatus(c.sport, live.league, live.espn_event_id) : null;
    if (!s) {
      rows.push({ ...base, verdict: "no_provider_answer", note: `провайдер не отдал событие ${live.espn_event_id} (${live.league})` });
      continue;
    }
    const bind = verifyStoredBind(m, s, gapMs);
    if (!bind.ok) {
      rows.push({
        ...base, verdict: bind.verdict,
        note: `хранимая привязка НЕ подтверждена сегодняшними гейтами (${bind.verdict}): запись «${label}» ${m.kickoff_at ?? "—"} vs событие «${s.home}–${s.away}» ${s.date ?? "—"} — счёт НЕ берём`,
      });
      continue;
    }
    if (!s.final && s.state !== "finished") {
      rows.push({ ...base, verdict: "not_final", note: `у провайдера событие ещё «${s.state}» — счёт не окончателен` });
      continue;
    }
    const sh = bind.flip ? s.scoreAway : s.scoreHome;
    const sa = bind.flip ? s.scoreHome : s.scoreAway;
    if (sh == null || sa == null) {
      rows.push({ ...base, verdict: "no_score_at_source", note: "событие завершено, но счёта в ответе нет — дыра у ИСТОЧНИКА, а не у нас" });
      continue;
    }
    const score = `${sh}:${sa}`;
    // (б) СНАЧАЛА СВЕРКА С СОСТОЯВШИМИСЯ СЕТТЛАМИ, ПОТОМ ЗАПИСЬ. Не перезаписываем ничего: ни счёт,
    // ни исход. Вся группа — в карантин, разбирать человеку.
    const contradictions = contradictionsFor(sh, sa);
    if (contradictions.length) { quarantineGroup(score, contradictions); continue; }
    R.updateMatch(db, m.id, { score_home: sh, score_away: sa, final_score: score });
    filled++;
    rows.push({ ...base, verdict: "filled", score, note: `счёт ${score} записан; ${settled.length} сеттл(ов) ему не противоречат` });
  }

  const bookAfter = bookTotals(db);
  // Дельта по ВСЕМ агрегатам, а не по одному: совпадение P&L при разошедшихся stake/payout — тоже расхождение.
  const bookDeltaUsd = Math.round((bookAfter.pnlSum - bookBefore.pnlSum) * 100) / 100;
  const aggregatesMoved = (["settledBets", "stakeSum", "payoutSum", "pnlSum"] as const).filter((k) => bookAfter[k] !== bookBefore[k]);
  return {
    scanned: cands.length, filled, quarantined, quarantinedBets, rows,
    bookBefore, bookAfter, bookDeltaUsd, at,
    note: `bound_no_score: просмотрено ${cands.length}, дожато ${filled}, в карантин ${quarantined} матч(ей)/${quarantinedBets} ставок`
      + ` · Δ книги = $${bookDeltaUsd.toFixed(2)} (ИЗМЕРЕНО из базы, все 4 агрегата)`
      + (aggregatesMoved.length ? ` — СДВИНУЛОСЬ ${aggregatesMoved.join("/")}: проход не двигает деньги по построению, значит это БАГ ПРОХОДА. Разбирать, а не объяснять.` : ""),
  };
}

/** Строка для еженедельника — печатается БЕЗУСЛОВНО, включая «дожато 0». Ноль здесь факт, а не молчание. */
export function chaseLine(r: ChaseResult): string {
  const by = new Map<ChaseVerdict, number>();
  for (const row of r.rows) by.set(row.verdict, (by.get(row.verdict) ?? 0) + 1);
  const tail = [...by.entries()].filter(([v]) => v !== "filled").map(([v, n]) => `${v} ${n}`).join(", ");
  return `bound_no_score: ${r.filled}/${r.scanned} дожато`
    + (r.quarantined ? ` · ⚠ карантин ${r.quarantined} матч(ей)/${r.quarantinedBets} ставок (счёт спорит с сеттлом)` : "")
    + (tail ? ` · не взято: ${tail}` : "");
}
