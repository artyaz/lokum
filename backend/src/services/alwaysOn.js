// Always-on fetcher orchestrator (Task I — H4 design).
//
// Architecture (H4-hybrid-final.md §7):
//   - One long-lived Chromium (browser.js#getWatcherBrowser) with per-platform
//     persistent BrowserContexts (browser.js#getPersistentContext). storageState
//     persisted to backend/.playwright-state/<slug>.json so cookies + localStorage
//     survive process restarts.
//   - Per-source watcher loop driven by `setInterval` (NOT node-cron — node-cron's
//     minimum resolution is 1 minute; H4's intervals go down to 75s for OLX).
//   - Each tick fetches ONLY page 1 of the source's search feed, computes a
//     sha256 hash of the returned listing IDs (sorted, so OLX's promoted-ad
//     rotation within page 1 doesn't flip the hash without a real new listing
//     — H2-T3 risk mitigation), and if the hash differs from the watermark:
//       1. Walk the result list from the top, finding the first ID that's in
//          `last_seen_ids` (H2-T4 last-seen-ID watermark short-circuit). Any
//          ID ABOVE that watermark is NEW.
//       2. For each new ID: call runner.js#enqueueNewListing(sourceId, cityId,
//          externalId, url, postedAt) — idempotent via the
//          (source_id, external_id) UNIQUE constraint; persistListing stub +
//          background enrichment pipeline (translate / dedupe / totalprice /
//          telegram).
//       3. Update last_seen_ids to the top-N (capped 500) of the new result.
//       4. Update page1_hash + last_changed_at.
//     If the hash matches the watermark: bump consecutive_empty_polls, do
//     nothing else.
//   - Circuit breaker: 3 consecutive errors for a source → set paused_until =
//     now + 5min + sendAdminAlert via telegram.js. Skip ticks while paused.
//   - Coexistence with the existing full cron (runner.js#runFetchCycle, fires
//     every ~30 min for ground-truth re-sync + is_active cleanup): in-memory
//     mutex `isFullCronRunning()` from runner.js. Watcher checks the flag at
//     the top of each tick and skips if true. The full cron takes 1-5 min, so
//     the watcher might skip 1-2 ticks per cron run — acceptable.
//
// Env vars (all optional; defaults in CAPS):
//   LOKUM_ALWAYS_ON=1            master switch. 0 = don't start watchers.
//                                (LOKUM_ONESHOT=1 also disables — CLI mode.)
//   ALWAYSON_HEADFUL=0           1 = Xvfb-wrapped headful Chrome (more stealth).
//   ALWAYSON_PAUSE_MS=300000     5-min cooldown after 3 consecutive errors.
//   ALWAYSON_WATERMARK_CAP=500   max size of last_seen_ids[] ring per (source,city).
//   ALWAYSON_OLX_INTERVAL=75000
//   ALWAYSON_OTODOM_INTERVAL=150000
//   ALWAYSON_GRATKA_INTERVAL=90000
//   ALWAYSON_MORIZON_INTERVAL=90000
//   ALWAYSON_ADRESOWO_INTERVAL=180000
//   ALWAYSON_FACEBOOK_INTERVAL=180000
//   PROXY_OTODOM_URL=            residential proxy override (H4-§4.9 — only if
//                                block-rate > 5% sustained).
//
// Lifecycle:
//   - initAlwaysOn() called from index.js after initScheduler() returns. Wrapped
//     in try/catch so a launch failure (e.g. Playwright not installed) logs an
//     error and continues — the rest of the server boots fine without the watcher.
//   - shutdownAlwaysOn() called from index.js graceful shutdown to close the
//     watcher browser + persistent contexts.

import { createHash } from 'node:crypto';
import { query, one, many } from '../db.js';
import {
  getPersistentContext,
  savePersistentContextState,
  closePersistentContexts,
} from './browser.js';
import {
  SCRAPERS_BY_ID,
  enqueueNewListing,
  isFullCronRunning,
} from './runner.js';
import { sendAdminAlert } from './telegram.js';

