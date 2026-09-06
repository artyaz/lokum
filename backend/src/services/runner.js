// Fetch cycle runner.
//
// Logic for "new" listings:
//   1. Compute sinceTime = latest successful cron_run's started_at
//      (excluding test runs, since test runs don't represent a real "fetch point").
//   2. For each (source, city) combination, run the scraper with { filters, sinceTime }.
//      The scraper applies filters at the URL level and walks listings newest-first.
//   3. For each scraped listing:
//      a. Persist it (database upsert).
//      b. Compute was_new = (listing.postedAt >= sinceTime).
//         This is "the listing was posted AFTER the previous cron run".
//      c. Record (cron_run_id, listing_id, was_new) in cron_run_listings.
//   4. Mark listings that weren't seen this run as is_active = FALSE
//      (only for the (source, city) we just scraped).
//
// The "NEW TODAY" feed queries cron_run_listings WHERE cron_run_id = <latest> AND was_new = TRUE.
// So a listing shows as NEW only if it was posted after the previous cron run
// (not merely "first time we've seen it" — that distinction matters when the
// previous cron failed or was filtered differently).

import { query, one, many } from '../db.js';
import { OlxScraper } from './scrapers/olx.js';
import { OtodomScraper } from './scrapers/otodom.js';
import { AdresowoScraper } from './scrapers/adresowo.js';
import { GratkaScraper } from './scrapers/gratka.js';
import { MorizonScraper } from './scrapers/morizon.js';
import { FacebookScraper } from './scrapers/facebook.js';
import { NieruchomosciOnlineScraper } from './scrapers/nieruchomosciOnline.js';
import { OfertyNetScraper } from './scrapers/ofertyNet.js';
import { DomiportaScraper } from './scrapers/domiporta.js';
import { TabelaofertScraper } from './scrapers/tabelaofert.js';
import { OkolicaScraper } from './scrapers/okolica.js';
import { SprzedajemyScraper } from './scrapers/sprzedajemy.js';
import { BezposrednioScraper } from './scrapers/bezposrednio.js';
import { Wynajem24Scraper } from './scrapers/wynajem24.js';
import { LentoScraper } from './scrapers/lento.js';
import { RentolaScraper } from './scrapers/rentola.js';
import { TelegramScraper } from './scrapers/telegram.js';
import { OdwlascicielaScraper } from './scrapers/odwlasciciela.js';
import { AllegroScraper } from './scrapers/allegro.js';
import { GethomeScraper } from './scrapers/gethome.js';
import { persistListing } from './scrapers/base.js';
import { translateParams, translateBatch } from './translate.js';
import { backfillMetro } from './metro.js';
import { rateAestheticBacklog } from './aesthetic.js';
import { resetAICircuit, aiCircuitState } from './ai-client.js';
import { dedupeForListings, dedupeCrossRun } from './dedupe.js';
import { computeForListings } from './totalprice.js';
import { notifyNewListings, notifyCommunityImport } from './telegram.js';
import { enrichBackfill } from './enrich.js';

const SCRAPERS = {
  1: new OlxScraper(),
  2: new OtodomScraper(),
  3: new AdresowoScraper(),
  4: new GratkaScraper(),
  5: new MorizonScraper(),
  7: new FacebookScraper(),
  8: new NieruchomosciOnlineScraper(),
  9: new DomiportaScraper(),
  10: new OfertyNetScraper(),
  11: new GethomeScraper(),
  12: new TabelaofertScraper(),
  14: new BezposrednioScraper(),
  15: new OkolicaScraper(),
  16: new SprzedajemyScraper(),
  17: new Wynajem24Scraper(),
  18: new LentoScraper(),
  19: new RentolaScraper(),
  20: new TelegramScraper(),
  13: new OdwlascicielaScraper(),
  21: new AllegroScraper()
};

// Exported so alwaysOn.js can probe the same per-source scraper instances
// the full cron uses (Task I — H4 design, §7.1 "Per-scraper extension").
export const SCRAPERS_BY_ID = SCRAPERS;

