// ─────────────────────────────────────────────────────────────────────────────
// realControl (spec §6, Phase G iteration 2) — the FIVE owner knobs. Each is a
// distinct, audited action (who/when/what → real_control_log). The app can't write
// env, so mode/limit controls are persistent DB overrides; effectiveTradingMode /
// resolveSafetyCaps take the MOST RESTRICTIVE of (env, override, pause) — the UI can
// only ever tighten, never exceed the env ceiling. Every write is logged.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "../db.js";
import * as RR from "../realRepo.js";
import { effectiveTradingMode, isLoosening, type TradingMode } from "./safety.js";
import { addWhitelistRow, setWhitelistEnabled, type AddWhitelistInput } from "./whitelist.js";

const VALID: TradingMode[] = ["off", "dry_run", "exits_only", "on"];
export interface ControlResult { ok: boolean; note: string; needConfirm?: boolean; needPhrase?: boolean }

// The STRONGEST barrier: arming the operator ceiling to `on` (real money can flow) is NOT a click and
// NOT a second click — it demands this exact phrase be TYPED. Muscle memory can't produce it; a fat
// finger can't either. Every other loosening (→dry_run, →exits_only) is a single confirm; downward and
// STOP are instant. This is the one button in the system that must cost deliberate keystrokes.
export const ON_CONFIRM_PHRASE = "ВКЛЮЧИТЬ РЕАЛ";

/** [STOP] — hard stop: operator mode → off + cancel every working order + alert. INSTANT: no confirm,
 *  zero friction (the panic button must not ask). GREEDY: cancels every order it can, reports N of M,
 *  never dies on the first failure. Open positions are NOT force-dumped (§4.2: a panic sell into a thin
 *  book is worse). Idempotent — a second press cancels 0 of 0 and still logs. Order matters: mode→off
 *  FIRST (no new orders), then sweep. */
export function operatorStop(db: Database, actor: string, now: string): ControlResult {
  RR.setOperatorMode(db, "off", now);
  const c = RR.cancelWorkingRealOrders(db, now);
  const tail = c.failed ? `, ${c.failed} не удалось (см. лог)` : "";
  RR.setRealOrphanAlert(db, `[STOP] нажат в ${now} — новые ордера остановлены, отменено ${c.cancelled}/${c.attempted} висящих${tail}. Позиции под exits-only.`, now);
  RR.logControl(db, "stop", JSON.stringify(c), actor, now);
  return { ok: true, note: `STOP: режим→off, отменено висящих ордеров: ${c.cancelled} из ${c.attempted}${tail}` };
}

/** Master switch — set the operator mode ceiling. ASYMMETRIC by design:
 *   • tightening (→off/exits_only/dry_run that lowers) — INSTANT, no confirm.
 *   • loosening to dry_run/exits_only — a single confirm:true (one dialog).
 *   • loosening to `on` (REAL MONEY) — a TYPED phrase (ON_CONFIRM_PHRASE), never a click. A bare
 *     confirm:true is rejected with needPhrase; only the exact phrase arms it.
 *  Always logged with before/after (and, for `on`, that the phrase gate was cleared). */
export function setOperatorModeControl(db: Database, target: string, confirm: boolean, actor: string, now: string, phrase?: string): ControlResult {
  if (!VALID.includes(target as TradingMode)) return { ok: false, note: `неизвестный режим «${target}»` };
  const before = effectiveTradingMode(db, process.env);
  if (target === "on") {
    // The strongest barrier — a click (even confirm:true) is never enough; the phrase must be typed.
    if ((phrase ?? "").trim().toUpperCase() !== ON_CONFIRM_PHRASE) {
      return { ok: false, needPhrase: true, note: `включение РЕАЛЬНЫХ денег: введи фразу «${ON_CONFIRM_PHRASE}» (не кнопку)` };
    }
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
  RR.logControl(db, "clear_pause", null, actor, now);
  return { ok: true, note: "авто-пауза снята — режим снова управляется env/оператором" };
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