// H4 §7.3 per-platform poll intervals (ms). 0 = disable that source's watcher.
const INTERVALS = {
  1:  Number.parseInt(process.env.ALWAYSON_OLX_INTERVAL || '75000', 10),     // OLX
  2:  Number.parseInt(process.env.ALWAYSON_OTODOM_INTERVAL || '150000', 10), // Otodom
  4:  Number.parseInt(process.env.ALWAYSON_GRATKA_INTERVAL || '90000', 10),  // Gratka
  5:  Number.parseInt(process.env.ALWAYSON_MORIZON_INTERVAL || '90000', 10),  // Morizon
  3:  Number.parseInt(process.env.ALWAYSON_ADRESOWO_INTERVAL || '180000', 10), // Adresowo
  7:  Number.parseInt(process.env.ALWAYSON_FACEBOOK_INTERVAL || '180000', 10)  // Facebook
};

const PAUSE_MS = Number.parseInt(process.env.ALWAYSON_PAUSE_MS || '300000', 10) || 300000;
const WATERMARK_CAP = Number.parseInt(process.env.ALWAYSON_WATERMARK_CAP || '500', 10) || 500;
const ERROR_THRESHOLD = 3; // circuit breaker trip point

// Slug lookup for the per-platform storageState path. Matches the source rows
// in the DB. (See schema.sql for the canonical list — added by migrations.)
const SOURCE_SLUG_BY_ID = {
  1: 'olx',
  2: 'otodom',
  3: 'adresowo',
  4: 'gratka',
  5: 'morizon',
  7: 'facebook'
};

const watcherTimers = new Map();      // sourceId -> setInterval handle
const inFlightTicks = new Set();      // sourceIds currently ticking (prevents overlap)
let citiesCache = null;
let citiesCacheAt = 0;
const CITIES_TTL_MS = 5 * 60 * 1000; // 5-min cache of the city list

// Fetch the list of cities to probe (typically 5: warsaw/krakow/wroclaw/
// gdansk/poznan). Cached for 5 min so a config change in the cities table
// propagates within 5 min without re-querying every tick.
async function getCities() {
  if (citiesCache && Date.now() - citiesCacheAt < CITIES_TTL_MS) return citiesCache;
  const rows = await many(`SELECT id, name, name_pl, slug, lat, lng FROM cities ORDER BY id`);
  citiesCache = rows;
  citiesCacheAt = Date.now();
  return rows;
}

// SHA-256 of the SORTED set of externalIds (H2-T3 risk #2: sorted so OLX's
// promoted-ad rotation within page 1 doesn't flip the hash without a real
// new listing). Returns null for an empty list (so a fresh probe doesn't
// wipe a previously-good watermark).
function hashIds(ids) {
  if (!ids.length) return null;
  const sorted = [...new Set(ids.map(String))].sort();
  return createHash('sha256').update(sorted.join('|')).digest('hex');
}

// H2-T4 last-seen-ID watermark walk. Given the freshly-fetched ordered list
// of {externalId} and the previous last_seen_ids set, returns:
//   { newItems: [...top items ABOVE the first known ID], topIds: [first N] }
// `topIds` is the new watermark (capped at WATERMARK_CAP) for next tick.
//
// If NO item is in the previous set (e.g. source rotated its entire first
// page, or first-ever probe), we treat ALL items as new — same as the
// "no known id" case. Capped at WATERMARK_CAP to avoid enqueueing thousands
// of historical listings on first boot.
function detectNewAndWatermark(orderedItems, prevSeenSet) {
  const seen = prevSeenSet instanceof Set ? prevSeenSet : new Set(prevSeenSet || []);
  const newItems = [];
  let hitWatermark = false;
  for (const item of orderedItems) {
    if (seen.has(String(item.externalId))) {
      hitWatermark = true;
      break;
    }
    newItems.push(item);
  }
  // New watermark = the top WATERMARK_CAP ids of this result, regardless of
  // whether we hit the watermark. This keeps the ring fresh — if the source
  // posts 100 new listings between ticks, the watermark grows accordingly.
  const topIds = orderedItems.slice(0, WATERMARK_CAP).map(i => String(i.externalId));
  return { newItems, topIds, hitWatermark };
}

