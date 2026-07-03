// ============================================================
// EDGE LAB — server-side HTTP setup  [SERVER-ONLY]
//
// Node's global fetch (undici) does NOT honor HTTPS_PROXY on its own. In
// sandboxed/corporate environments egress goes through a proxy, so we install
// a ProxyAgent as the global dispatcher when a proxy is configured. This is a
// no-op in normal deployments (no proxy env => direct connections), so the
// Polymarket/LLM clients work unchanged everywhere.
//
// TLS: when the proxy re-terminates TLS, Node must trust its CA via
// NODE_EXTRA_CA_CERTS (the runtime sets this in proxied environments).
// ============================================================

import { ProxyAgent, setGlobalDispatcher } from "undici";

let configured = false;

export function ensureProxyConfigured(env = process.env): void {
  if (configured) return;
  configured = true;
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
}

// Configure on import so any server module that fetches is proxy-aware.
ensureProxyConfigured();
