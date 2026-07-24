// ============================================================
// EDGE LAB — CLEAN-FAVOURITE RETRO-BACKTEST  [SERVER-ONLY, read-only]  (P5, batch-7)
//
// Owner's "allow prematch back-favourite" was rejected wholesale — his own counter-example proves the gate
// catches model OVERCONFIDENCE too (Botafogo–Vitória: model 75% on a 0:0, the gate saved $360). So this is a
// HYPOTHESIS, tested by a criterion FIXED BEFORE the data, not a switch to flip:
//
//   cohort (defined before the data): «clean favourite» = derived P(win) ≥ 70% on a LIQUID main-line with
//   CONSISTENT quotes (no duplicate-outcome data-conflict flag), PREMATCH. Over settled history, compute the
//   would-be P&L of backing that side at its recorded price. The ABSTAINED sub-cohort (a clean favourite we did
//   NOT enter) is the anti-phantom-rejected proxy — the thing the hypothesis is about.
//
//   criterion: EV after fees > 0 with a margin ≥ 3pp at n ≥ 50 → enable a small cap (ft_blind pattern) a new
//   epoch; else the hypothesis is BURIED with numbers. Botafogo–Vitória is a mandatory labelled control.
//
// Read-only; never trades. Exposed at GET /api/profiles?report=clean_favourite.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { resolveFootballMarket, matchPhase } from "./settlement.js";
import { duplicateOutcomeConflicts } from "./analysis.js";

export interface CleanFavPick {
  match: string; league: string; label: string; probPct: number; priceCents: number;
  entered: boolean; outcome: "won" | "lost"; returnUsd: number; control: boolean;
}
export interface CohortStat { n: number; wins: number; winPct: number | null; meanReturnPct: number | null; evAfterFeesPct: number | null }
export interface CleanFavouriteBacktest {
  criteria: string[];
  minProbPct: number; minBookUsd: number; feePct: number; needN: number; marginPp: number;
  all: CohortStat; abstained: CohortStat; entered: CohortStat;
  control: CleanFavPick[];           // Botafogo–Vitória (mandatory control), if present
  verdict: "enable_small_cap" | "buried" | "insufficient";
  note: string;
  sample: CleanFavPick[];            // top abstained picks by |return| for eyeballing
}

const cohortStat = (picks: CleanFavPick[], feePct: number): CohortStat => {
  const n = picks.length;
  if (!n) return { n: 0, wins: 0, winPct: null, meanReturnPct: null, evAfterFeesPct: null };
  const wins = picks.filter((p) => p.outcome === "won").length;
  const meanRet = picks.reduce((s, p) => s + p.returnUsd, 0) / n;               // per $1 staked
  const evAfterFees = meanRet - feePct / 100;                                    // fee on turnover, per pick
  return { n, wins, winPct: Math.round((wins / n) * 1000) / 10, meanReturnPct: Math.round(meanRet * 1000) / 10, evAfterFeesPct: Math.round(evAfterFees * 1000) / 10 };
};

