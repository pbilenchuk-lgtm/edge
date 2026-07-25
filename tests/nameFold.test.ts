import { test } from "node:test";
import assert from "node:assert/strict";
import { foldLetters, foldToken } from "../src/lib/nameFold.js";

test("foldLetters bridges the locale letters NFD alone misses", () => {
  assert.equal(foldLetters("Zø" + "e"), "Zoe");        // ø → o
  assert.equal(foldLetters("Straße"), "Strasse");        // ß → ss
  assert.equal(foldLetters("Zirə"), "Zira");             // schwa → a
});

test("foldToken normalizes to teamTokens' canonical space (fold → strip diacritics → lower → alnum)", () => {
  assert.equal(foldToken("Neftçi"), "neftci");
  assert.equal(foldToken("Västerås"), "vasteras");
  assert.equal(foldToken("Zirə"), "zira");
  assert.equal(foldToken("  Köln  "), "koln");
  assert.equal(foldToken("PFK-99"), "pfk99");            // punctuation dropped, digits kept
  assert.equal(foldToken("—"), "");                       // no letters/digits → empty (rejected upstream)
});
