// ─────────────────────────────────────────────────────────────────────────────
// realControl (spec §6, Phase G iteration 2) — the FIVE owner knobs. Each is a
// distinct, audited action (who/when/what → real_control_log). The app can't write
// env, so mode/limit controls are persistent DB overrides; effectiveTradingMode /
// resolveSafetyCaps take the MOST RESTRICTIVE of (env, override, pause) — the UI can
// only ever tighten, never exceed the env ceiling. Every write is logged.
// ─────────────────────────────────────────────────────────────────────────────

import { timingSafeEqual } from "node:crypto";
import type { Database } from "../db.js";
import * as RR from "../realRepo.js";
import { effectiveTradingMode, isLoosening, type TradingMode } from "./safety.js";
import { addWhitelistRow, setWhitelistEnabled, type AddWhitelistInput } from "./whitelist.js";
import { buildPhaseFReadiness } from "./phaseFReadiness.js";
import { thesisCapUsd } from "../thesisExposure.js";

const VALID: TradingMode[] = ["off", "dry_run", "exits_only", "on"];

/** A2 (audit #1): authorize a control POST from its Authorization header against env REAL_CONTROL_TOKEN.
 *  Constant-time compare; a missing SERVER token means control is DISABLED (fail-closed, not open). The
 *  route rejects before reading the body, so a denied call has zero side effects, and `actor` is derived
 *  from the valid token ("owner") — never from the body. */
export function authorizeControl(authorizationHeader: string | null | undefined, env: Record<string, string | undefined> = process.env): { ok: boolean; reason: "ok" | "no_server_token" | "bad_token" } {
  const expected = (env.REAL_CONTROL_TOKEN ?? "").trim();
  if (!expected) return { ok: false, reason: "no_server_token" };
  const h = authorizationHeader ?? "";
  const presented = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  const a = Buffer.from(presented), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_token" };
  return { ok: true, reason: "ok" };
}
export interface ControlResult { ok: boolean; note: string; needConfirm?: boolean; needPhrase?: boolean }

// The STRONGEST barrier: arming the operator ceiling to `on` (real money can flow) is NOT a click and
// NOT a second click — it demands this exact phrase be TYPED. Muscle memory can't produce it; a fat
// finger can't either. Every other loosening (→dry_run, →exits_only) is a single confirm; downward and
// STOP are instant. This is the one button in the system that must cost deliberate keystrokes.
export const ON_CONFIRM_PHRASE = "ВКЛЮЧИТЬ РЕАЛ";

/** [STOP] — hard stop: operator mode → EXITS_ONLY + cancel every working ENTRY-capable order + alert.
 *  A5 (audit #16): floors at exits_only, NOT off — so open positions keep their defensive exit management
 *  ("positions ride under exits-only" is now TRUE). A full freeze is still available via an explicit
 *  set_mode off (a deliberate choice, not the reflex). INSTANT: no confirm (the panic button must not
 *  ask). GREEDY: cancels every order it can, reports N of M, never dies on the first failure. Open
 *  positions are NOT force-dumped (§4.2: a panic sell into a thin book is worse). Idempotent. */
export function operatorStop(db: Database, actor: string, now: string): ControlResult {
  RR.setOperatorMode(db, "exits_only", now);
  const c = RR.cancelWorkingRealOrders(db, now);
  const tail = c.failed ? `, ${c.failed} не удалось (см. лог)` : "";
  RR.setRealOrphanAlert(db, `[STOP] нажат в ${now} — новые входы остановлены (exits_only), отменено ${c.cancelled}/${c.attempted} висящих${tail}. Позиции остаются под exit-управлением.`, now);
  RR.logControl(db, "stop", JSON.stringify({ ...c, mode: "exits_only" }), actor, now);
  return { ok: true, note: `STOP: режим→exits_only (позиции под защитой exit), отменено висящих: ${c.cancelled} из ${c.attempted}${tail}` };
}

/** Master switch — set the operator mode ceiling. ASYMMETRIC by design:
 *   • tightening (→off/exits_only/dry_run that lowers) — INSTANT, no confirm.
 *   • loosening to dry_run/exits_only — a single confirm:true (one dialog).
 *   • loosening to `on` (REAL MONEY) — a TYPED phrase (ON_CONFIRM_PHRASE), never a click. A bare
 *     confirm:true is rejected with needPhrase; only the exact phrase arms it.
 *  Always logged with before/after (and, for `on`, that the phrase gate was cleared). */