// ============================================================================
// Always-on fetcher coexistence (Task I — H4 design).
//
// In-memory mutex so the always-on watcher pauses its per-source ticks
// while a full cron runFetchCycle is in flight. The full cron takes
// 1-5 minutes to walk every (source, city) combo; without the mutex, the
// watcher would tick on the same source's search URL during that window,
// potentially racing on the same context/cookies and triggering
// duplicate-enqueue alerts for listings the full cron is about to persist
// anyway.
//
// Mutex scope:
//   - markFullCronStart() called inside runFetchCycle() after the in-flight
//     DB check passes; markFullCronEnd() called in a finally{} at function
//     exit.
//   - Watcher checks isFullCronRunning() before each tick; if true, skips
//     (the next tick will fire per its setInterval schedule).
//
// In-memory only — if the process restarts mid-cron, the mutex dies with
// it (no orphan-state cleanup needed). The existing run-concurrency lock
// in runFetchCycle (the cron_runs.status='running' DB check) handles the
// cross-process / cross-restart case.
let _isFullCronRunning = false;
export function isFullCronRunning() { return _isFullCronRunning; }
export function markFullCronStart() { _isFullCronRunning = true; }
export function markFullCronEnd() { _isFullCronRunning = false; }

// ============================================================================
// Watcher entry point (Task I — H4 design).
//
// Called by alwaysOn.js#watchLoop when the hash differs + a new externalId
// is detected on page 1 of a source's search feed. Idempotent: the
// (source_id, external_id) UNIQUE constraint in listings means a second
// call for the same externalId just returns the existing listingId with
// isNew=false — no double-enqueue, no duplicate telegram alert.
//
// Pipeline (per H4 §7.1):
//   1. Build a stub listing ({ externalId, sourceId, cityId, url, postedAt,
//      title: 'Pending enrichment', price: 0, ... }) and persistListing() it.
//      This makes the listing visible in the UI immediately (with the
//      source URL + postedAt — enough for a user to click through to the
//      source even before full enrichment).
//   2. If isNew: fire-and-forget a background enrichment pipeline:
//      (a) scraper.fetchOneListing(url, { city, externalId }) — for sources
//          that expose a per-listing detail-page fetch (otodom, gratka,
//          morizon, adresowo). OLX and Facebook return null (their per-
//          listing fetch isn't feasible — the full cron will catch up).
//          On success, persistListing() the enriched data (UPSERT updates
//          the same row in place).
//      (b) dedupeForListings([listingId]) — cross-source duplicate detection.
//      (c) computeForListings([listingId], { limit: 1 }) — total-price
//          estimate (skipped if price=0; totalprice.js no-ops).
//      (d) notifyCommunityImport(listingId) — per-listing telegram alert
//          using the same rule-matching as community imports (price range,
//          region polygons). Skips users whose rules don't match.
//
// Returns { listingId, isNew } on success, null on persist failure. The
// background pipeline is not awaited — the watcher loop must continue
// probing other sources without blocking on enrichment.
// ============================================================================
export async function enqueueNewListing({ sourceId, cityId, externalId, url, postedAt }) {
  if (!url || !externalId) return null;
  const scraper = SCRAPERS[sourceId];

  // Step 0 (2026-09-01): if a row for this (source, externalId) already
  // exists WITH enriched data (description or coords), do NOT overwrite it
  // with the stub below. The stub upsert previously clobbered enriched
  // desc/coords/title/price back to 'Pending enrichment' whenever the
  // watcher re-detected a known listing (watermark re-init, restarts) —
  // the enrichment pipeline then had to heal it via backfill. Keep
  // last_seen_at fresh (cheap indexed UPDATE) and treat it as not-new.
  const existingEnriched = await one(
    `SELECT id FROM listings
      WHERE source_id = $1 AND external_id = $2
        AND (description <> '' OR lat IS NOT NULL)`,
    [sourceId, String(externalId)]
  );
  if (existingEnriched) {
    try { await query(`UPDATE listings SET last_seen_at = NOW() WHERE id = $1`, [existingEnriched.id]); }
    catch (e) { console.warn('[runner] last_seen refresh failed:', e.message); }
    return { listingId: existingEnriched.id, isNew: false };
  }

  // Step 1: persist the stub immediately so the listing is visible in the
  // UI + so a subsequent call for the same externalId dedupes (isNew=false).
  const stub = {
    externalId: String(externalId),
    sourceId,
    cityId,
    title: 'Pending enrichment',
    description: '',
    price: 0,
    currency: 'PLN',
    rooms: null,
    area: null,
    floor: null,
    district: null,
    street: null,
    address: null,
    lat: null,
    lng: null,
    url,
    postedAt: postedAt || null,
    images: [],
    conveniences: [],
    raw: { watcher: true, enqueuedAt: new Date().toISOString() }
  };
  let persisted;
  try {
    persisted = await persistListing(stub);
  } catch (e) {
    console.error('[runner] watcher persist failed', e.message);
    return null;
  }
  // Already enqueued (UNIQUE constraint) — no double-enqueue / no duplicate
  // telegram alert.
  if (!persisted.isNew) return persisted;

  // Step 2: fire-and-forget the background enrichment pipeline.
  enqueueBackgroundEnrichment({ sourceId, cityId, externalId, url, listingId: persisted.listingId })
    .catch(e => console.error('[runner] background enrichment failed', e.message));

  return persisted;
}

