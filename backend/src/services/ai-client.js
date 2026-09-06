// =============================================================================
// ai-client.js — SINGLE SEAM for every AI call in the Lokum backend.
//
// Backend: OpenRouter chat-completions.
//   POST https://openrouter.ai/api/v1/chat/completions
//   Authorization: Bearer $OPENROUTER_API_KEY
//   HTTP-Referer: https://lokum.local        (OpenRouter attribution header)
//   X-Title: Lokum                              (OpenRouter app-name header)
//   Body: { model, messages, max_tokens, temperature, stream:false }
//
// Model:
//   openai/gpt-5.6-luna   (OpenAI GPT Luna via OpenRouter, reasoning effort
//   xhigh by default — see AI_REASONING_EFFORT). Override with
//   OPENROUTER_MODEL env var.
//
// Efficiency invariants preserved from agent A7's prep work:
//   - hard 45s timeout per call (Promise.race with setTimeout) — DeepSeek on
//     OpenRouter can take 20-30s under load; 15s was too tight and caused the
//     'ai-json timed out after 5000ms' cascade (circuit breaker tripping).
//   - circuit breaker: 5 consecutive failures -> skip AI for 2 min
//     (in-memory flag, auto-resets; runner.js also calls resetAICircuit at the
//     start of every fetch cycle for clean-slate recovery)
//   - translations cache table (translations) — re-runs skip already-translated
//   - shared by translate.js, totalprice.js, runner.js (no other module is
//     allowed to talk to the AI directly)
//
// Export signature kept stable from the A7 prep commit:
//   callAI({ system, user, opts }) -> Promise<string>
//   opts: { timeoutMs, bypassCircuit, model, maxTokens, temperature }
// =============================================================================

import { query, one, many } from '../db.js';

// --- Configuration ----------------------------------------------------------
const OPENROUTER_URL = process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;
// OpenAI GPT Luna via OpenRouter (verified id on the /models catalogue).
// Override with OPENROUTER_MODEL env var — any OpenRouter chat-completions
// model id works (e.g. openai/gpt-5.6-luna-pro, deepseek/deepseek-chat).
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5.6-luna';
// Reasoning effort for models that support it (OpenAI gpt-5.x family:
// none|low|medium|high|xhigh). Sent as the OpenRouter `reasoning.effort`
// request field; ignored by models without reasoning support. Empty string
// disables the field entirely.
const REASONING_EFFORT = (process.env.AI_REASONING_EFFORT || 'xhigh').trim();
const HARD_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '45000', 10);
const DEFAULT_MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS || '1024', 10);
const DEFAULT_TEMPERATURE = parseFloat(process.env.AI_TEMPERATURE || '0.2');

// --- Circuit breaker state (module-level singleton) ------------------------
// Counts consecutive failures. After CIRCUIT_FAIL_THRESHOLD in a row, the
// breaker opens for CIRCUIT_OPEN_MS milliseconds (5 min) — during that window
// callAI() rejects immediately with code 'circuit_open' unless opts.bypassCircuit
// is set (on-demand UI calls from the /translate endpoint). After the open
// window elapses the breaker auto-resets so the next run cycle doesn't have
// to call resetAICircuit manually.
const CIRCUIT_FAIL_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 2 * 60 * 1000; // 2 minutes (was 5 — too aggressive)

let consecutiveFailures = 0;
let circuitOpen = false;
let circuitOpenUntil = 0; // epoch-ms when the breaker will auto-close

export function aiCircuitState() {
  // If the open window has expired, transparently reset so callers see the
  // current effective state.
  if (circuitOpen && Date.now() >= circuitOpenUntil) {
    circuitOpen = false;
    consecutiveFailures = 0;
  }
  return { open: circuitOpen, consecutiveFailures, openUntil: circuitOpenUntil || null };
}

export function resetAICircuit() {
  if (consecutiveFailures > 0 || circuitOpen) {
    console.log(`[ai-client] circuit reset (was ${consecutiveFailures} consecutive failures, open=${circuitOpen})`);
  }
  consecutiveFailures = 0;
  circuitOpen = false;
  circuitOpenUntil = 0;
}

function recordAISuccess() {
  consecutiveFailures = 0;
  circuitOpen = false;
  circuitOpenUntil = 0;
}

function recordAIFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_FAIL_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    console.warn(
      `[ai-client] circuit OPEN after ${consecutiveFailures} consecutive failures — ` +
      `AI will be skipped for ${Math.round(CIRCUIT_OPEN_MS / 1000)}s ` +
      `(or until resetAICircuit() is called by the next fetch cycle).`
    );
  }
}

