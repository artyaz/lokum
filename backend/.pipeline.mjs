import 'dotenv/config';
import { many, query, pool } from './src/db.js';
import { translateDescription } from './src/services/translate.js';
import { dedupeForListings } from './src/services/dedupe.js';
import { computeForListings } from './src/services/totalprice.js';
import { notifyNewListings } from './src/services/telegram.js';

const RUN_ID = process.argv[2];
const news = await many(
  `SELECT l.id, l.title, l.description, l.price, l.district, l.area, l.rooms, l.floor, l.raw, c.name AS city
   FROM cron_run_listings crl
   JOIN listings l ON l.id = crl.listing_id
   JOIN cities c ON c.id = l.city_id
   WHERE crl.cron_run_id = $1 AND crl.was_new = TRUE AND l.description_en IS NULL AND length(l.description) > 30
   ORDER BY l.first_seen_at DESC LIMIT 120`, [RUN_ID]);
console.log('to translate:', news.length);
let idx = 0, done = 0;
async function worker() {
  while (idx < news.length) {
    const l = news[idx++];
    try {
      const d = await translateDescription({ title: l.title, description: l.description, price: l.price, city: l.city, district: l.district, area: l.area, rooms: l.rooms, floor: l.floor, params: l.raw?.params || [] });
      if (d) { await query(`UPDATE listings SET description_en = $2 WHERE id = $1 AND description_en IS NULL`, [l.id, d]); done++; }
    } catch (e) { console.log('translate err:', e.message); }
  }
}
await Promise.all([worker(), worker()]);
console.log('translated:', done);

const ids = (await many(`SELECT listing_id FROM cron_run_listings WHERE cron_run_id = $1 AND was_new = TRUE`, [RUN_ID])).map(r => r.listing_id);
console.log('dedupe pairs:', await dedupeForListings(ids));
await computeForListings(ids, { limit: 90 });
await notifyNewListings(RUN_ID);
console.log('PIPELINE DONE');
await pool.end();
process.exit(0);
