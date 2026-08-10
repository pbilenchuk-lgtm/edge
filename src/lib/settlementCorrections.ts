// ============================================================
// EDGE LAB — КОРРЕКТИРУЮЩИЕ ПРОВОДКИ РАСЧЁТА  (T4, ратифицировано 09.08)
//
// ЧТО НАШЁЛ ЗАМЕР VOID-КНИГИ. Из 11 матчей, помеченных у нас `settled_void`:
//   • 7 биржа разрешила БИНАРНО (Completed Match = Yes, outcomePrices 1/0) — это не void, а НАША
//     неспособность сверить. Мы вернули ставку там, где был выигрыш или проигрыш;
//   • 4 — настоящий void (все рынки события 0.5/0.5, Completed Match = No), но НЕДОПЛАЧЕННЫЙ: Polymarket
//     гасит ОБА токена по 0.5 за акцию, а мы книжили возврат ставки.
//
// ПОЧЕМУ ОШИБКА ФОРМУЛЫ ЖИЛА ТАК ДОЛГО. На входе ровно 50¢ она РАВНА НУЛЮ: shares×0.5 = stake. А 50¢ —
// это плейсхолдерная цена, где voidов больше всего. Дефект был невидим именно там, где чаще всего
// срабатывал, и проявлялся только на входах в стороне от середины.
//
// ═══ ТРИ ПРАВИЛА, БЕЗ КОТОРЫХ ЭТО СТАЛО БЫ ВПРЫСКОМ ФАНТОМА ═══
//
// 1. ИСТОРИЯ НЕ ПЕРЕПИСЫВАЕТСЯ. Исходная строка ставки остаётся как есть; правка — ОТДЕЛЬНАЯ строка со
//    ссылкой. Иначе «мы посчитали честно тогда» стало бы неотличимо от «мы поправили потом».
// 2. ПРОВЕНАНС ОБЯЗАТЕЛЕН И ПРОВЕРЯЕТСЯ. Улика приходит СНАРУЖИ (фактические цены погашения токенов) и
//    не может быть выведена из наших же данных: вывести правку из того, что и так неверно, — замкнутый
//    круг. Схема держит `evidence NOT NULL`, а планировщик отказывает строке без улики ПОИМЁННО.
// 3. PLAN ≠ APPLY. Сухой прогон — полноправное состояние в базе (`applied=0`), а не намерение в голове.
//    Деньги двигает только явное применение, и повтор ничего не удваивает (UNIQUE по bet_id).
//
// ЧТО СЮДА НЕ ВХОДИТ И ПОЧЕМУ. Восемь строк на $143 537 (17.07, утечка бюджета $1M) НЕ корректируются:
// их размер — артефакт испорченного сайзинга, а не решение стратегии. Пересеттлить их «по факту биржи»
// значило бы узаконить фантом в стотысячном масштабе. Они исключены ЯВНО и названы в отчёте.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";

/** Порог, выше которого ставка считается артефактом порчи сайзинга, а не решением стратегии. */
export const ARTIFACT_STAKE_USD = 1000;

export type CorrectionKind = "false_void_binary" | "true_void_underpaid";

/** Улика приходит ИЗВНЕ — из фактических цен погашения токенов. Вывести её из наших данных нельзя. */
export interface ResolutionEvidence {
  betId: string;
  /** true = биржа разрешила бинарно; false = сплит 0.5/0.5. */
  binary: boolean;
  /** При binary=true: выиграла ли НАША сторона. Null запрещён — без стороны правка невозможна. */
  ourSideWon?: boolean;
  /** Человекочитаемый провенанс: рынок, его outcomePrices, Completed Match. */
  evidence: string;
  evidenceSrc: string;
}

