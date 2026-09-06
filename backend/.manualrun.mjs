import 'dotenv/config';
import { runFetchCycle } from './src/services/runner.js';
import { pool } from './src/db.js';
const run = await runFetchCycle({
  triggeredBy: 'manual',
  sourceIds: [1, 2, 3, 4, 5],
  cityIds: [1],
  filters: { maxPrice: 3000 }
});
console.log('RUN DONE:', JSON.stringify({ status: run.status, new: run.new_count, total: run.total_count, duration_s: (run.duration_ms/1000).toFixed(0) }));
await pool.end();
process.exit(0);
