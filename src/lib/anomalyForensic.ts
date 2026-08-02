// ============================================================
// EDGE LAB — D2: ФОРЕНЗИК АНОМАЛИИ 24/24 [батч-13, ДО любого лечения красной группы]
//
// ЧТО СЛУЧИЛОСЬ. Августовский срез золотой ячейки по лиговым группам дал ДВЕ аномалии, а не одну:
//   • красная: MLS/LigaMX/CSL 31/64 = 48.4% против исторических 65.7% ТОЙ ЖЕ группы, binom p = 0.0033;
//   • зелёная: скандинавия+ЮА 24 из 24 = 100%, при тех же исторических 65.7% вероятность ≈ 0.00004.
// Лечить красную, не объяснив зелёную, нельзя: если 24/24 — артефакт сеттла, то и база, против которой
// считалась значимость красной, посчитана по загрязнённым числам, и весь вывод рушится вместе с ней.
//
// ЧТО ЭТОТ ПРОХОД ДЕЛАЕТ. Предъявляет по каждой из 24 ставок улики, по которым человек выносит вердикт:
// наш сеттл и метку против ФАКТИЧЕСКОГО счёта матча (он у нас есть — `matches.final_score`), плюс
// отдельные флаги Varbergs-класса: сеттл по PM-резолюции без счёта, воид, ставший победой, early-метка.
//
// ЧЕГО ОН НЕ ДЕЛАЕТ, И ЭТО ГЛАВНОЕ. Он НИЧЕГО не чинит и ничего не решает. Ветвление (а) артефакт → фикс
// и пере-срез всей таблицы групп; (б) 24/24 честные → хвост дисперсии малого n — принимается человеком.
// Автоматический вердикт здесь означал бы, что расследование выносит приговор само себе.
//
// ВНЕШНИЙ ИСТОЧНИК СЧЁТА. ТЗ просит сверку с внешним источником. Наш `final_score` — это уже результат
// нашего же конвейера, поэтому строка, где счёта НЕТ, помечается `score_unverifiable`: по ней сверка
// невозможна В ПРИНЦИПЕ, и выдавать её за сошедшуюся — то самое закрашивание дыры нулём.
// ============================================================

import type { Database } from "./db.js";
import { betRecords, type BetRec } from "./profileAnalytics.js";
import { marketFamily } from "./signals.js";
import { resolveFootballMarket } from "./settlement.js";

/** Лиговые группы среза. Ключи по подстроке категории/компетишена — тот же признак, что и в разборе. */
export const LEAGUE_GROUPS: Record<string, string[]> = {
  "скандинавия/квалы": ["swe", "nor", "den", "fin", "isl", "uefa", "conf", "champ", "euro", "qual", "allsvenskan", "superettan", "eliteserien"],
  "MLS/LigaMX/CSL": ["usa", "mex", "chn", "mls", "liga mx", "super league", "apertura"],
  "южная америка": ["bra", "arg", "per", "uru", "col", "chi", "conmebol", "serie", "brasileiro", "liga 1"],
};
export function leagueGroup(category: string | null, competitionId: string | null): string {
  const s = `${category ?? ""} ${competitionId ?? ""}`.toLowerCase();
  for (const [g, keys] of Object.entries(LEAGUE_GROUPS)) if (keys.some((k) => s.includes(k))) return g;
  return "прочее";
}

export type ForensicFlag =
  | "score_unverifiable"      // счёта нет вовсе — сверка невозможна, а не «сошлась»
  | "settle_disagrees"        // счёт есть и он ПРОТИВОРЕЧИТ нашей метке
  | "pm_resolution_no_score"  // сеттл по PM-резолюции при отсутствии счёта — Varbergs-класс
  | "void_became_win"         // строка была воидом, а числится победой
  | "early_label"             // метка выставлена на досрочно закрытом куске
  | "clean";                  // счёт есть и метке НЕ противоречит

export interface ForensicRow {
  betId: string; matchLabel: string; competitionId: string | null; group: string;
  market: string; status: string; outcome: string; settledBy: string | null;
  finalScore: string | null; impliedByScore: boolean | null;
  flags: ForensicFlag[]; note: string;
}
export interface AnomalyForensic {
  windowFrom: string;
  /** Зелёная аномалия — то, ради чего проход и написан. */
  green: { groups: string[]; n: number; won: number; winPct: number | null; rows: ForensicRow[] };
  /** Красная группа рядом — чтобы сверка шла по одной линейке, а не по двум. */
  red: { groups: string[]; n: number; won: number; winPct: number | null; rows: ForensicRow[] };
  flagCounts: Record<string, number>;
  verifiable: { checked: number; agreed: number; disagreed: number; unverifiable: number };
  branch: "артефакт-найден" | "сверка-чиста" | "сверка-невозможна";
  note: string;
}

