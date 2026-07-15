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
export interface ControlResult { ok: boolean; note: string; needConfirm?: boolean }

/** [STOP] — hard stop: operator mode → off + cancel every working order + alert. Open positions are
 *  NOT force-dumped (§4.2: a panic sell into a thin book is worse). Idempotent. */
export function operatorStop(db: Database, actor: string, now: string): ControlResult {
  RR.setOperatorMode(db, "off", now);
  const cancelled = RR.cancelWorkingRealOrders(db, now);
  RR.setRealOrphanAlert(db, `[STOP] нажат в ${now} — новые ордера остановлены, ${cancelled} висящих отменено. Позиции под exits-only.`, now);
  RR.logControl(db, "stop", JSON.stringify({ cancelled }), actor, now);
  return { ok: true, note: `STOP: режим→off, отменено висящих ордеров: ${cancelled}` };
}

/** Master switch — set the operator mode ceiling. LOOSENING (more real actions) requires confirm:true
 *  (the UI shows a dialog first). Always logged with before/after. */
export function setOperatorModeControl(db: Database, target: string, confirm: boolean, actor: string, now: string): ControlResult {
  if (!VALID.includes(target as TradingMode)) return { ok: false, note: `неизвестный режим «${target}»` };
  const before = effectiveTradingMode(db, process.env);
  if (isLoosening(before, target as TradingMode) && !confirm) return { ok: false, needConfirm: true, note: `подтверди повышение ${before}→${target} (даёт больше реальных действий)` };
  RR.setOperatorMode(db, target, now);
  const after = effectiveTradingMode(db, process.env);
  RR.logControl(db, "set_mode", JSON.stringify({ target, before, after }), actor, now);
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
