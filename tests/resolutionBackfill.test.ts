// ============================================================
// ДОЧИТЫВАНИЕ РЕЗОЛЮЦИИ ПОСЛЕ ФИНАЛА (Р3, часть 1)
//
// Замер 09.08: у сыгранного матча (2:0) рынок `Completed Match` стоял в базе на 50/50, хотя на бирже давно
// `['0','1'], closed:true`. Причина структурная: `refreshActiveOdds` обновляет НЕзавершённые матчи — для
// торговли верно, для улики наоборот: резолюция появляется ровно тогда, когда обновление выключается.
//
// Свойства ниже: пишем в ОТДЕЛЬНЫЙ стол (иначе «текущая цена» тихо станет «исходом»), непрочитанное не
// выдаётся за неразрешённое, повтор не плодит строк.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { backfillResolutions, buildResolutionCoverage, BACKFILL_MIN_AGE_MIN } from "../src/lib/resolutionBackfill.js";

const NOW = "2026-08-10T12:00:00.000Z";
const OLD = "2026-08-10T10:00:00.000Z";   // 2ч назад — старше выдержки

function db0() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: OLD } as never);
  return db;
}
function match(db: ReturnType<typeof db0>, id: string, state: string, kickoff: string) {
  R.insertMatch(db, { id, competition_id: "atp", home: "A", away: "B", state, lineup_out: true, kickoff_at: kickoff,
    minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null,
    duration: null, end_note: null, external_ref: id } as never);
}
function mkt(db: ReturnType<typeof db0>, matchId: string, label: string, token: string) {
  R.insertMarket(db, { id: R.uid(), match_id: matchId, label, price: 50, ai_prob: null, liquidity: "100",
    external_ref: token, snapshot_at: OLD, is_closing: false } as never);
}
const resolver = (m: Record<string, { priceCents: number | null; closed: boolean }>) => async () => m;

test("дочитывает резолюцию сыгранного матча — снимок больше не замирает раньше факта", async () => {
  const db = db0();
  match(db, "m1", "finished", OLD);
  mkt(db, "m1", "Completed Match — Yes", "T1");
  const r = await backfillResolutions(db, { now: () => NOW, resolveTokens: resolver({ T1: { priceCents: 0, closed: true } }) } as never);
  assert.deepEqual({ m: r.matches, res: r.resolved }, { m: 1, res: 1 });
  const row = db.prepare(`SELECT * FROM market_resolutions WHERE match_id='m1'`).get() as any;
  assert.equal(row.price_cents, 0);
  assert.equal(row.closed, 1);
  assert.equal(row.src, "gamma_token_resolution");
});

test("ТОРГОВЫЙ СНИМОК НЕ ТРОНУТ: «текущая цена» не становится «исходом»", async () => {
  const db = db0();
  match(db, "m1", "finished", OLD);
  mkt(db, "m1", "Completed Match — Yes", "T1");
  await backfillResolutions(db, { now: () => NOW, resolveTokens: resolver({ T1: { priceCents: 100, closed: true } }) } as never);
  // Именно на этом обжигались: калибровка по «текущим ценам» сыгранных матчей дала 92% попаданий,
  // потому что цена И БЫЛА исходом. Два вопроса — два стола.
  assert.equal(R.latestMarkets(db, "m1")[0]!.price, 50, "рынок остался с торговой ценой");
});

test("НЕПРОЧИТАННОЕ ≠ НЕРАЗРЕШЁННОЕ: токена нет в ответе — молчим и вернёмся", async () => {
  const db = db0();
  match(db, "m1", "finished", OLD);
  mkt(db, "m1", "X", "T1");
  const r = await backfillResolutions(db, { now: () => NOW, resolveTokens: resolver({}) } as never);
  assert.equal(r.resolved, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM market_resolutions`).get() as { n: number }).n, 0,
    "своя слепота НЕ записывается как свойство биржи");
});

test("незавершённый матч не дочитывается — резолюции ещё нет в природе", async () => {
  const db = db0();
  match(db, "m1", "live", OLD);
  mkt(db, "m1", "X", "T1");
  const r = await backfillResolutions(db, { now: () => NOW, resolveTokens: resolver({ T1: { priceCents: 100, closed: true } }) } as never);
  assert.equal(r.matches, 0);
});

test("матч моложе выдержки пропускается — резолюция не появляется в секунду свистка", async () => {
  const db = db0();
  const fresh = new Date(Date.parse(NOW) - (BACKFILL_MIN_AGE_MIN - 5) * 60_000).toISOString();
  match(db, "m1", "finished", fresh);
  mkt(db, "m1", "X", "T1");
  assert.equal((await backfillResolutions(db, { now: () => NOW, resolveTokens: resolver({ T1: { priceCents: 100, closed: true } }) } as never)).matches, 0);
});

test("повтор не плодит строк", async () => {
  const db = db0();
  match(db, "m1", "finished", OLD);
  mkt(db, "m1", "X", "T1");
  const deps = { now: () => NOW, resolveTokens: resolver({ T1: { priceCents: 100, closed: true } }) } as never;
  await backfillResolutions(db, deps);
  await backfillResolutions(db, deps);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM market_resolutions`).get() as { n: number }).n, 1);
});

test("покрытие различает «не дочитали» и «не разрешён»", async () => {
  const db = db0();
  match(db, "m1", "finished", OLD); mkt(db, "m1", "Completed Match — Yes", "T1");
  match(db, "m2", "finished", OLD); mkt(db, "m2", "X", "T2");
  await backfillResolutions(db, { now: () => NOW, resolveTokens: resolver({ T1: { priceCents: 100, closed: true } }) } as never);
  const c = buildResolutionCoverage(db, NOW);
  assert.equal(c.finishedMatches, 2);
  assert.equal(c.withAnyResolution, 1, "второй матч НЕ дочитан — это не «не разрешён»");
  assert.equal(c.oracle.present, 1);
  assert.equal(c.oracle.resolved, 1);
  assert.match(c.note, /НАША слепота, а не свойство биржи/);
});

test("оракула нет — сказано прямо, а не показано нулём разрешённых", () => {
  const db = db0();
  match(db, "m1", "finished", OLD);
  const c = buildResolutionCoverage(db, NOW);
  assert.match(c.oracle.note, /читать пока нечего/);
});