/** Retro-backtest the clean-favourite cohort over settled football history. Pure read. */
export function buildCleanFavouriteBacktest(db: Database, opts: { minProbPct?: number; minBookUsd?: number; feePct?: number; env?: Record<string, string | undefined> } = {}): CleanFavouriteBacktest {
  const env = opts.env ?? process.env;
  const minProbPct = opts.minProbPct ?? Number(env.CLEAN_FAV_MIN_PROB_PCT ?? 70);
  const minBookUsd = opts.minBookUsd ?? Number(env.CLEAN_FAV_MIN_BOOK_USD ?? 500);
  const feePct = opts.feePct ?? Number(env.CLEAN_FAV_FEE_PCT ?? 2);
  const needN = Number(env.CLEAN_FAV_NEED_N ?? 50);
  const marginPp = Number(env.CLEAN_FAV_MARGIN_PP ?? 3);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

  const picks: CleanFavPick[] = [];
  const control: CleanFavPick[] = [];
  const comps = new Map(R.listCompetitions(db).filter((c) => c.sport_id === "football").map((c) => [c.id, c]));
  for (const comp of comps.values()) {
    for (const m of R.listMatches(db, comp.id)) {
      if (m.state !== "finished" || m.score_home == null || m.score_away == null) continue;
      const markets = R.latestMarkets(db, m.id);
      if (!markets.length) continue;
      const conflicts = duplicateOutcomeConflicts(markets.map((mk) => ({ label: mk.label, priceCents: mk.price })));
      const enteredLabels = new Set(R.betsForMatch(db, m.id).map((b) => norm(b.market_label)));
      const isControl = /botafogo/i.test(m.home + m.away) && /vit[oó]ria/i.test(m.home + m.away);
      for (const mk of markets) {
        // Cohort membership (fixed BEFORE the data):
        if (mk.ai_prob == null || mk.ai_prob * 100 < minProbPct) continue;          // derived P(win) ≥ 70%
        if ((Number(mk.liquidity ?? 0) || 0) < minBookUsd) continue;                 // liquid main-line
        if (conflicts.has(mk.label)) continue;                                       // consistent quotes only
        if (mk.is_closing) continue;                                                 // prematch (not the kickoff/closing snapshot)
        if (mk.price <= 0 || mk.price >= 100) continue;
        const won = resolveFootballMarket(mk.label, m.score_home, m.score_away, { home: m.home, away: m.away }, matchPhase(m));
        if (won == null) continue;                                                   // unresolvable label → out
        // back the YES side at its recorded price: $1 stake → profit (100−p)/p if it wins, −1 if it loses.
        const returnUsd = won ? Math.round(((100 - mk.price) / mk.price) * 1000) / 1000 : -1;
        const pick: CleanFavPick = {
          match: `${m.home}—${m.away}`, league: String(comp.external_league || comp.name || "—"), label: mk.label,
          probPct: Math.round(mk.ai_prob * 1000) / 10, priceCents: mk.price, entered: enteredLabels.has(norm(mk.label)),
          outcome: won ? "won" : "lost", returnUsd, control: isControl,
        };
        picks.push(pick);
        if (isControl) control.push(pick);
      }
    }
  }

  const abstainedPicks = picks.filter((p) => !p.entered);
  const enteredPicks = picks.filter((p) => p.entered);
  const all = cohortStat(picks, feePct), abstained = cohortStat(abstainedPicks, feePct), entered = cohortStat(enteredPicks, feePct);

  // Criterion keys on the ABSTAINED cohort (the anti-phantom-rejected picks the hypothesis is about).
  const verdict: CleanFavouriteBacktest["verdict"] =
    abstained.n < needN ? "insufficient"
      : (abstained.evAfterFeesPct != null && abstained.evAfterFeesPct >= marginPp) ? "enable_small_cap" : "buried";
  const note = verdict === "insufficient"
    ? `недостаточно данных: abstained n=${abstained.n} < ${needN} — гипотеза преждевременна (Botafogo-Vitória в контроле: ${control.length})`
    : verdict === "enable_small_cap"
      ? `✅ ГИПОТЕЗА ПРОШЛА: back чистого фаворита (abstained) EV после комиссий +${abstained.evAfterFeesPct}пп ≥ ${marginPp}пп при n=${abstained.n} — включить малым кэпом (ft_blind-паттерн, новая эпоха)`
      : `❌ ГИПОТЕЗА ПОХОРОНЕНА: abstained EV после комиссий ${abstained.evAfterFeesPct}пп < ${marginPp}пп при n=${abstained.n} — гейт прав, недозаработка нет (модель переоценивает фаворита; Botafogo-Vitória подтверждает)`;

  const sample = [...abstainedPicks].sort((a, b) => Math.abs(b.returnUsd) - Math.abs(a.returnUsd)).slice(0, 20);
  return {
    criteria: [
      `«чистый фаворит» = derived P(win) ≥ ${minProbPct}%, ликвидный main-line (≥$${minBookUsd}), согласованные котировки (без data-conflict), предматч.`,
      `критерий: EV после комиссий (${feePct}%) > 0 с маржой ≥ ${marginPp}пп при n ≥ ${needN} на ABSTAINED (анти-phantom-отклонённые). Прошёл → малый кэп; нет → хоронится.`,
      `Botafogo–Vitória — обязательный контрольный кейс (модель переоценки, гейт спас $360).`,
    ],
    minProbPct, minBookUsd, feePct, needN, marginPp,
    all, abstained, entered, control, verdict, note, sample,
  };
}
