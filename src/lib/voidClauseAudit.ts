// ============================================================
// EDGE LAB — АУДИТ КЛАУЗ: СОГЛАСЕН ЛИ КОД С ТЕКСТОМ РЫНКА  (Р4, часть 2)  [read-only]
//
// Разбор клауз (`voidClause.ts`) умеет читать текст. Этот модуль ставит его ПРОТИВ нашей зашитой семейной
// логики на ЖИВЫХ строках базы и отвечает на вопрос, который иначе задать нечем: «наше общее правило и
// текст ЭТОГО рынка говорят одно и то же?».
//
// ПОЧЕМУ ЭТО СТОРОЖ, А НЕ РАЗОВАЯ СВЕРКА. На выборке 09.08 расхождений было 0 из 14 — код прав. Но прав он
// БЕЗ ДОКАЗАТЕЛЬСТВА: до сравнения отличить его правоту от везения было нечем, и ничто не мешает
// Polymarket поменять формулировку завтра. Сторож переводит «сегодня сходится» в «мы узнаем, когда
// перестанет».
//
// НЕРАЗОБРАННОЕ НЕ СЧИТАЕТСЯ СОГЛАСИЕМ. Строка, где клауза не прочиталась, идёт в свой счётчик: молчание
// парсера, зачтённое за одобрение кода, было бы ровно тем дефектом, против которого весь этот модуль.
// ============================================================

import type { Database } from "./db.js";
import { parseVoidClause, clauseDisagrees, clauseSignature } from "./voidClause.js";

/** Наша зашитая семейная логика (isMatchScopeVoid): какие семьи воидятся по незавершению МАТЧА. */
export function ourMatchScopeVoid(label: string): boolean {
  return /total sets|set handicap|match o\/u|match over|match under/i.test(label);
}

export interface ClauseAuditRow { label: string; clause: string; why: string }
export interface ClauseAudit {
  at: string;
  stored: number; parsed: number; unparsed: number; agree: number; disagree: number;
  disagreements: ClauseAuditRow[];
  byClause: { clause: string; n: number }[];
  verdict: "agree" | "disagree" | "unmeasured";
  note: string;
}

export function buildClauseAudit(db: Database, nowIso: string, limit = 4000): ClauseAudit {
  let rows: { market_label: string; description: string }[] = [];
  try {
    rows = db.prepare(`SELECT market_label, description FROM market_clauses LIMIT ?`).all(limit) as typeof rows;
  } catch { rows = []; }

  const disagreements: ClauseAuditRow[] = [];
  const byClauseMap = new Map<string, number>();
  let parsed = 0, unparsed = 0, agree = 0;
  for (const r of rows) {
    const c = parseVoidClause(r.description);
    const sig = clauseSignature(c);
    byClauseMap.set(sig, (byClauseMap.get(sig) ?? 0) + 1);
    if (c.status === "unparsed") { unparsed++; continue; }
    parsed++;
    const d = clauseDisagrees(c, ourMatchScopeVoid(r.market_label));
    if (d.disagrees) { if (disagreements.length < 20) disagreements.push({ label: r.market_label, clause: sig, why: d.why }); }
    else agree++;
  }
  const disagree = parsed - agree;
  // ВЕРДИКТ ТОЛЬКО ПО РАЗОБРАННЫМ. Ноль разобранных — это «не измерено», а не «согласны»: сравнивать
  // было не с чем, и объявлять согласие на пустом множестве значило бы оправдать код его же молчанием.
  const verdict: ClauseAudit["verdict"] = !parsed ? "unmeasured" : disagree ? "disagree" : "agree";
  return {
    at: nowIso, stored: rows.length, parsed, unparsed, agree, disagree, disagreements,
    byClause: [...byClauseMap.entries()].map(([clause, n]) => ({ clause, n })).sort((a, b) => b.n - a.n),
    verdict,
    note: !rows.length ? "текстов правил в базе нет — завоз клауз ещё не дошёл, читать нечего"
      : verdict === "unmeasured" ? `${rows.length} текстов, но ни один не разобран — НЕ ИЗМЕРЕНО (это не согласие)`
        : verdict === "agree"
          ? `код и текст согласны на всех ${parsed} разобранных (не разобрано ${unparsed}, они в согласие НЕ зачтены).`
            + ` Сторож живой: если Polymarket поменяет формулировку, расхождение появится числом.`
          : `РАСХОЖДЕНИЕ: ${disagree} из ${parsed} разобранных — код и текст рынка говорят РАЗНОЕ.`
            + ` Одно из двух неверно; менять расчёт только через ратификацию.`,
  };
}

export function clauseAuditLine(a: ClauseAudit): string {
  return `аудит клауз: ${a.agree}/${a.parsed} согласны · расхождений ${a.disagree} · не разобрано ${a.unparsed} · ${a.verdict}`;
}
