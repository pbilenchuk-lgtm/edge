// Self-contained preview: mounts the real EdgeLab UI on the real dataset.
// A fetch shim answers /api/* locally so the app is fully clickable with no
// backend; live LLM/odds paths return a clear "demo" message.
import React from "react";
import { createRoot } from "react-dom/client";
import EdgeLab from "../src/components/EdgeLab";
import DATA from "./data.json";

const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const orig = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  let b = {};
  try { b = init && init.body ? JSON.parse(init.body) : {}; } catch {}
  if (url.includes("/api/app")) return j(DATA);
  if (url.includes("/api/quotes")) return j({ quotes: (b.markets || []).map((m) => ({ tokenId: m.tokenId, priceCents: m.snapshotCents ?? null, source: "snapshot", stale: true })) });
  if (url.includes("/api/engine")) {
    if (b.action === "analyze") return j({ ok: false, error: "Демо-превью: снимок реальных данных. Живой (пере)анализ и авто-цикл — в развёрнутой версии (нужен бэкенд + ключ Claude)." }, 422);
    if (b.action === "analyzeStatus") return j({ status: "idle" });
    return j({ ok: true });
  }
  if (url.includes("/api/mutations")) return j({ ok: true });
  return orig(input, init);
};
createRoot(document.getElementById("root")).render(<EdgeLab initial={DATA} />);
