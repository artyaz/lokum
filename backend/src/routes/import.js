// Community import — paste a listing's text (e.g. from a Facebook rentals
// group) and let AI structure it into a real listing. This is the safe
// alternative to scraping Facebook (which would need personal cookies).

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, one } from '../db.js';
import { requireUser } from '../middleware/auth.js';
import { computeAndStore } from '../services/totalprice.js';
import { dedupeForListings } from '../services/dedupe.js';
import { notifyCommunityImport } from '../services/telegram.js';

const router = Router();

const OMNI_URL = 'http://127.0.0.1:20128/v1/chat/completions';
const MODEL = 'auto/best-chat';
const COMMUNITY_SOURCE_ID = 6;

const SYSTEM = `You parse rental listings pasted from social media groups (usually Polish) into structured JSON.

Extract:
- title: short descriptive title in English (e.g. "2-room flat — Mokotów, near metro")
- price: monthly rent in PLN (integer, the advertised rent only, not deposit)
- rooms: integer or null (studio/kawalerka = 1)
- area: m² float or null
- floor: string or null (e.g. "3", "3/7")
- district: Warsaw district/area name (e.g. "Mokotów") or null
- description: the cleaned full text (keep Polish, strip phone numbers/emails/messenger handles)
- available_from: ISO date string or null

Rules:
- Answer ONLY with strict JSON, no markdown.
- If the text is clearly NOT a rental listing, return {"not_a_listing": true}.
- Do not invent facts not present in the text.`;

// FAKE_DB mode: crude local parser so the import flow is testable without AI.
function parseLocally(text) {
  const price = (text.match(/(\d[\d\s]{2,})\s*(zł|pln)/i) || [])[1];
  const area = (text.match(/(\d{2,3}(?:[.,]\d+)?)\s*m[²2]/i) || [])[1];
  const rooms = (text.match(/(\d)\s*(-|–)?\s*(pok|room)/i) || [])[1];
  return {
    title: text.split('\n')[0].slice(0, 80) || 'Community listing',
    price: price ? parseInt(price.replace(/\s/g, ''), 10) : null,
    rooms: rooms ? parseInt(rooms, 10) : null,
    area: area ? parseFloat(area.replace(',', '.')) : null,
    floor: null,
    district: null,
    description: text,
    available_from: null
  };
}

async function parseWithAI(text) {
  if (process.env.FAKE_DB === '1') return parseLocally(text);
  const resp = await fetch(OMNI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text.slice(0, 6000) }
      ]
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!resp.ok) throw new Error(`OmniRoute HTTP ${resp.status}`);
  const data = await resp.json();
  const content = (data.choices?.[0]?.message?.content || '').replace(/```(?:json)?/g, '').trim();
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI returned no JSON');
  return JSON.parse(m[0]);
}

// POST /api/import/text — { text, url?, images?, city_slug?, save, parsed? }
router.post('/text', requireUser, async (req, res) => {
  try {
    const { text, url, images = [], city_slug = 'warsaw', save = false, parsed: preParsed } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'no_text', detail: 'Paste the post text first' });
    }

    let parsed = preParsed;
    if (!parsed) {
      parsed = await parseWithAI(String(text).trim());
      if (parsed.not_a_listing) {
        return res.status(422).json({ error: 'not_a_listing', detail: "This text doesn't look like a rental listing." });
      }
    }

    if (!save) {
      return res.json({ parsed });
    }

    // validate minimal data
    const price = parseInt(parsed.price);
    if (!price || price < 100 || price > 100000) {
      return res.status(422).json({ error: 'bad_price', detail: 'Set a valid monthly price before saving.' });
    }
    const city = await one(`SELECT id FROM cities WHERE slug = $1`, [city_slug]);
    if (!city) return res.status(400).json({ error: 'bad_city' });

    const id = uuidv4();
    const externalId = 'imp-' + Date.now().toString(36);
    const validImages = (Array.isArray(images) ? images : []).filter(u => typeof u === 'string' && u.startsWith('http')).slice(0, 12);

    await query(
      `INSERT INTO listings (
        id, source_id, external_id, city_id, url, title, description,
        price, currency, rooms, area, floor, district, street, address,
        lat, lng, posted_at, first_seen_at, last_seen_at, is_active, raw
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PLN', $9, $10, $11, $12, NULL, $13, NULL, NULL, NOW(), NOW(), NOW(), TRUE, $14)`,
      [
        id, COMMUNITY_SOURCE_ID, externalId, city.id,
        url || '',
        String(parsed.title || 'Community listing').slice(0, 300),
        String(parsed.description || text).slice(0, 8000),
        price,
        parsed.rooms ? parseInt(parsed.rooms) : null,
        parsed.area ? parseFloat(parsed.area) : null,
        parsed.floor ? String(parsed.floor).slice(0, 20) : null,
        String(parsed.district || '').slice(0, 120) || null,
        String(parsed.district || '').slice(0, 200) || null,
        JSON.stringify({ imported: true, by_user: req.user.id, params: [] })
      ]
    );

    for (let i = 0; i < validImages.length; i++) {
      await query(
        `INSERT INTO listing_images (listing_id, url, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, validImages[i], i]
      );
    }

    // treat like any other new listing: total estimate + dedupe + notifications
    computeAndStore(id).catch(() => {});
    dedupeForListings([id]).catch(() => {});
    notifyCommunityImport(id).catch(() => {});

    res.json({ ok: true, listing: { id } });
  } catch (e) {
    console.error('[import] failed', e);
    res.status(500).json({ error: 'import_failed', detail: e.message });
  }
});

export default router;