// Update the watermark row for (source_id, city_id) — bump poll timestamp,
// update hash + last_seen_ids on change, bump consecutive_empty_polls on
// no-change, track consecutive_errors for the circuit breaker, set
// paused_until on breaker trip.
async function updateWatermark({ sourceId, cityId, hash, topIds, changed, errorBump, paused }) {
  const now = new Date();
  if (paused) {
    const pausedUntil = new Date(now.getTime() + PAUSE_MS);
    await query(
      `UPDATE poll_watermarks
       SET last_poll_at = $3,
           paused_until = $4,
           consecutive_errors = consecutive_errors,
           last_changed_at = CASE WHEN $5 THEN $3 ELSE last_changed_at END
       WHERE source_id = $1 AND city_id = $2`,
      [sourceId, cityId, now, pausedUntil, changed]
    );
    return pausedUntil;
  }
  if (errorBump) {
    await query(
      `UPDATE poll_watermarks
       SET last_poll_at = $3,
           consecutive_errors = consecutive_errors + 1
       WHERE source_id = $1 AND city_id = $2`,
      [sourceId, cityId, now]
    );
    return null;
  }
  if (changed) {
    await query(
      `UPDATE poll_watermarks
       SET page1_hash = $3,
           last_seen_ids = $4::text[],
           consecutive_empty_polls = 0,
           consecutive_errors = 0,
           paused_until = NULL,
           last_changed_at = $5,
           last_poll_at = $5
       WHERE source_id = $1 AND city_id = $2`,
      [sourceId, cityId, hash, topIds, now]
    );
  } else {
    await query(
      `UPDATE poll_watermarks
       SET consecutive_empty_polls = consecutive_empty_polls + 1,
           consecutive_errors = 0,
           paused_until = NULL,
           last_poll_at = $3
       WHERE source_id = $1 AND city_id = $2`,
      [sourceId, cityId, now]
    );
  }
  return null;
}

// Ensure a watermark row exists for (source_id, city_id). INSERT ... ON
// CONFLICT DO NOTHING — idempotent.
async function ensureWatermarkRow(sourceId, cityId) {
  await query(
    `INSERT INTO poll_watermarks (source_id, city_id, last_poll_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (source_id, city_id) DO NOTHING`,
    [sourceId, cityId]
  );
}

// Read the current watermark state for a (source_id, city_id).
async function getWatermark(sourceId, cityId) {
  return one(
    `SELECT page1_hash, last_seen_ids, consecutive_errors, paused_until
     FROM poll_watermarks
     WHERE source_id = $1 AND city_id = $2`,
    [sourceId, cityId]
  ).catch(() => null);
}