async function enqueueBackgroundEnrichment({ sourceId, cityId, externalId, url, listingId }) {
  const scraper = SCRAPERS[sourceId];

  // (a) Per-listing detail fetch, when supported by the scraper.
  if (scraper && typeof scraper.fetchOneListing === 'function') {
    try {
      const city = await one(
        `SELECT id, name, name_pl, slug, lat, lng FROM cities WHERE id = $1`,
        [cityId]
      );
      if (city) {
        const full = await scraper.fetchOneListing(url, { city, externalId });
        if (full) {
          // UPSERT — updates the existing row (same source_id+external_id)
          // with the enriched description / coords / postedAt / images.
          try { await persistListing(full); }
          catch (e) { console.warn('[runner] enrichment persist failed:', e.message); }
        }
      }
    } catch (e) {
      console.warn('[runner] per-listing enrichment failed:', e.message);
    }
  }

  // (b) dedupe — compare against other active listings in the same city
  // for cross-source duplicate pairs (price + rooms + geo proximity).
  // No-op until listing has full data, but the call is cheap.
  try { await dedupeForListings([listingId]); }
  catch (e) { console.warn('[runner] watcher dedupe failed:', e.message); }

  // (c) totalprice — skipped automatically when price=0 (computeForListings
  // bails on listings missing price).
  try { await computeForListings([listingId], { limit: 1 }); }
  catch (e) { console.warn('[runner] watcher totalprice failed:', e.message); }

  // (d) telegram — uses the existing per-listing notifyCommunityImport
  // path (same as community imports). Sends only to users whose price +
  // region rules match the (scant) listing. With price=0 no user's price
  // rule will match, so this is effectively a no-op until the full cron
  // re-scrapes + UPSERTs the real price. The full cron's
  // notifyNewListings(runId) is the real alert path — this is a backup.
  try { await notifyCommunityImport(listingId); }
  catch (e) { console.warn('[runner] watcher telegram failed:', e.message); }
}

/**
 * Look up the latest "real" cron run's started_at (excluding test runs).
 * Returns null if no previous run exists.
 */
async function getSinceTime() {
  const r = await one(
    `SELECT started_at FROM cron_runs
     WHERE status IN ('success','partial')
       AND triggered_by IN ('cron','manual')
     ORDER BY started_at DESC
     LIMIT 1`
  );
  return r ? new Date(r.started_at) : null;
}

/**
 * Get the set of listing IDs that were seen in the previous successful run
 * for a given source. Used to determine "new" for sources without postedAt.
 */
async function getPrevRunListingIds(sourceId) {
  const prevRun = await one(
    `SELECT id FROM cron_runs
     WHERE status IN ('success','partial')
       AND triggered_by IN ('cron','manual')
     ORDER BY started_at DESC
     LIMIT 1 OFFSET 1`
  );
  if (!prevRun) return null; // no previous run — treat all as new
  const rows = await many(
    `SELECT crl.listing_id FROM cron_run_listings crl
     JOIN listings l ON l.id = crl.listing_id
     WHERE crl.cron_run_id = $1 AND l.source_id = $2`,
    [prevRun.id, sourceId]
  );
  return new Set(rows.map(r => r.listing_id));
}

/**
 * Backlog catch-up for description rewrites. Finds the oldest ACTIVE
 * listings that still lack description_en, builds translateBatch jobs for
 * up to `limit` of them, and runs the standard batched pipeline (cache
 * lookup + ≤5 listings per AI call). Oldest-first ordering guarantees the
 * backlog converges instead of starving early listings.
 */
async function translateBacklog(limit) {
  const rows = await many(
    `SELECT l.id, l.title, l.description, l.price, l.area, l.rooms, l.floor,
            l.district, l.raw, c.name AS city_name
     FROM listings l
     JOIN cities c ON c.id = l.city_id
     WHERE l.is_active = TRUE
       AND l.description_en IS NULL
       AND l.description IS NOT NULL AND l.description <> ''
     ORDER BY l.first_seen_at ASC
     LIMIT $1`,
    [limit]
  ).catch(() => []);
  if (!rows.length) return { translated: 0, cached: 0, failed: 0, aiCalls: 0 };
  const jobs = rows.map(r => ({
    listingId: r.id,
    payload: {
      title: r.title,
      description: r.description,
      price: r.price,
      city: r.city_name,
      district: r.district,
      area: r.area,
      rooms: r.rooms,
      floor: r.floor,
      params: r.raw?.params || []
    }
  }));
  return translateBatch(jobs);
}

