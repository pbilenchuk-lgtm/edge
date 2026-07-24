// ============================================================
// EDGE LAB — EXIT-HONESTY DECOMPOSITION  [SERVER-ONLY, read-only]
//
// The dry contour books $1234 realized vs a $236 hold-to-settle paper twin — a $998 gap. Before touching the
// fill model (Petro's requirement #2: MEASURE the optimism before mutating), this decomposes the gap by the
// ONLY thing that makes an early exit honest-or-not: what the position would have settled at.
//
// The dry executor already sells into the REAL bid book with depth+limit respected (dryRun.ts), so an exit at
// 99.9¢ is a real top-of-book bid, not an invented price. The gap is therefore NOT "invented price" — it is
// EARLY-EXIT vs HOLD-TO-SETTLE on two different strategies. That splits cleanly by the twin bet's outcome:
//
//   • twin WON  → settle was 100¢; selling early at ~99.9¢ books ≈ the same money (delta ~0, benign). We gave
//                 up a hair by not holding — the honest, boring case.
//   • twin LOST → settle was 0¢; selling early at ~99.9¢ booked proceeds on a position that would have gone to
//                 ZERO. THIS is the whole optimism: the dry model "won" by selling a future-0 at ~100¢. It is
//                 real IFF that 99.9¢ bid depth was real enough to absorb the size in the last seconds — the
//                 exact book-realism question the fill model can't self-certify. suspectProceeds = this pile.
//   • unresolved → twin not yet settled; can't judge, quarantined from the verdict.
//
// suspectProceeds is the honest upper bound on exit-model optimism. If it's ~0 the $998 is benign (early sales
// of eventual winners) and NO model change is warranted. If it's large, THAT number is what an honest
// bid-corroborated exit model must claw back — and only then do we flip the model + mark the epoch. Read-only.
// Exposed at GET /api/real?report=exit_honesty.
// ============================================================

import type { Database } from "../db.js";

export interface ExitHonesty {
  exits: number;                       // dry SELL fills examined
  wonExits: number; lostExits: number; unresolvedExits: number;
  soldProceedsUsd: number;             // total $ the dry booked from selling (all resolved exits)
  benignWonProceedsUsd: number;        // proceeds on exits whose twin WON (early sale ≈ hold, honest)
  benignWonForgoneUsd: number;         // the hair given up vs holding to 100¢ (negative delta, benign)
  suspectLostProceedsUsd: number;      // ALL proceeds booked on exits whose twin SETTLED 0 (gross upper bound)
  // The gross pile splits by EXIT PRICE — the only axis that separates optimism from a working exit:
  //   • HIGH (≥ optimismFloor): sold a future-0 at ~100¢ → the real optimism (booked near-full value on
  //     something worth 0; the bid-depth realism this whole fix is about).
  //   • LOW  (< optimismFloor): sold a future-0 cheaply → a DEFENSIVE CUT that RECOVERED value before the
  //     position went to 0. That is the exit WORKING, not optimism, and must not inflate the verdict.
  optimismFloorCents: number;
  suspectHighPriceUsd: number;         // ⚠ the true optimism — sold future-0s at ≥ floor
  suspectLowPriceUsd: number;          // ✅ defensive cuts of future-0s below floor (exit doing its job)
  suspectShareOfSold: number | null;   // HIGH-price suspect / soldProceeds — the poison share
  avgSuspectExitCents: number | null;  // avg price over ALL suspect exits (a mix ⇒ read the split, not this)
  topSuspect: { match: string | null; label: string; exitCents: number; proceedsUsd: number; at: string; band: "high" | "low" }[];
  verdict: "benign" | "material_optimism" | "insufficient";
  note: string;
}