// Run one watcher tick for a single source. Probes all cities in one call
// (the per-scraper `watchLatest(page, cities)` returns items for all cities
// in one pass).
//
// Tick flow (H2 "smart polling triad" + H4 §5.4 implementation sketch):
//   1. If paused_until > now → skip (circuit breaker cooldown).
//   2. If isFullCronRunning() → skip (mutex with full cron).
//   3. Acquire persistent context (per-source slug) — open a Playwright Page.
//   4. scraper.watchLatest(page, cities) → [{externalId, postedAt, url, cityId}].
//   5. Group items by cityId. For each city:
//      a. Compute new hash = sha256(sorted externalIds).
//      b. If hash == prev watermark hash → no change, bump empty_polls.
//      c. If hash differs (or prev hash null) → walk top-down for new IDs
//         (H2-T4 watermark short-circuit), enqueue each new via
//         enqueueNewListing(), update watermark with new topIds.
//   6. savePersistentContextState(slug) so cookies + localStorage persist
//      for the next tick.
//   7. On error: bump consecutive_errors. If >= 3, set paused_until = now + PAUSE_MS
//      + sendAdminAlert via telegram.
async function tickSource(sourceId) {
  // Reentrancy guard — if the previous tick is still running (network slow),
  // skip this tick. setInterval will fire again next interval.
  if (inFlightTicks.has(sourceId)) {
    console.debug(`[alwaysOn] source ${sourceId}: tick skipped (previous tick in-flight)`);
    return;
  }
  inFlightTicks.add(sourceId);
  let page = null;
  try {
    const scraper = SCRAPERS_BY_ID[sourceId];
    if (!scraper || typeof scraper.watchLatest !== 'function') return;
    const slug = SOURCE_SLUG_BY_ID[sourceId];
    if (!slug) return;

    // Check circuit breaker + full-cron mutex.
    const cities = await getCities();
    for (const city of cities) {
      await ensureWatermarkRow(sourceId, city.id);
      const wm = await getWatermark(sourceId, city.id);
      if (wm?.paused_until && new Date(wm.paused_until).getTime() > Date.now()) {
        // Still in cooldown — skip this city.
        continue;
      }
    }
    if (isFullCronRunning()) {
      console.debug(`[alwaysOn] source ${sourceId}: tick skipped (full cron running)`);
      return;
    }

    // OLX uses plain fetch (no Playwright). Other sources use a persistent
    // page on their BrowserContext.
    let items;
    try {
      if (slug === 'olx') {
        items = await scraper.watchLatest(null, cities);
      } else {
        const ctx = await getPersistentContext(slug);
        page = await ctx.newPage();
        items = await scraper.watchLatest(page, cities);
      }
    } catch (e) {
      // The whole tick failed (likely a launch / context error) — count as
      // one error for EVERY (source, city) watermark, then trip the breaker
      // uniformly. Per-city errors inside watchLatest are handled inside the
      // scraper (which `continue`s past the failed city) so they don't reach
      // here.
      console.warn(`[alwaysOn] source ${sourceId} (${slug}) tick failed:`, e.message);
      for (const city of cities) {
        await ensureWatermarkRow(sourceId, city.id);
        const wm = await getWatermark(sourceId, city.id);
        const errors = (wm?.consecutive_errors || 0) + 1;
        const shouldTrip = errors >= ERROR_THRESHOLD;
        await updateWatermark({
          sourceId, cityId: city.id,
          hash: null, topIds: null, changed: false,
          errorBump: true,
          paused: shouldTrip
        });
        if (shouldTrip && !(wm?.paused_until)) {
          // Only alert once per trip (not once per city).
          sendAdminAlert(
            `watcher for "${slug}" paused for ${Math.round(PAUSE_MS / 60000)} min after ${ERROR_THRESHOLD} consecutive errors: ${e.message}`,
            { label: 'alwaysOn' }
          ).catch(() => {});
        }
      }
      return;
    }

    // Group items by cityId for per-(source, city) watermark updates.
    const byCity = new Map();
    for (const item of items || []) {
      if (!item?.externalId || !item?.url) continue;
      const arr = byCity.get(item.cityId) || [];
      arr.push(item);
      byCity.set(item.cityId, arr);
    }

    for (const city of cities) {
      await ensureWatermarkRow(sourceId, city.id);
      const wm = await getWatermark(sourceId, city.id);
      const prevSet = wm?.last_seen_ids || [];
      const prevHash = wm?.page1_hash || null;

      const cityItems = byCity.get(city.id) || [];
      const newHash = hashIds(cityItems.map(i => i.externalId));

      // No items returned for this city — count as an error (transient block).
      if (!cityItems.length && prevHash !== null) {
        const errors = (wm?.consecutive_errors || 0) + 1;
        const shouldTrip = errors >= ERROR_THRESHOLD;
        await updateWatermark({
          sourceId, cityId: city.id,
          hash: null, topIds: null, changed: false,
          errorBump: true,
          paused: shouldTrip
        });
        if (shouldTrip && !(wm?.paused_until)) {
          sendAdminAlert(
            `watcher for "${slug}/${city.slug}" paused for ${Math.round(PAUSE_MS / 60000)} min after ${ERROR_THRESHOLD} consecutive empty/error polls`,
            { label: 'alwaysOn' }
          ).catch(() => {});
        }
        continue;
      }

      // Hash matches the watermark — no change.
      if (newHash && newHash === prevHash) {
        await updateWatermark({
          sourceId, cityId: city.id,
          hash: newHash, topIds: prevSet, changed: false
        });
        continue;
      }

      // Hash differs (or first probe) — H2-T4 walk: find new IDs above the
      // last-seen-ID watermark, enqueue each via enqueueNewListing.
      const { newItems, topIds } = detectNewAndWatermark(cityItems, prevSet);

      // Enqueue each new listing. Sequential — the per-listing pipeline
      // is fire-and-forget inside enqueueNewListing (returns immediately),
      // so the watcher loop is not blocked on enrichment.
      let enqueued = 0;
      for (const item of newItems) {
        try {
          const r = await enqueueNewListing({
            sourceId,
            cityId: city.id,
            externalId: item.externalId,
            url: item.url,
            postedAt: item.postedAt
          });
          if (r?.isNew) enqueued++;
        } catch (e) {
          // Don't abort the whole tick on one bad enqueue.
          console.warn(`[alwaysOn] enqueue failed for ${slug}/${city.slug}/${item.externalId}:`, e.message);
        }
      }

      console.log(
        `[alwaysOn] ${slug}/${city.slug}: ${newItems.length} new (enqueued ${enqueued}), hash ${prevHash ? 'changed' : 'init'}`
      );

      await updateWatermark({
        sourceId, cityId: city.id,
        hash: newHash, topIds, changed: true
      });
    }

    // Persist the updated cookies + localStorage for next tick.
    if (slug !== 'olx') {
      await savePersistentContextState(slug);
    }
  } finally {
    if (page) {
      try { await page.close({ runBeforeUnload: false }); } catch {}
    }
    inFlightTicks.delete(sourceId);
  }
}