export interface PlannedCorrection {
  betId: string; kind: CorrectionKind;
  oldStatus: string; oldPayout: number;
  newStatus: string; newPayout: number;
  deltaUsd: number;
  evidence: string; evidenceSrc: string;
}
export interface CorrectionPlan {
  at: string;
  planned: PlannedCorrection[];
  /** Строки, ОТКАЗАННЫЕ планировщиком, и причина — поимённо. Молчаливый пропуск здесь недопустим. */
  refused: { betId: string; reason: string }[];
  totals: { rows: number; deltaUsd: number; falseVoid: number; trueVoid: number; excludedArtifacts: number };
  note: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Выплата при СПЛИТЕ: оба токена гасятся по 0.5 за акцию. shares = stake / (entry/100), значит
 * payout = stake × 50 / entry. На входе 50¢ это ровно stake — отсюда и невидимость дефекта.
 */
export function splitPayout(stake: number, entryCents: number): number {
  if (!(stake > 0) || !(entryCents > 0) || entryCents >= 100) return stake;
  return stake * 50 / entryCents;
}

/** Выплата при БИНАРНОМ исходе: выигрыш гасит акции по $1, проигрыш — по $0. */
export function binaryPayout(stake: number, entryCents: number, won: boolean): number {
  if (!won) return 0;
  if (!(stake > 0) || !(entryCents > 0) || entryCents >= 100) return stake;
  return stake * 100 / entryCents;
}

/**
 * Сухой прогон. Улики передаются СНАРУЖИ и по одной на ставку; строка без улики попадает в `refused`
 * С ПРИЧИНОЙ, а не исчезает. Ничего не пишет в `bets` и в леджер — только считает.
 */
export function planCorrections(db: Database, evidence: ResolutionEvidence[], nowIso: string): CorrectionPlan {
  const byBet = new Map(evidence.map((e) => [e.betId, e]));
  const planned: PlannedCorrection[] = [];
  const refused: { betId: string; reason: string }[] = [];
  let excludedArtifacts = 0;

  for (const b of R.allBets(db)) {
    if (b.status !== "settled_void") continue;
    const stake = b.stake ?? 0, entry = b.entry_price ?? 0, oldPayout = b.payout ?? 0;
    // АРТЕФАКТЫ ПОРЧИ САЙЗИНГА ИСКЛЮЧЕНЫ ЯВНО. Их размер — не решение стратегии, и «поправить по факту
    // биржи» здесь значило бы узаконить фантом, а не исправить учёт.
    if (stake > ARTIFACT_STAKE_USD) {
      excludedArtifacts++;
      refused.push({ betId: b.id, reason: `ставка $${Math.round(stake)} > $${ARTIFACT_STAKE_USD} — артефакт порчи сайзинга (утечка бюджета 17.07), НЕ корректируется` });
      continue;
    }
    const ev = byBet.get(b.id);
    if (!ev) { refused.push({ betId: b.id, reason: "нет улики резолюции — правка без провенанса не пишется" }); continue; }
    if (!(entry > 0)) { refused.push({ betId: b.id, reason: "цена входа неизвестна — выплату не из чего считать" }); continue; }

    if (ev.binary) {
      if (ev.ourSideWon == null) { refused.push({ betId: b.id, reason: "бинарная резолюция, но сторона НЕ названа — угадывать нельзя" }); continue; }
      const newPayout = r2(binaryPayout(stake, entry, ev.ourSideWon));
      planned.push({ betId: b.id, kind: "false_void_binary",
        oldStatus: b.status, oldPayout: r2(oldPayout), newStatus: ev.ourSideWon ? "settled_won" : "settled_lost",
        newPayout, deltaUsd: r2(newPayout - oldPayout), evidence: ev.evidence, evidenceSrc: ev.evidenceSrc });
    } else {
      const newPayout = r2(splitPayout(stake, entry));
      const delta = r2(newPayout - oldPayout);
      // Ноль дельты — это вход ровно на 50¢, где формула совпадает. Правка не нужна, и писать пустую
      // проводку значило бы засорять леджер строками, которые ничего не меняют.
      if (Math.abs(delta) < 0.01) { refused.push({ betId: b.id, reason: "вход ровно на 50¢ — старая и новая формулы совпадают, править нечего" }); continue; }
      planned.push({ betId: b.id, kind: "true_void_underpaid",
        oldStatus: b.status, oldPayout: r2(oldPayout), newStatus: "settled_void", newPayout, deltaUsd: delta,
        evidence: ev.evidence, evidenceSrc: ev.evidenceSrc });
    }
  }

  const deltaUsd = r2(planned.reduce((s, p) => s + p.deltaUsd, 0));
  const falseVoid = planned.filter((p) => p.kind === "false_void_binary").length;
  const trueVoid = planned.filter((p) => p.kind === "true_void_underpaid").length;
  return {
    at: nowIso, planned, refused,
    totals: { rows: planned.length, deltaUsd, falseVoid, trueVoid, excludedArtifacts },
    note: !planned.length
      ? `правок нет · отказано ${refused.length}${excludedArtifacts ? ` (из них артефактов сайзинга ${excludedArtifacts})` : ""}`
      : `СУХОЙ ПРОГОН: ${planned.length} правок на ${deltaUsd >= 0 ? "+" : ""}$${deltaUsd}`
        + ` (ложных void ${falseVoid}, недоплаченных настоящих ${trueVoid})`
        + ` · отказано ${refused.length}, из них артефактов сайзинга ${excludedArtifacts}`
        + ` · деньги НЕ двигались: это план, а не проводка`,
  };
}

/**
 * Применение. Пишет ТОЛЬКО в леджер правок — строка ставки остаётся нетронутой. Идемпотентно: UNIQUE по
 * bet_id, повтор ничего не удваивает.
 */
export function applyCorrections(db: Database, plan: CorrectionPlan, nowIso: string): { written: number; skipped: number } {
  let written = 0, skipped = 0;
  for (const p of plan.planned) {
    try {
      const res = db.prepare(
        `INSERT INTO settlement_corrections (id, bet_id, kind, old_status, old_payout, new_status, new_payout, delta_usd, evidence, evidence_src, applied, planned_at, applied_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(bet_id) DO NOTHING`,
      ).run(R.uid(), p.betId, p.kind, p.oldStatus, p.oldPayout, p.newStatus, p.newPayout, p.deltaUsd, p.evidence, p.evidenceSrc, nowIso, nowIso);
      (res.changes ?? 0) > 0 ? written++ : skipped++;
    } catch { skipped++; }
  }
  return { written, skipped };
}

/**
 * ВЫГРУЗКА ДЛЯ СБОРА УЛИК. Связывать нашу ставку с рынком биржи ПО ИМЕНИ нельзя: имена мы сами и
 * нормализуем, и совпадение имени — это наше утверждение о себе, а не о бирже. Связь идёт по CLOB-ТОКЕНУ:
 * `external_ref` = токен outcomes[0], `token_second` = токен outcomes[1]. Gamma отдаёт `clobTokenIds` и
 * `outcomes` в ОДНОМ порядке, поэтому совпадение токена даёт ИНДЕКС нашей стороны без единой догадки.
 * Строка без токена уедет в отказ — и это правильный отказ, а не повод угадать по подписи.
 */
export interface VoidEvidenceKitRow {
  betId: string; matchId: string; matchLabel: string; marketLabel: string;
  stake: number; entryCents: number | null; payout: number | null;
  tokenFirst: string | null; tokenSecond: string | null; outcomeFirst: string | null;
  isArtifact: boolean;
}
export function buildVoidEvidenceKit(db: Database): { rows: VoidEvidenceKitRow[]; note: string } {
  const rows: VoidEvidenceKitRow[] = [];
  for (const b of R.allBets(db)) {
    if (b.status !== "settled_void") continue;
    const m = R.getMatch(db, b.match_id);
    let tokenFirst: string | null = null, tokenSecond: string | null = null, outcomeFirst: string | null = null;
    try {
      const mk = R.latestMarkets(db, b.match_id).find((x) => x.label === b.market_label);
      tokenFirst = mk?.external_ref ?? null;
      tokenSecond = (mk as { token_second?: string | null } | undefined)?.token_second ?? null;
      outcomeFirst = (mk as { outcome_first?: string | null } | undefined)?.outcome_first ?? null;
    } catch { /* доски может не быть — уедет в отказ с названной причиной */ }
    rows.push({
      betId: b.id, matchId: b.match_id, matchLabel: m ? `${m.home} — ${m.away}` : b.match_id,
      marketLabel: b.market_label, stake: b.stake ?? 0, entryCents: b.entry_price ?? null, payout: b.payout ?? null,
      tokenFirst, tokenSecond, outcomeFirst, isArtifact: (b.stake ?? 0) > ARTIFACT_STAKE_USD,
    });
  }
  const withToken = rows.filter((r) => r.tokenFirst).length;
  return { rows, note: `${rows.length} строк void · с токеном ${withToken} · артефактов ${rows.filter((r) => r.isArtifact).length}`
    + ` · связь по ТОКЕНУ, не по имени: совпадение имени — наше утверждение о себе, а не о бирже` };
}

export interface CorrectionsLedger {
  at: string; rows: number; deltaUsd: number;
  byKind: { kind: string; n: number; deltaUsd: number }[];
  entries: { betId: string; kind: string; deltaUsd: number; evidence: string; appliedAt: string | null }[];
  note: string;
}

/** Чтение леджера. Существует затем, чтобы поправленная книга ЧИТАЛАСЬ как книга + правки, а не как
 *  переписанная книга: сумма правок обязана быть видна отдельным числом. */
export function buildCorrectionsLedger(db: Database, nowIso: string): CorrectionsLedger {
  let rows: { bet_id: string; kind: string; delta_usd: number; evidence: string; applied_at: string | null }[] = [];
  try {
    rows = db.prepare(`SELECT bet_id, kind, delta_usd, evidence, applied_at FROM settlement_corrections WHERE applied=1`).all() as typeof rows;
  } catch { rows = []; }
  const byKindMap = new Map<string, { kind: string; n: number; deltaUsd: number }>();
  for (const r of rows) {
    const g = byKindMap.get(r.kind) ?? { kind: r.kind, n: 0, deltaUsd: 0 };
    g.n++; g.deltaUsd = r2(g.deltaUsd + Number(r.delta_usd || 0));
    byKindMap.set(r.kind, g);
  }
  const deltaUsd = r2(rows.reduce((s, r) => s + Number(r.delta_usd || 0), 0));
  return {
    at: nowIso, rows: rows.length, deltaUsd,
    byKind: [...byKindMap.values()].sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd)),
    entries: rows.map((r) => ({ betId: r.bet_id, kind: r.kind, deltaUsd: r2(Number(r.delta_usd || 0)), evidence: r.evidence, appliedAt: r.applied_at })),
    note: !rows.length ? "правок не применялось — книга равна исходной"
      : `книга = исходная + ${rows.length} правок на ${deltaUsd >= 0 ? "+" : ""}$${deltaUsd}.`
        + ` Исходные строки НЕ переписаны: «посчитали честно тогда» и «поправили потом» остаются различимы.`,
  };
}
