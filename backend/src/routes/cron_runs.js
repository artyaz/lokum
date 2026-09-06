import { Router } from 'express';
import { query, one } from '../db.js';
import { requireUser } from '../middleware/auth.js';
import { runFetchCycle } from '../services/runner.js';

const router = Router();

// List recent runs
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const r = await query(
      `SELECT cr.*,
              s.name AS source_name, s.slug AS source_slug,
              c.name AS city_name, c.slug AS city_slug
       FROM cron_runs cr
       LEFT JOIN sources s ON s.id = cr.source_id
       LEFT JOIN cities c ON c.id = cr.city_id
       ORDER BY cr.started_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ runs: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'list_failed' });
  }
});

// Get one run + its listings
router.get('/:id', async (req, res) => {
  try {
    const run = await one(
      `SELECT cr.*,
              s.name AS source_name, s.slug AS source_slug,
              c.name AS city_name, c.slug AS city_slug
       FROM cron_runs cr
       LEFT JOIN sources s ON s.id = cr.source_id
       LEFT JOIN cities c ON c.id = cr.city_id
       WHERE cr.id = $1`,
      [req.params.id]
    );
    if (!run) return res.status(404).json({ error: 'not_found' });
    const listingRes = await query(
      `SELECT l.id, l.title, l.price, l.first_seen_at, crl.was_new,
              s.name AS source_name, s.slug AS source_slug, s.color AS source_color
       FROM cron_run_listings crl
       JOIN listings l ON l.id = crl.listing_id
       JOIN sources s ON s.id = l.source_id
       WHERE crl.cron_run_id = $1
       ORDER BY crl.was_new DESC, l.first_seen_at DESC
       LIMIT 100`,
      [req.params.id]
    );
    res.json({ run, listings: listingRes.rows });
  } catch (e) {
    res.status(500).json({ error: 'get_failed' });
  }
});

// Manual run trigger
router.post('/run-now', requireUser, async (req, res) => {
  try {
    const { source_ids, city_ids, filters } = req.body || {};
    const result = await runFetchCycle({
      triggeredBy: 'manual',
      sourceIds: source_ids || [],
      cityIds: city_ids || [],
      filters: filters || {}
    });
    res.json({ run: result });
  } catch (e) {
    console.error('[cron_runs] run-now', e);
    res.status(500).json({ error: 'run_failed', detail: e.message });
  }
});

export default router;
