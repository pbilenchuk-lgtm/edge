// ============================================================
// EDGE LAB — LEG-CONSISTENCY INVARIANT  [Z2(а), batch-9 ТЗ]
//
// One market on one match is ONE contract: at settlement it resolved one way. Yet batch 9 shows a market
// carrying labels in BOTH directions — Cusco «Over 0.5»: 4 legs `lost` (partial @45.3¢) alongside 4 legs
// `won` (@95.5¢) — with not a single accounting_suspect raised. The existing Z2(b) invariant cannot see this:
// it validates ONE leg's payout against ONE leg's expectation and never compares siblings.
//
// Two very different things produce that shape, and the whole point of this check is to TELL THEM APART:
//   • LEGITIMATE — a partial cut booked at the exit price (a money-losing leg) plus the held remainder that
//     settled a winner. Two legs, two money outcomes, one contract. Correct, but it must be LABELLED, because
//     outcome-based aggregates (win-rate, calibration, the signal verdict) read `result` as the CONTRACT's
//     outcome. Phase-0 [M6] already collapses such a signal to `void` rather than a win — this names WHY.
//   • A BUG — two full settles of the same position disagreeing (a double-settle / mislabel), which silently
//     inflates or deflates the win-rate of the whole cell.
//
// Read-only: it counts and names, never rewrites a settle. The classification is mechanical — a group whose
// disagreement is explained entirely by early/partial legs is `partial_explained`; anything else is `suspect`.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { canonicalMarket } from "./signals.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const EARLY = new Set(["early", "partial"]);

export interface LegRow {
  betId: string; profileId: string; status: string; result: string | null; settledBy: string | null;
  stake: number; entryCents: number | null; closingCents: number | null; payout: number | null;
}
export interface LegGroup {
  matchId: string; matchLabel: string; strategyId: string; market: string;
  legs: LegRow[]; won: number; lost: number; voided: number;
  earlyLegs: number; heldLegs: number;
  classification: "consistent" | "partial_explained" | "suspect";
  note: string;
}
export interface LegConsistencyReport {
  scannedGroups: number; disagreeing: number; partialExplained: number; suspect: number;
  groups: LegGroup[];   // only the disagreeing ones, suspect first
  note: string;
}

/** Group every settled bet by (match × canonical market × strategy) and classify direction disagreements. */
export function buildLegConsistency(db: Database): LegConsistencyReport {
  const byKey = new Map<string, { matchId: string; strategyId: string; market: string; legs: LegRow[] }>();
  for (const b of R.allBets(db)) {
    if (!R.isSettled(b.status)) continue;
    const key = `${b.match_id}|${b.strategy_id}|${canonicalMarket(b.market_label)}`;
    const g = byKey.get(key) ?? byKey.set(key, { matchId: b.match_id, strategyId: b.strategy_id, market: b.market_label, legs: [] }).get(key)!;
    g.legs.push({
      betId: b.id, profileId: b.risk_profile_id ?? "medium", status: b.status, result: b.result ?? null,
      settledBy: b.settled_by ?? null, stake: b.stake ?? 0,
      entryCents: b.entry_price ?? null, closingCents: b.closing_price ?? null, payout: b.payout ?? null,
    });
  }

  const groups: LegGroup[] = [];
  let disagreeing = 0, partialExplained = 0, suspect = 0;
  for (const g of byKey.values()) {
    const won = g.legs.filter((l) => l.result === "won").length;
    const lost = g.legs.filter((l) => l.result === "lost").length;
    const voided = g.legs.filter((l) => l.result !== "won" && l.result !== "lost").length;
    if (!(won > 0 && lost > 0)) continue; // no direction disagreement → nothing to report
    disagreeing++;
    const earlyLegs = g.legs.filter((l) => EARLY.has(l.settledBy ?? "")).length;
    const heldLegs = g.legs.length - earlyLegs;
    // A disagreement is EXPLAINED when one whole DIRECTION consists of early/partial cuts: those legs record
    // the money outcome of a CUT (booked at the exit price), while the other direction records the contract's
    // real resolution. Note this is not a "minority" question — in the Cusco shape the cut side and the held
    // side had four legs each, so counting would have mislabelled a legitimate split as a defect.
    // It is SUSPECT when BOTH directions contain a leg that was HELD to settlement: one contract cannot
    // resolve two ways, so that is a double settle or a mislabel, and it silently skews the cell's win-rate.
    const heldOf = (res: string) => g.legs.filter((l) => l.result === res && !EARLY.has(l.settledBy ?? ""));
    const cutSide = heldOf("won").length === 0 ? "won" : heldOf("lost").length === 0 ? "lost" : null;
    const classification: LegGroup["classification"] = cutSide ? "partial_explained" : "suspect";
    const minority = cutSide ?? (won <= lost ? "won" : "lost"); // the side reported as cut-explained / as odd
    const minorityLegs = g.legs.filter((l) => l.result === minority);
    if (classification === "suspect") suspect++; else partialExplained++;
    const m = R.getMatch(db, g.matchId);
    const px = (l: LegRow) => (l.closingCents != null ? `${r2(l.closingCents)}¢` : l.payout != null ? `payout $${r2(l.payout)}` : "—");
    groups.push({
      matchId: g.matchId, matchLabel: m ? `${m.home} — ${m.away}` : g.matchId, strategyId: g.strategyId, market: g.market,
      legs: g.legs, won, lost, voided, earlyLegs, heldLegs, classification,
      note: classification === "partial_explained"
        ? `объяснимо частичными: ${won}W/${lost}L на одном контракте, но ВСЕ ноги меньшинства (${minority}) — early/partial срезы (${minorityLegs.map(px).join(", ")}). Деньги верны; но outcome-агрегаты читают result как исход КОНТРАКТА, поэтому сигнал схлопывается в void [M6], а не в победу.`
        : `ПОДОЗРИТЕЛЬНО: ${won}W/${lost}L на одном контракте, и не все ноги меньшинства (${minority}) — срезы: ${minorityLegs.filter((l) => !EARLY.has(l.settledBy ?? "")).map((l) => `${l.profileId}/${l.settledBy ?? "?"}`).join(", ")}. Один контракт разрешился в две стороны — двойной сеттл или ошибка разметки; win-rate ячейки искажён.`,
    });
  }
  groups.sort((a, b) => (a.classification === "suspect" ? 0 : 1) - (b.classification === "suspect" ? 0 : 1) || b.legs.length - a.legs.length);
  return {
    scannedGroups: byKey.size, disagreeing, partialExplained, suspect, groups,
    note: `Инвариант Z2(а): один рынок одного матча — ОДИН контракт, он разрешился в одну сторону. Группируем сеттленные ноги по (матч × канонический рынок × стратегия) и ищем разнонаправленные метки. partial_explained — законно (частичный срез + додержанный остаток), но именно поэтому сигнал схлопывается в void [M6], а не в победу. suspect — один контракт разрешился в две стороны при додержанных ногах: двойной сеттл/ошибка разметки, искажает win-rate. Отчёт только читает, ничего не переписывает.`,
  };
}