// --- Hard timeout helper (Promise.race with setTimeout) --------------------
// Belt-and-suspenders: even if the underlying fetch exposes AbortSignal.timeout,
// we wrap in Promise.race so a hung socket cannot lock the worker forever.
function withTimeout(promise, ms, label = 'ai-call') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- Free-model fallback (402 resilience) ----------------------------------
// When the OpenRouter account runs out of credits, every paid call 402s and
// ALL AI features (translate, price analysis, description rewrite) die — even
// though OpenRouter hosts free variants of capable models. Strategy:
//   1. If the 402 body says "can only afford N tokens" and N is workable,
//      immediately retry the PAID model with max_tokens = N (spend the
//      remaining credits instead of dropping the feature).
//   2. Otherwise fall back through FREE_MODELS and remember the winner
//      (sticky) so subsequent calls skip the paid 402 round-trip.
//   3. Every 30 min, quietly probe the paid model again — a top-up
//      transparently restores it as primary.
const FREE_MODELS = (process.env.AI_FREE_MODELS ||
  'minimax/minimax-m3:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,openrouter/free')
  .split(',').map(s => s.trim()).filter(Boolean);
let stickyFreeModel = null;   // free model that worked while credits are empty
let lastPrimaryProbeMs = 0;   // last time we re-tried the paid model after a 402
const PRIMARY_REPROBE_MS = 30 * 60 * 1000;

function isFreeModel(m) { return m.endsWith(':free'); }

async function rawCall(headers, system, user, model, maxTokens, temperature, timeoutMs, aiOpts = {}) {
  const effort = aiOpts.reasoningEffort !== undefined ? aiOpts.reasoningEffort : REASONING_EFFORT;
  const payload = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: system },
      // Multimodal (vision) calls pass content-parts; default is plain text.
      { role: 'user', content: aiOpts.userContent || user }
    ],
    max_tokens: maxTokens,
    temperature
  };
  // Reasoning effort (e.g. "xhigh" for GPT Luna). Only sent when configured;
  // OpenRouter ignores it for models without reasoning support.
  if (effort) payload.reasoning = { effort };
  const body = JSON.stringify(payload);
  return withTimeout(
    fetch(OPENROUTER_URL, { method: 'POST', headers, body }),
    timeoutMs,
    'ai-fetch'
  );
}

/**
 * SINGLE SEAM. Every AI call in the backend MUST go through here.
 *
 * @param {Object} args
 * @param {string} args.system                system prompt
 * @param {string} args.user                  user prompt
 * @param {Object} [args.opts]
 * @param {number} [args.opts.timeoutMs]      override HARD_TIMEOUT_MS (default 45000)
 * @param {boolean}[args.opts.bypassCircuit]  skip the circuit-breaker check (on-demand UI calls)
 * @param {string} [args.opts.model]          override DEFAULT_MODEL
 * @param {number} [args.opts.maxTokens]      override DEFAULT_MAX_TOKENS
 * @param {number} [args.opts.temperature]   override DEFAULT_TEMPERATURE
 * @param {string} [args.opts.reasoningEffort] override REASONING_EFFORT ('' disables)
 * @param {Array}  [args.opts.userContent]   when set, replaces the plain user
 *   string with a multimodal content-parts array (e.g. [{type:'text',text},
 *   {type:'image_url',image_url:{url}}] for vision calls)
 * @returns {Promise<string>} content string from the model
 * @throws  {Error} with .code ∈ {'circuit_open','timeout','http','empty','not_configured','parse'}
 */
