import 'dotenv/config';
import { pool, query } from '../src/db.js';

async function main() {
  const latest = await query(
    `SELECT started_at FROM cron_runs
     WHERE status IN ('success','partial')
     ORDER BY started_at DESC LIMIT 1`
  );
  console.log('latest cron_run started_at:', latest.rows[0]?.started_at);

  const l = await query(
    `SELECT title, first_seen_at, posted_at,
            (first_seen_at >= (SELECT started_at FROM cron_runs
                                WHERE status IN ('success','partial')
                                ORDER BY started_at DESC LIMIT 1)) AS passes
     FROM listings WHERE is_active=TRUE LIMIT 5`
  );
  for (const r of l.rows) {
    console.log(` - "${r.title.slice(0,30)}" first_seen: ${r.first_seen_at} | passes: ${r.passes}`);
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
