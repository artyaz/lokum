import 'dotenv/config';
import { pool, query } from '../src/db.js';

async function main() {
  // Delete all recent cron_runs except the seeded historical ones,
  // so the "latest cron" is far enough in the past that the next fetch
  // will mark many listings as new.
  console.log('Before cleanup:');
  const before = await query(`SELECT COUNT(*) as cnt FROM cron_runs`);
  console.log(`  cron_runs: ${before.rows[0].cnt}`);

  // Delete all runs from the last 24 hours
  const r = await query(`DELETE FROM cron_runs WHERE started_at >= NOW() - INTERVAL '24 hours' RETURNING id`);
  console.log(`  deleted ${r.rows.length} recent runs`);

  // Also delete their cron_run_listings (CASCADE should handle it, but be sure)
  // Already handled by ON DELETE CASCADE on cron_run_listings

  // Show what remains
  const after = await query(`SELECT id, started_at, status, triggered_by, new_count FROM cron_runs ORDER BY started_at DESC LIMIT 5`);
  console.log('\nRemaining runs (newest first):');
  for (const row of after.rows) {
    console.log(`  ${row.started_at.toISOString()} | ${row.status} | ${row.triggered_by} | ${row.new_count} new`);
  }

  // Show the new "latest cron" started_at — this will be the sinceTime for the next fetch
  const latest = await query(`SELECT started_at FROM cron_runs WHERE status IN ('success','partial') AND triggered_by IN ('cron','manual') ORDER BY started_at DESC LIMIT 1`);
  console.log(`\nNext fetch's sinceTime will be: ${latest.rows[0]?.started_at?.toISOString() || 'null (no previous run)'}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
