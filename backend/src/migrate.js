import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, query } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  // Apply main schema
  const schemaPath = path.join(__dirname, 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await query(sql);
  console.log('[migrate] schema applied OK');

  // Apply incremental migrations (for adding columns to existing tables).
  // Two naming conventions are supported:
  //   - legacy:  migration_NNN_description.sql   (applied first, by sort)
  //   - dated:    YYYY_MM_description.sql         (applied after, lexicographic)
  // Both must be idempotent (the legacy DO $$ ... $$ blocks already are).
  const migrationsDir = path.join(__dirname, 'sql');
  const allFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .filter(f => f.startsWith('migration_') || /^\d{4}_\d{2}_.+\.sql$/.test(f));
  const isDated = (f) => /^\d{4}_\d{2}_.+\.sql$/.test(f);
  const sortByConventionThenName = (a, b) => {
    const ad = isDated(a), bd = isDated(b);
    if (ad !== bd) return ad ? 1 : -1; // legacy first, dated second
    return a < b ? -1 : a > b ? 1 : 0;
  };
  allFiles.sort(sortByConventionThenName);
  for (const f of allFiles) {
    const migrationSql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    try {
      await query(migrationSql);
      console.log(`[migrate] applied ${f}`);
    } catch (e) {
      console.warn(`[migrate] ${f} skipped:`, e.message);
    }
  }

  await pool.end();
}

migrate().catch(err => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