// Start the watcher for a single source. setInterval-driven (not node-cron).
// The interval fires on a fixed schedule; the tick function checks the
// circuit-breaker + full-cron mutex internally and skips if either is set.
//
// H4-§4.6 jitter: ±20% on each interval to defeat metronomic-timing
// detection (anti-bot trigger #10). Implemented as a setTimeout that
// recomputes the next interval after each tick completes — slightly more
// code than setInterval but avoids the metronome.
function startWatcher(sourceId) {
  const intervalMs = INTERVALS[sourceId];
  if (!intervalMs || intervalMs <= 0) {
    console.log(`[alwaysOn] source ${sourceId}: watcher disabled (interval=0)`);
    return;
  }
  const slug = SOURCE_SLUG_BY_ID[sourceId] || `source-${sourceId}`;
  console.log(`[alwaysOn] starting watcher for "${slug}" (interval=${Math.round(intervalMs / 1000)}s)`);

  // Single async fire-and-reschedule loop. setTimeout chain — not setInterval
  // — so each tick's actual duration is included in the schedule, and the
  // jitter is recomputed per tick. The boot timer fires the FIRST tick at
  // t=1s (so fresh listings are detected ASAP on boot, not after a full
  // interval); subsequent ticks fire intervalMs ± 20% after the previous
  // tick COMPLETES (so a slow tick doesn't overlap with the next scheduled
  // fire).
  let bootTimer = null;
  let nextTimer = null;

  const fireTick = async () => {
    try {
      await tickSource(sourceId);
    } catch (e) {
      // tickSource's internal try/catch should swallow everything; this is
      // a belt-and-braces catch so a thrown tick never breaks the chain.
      console.error(`[alwaysOn] ${slug} tick threw:`, e.message);
    }
    // Reschedule only if not stopped (the stop() fn clears watcherTimers).
    if (watcherTimers.has(sourceId)) {
      const jitter = intervalMs * (0.8 + Math.random() * 0.4);
      nextTimer = setTimeout(fireTick, jitter);
      nextTimer.unref?.();
    }
  };

  bootTimer = setTimeout(fireTick, 1000); // first tick at t=1s
  bootTimer.unref?.();

  watcherTimers.set(sourceId, { stop: () => {
    if (bootTimer) clearTimeout(bootTimer);
    if (nextTimer) clearTimeout(nextTimer);
    watcherTimers.delete(sourceId);
  }});
}

// Initialize + start all per-source watchers. Called from index.js after
// initScheduler(). Wrapped in try/catch by the caller — a launch failure
// (e.g. Playwright not installed on the dev machine) logs an error and the
// rest of the server continues without the watcher.
export async function initAlwaysOn() {
  if (process.env.LOKUM_ONESHOT === '1') {
    console.log('[alwaysOn] LOKUM_ONESHOT=1 → skipping watcher init');
    return;
  }
  if (process.env.LOKUM_ALWAYS_ON === '0') {
    console.log('[alwaysOn] LOKUM_ALWAYS_ON=0 → skipping watcher init');
    return;
  }
  console.log('[alwaysOn] init starting (Task I — H4 hybrid design)');

  // Pre-warm the cities cache so the first tick doesn't pay the DB round trip.
  try {
    await getCities();
  } catch (e) {
    console.error('[alwaysOn] failed to load cities cache — proceeding anyway:', e.message);
  }

  // Start a watcher per source configured in INTERVALS.
  for (const sourceId of Object.keys(INTERVALS).map(Number)) {
    try {
      startWatcher(sourceId);
    } catch (e) {
      console.error(`[alwaysOn] failed to start watcher for source ${sourceId}:`, e.message);
    }
  }
  console.log(`[alwaysOn] init done — ${watcherTimers.size} watcher(s) scheduled`);
}

// Stop all watchers + close the persistent contexts. Called from
// index.js graceful shutdown.
export async function shutdownAlwaysOn() {
  for (const { stop } of watcherTimers.values()) {
    try { stop(); } catch {}
  }
  watcherTimers.clear();
  try {
    await closePersistentContexts();
  } catch (e) {
    console.warn('[alwaysOn] closePersistentContexts failed:', e.message);
  }
}