export function setOperatorModeControl(db: Database, target: string, confirm: boolean, actor: string, now: string, phrase?: string, readinessOverride = false): ControlResult {
  if (!VALID.includes(target as TradingMode)) return { ok: false, note: `неизвестный режим «${target}»` };
  const before = effectiveTradingMode(db, process.env);
  if (target === "on") {
    // The strongest barrier — a click (even confirm:true) is never enough; the phrase must be typed.
    if ((phrase ?? "").trim().toUpperCase() !== ON_CONFIRM_PHRASE) {
      return { ok: false, needPhrase: true, note: `включение РЕАЛЬНЫХ денег: введи фразу «${ON_CONFIRM_PHRASE}» (не кнопку)` };
    }
    // [C2] The readiness "4 conditions" are ENFORCED here, not advisory: arming real money REFUSES unless the
    // Phase-F readiness verdict is `go` AND the correlated-exposure blocker (THESIS_MATCH_CAP_USD) is set. The
    // failing checks are printed. An explicit, LOGGED override (readinessOverride) is the only bypass.
    const failing: string[] = [];
    const readiness = buildPhaseFReadiness(db, process.env);
    if (readiness.verdict !== "go") failing.push(`phase_f_readiness=${readiness.verdict} (${readiness.counts.fail} провал/${readiness.counts.warn} предупр.: ${readiness.checks.filter((c) => c.status !== "pass").map((c) => c.id).join(", ") || "—"})`);
    if (thesisCapUsd(process.env) <= 0) failing.push(`THESIS_MATCH_CAP_USD не задан — коррелированный кэп (R0.5) выключен`);
    if (failing.length && !readinessOverride) {
      RR.logControl(db, "set_mode_blocked", JSON.stringify({ target, failing }), actor, now);
      return { ok: false, note: `⛔ включение РЕАЛА заблокировано готовностью: ${failing.join("; ")}. Закрой их (см. ?report=phase_f_readiness) или подтверди явный override.` };
    }
    if (failing.length && readinessOverride) RR.logControl(db, "set_mode_override", JSON.stringify({ target, failing, actor }), actor, now);
  } else if (isLoosening(before, target as TradingMode) && !confirm) {
    return { ok: false, needConfirm: true, note: `подтверди повышение ${before}→${target} (даёт больше реальных действий)` };
  }
  RR.setOperatorMode(db, target, now);
  const after = effectiveTradingMode(db, process.env);
  RR.logControl(db, "set_mode", JSON.stringify({ target, before, after, ...(target === "on" ? { phrase: "✓ typed" } : {}) }), actor, now);
  // A note if env caps the request below what was asked (owner can't exceed env from the UI).
  return { ok: true, note: after === target ? `режим→${after}` : `запрошен ${target}, действует ${after} (ограничено env=${process.env.REAL_TRADING ?? "off"})` };
}

/** Clear the sticky auto-pause (explicit owner action, §4.1/§4.4) — and the orphan alert if resolved. */
export function clearAutoPauseControl(db: Database, actor: string, now: string): ControlResult {
  RR.clearRealAutoPause(db);
  RR.clearRealOrphanAlert(db); // C5 (audit #8): also clear the orphan alert the pause raised — as the docstring promises
  RR.logControl(db, "clear_pause", null, actor, now);
  return { ok: true, note: "авто-пауза снята (и orphan-алерт очищен) — режим снова управляется env/оператором" };
}

/** Whitelist add — a versioned, journaled row (whitelist versioning) PLUS a control-log entry. */
export function whitelistAddControl(db: Database, input: AddWhitelistInput, actor: string, now: string): ControlResult {
  const r = addWhitelistRow(db, input, actor, now);
  if (!r.ok) return { ok: false, note: r.error ?? "не удалось добавить строку" };
  RR.logControl(db, "whitelist_add", JSON.stringify({ ...input, version: r.version }), actor, now);
  return { ok: true, note: `whitelist +${input.strategyId} → v${r.version}` };
}
export function whitelistToggleControl(db: Database, id: string, enabled: boolean, actor: string, now: string): ControlResult {
  const version = setWhitelistEnabled(db, id, enabled, actor, now);
  if (version == null) return { ok: false, note: `нет строки whitelist с id ${id} — ничего не изменено` }; // C5: no phantom toggle
  RR.logControl(db, "whitelist_toggle", JSON.stringify({ id, enabled, version }), actor, now);
  return { ok: true, note: `whitelist ${enabled ? "включена" : "выключена"} строка → v${version}` };
}

/** Edit the four hard caps (persistent override; env stays the read-only floor). Each must be > 0. */
export function setCapsControl(db: Database, partial: Record<string, number>, actor: string, now: string): ControlResult {
  const allow = ["maxOrderUsd", "maxExposureUsd", "maxDailyLossUsd", "maxOrdersPerHour"];
  const clean: Record<string, number> = {};
  for (const k of allow) if (Number.isFinite(partial[k]) && partial[k] > 0) clean[k] = partial[k];
  if (!Object.keys(clean).length) return { ok: false, note: "нет валидных значений (> 0)" };
  const before = RR.getCapsOverride(db);
  RR.setCapsOverride(db, { ...before, ...clean }, now);
  RR.logControl(db, "set_caps", JSON.stringify({ before, after: { ...before, ...clean } }), actor, now);
  return { ok: true, note: `лимиты обновлены: ${Object.entries(clean).map(([k, v]) => `${k}=$${v}`).join(", ")}` };
}