export async function callAI({ system, user, opts = {} }) {
  // Auto-recover if the open window has expired.
  if (circuitOpen && Date.now() >= circuitOpenUntil) {
    circuitOpen = false;
    consecutiveFailures = 0;
  }
  if (circuitOpen && !opts.bypassCircuit) {
    const e = new Error('AI circuit is open — skipping call');
    e.code = 'circuit_open';
    throw e;
  }

  if (!OPENROUTER_API_KEY) {
    const e = new Error('OPENROUTER_API_KEY not set — AI backend not configured');
    e.code = 'not_configured';
    throw e;
  }

  const timeoutMs = opts.timeoutMs || HARD_TIMEOUT_MS;
  const primaryModel = opts.model || DEFAULT_MODEL;
  let maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature != null ? opts.temperature : DEFAULT_TEMPERATURE;
  // Per-call multimodal + reasoning overrides (vision passes userContent parts).
  const aiOpts = { reasoningEffort: opts.reasoningEffort, userContent: opts.userContent };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    // OpenRouter attribution headers — show "Lokum" in their dashboard.
    'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://lokum.local',
    'X-Title': 'Lokum'
  };

  // Resolve the effective model. While credits are dead we stick to the free
  // model that last worked, but every PRIMARY_REPROBE_MS we quietly re-probe
  // the paid model — a top-up transparently restores it.
  let model = primaryModel;
  if (stickyFreeModel && !opts.model) {
    const due = Date.now() - lastPrimaryProbeMs >= PRIMARY_REPROBE_MS;
    model = due ? primaryModel : stickyFreeModel;
  }

  const ATTEMPTS = 2;
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let raw;
    let data;
    try {
      raw = await rawCall(headers, system, user, model, maxTokens, temperature, timeoutMs, aiOpts);

      if (!raw.ok) {
        const errText = await raw.text().catch(() => '');
        if (raw.status === 402) {
          // --- 402: credits exhausted. Two-stage rescue: -------------------
          // Stage 1: spend what's left — "You requested up to 1536 tokens,
          // but can only afford 1272" → retry with max_tokens = 1272.
          const afford = parseInt((errText.match(/can only afford (\d+)/) || [])[1], 10);
          if (!isFreeModel(model) && afford >= 200 && afford < maxTokens) {
            console.warn(`[ai] 402 — retrying paid model with max_tokens=${afford} (spending remaining credits)`);
            maxTokens = afford;
            attempt--; // don't burn a real attempt on this instant retry
            continue;
          }
          // Stage 2: fall back through free models.
          if (isFreeModel(model) || stickyFreeModel) {
            // already on the free path and it just 402'd/failed → drop stickiness
            stickyFreeModel = null;
          }
          console.error('[ai] OpenRouter 402 — OUT OF CREDITS. Falling back to free models (top up at https://openrouter.ai/credits to restore primary model).');
          lastPrimaryProbeMs = Date.now();
          const candidates = FREE_MODELS.filter(m => m !== model);
          for (const fm of candidates) {
            try {
              raw = await rawCall(headers, system, user, fm, maxTokens, temperature, timeoutMs, aiOpts);
              if (raw.ok) {
                const text = await raw.text();
                data = JSON.parse(text);
                const content = data?.choices?.[0]?.message?.content || '';
                if (content) {
                  stickyFreeModel = fm;
                  console.warn(`[ai] free-model fallback succeeded — using "${fm}" until credits are topped up`);
                  recordAISuccess();
                  return content;
                }
              }
            } catch { /* try next free model */ }
          }
          const e = new Error('AI HTTP 402: out of credits and all free-model fallbacks failed');
          e.code = 'http';
          e.status = 402;
          throw e;
        }
        const e = new Error(`AI HTTP ${raw.status}: ${errText.slice(0, 200)}`);
        e.code = 'http';
        e.status = raw.status;
        throw e;
      }

      // Read body as text first (bounded by the fetch timeout above), then parse
      // synchronously. The previous `withTimeout(raw.json(), 5000, 'ai-json')` was
      // the root cause of the 'AI JSON parse failed: ai-json timed out after 5000ms'
      // cascade — a slow read side (large response, cold socket) hit 5s even though
      // the model had already produced a valid answer. JSON.parse() on a complete
      // buffer is CPU-bound and takes <50ms even for 100KB responses.
      const text = await raw.text();
      try {
        data = JSON.parse(text);
      } catch (e) {
        const err = new Error(`AI JSON parse failed: ${e.message}`);
        err.code = 'parse';
        throw err;
      }

      const content = data?.choices?.[0]?.message?.content || '';
      if (!content) {
        const err = new Error('AI returned empty content');
        err.code = 'empty';
        throw err;
      }

      // A paid-model success means credits are back — clear the sticky fallback.
      if (stickyFreeModel && !isFreeModel(model)) {
        stickyFreeModel = null;
        console.log('[ai] paid model responded — credits restored, free-model fallback cleared');
      }
      recordAISuccess();
      return content;
    } catch (e) {
      const code = /timed out/i.test(e.message) ? 'timeout' : (e.code || 'http');
      lastErr = e;
      if (e.status === 402) {
        // 402 is terminal for this call (fallback chain already exhausted)
        recordAIFailure();
        const err = new Error(e.message);
        err.code = 'http';
        err.status = 402;
        throw err;
      }
      const transient = code === 'timeout' || code === 'parse' || code === 'empty'
        || (code === 'http' && (e.status === 429 || e.status >= 500));
      console.warn(`[ai] attempt ${attempt}/${ATTEMPTS} failed (${code}): ${e.message.slice(0, 160)}`
        + (transient && attempt < ATTEMPTS ? ' — retrying in 2s' : ''));
      if (transient && attempt < ATTEMPTS) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      recordAIFailure();
      const err = new Error(e.message);
      err.code = code;
      throw err;
    }
  }

  recordAIFailure();
  const err = new Error(lastErr ? lastErr.message : 'AI call failed');
  err.code = 'http';
  throw err;
}

