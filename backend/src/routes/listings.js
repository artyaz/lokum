import { Router } from 'express';
import { query, one, many } from '../db.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { pointInPolygon } from './regions.js';
import { normalizeFees } from './listings-helpers.js';

const router = Router();

// In-memory cache of regions by city, refreshed on each request.
// Structure: { cityId: [{ name, color, polygon }], ... }
let regionsCache = null;
let regionsCacheTime = 0;
const REGIONS_CACHE_TTL = 30_000; // 30 seconds

async function getRegionsByCity() {
  if (regionsCache && Date.now() - regionsCacheTime < REGIONS_CACHE_TTL) {
    return regionsCache;
  }
  const r = await query(
    `SELECT id, city_id, name, color, polygon FROM regions`
  );
  const byCity = {};
  for (const row of r.rows) {
    (byCity[row.city_id] ||= []).push({
      id: row.id, name: row.name, color: row.color,
      polygon: typeof row.polygon === 'string' ? JSON.parse(row.polygon) : row.polygon
    });
  }
  regionsCache = byCity;
  regionsCacheTime = Date.now();
  return byCity;
}

// Helper: decorate a listing row with images, conveniences, saved flag, source, city.
// Also appends region names as conveniences for listings whose lat/lng falls
// inside a user-drawn region polygon.
async function decorate(rows, userId) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  // images
  const imgRes = await query(
    `SELECT listing_id, url FROM listing_images
     WHERE listing_id = ANY($1::uuid[]) ORDER BY listing_id, position`,
    [ids]
  );
  const imgsByListing = {};
  for (const r of imgRes.rows) {
    (imgsByListing[r.listing_id] ||= []).push(r.url);
  }
  // conveniences
  const convRes = await query(
    `SELECT listing_id, type, label FROM listing_conveniences
     WHERE listing_id = ANY($1::uuid[])`,
    [ids]
  );
  const convByListing = {};
  for (const r of convRes.rows) {
    (convByListing[r.listing_id] ||= []).push({ type: r.type, label: r.label });
  }
  // saved
  let savedByListing = {};
  if (userId) {
    const savedRes = await query(
      `SELECT listing_id FROM saved_listings
       WHERE user_id = $1 AND listing_id = ANY($2::uuid[])`,
      [userId, ids]
    );
    for (const r of savedRes.rows) savedByListing[r.listing_id] = true;
  }

  // regions — check each listing against all regions in its city
  const regionsByCity = await getRegionsByCity();

  return rows.map(r => {
    const conv = (convByListing[r.id] || []).slice();
    // Region matching: if listing has lat/lng, check all regions for its city
    if (r.lat != null && r.lng != null && regionsByCity[r.city_id]) {
      for (const region of regionsByCity[r.city_id]) {
        if (pointInPolygon(r.lat, r.lng, region.polygon)) {
          conv.unshift({ type: 'region', label: region.name });
        }
      }
    }

    // Fee breakdown (Task E). normalizeFees handles both legacy {items:[]}
    // storage and the new {rent, admin_fee, utilities, parking, extras, ...}
    // shape; it always returns the new normalized shape so the frontend card
    // has a single chip-rendering path. Returns null when total_estimate is
    // unset (listing hasn't gone through totalprice.js yet).
    const fees = normalizeFees(r);

    return {
      id: r.id,
      source: { id: r.source_id, name: r.source_name, slug: r.source_slug, color: r.source_color },
      city: { id: r.city_id, name: r.city_name, namePl: r.city_name_pl, slug: r.city_slug },
      title: r.title,
      price: r.price,
      priceLabel: formatPrice(r.price),
      rooms: r.rooms,
      area: r.area,
      floor: r.floor,
      district: r.district,
      street: r.street,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      url: r.url,
      postedAt: r.posted_at,
      firstSeenAt: r.first_seen_at,
      isNew: r.is_new,
      images: imgsByListing[r.id] || [],
      conveniences: conv,
      saved: !!savedByListing[r.id],
      totalEstimate: r.total_estimate || null, // legacy alias of totalMonthly
      totalBreakdown: fees,                    // legacy alias of `fees`
      fees,                                    // NEW canonical full breakdown (Task E)
      totalMonthly: fees?.total_monthly ?? null, // NEW headline monthly cost (Task E)
      currency: fees?.currency ?? 'PLN',         // NEW currency code (Task E)
      // Metro proximity (nearest_metro JSONB {name, line, distance_m}) +
      // aesthetic topping flag. nearestMetro is null until the metro
      // backfill tags the listing (requires coordinates).
      nearestMetro: parseMetro(r.nearest_metro),
      aestheticScore: r.aesthetic_score ?? null,
      topped: !!r.topped
    };
  });
}

// nearest_metro arrives from pg as a parsed object already (JSONB), but be
// tolerant of string rows (tests, fakedb) so the feed never 500s on shape.
function parseMetro(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || !v.name) return null;
  return { name: String(v.name), line: String(v.line || ''), distance_m: Number(v.distance_m) || 0 };
}

function formatPrice(n) {
  if (n == null) return '';
  return n.toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł';
}

