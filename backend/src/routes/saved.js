import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();

// List saved listings for the current user
router.get('/', requireUser, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.id, l.source_id, l.city_id, l.title, l.price, l.rooms, l.area, l.floor,
              l.district, l.street, l.address, l.lat, l.lng, l.url,
              l.posted_at, l.first_seen_at,
              s.name AS source_name, s.slug AS source_slug, s.color AS source_color,
              c.name AS city_name, c.name_pl AS city_name_pl, c.slug AS city_slug,
              sl.created_at AS saved_at
       FROM saved_listings sl
       JOIN listings l ON l.id = sl.listing_id
       JOIN sources s ON s.id = l.source_id
       JOIN cities c ON c.id = l.city_id
       WHERE sl.user_id = $1
       ORDER BY sl.created_at DESC`,
      [req.user.id]
    );
    // decorate with images + conveniences
    const ids = r.rows.map(x => x.id);
    let imgsByListing = {}, convByListing = {};
    if (ids.length) {
      const imgRes = await query(
        `SELECT listing_id, url FROM listing_images
         WHERE listing_id = ANY($1::uuid[]) ORDER BY listing_id, position`,
        [ids]
      );
      for (const x of imgRes.rows) (imgsByListing[x.listing_id] ||= []).push(x.url);
      const convRes = await query(
        `SELECT listing_id, type, label FROM listing_conveniences
         WHERE listing_id = ANY($1::uuid[])`,
        [ids]
      );
      for (const x of convRes.rows) (convByListing[x.listing_id] ||= []).push({ type: x.type, label: x.label });
    }
    const listings = r.rows.map(l => ({
      id: l.id,
      source: { id: l.source_id, name: l.source_name, slug: l.source_slug, color: l.source_color },
      city: { id: l.city_id, name: l.city_name, namePl: l.city_name_pl, slug: l.city_slug },
      title: l.title,
      price: l.price,
      priceLabel: l.price.toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł',
      rooms: l.rooms,
      area: l.area,
      floor: l.floor,
      district: l.district,
      street: l.street,
      address: l.address,
      lat: l.lat,
      lng: l.lng,
      url: l.url,
      postedAt: l.posted_at,
      firstSeenAt: l.first_seen_at,
      isNew: false,
      images: imgsByListing[l.id] || [],
      conveniences: convByListing[l.id] || [],
      saved: true,
      savedAt: l.saved_at
    }));
    res.json({ count: listings.length, listings });
  } catch (e) {
    console.error('[saved] list', e);
    res.status(500).json({ error: 'saved_failed' });
  }
});

// Save a listing
router.post('/:id', requireUser, async (req, res) => {
  try {
    await query(
      `INSERT INTO saved_listings (user_id, listing_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true, saved: true });
  } catch (e) {
    res.status(500).json({ error: 'save_failed' });
  }
});

// Unsave a listing
router.delete('/:id', requireUser, async (req, res) => {
  try {
    await query(
      `DELETE FROM saved_listings WHERE user_id = $1 AND listing_id = $2`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true, saved: false });
  } catch (e) {
    res.status(500).json({ error: 'unsave_failed' });
  }
});

export default router;
