// Bounded outbound HTTP agent for the scraper pipeline.
//
// Native `fetch` in Node 18+ is backed by undici, whose default dispatcher
// keeps idle sockets alive per origin with no bound on the number of
// concurrent sockets. For a long-lived Express server, that can leak
// hundreds of idle sockets between cron cycles.
//
// This module installs a single shared Agent with:
//   - connectionsPerHost: 6   (bound concurrent sockets per origin)
//   - keepAliveTimeout: 4s    (drop idle sockets quickly)
//   - keepAliveMaxTimeout: 10s
//   - headersTimeout: 30s     (defensive: abort hung responses)
//   - bodyTimeout: 30s
//
// `applyGlobalDispatcher()` is idempotent and safe to call from both
// index.js (Express server) and run_scrape.js (child). If the `undici`
// npm package isn't installed, we fall back to native fetch defaults —
// no crash, just no global bound.
//
// Per-call usage: pass `dispatcher: httpAgent` to `fetch(url, opts)`.
// Native fetch ignores this option unless undici is loaded — that's OK,
// the global dispatcher set in applyGlobalDispatcher() still applies.

let _agent = null;
let _setGlobalDispatcher = null;
let _applied = false;

try {
  // `undici` is bundled with Node 18+ as the implementation of global
  // `fetch`, but the public API (`Agent`, `setGlobalDispatcher`) is only
  // importable if the npm package is installed. Add it as a dep in
  // `package.json` to enable the bound agent everywhere.
  const undici = await import('undici');
  if (undici.Agent) {
    _agent = new undici.Agent({
      connectionsPerHost: 6,
      keepAliveTimeout: 4_000,
      keepAliveMaxTimeout: 10_000,
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
      pipelining: 1
    });
    _setGlobalDispatcher = typeof undici.setGlobalDispatcher === 'function'
      ? undici.setGlobalDispatcher
      : null;
  }
} catch {
  // undici not installed — native fetch defaults apply (4-5s idle per origin,
  // unbounded sockets per host). Acceptable for short-lived child runs;
  // not ideal for the long-lived Express server.
  _agent = null;
  _setGlobalDispatcher = null;
}

export const httpAgent = _agent;

/**
 * Install the shared Agent as the global undici dispatcher. Idempotent.
 * @returns {boolean} true if applied, false if undici wasn't available
 */
export function applyGlobalDispatcher() {
  if (_applied) return _agent != null;
  _applied = true;
  if (!_agent || !_setGlobalDispatcher) {
    console.log('[http] using native fetch default dispatcher (install `undici` for bounded sockets)');
    return false;
  }
  try {
    _setGlobalDispatcher(_agent);
    console.log('[http] global dispatcher set (maxSockets/host=6, keepAliveTimeout=4s)');
    return true;
  } catch (e) {
    console.warn('[http] failed to set global dispatcher:', e.message);
    return false;
  }
}

/**
 * Clean up the agent — close all idle sockets. Safe to call from
 * graceful shutdown handlers.
 */
export async function destroyAgent() {
  if (_agent) {
    try { await _agent.close?.(); } catch {}
    try { await _agent.destroy?.(); } catch {}
  }
}
