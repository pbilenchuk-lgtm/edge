// ============================================================
// EDGE LAB — АРХИВ БАЗЫ ДЛЯ ОСТАНОВКИ С ВОЗМОЖНОСТЬЮ ВОССТАНОВЛЕНИЯ  [SERVER-ONLY]
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ПУТЬ. База — SQLite на персистентном диске Render (`/app/data/edge.db`). Шелла в
// контейнер нет, `pg_dump` неприменим, а существующие выгрузки (`/api/profiles-export`) покрывают ТОЛЬКО
// ставки: `markets`, `tennis_snapshots`, `decision_prices`, `system_events`, `config_epochs` и ещё сорок
// таблиц наружу не отдавались вовсе. Архив без них — не архив, а витрина.
//
// ПОЧЕМУ VACUUM INTO, А НЕ КОПИЯ ФАЙЛА. Копировать `edge.db` на живой базе нельзя: конкурентная запись
// оставит копию в середине транзакции, и восстановление даст «database disk image is malformed» — причём
// не сразу, а на первом же чтении повреждённой страницы. `VACUUM INTO` делает СОГЛАСОВАННЫЙ снимок
// средствами самого SQLite, не останавливая приложение, и заодно отдаёт файл без свободных страниц.
//
// ПОЧЕМУ ФЕЙЛ-КЛОУЗД ПО ТОКЕНУ. В базе лежат `provider_keys` — ключи внешних API. Эндпоинт, отдающий
// файл целиком, без секрета публиковал бы их всему интернету. Токена нет → путь ВЫКЛЮЧЕН, а не «открыт
// по умолчанию»: та же асимметрия, что и у остальных гейтов проекта.
//
// СВЕРКА ПОЛНОТЫ — ЧАСТЬ АРХИВА, А НЕ ПОСЛЕСЛОВИЕ. `mode=counts` считает строки по КАЖДОЙ таблице из
// `sqlite_master`, а не по заранее выписанному списку: список пришлось бы помнить, а забытая таблица —
// это ровно тот немой ноль, которого в архиве быть не должно. Те же числа снимаются с восстановленной
// копии и сравниваются построчно.
// ============================================================

import type { Database } from "./db.js";

export interface TableCount { table: string; rows: number | null; error?: string }
export interface BackupCounts {
  at: string;
  dbPath: string;
  pageCount: number | null; pageSize: number | null; fileBytes: number | null;
  tables: TableCount[];
  totalRows: number;
  note: string;
}

/** Имена таблиц берутся ИЗ БАЗЫ, а не из списка в коде: забытая таблица — молчаливая дыра в архиве. */
export function listTables(db: Database): string[] {
  try {
    return (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string }[]).map((r) => r.name);
  } catch { return []; }
}

export function buildBackupCounts(db: Database, dbPath: string, nowIso: string): BackupCounts {
  const one = (sql: string): number | null => {
    try { const r = db.prepare(sql).get() as Record<string, unknown> | undefined; const v = r ? Object.values(r)[0] : null; return typeof v === "number" ? v : null; }
    catch { return null; }
  };
  const tables: TableCount[] = [];
  for (const t of listTables(db)) {
    // Имя таблицы приходит из sqlite_master, а не снаружи — интерполяция здесь безопасна, и параметром
    // имя таблицы в SQL всё равно не подставить.
    try { tables.push({ table: t, rows: one(`SELECT COUNT(*) n FROM "${t}"`) }); }
    catch (e) { tables.push({ table: t, rows: null, error: e instanceof Error ? e.message : String(e) }); }
  }
  const pageCount = one("PRAGMA page_count"), pageSize = one("PRAGMA page_size");
  const totalRows = tables.reduce((s, t) => s + (t.rows ?? 0), 0);
  return {
    at: nowIso, dbPath, pageCount, pageSize,
    fileBytes: pageCount != null && pageSize != null ? pageCount * pageSize : null,
    tables, totalRows,
    note: `таблиц ${tables.length}, строк всего ${totalRows}`
      + (pageCount != null && pageSize != null ? ` · файл ≈ ${(pageCount * pageSize / 1048576).toFixed(1)} МБ (${pageCount} страниц × ${pageSize} Б)` : "")
      + " · имена таблиц прочитаны ИЗ sqlite_master, а не из списка в коде",
  };
}

/**
 * Согласованный снимок базы в отдельный файл. Возвращает путь; вызывающий обязан удалить файл после
 * отдачи. Бросает — молча вернуть «снимка нет» здесь было бы хуже всего: архив либо есть, либо его нет.
 */
export function vacuumInto(db: Database, targetPath: string): void {
  // Путь формируется НАМИ (метка времени), снаружи не приходит; VACUUM INTO не принимает параметров.
  db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
}

/** Одна таблица целиком как массив объектов — запасной путь, если бинарь не доходит через прокси. */
export function dumpTable(db: Database, table: string, limit: number, offset: number): unknown[] {
  const known = new Set(listTables(db));
  if (!known.has(table)) throw new Error(`unknown table: ${table}`);
  return db.prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`).all(limit, offset) as unknown[];
}
