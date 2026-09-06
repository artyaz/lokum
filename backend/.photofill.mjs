import 'dotenv/config';
import { many, query, pool } from './src/db.js';
import { extractGalleryPhotos, extractNuxtPhotos, extractDetailDescription } from './src/services/scrapers/jsonldProduct.js';
import { AdresowoScraper } from './src/services/scrapers/adresowo.js';

// Photo-backfill script: re-fetches detail pages for listings that have
// ≤1 stored image and replaces their `listing_images` rows with the full
// photo URL list. Compatible with the new gratka photo path added in A5
// (`extractNuxtPhotos` — renamed from `extractGratkaNuxtPhotos` in Task
// B4 because the same Nuxt payload layout is shared by gratka + morizon,
// both owned by Grupa Morizon-Gratka).
// For gratka (source 4) AND morizon (source 5) we call `extractNuxtPhotos`
// first and fall back to `extractGalleryPhotos` (the regex path) if the
// Nuxt block is absent. For adresowo (source 3) we use the existing path
// (`_applyDetail`, which uses og:image + 6-hex prefix filter — B5-5).
// Photos are stored as URL strings only — no downloaded bytes written.

const UA2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
async function fetchHtml(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA2, 'Accept-Language': 'pl-PL,pl;q=0.9' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

const rows = await many(`
  SELECT l.id, l.url, l.source_id, l.description,
         (SELECT count(*) FROM listing_images WHERE listing_id = l.id) AS nimgs
  FROM listings l
  WHERE l.is_active = TRUE AND l.source_id IN (3, 4, 5)
  ORDER BY l.first_seen_at DESC`);
const targets = rows.filter(r => r.nimgs <= 1 && r.url);
console.log('to re-enrich:', targets.length, 'of', rows.length);

const adresowo = new AdresowoScraper();
let updated = 0, coords = 0, descs = 0, failed = 0;
for (const t of targets) {
  try {
    const html = await fetchHtml(t.url);
    let photos = [];
    if (t.source_id === 3) {
      const ad = { url: t.url, images: [], description: t.description || '', raw: {} };
      adresowo._applyDetail(html, ad);
      photos = ad.images;
      if (ad.lat != null) {
        await query(`UPDATE listings SET lat = $2, lng = $3 WHERE id = $1 AND lat IS NULL`, [t.id, ad.lat, ad.lng]);
        coords++;
      }
      if (ad.description && ad.description.length > (t.description || '').length + 40) {
        await query(`UPDATE listings SET description = $2 WHERE id = $1`, [t.id, ad.description]);
        descs++;
      }
    } else {
      // source 4 (gratka): Nuxt-first — returns up to 20 photos (was 4).
      // source 5 (morizon): Nuxt-first too — same __NUXT_DATA__ layout as
      // gratka (Grupa Morizon-Gratka — same Nuxt platform, same photo CDN).
      // Task B4 generalized `extractGratkaNuxtPhotos` → `extractNuxtPhotos`
      // because the function was always platform-agnostic.
      if (t.source_id === 4 || t.source_id === 5) {
        photos = extractNuxtPhotos(html);
        if (!photos.length) photos = extractGalleryPhotos(html);
      } else {
        photos = extractGalleryPhotos(html);
      }
      const desc = extractDetailDescription(html);
      if (desc && desc.length > (t.description || '').length + 40) {
        await query(`UPDATE listings SET description = $2 WHERE id = $1`, [t.id, desc]);
        descs++;
      }
    }
    if (photos.length) {
      await query(`DELETE FROM listing_images WHERE listing_id = $1`, [t.id]);
      for (let i = 0; i < photos.length; i++) {
        await query(`INSERT INTO listing_images (listing_id, url, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [t.id, photos[i], i]);
      }
      updated++;
    }
  } catch (e) { failed++; }
  await new Promise(r => setTimeout(r, 150));
}
console.log(`DONE — photos updated: ${updated}, coords added: ${coords}, descriptions: ${descs}, failed: ${failed}`);
await pool.end();
process.exit(0);
