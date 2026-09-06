import { Router } from 'express';
import { query, one, many } from '../db.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();

// Validate a GeoJSON Polygon.
// Must be { type: "Polygon", coordinates: [[[lng, lat], ...]] } with >= 4 points
// (first === last), each coordinate [lng, lat] with valid ranges.
function validatePolygon(polygon) {
  if (!polygon || polygon.type !== 'Polygon' || !Array.isArray(polygon.coordinates)) {
    return 'Polygon must have type "Polygon" and coordinates array';
  }
  const rings = polygon.coordinates;
  if (!rings.length || !Array.isArray(rings[0])) {
    return 'Polygon must have at least one ring';
  }
  const outer = rings[0];
  if (outer.length < 4) {
    return 'Polygon outer ring must have at least 4 points (3 unique + closing point)';
  }
  // Check first === last
  const first = outer[0];
  const last = outer[outer.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return 'Polygon outer ring must be closed (first point === last point)';
  }
  // Check coordinate validity
  for (const pt of outer) {
    if (!Array.isArray(pt) || pt.length < 2) return 'Each point must be [lng, lat]';
    const [lng, lat] = pt;
    if (typeof lng !== 'number' || typeof lat !== 'number') return 'Coordinates must be numbers';
    if (lng < -180 || lng > 180) return 'Longitude out of range';
    if (lat < -90 || lat > 90) return 'Latitude out of range';
  }
  return null;
}

// Ray-casting point-in-polygon test.
// point = { lat, lng }, polygon = GeoJSON Polygon
export function pointInPolygon(lat, lng, polygon) {
  if (!polygon || polygon.type !== 'Polygon') return false;
  const ring = polygon.coordinates?.[0];
  if (!ring || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];   // [lng, lat]
    const xj = ring[j][0], yj = ring[j][1];
    // Use lat as y, lng as x
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// GET /api/regions?city=warsaw
// Returns regions for the current user in the given city (or all cities if no city param).
router.get('/', requireUser, async (req, res) => {
  try {
    const citySlug = req.query.city;
    let sql = `SELECT r.id, r.name, r.color, r.polygon, r.created_at,
                      r.city_id, c.slug AS city_slug, c.name AS city_name
               FROM regions r
               JOIN cities c ON c.id = r.city_id
               WHERE r.user_id = $1`;
    const params = [req.user.id];
    if (citySlug) {
      sql += ` AND c.slug = $2`;
      params.push(citySlug);
    }
    sql += ` ORDER BY r.created_at DESC`;
    const r = await query(sql, params);
    res.json({ regions: r.rows });
  } catch (e) {
    console.error('[regions] list', e);
    res.status(500).json({ error: 'list_failed', detail: e.message });
  }
});

// POST /api/regions
// Body: { name, color, city_id, polygon }
router.post('/', requireUser, async (req, res) => {
  try {
    const { name, color, city_id, polygon } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
    if (!city_id) return res.status(400).json({ error: 'city_id_required' });
    if (!polygon) return res.status(400).json({ error: 'polygon_required' });

    const err = validatePolygon(polygon);
    if (err) return res.status(400).json({ error: 'invalid_polygon', detail: err });

    const region = await one(
      `INSERT INTO regions (user_id, city_id, name, color, polygon)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [req.user.id, city_id, name.trim(), color || '#C15F3C', JSON.stringify(polygon)]
    );
    res.json({ region });
  } catch (e) {
    console.error('[regions] create', e);
    res.status(500).json({ error: 'create_failed', detail: e.message });
  }
});

// PATCH /api/regions/:id
// Body: { name?, color?, polygon? }
router.patch('/:id', requireUser, async (req, res) => {
  try {
    const existing = await one(
      `SELECT * FROM regions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const name = req.body.name ?? existing.name;
    const color = req.body.color ?? existing.color;
    let polygon = existing.polygon;
    if (req.body.polygon) {
      const err = validatePolygon(req.body.polygon);
      if (err) return res.status(400).json({ error: 'invalid_polygon', detail: err });
      polygon = req.body.polygon;
    }

    const updated = await one(
      `UPDATE regions SET name = $2, color = $3, polygon = $4::jsonb
       WHERE id = $1 RETURNING *`,
      [req.params.id, name, color, JSON.stringify(polygon)]
    );
    res.json({ region: updated });
  } catch (e) {
    console.error('[regions] update', e);
    res.status(500).json({ error: 'update_failed', detail: e.message });
  }
});

// DELETE /api/regions/:id
router.delete('/:id', requireUser, async (req, res) => {
  try {
    await query(`DELETE FROM regions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'delete_failed' });
  }
});

export default router;