/**
 * Run several prompts sequentially, sharing one circuit-breaker state.
 * Used by batch translation / batch totalprice loops so that one failure
 * doesn't drag down N sequential calls — once the breaker opens, the
 * remaining calls short-circuit to {ok:false, error:'circuit_open'}.
 *
 * @param {Array<{system, user, opts}>} calls
 * @param {{stopOnCircuit?: boolean}} cfg  — default true
 * @returns {Promise<Array<{ok, content, error}>>}  — never throws; per-call result
 */
export async function callAISeries(calls, cfg = {}) {
  const stopOnCircuit = cfg.stopOnCircuit !== false;
  const out = [];
  for (const c of calls) {
    if (circuitOpen && stopOnCircuit) {
      out.push({ ok: false, error: 'circuit_open', content: null });
      continue;
    }
    try {
      const content = await callAI(c);
      out.push({ ok: true, content, error: null });
    } catch (e) {
      out.push({ ok: false, content: null, error: e.code || e.message });
    }
  }
  return out;
}

// =============================================================================
// Translations cache (table: translations)
//
// Keyed by (listing_id, source_lang). Lets re-runs (cron fetch cycles)
// skip listings we've already translated, which is the biggest cost win:
// without this, every cron run that sees 100 previously-translated listings
// would re-translate all of them. With the cache, only genuinely new
// listings hit the AI.
//
// Migration: sql/migration_007_translations.sql (legacy) +
//            sql/2026_08_translations_cache.sql (extends with target_lang +
//            created_at columns to match the task E spec shape).
// =============================================================================

/**
 * Look up a cached translation for a listing.
 * @param {string} listingId
 * @param {string} sourceLang  — default 'pl'
 * @returns {Promise<string|null>} translated markdown or null
 */
export async function getCachedTranslation(listingId, sourceLang = 'pl') {
  try {
    const r = await one(
      `SELECT translated_text FROM translations
       WHERE listing_id = $1 AND source_lang = $2
       LIMIT 1`,
      [listingId, sourceLang]
    );
    return r?.translated_text || null;
  } catch {
    // Table missing or db error — degrade gracefully (just means we re-translate)
    return null;
  }
}

/**
 * Bulk cache lookup — ONE SELECT for N listing ids instead of N round-trips.
 * Used by translate.js#translateBatch at the start of the cron re-run path so
 * we don't issue 80 sequential SELECTs just to figure out which listings to
 * skip. Mirrors the bulk-load pattern already used by
 * totalprice.js#computeForListings.
 *
 * @param {string[]} listingIds
 * @param {string} sourceLang  — default 'pl'
 * @returns {Promise<Map<string,string>>} listingId -> translated_text
 */
export async function getCachedTranslationsBulk(listingIds, sourceLang = 'pl') {
  const out = new Map();
  if (!Array.isArray(listingIds) || listingIds.length === 0) return out;
  try {
    const rows = await many(
      `SELECT listing_id, translated_text FROM translations
       WHERE source_lang = $2 AND listing_id = ANY($1::uuid[])`,
      [listingIds, sourceLang]
    );
    for (const r of rows) {
      if (r?.listing_id && r?.translated_text) out.set(r.listing_id, r.translated_text);
    }
  } catch {
    // Table missing or db error — degrade gracefully (return empty map so
    // caller will translate everything; better than crashing the run).
  }
  return out;
}

/**
 * Save a translation to the cache table. Idempotent UPSERT.
 */
export async function setCachedTranslation(listingId, translatedText, sourceLang = 'pl') {
  try {
    await query(
      `INSERT INTO translations (listing_id, source_lang, translated_text, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (listing_id, source_lang)
       DO UPDATE SET translated_text = EXCLUDED.translated_text, updated_at = NOW()`,
      [listingId, sourceLang, translatedText]
    );
  } catch (e) {
    // Cache write failure is non-fatal — keep going
    console.warn('[ai-client] cache write failed:', e.message);
  }
}


