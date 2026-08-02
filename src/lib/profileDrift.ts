// ============================================================
// EDGE LAB — РЕШАЮЩЕЕ ПРАВИЛО В ПРОДЕ ≠ РЕШАЮЩЕЕ ПРАВИЛО В КОДЕ
//
// Найдено форензиком калибровки 02.08. Владелец спросил: почему предматч-канал почти закрыт, если
// калибровка «не дотягивает до высокой»? Проверка калибровочной функции её оправдала (см. ниже), а вот
// пороги профилей — нет: прод держит `conservative-1.0` (edge 7% / кал 0.55 / ликв $2000), тогда как код
// с 25.07 везёт `conservative-2.0` (edge 5% / кал 0.45 / ликв $1000, Фаза 1.3 — «тот же сигнал, меньший
// размер»). Ратифицированное решение просто НЕ ДОЕХАЛО до прода.
//
// ПОЧЕМУ НЕ ДОЕХАЛО. `seedRiskProfiles` выходит на первой же строке, если в базе есть ХОТЬ ОДИН профиль:
//   if (R.listRiskProfiles(db).length > 0) return;
// Это верно для «не затирать правки владельца» и одновременно означает, что НИ ОДНО изменение пресета
// в коде никогда не достигнет живой базы. У промтов стратегий такая миграция есть (`migrateStrategyRoster`
// → `migrateSeedStrategists`), у пресетов профилей — нет. Асимметрия и породила расхождение.
//
// ЧТО ЭТОТ МОДУЛЬ ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ. Он ТОЛЬКО ЧИТАЕТ и называет расхождение поимённо: профиль,
// поле, значение в проде, значение в коде, и (для порогов входа) в какую сторону прод строже. Он НИЧЕГО
// не пишет. Автоматически подтянуть числа нельзя: правка владельца через UI и невыехавший пресет выглядят
// в базе ОДИНАКОВО — обе просто «конфиг, который не равен коду». Отличить их может только человек, и
// решение о порогах входа — его, а не миграции. Наш долг — не молчать.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { RISK_PROFILE_DEFS } from "./riskConfig.js";

export interface ProfileDriftField {
  /** Путь поля, напр. "entry_thresholds.min_calibration". */
  path: string;
  prod: unknown;
  code: unknown;
  /** Для порогов входа: прод строже кода (true), мягче (false), несравнимо (null). */
  prodStricter: boolean | null;
}

export interface ProfileDriftRow {
  id: string;
  name: string;
  prodVersion: string | null;
  codeVersion: string | null;
  /** Профиля нет в базе — он будет создан посевом при первом пустом старте. */
  missing: boolean;
  fields: ProfileDriftField[];
}

export interface ProfileDriftReport {
  at: string;
  profiles: ProfileDriftRow[];
  driftedProfiles: number;
  driftedFields: number;
  note: string;
}

/** Поля, где БОЛЬШЕЕ значение = более строгий вход (порог, который надо перепрыгнуть). */
const HIGHER_IS_STRICTER = new Set([
  "entry_thresholds.min_edge",
  "entry_thresholds.min_edge_low_liquidity",
  "entry_thresholds.min_calibration",
  "entry_thresholds.min_market_liquidity",
]);

function flatten(obj: unknown, prefix = "", out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "_defaults_used") continue;              // служебное поле загрузчика, не настройка
    const path = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out.set(path, v);
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return a === b;
}

/** Сравнить хранимые пресет-профили с их определением в коде. Только чтение. */
export function buildProfileDrift(db: Database, nowIso: string): ProfileDriftReport {
  const stored = new Map(R.listRiskProfiles(db).map((p) => [p.id, p]));
  const profiles: ProfileDriftRow[] = [];

  for (const def of RISK_PROFILE_DEFS) {
    const row = stored.get(def.id);
    const codeFlat = flatten(def.values);
    const codeVersion = String((def.values as { config_version?: unknown }).config_version ?? "") || null;

    if (!row) {
      profiles.push({ id: def.id, name: def.name, prodVersion: null, codeVersion, missing: true, fields: [] });
      continue;
    }

    let prodCfg: unknown = null;
    try { prodCfg = JSON.parse(row.content); } catch { prodCfg = null; }
    const prodFlat = flatten(prodCfg);
    const prodVersion = String((prodCfg as { config_version?: unknown } | null)?.config_version ?? "") || null;

    const fields: ProfileDriftField[] = [];
    for (const [path, code] of codeFlat) {
      if (path === "config_version") continue;         // версия — метка, её расхождение видно отдельной колонкой
      const prod = prodFlat.get(path);
      if (same(prod, code)) continue;
      let prodStricter: boolean | null = null;
      if (HIGHER_IS_STRICTER.has(path) && typeof prod === "number" && typeof code === "number") prodStricter = prod > code;
      fields.push({ path, prod: prod ?? null, code, prodStricter });
    }
    profiles.push({ id: def.id, name: def.name, prodVersion, codeVersion, missing: false, fields });
  }

  const driftedProfiles = profiles.filter((p) => p.missing || p.fields.length > 0).length;
  const driftedFields = profiles.reduce((n, p) => n + p.fields.length, 0);
  const stricter = profiles.flatMap((p) => p.fields).filter((f) => f.prodStricter === true).length;

  const note = driftedFields === 0
    ? "пресеты профилей в базе совпадают с кодом — решающее правило одно и то же"
    : `РАСХОЖДЕНИЕ: профилей ${driftedProfiles}, полей ${driftedFields}, из них ${stricter} — там, где ПРОД СТРОЖЕ кода. `
      + "Пресеты в коде не доезжают до живой базы: seedRiskProfiles выходит, если профили уже есть. "
      + "Автоматически не подтягиваем — правка владельца и невыехавший пресет в базе неразличимы, "
      + "а пороги входа меняет владелец, а не миграция.";

  return { at: nowIso, profiles, driftedProfiles, driftedFields, note };
}

/** Одна строка для еженедельника — «объявись сам». */
export function profileDriftLine(rep: ProfileDriftReport): string {
  if (rep.driftedFields === 0) return "profile_drift: 0 — пороги профилей в базе = пороги в коде";
  const worst = rep.profiles
    .filter((p) => p.fields.some((f) => f.prodStricter === true))
    .map((p) => `${p.id} (${p.prodVersion ?? "?"} vs ${p.codeVersion ?? "?"})`)
    .join(", ");
  return `profile_drift: полей ${rep.driftedFields} в ${rep.driftedProfiles} профилях`
    + (worst ? ` · ПРОД СТРОЖЕ КОДА: ${worst}` : "")
    + " · решение владельца, миграции нет";
}