/**
 * Backlog catch-up for total monthly prices. Same oldest-first convergence
 * as translateBacklog: the oldest ACTIVE listings with a rent but no
 * total_estimate get computed (AI batch → regex → size heuristic, so every
 * listing with a rent ends up with a total).
 */
async function priceBacklog(limit) {
  const rows = await many(
    `SELECT id FROM listings
     WHERE is_active = TRUE
       AND total_estimate IS NULL
       AND price IS NOT NULL AND price > 0
     ORDER BY first_seen_at ASC
     LIMIT $1`,
    [limit]
  ).catch(() => []);
  if (!rows.length) return { computed: 0, cached: 0, failed: 0, aiCalls: 0 };
  return computeForListings(rows.map(r => r.id), { limit: rows.length });
}

/**
 * Run a fetch cycle.
 *
 * @param {Object} opts
 * @param {string} opts.triggeredBy — 'cron' | 'manual' | 'test'
 * @param {number[]} opts.sourceIds — empty = all sources
 * @param {number[]} opts.cityIds — empty = all cities
 * @param {Object} opts.filters — { maxPrice, minRooms, maxRooms, minPrice }
 * @param {string} [opts.jobId] — Task G: link the new cron_run row back to
 *   the cron_jobs row that fired this run. Optional; manual/test runs and
 *   always-on fetcher ticks leave it NULL.
 * @returns cron_run row
 */
