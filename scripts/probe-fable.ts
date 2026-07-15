// Owner probe — WHY does the Fable-5 duel arm fail? One real call to each model via the app's own
// LLM path (callLLM, never-throws), printing success or the EXACT API error. Opus is the control.
//   npx tsx scripts/probe-fable.ts
// Read-only (a trivial 1-token completion). Tells abandon (404/403 no-access) from fixable (429/network).

import { getDb } from "../src/lib/db.js";
import * as R from "../src/lib/repo.js";
import { callLLM, effectiveEnv, resolveModel, apiKeyFor } from "../src/lib/llm.js";

const db = getDb();
const env = effectiveEnv(R.getProviderKeys(db));
const key = apiKeyFor("anthropic", env);
console.log(`═══ FABLE ARM PROBE ═══`);
console.log(`anthropic key: ${key ? `есть (${key.slice(0, 8)}…, len ${key.length})` : "НЕТ — вот и причина"}`);
console.log(`ANALYSIS_DUEL=${env.ANALYSIS_DUEL ?? "(unset)"}\n`);

for (const model of ["Claude Opus 4.8", "Claude Fable 5"]) {
  const apiId = resolveModel(model)?.apiId ?? "?";
  const t0 = Date.now();
  const r = await callLLM({ model, prompt: "Reply with exactly: OK", maxTokens: 16, retries: 0, timeoutMs: 30_000 }, { env });
  const ms = Date.now() - t0;
  console.log(`${model.padEnd(16)} [${apiId}]  ${ms}ms  → ${r.ok ? `OK: ${JSON.stringify(r.text.trim().slice(0, 40))}` : `FAIL: ${r.error}`}`);
}

console.log(`\nЧтение: Opus OK + Fable FAIL с 404/not_found или 403/not_authorized → у аккаунта НЕТ доступа к`);
console.log(`claude-fable-5 → арм не почини́ть ключом, ВЫРУБАЙ дуэль (ANALYSIS_DUEL=off → всё на Opus, полное покрытие).`);
console.log(`Fable FAIL с 429 → рейт-лимит (временное); network/timeout → сеть. Оба чинимы, не абандон.`);
