// prod-init.js — create the real admin user + default cron job on the fresh
// local Postgres. Does NOT touch seed.js demo data (no sample listings).
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool, one } from './db.js';
import cronParser from 'cron-parser';

const EMAIL = process.env.ADMIN_EMAIL || 'admin@lokum.app';
const PASSWORD = process.env.ADMIN_PASSWORD;
const NAME = process.env.ADMIN_NAME || 'Lokum Admin';

if (!PASSWORD) { console.error('ADMIN_PASSWORD required'); process.exit(1); }

// cron job: daily 06:00 Warsaw, Warsaw city, core sources incl. newly fixed ones
// sources: 1=olx, 2=otodom, 3=adresowo, 4=gratka, 5=morizon, 8=nieruchomosci-online,
//          9=domiporta, 16=sprzedajemy, 20=telegram
const SOURCE_IDS = [1, 2, 3, 4, 5, 8, 9, 16];
const CITY_IDS = [1]; // warsaw
const SCHEDULE = '0 6 * * *';

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);

  let user = await one(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  if (!user) {
    user = await one(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [EMAIL, NAME, hash]
    );
    console.log('[prod-init] created user', EMAIL);
  } else {
    await one(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, hash]);
    console.log('[prod-init] user exists — password reset', EMAIL);
  }

  const existingJob = await one(`SELECT id FROM cron_jobs WHERE user_id = $1`, [user.id]);
  if (!existingJob) {
    const nextRun = cronParser.parseExpression(SCHEDULE, { tz: 'Europe/Warsaw' }).next().toDate();
    const job = await one(
      `INSERT INTO cron_jobs (user_id, name, schedule, source_ids, city_ids, filters, enabled, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, $7) RETURNING id`,
      [user.id, 'Morning Warszaw', SCHEDULE, SOURCE_IDS, CITY_IDS, '{}', nextRun]
    );
    console.log('[prod-init] created cron job', job.id, SCHEDULE, 'next:', nextRun.toISOString());
  } else {
    console.log('[prod-init] cron job already exists — leaving untouched');
  }

  await pool.end();
  console.log('[prod-init] DONE');
}

main().catch(e => { console.error('[prod-init] FAILED:', e); process.exit(1); });
