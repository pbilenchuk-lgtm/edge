// ============================================================
// EDGE LAB — MEASUREMENT SLICE: were melting options cut on the bottom?
//
// The Argentina–Switzerland loss (Switzerland Over 0.5 cut at 31–43¢ on 54',
// goal on 64', market 95¢) raised the question: do we SYSTEMATICALLY cut melting
// options (bets that win on a future EVENT — team Over 0.5/1.5, BTTS-Yes) right
// before the event lands? This report answers it from accumulated data BEFORE we
// calibrate the Fix-1 game-state multipliers: every early-closed melting-option
// position, whether the event then occurred by full time, and the delta left on
// the table — bucketed by the minute of the cut (<60' / 60–75' / 75'+).
//
// Read-only: no money moves here. If the "occurred after cut" fraction is high we
// calibrate the multipliers up; if low, the case was a tail and they stay conservative.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { winsOnEventOccurrence } from "./thresholds.js";

// Latest market price (¢) at/above which the melting option is treated as RESOLVED
// YES — the event effectively happened. Env-tunable.
const OCCURRED_CENTS = (() => { const n = Number(process.env.MELT_REPORT_OCCURRED_CENTS); return Number.isFinite(n) && n > 0 ? n : 85; })();

export type CutBucket = "<60" | "60-75" | "75+";
export type CutReason = "time_stop" | "counter_scenario" | "thesis_stop" | "take_price" | "stop" | "other";

export interface MeltCut {
  matchId: string; home: string; away: string; market: string;
  entryCents: number | null;
  cutCents: number | null;      // the price the slice was closed at
  cutMinute: number | null;     // match minute of the cut (from the exit log, else estimated)
  reason: CutReason;
  finalCents: number | null;    // last market price for the label (event's eventual read)
  eventOccurred: boolean | null; // finalCents >= OCCURRED_CENTS (null when no final price)
  missedDeltaCents: number | null; // finalCents − cutCents (positive = left on the table)
  bucket: CutBucket;
  settledAt: string | null;
}

export interface MeltBucketAgg {
  bucket: CutBucket; cuts: number;
  occurred: number; occurredFraction: number | null;
  avgMissedDeltaWhenOccurred: number | null; // mean (final − cut) over the occurred-after-cut cuts
}

export interface MeltReport {
  cuts: MeltCut[];
  total: number;
  withFinal: number;             // how many had a resolvable final price (denominator for fractions)
  occurred: number;
  occurredFraction: number | null;
  avgMissedDeltaWhenOccurred: number | null;
  byBucket: MeltBucketAgg[];
  byReason: { reason: CutReason; cuts: number; occurred: number }[];
  occurredCents: number;         // the threshold used, for transparency
}

/** Parse the leading match-minute from a minute label ("64'", "45'+2'", "≈70'") → 64/70. */
function minuteFromLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = String(label).match(/(\d{1,3})/);
  return m ? Number(m[1]) : null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Classify an exit reason string into a coarse category for the aggregate. */
export function classifyCutReason(text: string): CutReason {
  const t = text.toLowerCase();
  if (/time_stop|тайм-стоп/.test(t)) return "time_stop";
  if (/counter_scenario|контр-ветк|контр-сценар|counter/.test(t)) return "counter_scenario";
  if (/thesis_stop|тезис|слома|сломан/.test(t)) return "thesis_stop";
  if (/take_price|тейк|edge (исчерп|закры|closed)|цена (дош|дости|пришла)|фикс|прибыл|на пике/.test(t)) return "take_price";
  if (/стоп|\bstop\b|тайм-флор|time_decay/.test(t)) return "stop";
  return "other";
}

function bucketOf(minute: number | null): CutBucket {
  if (minute == null || minute < 60) return "<60";
  if (minute <= 75) return "60-75";
  return "75+";
}

