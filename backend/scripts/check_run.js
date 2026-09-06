import 'dotenv/config';
import { pool, query } from '../src/db.js';

const RUN_ID = '485ba240-23d8-4735-b50d-0a0ce3d6cc6a';

async function main() {
  // Count by was_new
  const r = await query(
    `SELECT crl.was_new, COUNT(*) as cnt,
            MIN(l.price) as min_price, MAX(l.price) as max_price
     FROM cron_run_listings crl
     JOIN listings l ON l.id = crl.listing_id
     WHERE crl.cron_run_id = $1
     GROUP BY crl.was_new`,
    [RUN_ID]
  );
  console.log('Breakdown by was_new:');
  for (const row of r.rows) {
    console.log(`  was_new=${row.was_new}: ${row.cnt} listings (price ${row.min_price}-${row.max_price})`);
  }

  // Count posted in last 24h
  const r2 = await query(
    `SELECT COUNT(*) as cnt
     FROM cron_run_listings crl
     JOIN listings l ON l.id = crl.listing_id
     WHERE crl.cron_run_id = $1
       AND l.posted_at >= NOW() - INTERVAL '24 hours'`,
    [RUN_ID]
  );
  console.log(`Posted in last 24h: ${r2.rows[0].cnt}`);

  // Show the 24h listings
  const r3 = await query(
    `SELECT l.title, l.price, l.posted_at, l.district
     FROM cron_run_listings crl
     JOIN listings l ON l.id = crl.listing_id
     WHERE crl.cron_run_id = $1
       AND l.posted_at >= NOW() - INTERVAL '24 hours'
     ORDER BY l.posted_at DESC`,
    [RUN_ID]
  );
  console.log('\nLast 24h listings in this run:');
  for (const l of r3.rows) {
    console.log(`  ${l.posted_at.toISOString().slice(0,16)} | ${l.price} zł | ${l.title.slice(0,50)} | ${l.district}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
