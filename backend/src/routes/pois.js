// POI starring endpoints — Task F.
//
// Two endpoints:
//   POST   /api/pois/star    body { name, type, lat, lng, place_id?, address? }
//                            → upserts into starred_pois, returns the full
//                              starred list so the frontend can refresh
//                              every chip in one round-trip.
//   DELETE /api/pois/star    body { place_id?, name?, lat?, lng?, starred_id? }
//                            → removes the matching row, returns starred list.
//   GET    /api/pois/starred → returns the starred list (no body).
//
// All three use optionalUser (not requireUser) so single-user deployments
// without an auth session continue to work — the row is stored with
// user_id=NULL in that case. When a session IS present, the row is
// attributed to that user.id so multi-user deployments scope correctly.
//
// The actual POI fetching (Google Maps + Overpass fallback + cache) lives
// in services/pois.js and is exposed via GET /api/listings/:id/pois
// (mounted in routes/listing-detail.js).

import { Router } from 'express';
import { optionalUser } from '../middleware/auth.js';
import { starPOI, unstarPOI, getStarred } from '../services/pois.js';

const router = Router();

// ============ GET /api/pois/starred ============
router.get('/starred', optionalUser, async (req, res) => {
  try {
    const starred = await getStarred(req.user?.id || null);
    res.json({ starred });
  } catch (e) {
    console.error('[pois] starred', e);
    res.status(500).json({ error: 'starred_failed', detail: e.message });
  }
});

// ============ POST /api/pois/star ============
// Body: { name, type, lat, lng, place_id?, address? }
// Returns: { starred: [...] } — the full fresh starred list for the user.
router.post('/star', optionalUser, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.type || b.lat == null || b.lng == null) {
      return res.status(400).json({
        error: 'invalid_payload',
        detail: 'required: name, type, lat, lng'
      });
    }
    const starred = await starPOI(
      {
        name: String(b.name).slice(0, 200),
        type: String(b.type).slice(0, 40),
        lat: Number(b.lat),
        lng: Number(b.lng),
        place_id: b.place_id ? String(b.place_id).slice(0, 300) : null,
        address: b.address ? String(b.address).slice(0, 300) : null
      },
      req.user?.id || null
    );
    res.json({ starred });
  } catch (e) {
    console.error('[pois] star', e);
    res.status(500).json({ error: 'star_failed', detail: e.message });
  }
});

// ============ DELETE /api/pois/star ============
// Body: { place_id?, name?, lat?, lng?, starred_id? }
// Priority: starred_id (UUID) > place_id > (name + rounded lat + rounded lng).
// Returns: { starred: [...] } — the full fresh starred list for the user.
router.delete('/star', optionalUser, async (req, res) => {
  try {
    const b = req.body || {};
    const starred = await unstarPOI(
      {
        starred_id: b.starred_id ? String(b.starred_id) : null,
        place_id: b.place_id ? String(b.place_id) : null,
        name: b.name ? String(b.name) : null,
        lat: b.lat != null ? Number(b.lat) : null,
        lng: b.lng != null ? Number(b.lng) : null
      },
      req.user?.id || null
    );
    res.json({ starred });
  } catch (e) {
    console.error('[pois] unstar', e);
    res.status(500).json({ error: 'unstar_failed', detail: e.message });
  }
});

export default router;
