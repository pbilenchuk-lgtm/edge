// ============================================================
// EDGE LAB — ПРИЗРАК «ЖДЁМ КОРТ» СЪЕДАЛ ФУТБОЛ ЧЕРЕЗ ОБЩИЙ ЛОК
//
// 30.07, 16:35 UTC. Крон не делал полного цикла 56 минут — ровно в окно старта футбольного слейта.
// Живой цикл при этом работал: `[live] live 130 · входы 0`. Разбор набора «в игре»:
//
//   ТЕННИС: lineup 123, live 0   (69 матчей с кикоффом >3ч назад)
//   ФУТБОЛ: lineup 5,   live 2
//
// Теннисный матч выводит из lineup ТОЛЬКО скаут — и он был слеп с 29.07. Потолок против зависания
// существовал, но лишь для state="live"; для запертых в lineup его не было, а `hoursUntil` после
// кикоффа отрицателен, поэтому ветка расписания уже ничего не делала. 123 матча-призрака остались
// в наборе навсегда.
//
// Дальше сработала связка, которую никто не проектировал: runLiveCycle считает in-play всё, где
// стоит lineup_out; набор раздулся до 130; живой цикл каждые 20с перемалывал их все, удерживая
// ОБЩИЙ engineLock; медленный цикл, где живут анализ и входы, не мог его взять и просрочился на
// полчаса. Футбол не входил никуда потому, что ослеп ТЕННИСНЫЙ провайдер.
//
// Отсюда правило: ни один призрак не имеет права числиться «в игре» дольше потолка своего вида
// спорта. Терминальное состояние при этом НЕ выдумывается — результата у нас нет.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { advanceClocks, maxLiveMinutes } from "../src/lib/lifecycle.js";
import { migrateTennisStrategy } from "../src/lib/seed.js";

const NOW = "2026-07-30T16:35:00.000Z";
const minutesAgo = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();

function seed(db: ReturnType<typeof openDb>) {
  migrateTennisStrategy(db);
  R.upsertSport(db, "tennis", "Теннис");
  R.upsertCompetition(db, { id: "pm-atp", sport_id: "tennis", name: "ATP", budget: 0, external_league: null, created_at: "t" });
}
function addMatch(db: ReturnType<typeof openDb>, kickoffAt: string, state: "lineup" | "upcoming", lineupOut: boolean) {
  const id = R.uid();
  R.insertMatch(db, {
    id, competition_id: "pm-atp", home: `P${id.slice(0, 4)}`, away: `Q${id.slice(0, 4)}`, state, lineup_out: lineupOut,
    kickoff_at: kickoffAt, minute: null, score_home: null, score_away: null, final_score: null,
    kickoff_time: null, end_time: null, duration: null, end_note: null, external_ref: id,
  });
  return id;
}

test("призрак «ждём корт» старше потолка выпадает из набора «в игре» — и это обратимо, а не выдуманный финиш", () => {
  const db = openDb(":memory:");
  seed(db);
  const ceiling = maxLiveMinutes("tennis");
  const ghost = addMatch(db, minutesAgo(ceiling + 60), "lineup", true);   // кикофф давно, скаут не видел
  const fresh = addMatch(db, minutesAgo(30), "lineup", true);             // идёт прямо сейчас

  advanceClocks(db, { now: () => NOW } as any);

  const g = R.getMatch(db, ghost)!;
  assert.equal(g.lineup_out, false, "призрак снят с учёта «в игре» — иначе живой цикл платит за него каждые 20с");
  assert.notEqual(g.state, "finished", "терминальное состояние НЕ выдумывается: результата у нас нет");
  assert.equal(g.state, "upcoming");

  const f = R.getMatch(db, fresh)!;
  assert.equal(f.lineup_out, true, "матч в пределах потолка остаётся в игре — жнец не трогает живое");
  assert.equal(f.state, "lineup");
});

test("призрак с ОТКРЫТОЙ позицией не трогается — деньгами владеют сеттл и поллер", () => {
  const db = openDb(":memory:");
  seed(db);
  const funded = addMatch(db, minutesAgo(maxLiveMinutes("tennis") + 600), "lineup", true);
  R.insertBet(db, {
    id: "ghost-open", match_id: funded, strategy_id: "tennis_overreaction", risk_profile_id: "medium",
    market_label: "P vs Q", status: "open", proposed_price: 60, entry_price: 60, current_price: 60,
    closing_price: null, ai_prob: 0.7, stake: 50, rationale: "тест", entered_minute: "сет 1",
    result: null, payout: null, settled_by: null, settled_at: null, entry_meta: null,
    code_version: "e9", created_at: minutesAgo(120),
  } as any);

  advanceClocks(db, { now: () => NOW } as any);

  const m = R.getMatch(db, funded)!;
  assert.equal(m.lineup_out, true, "с открытой позицией матч остаётся под наблюдением, как и в live-ветке");
  assert.equal(m.state, "lineup");
});

test("жнец не воскрешает и не хоронит: повторный прогон идемпотентен, скаут может вернуть матч", () => {
  const db = openDb(":memory:");
  seed(db);
  const ghost = addMatch(db, minutesAgo(maxLiveMinutes("tennis") + 60), "lineup", true);

  advanceClocks(db, { now: () => NOW } as any);
  advanceClocks(db, { now: () => NOW } as any);

  const m = R.getMatch(db, ghost)!;
  assert.equal(m.state, "upcoming");
  assert.equal(m.lineup_out, false);
  // Матч всё ещё АКТИВЕН (не finished) — значит скаут по-прежнему обходит его и переведёт в live,
  // если игра появится в ленте. Обратимость — это и есть причина не ставить finished.
  assert.notEqual(m.state, "finished");
});
