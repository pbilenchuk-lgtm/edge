// ============================================================
// АУДИТ КЛАУЗ: СТОРОЖ, А НЕ РАЗОВАЯ СВЕРКА (Р4, часть 2)
//
// На выборке 09.08 расхождений было 0 из 14 — код прав. Но прав он был БЕЗ ДОКАЗАТЕЛЬСТВА: отличить его
// правоту от везения было нечем, и ничто не мешает Polymarket поменять формулировку завтра. Сторож
// переводит «сегодня сходится» в «мы узнаем, когда перестанет».
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initSchema } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { buildClauseAudit, clauseAuditLine, ourMatchScopeVoid } from "../src/lib/voidClauseAudit.js";

const NOW = "2026-08-10T12:00:00.000Z";
const SET_TOTAL = `This market will resolve to "Over" if the total number of games completed in the first set equals or exceeds 9. If the first set is not completed for any reason, this market will resolve 50-50.`;
const TOTAL_SETS = `This market will resolve based on the total number of sets played. If the match is canceled, ends in a tie, or is delayed beyond 7 days, this market will resolve to 50-50.`;
const ML = `If the match begins but is not completed, and one player advances due to the opponent's retirement, default, or disqualification, this market will resolve to the player who advances.`;

const db0 = () => { const db = openDb(":memory:"); initSchema(db); return db; };
const clause = (db: ReturnType<typeof db0>, label: string, desc: string) =>
  db.prepare(`INSERT INTO market_clauses (id, match_id, market_label, description, fetched_at) VALUES (?,?,?,?,?)`)
    .run(R.uid(), "m1", label, desc, NOW);

test("текстов нет — «читать нечего», а не «согласны»", () => {
  const a = buildClauseAudit(db0(), NOW);
  assert.equal(a.verdict, "unmeasured");
  assert.match(a.note, /читать нечего/);
});

test("СОГЛАСИЕ НАЗВАНО ЧИСЛОМ, и оно не выдаётся за вечное", () => {
  const db = db0();
  clause(db, "Set 1 Games O/U 8.5", SET_TOTAL);         // область СЕТ, наш код не матч-воидит → согласны
  clause(db, "Total Sets: Over 2.5", TOTAL_SETS);       // 50-50 при незавершении, наш код матч-воидит → согласны
  const a = buildClauseAudit(db, NOW);
  assert.equal(a.verdict, "agree");
  assert.equal(a.agree, 2);
  assert.equal(a.disagree, 0);
  assert.match(a.note, /если Polymarket поменяет формулировку, расхождение появится числом/);
});

test("РАСХОЖДЕНИЕ НАЗВАНО ПОИМЁННО, с ярлыком и причиной", () => {
  const db = db0();
  // Манилайн-клауза на рынке, который наш код считает матч-воидным, — вернули бы ставку там, где платят.
  clause(db, "Total Sets: Over 2.5", ML);
  const a = buildClauseAudit(db, NOW);
  assert.equal(a.verdict, "disagree");
  assert.equal(a.disagreements.length, 1);
  assert.equal(a.disagreements[0]!.label, "Total Sets: Over 2.5");
  assert.match(a.disagreements[0]!.why, /платит ПРОХОДЯЩЕМУ/);
  assert.match(a.note, /менять расчёт только через ратификацию/i);
});

test("НЕРАЗОБРАННОЕ НЕ ЗАЧТЕНО В СОГЛАСИЕ — молчание парсера не оправдывает код", () => {
  const db = db0();
  clause(db, "X", "Some prose with no void clause at all.");
  const a = buildClauseAudit(db, NOW);
  assert.equal(a.unparsed, 1);
  assert.equal(a.parsed, 0);
  assert.equal(a.verdict, "unmeasured", "ноль разобранных — НЕ согласие");
  assert.match(a.note, /это не согласие/);
});

test("зашитая семейная логика опознаётся по ярлыку — и её граница названа", () => {
  assert.ok(ourMatchScopeVoid("Total Sets: Over 2.5"));
  assert.ok(ourMatchScopeVoid("Set Handicap: A (-1.5) vs B (+1.5)"));
  assert.ok(ourMatchScopeVoid("A vs. B: Match O/U 22.5"));
  assert.ok(!ourMatchScopeVoid("A vs. B: Set 1 Games O/U 8.5"), "сетовый тотал — НЕ матч-воидный");
});

test("строка еженедельника печатает неразобранное отдельно от согласия", () => {
  const db = db0();
  clause(db, "Set 1 Games O/U 8.5", SET_TOTAL);
  clause(db, "X", "no clause here");
  assert.match(clauseAuditLine(buildClauseAudit(db, NOW)), /1\/1 согласны · расхождений 0 · не разобрано 1/);
});
