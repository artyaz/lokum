import { Router } from 'express';
import { one, many } from '../db.js';
import { requireUser } from '../middleware/auth.js';
import {
  getDuplicateGroups,
  dedupeScanCity,
  getCrossProviderDuplicates,
  phashBackfill
} from '../services/dedupe.js';

const router = Router();

// GET /api/duplicates?city=warsaw
//   Returns BOTH kinds of duplicates for the city:
//     - `groups`           — source-level duplicate groups (union-find over
//                            listing_duplicates pairs; metadata + photo-URL
//                            + pHash-exact-match pairs all flow through here)
//     - `crossProvider`    — listings flagged via the new duplicate_of_id
//                            column (cross-provider pHash duplicates), grouped
//                            by canonical listing. Lets the UI badge
//                            "also listed on OLX" without walking union-find.
router.get('/', requireUser, async (req, res) => {
  try {
    const slug = req.query.city || 'warsaw';
    const city = await one(`SELECT id FROM cities WHERE slug = $1`, [slug]);
    if (!city) return res.json({ groupCount: 0, groups: [], crossProviderCount: 0, crossProvider: [] });
    const [groups, crossProvider] = await Promise.all([
      getDuplicateGroups(city.id),
      getCrossProviderDuplicates(city.id)
    ]);
    res.json({
      groupCount: groups.length,
      groups,
      crossProviderCount: crossProvider.length,
      crossProvider
    });
  } catch (e) {
    console.error('[duplicates] list', e);
    res.status(500).json({ error: 'list_failed', detail: e.message });
  }
});

// POST /api/duplicates/run — rescan all cities (rebuilds listing_duplicates
// pairs via the bucketed metadata scan + URL-image bucket + pHash bucket
// passes; also refreshes duplicate_of_id on every non-canonical row found).
router.post('/run', requireUser, async (req, res) => {
  try {
    const cities = await many(`SELECT id FROM cities`);
    let total = 0;
    for (const c of cities) {
      try { total += await dedupeScanCity(c.id); }
      catch (e) { console.error('[duplicates] scan failed for city', c.id, e.message); }
    }
    res.json({ ok: true, pairs: total });
  } catch (e) {
    res.status(500).json({ error: 'scan_failed', detail: e.message });
  }
});

// POST /api/duplicates/phash-backfill?limit=200&city=warsaw
//   Backfill photo_phash + cross-provider duplicate_of_id for active listings
//   that pre-date the pHash worker (e.g. historical rows inserted before the
//   2026_08_dedupe_phash.sql migration ran). Idempotent: listings already
//   carrying a photo_phash are skipped. Bounded by `limit` (default 200,
//   max 1000) so a single admin click can't saturate the photo CDN with
//   thousands of concurrent fetches.
//
//   Body / query:
//     limit   int (default 200, max 1000)
//     city    slug (optional — restricts to one city)
router.post('/phash-backfill', requireUser, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || req.body?.limit) || 200, 1000);
    const citySlug = req.query.city || req.body?.city;
    let cityId = null;
    if (citySlug) {
      const c = await one(`SELECT id FROM cities WHERE slug = $1`, [citySlug]);
      if (!c) return res.status(400).json({ error: 'bad_city' });
      cityId = c.id;
    }
    const result = await phashBackfill({ limit, cityId });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[duplicates] phash-backfill', e);
    res.status(500).json({ error: 'backfill_failed', detail: e.message });
  }
});

export default router;
