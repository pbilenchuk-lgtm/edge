import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import * as RR from "../src/lib/realRepo.js";
import { addWhitelistRow } from "../src/lib/executor/whitelist.js";
import { buildPhaseFReadiness } from "../src/lib/executor/phaseFReadiness.js";

const NOW = "2026-07-17T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const ENV = { REAL_TRADING: "dry_run", REAL_BANK_USD: "1000" };

function seed() {
  const db = openDb(":memory:"); initSchema(db);
  R.upsertSport(db, "football", "Футбол");
  R.insertStrategy(db, { id: "prematch_value", sport_id: "football", name: "PMV", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: NOW } as any);
  R.upsertCompetition(db, { id: "epl", sport_id: "football", name: "EPL", budget: 1000, external_league: "eng.1", created_at: NOW });
  R.insertMatch(db, { id: "m1", competition_id: "epl", home: "A", away: "B", state: "live", lineup_out: true, kickoff_at: NOW, minute: 30, score_home: 0, score_away: 0, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: null } as any);
  return db;
}
const paperBet = (db: any, decision: string) => R.insertBet(db, { id: R.uid(), match_id: "m1", strategy_id: "prematch_value", risk_profile_id: "medium", market_label: "Over 2.5", status: "settled_won", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: 60, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "предматч", result: "won", payout: 80, decision_id: decision, created_at: NOW } as any);
const realOrder = (db: any, o: { decision: string; status: RR.RealOrderStatus; fillCents?: number; filled?: number; createdAt?: string }) => {
  const id = R.uid();
  RR.insertRealOrder(db, { id, client_order_id: id, exchange_order_id: null, decision_id: o.decision, strategy_id: "prematch_value", profile_id: "medium", match_id: "m1", token_id: "0xTOK", side: "BUY", leg: "entry", limit_price_cents: 50, size_usd: 20, tif_sec: 30, status: o.status, code_version: null, whitelist_version: 1, note: "n", dry: 1, created_at: o.createdAt ?? NOW } as any);
  db.prepare(`UPDATE real_orders SET filled_size_usd=?, avg_fill_cents=? WHERE id=?`).run(o.filled ?? 0, o.fillCents ?? null, id);
  return id;
};
const position = (db: any, decision: string) => RR.upsertRealPosition(db, { token_id: "0xTOK", decision_id: decision, profile_id: "medium", match_id: "m1", strategy_id: "prematch_value", size_shares: 40, avg_price_cents: 50, realized_pnl_usd: 0, unrealized_pnl_usd: 0, updated_at: NOW } as any);

