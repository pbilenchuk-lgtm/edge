// ============================================================
// EDGE LAB — SHADOW ОТКЛОНЁННЫХ ПО ДРЕЙФУ ВХОДОВ  [W5 / batch-12, измеритель — денег не двигает]
//
// stale_proposal отклоняет вход, когда филл ушёл от цены решения (Hacken: предложение 25.5¢, филл 34.2¢,
// Δ9¢ > порога). Гейт написан против исполнения чужого решения — и 3 из 7 отказов пачки пришлись на него.
// Вопрос, на который никто не отвечал: а выигрывали ли бы эти входы ПО ЦЕНЕ ФИЛЛА? Если да — порог дрейфа
// режет живые деньги, и его надо расширять; если нет — порог прав. Спорить об этом словами бессмысленно,
// поэтому каждый отклонённый вход замораживается здесь would-be записью и резолвится по исходу рынка.
//
// КРИТЕРИЙ ОБЪЯВЛЕН ДО ДАННЫХ (в ТЗ и здесь, одинаково): n ≥ 20 разрешённых отказов; их would-be EV на $1
// по цене ФИЛЛА, после комиссии тейкера, > 0 → порог расширяется до измеренного квантиля фактических
// дрейфов ВЫИГРЫШНЫХ входов; иначе порог прав и не трогается. До n=20 отчёт печатает «копим» и не даёт
// повода крутить порог на глаз.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import type { EngineDeps } from "./engine.js";
import { isStateSuspect } from "./engine.js";
import { resolveFootballMarket, matchPhase } from "./settlement.js";

export const STALE_SHADOW_NEED_N = 20;

/** Заморозить would-be вход в момент отказа. Дедуп по (match, label, proposed, fill) — один и тот же
 *  отказ, повторённый ре-циклом, не должен раздувать выборку. Никогда не бросает в тик. */
export function recordStaleProposalShadow(db: Database, s: {
  matchId: string; strategyId: string; label: string; proposedCents: number; fillCents: number; at: string;
}): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO stale_proposal_shadow(id, match_id, strategy_id, market_label, proposed_cents, fill_cents, drift_cents, status, created_at)
       VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
    ).run(`${s.matchId}|${s.label}|${s.proposedCents}|${s.fillCents}`, s.matchId, s.strategyId, s.label,
      s.proposedCents, s.fillCents, Math.round(Math.abs(s.fillCents - s.proposedCents) * 10) / 10, s.at);
  } catch { /* измеритель не имеет права ломать вход */ }
}

/** Разрешить pending-записи по исходу рынка. Fail-closed: не решается по счёту → unverifiable, не гадаем. */
export function resolveStaleProposalShadow(db: Database, deps: EngineDeps = {}): { resolved: number; unverifiable: number } {
  const now = deps.now?.() ?? new Date().toISOString();
  let resolved = 0, unverifiable = 0;
  const rows = db.prepare(`SELECT id, match_id, market_label FROM stale_proposal_shadow WHERE status='pending'`).all() as any[];
  for (const r of rows) {
    const m = R.getMatch(db, r.match_id);
    if (!m || m.state !== "finished" || isStateSuspect(db, m.id)) continue;
    const won = m.score_home == null || m.score_away == null ? null
      : resolveFootballMarket(r.market_label, m.score_home, m.score_away, { home: m.home, away: m.away }, matchPhase(m));
    if (won == null) { db.prepare(`UPDATE stale_proposal_shadow SET status='unverifiable', resolved_at=? WHERE id=?`).run(now, r.id); unverifiable++; continue; }
    db.prepare(`UPDATE stale_proposal_shadow SET status=?, resolved_at=? WHERE id=?`).run(won ? "won" : "lost", now, r.id);
    resolved++;
  }
  return { resolved, unverifiable };
}

export interface StaleShadowReport {
  criterion: string;
  total: number; pending: number; resolvedN: number; unverifiable: number;
  evPerDollar: number | null;            // по цене ФИЛЛА, после комиссии — единственное решающее число
  winPct: number | null;
  winnersDriftQuantileC: number | null;  // p75 дрейфа ВЫИГРЫШНЫХ — кандидат в новый порог, если критерий сработал
  verdict: "insufficient" | "порог_прав" | "порог_режет_деньги";
  note: string;
}

export function buildStaleShadowReport(db: Database, env: Record<string, string | undefined> = process.env): StaleShadowReport {
  const fee = (() => { const n = Number(env.POLYMARKET_TAKER_FEE_RATE); return Number.isFinite(n) && n >= 0 ? n : 0.02; })();
  const all = db.prepare(`SELECT status, fill_cents, drift_cents FROM stale_proposal_shadow`).all() as any[];
  const res = all.filter((r) => r.status === "won" || r.status === "lost");
  const pending = all.filter((r) => r.status === "pending").length;
  const unv = all.filter((r) => r.status === "unverifiable").length;
  const evs = res.filter((r) => r.fill_cents > 0 && r.fill_cents < 100)
    .map((r) => (r.status === "won" ? 100 / r.fill_cents - 1 : -1) - fee);
  const ev = evs.length ? Math.round((evs.reduce((a, b) => a + b, 0) / evs.length) * 10000) / 10000 : null;
  const winners = res.filter((r) => r.status === "won").map((r) => r.drift_cents).sort((a, b) => a - b);
  const q75 = winners.length ? winners[Math.min(winners.length - 1, Math.floor(0.75 * winners.length))] : null;
  const matured = res.length >= STALE_SHADOW_NEED_N;
  const verdict: StaleShadowReport["verdict"] = !matured ? "insufficient" : ev != null && ev > 0 ? "порог_режет_деньги" : "порог_прав";
  return {
    criterion: `n≥${STALE_SHADOW_NEED_N} разрешённых; would-be EV по цене филла после комиссии > 0 → порог расширяется до p75 дрейфа выигрышных; иначе порог прав.`,
    total: all.length, pending, resolvedN: res.length, unverifiable: unv,
    evPerDollar: ev, winPct: res.length ? Math.round((1000 * res.filter((r) => r.status === "won").length) / res.length) / 10 : null,
    winnersDriftQuantileC: q75, verdict,
    note: !matured
      ? `КОПИМ: ${res.length}/${STALE_SHADOW_NEED_N} разрешённых отказов — крутить порог дрейфа рано, и на глаз нельзя.`
      : verdict === "порог_режет_деньги"
        ? `Отклонённые входы В СРЕДНЕМ выигрывали бы по цене филла: EV $${ev}/на $1 после комиссии на n=${res.length}. Кандидат в порог: p75 дрейфа выигрышных = ${q75}¢ (решение о расширении — за владельцем).`
        : `Порог прав: would-be EV $${ev}/на $1 ≤ 0 на n=${res.length} — гейт резал входы, которые в среднем теряли бы.`,
  };
}