export function meltingOptionCutReport(db: Database): MeltReport {
  const cuts: MeltCut[] = [];
  // Group the settled early/partial melting-option bets by match so we fetch each
  // match's final markets + trade log once.
  type Bet = ReturnType<typeof R.allBets>[number];
  const byMatch = new Map<string, Bet[]>();
  for (const b of R.allBets(db)) {
    const settledEarly = (b.settled_by === "early" || b.settled_by === "partial");
    if (!settledEarly) continue;
    if (!winsOnEventOccurrence(b.market_label)) continue;
    const arr = byMatch.get(b.match_id) ?? [];
    arr.push(b); byMatch.set(b.match_id, arr);
  }
  for (const [matchId, bets] of byMatch) {
    const m = R.getMatch(db, matchId);
    if (!m) continue;
    // Final read per label: the latest market snapshot (for a settled match this is
    // the closing/last price — our proxy for whether the event resolved YES).
    const finalByLabel = new Map<string, number>();
    for (const mk of R.latestMarkets(db, matchId)) if (mk.price != null) finalByLabel.set(norm(mk.label), mk.price);
    const exits = R.tradeLogForMatch(db, matchId).filter((e) => e.type === "exit");
    for (const b of bets) {
      // Match the exit log entry for this position: same market label (guillemets), and
      // the closest close price to the recorded closing_price — gives minute + reason.
      const candidates = exits.filter((e) => e.text.includes(`«${b.market_label}»`));
      const cut = b.closing_price;
      const pick = candidates.length
        ? candidates.reduce((best, e) => {
            const pe = Number((e.text.match(/@ (\d+(?:\.\d+)?)¢/) ?? [])[1]);
            const pb = Number((best.text.match(/@ (\d+(?:\.\d+)?)¢/) ?? [])[1]);
            if (cut == null) return best;
            return Math.abs((pe || 1e9) - cut) < Math.abs((pb || 1e9) - cut) ? e : best;
          })
        : null;
      const reason = classifyCutReason(pick?.text ?? b.rationale ?? "");
      // Cut minute: prefer the exit-log minute label; else estimate from settled_at−kickoff.
      let cutMinute = minuteFromLabel(pick?.minute);
      if (cutMinute == null && b.settled_at && m.kickoff_at) {
        const dt = Date.parse(b.settled_at) - Date.parse(m.kickoff_at);
        if (Number.isFinite(dt) && dt > 0) cutMinute = Math.min(120, Math.floor(dt / 60000));
      }
      const finalCents = finalByLabel.get(norm(b.market_label)) ?? null;
      const eventOccurred = finalCents == null ? null : finalCents >= OCCURRED_CENTS;
      const missedDeltaCents = (finalCents != null && cut != null) ? Math.round((finalCents - cut) * 10) / 10 : null;
      cuts.push({
        matchId, home: m.home, away: m.away, market: b.market_label,
        entryCents: b.entry_price, cutCents: cut, cutMinute, reason,
        finalCents, eventOccurred, missedDeltaCents,
        bucket: bucketOf(cutMinute), settledAt: b.settled_at ?? null,
      });
    }
  }
  // Aggregates — fractions computed only over cuts with a resolvable final price.
  const withFinalCuts = cuts.filter((c) => c.eventOccurred != null);
  const occurredCuts = withFinalCuts.filter((c) => c.eventOccurred);
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const missedWhenOccurred = occurredCuts.map((c) => c.missedDeltaCents).filter((x): x is number => x != null);
  const buckets: CutBucket[] = ["<60", "60-75", "75+"];
  const byBucket: MeltBucketAgg[] = buckets.map((bk) => {
    const inB = withFinalCuts.filter((c) => c.bucket === bk);
    const occ = inB.filter((c) => c.eventOccurred);
    const missed = occ.map((c) => c.missedDeltaCents).filter((x): x is number => x != null);
    return {
      bucket: bk, cuts: inB.length, occurred: occ.length,
      occurredFraction: inB.length ? Math.round((occ.length / inB.length) * 100) / 100 : null,
      avgMissedDeltaWhenOccurred: mean(missed),
    };
  });
  const reasons: CutReason[] = ["time_stop", "counter_scenario", "thesis_stop", "take_price", "stop", "other"];
  const byReason = reasons.map((rz) => {
    const inR = cuts.filter((c) => c.reason === rz);
    return { reason: rz, cuts: inR.length, occurred: inR.filter((c) => c.eventOccurred).length };
  }).filter((r) => r.cuts > 0);
  return {
    cuts, total: cuts.length, withFinal: withFinalCuts.length,
    occurred: occurredCuts.length,
    occurredFraction: withFinalCuts.length ? Math.round((occurredCuts.length / withFinalCuts.length) * 100) / 100 : null,
    avgMissedDeltaWhenOccurred: mean(missedWhenOccurred),
    byBucket, byReason, occurredCents: OCCURRED_CENTS,
  };
}