function happy() {
  const db = seed();
  addWhitelistRow(db, { strategyId: "prematch_value", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  paperBet(db, "d1");
  realOrder(db, { decision: "d1", status: "filled", fillCents: 49, filled: 20 }); // fill BELOW limit → negative slip, healthy
  position(db, "d1");
  return db;
}

test("phase-F readiness: clean dry contour → GO, no failed invariants", () => {
  const rep = buildPhaseFReadiness(happy(), ENV, nowMs);
  assert.equal(rep.counts.fail, 0, "no hard failures");
  assert.ok(rep.verdict === "go" || rep.verdict === "review", `verdict=${rep.verdict}`);
  const by = Object.fromEntries(rep.checks.map((c) => [c.id, c.status]));
  assert.equal(by.whitelist_target, "pass");
  assert.equal(by.twin_orphan_orders, "pass");
  assert.equal(by.filled_has_position, "pass");
  assert.equal(by.dry_fill, "pass");
  assert.equal(by.target_exercised, "pass");
  assert.equal(by.exposure_le_bank, "pass");
});

test("phase-F readiness: a real order with no paper twin → twin_orphan_orders FAIL → hold", () => {
  const db = happy();
  realOrder(db, { decision: "ghost", status: "filled", fillCents: 50, filled: 20 }); // decision_id not in bets
  const rep = buildPhaseFReadiness(db, ENV, nowMs);
  const c = rep.checks.find((x) => x.id === "twin_orphan_orders")!;
  assert.equal(c.status, "fail");
  assert.equal(rep.verdict, "hold");
});

test("phase-F readiness: a filled order without a position → filled_has_position FAIL", () => {
  const db = seed();
  addWhitelistRow(db, { strategyId: "prematch_value", categories: ["epl"], maxOrderUsd: 50, enabled: true }, "owner", NOW);
  paperBet(db, "d1");
  realOrder(db, { decision: "d1", status: "filled", fillCents: 49, filled: 20 }); // NO position inserted
  const rep = buildPhaseFReadiness(db, ENV, nowMs);
  assert.equal(rep.checks.find((x) => x.id === "filled_has_position")!.status, "fail");
  assert.equal(rep.verdict, "hold");
});

test("phase-F readiness: target strategy not whitelisted → whitelist_target FAIL", () => {
  const db = seed();
  paperBet(db, "d1");
  realOrder(db, { decision: "d1", status: "filled", fillCents: 49, filled: 20 });
  position(db, "d1");
  const rep = buildPhaseFReadiness(db, ENV, nowMs);
  assert.equal(rep.checks.find((x) => x.id === "whitelist_target")!.status, "fail");
  assert.equal(rep.verdict, "hold");
});

test("phase-F readiness: over-fill (filled > size) is caught as an impossible fill", () => {
  const db = happy();
  db.prepare(`UPDATE real_orders SET filled_size_usd=999 WHERE decision_id='d1'`).run();
  const rep = buildPhaseFReadiness(db, ENV, nowMs);
  assert.equal(rep.checks.find((x) => x.id === "no_overfill")!.status, "fail");
});

// ── [пункт 7] Пара исполнения в явном списке блокеров ───────────────────────────────────────────
// Веер по ликвидности: книга кэшируется на цикл, и несколько ставок исполняются об ОДИН стакан, не съедая
// его — каждая получает полную глубину, как будто пришла первой. На бумаге бесплатно, на реальных деньгах
// нет. Значит вся статистика исполнения систематически оптимистична, и вывод о ВМЕСТИМОСТИ на ней завышен.
const fill = (db: any, o: { betId: string; strategyId: string; at: string; usd: number; label?: string }) =>
  R.insertFillCost(db, { id: R.uid(), bet_id: o.betId, match_id: "m1", competition_id: "epl", strategy_id: o.strategyId, profile_id: "medium", side: "buy", shares: o.usd * 2, notional_usd: o.usd, quote_cents: 50, vwap_cents: 50, fee_cents: 0, fee_usd: 0, slip_cents: 0, slip_usd: 0, from_book: 1, created_at: o.at } as any);

const betOn = (db: any, id: string, profile: string, strategyId = "prematch_value") =>
  R.insertBet(db, { id, match_id: "m1", strategy_id: strategyId, risk_profile_id: profile, market_label: "Over 2.5", status: "open", proposed_price: 50, entry_price: 50, current_price: 50, closing_price: null, ai_prob: 0.6, stake: 40, rationale: "r", entered_minute: "предматч", result: null, payout: null, decision_id: `dx${id}`, created_at: NOW } as any);

test("пункт 7: веер по ликвидности у целевой стратегии — жёсткий блокер Phase F", () => {
  const db = happy();
  betOn(db, "p1", "medium"); betOn(db, "p2", "aggressive");
  // Два профиля одной стратегии исполнились об ОДИН стакан в ОДИН момент — глубина не съедалась.
  fill(db, { betId: "p1", strategyId: "prematch_value", at: NOW, usd: 40 });
  fill(db, { betId: "p2", strategyId: "prematch_value", at: NOW, usd: 40 });
  const rep = buildPhaseFReadiness(db, ENV, nowMs);
  const c = rep.checks.find((x) => x.id === "liquidity_fanout")!;
  assert.equal(c.status, "fail", "веер по целевой стратегии — блокер, а не примечание");
  assert.match(c.detail, /вместимости/, "и он прямо говорит, что вывод о вместимости на этих числах строить нельзя");
  assert.equal(rep.verdict, "hold");
});

test("пункт 7: веер по ЧУЖОЙ стратегии — предупреждение, но не блокер целевой", () => {
  const db = happy();
  R.insertStrategy(db, { id: "overreaction", sport_id: "football", name: "OVR", tag: "t", color: null, version: 1, prompt: "p", prompt_live: null, params: {}, model: null, model_live: null, created_at: NOW } as any);
  betOn(db, "q1", "medium", "overreaction"); betOn(db, "q2", "aggressive", "overreaction");
  fill(db, { betId: "q1", strategyId: "overreaction", at: NOW, usd: 30 });
  fill(db, { betId: "q2", strategyId: "overreaction", at: NOW, usd: 30 });
  const c = buildPhaseFReadiness(db, ENV, nowMs).checks.find((x) => x.id === "liquidity_fanout")!;
  assert.equal(c.status, "warn", "чужой веер не блокирует целевую стратегию, но и не молчит");
});

test("пункт 7: одиночные книжные филлы — веера нет", () => {
  const db = happy();
  betOn(db, "s1", "medium"); betOn(db, "s2", "aggressive");
  fill(db, { betId: "s1", strategyId: "prematch_value", at: NOW, usd: 40 });
  fill(db, { betId: "s2", strategyId: "prematch_value", at: "2026-07-17T12:05:00.000Z", usd: 40 }); // другой момент — другой стакан
  const c = buildPhaseFReadiness(db, ENV, nowMs).checks.find((x) => x.id === "liquidity_fanout")!;
  assert.equal(c.status, "pass");
});

test("пункт 7: отсутствие книжных филлов читается как «не измерено», а не как «веера нет»", () => {
  const c = buildPhaseFReadiness(happy(), ENV, nowMs).checks.find((x) => x.id === "liquidity_fanout")!;
  assert.equal(c.status, "warn");
  assert.match(c.detail, /«неизвестно», а не «нет»/);
});

// Предохранитель-берсерк складывал симуляцию и реальные деньги в один счётчик: в dry он молча подрезал
// сухую воронку, а на переходе к реалу отдал бы первым настоящим ордерам квоту, потраченную симуляцией.
test("пункт 7: предохранитель ордеров/час считает свой контур раздельно", () => {
  const db = happy();
  const c = buildPhaseFReadiness(db, ENV, nowMs).checks.find((x) => x.id === "berserk_scope")!;
  assert.equal(c.status, "pass", "признак режима на ордере есть — контуры разделены");
});
