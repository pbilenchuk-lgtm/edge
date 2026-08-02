// ============================================================
// EDGE LAB — РАЗОВАЯ СИНХРОНИЗАЦИЯ ПРЕСЕТОВ ПРОФИЛЕЙ С КОДОМ  [решение владельца 02.08.2026]
//
// Форензик 02.08 показал: живая база держала `conservative-1.0` (edge 7% / кал 0.55 / ликв $2000), тогда
// как код с 25.07 везёт `conservative-2.0` (5% / 0.45 / $1000) — Фазу 1.3, ратифицированную неделей
// раньше. Прод неделю жил на профиле, который мы считали заменённым: 18 отказов «калибровка X < 0.55» у
// бара, отменённого семь дней назад, 12 из них прошли бы под 2.0.
//
// Причина молчания — `seedRiskProfiles` выходит на первой строке, если в базе есть ХОТЬ ОДИН профиль.
// Это верно для «не затирать правки владельца» и одновременно значит, что НИ ОДНО изменение пресета
// само не доедет. У промтов стратегий миграция есть, у пресетов не было. Эта — есть.
//
// ТРИ УСЛОВИЯ РАТИФИКАЦИИ, исполненные здесь буквально:
//  (а) ОДНИМ ПРОХОДОМ ПО ВСЕМ ПРЕСЕТАМ, а не по одному пойманному. Раз посев выходит на первой строке,
//      дрейфовать мог любой; снимок расхождения по ВСЕМ пресетам снимается ДО записи и сохраняется, так
//      что «что именно было в базе за секунду до миграции» останется доказуемым и после неё.
//  (б) ЭПОХА ТЕГОМ НА ДАТЕ ПЕРЕКЛЮЧЕНИЯ. Ставки, размещённые под conservative-1.0, обязаны остаться
//      отличимыми от ставок под 2.0 — иначе профильные срезы смешают две разные политики входа в одну
//      «когорту conservative». Механизм уже есть и не изобретается заново: глобальный CODE_VERSION
//      (betMeta.ts) поднят e9→e10 тем же деплоем, `epochNum`/`crossEpoch` разводят когорты сами, а сюда
//      кладётся человекочитаемая запись — когда, что и с чего на что.
//  (в) Строка drift в еженедельнике остаётся навсегда — она в profileDrift.ts и от миграции не зависит.
//
// ЧЕГО НЕ ДЕЛАЕМ. Не трогаем профили, у которых НЕТ пресета в коде (сегодня `max`: он собран из legacy-
// строки по решению владельца «как есть» — это дизайн, а не дрейф). Не переписываем историю ставок. И
// маркер сделан одноразовым: миграция чинит ровно один зафиксированный разрыв, а не превращается в
// вечный «код всегда прав» — иначе она молча затирала бы правки владельца через UI, ровно то, от чего
// ранний выход посева и защищал.
// ============================================================

import type { Database } from "./db.js";
import * as R from "./repo.js";
import { RISK_PROFILE_DEFS, loadRiskConfig } from "./riskConfig.js";
import { buildProfileDrift, PRESET_EPOCH_CUT_KEY } from "./profileDrift.js";
import { CODE_VERSION } from "./betMeta.js";

const MARK = "risk_presets_code_sync_v1";

export interface PresetSyncResult {
  ran: boolean;
  /** Профили, чей конфиг реально переписан. */
  synced: { id: string; from: string | null; to: string | null; fields: string[] }[];
  /** Профили, у которых расхождения не было (и трогать их не пришлось). */
  alreadyEqual: string[];
  /** Профили без пресета в коде — вне синхронизации по определению. */
  skippedNoCodePreset: string[];
  note: string;
}

/**
 * Привести пресет-профили в базе к их определению в коде. Одноразовая, маркер-защищённая.
 *
 * Порядок важен: сначала СНИМОК расхождения (условие «а» — отчёт показывает код↔база по всем пресетам
 * ДО миграции), потом запись. Каждый конфиг проходит через `loadRiskConfig` — невалидный пресет
 * пропускается, мусор в базу не попадает никогда.
 */
export function migrateRiskPresetsToCode(db: Database, nowIso: string): PresetSyncResult {
  const idle: PresetSyncResult = { ran: false, synced: [], alreadyEqual: [], skippedNoCodePreset: [], note: "уже выполнена" };
  if (R.metaGet(db, MARK)) return idle;
  // Пустая база — профилей ещё нет, их поставит посев из того же кода. Мигрировать нечего, но и маркер
  // ставить нельзя: база может быть пустой на первом старте, а реальный разрыв — появиться позже.
  if (R.listRiskProfiles(db).length === 0) return { ...idle, note: "профилей в базе нет — синхронизировать нечего" };

  const before = buildProfileDrift(db, nowIso);

  const res: PresetSyncResult = { ran: true, synced: [], alreadyEqual: [], skippedNoCodePreset: [], note: "" };
  for (const p of before.profiles) {
    if (p.noCodePreset) { res.skippedNoCodePreset.push(p.id); continue; }
    if (p.missing || p.fields.length === 0) { res.alreadyEqual.push(p.id); continue; }

    const def = RISK_PROFILE_DEFS.find((d) => d.id === p.id);
    if (!def) { res.alreadyEqual.push(p.id); continue; }
    const loaded = loadRiskConfig(def.values);
    if (!loaded.ok || !loaded.config) continue;      // невалидный пресет не записываем НИКОГДА

    const row = R.getRiskProfileRow(db, p.id);
    R.upsertRiskProfile(db, {
      id: p.id, name: row?.name ?? def.name, content: JSON.stringify(loaded.config),
      sort: row?.sort ?? def.sort, created_at: row?.created_at ?? nowIso,
    });
    res.synced.push({ id: p.id, from: p.prodVersion, to: p.codeVersion, fields: p.fields.map((f) => f.path) });
  }

  // Условие «б»: человекочитаемая запись о разрезе. Сама разметка когорт делается глобальной эпохой
  // CODE_VERSION (поднята тем же деплоем) — здесь фиксируется, ПОЧЕМУ она поднята и что было до.
  R.metaSet(db, PRESET_EPOCH_CUT_KEY, JSON.stringify({
    at: nowIso,
    codeEpochAtCut: CODE_VERSION,
    reason: "синхронизация пресетов профилей с кодом (Фаза 1.3 не доехала до прода; решение владельца 02.08.2026)",
    synced: res.synced,
    skippedNoCodePreset: res.skippedNoCodePreset,
    driftBefore: before.profiles.filter((x) => x.fields.length > 0 || x.missing || x.noCodePreset),
  }), nowIso);
  R.metaSet(db, MARK, nowIso, nowIso);

  res.note = res.synced.length === 0
    ? "расхождений не было — база уже совпадала с кодом; разрез отмечен, маркер поставлен"
    : `синхронизировано профилей: ${res.synced.map((s) => `${s.id} (${s.from ?? "?"} → ${s.to ?? "?"}, полей ${s.fields.length})`).join(", ")}`
      + `. Ставки ДО этой отметки размечены прежней эпохой — профильные срезы двух политик входа не смешиваются.`;
  for (const s of res.synced) console.log(`[migrate] risk preset «${s.id}»: ${s.from} → ${s.to} (полей ${s.fields.length}) — Фаза 1.3 доехала до базы`);
  return res;
}
