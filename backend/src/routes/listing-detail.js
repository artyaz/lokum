import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, one } from '../db.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { pointInPolygon } from './regions.js';
import { formatPrice, normalizeFees } from './listings-helpers.js';
import { translateDescription } from '../services/translate.js';
import { getPOIs, getStarred, matchStarred } from '../services/pois.js';

const router = Router();

// ============ GET /api/listings/:id/pois ============
// Returns the cached POIs for the listing's lat/lng (800m radius by default),
// annotated with the active user's starred-POI state. Public (optionalUser)
// so the share-page can render chips too — starred-state is null-user
// (single-user mode) when no session is present.
//
// Path params:
//   id   — listing UUID
// Query:
//   radius — override default 800m radius (clamped 100..5000)
router.get('/:id/pois', optionalUser, async (req, res) => {
  try {
    const r = await one(
      `SELECT id, lat, lng FROM listings WHERE id = $1`,
      [req.params.id]
    );
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (r.lat == null || r.lng == null) {
      return res.json({ pois: [] });
    }

    const radius = Math.min(Math.max(parseInt(req.query.radius) || 800, 100), 5000);
    const [pois, starred] = await Promise.all([
      getPOIs(r.lat, r.lng, radius),
      getStarred(req.user?.id || null)
    ]);
    const annotated = matchStarred(pois, starred);
    res.json({ pois: annotated });
  } catch (e) {
    console.error('[pois] list', e);
    res.status(500).json({ error: 'pois_failed', detail: e.message });
  }
});

// ============ POST /api/listings/:id/translate ============
// Translates the listing description from Polish to English using AI,
// and rewrites it into a cleaner markdown structure.
// Returns { description: "translated markdown" }
router.post('/:id/translate', optionalUser, async (req, res) => {
  try {
    // Task A3: explicit column list — see listings.js GET /:id for rationale.
    const r = await one(
      `SELECT l.id, l.source_id, l.external_id, l.city_id, l.title,
              l.description, l.description_en, l.params_en,
              l.price, l.currency, l.rooms, l.area, l.floor,
              l.district, l.street, l.address, l.lat, l.lng, l.url,
              l.posted_at, l.first_seen_at, l.last_seen_at, l.is_active,
              l.raw, l.total_estimate, l.total_breakdown,
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

    const description = r.description || r.raw?.description || '';
    if (!description.trim()) {
      return res.json({ description: 'No description available.' });
    }

    // The system+user prompts live in services/translate.js so the only
    // place the AI backend is touched is services/ai-client.js (the seam
    // that agent E will swap for OpenRouter).

    let translated;
    try {
      if (process.env.FAKE_DB === '1') {
        throw new Error('fake mode — using canned translation');
      }
      // Route through services/translate.js -> services/ai-client.js (single
      // seam). bypassCircuit=true so an on-demand UI request ignores any
      // open circuit-breaker state from the previous batch run.
      translated = await translateDescription({
        title: r.title,
        description,
        price: r.price,
        city: r.city_name,
        district: r.district,
        area: r.area,
        rooms: r.rooms,
        floor: r.floor,
        params: r.raw?.params || []
      });
      if (!translated) {
        throw new Error('Empty response from AI');
      }
    } catch (e) {
      if (process.env.FAKE_DB === '1') {
        // Sample-data mode: build a structured English version locally so the
        // full translate UI flow can be tested without the AI proxy.
        const bits = [];
        if (r.rooms) bits.push(`**${r.rooms} room${r.rooms === 1 ? '' : 's'}**`);
        if (r.area) bits.push(`**${r.area} m²**`);
        if (r.floor) bits.push(`floor ${r.floor}`);
        translated = [
          `## About the apartment`,
          ``,
          `A rental in **${r.city_name}**${r.district ? ` (${r.district})` : ''}, offered at **${formatPrice(r.price)}/month**. ${bits.length ? bits.join(' · ') + '.' : ''}`,
          ``,
          `## Location`,
          ``,
          `- ${r.address || r.district || r.city_name}`,
          `- Good transport links and local amenities nearby`,
          ``,
          `## Costs`,
          ``,
          `- Rent: **${formatPrice(r.price)}** per month`,
          `- Utilities: extra unless stated`,
          ``,
          `_Sample translation generated in FAKE_DB mode._`
        ].join('\n');
        return res.json({ description: translated });
      }
      console.error('[translate] AI failed:', e.message);
      return res.status(503).json({ error: 'translation_service_unavailable', detail: e.message });
    }

    res.json({ description: translated });
  } catch (e) {
    console.error('[translate]', e);
    res.status(500).json({ error: 'translate_failed', detail: e.message });
  }
});