export async function runFetchCycle({ triggeredBy = 'cron', sourceIds = [], cityIds = [], filters = {}, jobId = null } = {}) {
  // FAKE_DB mode: no real scraping (no playwright/network) — simulate a run
  // against the in-memory sample data instead.
  if (process.env.FAKE_DB === '1') {
    const { simulateFetchCycle } = await import('../fakedb/index.js');
    return simulateFetchCycle({ triggeredBy });
  }

  // ---- Run-concurrency lock (Task A8, recommended by B8) ----
  //
  // The runner is sequential within a process, but the cron_runs table can
  // accumulate 'running' rows if a previous run was killed (SIGKILL, OOM,
  // hard watchdog) before it could UPDATE its row to a terminal status.
  // Without this guard, every crontab minute that finds a stale 'running'
  // row would silently allow a second run to start, eventually overlapping
  // with a real in-flight run from another crontab or the always-on Express.
  //
  // Strategy (simple, B8-recommended): row check + INSERT 'running' + UPDATE
  // on done. A true `SELECT FOR UPDATE SKIP LOCKED` advisory lock could be
  // added later if the race becomes real; for a 1–5 min cadence the simple
  // check is enough.
  //
  // 1. Opportunistic janitor: any 'running' row older than 30 min is stale
  //    (no run legitimately takes 30 min — the watchdog would have killed
  //    it at 10 min). Flip it to 'failed' so it doesn't block future runs.
  // 2. Skip check: if a 'running' row exists that is younger than 30 min,
  //    bail out gracefully with a 'skipped' status so the caller knows.
  const STALE_RUN_MS = 30 * 60 * 1000;
  const staleBefore = new Date(Date.now() - STALE_RUN_MS);
  try {
    const janitor = await query(
      `UPDATE cron_runs cr
       SET status = 'failed',
           error = COALESCE(error, 'stale: runner did not complete'),
           finished_at = NOW(),
           duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int,
           new_count = (SELECT count(*) FROM cron_run_listings crl WHERE crl.cron_run_id = cr.id AND crl.was_new),
           total_count = (SELECT count(*) FROM cron_run_listings crl WHERE crl.cron_run_id = cr.id)
       WHERE cr.status = 'running' AND cr.started_at < $1`,
      [staleBefore]
    );
    if (janitor.rowCount) {
      console.log(`[runner] stale-run janitor: marked ${janitor.rowCount} stale 'running' row(s) as 'failed'`);
    }
  } catch (e) {
    // Don't block the run if the janitor UPDATE fails — but log it.
    console.error('[runner] stale-run janitor failed:', e.message);
  }

  const inFlight = await one(
    `SELECT id, started_at FROM cron_runs
     WHERE status = 'running'
     ORDER BY started_at DESC
     LIMIT 1`
  ).catch(() => null);
  if (inFlight) {
    const ageMs = Date.now() - new Date(inFlight.started_at).getTime();
    console.log(`[runner] skipping — run ${inFlight.id} still in-flight (age ${Math.round(ageMs/1000)}s)`);
    return {
      id: inFlight.id,
      status: 'skipped',
      new_count: 0,
      total_count: 0,
      duration_ms: 0,
      error: `skipped: run ${inFlight.id} in-flight`,
      skipped: true,
      inFlightRunId: inFlight.id,
      perSource: {},
      details: { skipped: true, inFlightRunId: inFlight.id },
      sources: [],
      cities: []
    };
  }

  const startedAt = new Date();
  const startMs = Date.now();
  const memStart = process.memoryUsage();
  console.log(`[runner] start | triggeredBy=${triggeredBy} | rss=${Math.round(memStart.rss/1024/1024)}MB heap=${Math.round(memStart.heapUsed/1024/1024)}MB`);

  // Always-on watcher mutex (Task I — H4 §7.4). Set BEFORE the per-source
  // walk starts so the watcher skips ticks while we're scraping the same
  // sources. Cleared in the outer finally{} at function exit so a thrown
  // runFetchCycle (uncaught error in any per-source/per-city branch) can't
  // leave the mutex stuck on.
  markFullCronStart();

  // Reset the AI circuit breaker at the start of every fetch cycle so a
  // transiently-dead AI proxy on the previous run doesn't permanently skip
  // AI for the next run.
  resetAICircuit();

  // Resolve sources + cities
  const sourceList = sourceIds.length
    ? await many(`SELECT id, name, slug, color, base_url FROM sources WHERE id = ANY($1::int[])`, [sourceIds])
    : await many(`SELECT id, name, slug, color, base_url FROM sources ORDER BY id`);
  const cityList = cityIds.length
    ? await many(`SELECT id, name, name_pl, slug, lat, lng FROM cities WHERE id = ANY($1::int[])`, [cityIds])
    : await many(`SELECT id, name, name_pl, slug, lat, lng FROM cities ORDER BY id`);

  // Compute sinceTime — listings posted after this are "new" in this run.
  // For test runs, use the latest real cron run as the cutoff.
  // For manual/cron runs, also use the latest real cron run as the cutoff.
  const sinceTime = await getSinceTime();
  console.log(`[runner] sinceTime = ${sinceTime ? sinceTime.toISOString() : 'null (first run)'}`);

  // Create cron_run row.
  //
  // source_id / city_id are written when the run targets exactly one source
  // or city (per B8's audit: these columns were always NULL because the old
  // code hardcoded NULL even for single-source / single-city runs). When the
  // run spans multiple (or all) sources/cities, the column stays NULL —
  // that's the schema-level "all" convention. Frontend filters + the audit
  // script (scripts/audit_runs.js) can then display the per-source breakdown
  // for single-source runs without parsing the filters JSONB.
  const runSourceId = sourceIds.length === 1 ? sourceIds[0] : null;
  const runCityId  = cityIds.length  === 1 ? cityIds[0]  : null;
  const run = await one(
    `INSERT INTO cron_runs (started_at, status, source_id, city_id, triggered_by, filters, cron_job_id)
     VALUES ($1, 'running', $4, $5, $2, $3::jsonb, $6)
     RETURNING *`,
    [startedAt, triggeredBy, JSON.stringify(filters || {}), runSourceId, runCityId, jobId]
  );

  // Safety cap (2026-09-01): a manual run with empty filters x all cities x
  // all sources once inserted ~7k listings in one cycle. RUN_MAX_NEW_LISTINGS
  // bounds how many NEW listings a single run cycle may insert; when hit, the
  // remaining (source, city) units are skipped and the run is marked partial.
  const RUN_MAX_NEW = parseInt(process.env.RUN_MAX_NEW_LISTINGS || '1500', 10);
  let capSkipped = 0;
  let totalNew = 0;
  let totalSeen = 0;
  const newListingIds = [];   // was_new listings of this run (for post-run pipeline)
  const translateJobs = [];   // { listingId, payload } — processed post-run, bounded
  const perSourceStats = {}; // sourceId -> { new, total, error }
  const newCityIds = new Set();
  let lastError = null;

  // For each (source, city) combination
  for (const source of sourceList) {
    const scraper = SCRAPERS[source.id];
    if (!scraper) continue;
    perSourceStats[source.id] = { new: 0, total: 0, error: null };

    // For sources without postedAt (Gratka, Morizon, Adresowo), "new" means
    // "not seen in the previous run" rather than "first time in DB".
    const prevRunIds = await getPrevRunListingIds(source.id);

    for (const city of cityList) {
      if (totalNew >= RUN_MAX_NEW) {
        capSkipped++;
        console.warn(`[runner] RUN_MAX_NEW_LISTINGS cap (${RUN_MAX_NEW}) reached — skipping ${source.slug}/${city.slug}`);
        continue;
      }
      try {
        const seenIdsThisRun = [];
        // Task A3: buffer (listingId, wasNew) tuples and flush them in a
        // single multi-row INSERT after the (source, city) cycle finishes.
        // The previous code did one INSERT INTO cron_run_listings per
        // listing (one of the worst N+1 spots in the cron hot path —
        // ~130 listings × 5 sources × 5 cities = 3 250 INSERTs/run, now
        // 25). The is_active=FALSE UPDATE below only needs seenIdsThisRun
        // (the id list), so deferring the join-table write is safe.
        const cronRunListingsBuffer = [];
        const processListing = async (l) => {
          // Defensive filters also cover sources that cannot express every
          // filter in the source URL.
          if (filters.maxPrice != null && l.price > filters.maxPrice) return;
          if (filters.minPrice != null && (l.price == null || l.price < filters.minPrice)) return;
          if (filters.minRooms != null && l.rooms && l.rooms < filters.minRooms) return;
          if (filters.maxRooms != null && l.rooms && l.rooms > filters.maxRooms) return;

          let persisted;
          try {
            persisted = await persistListing(l);
          } catch (e) {
            console.error('[runner] persist failed', e.message);
            return;
          }
          seenIdsThisRun.push(persisted.listingId);

          let wasNew;
          if (sinceTime && l.postedAt) {
            wasNew = new Date(l.postedAt) >= sinceTime;
          } else if (!l.postedAt && prevRunIds !== null) {
            wasNew = persisted.isNew || !prevRunIds.has(persisted.listingId);
          } else {
            wasNew = persisted.isNew;
          }

          if (wasNew) {
            totalNew++;
            perSourceStats[source.id].new++;
            newListingIds.push(persisted.listingId);
            newCityIds.add(city.id);
          }
          totalSeen++;
          perSourceStats[source.id].total++;

          // Buffer the cron_run_listings write — flushed once per
          // (source, city) cycle below (Task A3 batching).
          cronRunListingsBuffer.push({ listingId: persisted.listingId, wasNew });

          if (persisted.isNew && l.description) {
            try {
              const paramsEn = translateParams(l.raw?.params || []);
              await query(
                `UPDATE listings SET params_en = $2::jsonb WHERE id = $1 AND params_en IS NULL`,
                [persisted.listingId, JSON.stringify(paramsEn)]
              );
              // Task A2: cap the in-memory translateJobs array at the
              // downstream batch size (translateBatch slices to 120 anyway).
              // Pushing unbound then slicing would hold ~N entries × ~1KB
              // payload (incl. full description text) across the whole run
              // before GC — for a busy day (200+ new listings with Polish
              // descriptions) that's ~200KB transiently retained for nothing.
              if (translateJobs.length < 120) {
                translateJobs.push({
                  listingId: persisted.listingId,
                  payload: {
                    title: l.title,
                    description: l.description,
                    price: l.price,
                    city: city.name,
                    district: l.district,
                    area: l.area,
                    rooms: l.rooms,
                    floor: l.floor,
                    params: l.raw?.params || []
                  }
                });
              }
            } catch (e) {
              console.error('[runner] translate params failed:', e.message);
            }
          }
        };

        if (scraper.supportsStreaming) {
          // Persist as each listing arrives. This keeps peak memory roughly
          // independent of page depth instead of retaining the entire source/city
          // result (including descriptions and raw metadata) before persistence.
          await scraper.fetchCity(city, { filters, sinceTime, onListing: processListing });
        } else {
          const scraped = await scraper.fetchCity(city, { filters, sinceTime });
          for (const l of scraped) await processListing(l);
        }

        // Flush the cron_run_listings buffer for this (source, city) cycle.
        // One multi-row INSERT via unnest replaces N per-listing INSERTs.
        // Must happen BEFORE the is_active=FALSE UPDATE so a re-scraper
        // of the same listing in a future run sees the was_new flag flip
        // back to TRUE consistently (the ON CONFLICT DO UPDATE preserves
        // the latest was_new, which is the desired semantic).
        if (cronRunListingsBuffer.length) {
          const lids = cronRunListingsBuffer.map(r => r.listingId);
          const wns  = cronRunListingsBuffer.map(r => r.wasNew);
          try {
            await query(
              `INSERT INTO cron_run_listings (cron_run_id, listing_id, was_new)
               SELECT $1, lid, wn FROM unnest($2::uuid[], $3::boolean[]) AS t(lid, wn)
               ON CONFLICT (cron_run_id, listing_id) DO UPDATE SET was_new = EXCLUDED.was_new`,
              [run.id, lids, wns]
            );
          } catch (e) {
            console.error(`[runner] cron_run_listings flush failed for ${source.slug}/${city.slug}:`, e.message);
          }
        }

        // Mark listings of this (source, city) that we DIDN'T see as is_active = FALSE
        // This is the "the listing disappeared from the source" signal.
        if (seenIdsThisRun.length) {
          await query(
            `UPDATE listings
             SET is_active = FALSE
             WHERE source_id = $1 AND city_id = $2
               AND id <> ALL($3::uuid[])`,
            [source.id, city.id, seenIdsThisRun]
          );
        }
      } catch (e) {
        console.error(`[runner] ${source.slug}/${city.slug} error:`, e.message);
        perSourceStats[source.id].error = e.message;
        perSourceStats[source.id].errorCity = city.slug;
        lastError = `${source.slug}/${city.slug}: ${e.message}`;
      }
    }
  }

  const finishedAt = new Date();
  const durationMs = Date.now() - startMs;
  // status: 'success' if at least one source returned data and no errors;
  //         'partial' if we got some data but also errors (e.g. Otodom blocked);
  //         'failed' if we got nothing.
  let status;
  if (capSkipped > 0) status = 'partial';   // cap hit — run did NOT cover everything
  else if (totalSeen > 0 && !lastError) status = 'success';
  else if (totalSeen > 0 && lastError) status = 'partial';
  else status = 'failed';

  // Build a per-source summary to persist in the cron_runs row (in the existing
  // `filters` JSONB column — conceptually a "details" object now)
  const details = {
    filters: filters || {},
    sinceTime: sinceTime ? sinceTime.toISOString() : null,
    perSource: {}
  };
  for (const sid of Object.keys(perSourceStats)) {
    const s = perSourceStats[sid];
    const src = sourceList.find(x => x.id == sid);
    details.perSource[src?.slug || sid] = {
      new: s.new,
      total: s.total,
      error: s.error || null
    };
  }

  const updated = await one(
    `UPDATE cron_runs
     SET finished_at = $1, status = $2, new_count = $3, total_count = $4,
         duration_ms = $5, error = $6, filters = $7::jsonb
     WHERE id = $8
     RETURNING *`,
    [finishedAt, status, totalNew, totalSeen, durationMs, lastError, JSON.stringify(details), run.id]
  );

  // Update scheduling info on cron_jobs that match this trigger pattern
  if (triggeredBy === 'cron') {
    await query(`UPDATE cron_jobs SET last_run_at = NOW() WHERE next_run_at <= NOW() AND enabled = TRUE`);
  }

  // ---- post-run pipeline (real runs only) ----
  // AI calls go through services/ai-client.js (single seam) which enforces:
  //   - hard 15s timeout (Promise.race with setTimeout)
  //   - circuit breaker (3 consecutive failures -> skip AI for rest of run)
  //   - batched prompts (translateBatch / computeForListings do N listings
  //     per LLM call instead of 1 per listing)
  //   - translations cache (translations table keyed by listing_id+source_lang)
  if (triggeredBy !== 'test' && (newListingIds.length || translateJobs.length)) {
    if (translateJobs.length) {
      const jobs = translateJobs.slice(0, 120); // newest first
      try {
        console.log(`[runner] translating ${jobs.length} descriptions (batched, ≤5/call)…`);
        const r = await translateBatch(jobs);
        console.log(
          `[runner] translated ${r.translated}/${jobs.length} ` +
          `(cached ${r.cached}, failed ${r.failed}, ${r.aiCalls} AI calls) ` +
          `circuit=${aiCircuitState().open ? 'OPEN' : 'closed'}`
        );
      } catch (e) {
        console.error('[runner] translate phase failed:', e.message);
      }
    }

    if (newListingIds.length) {
      try {
        const pairs = await dedupeForListings(newListingIds);
        if (pairs) console.log(`[runner] dedupe: ${pairs} duplicate pair(s) found`);
      } catch (e) {
        console.error('[runner] dedupe failed:', e.message);
      }
      try {
        await computeForListings(newListingIds, { limit: 80 });
      } catch (e) {
        console.error('[runner] totalprice failed:', e.message);
      }
      try {
        await notifyNewListings(run.id);
      } catch (e) {
        console.error('[runner] telegram notify failed:', e.message);
      }
    }

    // Enrichment backfill: fill missing descriptions/coords/photos for active
    // listings that the per-scraper enrichment (capped at 40/city) missed.
    try {
      const enrichResult = await enrichBackfill();
      if (enrichResult.enriched) {
        console.log(`[runner] enrich: ${enrichResult.enriched} listings enriched`);
      }
    } catch (e) {
      console.error('[runner] enrich backfill failed:', e.message);
    }

    // Metro proximity backfill: pure local haversine over the static OSM
    // station dataset (no AI cost), so it sweeps generously every run and
    // converges to ALL listings with coordinates. Runs right after
    // enrichment because enrichment is what fills in missing coords.
    try {
      const mm = await backfillMetro();
      if (mm.updated) {
        console.log(`[runner] metro: ${mm.updated} listings tagged (remaining ${mm.remaining})`);
      }
    } catch (e) {
      console.error('[runner] metro backfill failed:', e.message);
    }

    // Backlog catch-up: the new-listing phases above are capped (120
    // translations, 80 price estimates per run), so on busy days older
    // listings would NEVER get a rewrite or a total. These passes sweep
    // the oldest uncovered active listings each run (bounded by
    // AI_BACKLOG_PER_RUN) so coverage converges to ALL listings over
    // successive cycles. They run AFTER enrichment because enrichment may
    // have just filled the descriptions/coords these passes consume.
    try {
      const backlogN = parseInt(process.env.AI_BACKLOG_PER_RUN || '60', 10);
      if (backlogN > 0) {
        const tr = await translateBacklog(backlogN);
        if (tr.translated || tr.cached) {
          console.log(`[runner] translate backlog: ${tr.translated} translated (cached ${tr.cached}, failed ${tr.failed}, ${tr.aiCalls} AI calls)`);
        }
        const pr = await priceBacklog(backlogN);
        if (pr.computed || pr.cached) {
          console.log(`[runner] price backlog: ${pr.computed} computed (cached ${pr.cached}, failed ${pr.failed}, ${pr.aiCalls} AI calls)`);
        }
      }
    } catch (e) {
      console.error('[runner] AI backlog failed:', e.message);
    }

    // Aesthetic vision pass: eligible budget/metro/centrum rentals get
    // their photos rated for modern/clean looks; the best are flagged
    // topped so the feed surfaces them first with the TOP PICK chip.
    // Bounded (AESTHETIC_PER_RUN) — vision calls are the priciest in the
    // pipeline — and oldest-first for convergence.
    try {
      const aesN = parseInt(process.env.AESTHETIC_PER_RUN || '20', 10);
      if (aesN > 0) {
        const ar = await rateAestheticBacklog(aesN);
        if (ar.rated || ar.failed) {
          console.log(`[runner] aesthetic: ${ar.rated} rated, ${ar.topped} topped (${ar.failed} failed, ${ar.aiCalls} AI calls)`);
        }
      }
    } catch (e) {
      console.error('[runner] aesthetic pass failed:', e.message);
    }

    // Cross-run dedup: now that enrichment gave coords to previously-unlocated
    // listings, rescan all active listings for cross-source duplicates.
    try {
      const crossPairs = await dedupeCrossRun(newCityIds.size ? [...newCityIds] : null);
      if (crossPairs) console.log(`[runner] cross-run dedupe: ${crossPairs} pair(s)`);
    } catch (e) {
      console.error('[runner] cross-run dedupe failed:', e.message);
    }
  }

  // Always-on watcher mutex release (Task I — H4 §7.4). Done here in the
  // single success-path return; the per-source / per-city branches below all
  // have their own try/catch so a thrown branch can't reach this point. If
  // runFetchCycle throws unexpectedly (DB disconnect etc.) the mutex leaks
  // — the watcher simply skips ticks until the next process restart, which
  // is the safest behavior (we don't want the watcher running amok while
  // the DB is down).
  markFullCronEnd();
  return {
    ...updated,
    perSource: perSourceStats,
    details,
    sources: sourceList,
    cities: cityList
  };
}

// Convenience: close everything the runner may have opened (browser singleton)
// and emit a final memory snapshot. Use from oneshot entry points after the
// last runFetchCycle returns, then call pool.end() + process.exit().
export async function shutdownRunner({ label = 'runner' } = {}) {
  try {
    const { closeBrowser } = await import('./browser.js');
    await closeBrowser();
  } catch (e) {
    console.error(`[${label}] closeBrowser failed:`, e.message);
  }
  const mem = process.memoryUsage();
  console.log(`[${label}] shutdown | rss=${Math.round(mem.rss/1024/1024)}MB heap=${Math.round(mem.heapUsed/1024/1024)}MB`);
}