/** Decompose the dry realized-vs-hold gap by twin outcome. Pure read; never writes. */
export function buildExitHonesty(db: Database, env: Record<string, string | undefined> = process.env): ExitHonesty {
  const materialUsd = (() => { const n = Number(env.EXIT_HONESTY_MATERIAL_USD); return Number.isFinite(n) && n > 0 ? n : 50; })();
  // Sold-a-future-0 above this price = optimism; below = a defensive cut that recovered value. Default 90¢.
  const optimismFloorCents = (() => { const n = Number(env.EXIT_HONESTY_OPTIMISM_FLOOR_CENTS); return Number.isFinite(n) && n > 0 ? n : 90; })();
  // dry SELL fills → their order → the twin bet (by decision_id) carrying the hold-to-settle outcome + match.
  const rows = db.prepare(
    `SELECT f.price_cents AS exit_cents, f.size_usd AS proceeds_usd, f.created_at AS at,
            o.decision_id AS decision_id, b.status AS bet_status, b.market_label AS label,
            m.home AS home, m.away AS away
       FROM real_fills f
       JOIN real_orders o ON o.id = f.order_id
       LEFT JOIN bets b ON b.decision_id = o.decision_id
       LEFT JOIN matches m ON m.id = b.match_id
      WHERE f.side = 'SELL' AND f.dry = 1`,
  ).all() as { exit_cents: number; proceeds_usd: number; at: string; decision_id: string | null; bet_status: string | null; label: string | null; home: string | null; away: string | null }[];

  let wonExits = 0, lostExits = 0, unresolvedExits = 0;
  let benignWonProceeds = 0, benignWonForgone = 0, suspectLostProceeds = 0, suspectHigh = 0, suspectLow = 0, soldProceeds = 0;
  const suspectPrices: number[] = [];
  const suspect: { match: string | null; label: string; exitCents: number; proceedsUsd: number; at: string; band: "high" | "low" }[] = [];
  for (const r of rows) {
    const proceeds = Number(r.proceeds_usd) || 0, exitCents = Number(r.exit_cents) || 0;
    if (r.bet_status === "settled_won") {
      wonExits++; soldProceeds += proceeds; benignWonProceeds += proceeds;
      // hair given up vs holding to 100¢: shares × (100 − exit)/100 = proceeds × (100/exit − 1)
      benignWonForgone += exitCents > 0 ? proceeds * (100 / exitCents - 1) : 0;
    } else if (r.bet_status === "settled_lost") {
      lostExits++; soldProceeds += proceeds; suspectLostProceeds += proceeds;
      const high = exitCents >= optimismFloorCents;
      if (high) suspectHigh += proceeds; else suspectLow += proceeds;
      suspectPrices.push(exitCents);
      suspect.push({ match: r.home && r.away ? `${r.home}—${r.away}` : null, label: r.label ?? "", exitCents, proceedsUsd: Math.round(proceeds * 100) / 100, at: r.at, band: high ? "high" : "low" });
    } else {
      unresolvedExits++;
    }
  }

  const resolved = wonExits + lostExits;
  // the poison SHARE is the HIGH-price optimism over all booked exit $, not the gross suspect pile.
  const suspectShare = soldProceeds > 0 ? Math.round((suspectHigh / soldProceeds) * 1000) / 1000 : null;
  const avgSuspect = suspectPrices.length ? Math.round((suspectPrices.reduce((a, b) => a + b, 0) / suspectPrices.length) * 10) / 10 : null;
  suspect.sort((a, b) => b.proceedsUsd - a.proceedsUsd);

  // verdict keys on the HIGH-price optimism only — a future-0 sold cheaply is the exit working, not a fault.
  const verdict: ExitHonesty["verdict"] = resolved < 5 ? "insufficient" : suspectHigh >= materialUsd ? "material_optimism" : "benign";
  const hi = Math.round(suspectHigh), lo = Math.round(suspectLow);
  const note = verdict === "insufficient"
    ? `недостаточно закрытых выходов (${resolved}<5) — вердикт преждевременен`
    : verdict === "material_optimism"
      ? `⚠️ ОПТИМИЗМ МАТЕРИАЛЕН: $${hi} выручки книжено продажами будущих-0 по ≥${optimismFloorCents}¢ — это НАСТОЯЩАЯ переоценка exit-модели (продали ~по 100¢ то, что стоило 0). Отдельно $${lo} — защитные сбросы будущих-0 дешевле ${optimismFloorCents}¢ (выход РАБОТАЛ, вернул часть; в вину не идёт). Честная bid-модель должна отыграть высокоценовой хвост $${hi}; смена exit-модели оправдана (граница эпохи + пересчёт гейта)`
      : `✅ доброкачественно: настоящий оптимизм всего $${hi} (продажи будущих-0 по ≥${optimismFloorCents}¢, порог $${materialUsd}); ещё $${lo} — защитные сбросы дешевле ${optimismFloorCents}¢ (выход работал). Менять модель/эпоху не требуется`;
  return {
    exits: rows.length, wonExits, lostExits, unresolvedExits,
    soldProceedsUsd: Math.round(soldProceeds * 100) / 100,
    benignWonProceedsUsd: Math.round(benignWonProceeds * 100) / 100,
    benignWonForgoneUsd: Math.round(benignWonForgone * 100) / 100,
    suspectLostProceedsUsd: Math.round(suspectLostProceeds * 100) / 100,
    optimismFloorCents,
    suspectHighPriceUsd: Math.round(suspectHigh * 100) / 100,
    suspectLowPriceUsd: Math.round(suspectLow * 100) / 100,
    suspectShareOfSold: suspectShare, avgSuspectExitCents: avgSuspect,
    topSuspect: suspect.slice(0, 15), verdict, note,
  };
}