function timeAgo(date) {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

// ============ GET /api/listings ============
// Query params:
//   run_id       — UUID of a cron_run; show listings NEW in that run (was_new=true)
//   since_latest — '1' to show only listings new since latest cron run (default behavior when no run_id)
//   city         — city slug (warsaw, krakow, ...)
//   source       — source slug (olx, otodom)
//   max_price    — int
//   min_rooms    — int
//   max_rooms    — int
//   all          — '1' to ignore new-only filter (show all active listings)
//   limit        — int (default 50, max 200)
//   offset       — int
router.get('/', optionalUser, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const citySlug = req.query.city;
    const sourceSlug = req.query.source;
    const maxPrice = req.query.max_price ? parseInt(req.query.max_price) : null;
    const minRooms = req.query.min_rooms ? parseInt(req.query.min_rooms) : null;
    const maxRooms = req.query.max_rooms ? parseInt(req.query.max_rooms) : null;
    const runId = req.query.run_id;
    const showAll = req.query.all === '1';

    // When querying a specific historical run, we want to see all listings that
    // were new at that point in time — even if they've since been deactivated
    // by a later run (the listing may have been removed from OLX, but it was
    // still "new" in the selected run). So we only filter is_active=TRUE when
    // NOT querying a specific run.
    let where = runId ? [] : ['l.is_active = TRUE'];
    // Dedupe: in every pair (id_a = preferred source, id_b = loser) the loser
    // is hidden from the feed. The full group stays visible on /duplicates.
    where.push('l.id NOT IN (SELECT id_b FROM listing_duplicates)');
    let params = [];
    let idx = 1;

    if (citySlug) {
      where.push(`c.slug = $${idx++}`);
      params.push(citySlug);
    }
    if (sourceSlug) {
      where.push(`s.slug = $${idx++}`);
      params.push(sourceSlug);
    }
    if (maxPrice != null) {
      where.push(`l.price <= $${idx++}`);
      params.push(maxPrice);
    }
    if (minRooms != null) {
      where.push(`l.rooms >= $${idx++}`);
      params.push(minRooms);
    }
    if (maxRooms != null) {
      where.push(`l.rooms <= $${idx++}`);
      params.push(maxRooms);
    }

    let joinCron = '';
    let newOnlyCondition = '';

    if (runId) {
      // Show only listings that were NEW in this specific run
      joinCron = `JOIN cron_run_listings crl ON crl.listing_id = l.id AND crl.cron_run_id = $${idx}`;
      params.push(runId);
      idx++;
      newOnlyCondition = `AND crl.was_new = TRUE`;
    } else if (!showAll) {
      // Show listings marked NEW in the latest "real" cron run.
      // Exclude test runs (triggered_by='test') so a manual test fetch
      // doesn't wipe out the default feed view.
      // Using cron_run_listings.was_new = TRUE is more accurate than timestamp
      // comparison (which suffers from microsecond precision mismatches).
      joinCron = `JOIN cron_run_listings crl ON crl.listing_id = l.id AND crl.cron_run_id = (
        SELECT id FROM cron_runs
        WHERE status IN ('success','partial')
          AND triggered_by IN ('cron','manual')
        ORDER BY started_at DESC LIMIT 1
      )`;
      newOnlyCondition = `AND crl.was_new = TRUE`;
    }

    // Build the WHERE clause. If where is empty (e.g. runId set with no other
    // filters), use 'TRUE' as a no-op so the SQL is valid.
    const whereSql = where.length ? where.join(' AND ') : 'TRUE';
    // Base query (without ORDER BY / LIMIT) — used for both count and data.
    // Includes total_estimate + total_breakdown so the feed card can render
    // the prominent "all-in monthly price" + breakdown chips (Task E).
    const baseSql = `
      SELECT l.id, l.source_id, l.city_id, l.title, l.price, l.rooms, l.area, l.floor,
             l.district, l.street, l.address, l.lat, l.lng, l.url,
             l.posted_at, l.first_seen_at,
             l.total_estimate, l.total_breakdown,
             l.nearest_metro, l.aesthetic_score, l.topped,
             EXISTS(
               SELECT 1 FROM cron_run_listings crl2
               JOIN cron_runs cr2 ON cr2.id = crl2.cron_run_id
               WHERE crl2.listing_id = l.id
                 AND crl2.was_new = TRUE
                 AND cr2.id = (SELECT id FROM cron_runs
                                WHERE status IN ('success','partial')
                                  AND triggered_by IN ('cron','manual')
                                ORDER BY started_at DESC LIMIT 1)
             ) AS is_new,
             s.name AS source_name, s.slug AS source_slug, s.color AS source_color,
             c.name AS city_name, c.name_pl AS city_name_pl, c.slug AS city_slug
      FROM listings l
      JOIN sources s ON s.id = l.source_id
      JOIN cities c ON c.id = l.city_id
      ${joinCron}
      WHERE ${whereSql} ${newOnlyCondition}
    `;

    // Total count for feed header
    let totalCount = 0;
    try {
      const cr = await query('SELECT COUNT(*) as cnt FROM (' + baseSql + ') _c', params);
      totalCount = parseInt(cr.rows[0]?.cnt || '0');
    } catch (e) { /* fallback below */ }

    // Data query with interleave ordering + pagination. Topped (TOP PICK)
    // listings surface first, then the per-source interleave as before.
    const sql = baseSql + `
      ORDER BY l.topped DESC,
        ROW_NUMBER() OVER (PARTITION BY l.source_id ORDER BY l.first_seen_at DESC, l.posted_at DESC NULLS LAST)
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    params.push(limit, offset);

    const r = await query(sql, params);
    const listings = await decorate(r.rows, userId);
    res.json({
      count: totalCount || listings.length,
      limit,
      offset,
      listings
    });
  } catch (e) {
    console.error('[listings] list error', e);
    res.status(500).json({ error: 'listings_failed', detail: e.message });
  }
});

// ============ GET /api/listings/cities ============
router.get('/cities', async (req, res) => {
  try {
    const r = await query(`SELECT id, name, name_pl, slug, lat, lng FROM cities ORDER BY id`);
    res.json({ cities: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'cities_failed' });
  }
});

// ============ GET /api/listings/sources ============
router.get('/sources', async (req, res) => {
  try {
    const r = await query(`SELECT id, name, slug, color, base_url FROM sources ORDER BY id`);
    res.json({ sources: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'sources_failed' });
  }
});

// ============ GET /api/listings/runs ============
// Returns the recent cron runs — used to populate the date dropdown.
// Excludes pure 'test' runs (those are visible in Settings > Recent runs only).
router.get('/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const r = await query(
      `SELECT cr.id, cr.started_at, cr.finished_at, cr.status, cr.new_count, cr.total_count,
              cr.duration_ms, cr.error, cr.triggered_by, cr.source_id, cr.city_id,
              s.name AS source_name, s.slug AS source_slug,
              c.name AS city_name, c.slug AS city_slug
       FROM cron_runs cr
       LEFT JOIN sources s ON s.id = cr.source_id
       LEFT JOIN cities c ON c.id = cr.city_id
       WHERE cr.triggered_by IN ('cron','manual')
       ORDER BY cr.started_at DESC
       LIMIT $1`,
      [limit]
    );
    // previous run's started_at — used to compute "what was new in this run"
    const runs = r.rows;
    for (let i = 0; i < runs.length; i++) {
      const prev = runs[i + 1];
      runs[i].prev_started_at = prev ? prev.started_at : null;
    }
    res.json({ runs });
  } catch (e) {
    console.error('[listings] runs', e);
    res.status(500).json({ error: 'runs_failed' });
  }
});

// ============ GET /api/listings/:id ============
// Returns full listing detail including description and raw params.
router.get('/:id', optionalUser, async (req, res) => {
  try {
    // Task A3: explicit column list instead of `l.*`. The detail response
    // shape is fully known here (decorate() + the params/description fields
    // below), so naming the columns protects against accidentally exposing
    // future-added columns (e.g. raw cookie-session payloads, internal
    // bookkeeping) and lets the planner skip the row-attribute lookup that
    // `*` requires on every row.
    const r = await one(
      `SELECT l.id, l.source_id, l.external_id, l.city_id, l.title,
              l.description, l.description_en, l.params_en,
              l.price, l.currency, l.rooms, l.area, l.floor,
              l.district, l.street, l.address, l.lat, l.lng, l.url,
              l.posted_at, l.first_seen_at, l.last_seen_at, l.is_active,
              l.raw, l.total_estimate, l.total_breakdown,
              l.nearest_metro, l.aesthetic_score, l.topped,
              l.photo_phash, l.duplicate_of_id, l.duplicate_source,
              s.name AS source_name, s.slug AS source_slug, s.color AS source_color,
              c.name AS city_name, c.name_pl AS city_name_pl, c.slug AS city_slug
       FROM listings l
       JOIN sources s ON s.id = l.source_id
       JOIN cities c ON c.id = l.city_id
       WHERE l.id = $1`,
      [req.params.id]
    );
    if (!r) return res.status(404).json({ error: 'not_found' });
    const [decorated] = await decorate([r], req.user?.id);

    // Extract params from raw for the detail page (OLX-style "Label: Value" boxes)
    let params = [];
    if (r.raw && Array.isArray(r.raw.params)) {
      params = r.raw.params.map(p => ({ label: p.name, value: p.value }));
    }

    // Use translated params if available, otherwise fall back to original
    let paramsEn = [];
    if (r.params_en) {
      paramsEn = typeof r.params_en === 'string' ? JSON.parse(r.params_en) : r.params_en;
    }

    res.json({
      listing: {
        ...decorated,
        description: r.description || '',
        descriptionEn: r.description_en || null,
        params,
        paramsEn,
        // `fees` is already on `decorated` (added by decorate() in Task E);
        // surface it explicitly here too so the detail response shape is
        // self-documenting for API consumers.
        fees: decorated.fees
      }
    });
  } catch (e) {
    console.error('[listings] detail', e);
    res.status(500).json({ error: 'detail_failed' });
  }
});

export default router;
