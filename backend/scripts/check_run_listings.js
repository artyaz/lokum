import 'dotenv/config';
import { pool, query } from '../src/db.js';

const RUN_ID = process.argv[2] || 'c883985e-392f-4604-9cc4-9e75e5c75f3a';

async function main() {
  console.log(`Checking run ${RUN_ID}...`);

  // Count cron_run_listings by was_new
  const r = await query(
    `SELECT was_new, COUNT(*) as cnt FROM cron_run_listings WHERE cron_run_id = $1 GROUP BY was_new`,
    [RUN_ID]
  );
  console.log('\ncron_run_listings breakdown:');
  for (const row of r.rows) {
    console.log(`  was_new=${row.was_new}: ${row.cnt}`);
  }

  // For was_new=TRUE, check is_active status
  const r2 = await query(
    `SELECT l.is_active, COUNT(*) as cnt
     FROM cron_run_listings crl
     JOIN listings l ON l.id = crl.listing_id
     WHERE crl.cron_run_id = $1 AND crl.was_new = TRUE
     GROUP BY l.is_active`,
    [RUN_ID]
  );
  console.log('\nwas_new=TRUE breakdown by is_active:');
  for (const row of r2.rows) {
    console.log(`  is_active=${row.is_active}: ${row.cnt}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
