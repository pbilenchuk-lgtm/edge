// ============================================================
// EDGE LAB — batch-12, пункт 5: три дыры между «решением» и «деньгами»
//
//   • кэп матча/кластера читал только ИСПОЛНЕННОЕ (open), хотя обязательство возникает уже у proposed;
//   • слепой вход (ft_blind) мерил грейс от РОЖДЕНИЯ ТЕЗИСА, а не от момента, когда уходят деньги;
//   • дата-гейт привязки проваливался в «первый попавшийся кандидат», когда у события нет даты.
//
// Все три — один класс: правило написано про одно, а проверяется на другом.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/lib/db.js";
import { seedDatabase } from "../src/lib/seed.js";
import * as R from "../src/lib/repo.js";
import { enrichFromEspn } from "../src/lib/engine.js";
import { committedBets } from "../src/lib/analysis.js";
import type { SportsMatchStatus, SportsProvider } from "../src/lib/sports.js";

// ── 1. Кэп матча и кластера считает ОБЯЗАТЕЛЬСТВА ───────────────────────────────────────────────
// autoAnalyze идёт ДО autoEnter в тике, а pre_lineup и post_lineup — два независимых прогона. Считая
// только open, второй прогон видел пустой матч и мог напредлагать ещё столько же: до 2× кэпа матча и
// кластера, и оба пакета филлятся. Comp-кэп (strategyCompExposure) proposed учитывал всегда — это была
// асимметрия внутри одного и того же счёта.
test("п.5: экспозиция матча/кластера = open + proposed, не только open", () => {
  const bets = [
    { status: "open", risk_profile_id: "medium", stake: 100 },
    { status: "proposed", risk_profile_id: "medium", stake: 90 },
    { status: "not_filled", risk_profile_id: "medium", stake: 500 },
    { status: "settled_won", risk_profile_id: "medium", stake: 400 },
    { status: "proposed", risk_profile_id: "aggressive", stake: 300 },
    { status: "open", risk_profile_id: null, stake: 50 },   // null → medium по умолчанию
  ];
  const med = committedBets(bets as { status: string; risk_profile_id: string | null; stake: number }[], "medium");
  assert.deepEqual(med.map((b) => b.stake), [100, 90, 50], "open + proposed своего профиля, включая null→medium");
  assert.equal(med.reduce((s, b) => s + b.stake, 0), 240, "обязательства, а не только исполненное");
  assert.deepEqual(committedBets(bets as { status: string; risk_profile_id: string | null; stake: number }[], "aggressive").map((b) => b.stake), [300], "чужой профиль не подмешивается");
  assert.ok(!med.some((b) => b.status === "not_filled" || b.status === "settled_won"),
    "отменённое и закрытое обязательством не является — иначе кэп зажимал бы навсегда");
});

// ── 2. Привязка без даты события: несколько кандидатов = жребий ──────────────────────────────────
// StatPal-фид дат не отдаёт вовсе, и весь дата-гейт проваливался в candidates[0]. Двухматчевые пары
// UEFA/CONMEBOL прикрыты списком, но «кубок + лига» одних и тех же команд в списке не значится — класс
// Seattle–Portland. Цена ошибки — не пропущенная привязка, а ЧУЖОЙ СЧЁТ на живом матче и сеттл по нему.
const datelessProvider = (home: string, away: string): SportsProvider => ({
  name: "mock",
  async scoreboard() {
    return [{ externalRef: "SP1", home, away, state: "live", minute: 33, scoreHome: 2, scoreAway: 0, final: false }] as SportsMatchStatus[];
  },
  async matchDetail() { return null; },
});

// Оба кикоффа уже в прошлом относительно этого «сейчас» — иначе сработал бы отдельный гвард
// finished_before_kickoff («матч не может идти раньше собственного старта»), и тест мерил бы не то.
const AFTER_BOTH = "2026-08-02T04:00:00Z";

const seedTwoComps = (db: ReturnType<typeof openDb>) => {
  R.upsertCompetition(db, { id: "pm-mls", sport_id: "football", name: "MLS", budget: 1000, external_league: "usa.1", created_at: "t" });
  R.upsertCompetition(db, { id: "pm-cup", sport_id: "football", name: "Leagues Cup", budget: 1000, external_league: "concacaf.leagues.cup", created_at: "t" });
};
const mkMatch = (db: ReturnType<typeof openDb>, id: string, comp: string, ko: string) =>
  R.insertMatch(db, { id, competition_id: comp, home: "Seattle Sounders", away: "Portland Timbers", state: "upcoming", lineup_out: false, kickoff_at: ko, minute: null, score_home: null, score_away: null, final_score: null, kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id });

test("п.5: событие без даты + несколько кандидатов → НЕ привязано (класс Seattle–Portland)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  seedTwoComps(db);
  // Одни и те же соперники дважды за неделю в РАЗНЫХ турнирах — имена совпадают у обоих.
  mkMatch(db, "m-cup", "pm-cup", "2026-07-29T02:00:00Z");
  mkMatch(db, "m-mls", "pm-mls", "2026-08-02T02:00:00Z");
  const res = await enrichFromEspn(db, datelessProvider("Seattle Sounders", "Portland Timbers"), { now: () => AFTER_BOTH });
  assert.equal(res.enriched, 0, "различить нечем → не привязано ни к кому");
  assert.equal(R.getMatchLive(db, "m-cup"), undefined, "нет привязки к кубку");
  assert.equal(R.getMatchLive(db, "m-mls"), undefined, "нет привязки к лиге");
  assert.equal(R.getMatch(db, "m-cup")!.score_home, null, "чужой счёт не записан");
  assert.equal(R.getMatch(db, "m-mls")!.score_home, null, "чужой счёт не записан");
  const tally = JSON.parse(R.metaGet(db, "fixture_leg_mismatch") as string);
  assert.ok(tally.dateGap >= 1, "отказ ПОСЧИТАН, а не проглочен");
});

test("п.5: событие без даты + ЕДИНСТВЕННЫЙ кандидат → привязка сохраняется (не ломаем StatPal-покрытие)", async () => {
  const db = openDb(":memory:");
  seedDatabase(db);
  seedTwoComps(db);
  mkMatch(db, "m-only", "pm-mls", "2026-08-02T02:00:00Z");
  const res = await enrichFromEspn(db, datelessProvider("Seattle Sounders", "Portland Timbers"), { now: () => AFTER_BOTH });
  assert.ok(res.enriched >= 1, "выбирать не из чего — легаси-привязка по именам жива");
  assert.equal(R.getMatch(db, "m-only")!.score_home, 2, "счёт записан");
});
