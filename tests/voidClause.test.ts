// ============================================================
// КЛАУЗА VOID — ФАКТ КОНКРЕТНОГО РЫНКА, А НЕ ВЫВОД ИЗ ЕГО ИМЕНИ (Р4, O14 буквально)
//
// Сверка с Gamma: ретайр-клауза РАЗНАЯ у семей ОДНОГО матча. Манилайн платит ПРОХОДЯЩЕМУ, сетовый тотал
// воидится по незавершению СЕТА, Completed Match уходит в «No». Одно «общее правило voidов» на все три
// невозможно: применив сетовую клаузу к манилайну, мы вернули бы ставку там, где биржа платит.
//
// Тексты ниже — ДОСЛОВНЫЕ из `description` рынков Polymarket (проверено на 11 матчах 08.08).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoidClause, clauseDisagrees, clauseSignature } from "../src/lib/voidClause.js";

const ML = `This market will resolve to the player who wins the match. If the match is canceled (not played at all), ends in a tie, or is delayed beyond 7 days from the scheduled date without a winner determined, this market will resolve to 50-50. If the match begins but is not completed, and one player advances due to the opponent's retirement, default, or disqualification, this market will resolve to the player who advances. If the match ends in a walkover (player withdraws before the start and the other advances automatically), this market will resolve to 50-50.`;
const SET_TOTAL = `This market will resolve to "Over" if the total number of games completed in the first set equals or exceeds 9. If the first set is not completed for any reason, this market will resolve 50-50. If the match is canceled before play begins, or delayed beyond 7 days without commencement, this market will also resolve 50-50.`;
const COMPLETED = `This market will resolve to "Yes" if all games and sets required to determine a match winner are played to completion through normal play. Otherwise, if the match is not completed for any reason, it will resolve to "No." If a forfeit of any kind occurs, including but not limited to a walkover or retirement, this market will resolve "No."`;

test("МАНИЛАЙН: при ретайре платит ПРОХОДЯЩЕМУ — это НЕ 50-50", () => {
  const c = parseVoidClause(ML);
  assert.equal(c.status, "parsed");
  assert.equal(c.onRetire, "advancer");
  assert.ok(c.quotes.some((q) => /advances/.test(q)), "вывод стоит на ЦИТАТЕ, иначе это наше утверждение");
});

test("СЕТОВЫЙ ТОТАЛ: область — СЕТ, а не матч", () => {
  const c = parseVoidClause(SET_TOTAL);
  assert.equal(c.status, "parsed");
  assert.equal(c.scope, "set");
  assert.ok(c.quotes.some((q) => /first set is not completed/i.test(q)));
});

test("COMPLETED MATCH: любой форфейт → «No»", () => {
  const c = parseVoidClause(COMPLETED);
  assert.equal(c.onRetire, "no");
  assert.equal(c.scope, "match");
});

test("ТРИ СЕМЬИ ОДНОГО МАТЧА ДАЮТ ТРИ РАЗНЫЕ КЛАУЗЫ — «общего правила» физически не существует", () => {
  const kinds = [ML, SET_TOTAL, COMPLETED].map((t) => parseVoidClause(t).onRetire);
  assert.equal(new Set(kinds).size, 3, `получили ${JSON.stringify(kinds)}`);
});

test("текста нет — «НЕ разобрана», а НЕ тихий дефолт к общему правилу", () => {
  const c = parseVoidClause(null);
  assert.equal(c.status, "unparsed");
  assert.deepEqual(c.quotes, []);
  assert.match(clauseSignature(c), /НЕ разобрана/);
});

test("РАСХОЖДЕНИЕ НАЗВАНО: манилайн против нашей матч-воидной логики", () => {
  const d = clauseDisagrees(parseVoidClause(ML), true);
  assert.equal(d.disagrees, true);
  assert.match(d.why, /платит ПРОХОДЯЩЕМУ/);
});

test("РАСХОЖДЕНИЕ НАЗВАНО: сетовый тотал против матч-воидной логики", () => {
  const d = clauseDisagrees(parseVoidClause(SET_TOTAL), true);
  assert.equal(d.disagrees, true);
  assert.match(d.why, /воидили бы сыгранный сет/);
});

test("НЕРАЗОБРАННОЕ НЕ СЧИТАЕТСЯ СОГЛАСИЕМ — иначе молчание оправдывало бы код", () => {
  const d = clauseDisagrees(parseVoidClause(""), true);
  assert.equal(d.disagrees, false);
  assert.match(d.why, /НЕ согласие/);
});

test("согласие тоже называется — сторож обязан уметь сказать «сходится»", () => {
  const d = clauseDisagrees(parseVoidClause(SET_TOTAL), false);
  assert.equal(d.disagrees, false);
  assert.match(d.why, /согласны/);
});