// ============ POST /api/listings/:id/share ============
// Creates a share token for public access to this listing.
router.post('/:id/share', requireUser, async (req, res) => {
  try {
    const listing = await one(`SELECT id FROM listings WHERE id = $1`, [req.params.id]);
    if (!listing) return res.status(404).json({ error: 'not_found' });

    const existing = await one(
      `SELECT token FROM share_tokens WHERE listing_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (existing) {
      return res.json({ token: existing.token, url: `/s/${existing.token}` });
    }

    const token = uuidv4().replace(/-/g, '').slice(0, 16);
    await query(
      `INSERT INTO share_tokens (token, listing_id, user_id) VALUES ($1, $2, $3)`,
      [token, req.params.id, req.user.id]
    );
    res.json({ token, url: `/s/${token}` });
  } catch (e) {
    console.error('[share] create', e);
    res.status(500).json({ error: 'share_failed', detail: e.message });
  }
});

// ============ GET /api/public/:token ============
// Public endpoint — returns listing detail for a share token. No auth required.
//
// Task 5: now populates `conveniences` the same way the authenticated
// listings.js decorate() path does — DB-backed listing_conveniences rows
// PLUS region polygons that contain the listing's lat/lng. Previously
// this hard-coded `conveniences: []`, which made the shared page render
// without the convenience chips the authenticated detail page shows.
// The POI endpoint (/:id/pois above) is already optionalUser, so the
// shared SPA can fetch POIs the same way ListingDetail does.
router.get('/public/:token', async (req, res) => {
  try {
    const share = await one(
      `SELECT listing_id FROM share_tokens WHERE token = $1`,
      [req.params.token]
    );
    if (!share) return res.status(404).json({ error: 'not_found' });

    const r = await one(
      `SELECT l.id, l.source_id, l.external_id, l.city_id, l.title,
              l.description, l.description_en, l.params_en,
              l.price, l.currency, l.rooms, l.area, l.floor,
              l.district, l.street, l.address, l.lat, l.lng, l.url,
              l.posted_at, l.first_seen_at, l.last_seen_at, l.is_active,
              l.raw, l.total_estimate, l.total_breakdown,
              l.photo_phash, l.duplicate_of_id, l.duplicate_source,
              s.name AS source_name, s.slug AS source_slug, s.color AS source_color,
              c.name AS city_name, c.name_pl AS city_name_pl, c.slug AS city_slug
       FROM listings l
       JOIN sources s ON s.id = l.source_id
       JOIN cities c ON c.id = l.city_id
       WHERE l.id = $1`,
      [share.listing_id]
    );
    if (!r) return res.status(404).json({ error: 'not_found' });

    // Fetch images
    const imgRes = await query(
      `SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position`,
      [r.id]
    );

    // Fetch DB-backed conveniences (transit stops, parks, etc.)
    const convRes = await query(
      `SELECT type, label FROM listing_conveniences WHERE listing_id = $1`,
      [r.id]
    );
    const conveniences = (convRes.rows || []).map(c => ({ type: c.type, label: c.label }));

    // Region chips: check the listing's lat/lng against every region polygon
    // in its city. Mirrors the decorate() logic in listings.js. Regions are
    // user-drawn (see /api/regions) so a shared listing inside a named
    // region shows that region chip too.
    if (r.lat != null && r.lng != null) {
      const regRes = await query(
        `SELECT name, polygon FROM regions WHERE city_id = $1`,
        [r.city_id]
      );
      for (const reg of regRes.rows || []) {
        const poly = typeof reg.polygon === 'string' ? JSON.parse(reg.polygon) : reg.polygon;
        if (Array.isArray(poly) && poly.length && pointInPolygon(r.lat, r.lng, poly)) {
          conveniences.unshift({ type: 'region', label: reg.name });
        }
      }
    }

    let params = [];
    if (r.raw && Array.isArray(r.raw.params)) {
      params = r.raw.params.map(p => ({ label: p.name, value: p.value }));
    }

    let paramsEn = [];
    if (r.params_en) {
      paramsEn = typeof r.params_en === 'string' ? JSON.parse(r.params_en) : r.params_en;
    }

    const fees = normalizeFees(r);
    res.json({
      listing: {
        id: r.id,
        source: { id: r.source_id, name: r.source_name, slug: r.source_slug, color: r.source_color },
        city: { id: r.city_id, name: r.city_name, namePl: r.city_name_pl, slug: r.city_slug },
        title: r.title,
        description: r.description || '',
        descriptionEn: r.description_en || null,
        price: r.price,
        priceLabel: formatPrice(r.price),
        totalEstimate: r.total_estimate || null,
        totalBreakdown: fees,
        fees,
        totalMonthly: fees?.total_monthly ?? null,
        currency: fees?.currency ?? 'PLN',
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
        isNew: false,
        images: imgRes.rows.map(row => row.url),
        conveniences,
        saved: false,
        params,
        paramsEn
      }
    });
  } catch (e) {
    console.error('[public]', e);
    res.status(500).json({ error: 'public_failed' });
  }
});

export default router;