const GREEN = ["скандинавия/квалы", "южная америка"];
const RED = ["MLS/LigaMX/CSL"];

function examine(db: Database, b: BetRec): ForensicRow {
  const m = db.prepare(`SELECT home, away, final_score, score_home, score_away FROM matches WHERE id=?`).get(b.matchId) as
    { home: string; away: string; final_score: string | null; score_home: number | null; score_away: number | null } | undefined;
  const flags: ForensicFlag[] = [];
  let implied: boolean | null = null;
  if (!m || m.score_home == null || m.score_away == null) {
    flags.push("score_unverifiable");
    if (b.settledBy === "pm_resolution") flags.push("pm_resolution_no_score");
  } else {
    implied = resolveFootballMarket(b.market, m.score_home, m.score_away, { home: m.home, away: m.away }) ?? null;
    if (implied != null) {
      const ours = b.outcome === "won";
      if (implied !== ours) flags.push("settle_disagrees"); else flags.push("clean");
    } else flags.push("score_unverifiable");
  }
  if (b.status === "settled_void" && b.outcome === "won") flags.push("void_became_win");
  if (b.settledBy === "early" || b.settledBy === "partial") flags.push("early_label");
  return {
    betId: b.id, matchLabel: b.matchLabel, competitionId: b.competitionId,
    group: leagueGroup(b.category, b.competitionId), market: b.market, status: b.status,
    outcome: b.outcome, settledBy: b.settledBy, finalScore: m?.final_score ?? null, impliedByScore: implied,
    flags,
    note: flags.includes("settle_disagrees")
      ? `счёт ${m?.final_score} даёт исход «${implied ? "won" : "lost"}», а метка «${b.outcome}» — ПРОТИВОРЕЧИЕ`
      : flags.includes("score_unverifiable")
        ? "счёта нет — сверка НЕВОЗМОЖНА в принципе; это не «сошлось»"
        : "счёт подтверждает метку",
  };
}

export function buildAnomalyForensic(db: Database, windowFrom = "2026-08-01"): AnomalyForensic {
  const gold = betRecords(db).filter((r) =>
    r.strategyId === "prematch_value" && marketFamily(r.market) === "totals"
    && String(r.status).startsWith("settled") && (r.createdAt ?? "") >= windowFrom);
  const rowsOf = (groups: string[]) => gold.filter((r) => groups.includes(leagueGroup(r.category, r.competitionId))).map((b) => examine(db, b));
  const greenRows = rowsOf(GREEN), redRows = rowsOf(RED);
  const pct = (rs: ForensicRow[]) => {
    const w = rs.filter((r) => r.outcome === "won").length, l = rs.filter((r) => r.outcome === "lost").length;
    return w + l ? Math.round((1000 * w) / (w + l)) / 10 : null;
  };
  const flagCounts: Record<string, number> = {};
  for (const r of [...greenRows, ...redRows]) for (const f of r.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  const disagreed = greenRows.filter((r) => r.flags.includes("settle_disagrees")).length;
  const unverifiable = greenRows.filter((r) => r.flags.includes("score_unverifiable")).length;
  const agreed = greenRows.filter((r) => r.flags.includes("clean")).length;
  const branch: AnomalyForensic["branch"] =
    disagreed > 0 ? "артефакт-найден"
    : unverifiable >= Math.max(1, Math.ceil(greenRows.length / 2)) ? "сверка-невозможна"
    : "сверка-чиста";
  return {
    windowFrom,
    green: { groups: GREEN, n: greenRows.length, won: greenRows.filter((r) => r.outcome === "won").length, winPct: pct(greenRows), rows: greenRows },
    red: { groups: RED, n: redRows.length, won: redRows.filter((r) => r.outcome === "won").length, winPct: pct(redRows), rows: redRows },
    flagCounts, verifiable: { checked: greenRows.length, agreed, disagreed, unverifiable },
    branch,
    note: branch === "артефакт-найден"
      ? `⚠ АРТЕФАКТ: ${disagreed} из ${greenRows.length} строк зелёной группы ПРОТИВОРЕЧАТ фактическому счёту — база, против которой считалась значимость красной группы, посчитана по загрязнённым числам. Ветка (а): фикс → пере-срез ВСЕЙ таблицы групп → и только потом D3.`
      : branch === "сверка-невозможна"
        ? `СВЕРКА НЕВОЗМОЖНА: у ${unverifiable} из ${greenRows.length} строк нет счёта — вердикт «честные» на таких данных был бы выдуман. Нужен внешний источник счёта, а не наш конвейер.`
        : `сверка чиста: ${agreed} из ${greenRows.length} строк подтверждены счётом, противоречий нет. Ветка (б): 24/24 принимается как хвост дисперсии малого n, D3 идёт. Решение — владельца, проход только предъявил улики.`,
  };
}
