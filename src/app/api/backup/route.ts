import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/backup?mode=counts|dump|table&name=&limit=&offset=
 *
 * АРХИВ БАЗЫ ДЛЯ ОСТАНОВКИ ПРОЕКТА. Три режима:
 *   counts — построчная сверка по КАЖДОЙ таблице (что и сравнивается с восстановленной копией);
 *   dump   — согласованный снимок SQLite (VACUUM INTO) файлом, потоком, без чтения в память целиком;
 *   table  — одна таблица как JSON (запасной путь, если бинарь не проходит через прокси).
 *
 * АВТОРИЗАЦИЯ ФЕЙЛ-КЛОУЗД. В базе лежат `provider_keys` — ключи внешних API, поэтому без секрета путь
 * ВЫКЛЮЧЕН, а не открыт. Секрет — заголовок `x-backup-token`, сверяется с env `BACKUP_TOKEN`; переменной
 * нет → 503 с прямой причиной, а не 404 «как будто эндпоинта не существует»: владелец должен отличать
 * «не настроено» от «сломалось».
 *
 * Токен НЕ принимается в query-строке намеренно: query попадает в логи прокси и в историю браузера.
 */
export async function GET(req: Request) {
  const token = process.env.BACKUP_TOKEN ?? "";
  if (!token) {
    return NextResponse.json({
      ok: false,
      error: "backup_disabled",
      note: "переменная окружения BACKUP_TOKEN не задана — путь выключен по построению (в базе лежат ключи провайдеров). Задайте её в Render и повторите запрос с заголовком x-backup-token.",
    }, { status: 503 });
  }
  if (req.headers.get("x-backup-token") !== token) {
    return NextResponse.json({ ok: false, error: "unauthorized", note: "нужен заголовок x-backup-token" }, { status: 401 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "counts";
  const dbPath = process.env.EDGE_DB_PATH ?? "./data/edge.db";

  try {
    const { getDb } = await import("@/lib/db");
    const B = await import("@/lib/backup");
    const db = getDb();

    if (mode === "counts") {
      return NextResponse.json({ ok: true, report: B.buildBackupCounts(db, dbPath, new Date().toISOString()) });
    }

    if (mode === "table") {
      const name = url.searchParams.get("name") ?? "";
      const limit = Math.min(50_000, Math.max(1, Number(url.searchParams.get("limit") ?? 10_000)));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
      const rows = B.dumpTable(db, name, limit, offset);
      return NextResponse.json({ ok: true, table: name, limit, offset, rows: rows.length, data: rows });
    }

    if (mode === "dump") {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = path.join(os.tmpdir(), `edge-backup-${stamp}.db`);
      // Файл не должен существовать — VACUUM INTO отказывается писать поверх.
      try { fs.unlinkSync(target); } catch { /* его и не было */ }
      B.vacuumInto(db, target);
      const size = fs.statSync(target).size;
      // Поток, а не Buffer: на Starter-инстансе 512 МБ памяти, и чтение базы целиком в память —
      // самый простой способ уронить прод ровно в момент, когда он нужен для архива.
      const nodeStream = fs.createReadStream(target);
      nodeStream.on("close", () => { try { fs.unlinkSync(target); } catch { /* временный файл */ } });
      const web = new ReadableStream<Uint8Array>({
        start(controller) {
          nodeStream.on("data", (c) => controller.enqueue(typeof c === "string" ? new TextEncoder().encode(c) : new Uint8Array(c)));
          nodeStream.on("end", () => controller.close());
          nodeStream.on("error", (e) => controller.error(e));
        },
        cancel() { nodeStream.destroy(); },
      });
      return new Response(web, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
          "Content-Disposition": `attachment; filename="edge-${stamp}.db"`,
          "X-Backup-Bytes": String(size),
        },
      });
    }

    return NextResponse.json({ ok: false, error: "unknown mode", modes: ["counts", "dump", "table"] }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
