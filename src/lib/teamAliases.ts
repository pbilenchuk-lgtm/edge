// ============================================================
// EDGE LAB — persisted team-name ALIAS overlay  [S11, coverage sprint]
//
// TEAM_EXONYMS (engine.ts) is a STATIC in-code map: every name-mismatch the &probe surfaces
// («Neftçi PFK» ↔ «Neftchi Baku») needs a code edit + redeploy before that fixture can ever bind. A
// coverage SPRINT has to close such gaps as they're found, not next release. This is a DB-backed overlay
// (app_meta JSON) merged OVER TEAM_EXONYMS at match time: add an alias → the fixture binds on the next pass.
//
// Safety is unchanged from the static map: an alias only maps one spelling TOKEN to another canonical token;
// nameMatch's distinctive-token subset gate still holds, so an alias can bridge a real pair but cannot invent
// a false match (two different Vienna clubs keep their distinct rapid/austria tokens). Keys+values are
// normalized through the SAME foldToken the live path uses, so an added alias lands in the exact token space.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { foldToken } from "./nameFold.js";

const KEY = "team_aliases";

export interface TeamAlias { from: string; to: string; addedAt?: string }

/** The overlay as a folded-token → folded-token map (the shape teamTokens consumes). Malformed store → {}. */
export function getTeamAliases(db: Database): Record<string, string> {
  try {
    const raw = JSON.parse(R.metaGet(db, KEY) ?? "null");
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.aliases)) return {};
    const out: Record<string, string> = {};
    for (const a of raw.aliases as TeamAlias[]) {
      const f = foldToken(a.from), t = foldToken(a.to);
      if (f && t && f !== t) out[f] = t;
    }
    return out;
  } catch { return {}; }
}

/** The overlay as a human-readable list (for the report / audit). */
export function listTeamAliases(db: Database): TeamAlias[] {
  try {
    const raw = JSON.parse(R.metaGet(db, KEY) ?? "null");
    if (!raw || !Array.isArray(raw.aliases)) return [];
    return (raw.aliases as TeamAlias[]).filter((a) => a && a.from && a.to);
  } catch { return []; }
}

export interface AddAliasResult { ok: boolean; from?: string; to?: string; error?: string; count?: number }

/** Add one alias (idempotent). Both sides are normalized to folded tokens; rejects empty/equal/over-long. A
 *  new key OVERWRITES an existing mapping for the same `from` (last write wins — a correction). Read-modify-write
 *  on the single meta key; caller supplies `now` (Date is unavailable in some contexts). */
export function addTeamAlias(db: Database, fromRaw: string, toRaw: string, now: string): AddAliasResult {
  const from = foldToken(fromRaw), to = foldToken(toRaw);
  if (!from || !to) return { ok: false, error: "обе стороны должны сворачиваться в непустой токен (буквы/цифры)" };
  if (from === to) return { ok: false, error: "стороны совпадают после нормализации — псевдоним не нужен" };
  if (from.length > 40 || to.length > 40) return { ok: false, error: "токен слишком длинный (>40) — это имя команды, не строка" };
  const existing = listTeamAliases(db).filter((a) => foldToken(a.from) !== from); // drop any prior mapping for `from`
  const aliases = [...existing, { from, to, addedAt: now }];
  R.metaSet(db, KEY, JSON.stringify({ aliases }), now);
  return { ok: true, from, to, count: aliases.length };
}

/** Remove an alias by its `from` token (normalized). Returns the new count. */
export function removeTeamAlias(db: Database, fromRaw: string, now: string): AddAliasResult {
  const from = foldToken(fromRaw);
  if (!from) return { ok: false, error: "пустой токен" };
  const aliases = listTeamAliases(db).filter((a) => foldToken(a.from) !== from);
  R.metaSet(db, KEY, JSON.stringify({ aliases }), now);
  return { ok: true, from, count: aliases.length };
}
